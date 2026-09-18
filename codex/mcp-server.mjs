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
const MAX_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const WAIT_REQUEST_GRACE_MS = 20_000;
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const BRIDGE_HOST = process.env.PI_CONTROL_CHROME_BRIDGE_HOST || "127.0.0.1";
const configuredBridgePort = Number(process.env.PI_CONTROL_CHROME_BRIDGE_PORT || 17318);
const BRIDGE_PORT = Number.isInteger(configuredBridgePort) && configuredBridgePort > 0 && configuredBridgePort < 65_536 ? configuredBridgePort : 17318;
const BRIDGE_ORIGIN = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
const BRIDGE_PATH = fileURLToPath(new URL("../bridge/server.mjs", import.meta.url));
const TOKEN_FILE = process.env.PI_CONTROL_CHROME_TOKEN_FILE || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent", "pi-control-chrome.token");

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
const TEXT_ANY = { type: "array", items: string("Literal text to match."), minItems: 1, maxItems: 20, description: "For text waits, succeed when any listed literal is present; the result reports matchedText and terminalState." };
const FAILURE_TEXT_ANY = { type: "array", items: string("Literal failure text to match."), minItems: 1, maxItems: 20, description: "For state=text waits, return immediately with failed=true when any listed failure literal is present." };
const RESPONSE_MODE = { type: "string", enum: ["compact", "raw"], description: "Compact semantic Page Map is the default; use raw only for page-abstraction diagnostics." };
const COORDINATE = object({ x: number(), y: number() }, ["x", "y"]);

function schema(properties, required = []) {
  return object(properties, required);
}

function tool(name, description, method, inputSchema, transform) {
  return Object.freeze({ name, description, method, inputSchema, transform });
}

const ALL_TOOLS = [
  tool("browser_doctor", "Diagnose the local Bridge, extension connection, active browser target and Chrome/Edge competition without changing tabs.", "doctor", schema()),
  tool("browser_status", "Return the connected Chrome/Edge browser identity, target stability and Bridge state as one small read. The capability revision stands in for the boolean capability map, and per-request metrics, targets and recovery detail live in browser_doctor. When multiple targets exist, provide browserId and acknowledgeBrowserId explicitly.", "status", schema({
    browserId: string("Select a connected browser target by browserId."),
    acknowledgeBrowserId: string("Explicitly acknowledge this browserId after confirming a browser switch."),
  })),
  tool("browser_targets", "List connected Chrome/Edge browser targets without selecting one. Use browser_status with an explicit browserId to activate the intended target when multiple targets are available.", "list_targets", schema()),
  tool("browser_target_lease", "Explicitly acquire, release, or inspect a session-scoped lease for a browser target before advanced multi-target control. Ordinary single-target browser operations do not require a lease.", "target_lease", schema({
    action: { type: "string", enum: ["acquire", "release", "release_session", "status"], description: "Lease action." },
    browserId: string("Browser target id. Required for acquire and release; omit for release_session and status."),
  }, ["action"])),
  tool("browser_restart", "After the user explicitly confirms a Bridge restart, restart the shared Bridge cooperatively without asking the user to type a command. Pass confirmed=true only after that confirmation; this does not restart DSH or Edge and does not close tabs.", "bridge_restart", schema({
    confirmed: boolean("Must be true only after the user explicitly confirms the Bridge restart."),
  }, ["confirmed"])),
  tool("browser_reload_extension", "Apply an updated pi-control-chrome distribution to the running browser by reloading its extension. The loaded service worker keeps the code it started with, so a refreshed profile stays inert until this runs; the extension restarts, in-flight browser work is cancelled, and the Bridge reconnects the same target. Pass confirmed=true only after the user explicitly confirms the reload, then refresh browser_status and every tab, snapshotId, ref, and handle.", "reload_extension", schema({
    confirmed: boolean("Must be true only after the user explicitly confirms the extension reload."),
    delayMs: integer("Delay before the worker restarts so the response can reach the caller first; defaults to 250 ms and is capped at 5000 ms."),
  }, ["confirmed"])),
  tool("browser_tabs", "List Chrome/Edge windows, tabs, tab groups, ownership and lifecycle state. The listing is complete by default and hard-capped at 200 rows; narrow it with query (title/url substring) and owner (user/agent/claimed) instead of paging, and pass limit only when you want fewer rows. totalTabs/matchedTabs/omittedTabs report any bound that applied. Choose tabs using owner, sessionId and sessionScope, never groupId alone.", "list_tabs", schema({
    query: string("Case-insensitive substring matched against tab title and URL."),
    limit: integer("Maximum rows to return; omit for the complete listing (hard-capped at 200). omittedTabs reports dropped rows."),
    owner: { type: "string", enum: ["user", "agent", "claimed"], description: "Return only tabs with this ownership state." },
    documentIdentity: boolean("When false, return tab-fence-only handles without probing document identity; re-observe before document-bound work."),
  })),
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
  tool("browser_snapshot", "Read the active page title and bounded semantic Page Map. eN refs require the matching snapshotId; navigation is a hard boundary. Use responseMode=raw only to diagnose the abstraction.", "snapshot", schema({ ...PAGE_FIELDS, selector: string(), responseMode: RESPONSE_MODE, maxChars: integer(), maxNodes: integer() }, ["handle"])),
  tool("browser_accessibility_snapshot", "Return the bounded Chromium accessibility tree as full, incremental diff or unchanged text. aN refs require the matching snapshotId; sensitive values remain redacted.", "snapshot", schema({ ...PAGE_FIELDS, selector: string(), responseMode: RESPONSE_MODE, maxChars: integer(), maxNodes: integer(), disableDiffing: boolean() }, ["handle"]), (args) => ({ ...args, accessibilityOnly: true })),
  tool("browser_extract", "Extract the current page as bounded plain text and simple Markdown without using a separate web scraper. Compact reads select primary content by default; use scope=log with tail=true for a log/pre region, or logMatch to return only matching log lines.", "extract", schema({ ...PAGE_FIELDS, selector: string(), includeFrames: boolean(), responseMode: RESPONSE_MODE, scope: { type: "string", enum: ["primary", "log", "body"] }, tail: boolean(), logMatch: string("For scope=log, keep only lines containing this case-insensitive literal."), logMaxMatches: integer("Maximum matching log lines to return."), maxChars: integer() }, ["handle"])),
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
  tool("browser_wait", "Wait for a selected tab to load, reach a URL, show or hide text, or reach an element state. Use text or textAny for text waits; textAny returns the first terminal literal found. Use target for element waits; set reload=true for externally refreshed pages such as Jenkins.", "wait", schema({
    ...PAGE_FIELDS,
    state: WAIT_STATE,
    url: string(),
    urlIncludes: string(),
    text: string(),
    textAny: TEXT_ANY,
    failureTextAny: FAILURE_TEXT_ANY,
    target: TARGET,
    snapshotId: string(),
    exact: boolean(),
    reload: boolean("Reload between polls; opt in only for externally refreshed pages."),
    reloadIntervalMs: integer("Minimum interval between opt-in reload polls; defaults to 5000 ms."),
    timeoutMs: number("Optional positive timeout in milliseconds."),
  }, ["handle"])),
  tool("browser_probe_interaction", "Perform one explicit browser interaction and return target resolution, action confirmation, document identity, incremental Console errors and post-action target state. The side effect is never automatically replayed.", "probe_interaction", schema({
     ...PAGE_FIELDS,
     operation: { type: "string", enum: ["click", "double_click", "dblclick", "fill", "type", "press", "select", "check", "uncheck", "set_checked", "hover", "focus", "scroll"] },
     snapshotId: string(),
     ref: string(),
     selector: string(),
     target: TARGET,
     value: anyValue(),
     key: string(),
     deltaX: number(),
     deltaY: number(),
     timeoutMs: number("Optional positive timeout in milliseconds."),
     settle: schema({ state: WAIT_STATE, url: string(), urlIncludes: string(), text: string(), textAny: TEXT_ANY, failureTextAny: FAILURE_TEXT_ANY, target: TARGET, exact: boolean(), timeoutMs: number() }),
     settleMs: number("Optional bounded settle delay in milliseconds."),
     only: { type: "string", enum: ["errors", "all"] },
     maxEvents: integer("Maximum post-action Console events."),
     maxChars: integer("Maximum post-action Console characters."),
   }, ["handle", "operation"])),
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
  tool("browser_console", "Enable and read bounded Runtime console, pageerror and Log entries captured from a browser tab. Use since/nextSince for incremental reads and only=errors to filter runtime failures.", "console_logs", schema({ ...TAB_FIELDS, action: string(), clear: boolean(), only: { type: "string", enum: ["all", "errors"] }, since: string(), maxEvents: integer(), maxChars: integer() }, ["handle"])),
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
// The Codex-aligned default: operations that work on tabs the user already has,
// kept small because this server's tool list is the caller's model-visible
// catalog. A node_repl-shaped client instead reads the list once at startup and
// projects it into a kernel, so it wants the complete surface; an explicit
// comma-separated list selects any other subset.
//
// Exposure is decided once, here, so a session's catalog never changes while it
// runs — the invariant every consumer of this server relies on.
const DEFAULT_EXPOSED_TOOL_NAMES = new Set([
  "browser_status",
  "browser_targets",
  "browser_target_lease",
  "browser_restart",
  "browser_reload_extension",
  "browser_tabs",
  "browser_snapshot",
  "browser_accessibility_snapshot",
  "browser_extract",
  "browser_wait",
  "browser_probe_interaction",
  "browser_click",
  "browser_fill",
]);

function selectExposedTools(requested) {
  const want = typeof requested === "string" ? requested.trim() : "";
  if (want === "") return ALL_TOOLS.filter(({ name }) => DEFAULT_EXPOSED_TOOL_NAMES.has(name));
  if (want === "all" || want === "*") return ALL_TOOLS;
  const names = want.split(",").map((entry) => entry.trim()).filter(Boolean);
  const known = new Set(ALL_TOOLS.map(({ name }) => name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`PI_CONTROL_CHROME_TOOLS lists unknown tools: ${unknown.join(", ")}`);
  return ALL_TOOLS.filter(({ name }) => names.includes(name));
}

// Every bridge operation answers with a decorated JSON object, so each tool can
// declare `outputSchema` and answer with `structuredContent` as well as the text
// block. Without it a caller can only guess whether a result carries `tabs`,
// `items` or `files`, and must JSON.parse a string out of a text block to find
// out.
//
// `additionalProperties: true` is deliberate: the bridge's per-operation payload
// grows over time, and an output schema stricter than reality would reject valid
// results in clients that validate. The fields named here are the ones this
// server can state from the bridge's own contract; anything else a caller needs
// it can read off the object at runtime.
const RESULT_ENVELOPE = {
  browserId: string("Connected browser target this result came from."),
  profile: string("Browser profile id."),
  connectionId: string(),
  connectionGeneration: integer(),
};
const outputObject = (properties, description) => ({
  type: "object",
  ...(description ? { description } : {}),
  properties: { ...RESULT_ENVELOPE, ...properties },
  additionalProperties: true,
});

// Field types below are MEASURED against real responses from this Bridge, never
// inferred: a declared schema is enforced by validating clients — the SDK rejects a
// `structuredContent` that does not match — so a wrong guess fails the call instead of
// merely documenting it badly. Two from the first pass: `browser_console`'s `baseline`
// is an object (declared as a string, which broke the call outright) and
// `browser_close_tab`'s `closed` is a number (declared as a boolean). A field absent
// from a given response is fine, because nothing here is `required`.
const TOOL_OUTPUT_SCHEMAS = Object.freeze({
  browser_status: outputObject({
    connected: boolean("Whether a browser target is connected."),
    state: string(),
    browser: string('Browser family, e.g. "edge".'),
    extensionVersion: string(),
    connectedAt: integer(),
    capabilityRevision: integer("Revision of the advertised capability set."),
    bridge: openObject("Bridge health: ok, version, port, extensionConnected, readyTargets."),
    targetStability: openObject("Target stability: stable, changed, acknowledged, requiresAcknowledgement, competition."),
  }, "One small connection read; per-request metrics and recovery detail live in browser_doctor."),
  browser_tabs: outputObject({
    tabs: array(openObject(), "Tab rows: id, browserId, windowId, index, active, pinned, title, url, status, groupId, owner, stale, handle, sessionScope."),
    totalTabs: integer(),
    matchedTabs: integer("Rows matched before the limit applied."),
    omittedTabs: integer("Rows dropped by the limit or the hard cap."),
    nextAction: string(),
    recommendation: string(),
    groups: array(openObject(), "Tab groups."),
  }, "The complete tab listing unless query, owner or limit narrowed it."),
  browser_snapshot: outputObject({
    tabId: number(),
    tab: openObject("The tab this snapshot came from."),
    snapshot: openObject("Bounded semantic Page Map: title, url, snapshotId, nodes and eN refs."),
  }, "Active page title and bounded semantic Page Map."),
  browser_accessibility_snapshot: outputObject({
    tabId: number(),
    tab: openObject(),
    snapshotId: string(),
    mode: string("full, diff or unchanged."),
    state: string(),
    nodeCount: integer(),
    changedNodeCount: integer(),
    charCount: integer(),
    truncated: boolean(),
    nextAction: string(),
    recommendation: string(),
    recovery: string(),
  }),
  browser_extract: outputObject({
    tabId: number(),
    tab: openObject(),
    content: openObject("Extracted content plus any bound that applied."),
    truncated: boolean(),
    omitted: openObject(),
    nextAction: string(),
    recommendation: string(),
    recovery: string(),
  }),
  browser_wait: outputObject({
    tab: openObject(),
    condition: string(),
    matched: boolean(),
    matchedText: string(),
    terminalState: string(),
  }, "Wait outcome. Text waits also report matchedText and terminalState."),
  browser_targets: outputObject({
    state: string(),
    targets: array(openObject(), "Connected browser targets, each with browserId, browser and profile."),
    bridgeHealth: openObject(),
  }),
  browser_target_lease: outputObject({
    ok: boolean(),
    action: string(),
    leases: array(openObject(), "Current target leases."),
    observability: openObject(),
  }),
  browser_doctor: outputObject({
    ok: boolean(),
    state: string(),
    recommendation: string(),
    bridgeHealth: openObject(),
    targets: array(openObject()),
    issues: array(openObject()),
    notices: array(openObject()),
  }, "Diagnosis rather than a page read; it changes no tabs."),
  browser_selected: outputObject({
    tab: openObject("The currently selected tab."),
  }),
  browser_navigate: outputObject({
    tab: openObject("The navigated tab, including any transitionPending marker."),
  }),
  browser_new_tab: outputObject({
    tab: openObject("The created Agent-owned tab."),
    currentAgentSessionId: string(),
    groupId: number(),
    tabFence: string(),
  }),
  browser_download: outputObject({
    downloads: array(openObject(), "Download entries."),
  }),
  browser_close_tab: outputObject({
    closed: number("How many tabs the call closed."),
  }),
  browser_console: outputObject({
    tabId: number(),
    logs: array(openObject(), "Console entries: level, text and timestamp."),
    logCount: integer(),
    logTotalCount: integer(),
    logCharCount: integer(),
    logTruncated: boolean(),
    maxLogChars: integer(),
    maxLogs: integer(),
    only: string(),
    baseline: openObject("Revision marker for incremental reads; an object, not a string."),
    nextSince: string("Cursor for the next incremental read."),
  }, "Debugger-backed read; enable first when the listing is empty."),
  browser_network: outputObject({
    tabId: number(),
    requests: array(openObject(), "Request entries, each with requestId and loaderId."),
    requestCount: integer(),
    requestTotalCount: integer(),
    requestCharCount: integer(),
    requestTruncated: boolean(),
    maxRequestChars: integer(),
    maxRequests: integer(),
  }, "Debugger-backed read; pass both requestId and its loaderId to fetch a response body."),
  browser_screenshot: outputObject({
    tabId: number(),
    mimeType: string(),
    path: string("Written when the call supplied path; the image data itself is a content block."),
  }),
});

const TOOLS = selectExposedTools(process.env.PI_CONTROL_CHROME_TOOLS)
  .map((entry) => Object.freeze({
    ...entry,
    outputSchema: TOOL_OUTPUT_SCHEMAS[entry.name]
      ?? outputObject({}, "The bridge operation's JSON result, decorated with the envelope below."),
  }));
const TOOL_MAP = new Map(TOOLS.map((entry) => [entry.name, entry]));
const COMPACT_READS = new Set(["browser_snapshot", "browser_extract", "browser_accessibility_snapshot", "browser_tabs", "browser_selected"]);
const MODEL_READ_BUDGETS = Object.freeze({ snapshotChars: 8_000, snapshotNodes: 100, extractChars: 6_000, domChars: 8_000, domNodes: 100, consoleChars: 4_000, consoleEvents: 40 });
let bridgeClient;
let bridgeClientPromise;
let shuttingDown = false;
let operationTail = Promise.resolve();
const activeRequests = new Map();
let targetSelectionRequired = false;

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

function applyModelReadBudget(toolName, params) {
  if (params.responseMode === "raw") return params;
  const budgeted = { ...params };
  if (toolName === "browser_snapshot" || toolName === "browser_accessibility_snapshot") {
    if (budgeted.maxChars === undefined) budgeted.maxChars = MODEL_READ_BUDGETS.snapshotChars;
    if (budgeted.maxNodes === undefined) budgeted.maxNodes = MODEL_READ_BUDGETS.snapshotNodes;
  } else if (toolName === "browser_extract") {
    if (budgeted.maxChars === undefined) budgeted.maxChars = MODEL_READ_BUDGETS.extractChars;
  } else if (toolName === "browser_dom_cua" && params.action === "get_visible_dom") {
    if (budgeted.maxChars === undefined) budgeted.maxChars = MODEL_READ_BUDGETS.domChars;
    if (budgeted.maxNodes === undefined) budgeted.maxNodes = MODEL_READ_BUDGETS.domNodes;
  } else if (toolName === "browser_console" && params.action !== "enable") {
    if (budgeted.maxChars === undefined) budgeted.maxChars = MODEL_READ_BUDGETS.consoleChars;
    if (budgeted.maxEvents === undefined) budgeted.maxEvents = MODEL_READ_BUDGETS.consoleEvents;
  }
  return budgeted;
}

function requestTimeout(args, method) {
  const requested = Number(args?.timeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (method !== "wait") return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(DEFAULT_REQUEST_TIMEOUT_MS, requested + 5_000));
  const bounded = Math.min(Math.floor(requested), MAX_WAIT_TIMEOUT_MS);
  return Math.min(MAX_WAIT_TIMEOUT_MS + WAIT_REQUEST_GRACE_MS, Math.max(DEFAULT_REQUEST_TIMEOUT_MS, bounded + WAIT_REQUEST_GRACE_MS));
}

function assertRequestActive(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Browser request aborted");
}

async function readBridgeHealth() {
  const response = await fetch(`${BRIDGE_ORIGIN}/health`, { signal: AbortSignal.timeout(1_500) });
  const value = await response.json();
  if (!response.ok || value?.ok !== true) throw new Error(`Bridge health failed: HTTP ${response.status}`);
  return value;
}

async function bridgeHealthy() {
  try {
    await readBridgeHealth();
    return true;
  } catch {
    return false;
  }
}

async function waitForBridgeOffline() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await bridgeHealthy())) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out stopping the pi-control-chrome Bridge at ${BRIDGE_ORIGIN}`);
}

async function waitForNewBridge(previousInstanceId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const health = await readBridgeHealth();
      if (typeof health.instanceId === "string" && health.instanceId !== previousInstanceId) return health;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for a new pi-control-chrome Bridge instance at ${BRIDGE_ORIGIN}`);
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

let bridgeRestartPromise;

async function restartBridgeNow() {
  const client = await ensureBridgeClient();
  const previousTarget = client.getAcknowledgedTarget();
  const health = await readBridgeHealth();
  const previousInstanceId = typeof health.instanceId === "string" ? health.instanceId : undefined;
  if (previousInstanceId === undefined || health.capabilities?.localUserRestart !== true) {
    const error = new Error("The active Bridge does not expose local-user cooperative restart capabilities");
    error.code = "BRIDGE_RESTART_UNSUPPORTED";
    throw error;
  }
  const control = await client.rawRequest("bridge_restart", {
    expectedInstanceId: previousInstanceId,
    requester: "codex",
  }, DEFAULT_REQUEST_TIMEOUT_MS);
  client.close();
  if (bridgeClient === client) bridgeClient = undefined;
  await waitForBridgeOffline();
  await ensureBridgeProcess();
  const nextHealth = await waitForNewBridge(previousInstanceId);
  const targets = Array.isArray(nextHealth.targets) ? nextHealth.targets : [];
  const readyTargets = targets.filter(target => target?.state === undefined || target?.state === "ready");
  const currentTarget = previousTarget === undefined
    ? readyTargets.length === 1 ? readyTargets[0] : undefined
    : readyTargets.find(target => target?.browserId === previousTarget.browserId);
  const requiresTargetSelection = previousTarget !== undefined || readyTargets.length !== 1;
  targetSelectionRequired = requiresTargetSelection;
  const common = {
    ok: true,
    restarted: true,
    recovery: "cooperative_restart",
    previousInstanceId,
    control,
    bridgeHealth: nextHealth,
    targets,
    handleRefreshRequired: true,
    snapshotRefreshRequired: true,
    documentIncarnationRefreshRequired: true,
    targetRequired: requiresTargetSelection,
    nextAction: "browser_status",
    recommendation: requiresTargetSelection ? "refresh_browser_target" : "refresh_browser_status",
    ...(previousTarget === undefined ? {} : { previousBrowserId: previousTarget.browserId }),
    ...(currentTarget === undefined ? {} : { target: currentTarget }),
  };
  if (nextHealth.extensionConnected !== true) {
    return { ...common, ok: false, connected: false, state: "bridge_only", completed: false, retryable: true, recommendation: "retry_browser_status" };
  }
  return { ...common, connected: true, state: requiresTargetSelection ? "target_required" : "connected" };
}

async function restartBridge(args) {
  if (args?.confirmed !== true) {
    const error = new Error("Bridge restart requires explicit user confirmation; ask the user before retrying with confirmed=true");
    error.code = "BRIDGE_RESTART_CONFIRMATION_REQUIRED";
    error.details = { requiresUserConfirmation: true };
    throw error;
  }
  if (bridgeRestartPromise !== undefined) return bridgeRestartPromise;
  const operation = restartBridgeNow().finally(() => {
    if (bridgeRestartPromise === operation) bridgeRestartPromise = undefined;
  });
  bridgeRestartPromise = operation;
  return operation;
}

function withSession(params) {
  return { ...params, sessionId: SESSION_ID };
}

async function listTargets(client, signal) {
  return client.rawRequest("list_targets", withSession({}), DEFAULT_REQUEST_TIMEOUT_MS, undefined, signal);
}

async function invokeTool(spec, args, signal) {
  assertRequestActive(signal);
  if (spec.name === "browser_restart") return restartBridge(args);
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
  params = applyModelReadBudget(spec.name, params);
  if ((COMPACT_READS.has(spec.name) || (spec.name === "browser_dom_cua" && params.action === "get_visible_dom")) && params.responseMode === undefined) params.responseMode = "compact";
  params = withSession(params);
  assertRequestActive(signal);

  if (spec.name === "browser_doctor") return client.rawRequest("doctor", params, requestTimeout(args, "doctor"), undefined, signal);
  if (spec.name === "browser_targets") {
    const inventory = await listTargets(client, signal);
    const health = await readBridgeHealth().catch(() => undefined);
    return {
      state: health?.extensionConnected === false ? "bridge_only" : "connected",
      targets: Array.isArray(inventory?.targets) ? inventory.targets : [],
      ...(health === undefined ? {} : { bridgeHealth: health }),
    };
  }
  if (spec.name === "browser_status") {
    if (targetSelectionRequired && args.browserId === undefined && args.acknowledgeBrowserId === undefined) {
      const inventory = await listTargets(client, signal).catch(() => ({ targets: [] }));
      const health = await readBridgeHealth().catch(() => undefined);
      return {
        connected: false,
        state: "target_required",
        targetRequired: true,
        completed: false,
        retryable: true,
        nextAction: "browser_status",
        recommendation: "select_browser_target",
        error: { code: "TARGET_REQUIRED", message: "The browser connection changed; provide browserId to acknowledge the current target before retrying browser operations." },
        ...(health === undefined ? {} : { bridgeHealth: health }),
        targets: Array.isArray(inventory?.targets) ? inventory.targets : [],
      };
    }
    try {
      const result = await client.request("status", { ...params, browserId: args.browserId, acknowledgeBrowserId: args.acknowledgeBrowserId }, requestTimeout(args, "status"), signal);
      if (targetSelectionRequired && result?.targetStability?.acknowledged === true) targetSelectionRequired = false;
      return result;
    } catch (error) {
      if (["TARGET_REQUIRED", "TARGET_UNAVAILABLE", "TARGET_CONNECTION_CHANGED"].includes(error?.code)) {
        const inventory = await listTargets(client, signal).catch(() => ({ targets: [] }));
        const health = await readBridgeHealth().catch(() => undefined);
        const code = error.code;
        return {
          connected: false,
          ...(code === "TARGET_REQUIRED" ? { targetRequired: true } : { targetUnavailable: true }),
          state: code === "TARGET_CONNECTION_CHANGED" ? "target_reconnecting" : code === "TARGET_REQUIRED" ? "target_required" : "target_unavailable",
          completed: false,
          retryable: code !== "TARGET_CONNECTION_CHANGED",
          nextAction: "browser_status",
          recommendation: code === "TARGET_REQUIRED" ? "select_browser_target" : "refresh_browser_targets",
          error: {
             code,
             message: error.message,
             ...(error?.details === undefined ? {} : { details: error.details }),
           },
          targets: Array.isArray(inventory?.targets) ? inventory.targets : [],
         ...(health === undefined ? {} : { bridgeHealth: health }),
        };
      }
      throw error;
    }
  }
  if (spec.name === "browser_context_reset") params.mode = "context";
  if (spec.name === "browser_cleanup" || spec.name === "browser_context_reset") {
    const cleanupResult = await client.request("cleanup", params, requestTimeout(args, "cleanup"), signal);
    await client.request("target_lease", withSession({ action: "release_session" }), requestTimeout(args, "target_lease"), signal);
    return cleanupResult;
  }
  if (spec.name === "browser_console" && params.action !== "enable") spec = { ...spec, method: "console_logs" };
  if (spec.name === "browser_network" && params.action !== "enable" && params.action !== "response_body") spec = { ...spec, method: "network_requests" };
  return client.request(spec.method, params, requestTimeout(args, spec.method), signal);
}

function jsonText(value) {
  try { return JSON.stringify(value ?? null); } catch { return "null"; }
}

/** MCP `structuredContent` must be an object; arrays and scalars stay text-only. */
function structuredResult(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function toolResult(name, value, args) {
  if (name !== "browser_screenshot") {
    // The text block and the structured form carry the same projection, so a
    // caller that reads `structuredContent` sees exactly what it sees in the text.
    const projected = compactBrowserResult(name, { ...args, sessionId: SESSION_ID }, value);
    const structured = structuredResult(projected);
    return {
      content: [{ type: "text", text: jsonText(projected) }],
      ...(structured === undefined ? {} : { structuredContent: structured }),
    };
  }
  const result = value && typeof value === "object" ? value : {};
  const { data, ...metadata } = result;
  if (typeof data !== "string" || data.length === 0) {
    const structured = structuredResult(value);
    return {
      content: [{ type: "text", text: jsonText(value) }],
      ...(structured === undefined ? {} : { structuredContent: structured }),
    };
  }
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
    structuredContent: metadata,
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
      await bridgeClient.request("target_lease", withSession({ action: "release_session" }), 5_000);
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
      instructions: "Use browser_status before browser actions. Preserve browserId, tabFence, incarnation and snapshotId; inspect before retrying BROWSER_OPERATION_UNCERTAIN. For Bridge recovery, ask the user for explicit confirmation before calling browser_restart with confirmed=true; acknowledge the new browser connection and refresh handles afterward.",
    });
    return;
  }
  if (message.method === "tools/list") {
    if (message.id === undefined) return;
    response(message.id, { tools: TOOLS.map(({ name, description, inputSchema, outputSchema }) => ({ name, description, inputSchema, outputSchema })) });
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
