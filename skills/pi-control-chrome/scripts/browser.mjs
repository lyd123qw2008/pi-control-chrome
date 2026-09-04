#!/usr/bin/env node

/**
 * Fast common workflows for the pi-control-chrome Skill.
 * Uses the already-running local Bridge and the current Chrome/Edge profile.
 * Requires Node.js 22+ for the built-in WebSocket and fetch APIs.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compactBrowserResult } from "../../../pi-extension/output.js";

const BRIDGE_HOST = process.env.PI_CONTROL_CHROME_BRIDGE_HOST || "127.0.0.1";
const BRIDGE_PORT = Number(process.env.PI_CONTROL_CHROME_BRIDGE_PORT || 17318);
const BRIDGE_ORIGIN = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
const BRIDGE_WS = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}/ws`;
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_CHARS = 8_000;
const COMPACT_RESPONSE_METHODS = new Map([
  ["snapshot", "browser_snapshot"],
  ["extract", "browser_extract"],
  ["list_tabs", "browser_tabs"],
  ["selected_tab", "browser_selected"],
]);

function compactToolName(method, params = {}) {
  if (method === "snapshot") return params.accessibilityOnly === true ? "browser_accessibility_snapshot" : "browser_snapshot";
  if (method === "dom_cua" && params.action === "get_visible_dom") return "browser_dom_cua";
  return COMPACT_RESPONSE_METHODS.get(method);
}

function usage() {
  console.log(`Usage:
  node browser.mjs status [--browser-id <id>] [--acknowledge-browser-id <id>] [--json]
  node browser.mjs targets [--json]
  node browser.mjs tabs --browser-id <id> [--raw] [--json]
  node browser.mjs group --browser-id <id> [--json]
  node browser.mjs open <url> --session <id> --browser-id <id> [--active|--inactive] [--turn <n>] [--json]
  node browser.mjs view <url> --session <id> --browser-id <id> [--turn <n>] [--temporary] [--inactive] [--reuse-existing] [--screenshot <path>] [--raw] [--json]
  node browser.mjs snapshot <tabId> --browser-id <id> [--session <id>] [--raw] [--json]
  node browser.mjs extract <tabId> --browser-id <id> [--session <id>] [--max-chars <n>] [--raw] [--json]
  node browser.mjs screenshot <tabId> <path> --browser-id <id> [--session <id>] [--full-page]
  node browser.mjs close <tabId> --browser-id <id> [--session <id>] [--json]
  node browser.mjs cleanup --session <id> --browser-id <id> [--recover-stale] [--json]

Examples:
  node browser.mjs status
  node browser.mjs view http://127.0.0.1:3000/ --session example-session --turn 1 --screenshot C:\\Temp\\page.png
  node browser.mjs tabs --json`);
}

function parseArgs(tokens) {
  const positionals = [];
  const options = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2).replaceAll("-", "_");
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return { positionals, options };
}

function boolOption(options, name, fallback = false) {
  if (options[name] === undefined) return fallback;
  return options[name] === true || options[name] === "true";
}

function numberOption(options, name, fallback) {
  if (options[name] === undefined) return fallback;
  const value = Number(options[name]);
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric option --${name.replaceAll("_", "-")}`);
  return value;
}

function requiredSession(options, command) {
  if (options.session === undefined || String(options.session).trim() === "") throw new Error(`${command} requires --session <id> for managed browser ownership`);
  return String(options.session);
}

function requiredTurn(options, command) {
  if (options.turn === undefined || String(options.turn).trim() === "") throw new Error(`${command} requires --turn <n> when marking a retained tab`);
  return numberOption(options, "turn");
}

async function bridgeHealth() {
  const response = await fetch(`${BRIDGE_ORIGIN}/health`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Bridge health failed: HTTP ${response.status}`);
  return response.json();
}

async function pairingToken() {
  const response = await fetch(`${BRIDGE_ORIGIN}/pair`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Bridge pairing failed: HTTP ${response.status}`);
  const value = await response.json();
  if (!value.token) throw new Error("Bridge pairing response did not include a token");
  return value.token;
}

function browserTarget(value) {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.browser !== "string" || !value.browser || typeof value.browserId !== "string" || !value.browserId || typeof value.profile !== "string" || !value.profile) return undefined;
  const connectionId = typeof value.connectionId === "string" && value.connectionId ? value.connectionId : undefined;
  const connectionGeneration = Number.isInteger(value.connectionGeneration) && value.connectionGeneration > 0 ? value.connectionGeneration : undefined;
  return { browser: value.browser, browserId: value.browserId, profile: value.profile, ...(connectionId === undefined ? {} : { connectionId }), ...(connectionGeneration === undefined ? {} : { connectionGeneration }) };
}

function isTargetLocator(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.combine === "and" || value.combine === "or") return isTargetLocator(value.left) || isTargetLocator(value.right);
  if (value.strategy !== undefined) return false;
  return ["ref", "selector", "role", "label", "placeholder", "text", "testId"].some((key) => value[key] !== undefined);
}

function hasAccessibilityReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (typeof value.ref === "string" && /^a\d+$/.test(value.ref))
    || hasAccessibilityReference(value.target)
    || hasAccessibilityReference(value.locator)
    || hasAccessibilityReference(value.left)
    || hasAccessibilityReference(value.right);
}

function isSideEffectingRequest(method, params = {}) {
  if (["navigate", "back", "forward", "reload", "select_tab", "new_tab", "close_tab", "upload", "cua", "keypress", "scroll", "cleanup", "claim_tab", "release", "mark_handoff", "mark_deliverable", "evaluate", "cdp", "devtools_enable", "devtools_disable"].includes(method)) return true;
  if (method === "interaction" || method === "locator") return ["click", "double_click", "dblclick", "fill", "type", "press", "select", "check", "uncheck", "set_checked", "hover", "focus", "scroll"].includes(String(params.action || params.operation || ""));
  if (method === "dom_cua") return params.action !== "get_visible_dom";
  if (method === "download") return !["list", "wait"].includes(String(params.action || ""));
  if (method === "clipboard") return params.action === "write";
  if (method === "dialog") return ["accept", "dismiss"].includes(String(params.action || ""));
  if (method === "console_logs" || method === "network_requests") return params.clear === true;
  return false;
}

function localRequestError(method, params, message, details = {}) {
  const error = new Error(message);
  if (isSideEffectingRequest(method, params)) {
    error.code = "BROWSER_OPERATION_UNCERTAIN";
    error.details = { actionState: "unknown", retryable: false, inspectFirst: true, ...details };
  }
  return error;
}

function tabRecoveryError(error, tabId) {
  const source = error instanceof Error ? error : new Error(String(error));
  const result = source.code === "BROWSER_OPERATION_UNCERTAIN" ? source : new Error(`${source.message} Created tab ${tabId} may still be owned; inspect it before retrying.`);
  result.code = "BROWSER_OPERATION_UNCERTAIN";
  result.details = { actionState: "unknown", retryable: false, inspectFirst: true, tabId, ownershipRetained: true, ...(result.details && typeof result.details === "object" ? result.details : {}) };
  if (result === source && !result.message.includes(`tab ${tabId}`)) result.message = `${result.message} Created tab ${tabId} may still be owned; inspect it before retrying.`;
  if (result !== source) result.cause = source;
  return result;
}

class BridgeClient {
  constructor(token, selectedBrowserId, bridgeCapabilities = {}) {
    this.token = token;
    this.selectedBrowserId = selectedBrowserId;
    this.bridgeCapabilities = bridgeCapabilities;
    this.socket = undefined;
    this.sequence = 0;
    this.pending = new Map();
    this.acknowledgedTarget = undefined;
    this.connecting = undefined;
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting !== undefined) return this.connecting;
    const attempt = (async () => {
      await new Promise((resolveOpen, reject) => {
        const socket = new WebSocket(`${BRIDGE_WS}?role=pi&token=${encodeURIComponent(this.token)}`);
        this.socket = socket;
        const timer = setTimeout(() => {
          if (this.socket === socket) this.socket = undefined;
          socket.close();
          reject(new Error("Timed out connecting to the Pi browser Bridge"));
        }, 5_000);
        socket.addEventListener("open", () => {
          if (this.socket !== socket) {
            clearTimeout(timer);
            socket.close();
            reject(new Error("Pi browser Bridge connection was replaced while opening"));
            return;
          }
          clearTimeout(timer);
          resolveOpen();
        }, { once: true });
        socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
        socket.addEventListener("close", () => {
          for (const [id, entry] of this.pending) {
            if (entry.socket !== socket) continue;
            clearTimeout(entry.timer);
            entry.reject(localRequestError(entry.method, entry.params, "Pi browser Bridge disconnected"));
            this.pending.delete(id);
          }
          if (this.socket === socket) this.socket = undefined;
        }, { once: true });
        socket.addEventListener("error", (error) => {
          clearTimeout(timer);
          if (this.socket === socket) this.socket = undefined;
          reject(error instanceof Error ? error : new Error("Bridge WebSocket error"));
        }, { once: true });
      });
    })();
    let tracked;
    tracked = attempt.finally(() => {
      if (this.connecting === tracked) this.connecting = undefined;
    });
    this.connecting = tracked;
    return tracked;
  }

  handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.type !== "response" || !message.id) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = message.error !== undefined;
    if ((!hasResult && !hasError) || (hasResult && hasError)) {
      this.settlePending(message.id, new Error("Browser Bridge returned a response without exactly one result or error"), undefined, true);
      return;
    }
    if (hasError) {
      const rawError = message.error;
      const validObject = rawError !== null && typeof rawError === "object" && !Array.isArray(rawError);
      const errorPayload = validObject ? rawError : {};
      const valid = validObject && typeof errorPayload.code === "string" && typeof errorPayload.message === "string";
      if (!valid) {
        this.settlePending(message.id, new Error("Browser Bridge returned a malformed error response"), undefined, true);
      } else {
        const error = new Error(errorPayload.message);
        error.code = errorPayload.code;
        if (errorPayload.details && typeof errorPayload.details === "object" && !Array.isArray(errorPayload.details)) error.details = errorPayload.details;
        this.settlePending(message.id, error);
      }
      return;
    }
    this.settlePending(message.id, undefined, message.result);
  }

  settlePending(id, error, value, cancelRemote = false) {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (cancelRemote) {
      try {
        if (entry.socket.readyState === WebSocket.OPEN) entry.socket.send(JSON.stringify({ type: "cancel", id }));
      } catch {
        // The response is already invalid; local settlement still protects the caller.
      }
    }
    clearTimeout(entry.timer);
    entry.removeAbort?.();
    this.pending.delete(id);
    if (error) entry.reject(cancelRemote ? localRequestError(entry.method, entry.params, error.message) : error);
    else entry.resolve(value);
  }

  rawRequest(method, params = {}, timeoutMs = DEFAULT_TIMEOUT, target, signal) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Bridge WebSocket is not connected"));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Browser request aborted"));
    }
    const id = `skill-${process.pid}-${++this.sequence}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.settlePending(id, new Error(`Browser request timed out: ${method}`), undefined, true);
      }, timeoutMs);
      const entry = { resolve: resolveRequest, reject: rejectRequest, timer, method, params, socket, removeAbort: undefined };
      this.pending.set(id, entry);
      if (signal) {
        const onAbort = () => this.settlePending(id, signal.reason instanceof Error ? signal.reason : new Error("Browser request aborted"), undefined, true);
        entry.removeAbort = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
      }
      try {
        socket.send(JSON.stringify({ type: "request", id, method, params, ...(target === undefined ? {} : { target }) }));
      } catch (error) {
        this.settlePending(id, error instanceof Error ? error : new Error(String(error)), undefined, true);
      }
    });
  }

  targetRoute(target = this.acknowledgedTarget) {
    if (!target) return this.selectedBrowserId === undefined ? undefined : { browserId: this.selectedBrowserId };
    return {
      browserId: target.browserId,
      ...(target.connectionId === undefined ? {} : { connectionId: target.connectionId }),
      ...(target.connectionGeneration === undefined ? {} : { connectionGeneration: target.connectionGeneration }),
    };
  }

  async request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT, signal) {
    if (method === "status") {
      const { acknowledgeBrowserId, browserId, ...statusParams } = params;
      const selectedBrowserId = browserId || acknowledgeBrowserId || this.selectedBrowserId || this.acknowledgedTarget?.browserId;
      const route = selectedBrowserId === undefined ? undefined : { browserId: selectedBrowserId };
      const result = await this.rawRequest("status", statusParams, timeoutMs, route, signal);
      const target = browserTarget(result);
      const previous = this.acknowledgedTarget;
      const changed = previous !== undefined && previous.browserId !== target?.browserId;
      const connectionChanged = previous !== undefined && !changed && target !== undefined && (previous.connectionId !== target.connectionId || previous.connectionGeneration !== target.connectionGeneration);
      const acknowledged = target !== undefined && (previous === undefined || (!changed && !connectionChanged) || acknowledgeBrowserId === target.browserId);
      if (target !== undefined && acknowledged) this.acknowledgedTarget = target;
      return {
        ...result,
        targetStability: {
          stable: target !== undefined && !changed && !connectionChanged,
          changed,
          connectionChanged,
          acknowledged,
          requiresAcknowledgement: (changed || connectionChanged) && !acknowledged,
          browser: target?.browser,
          browserId: target?.browserId,
          profile: target?.profile,
          ...(target?.connectionId === undefined ? {} : { connectionId: target.connectionId }),
          ...(target?.connectionGeneration === undefined ? {} : { connectionGeneration: target.connectionGeneration }),
          ...(previous === undefined ? {} : { previousBrowser: previous.browser, previousBrowserId: previous.browserId, ...(previous.connectionId === undefined ? {} : { previousConnectionId: previous.connectionId }), ...(previous.connectionGeneration === undefined ? {} : { previousConnectionGeneration: previous.connectionGeneration }) }),
        },
      };
    }
    const route = this.targetRoute();
    const status = await this.rawRequest("status", {}, timeoutMs, route, signal);
    const target = browserTarget(status);
    const extensionCapabilities = status?.capabilities && typeof status.capabilities === "object" ? status.capabilities : {};
    const required = [];
    if ((method === "interaction" && params.target !== undefined) || (method === "locator" && (params.target !== undefined || isTargetLocator(params.locator)))) {
      if (this.bridgeCapabilities.semanticTargetRequests !== true) required.push("Bridge.semanticTargetRequests");
      if (extensionCapabilities.semanticTargets !== true) required.push("extension.semanticTargets");
    }
    if (method === "wait") {
      const state = String(params.state || "load");
      if (params.target !== undefined && this.bridgeCapabilities.semanticTargetRequests !== true) required.push("Bridge.semanticTargetRequests");
      if (params.target !== undefined && extensionCapabilities.semanticTargets !== true) required.push("extension.semanticTargets");
      if (["text", "text_gone", "visible", "hidden", "enabled"].includes(state)) {
        if (this.bridgeCapabilities.pageWaitStates !== true) required.push("Bridge.pageWaitStates");
        if (extensionCapabilities.pageWaitStates !== true) required.push("extension.pageWaitStates");
      }
    }
    if (method === "dom_cua" && extensionCapabilities.domCuaSnapshots !== true) required.push("extension.domCuaSnapshots");
    if (["interaction", "locator", "wait"].includes(method) && params.snapshotId !== undefined && extensionCapabilities.snapshotRefs !== true) required.push("extension.snapshotRefs");
    if (["interaction", "locator", "wait"].includes(method) && hasAccessibilityReference(params) && extensionCapabilities.axRefs !== true) required.push("extension.axRefs");
    if (method === "cleanup" && params.recoverStale === true && extensionCapabilities.tabIncarnationFence !== true) required.push("extension.tabIncarnationFence");
    if (required.length > 0) throw new Error(`EXTENSION_CAPABILITY_MISSING: the selected browser target does not support ${required.join(", ")}`);
    const previous = this.acknowledgedTarget;
    if (target === undefined) throw new Error("Browser status did not identify an active browser target; run status --browser-id <id>");
    const changed = previous !== undefined && previous.browserId !== target.browserId;
    const connectionChanged = previous !== undefined && !changed && (previous.connectionId !== target.connectionId || previous.connectionGeneration !== target.connectionGeneration);
    if (changed || connectionChanged) {
      const reason = changed ? "browser target" : "browser connection";
      throw new Error(`${reason} changed; run status with --acknowledge-browser-id ${target.browserId} before retrying`);
    }
    if (previous === undefined) this.acknowledgedTarget = target;
    const responseTool = compactToolName(method, params);
    const requestedMode = params.responseMode === "raw" || params.responseMode === "compact" ? params.responseMode : undefined;
    const { responseMode: _requestedMode, ...baseParams } = params;
    const negotiatedMode = this.bridgeCapabilities.compactResponses === true && requestedMode !== undefined ? requestedMode : undefined;
    const wireParams = negotiatedMode === undefined ? baseParams : { ...baseParams, responseMode: negotiatedMode };
    const result = await this.rawRequest(method, { ...wireParams, expectedBrowserId: target.browserId }, timeoutMs, this.targetRoute(target), signal);
    return requestedMode === "compact" && responseTool !== undefined ? compactBrowserResult(responseTool, params, result) : result;
  }

  close() {
    this.socket?.close();
  }
}

async function createClient(selectedBrowserId, requireExtension = true) {
  const health = await bridgeHealth();
  if (requireExtension && !health.extensionConnected) throw new Error("Chrome/Edge extension is not connected. Run /chrome status and reload the unpacked extension if needed.");
  const client = new BridgeClient(await pairingToken(), selectedBrowserId, health.capabilities && typeof health.capabilities === "object" ? health.capabilities : {});
  await client.connect();
  return { client, health };
}

function evaluationValue(result) {
  return result?.result?.result?.value ?? result?.result?.value ?? result?.value;
}

function truncate(value, maxChars) {
  const text = String(value ?? "");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... [truncated at ${maxChars} characters]`;
}

function tabSummary(tab) {
  if (!tab) return undefined;
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    owner: tab.owner,
    lifecycle: tab.lifecycle,
    groupId: tab.groupId,
    windowId: tab.windowId,
    handle: tab.handle,
  };
}

async function readTabs(client, raw = false) {
  return client.request("list_tabs", { responseMode: raw ? "raw" : "compact" });
}

async function findTab(client, tabId) {
  const tabs = await readTabs(client);
  const tab = tabs.tabs.find((entry) => Number(entry.id) === Number(tabId));
  if (!tab) throw new Error(`Tab not found: ${tabId}`);
  return { tabs, tab };
}

async function waitForGroupedTab(client, tabId, attempts = 12) {
  let latest;
  for (let i = 0; i < attempts; i += 1) {
    latest = await readTabs(client);
    const tab = latest.tabs.find((entry) => Number(entry.id) === Number(tabId));
    if (tab?.groupId !== undefined && tab.groupId !== -1) return { tabs: latest, tab };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const tab = latest?.tabs.find((entry) => Number(entry.id) === Number(tabId));
  return { tabs: latest, tab };
}

async function openTab(client, url, options) {
  const sessionId = requiredSession(options, "open");
  const turnId = options.turn === undefined ? undefined : numberOption(options, "turn");
  const active = boolOption(options, "active", !boolOption(options, "inactive", false));
  const timeoutMs = numberOption(options, "timeout_ms", 30_000);
  const waitStarted = Date.now();
  const rpcTimeoutMs = Math.min(120_000, timeoutMs + 5_000);
  const created = await client.request("new_tab", { url, active, sessionId, wait: true, timeoutMs }, rpcTimeoutMs);
  const tabId = created?.tab?.id;
  if (tabId === undefined) throw new Error("Bridge did not return the new tab id");
  const waitMs = Date.now() - waitStarted;
  const waited = { tab: created.tab };
  let grouped;
  try {
    grouped = await waitForGroupedTab(client, tabId);
    if (!grouped.tab) throw new Error(`Created tab ${tabId} was not present in the tab listing after setup`);
    const groupId = Number(grouped.tab.groupId);
    if (grouped.tab.owner !== "agent" || !Number.isInteger(groupId) || groupId < 0) {
      const error = new Error(`Created tab ${tabId} did not reach the Agent-owned Pi group; inspect it before retrying.`);
      error.code = "TAB_SETUP_INCOMPLETE";
      error.details = { tabId, owner: grouped.tab.owner, groupId: grouped.tab.groupId };
      throw error;
    }
  } catch (error) {
    throw tabRecoveryError(error, tabId);
  }
  return { created, waited, tabId, waitMs, ...grouped, sessionId, turnId };
}

async function inspectTab(client, tabOrId, options, sessionId) {
  const sourceTab = tabOrId && typeof tabOrId === "object" ? tabOrId : undefined;
  const tabId = sourceTab?.id ?? tabOrId;
  const target = { tabId, ...(sourceTab?.handle ? { handle: sourceTab.handle } : {}), ...(sessionId ? { sessionId } : {}) };
  const responseMode = boolOption(options, "raw", false) ? "raw" : "compact";
  const snapshot = await client.request("snapshot", { ...target, responseMode });
  const snapshotTarget = snapshot?.tab?.handle ? { ...target, handle: snapshot.tab.handle } : target;
  const extracted = await client.request("extract", { ...snapshotTarget, responseMode });
  const extractedTarget = extracted?.tab?.handle ? { ...snapshotTarget, handle: extracted.tab.handle } : snapshotTarget;
  let timing;
  try {
    const evaluated = await client.request("evaluate", {
      ...extractedTarget,
      expression: `JSON.stringify((()=>{const n=performance.getEntriesByType('navigation')[0];return {readyState:document.readyState,title:document.title,url:location.href,domNodes:document.getElementsByTagName('*').length,textChars:(document.body?.innerText||'').length,navigation:n?{responseStart:Math.round(n.responseStart),domContentLoaded:Math.round(n.domContentLoadedEventEnd),load:Math.round(n.loadEventEnd),duration:Math.round(n.duration)}:null};})())`,
    });
    const value = evaluationValue(evaluated);
    timing = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    timing = { error: error.message };
  }

  let screenshot;
  if (options.screenshot) {
    const captured = await client.request("screenshot", { ...extractedTarget, fullPage: boolOption(options, "full_page", false) });
    const target = resolve(String(options.screenshot));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(captured.data, "base64"));
    screenshot = { path: target, bytes: Buffer.byteLength(Buffer.from(captured.data, "base64")), mimeType: captured.mimeType };
  }

  const snapshotDetails = responseMode === "raw"
    ? {
      available: Boolean(snapshot?.snapshot),
      elementCount: snapshot?.snapshot?.elements?.length ?? null,
      accessibilityAvailable: Boolean(snapshot?.snapshot?.accessibility),
      frameCount: snapshot?.frameTree?.frameTree ? 1 + (snapshot.frameTree.frameTree.childFrames?.length || 0) : null,
    }
    : {
      available: Boolean(snapshot?.snapshot),
      snapshotId: snapshot?.snapshot?.snapshotId ?? null,
      nodeCount: snapshot?.snapshot?.nodeCount ?? null,
      charCount: snapshot?.snapshot?.charCount ?? null,
      truncated: snapshot?.snapshot?.truncated ?? null,
    };
  const finalTab = extracted?.tab || snapshot?.tab || sourceTab;
  return {
    tab: tabSummary(finalTab),
    snapshot: snapshotDetails,
    timing,
    content: {
      title: extracted?.content?.title || extracted?.content?.text?.split("\n")[0] || "",
      text: truncate(extracted?.content?.text, numberOption(options, "max_chars", DEFAULT_MAX_CHARS)),
      markdown: truncate(extracted?.content?.markdown, numberOption(options, "max_chars", DEFAULT_MAX_CHARS)),
    },
    screenshot,
  };
}

function printResult(value, options) {
  if (boolOption(options, "json", false)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (value.status) {
    console.log(`Browser: ${value.status.browser || "unknown"}`);
    console.log(`Profile: ${value.status.profile || "current"}`);
    console.log(`Extension: ${value.status.extensionVersion || "unknown"} (${value.status.connected ? "connected" : "unknown"})`);
    console.log(`Bridge: ${value.health?.port || BRIDGE_PORT} (${value.health?.extensionConnected ? "healthy" : "extension offline"})`);
    return;
  }
  if (value.tab && value.content) {
    console.log(`Title: ${value.tab.title || value.content.title || ""}`);
    console.log(`URL: ${value.tab.url || ""}`);
    console.log(`Tab: ${value.tab.id} | owner=${value.tab.owner || "user"} | lifecycle=${value.tab.lifecycle || ""} | group=${value.tab.groupId}`);
    if (value.timing?.navigation) console.log(`Load: ${value.timing.navigation.duration} ms`);
    if (value.screenshot) console.log(`Screenshot: ${value.screenshot.path}`);
    console.log("\n" + value.content.text);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const command = process.argv[2] || "status";
  if (["help", "--help", "-h"].includes(command)) { usage(); return; }
  const { positionals, options } = parseArgs(process.argv.slice(3));
  if (command === "open") {
    requiredSession(options, "open");
    if (boolOption(options, "handoff", false) || boolOption(options, "deliverable", false)) requiredTurn(options, "open");
  }
  if (command === "view") {
    if (!boolOption(options, "reuse_existing", false) || !boolOption(options, "temporary", false)) requiredSession(options, "view");
    if (!boolOption(options, "temporary", false)) requiredTurn(options, "view");
  }
  if (command === "cleanup") requiredSession(options, "cleanup");
  const requiresExtension = command !== "status" && command !== "targets";
  const { client, health } = await createClient(options.browser_id, requiresExtension);
  try {
    if (command === "status") {
      const status = await client.request("status", options.acknowledge_browser_id ? { acknowledgeBrowserId: String(options.acknowledge_browser_id) } : {});
      printResult({ status, health }, options);
      return;
    }
    if (command === "targets") {
      const result = await client.rawRequest("list_targets");
      printResult(result, options);
      return;
    }
    if (command === "tabs") {
      const result = await readTabs(client, boolOption(options, "raw", false));
      printResult(result, options);
      return;
    }
    if (command === "group") {
      const result = await readTabs(client);
      printResult(result.groups || [], options);
      return;
    }
    if (command === "open") {
      if (!positionals[0]) throw new Error("open requires a URL");
      const result = await openTab(client, positionals[0], options);
      try {
        if (boolOption(options, "handoff", false)) {
          await client.request("mark_handoff", { tabId: result.tabId, handle: result.tab?.handle, sessionId: result.sessionId, turnId: result.turnId });
          if (result.tab) result.tab.lifecycle = "handoff";
        }
        if (boolOption(options, "deliverable", false)) {
          await client.request("mark_deliverable", { tabId: result.tabId, handle: result.tab?.handle, sessionId: result.sessionId, turnId: result.turnId });
          if (result.tab) result.tab.lifecycle = "deliverable";
        }
      } catch (error) {
        throw tabRecoveryError(error, result.tabId);
      }
      printResult({ tab: tabSummary(result.tab), group: result.tabs?.groups?.find((entry) => entry.id === result.tab?.groupId), waitMs: result.waitMs, sessionId: result.sessionId, turnId: result.turnId }, options);
      return;
    }
    if (command === "view") {
      if (!positionals[0]) throw new Error("view requires a URL");
      let opened;
      if (boolOption(options, "reuse_existing", false)) {
        const tabs = await readTabs(client);
        const existing = tabs.tabs.find((tab) => tab.url === positionals[0]);
        if (existing) {
          const requestedSession = options.session === undefined ? undefined : String(options.session);
          if (existing.owner === "agent" || (typeof existing.sessionId === "string" && existing.sessionId.length > 0)) {
            if (!requestedSession) throw new Error("view --reuse-existing requires --session when reusing an owned tab");
            if (String(existing.sessionId) !== requestedSession) throw new Error("view --reuse-existing session does not own the selected tab");
          }
          opened = { tabId: existing.id, tab: existing, tabs, waitMs: 0, sessionId: requestedSession, turnId: numberOption(options, "turn", 0) };
        }
      }
      if (!opened) opened = await openTab(client, positionals[0], { ...options, active: !boolOption(options, "inactive", false) });
      const inspected = await inspectTab(client, opened.tab || opened.tabId, options, opened.sessionId);
      if (!boolOption(options, "temporary", false) && opened.tab?.owner === "agent") {
        const sessionId = String(opened.sessionId || requiredSession(options, "view"));
        const turnId = opened.turnId ?? requiredTurn(options, "view");
        await client.request("mark_handoff", { tabId: inspected.tab.id, handle: inspected.tab.handle, sessionId, turnId });
        inspected.tab.lifecycle = "handoff";
      }
      const group = opened.tabs?.groups?.find((entry) => entry.id === inspected.tab?.groupId);
      printResult({ ...inspected, group, waitMs: opened.waitMs, sessionId: opened.sessionId, turnId: opened.turnId }, options);
      return;
    }
    if (command === "snapshot" || command === "extract") {
      if (!positionals[0]) throw new Error(`${command} requires a tab id`);
      const responseMode = boolOption(options, "raw", false) ? "raw" : "compact";
      const result = await client.request(command, { tabId: Number(positionals[0]), responseMode, ...(options.session === undefined ? {} : { sessionId: String(options.session) }) });
      if (command === "extract") {
        result.content.text = truncate(result.content.text, numberOption(options, "max_chars", DEFAULT_MAX_CHARS));
        result.content.markdown = truncate(result.content.markdown, numberOption(options, "max_chars", DEFAULT_MAX_CHARS));
      }
      printResult(result, options);
      return;
    }
    if (command === "screenshot") {
      if (!positionals[0] || !positionals[1]) throw new Error("screenshot requires <tabId> <path>");
      const result = await client.request("screenshot", { tabId: Number(positionals[0]), fullPage: boolOption(options, "full_page", false), ...(options.session === undefined ? {} : { sessionId: String(options.session) }) });
      const target = resolve(positionals[1]);
      mkdirSync(dirname(target), { recursive: true });
      const data = Buffer.from(result.data, "base64");
      writeFileSync(target, data);
      printResult({ tabId: Number(positionals[0]), path: target, bytes: data.length, mimeType: result.mimeType }, options);
      return;
    }
    if (command === "close") {
      if (!positionals[0]) throw new Error("close requires a tab id");
      const sessionId = options.session === undefined ? undefined : String(options.session);
      printResult(await client.request("close_tab", { tabId: Number(positionals[0]), userRequested: true, ...(sessionId === undefined ? {} : { sessionId }) }), options);
      return;
    }
    if (command === "cleanup") {
      const params = {
        ...(options.session ? { sessionId: String(options.session) } : {}),
        ...(boolOption(options, "recover_stale", false) ? { recoverStale: true } : {}),
      };
      printResult(await client.request("cleanup", params), options);
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    client.close();
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    const code = typeof error?.code === "string" ? `[${error.code}] ` : "";
    console.error(`pi-control-chrome: ${code}${error.message}`);
    process.exitCode = 1;
  });
}

export { BridgeClient, createClient };
