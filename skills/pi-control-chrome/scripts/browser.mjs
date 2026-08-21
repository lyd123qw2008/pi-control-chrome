#!/usr/bin/env node

/**
 * Fast common workflows for the pi-control-chrome Skill.
 * Uses the already-running local Bridge and the current Chrome/Edge profile.
 * Requires Node.js 22+ for the built-in WebSocket and fetch APIs.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const BRIDGE_HOST = process.env.PI_CONTROL_CHROME_BRIDGE_HOST || "127.0.0.1";
const BRIDGE_PORT = Number(process.env.PI_CONTROL_CHROME_BRIDGE_PORT || 17318);
const BRIDGE_ORIGIN = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
const BRIDGE_WS = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}/ws`;
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_CHARS = 8_000;

function usage() {
  console.log(`Usage:
  node browser.mjs status [--acknowledge-browser-id <id>] [--json]
  node browser.mjs tabs [--json]
  node browser.mjs group [--json]
  node browser.mjs open <url> [--active|--inactive] [--session <id>] [--json]
  node browser.mjs view <url> [--inactive] [--reuse-existing] [--screenshot <path>] [--json]
  node browser.mjs snapshot <tabId> [--json]
  node browser.mjs extract <tabId> [--max-chars <n>] [--json]
  node browser.mjs screenshot <tabId> <path> [--full-page]
  node browser.mjs close <tabId> [--session <id>] [--json]
  node browser.mjs cleanup [--session <id>] [--json]

Examples:
  node browser.mjs status
  node browser.mjs view http://127.0.0.1:3000/ --screenshot C:\\Temp\\page.png
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
  return { browser: value.browser, browserId: value.browserId, profile: value.profile };
}

class BridgeClient {
  constructor(token) {
    this.token = token;
    this.socket = undefined;
    this.sequence = 0;
    this.pending = new Map();
    this.acknowledgedTarget = undefined;
  }

  async connect() {
    await new Promise((resolveOpen, reject) => {
      const socket = new WebSocket(`${BRIDGE_WS}?role=pi&token=${encodeURIComponent(this.token)}`);
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out connecting to the Pi browser Bridge"));
      }, 5_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      }, { once: true });
      socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
      socket.addEventListener("close", () => {
        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error("Pi browser Bridge disconnected"));
          this.pending.delete(id);
        }
      }, { once: true });
      socket.addEventListener("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Bridge WebSocket error"));
      }, { once: true });
    });
  }

  handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.type !== "response" || !message.id) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message || "Browser request failed"));
    else entry.resolve(message.result);
  }

  rawRequest(method, params = {}, timeoutMs = DEFAULT_TIMEOUT) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Bridge WebSocket is not connected"));
    }
    const id = `skill-${process.pid}-${++this.sequence}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Browser request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.socket.send(JSON.stringify({ type: "request", id, method, params }));
    });
  }

  async request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT) {
    if (method === "status") {
      const { acknowledgeBrowserId, ...statusParams } = params;
      const result = await this.rawRequest("status", statusParams, timeoutMs);
      const target = browserTarget(result);
      const previous = this.acknowledgedTarget;
      const changed = previous !== undefined && previous.browserId !== target?.browserId;
      const acknowledged = target !== undefined && (previous === undefined || !changed || acknowledgeBrowserId === target.browserId);
      if (target !== undefined && acknowledged) this.acknowledgedTarget = target;
      return {
        ...result,
        targetStability: {
          stable: target !== undefined && !changed,
          changed,
          acknowledged,
          requiresAcknowledgement: changed && !acknowledged,
          browser: target?.browser,
          browserId: target?.browserId,
          profile: target?.profile,
          ...(previous === undefined ? {} : { previousBrowser: previous.browser, previousBrowserId: previous.browserId }),
        },
      };
    }
    const status = await this.rawRequest("status", {}, timeoutMs);
    const target = browserTarget(status);
    const previous = this.acknowledgedTarget;
    if (target === undefined) throw new Error("Browser status did not identify an active browser target; run status");
    if (previous !== undefined && previous.browserId !== target.browserId) {
      throw new Error(`Browser target changed from ${previous.browser} (${previous.browserId}) to ${target.browser} (${target.browserId}); run status with --acknowledge-browser-id after disabling the other browser extension`);
    }
    if (previous === undefined) this.acknowledgedTarget = target;
    return this.rawRequest(method, { ...params, expectedBrowserId: target.browserId }, timeoutMs);
  }

  close() {
    this.socket?.close();
  }
}

async function createClient() {
  const health = await bridgeHealth();
  if (!health.extensionConnected) throw new Error("Chrome/Edge extension is not connected. Run /chrome status and reload the unpacked extension if needed.");
  const client = new BridgeClient(await pairingToken());
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
  };
}

async function findTab(client, tabId) {
  const tabs = await client.request("list_tabs");
  const tab = tabs.tabs.find((entry) => Number(entry.id) === Number(tabId));
  if (!tab) throw new Error(`Tab not found: ${tabId}`);
  return { tabs, tab };
}

async function waitForGroupedTab(client, tabId, attempts = 12) {
  let latest;
  for (let i = 0; i < attempts; i += 1) {
    latest = await client.request("list_tabs");
    const tab = latest.tabs.find((entry) => Number(entry.id) === Number(tabId));
    if (tab?.groupId !== undefined && tab.groupId !== -1) return { tabs: latest, tab };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const tab = latest?.tabs.find((entry) => Number(entry.id) === Number(tabId));
  return { tabs: latest, tab };
}

async function openTab(client, url, options) {
  const sessionId = String(options.session || `skill-${process.pid}`);
  const active = boolOption(options, "active", !boolOption(options, "inactive", false));
  const created = await client.request("new_tab", { url, active, sessionId });
  const tabId = created?.tab?.id;
  if (tabId === undefined) throw new Error("Bridge did not return the new tab id");
  const waitStarted = Date.now();
  const waited = await client.request("wait", { tabId, state: "load", timeoutMs: numberOption(options, "timeout_ms", 30_000) });
  const waitMs = Date.now() - waitStarted;
  const grouped = await waitForGroupedTab(client, tabId);
  return { created, waited, tabId, waitMs, ...grouped, sessionId };
}

async function inspectTab(client, tabId, options) {
  const snapshot = await client.request("snapshot", { tabId });
  const extracted = await client.request("extract", { tabId });
  let timing;
  try {
    const evaluated = await client.request("evaluate", {
      tabId,
      expression: `JSON.stringify((()=>{const n=performance.getEntriesByType('navigation')[0];return {readyState:document.readyState,title:document.title,url:location.href,domNodes:document.getElementsByTagName('*').length,textChars:(document.body?.innerText||'').length,navigation:n?{responseStart:Math.round(n.responseStart),domContentLoaded:Math.round(n.domContentLoadedEventEnd),load:Math.round(n.loadEventEnd),duration:Math.round(n.duration)}:null};})())`,
    });
    const value = evaluationValue(evaluated);
    timing = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    timing = { error: error.message };
  }

  let screenshot;
  if (options.screenshot) {
    const captured = await client.request("screenshot", { tabId, fullPage: boolOption(options, "full_page", false) });
    const target = resolve(String(options.screenshot));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(captured.data, "base64"));
    screenshot = { path: target, bytes: Buffer.byteLength(Buffer.from(captured.data, "base64")), mimeType: captured.mimeType };
  }

  return {
    tab: tabSummary((await findTab(client, tabId)).tab),
    snapshot: {
      available: Boolean(snapshot?.snapshot),
      elementCount: snapshot?.snapshot?.elements?.length ?? null,
      accessibilityAvailable: Boolean(snapshot?.snapshot?.accessibility),
      frameCount: snapshot?.frameTree?.frameTree ? 1 + (snapshot.frameTree.frameTree.childFrames?.length || 0) : null,
    },
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
  const { client, health } = await createClient();
  try {
    if (command === "status") {
      const status = await client.request("status", options.acknowledge_browser_id ? { acknowledgeBrowserId: String(options.acknowledge_browser_id) } : {});
      printResult({ status, health }, options);
      return;
    }
    if (command === "tabs") {
      const result = await client.request("list_tabs");
      printResult(result, options);
      return;
    }
    if (command === "group") {
      const result = await client.request("list_tabs");
      printResult(result.groups || [], options);
      return;
    }
    if (command === "open") {
      if (!positionals[0]) throw new Error("open requires a URL");
      const result = await openTab(client, positionals[0], options);
      if (boolOption(options, "handoff", false)) {
        await client.request("mark_handoff", { tabId: result.tabId, sessionId: result.sessionId });
        if (result.tab) result.tab.lifecycle = "handoff";
      }
      if (boolOption(options, "deliverable", false)) {
        await client.request("mark_deliverable", { tabId: result.tabId, sessionId: result.sessionId });
        if (result.tab) result.tab.lifecycle = "deliverable";
      }
      printResult({ tab: tabSummary(result.tab), group: result.tabs?.groups?.find((entry) => entry.id === result.tab?.groupId), waitMs: result.waitMs }, options);
      return;
    }
    if (command === "view") {
      if (!positionals[0]) throw new Error("view requires a URL");
      let opened;
      if (boolOption(options, "reuse_existing", false)) {
        const tabs = await client.request("list_tabs");
        const existing = tabs.tabs.find((tab) => tab.url === positionals[0]);
        if (existing) opened = { tabId: existing.id, tab: existing, tabs, waitMs: 0 };
      }
      if (!opened) opened = await openTab(client, positionals[0], { ...options, active: !boolOption(options, "inactive", false) });
      const inspected = await inspectTab(client, opened.tabId, options);
      if (!boolOption(options, "temporary", false) && opened.tab?.owner === "agent") {
        await client.request("mark_handoff", { tabId: opened.tabId });
        inspected.tab.lifecycle = "handoff";
      }
      const group = opened.tabs?.groups?.find((entry) => entry.id === inspected.tab?.groupId);
      printResult({ ...inspected, group, waitMs: opened.waitMs }, options);
      return;
    }
    if (command === "snapshot" || command === "extract") {
      if (!positionals[0]) throw new Error(`${command} requires a tab id`);
      const result = await client.request(command, { tabId: Number(positionals[0]) });
      if (command === "extract") {
        result.content.text = truncate(result.content.text, numberOption(options, "max_chars", DEFAULT_MAX_CHARS));
        result.content.markdown = truncate(result.content.markdown, numberOption(options, "max_chars", DEFAULT_MAX_CHARS));
      }
      printResult(result, options);
      return;
    }
    if (command === "screenshot") {
      if (!positionals[0] || !positionals[1]) throw new Error("screenshot requires <tabId> <path>");
      const result = await client.request("screenshot", { tabId: Number(positionals[0]), fullPage: boolOption(options, "full_page", false) });
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
      const params = options.session ? { sessionId: String(options.session) } : {};
      printResult(await client.request("cleanup", params), options);
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`pi-control-chrome: ${error.message}`);
  process.exitCode = 1;
});
