import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import WebSocket from "ws";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 17318;
const BRIDGE_WS = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}/ws`;
const SESSION_ID = randomUUID();
const OWNER_TOKEN_FILE = join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent", "pi-control-chrome.owner");
const BRIDGE_WAIT_ATTEMPTS = 30;
const BRIDGE_WAIT_DELAY_MS = 100;
let paused = false;

function localJsonRequest(path: string, timeoutMs: number): Promise<{ statusCode: number; value: any }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: BRIDGE_HOST, port: BRIDGE_PORT, path, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        try {
          resolve({ statusCode: response.statusCode || 0, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Local bridge request timed out: ${path}`)));
    request.on("error", reject);
    request.end();
  });
}

async function ensureOwnerToken(): Promise<string> {
  try {
    const existing = (await readFile(OWNER_TOKEN_FILE, "utf8")).trim();
    if (existing) return existing;
  } catch {}
  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(OWNER_TOKEN_FILE), { recursive: true });
  await writeFile(OWNER_TOKEN_FILE, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

const TAB_ID = Type.Optional(Type.Number({ description: "Chrome/Edge tab id. Omit to use the active tab." }));
const SELECTOR = Type.Optional(Type.String({ description: "Optional CSS selector. Prefer a ref from browser_snapshot." }));

class BridgeClient {
  private socket?: WebSocket;
  private bridgeProcess?: ChildProcess;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private connecting?: Promise<void>;

  async start(): Promise<void> {
    await this.ensureBridgeProcess();
    await this.connect();
  }

  async stop(): Promise<void> {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Pi browser bridge stopped"));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = undefined;
    // The bridge is intentionally left alive so a newly reloaded Pi session can
    // reconnect without restarting Chrome or the extension.
  }

  async health(): Promise<any> {
    const response = await localJsonRequest("/health", 1500);
    if (response.statusCode !== 200) throw new Error(`Bridge health failed: HTTP ${response.statusCode}`);
    return response.value;
  }

  async restart(): Promise<any> {
    const health = await this.health();
    const instanceId = typeof health.instanceId === "string" ? health.instanceId : undefined;
    if (!instanceId || health.managedBy !== "pi" || health.capabilities?.cooperativeRestart !== true) {
      throw new Error("BRIDGE_RESTART_UNSUPPORTED: the active Bridge is not a Pi-owned cooperative instance");
    }
    const ownerToken = await ensureOwnerToken();
    const control = await this.request("bridge_restart", {
      expectedInstanceId: instanceId,
      managedBy: "pi",
      ownerToken,
    });
    await this.waitForOffline();
    await this.startBridgeProcess();
    const next = await this.waitForHealth();
    if (next.instanceId === instanceId) throw new Error("BRIDGE_INSTANCE_CHANGED: Bridge restart reused the previous instance");
    return { ok: true, restarted: true, recovery: "cooperative_restart", previousInstanceId: instanceId, control, bridgeHealth: next };
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Pi browser bridge is not connected");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser request timed out: ${method}`));
      }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "request", id, method, params }));
    });
  }

  private async ensureBridgeProcess(): Promise<void> {
    if (await this.isHealthy()) return;
    await this.startBridgeProcess();
    await this.waitForHealth();
  }

  private async startBridgeProcess(): Promise<void> {
    const bridgePath = fileURLToPath(new URL("../bridge/server.mjs", import.meta.url));
    if (!existsSync(bridgePath)) throw new Error(`Missing Pi browser bridge: ${bridgePath}`);
    const tokenFile = join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent", "pi-control-chrome.token");
    await ensureOwnerToken();
    this.bridgeProcess = spawn(process.execPath, [
      bridgePath,
      "--port", String(BRIDGE_PORT),
      "--token-file", tokenFile,
      "--managed-by", "pi",
      "--owner-token-file", OWNER_TOKEN_FILE,
    ], {
      stdio: "ignore",
      windowsHide: true,
    });
    this.bridgeProcess.unref();
  }

  private async waitForHealth(): Promise<any> {
    for (let i = 0; i < BRIDGE_WAIT_ATTEMPTS; i += 1) {
      if (await this.isHealthy()) return await this.health();
      await new Promise((resolve) => setTimeout(resolve, BRIDGE_WAIT_DELAY_MS));
    }
    throw new Error("Timed out starting the Pi browser bridge");
  }

  private async waitForOffline(): Promise<void> {
    for (let i = 0; i < BRIDGE_WAIT_ATTEMPTS; i += 1) {
      if (!(await this.isHealthy())) return;
      await new Promise((resolve) => setTimeout(resolve, BRIDGE_WAIT_DELAY_MS));
    }
    throw new Error("Timed out stopping the Pi browser bridge");
  }


  private async isHealthy(): Promise<boolean> {
    try {
      const response = await localJsonRequest("/health", 700);
      return response.statusCode === 200 && response.value?.ok === true;
    } catch {
      return false;
    }
  }


  private async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.ensureBridgeProcess();
      const response = await localJsonRequest("/pair", 2000);
      if (response.statusCode !== 200) throw new Error(`Bridge pairing failed: HTTP ${response.statusCode}`);
      const pairing = response.value as { token?: string };
      if (!pairing.token) throw new Error("Bridge pairing response did not contain a token");
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`${BRIDGE_WS}?role=pi&token=${encodeURIComponent(pairing.token!)}`);
        this.socket = socket;
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error("Timed out connecting to the Pi browser bridge"));
        }, 5000);
        socket.once("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.on("message", (raw) => this.handleMessage(raw.toString()));
        socket.once("close", () => {
          if (this.socket === socket) this.socket = undefined;
          for (const [id, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error("Pi browser bridge disconnected"));
            this.pending.delete(id);
          }
        });
        socket.once("error", (error) => {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private handleMessage(raw: string): void {
    try {
      const message = JSON.parse(raw) as { type?: string; id?: string; result?: unknown; error?: { message?: string } };
      if (message.type !== "response" || !message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || "Browser request failed"));
      else entry.resolve(message.result);
    } catch {
      // Ignore malformed bridge events; the next request will report connection state.
    }
  }
}

const bridge = new BridgeClient();

function textResult(value: unknown, details?: unknown) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    details,
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Browser error: ${message}` }], details: { error: message } };
}

async function call(method: string, params: Record<string, unknown> = {}) {
  if (paused && !["status", "list_tabs", "selected_tab", "cleanup"].includes(method)) {
    throw new Error("Pi browser control is paused; run /chrome resume first");
  }
  const result = await bridge.request(method, { ...params, sessionId: SESSION_ID });
  if (method === "status") {
    try { return { ...result, bridgeHealth: await bridge.health() }; } catch { return result; }
  }
  return result;
}

function registerBrowserTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_status",
    label: "Browser Status",
    description: "Return the connected Chrome/Edge browser and Pi bridge status.",
    parameters: Type.Object({}),
    async execute() {
      try { return textResult(await call("status")); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_tabs",
    label: "Browser Tabs",
    description: "List Chrome/Edge windows, tabs, tab groups, ownership and lifecycle state.",
    parameters: Type.Object({}),
    async execute() {
      try { return textResult(await call("list_tabs")); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_selected",
    label: "Selected Browser Tab",
    description: "Return the currently selected Chrome/Edge tab.",
    parameters: Type.Object({}),
    async execute() {
      try { return textResult(await call("selected_tab")); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_claim_tab",
    label: "Claim Browser Tab",
    description: "Claim an existing user tab using its current tab id and optional title/URL snapshot. Fails if the snapshot changed.",
    parameters: Type.Object({
      tabId: Type.Number(),
      windowId: Type.Optional(Type.Number()),
      title: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("claim_tab", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_select_tab",
    label: "Select Browser Tab",
    description: "Select an existing browser tab by id, optionally focusing its window.",
    parameters: Type.Object({ tabId: Type.Number(), focusWindow: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("select_tab", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_new_tab",
    label: "New Browser Tab",
    description: "Create an Agent-owned tab and place it in the Pi tab group.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Initial URL. Defaults to about:blank." })),
      active: Type.Optional(Type.Boolean({ description: "Whether to activate the new tab." })),
    }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("new_tab", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Read the active page title, URL, visible text and interactive elements with stable eN refs.",
    parameters: Type.Object({ tabId: TAB_ID }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("snapshot", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_extract",
    label: "Extract Browser Page",
    description: "Extract the current page as bounded plain text and simple Markdown without fetching it through a separate web scraper.",
    parameters: Type.Object({ tabId: TAB_ID }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("extract", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_accessibility_snapshot",
    label: "Browser Accessibility Snapshot",
    description: "Return the accessibility-oriented semantic tree included in the current page snapshot.",
    parameters: Type.Object({ tabId: TAB_ID }),
    async execute(_toolCallId, params) {
      try {
        const result = await call("snapshot", params) as { snapshot?: { accessibility?: unknown } };
        return textResult(result.snapshot?.accessibility ?? result);
      } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_locator",
    label: "Browser Locator",
    description: "Playwright-style locator operations: css, role, text, label, placeholder and testid strategies plus count, first, last, nth, text, attributes and actions.",
    parameters: Type.Object({
      tabId: TAB_ID,
      action: Type.String(),
      strategy: Type.Optional(Type.String()),
      selector: SELECTOR,
      value: Type.Optional(Type.Unknown()),
      exact: Type.Optional(Type.Boolean()),
      name: Type.Optional(Type.String()),
      index: Type.Optional(Type.Number()),
      hasText: Type.Optional(Type.String()),
      hasSelector: Type.Optional(Type.String()),
      other: Type.Optional(Type.Unknown()),
      attribute: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      try {
        const locator = {
          strategy: params.strategy || (params.selector ? "css" : "css"),
          value: params.value ?? params.selector ?? "*",
          exact: params.exact,
          name: params.name,
          index: params.index,
          hasText: params.hasText,
          hasSelector: params.hasSelector,
        };
        return textResult(await call("locator", { ...params, locator }));
      } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Navigate Browser",
    description: "Navigate a selected or specified browser tab to a URL and optionally wait for loading to complete.",
    parameters: Type.Object({ tabId: TAB_ID, url: Type.String(), wait: Type.Optional(Type.Boolean()), timeoutMs: Type.Optional(Type.Number()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("navigate", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_wait",
    label: "Wait for Browser Page",
    description: "Wait for a selected browser tab to finish loading or reach a URL/URL fragment.",
    parameters: Type.Object({ tabId: TAB_ID, state: Type.Optional(Type.String()), url: Type.Optional(Type.String()), urlIncludes: Type.Optional(Type.String()), timeoutMs: Type.Optional(Type.Number()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("wait", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Click Browser Element",
    description: "Click an element by an eN ref from browser_snapshot or by CSS selector.",
    parameters: Type.Object({ tabId: TAB_ID, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "click" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_double_click",
    label: "Double Click Browser Element",
    description: "Double-click an element by an eN ref or CSS selector.",
    parameters: Type.Object({ tabId: TAB_ID, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "double_click" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_fill",
    label: "Fill Browser Field",
    description: "Fill an input, textarea or contenteditable element by eN ref or CSS selector.",
    parameters: Type.Object({ tabId: TAB_ID, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR, value: Type.String() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "fill" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "Type Browser Text",
    description: "Type or append text into a focused browser field.",
    parameters: Type.Object({ tabId: TAB_ID, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR, value: Type.String() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "type" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_press_key",
    label: "Press Browser Key",
    description: "Dispatch a keyboard key to an eN ref or CSS selector.",
    parameters: Type.Object({ tabId: TAB_ID, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR, key: Type.String() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "press" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_scroll",
    label: "Scroll Browser",
    description: "Scroll the selected page by a viewport delta.",
    parameters: Type.Object({ tabId: TAB_ID, deltaX: Type.Optional(Type.Number()), deltaY: Type.Optional(Type.Number()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "scroll" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_dom_cua",
    label: "Browser DOM CUA",
    description: "Use visible DOM node ids for click, double-click, type, keypress and scroll operations.",
    parameters: Type.Object({
      tabId: TAB_ID,
      action: Type.String(),
      nodeId: Type.Optional(Type.String()),
      value: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      deltaX: Type.Optional(Type.Number()),
      deltaY: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("dom_cua", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_cua",
    label: "Browser Coordinate CUA",
    description: "Use native CDP mouse and keyboard input at viewport coordinates, including click, move, scroll, drag, type and keypress.",
    parameters: Type.Object({
      tabId: TAB_ID,
      action: Type.String(),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      toX: Type.Optional(Type.Number()),
      toY: Type.Optional(Type.Number()),
      path: Type.Optional(Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() }))),
      deltaX: Type.Optional(Type.Number()),
      deltaY: Type.Optional(Type.Number()),
      text: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      button: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("cua", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Capture the selected browser tab and return it as an image.",
    parameters: Type.Object({ tabId: TAB_ID, fullPage: Type.Optional(Type.Boolean()), path: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      try {
        const result = await call("screenshot", params) as { data: string; mimeType?: string; tabId?: number };
        let savedPath: string | undefined;
        if (params.path) {
          savedPath = resolve(String(params.path));
          await mkdir(dirname(savedPath), { recursive: true });
          await writeFile(savedPath, Buffer.from(result.data, "base64"));
        }
        return {
          content: [
            { type: "text", text: `Screenshot captured for tab ${result.tabId ?? "selected"}${savedPath ? ` and saved to ${savedPath}` : ""}.` },
            { type: "image", data: result.data, mimeType: result.mimeType || "image/png" },
          ],
          details: { ...result, path: savedPath },
        };
      } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_console",
    label: "Browser Console",
    description: "Enable and read Runtime console and Log entries captured from a browser tab.",
    parameters: Type.Object({ tabId: TAB_ID, action: Type.Optional(Type.String()), clear: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      try {
        if (params.action === "enable") return textResult(await call("devtools_enable", { ...params, domains: ["Runtime", "Log"] }));
        return textResult(await call("console_logs", params));
      } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_network",
    label: "Browser Network",
    description: "Enable and read Network request/response events and response bodies from a browser tab.",
    parameters: Type.Object({ tabId: TAB_ID, action: Type.Optional(Type.String()), requestId: Type.Optional(Type.String()), clear: Type.Optional(Type.Boolean()), timeoutMs: Type.Optional(Type.Number()) }),
    async execute(_toolCallId, params) {
      try {
        if (params.action === "enable") return textResult(await call("devtools_enable", { ...params, domains: ["Network", "Page"] }));
        if (params.action === "response_body") return textResult(await call("network_response_body", params));
        return textResult(await call("network_requests", params));
      } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_dialog",
    label: "Browser JavaScript Dialog",
    description: "Inspect and accept or dismiss alert, confirm and prompt dialogs using native CDP.",
    parameters: Type.Object({ tabId: TAB_ID, action: Type.String(), promptText: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("dialog", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_upload",
    label: "Browser File Upload",
    description: "Set local files on a page file input using native CDP DOM.setFileInputFiles in Trusted Local Mode.",
    parameters: Type.Object({ tabId: TAB_ID, selector: SELECTOR, nodeId: Type.Optional(Type.Number()), files: Type.Union([Type.String(), Type.Array(Type.String())]) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("upload", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_clipboard",
    label: "Browser Clipboard",
    description: "Read or write plain text through the selected tab's browser clipboard.",
    parameters: Type.Object({ tabId: TAB_ID, action: Type.String(), text: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("clipboard", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_download",
    label: "Browser Download",
    description: "Start, wait for, list, cancel or erase browser downloads and return their paths/status.",
    parameters: Type.Object({ tabId: TAB_ID, action: Type.String(), url: Type.Optional(Type.String()), filename: Type.Optional(Type.String()), saveAs: Type.Optional(Type.Boolean()), wait: Type.Optional(Type.Boolean()), downloadId: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()), timeoutMs: Type.Optional(Type.Number()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("download", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_evaluate",
    label: "Evaluate Browser JavaScript",
    description: "Evaluate JavaScript in the selected page using the native CDP Runtime.evaluate path.",
    parameters: Type.Object({ tabId: TAB_ID, expression: Type.String(), awaitPromise: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("evaluate", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_cdp",
    label: "Native Browser CDP",
    description: "Send a native Chrome DevTools Protocol command to the selected browser tab.",
    parameters: Type.Object({ tabId: TAB_ID, method: Type.String(), params: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("cdp", params)); } catch (error) { return errorResult(error); }
    },
  });

  for (const [name, method, label, description] of [
    ["browser_back", "back", "Browser Back", "Navigate the selected browser tab back in history."],
    ["browser_forward", "forward", "Browser Forward", "Navigate the selected browser tab forward in history."],
    ["browser_reload", "reload", "Browser Reload", "Reload the selected browser tab."],
  ] as const) {
    pi.registerTool({
      name,
      label,
      description,
      parameters: Type.Object({ tabId: TAB_ID, bypassCache: Type.Optional(Type.Boolean()) }),
      async execute(_toolCallId, params) {
        try { return textResult(await call(method, params)); } catch (error) { return errorResult(error); }
      },
    });
  }

  pi.registerTool({
    name: "browser_close_tab",
    label: "Close Browser Tab",
    description: "Close a specified browser tab. Use only for Agent-owned or explicitly requested tabs.",
    parameters: Type.Object({ tabId: Type.Number() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("close_tab", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_release",
    label: "Release Browser Tab",
    description: "Release a claimed/Agent tab from the current Pi session without closing the page.",
    parameters: Type.Object({ tabId: Type.Number() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("release", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_mark_handoff",
    label: "Keep Browser Handoff",
    description: "Mark an Agent-owned tab to survive turn cleanup for manual user handoff.",
    parameters: Type.Object({ tabId: Type.Number() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("mark_handoff", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_mark_deliverable",
    label: "Keep Browser Deliverable",
    description: "Mark an Agent-owned tab to survive cleanup as a user-facing deliverable.",
    parameters: Type.Object({ tabId: Type.Number() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("mark_deliverable", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    name: "browser_cleanup",
    label: "Cleanup Agent Browser Tabs",
    description: "Close temporary Agent-owned tabs for the current Pi session and preserve handoff/deliverable tabs.",
    parameters: Type.Object({}),
    async execute() {
      try { return textResult(await call("cleanup")); } catch (error) { return errorResult(error); }
    },
  });
}

export default function piControlChrome(pi: ExtensionAPI): void {
  registerBrowserTools(pi);

  const updateStatus = (ctx: ExtensionContext, text: string) => ctx.ui.setStatus("pi-control-chrome", text);

  pi.registerCommand("chrome", {
    description: "Control the connected Chrome/Edge browser",
    handler: async (args, ctx) => {
      const [action = "status", ...rest] = args.trim().split(/\s+/);
      try {
        if (action === "status") {
          const result = await call("status");
          const connected = result.bridgeHealth?.extensionConnected === true;
          updateStatus(ctx, connected ? "chrome: connected" : "chrome: bridge only");
          ctx.ui.notify(JSON.stringify(result), "info");
          return;
        }
        if (action === "connect") {
          paused = false;
          await bridge.start();
          const result = await call("status");
          updateStatus(ctx, result.bridgeHealth?.extensionConnected === true ? "chrome: connected" : "chrome: bridge only");
          ctx.ui.notify(JSON.stringify(result), "info");
          return;
        }
        if (action === "restart") {
          const result = await bridge.restart();
          updateStatus(ctx, result.bridgeHealth?.extensionConnected === true ? "chrome: connected" : "chrome: bridge only");
          ctx.ui.notify(JSON.stringify(result), "info");
          return;
        }
        if (action === "disconnect") {
          await bridge.stop();
          updateStatus(ctx, "chrome: disconnected");
          ctx.ui.notify("Pi browser bridge disconnected; the local Bridge remains available for a later /chrome connect.", "info");
          return;
        }
        if (action === "pause") {
          paused = true;
          updateStatus(ctx, "chrome: paused");
          ctx.ui.notify("Pi browser control paused. Run /chrome resume to continue.", "info");
          return;
        }
        if (action === "resume") {
          paused = false;
          const result = await call("status");
          updateStatus(ctx, result.bridgeHealth?.extensionConnected === true ? "chrome: connected" : "chrome: bridge only");
          ctx.ui.notify("Pi browser control resumed.", "info");
          return;
        }
        if (action === "tabs") {
          ctx.ui.notify(JSON.stringify(await call("list_tabs"), null, 2), "info");
          return;
        }
        if (action === "cleanup") {
          ctx.ui.notify(JSON.stringify(await call("cleanup")), "info");
          return;
        }
        if (action === "release" && rest[0]) {
          ctx.ui.notify(JSON.stringify(await call("release", { tabId: Number(rest[0]) })), "info");
          return;
        }
        if (action === "profile") {
          const result = await call("status");
          ctx.ui.notify(JSON.stringify({ browser: result.browser, userAgent: result.userAgent, extensionVersion: result.extensionVersion }, null, 2), "info");
          return;
        }
        if (action === "group") {
          const result = await call("list_tabs");
          ctx.ui.notify(JSON.stringify(result.groups || [], null, 2), "info");
          return;
        }
        if (action === "setup") {
          ctx.ui.notify("Load extension/ as an unpacked Chrome/Edge extension, then run /chrome connect and /chrome status.", "info");
          return;
        }
        ctx.ui.notify("用法：/chrome status|connect|restart|disconnect|pause|resume|tabs|profile|group|setup|cleanup|release <tabId>", "warning");
      } catch (error) {
        updateStatus(ctx, "chrome: offline");
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      await bridge.start();
      const status = await call("status");
      updateStatus(ctx, status.bridgeHealth?.extensionConnected === true ? "chrome: connected" : "chrome: bridge only");
    } catch (error) {
      updateStatus(ctx, "chrome: offline");
      ctx.ui.notify(`Pi browser bridge is not connected: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.on("turn_end", async () => {
    try { await call("cleanup"); } catch {}
  });

  pi.on("session_shutdown", async () => {
    try { await call("cleanup"); } catch {}
    await bridge.stop();
  });
}
