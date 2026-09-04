#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactBrowserResult } from "../pi-extension/output.js";
import { createClient } from "../skills/pi-control-chrome/scripts/browser.mjs";

const SERVER_NAME = "pi-control-chrome";
const SERVER_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "unknown"; } catch { return "unknown"; }
})();
const PROTOCOL_VERSION = "2025-06-18";
const SESSION_ID = `codex-${process.pid}-${randomUUID()}`;
const TURN_ID = `codex-${randomUUID()}`;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_REQUEST_TIMEOUT_MS = 170_000;
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const BRIDGE_HOST = process.env.PI_CONTROL_CHROME_BRIDGE_HOST || "127.0.0.1";
const configuredBridgePort = Number(process.env.PI_CONTROL_CHROME_BRIDGE_PORT || 17318);
const BRIDGE_PORT = Number.isInteger(configuredBridgePort) && configuredBridgePort > 0 && configuredBridgePort < 65_536 ? configuredBridgePort : 17318;
const BRIDGE_ORIGIN = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
const BRIDGE_PATH = fileURLToPath(new URL("../bridge/server.mjs", import.meta.url));
const TOKEN_FILE = join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent", "pi-control-chrome.token");

const string = (description) => ({ type: "string", ...(description ? { description } : {}) });
const number = (description) => ({ type: "number", ...(description ? { description } : {}) });
const integer = (description) => ({ type: "integer", ...(description ? { description } : {}) });
const boolean = (description) => ({ type: "boolean", ...(description ? { description } : {}) });
const anyValue = () => ({});
const object = (properties = {}, required = [], description) => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});
const openObject = (description) => ({ type: "object", ...(description ? { description } : {}), additionalProperties: true });
const array = (items, description) => ({ type: "array", items, ...(description ? { description } : {}) });

const TAB_HANDLE = object({
  tabId: number("Browser tab id."),
  browserId: string(),
  windowId: number(),
  title: string(),
  url: string(),
  tabFence: string(),
  incarnation: string(),
  sessionId: string(),
  groupId: number(),
}, ["tabId"], "Complete tab identity returned by browser_tabs. Keep locator fields in target, not handle.");
const TARGET = object({
  ref: string(),
  selector: string("CSS selector; prefer role, label or text for ordinary semantic targets."),
  role: string(),
  name: string(),
  label: string(),
  placeholder: string(),
  text: string(),
  testId: string(),
  exact: boolean(),
  index: integer("Zero-based non-negative index applied after visibility filtering."),
  scopeSelector: string(),
  hasText: string(),
  hasSelector: string(),
}, [], "Use one primary locator: role, label, text, placeholder, testId, ref or selector.");
const TAB_FIELDS = { tabId: number("Browser tab id. Omit to use the selected tab."), handle: TAB_HANDLE };
const PAGE_FIELDS = { ...TAB_FIELDS };
const PAGE_TARGET_FIELDS = { ...PAGE_FIELDS, snapshotId: string(), ref: string(), selector: string(), target: TARGET, timeoutMs: number("Optional positive timeout in milliseconds.") };
const WAIT_STATE = { type: "string", enum: ["load", "url", "text", "text_gone", "visible", "hidden", "enabled"] };
const COORDINATE = object({ x: number(), y: number() }, ["x", "y"]);

function schema(properties, required = []) {
  return object(properties, required);
}

function tool(name, description, method, inputSchema, transform) {
  return Object.freeze({ name, description, method, inputSchema, transform });
}

const ALL_TOOLS = [
  tool("browser_doctor", "Diagnose the local Bridge, extension connection, active browser target and Chrome/Edge competition without changing tabs.", "doctor", schema()),
  tool("browser_status", "Return the connected Chrome/Edge browser, target stability and local Bridge status. When multiple targets exist, provide browserId and acknowledgeBrowserId explicitly.", "status", schema({
    browserId: string("Select a connected browser target by browserId."),
    acknowledgeBrowserId: string("Explicitly acknowledge this browserId after confirming a browser switch."),
  })),
  tool("browser_tabs", "List Chrome/Edge windows, tabs, tab groups, ownership and lifecycle state. Choose tabs using owner, sessionId and sessionScope, never groupId alone.", "list_tabs", schema()),
  tool("browser_selected", "Return the currently selected Chrome/Edge tab.", "selected_tab", schema()),
  tool("browser_claim_tab", "Claim an existing user tab using its id and optional snapshot checks. Fails if supplied tab identity changed.", "claim_tab", schema({ ...TAB_FIELDS, windowId: number(), title: string(), url: string() }, ["tabId", "handle"])),
  tool("browser_select_tab", "Select an existing browser tab by id, optionally focusing its window.", "select_tab", schema({ ...TAB_FIELDS, focusWindow: boolean() }, ["tabId", "handle"])),
  tool("browser_new_tab", "Create an Agent-owned tab and place it in the Pi tab group. With wait=true, return a refreshed post-load handle.", "new_tab", schema({
    url: string("Initial URL. Defaults to about:blank."),
    active: boolean("Whether to activate the new tab at creation time."),
    windowId: number(),
    wait: boolean("Wait for the created tab to finish loading before returning."),
    timeoutMs: number("Optional positive timeout for the load wait."),
    allowRedirects: boolean("Allow the final URL to differ from the requested URL while waiting."),
  })),
  tool("browser_snapshot", "Read the active page title and bounded semantic page state. eN refs require the matching snapshotId; navigation is a hard boundary.", "snapshot", schema({ ...PAGE_FIELDS, selector: string(), maxChars: integer(), maxNodes: integer() }, ["handle"])),
  tool("browser_accessibility_snapshot", "Return the bounded Chromium accessibility tree as full, incremental diff or unchanged text. aN refs require the matching snapshotId; sensitive values remain redacted.", "snapshot", schema({ ...PAGE_FIELDS, selector: string(), maxChars: integer(), maxNodes: integer(), disableDiffing: boolean() }, ["handle"]), (args) => ({ ...args, accessibilityOnly: true })),
  tool("browser_extract", "Extract the current page as bounded plain text and simple Markdown without using a separate web scraper.", "extract", schema({ ...PAGE_FIELDS, selector: string(), maxChars: integer() }, ["handle"])),
  tool("browser_locator", "Use locator operations with role/name, label, text, placeholder, testId, eN/aN ref or CSS selector. Ordinary role/name, label and accessible-text targets use Chromium AX first; unsafe AX mapping fails closed.", "locator", schema({
    ...PAGE_FIELDS,
    action: string("Locator action such as count, click, fill, text, attribute or waitFor."),
    target: TARGET,
    snapshotId: string(),
    strategy: string(),
    selector: string(),
    value: anyValue(),
    exact: boolean(),
    name: string(),
    index: integer(),
    hasText: string(),
    hasSelector: string(),
    other: anyValue(),
    attribute: string(),
    key: string(),
    timeoutMs: number("Optional positive timeout in milliseconds."),
  }, ["handle", "action"]), (args) => ({
    ...args,
    locator: args.target ?? {
      strategy: args.strategy ?? "css",
      value: args.value ?? args.selector ?? "*",
      ...(args.exact === undefined ? {} : { exact: args.exact }),
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.index === undefined ? {} : { index: args.index }),
      ...(args.hasText === undefined ? {} : { hasText: args.hasText }),
      ...(args.hasSelector === undefined ? {} : { hasSelector: args.hasSelector }),
    },
  })),
  tool("browser_navigate", "Navigate a selected or specified browser tab to a URL and optionally wait for loading. wait=false returns a transition-pending handle.", "navigate", schema({ ...PAGE_FIELDS, url: string("Destination URL."), wait: boolean(), timeoutMs: number(), allowRedirects: boolean() }, ["handle", "url"])),
  tool("browser_wait", "Wait for a selected tab to load, reach a URL, show or hide text, or reach an element state. Use text for text waits and target for element waits.", "wait", schema({
    ...PAGE_FIELDS,
    state: WAIT_STATE,
    url: string(),
    urlIncludes: string(),
    text: string(),
    target: TARGET,
    snapshotId: string(),
    exact: boolean(),
    timeoutMs: number("Optional positive timeout in milliseconds."),
  }, ["handle"])),
  tool("browser_click", "Click one visible element by semantic target, document-scoped eN/aN ref with matching snapshotId, or CSS selector.", "interaction", schema({ ...PAGE_TARGET_FIELDS }, ["handle"]), (args) => ({ ...args, operation: "click" })),
  tool("browser_double_click", "Double-click one visible element by semantic target, document-scoped eN/aN ref with matching snapshotId, or CSS selector.", "interaction", schema({ ...PAGE_TARGET_FIELDS }, ["handle"]), (args) => ({ ...args, operation: "double_click" })),
  tool("browser_fill", "Fill one input, textarea or contenteditable element by semantic target, document-scoped eN/aN ref, or CSS selector.", "interaction", schema({ ...PAGE_TARGET_FIELDS, value: string("Replacement text.") }, ["handle", "value"]), (args) => ({ ...args, operation: "fill" })),
  tool("browser_type", "Type or append text into one focused browser field by semantic target, document-scoped eN/aN ref, or CSS selector.", "interaction", schema({ ...PAGE_TARGET_FIELDS, value: string("Text to type.") }, ["handle", "value"]), (args) => ({ ...args, operation: "type" })),
  tool("browser_press_key", "Dispatch a keyboard key to one element selected by semantic target, document-scoped eN/aN ref, or CSS selector.", "interaction", schema({ ...PAGE_TARGET_FIELDS, key: string("Key name or character.") }, ["handle", "key"]), (args) => ({ ...args, operation: "press" })),
  tool("browser_scroll", "Scroll the selected page by a viewport delta.", "interaction", schema({ ...TAB_FIELDS, deltaX: number(), deltaY: number() }, ["handle"]), (args) => ({ ...args, operation: "scroll" })),
  tool("browser_dom_cua", "Use visible DOM node ids from a matching browser_dom_cua observation. Navigation remains a hard boundary.", "dom_cua", schema({
    ...TAB_FIELDS,
    action: { type: "string", enum: ["get_visible_dom", "click", "double_click", "type", "keypress", "scroll"] },
    snapshotId: string(),
    nodeId: string(),
    selector: string(),
    maxChars: integer(),
    maxNodes: integer(),
    value: string(),
    key: string(),
    deltaX: number(),
    deltaY: number(),
  }, ["handle", "action"])),
  tool("browser_cua", "Use native CDP mouse and keyboard input at viewport coordinates, including click, move, scroll, drag, type and keypress.", "cua", schema({
    ...TAB_FIELDS,
    action: string(),
    x: number(),
    y: number(),
    toX: number(),
    toY: number(),
    path: array(COORDINATE),
    deltaX: number(),
    deltaY: number(),
    text: string(),
    key: string(),
    button: string(),
  }, ["handle", "action"])),
  tool("browser_screenshot", "Capture the selected browser tab and return it as an image. An optional path also saves a local copy.", "screenshot", schema({ ...TAB_FIELDS, fullPage: boolean(), format: string(), path: string() }, ["handle"])),
  tool("browser_console", "Enable and read Runtime console and Log entries captured from a browser tab.", "console_logs", schema({ ...TAB_FIELDS, action: string(), clear: boolean() }, ["handle"])),
  tool("browser_network", "Enable and read Network request/response events and response bodies from a browser tab.", "network_requests", schema({ ...TAB_FIELDS, action: string(), requestId: string(), loaderId: string(), clear: boolean() }, ["handle"])),
  tool("browser_dialog", "Inspect and accept or dismiss alert, confirm and prompt dialogs using native CDP.", "dialog", schema({ ...TAB_FIELDS, action: string(), promptText: string() }, ["handle", "action"])),
  tool("browser_upload", "Set local files on a page file input using native CDP DOM.setFileInputFiles in trusted local mode.", "upload", schema({ ...TAB_FIELDS, selector: string(), nodeId: number(), incarnation: string(), files: { anyOf: [string(), array(string())] } }, ["handle", "files"])),
  tool("browser_clipboard", "Read or write plain text through the selected tab's browser clipboard.", "clipboard", schema({ ...TAB_FIELDS, action: { type: "string", enum: ["read", "write"] }, text: string() }, ["handle", "action"])),
  tool("browser_download", "Start, wait for, list, cancel or erase browser downloads and return their paths and status.", "download", schema({
    action: string(),
    url: string(),
    filename: string(),
    saveAs: boolean(),
    wait: boolean(),
    downloadId: number(),
    limit: number(),
    timeoutMs: number(),
  }, ["action"])),
  tool("browser_evaluate", "Evaluate JavaScript in the selected page using the native CDP Runtime.evaluate path.", "evaluate", schema({ ...TAB_FIELDS, expression: string(), awaitPromise: boolean() }, ["handle", "expression"])),
  tool("browser_cdp", "Send a native Chrome DevTools Protocol command to the selected browser tab.", "cdp", schema({ ...TAB_FIELDS, method: string(), params: openObject() }, ["handle", "method"])),
  tool("browser_back", "Navigate the selected browser tab back in history. The returned tab is transitionPending.", "back", schema({ ...TAB_FIELDS, bypassCache: boolean() }, ["handle"])),
  tool("browser_forward", "Navigate the selected browser tab forward in history. The returned tab is transitionPending.", "forward", schema({ ...TAB_FIELDS, bypassCache: boolean() }, ["handle"])),
  tool("browser_reload", "Reload the selected browser tab. The returned tab is transitionPending.", "reload", schema({ ...TAB_FIELDS, bypassCache: boolean() }, ["handle"])),
  tool("browser_close_tab", "Close a specified browser tab. Agent-owned tabs must belong to this session; unowned user tabs require userRequested=true.", "close_tab", schema({ ...TAB_FIELDS, userRequested: boolean() }, ["tabId", "handle"])),
  tool("browser_release", "Release a claimed or Agent tab from this session without closing the page.", "release", schema({ tabId: number() }, ["tabId"])),
  tool("browser_mark_handoff", "Mark an Agent-owned tab to survive cleanup for manual user handoff; repeat the mark in a later turn.", "mark_handoff", schema({ tabId: number() }, ["tabId"])),
  tool("browser_mark_deliverable", "Mark an Agent-owned tab to survive cleanup as a user-facing deliverable; repeat the mark in a later turn.", "mark_deliverable", schema({ tabId: number() }, ["tabId"])),
  tool("browser_cleanup", "Only after the user explicitly asks for browser cleanup: close allowed Agent tabs, release claims and recover stale ownership only when explicitly requested.", "cleanup", schema({ recoverStale: boolean() })),
  tool("browser_context_reset", "Only after the user explicitly asks to reset or clear browser context: finalize this Codex browser session while keeping the shared Bridge alive.", "cleanup", schema(), () => ({ mode: "context" })),
];
const EXPOSED_TOOL_NAMES = new Set([
  "browser_status",
  "browser_tabs",
  "browser_snapshot",
  "browser_accessibility_snapshot",
  "browser_extract",
  "browser_wait",
  "browser_click",
  "browser_fill",
]);
const TOOLS = ALL_TOOLS.filter(({ name }) => EXPOSED_TOOL_NAMES.has(name));
const TOOL_MAP = new Map(TOOLS.map((entry) => [entry.name, entry]));
const COMPACT_READS = new Set(["browser_snapshot", "browser_extract", "browser_accessibility_snapshot", "browser_tabs", "browser_selected"]);
let bridgeClient;
let bridgeClientPromise;
let shuttingDown = false;
let operationTail = Promise.resolve();
const activeRequests = new Map();

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

function requestTimeout(args) {
  const requested = Number(args?.timeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(DEFAULT_REQUEST_TIMEOUT_MS, requested + 5_000));
}

function assertRequestActive(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Browser request aborted");
}

async function bridgeHealthy() {
  try {
    const response = await fetch(`${BRIDGE_ORIGIN}/health`, { signal: AbortSignal.timeout(700) });
    return response.ok && (await response.json())?.ok === true;
  } catch {
    return false;
  }
}

async function ensureBridgeProcess() {
  if (await bridgeHealthy()) return;
  const child = spawn(process.execPath, [
    BRIDGE_PATH,
    "--port", String(BRIDGE_PORT),
    "--token-file", TOKEN_FILE,
    "--started-by", "codex",
  ], { stdio: "ignore", windowsHide: true });
  child.once("error", () => {});
  child.unref();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await bridgeHealthy()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out starting the pi-control-chrome Bridge at ${BRIDGE_ORIGIN}`);
}

async function ensureBridgeClient() {
  if (bridgeClient?.socket?.readyState === 1) return bridgeClient;
  bridgeClient?.close();
  bridgeClient = undefined;
  if (bridgeClientPromise === undefined) {
    bridgeClientPromise = ensureBridgeProcess().then(() => createClient(undefined, false)).then(({ client }) => {
      bridgeClient = client;
      return client;
    }).finally(() => {
      bridgeClientPromise = undefined;
    });
  }
  return bridgeClientPromise;
}

function withSession(params) {
  return { ...params, sessionId: SESSION_ID };
}

async function listTargets(client, signal) {
  return client.rawRequest("list_targets", withSession({}), DEFAULT_REQUEST_TIMEOUT_MS, undefined, signal);
}

async function invokeTool(spec, args, signal) {
  assertRequestActive(signal);
  const client = await ensureBridgeClient();
  let params = { ...args };
  if (spec.transform) params = spec.transform(params);
  if (spec.name === "browser_console" && params.action === "enable") {
    params = { ...params, domains: ["Runtime", "Log"] };
  }
  if (spec.name === "browser_network" && params.action === "enable") {
    params = { ...params, domains: ["Network", "Page"] };
  }
  if (spec.name === "browser_network" && params.action === "response_body") {
    if (!params.requestId || !params.loaderId) throw new Error("browser_network response_body requires requestId and loaderId from the current Network listing");
    spec = { ...spec, method: "network_response_body" };
  }
  if (spec.name === "browser_console" && params.action === "enable") spec = { ...spec, method: "devtools_enable" };
  if (spec.name === "browser_network" && params.action === "enable") spec = { ...spec, method: "devtools_enable" };
  if (spec.name === "browser_accessibility_snapshot") params.accessibilityOnly = true;
  if (spec.name === "browser_mark_handoff" || spec.name === "browser_mark_deliverable") params.turnId = TURN_ID;
  if ((COMPACT_READS.has(spec.name) || (spec.name === "browser_dom_cua" && params.action === "get_visible_dom")) && params.responseMode === undefined) params.responseMode = "compact";
  params = withSession(params);
  assertRequestActive(signal);

  if (spec.name === "browser_doctor") return client.rawRequest("doctor", params, requestTimeout(args), undefined, signal);
  if (spec.name === "browser_status") {
    try {
      return await client.request("status", { ...params, browserId: args.browserId, acknowledgeBrowserId: args.acknowledgeBrowserId }, requestTimeout(args), signal);
    } catch (error) {
      if (["TARGET_REQUIRED", "TARGET_UNAVAILABLE", "TARGET_CONNECTION_CHANGED"].includes(error?.code)) {
        const inventory = await listTargets(client, signal).catch(() => ({ targets: [] }));
        const code = error.code;
        return {
          connected: false,
          ...(code === "TARGET_REQUIRED" ? { targetRequired: true } : { targetUnavailable: true }),
          state: code === "TARGET_CONNECTION_CHANGED" ? "target_reconnecting" : code === "TARGET_REQUIRED" ? "target_required" : "target_unavailable",
          completed: false,
          retryable: code !== "TARGET_CONNECTION_CHANGED",
          nextAction: "browser_status",
          recommendation: code === "TARGET_REQUIRED" ? "select_browser_target" : "refresh_browser_targets",
          error: { code, message: error.message },
          targets: Array.isArray(inventory?.targets) ? inventory.targets : [],
        };
      }
      throw error;
    }
  }
  if (spec.name === "browser_context_reset") params.mode = "context";
  if (spec.name === "browser_console" && params.action !== "enable") spec = { ...spec, method: "console_logs" };
  if (spec.name === "browser_network" && params.action !== "enable" && params.action !== "response_body") spec = { ...spec, method: "network_requests" };
  return client.request(spec.method, params, requestTimeout(args), signal);
}

function jsonText(value) {
  try { return JSON.stringify(value ?? null); } catch { return "null"; }
}

function toolResult(name, value, args) {
  if (name !== "browser_screenshot") return { content: [{ type: "text", text: jsonText(compactBrowserResult(name, { ...args, sessionId: SESSION_ID }, value)) }] };
  const result = value && typeof value === "object" ? value : {};
  const { data, ...metadata } = result;
  if (typeof data !== "string" || data.length === 0) return { content: [{ type: "text", text: jsonText(value) }] };
  if (typeof args.path === "string" && args.path.length > 0) {
    const path = resolve(args.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(data, "base64"));
    metadata.path = path;
  }
  return {
    content: [
      { type: "text", text: jsonText(metadata) },
      { type: "image", data, mimeType: typeof result.mimeType === "string" ? result.mimeType : "image/png" },
    ],
  };
}

function errorResult(error) {
  const code = typeof error?.code === "string" ? error.code : "BROWSER_REQUEST_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details : undefined;
  return {
    isError: true,
    content: [{ type: "text", text: jsonText({ error: { code, message, ...(details === undefined ? {} : { details }) } }) }],
  };
}

function send(message) {
  if (process.stdout.destroyed) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function enqueue(operation) {
  const run = operationTail.then(operation, operation);
  operationTail = run.catch(() => {});
  return run;
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const controller of activeRequests.values()) controller.abort(new Error("Codex browser adapter is shutting down"));
  await operationTail.catch(() => {});
  try {
    if (bridgeClient?.socket?.readyState === 1) {
      await bridgeClient.request("cleanup", withSession({ mode: "context" }), 5_000);
    }
  } catch {
    // Process shutdown must not turn cleanup uncertainty into an automatic retry.
  } finally {
    bridgeClient?.close();
    bridgeClient = undefined;
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
    if (message.method === "notifications/cancelled") {
      const requestId = message.params?.requestId;
      if (requestId !== undefined) activeRequests.get(requestKey(requestId))?.abort(new Error("Browser request aborted"));
    }
    return;
  }
  if (message.method === "ping") {
    if (message.id !== undefined) response(message.id, {});
    return;
  }
  if (message.method === "initialize") {
    if (message.id === undefined) return;
    const requested = message.params?.protocolVersion;
    response(message.id, {
      protocolVersion: typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "Use browser_status before browser actions. Preserve browserId, tabFence, incarnation and snapshotId; inspect before retrying BROWSER_OPERATION_UNCERTAIN.",
    });
    return;
  }
  if (message.method === "tools/list") {
    if (message.id === undefined) return;
    response(message.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    return;
  }
  if (message.method !== "tools/call") {
    if (message.id !== undefined) rpcError(message.id, -32601, `Method not found: ${String(message.method)}`);
    return;
  }
  if (message.id === undefined) return;
  const name = message.params?.name;
  const args = message.params?.arguments;
  const spec = TOOL_MAP.get(name);
  if (!spec) {
    rpcError(message.id, -32602, `Unknown browser tool: ${String(name)}`);
    return;
  }
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
    rpcError(message.id, -32602, "tools/call arguments must be an object");
    return;
  }
  const key = requestKey(message.id);
  if (activeRequests.has(key)) {
    rpcError(message.id, -32600, "A request with this id is already pending");
    return;
  }
  const controller = new AbortController();
  activeRequests.set(key, controller);
  try {
    const value = await enqueue(() => invokeTool(spec, args || {}, controller.signal));
    response(message.id, toolResult(spec.name, value, args || {}));
  } catch (error) {
    response(message.id, errorResult(error));
  } finally {
    activeRequests.delete(key);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    rpcError(null, -32700, "Parse error");
    return;
  }
  void handleMessage(message);
});
input.on("close", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
