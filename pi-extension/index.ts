import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import WebSocket from "ws";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyBrowserToolMask, createBrowserActivation } from "./activation.js";

const BRIDGE_HOST = "127.0.0.1";
const configuredBridgePort = Number.parseInt(process.env.PI_CONTROL_CHROME_BRIDGE_PORT ?? "", 10);
const BRIDGE_PORT = Number.isInteger(configuredBridgePort) && configuredBridgePort > 0 && configuredBridgePort < 65_536 ? configuredBridgePort : 17318;
const BRIDGE_ORIGIN = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
const BRIDGE_WS = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}/ws`;
let sessionId = randomUUID();
let turnNumber = 0;
const LAZY_TOOLS = process.env.PI_CONTROL_CHROME_LAZY_TOOLS !== "false";
const browserActivation = createBrowserActivation({ lazyTools: LAZY_TOOLS });
let browserToolsActive = browserActivation.active;
let bridgeUsed = false;
let turnCleanupArmed = false;
let lifecycleGeneration = 0;
let sessionTransitionInFlight = false;
const BRIDGE_WAIT_DELAY_MS = 100;
const BRIDGE_WAIT_ATTEMPTS = 30;
let paused = false;

type BrowserTarget = { browser: string; browserId: string; profile: string };
type TargetStability = {
  stable: boolean;
  changed: boolean;
  acknowledged: boolean;
  requiresAcknowledgement: boolean;
  competition: string;
  observedBrowserIds: string[];
  browser?: string;
  browserId?: string;
  profile?: string;
  previousBrowser?: string;
  previousBrowserId?: string;
  issue?: string;
};
let acknowledgedTarget: BrowserTarget | undefined;
const observedBrowserIds = new Set<string>();

function readBrowserTarget(value: unknown): BrowserTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.browser !== "string" || !record.browser || typeof record.browserId !== "string" || !record.browserId || typeof record.profile !== "string" || !record.profile) return undefined;
  return { browser: record.browser, browserId: record.browserId, profile: record.profile };
}

function observeBrowserTarget(value: unknown, acknowledgeBrowserId?: string): TargetStability {
  const target = readBrowserTarget(value);
  if (!target) return { stable: false, changed: false, acknowledged: false, requiresAcknowledgement: false, competition: "unknown", observedBrowserIds: [...observedBrowserIds], issue: "status_missing_browser_target" };
  const previous = acknowledgedTarget;
  const changed = previous !== undefined && previous.browserId !== target.browserId;
  const acknowledged = previous === undefined || !changed || acknowledgeBrowserId === target.browserId;
  observedBrowserIds.add(target.browserId);
  if (acknowledged) acknowledgedTarget = target;
  return {
    stable: !changed,
    changed,
    acknowledged,
    requiresAcknowledgement: changed && !acknowledged,
    competition: previous === undefined ? "unknown" : changed ? "changed" : "stable_observed",
    browser: target.browser,
    browserId: target.browserId,
    profile: target.profile,
    observedBrowserIds: [...observedBrowserIds],
    ...(previous === undefined ? {} : { previousBrowser: previous.browser, previousBrowserId: previous.browserId }),
  };
}

async function localJsonRequest(path: string, timeoutMs: number, origin = BRIDGE_ORIGIN): Promise<{ statusCode: number; value: any }> {
  try {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    return { statusCode: response.status, value: await response.json() };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`Local bridge request timed out: ${path}`);
    }
    throw error;
  }
}

const TAB_ID = Type.Optional(Type.Number({ description: "Chrome/Edge tab id. Omit to use the active tab." }));
const SELECTOR = Type.Optional(Type.String({ description: "Optional CSS selector. Prefer a ref from browser_snapshot." }));

/** Client for the local Pi-to-Bridge WebSocket protocol. */
export class BridgeClient {
  private readonly origin: string;
  private readonly wsUrl: string;
  private readonly WebSocketCtor: typeof WebSocket;
  private socket?: WebSocket;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; socket: WebSocket }>();
  private connecting?: Promise<void>;
  private lifecycle = 0;

  constructor(options: { origin?: string; wsUrl?: string; WebSocketCtor?: typeof WebSocket } = {}) {
    this.origin = options.origin ?? BRIDGE_ORIGIN;
    this.wsUrl = options.wsUrl ?? BRIDGE_WS;
    this.WebSocketCtor = options.WebSocketCtor ?? WebSocket;
  }

  async start(): Promise<void> {
    await this.connect();
  }

  async stop(): Promise<void> {
    this.lifecycle += 1;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Pi browser bridge stopped"));
    }
    this.pending.clear();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    const connecting = this.connecting;
    if (connecting !== undefined) await connecting.catch(() => {});
    // The bridge is intentionally left alive so a newly reloaded Pi session can
    // reconnect without restarting Chrome or the extension.
  }

  async health(): Promise<any> {
    const response = await localJsonRequest("/health", 1500, this.origin);
    if (response.statusCode !== 200) throw new Error(`Bridge health failed: HTTP ${response.statusCode}`);
    return response.value;
  }

  async restart(): Promise<any> {
    const lifecycle = this.lifecycle;
    const assertLive = () => {
      if (lifecycle !== this.lifecycle) throw new Error("Pi browser bridge restart was stopped");
    };
    const health = await this.health();
    assertLive();
    const instanceId = typeof health.instanceId === "string" ? health.instanceId : undefined;
    if (!instanceId || health.capabilities?.localUserRestart !== true) {
      throw new Error("BRIDGE_RESTART_UNSUPPORTED: the active Bridge does not expose local-user cooperative restart capabilities");
    }
    const control = await this.request("bridge_restart", {
      expectedInstanceId: instanceId,
      requester: "pi",
    });
    assertLive();
    await this.waitForOffline();
    assertLive();
    await this.startBridgeProcess();
    assertLive();
    const next = await this.waitForHealth();
    assertLive();
    if (next.instanceId === instanceId) throw new Error("BRIDGE_INSTANCE_CHANGED: Bridge restart reused the previous instance");
    return { ok: true, restarted: true, recovery: "cooperative_restart", previousInstanceId: instanceId, control, bridgeHealth: next };
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== this.WebSocketCtor.OPEN) throw new Error("Pi browser bridge is not connected");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser request timed out: ${method}`));
      }, 120_000);
      this.pending.set(id, { resolve, reject, timer, socket });
      try {
        socket.send(JSON.stringify({ type: "request", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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
    const child = spawn(process.execPath, [
      bridgePath,
      "--port", String(BRIDGE_PORT),
      "--token-file", tokenFile,
      "--started-by", "pi",
    ], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => {});
    child.unref();
  }

  private async waitForHealth(): Promise<any> {
    for (let i = 0; i < BRIDGE_WAIT_ATTEMPTS; i += 1) {
      try {
        const health = await this.health();
        if (health?.ok === true) return health;
      } catch {
        // Keep polling while a newly spawned Bridge is binding its port.
      }
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
      const response = await localJsonRequest("/health", 700, this.origin);
      return response.statusCode === 200 && response.value?.ok === true;
    } catch {
      return false;
    }
  }


  private async connect(): Promise<void> {
    if (this.socket?.readyState === this.WebSocketCtor.OPEN) return;
    if (this.connecting) return this.connecting;
    const lifecycle = this.lifecycle;
    const attempt = (async () => {
      await this.ensureBridgeProcess();
      if (lifecycle !== this.lifecycle) throw new Error("Pi browser bridge connection was stopped");
      const response = await localJsonRequest("/pair", 2000, this.origin);
      if (response.statusCode !== 200) throw new Error(`Bridge pairing failed: HTTP ${response.statusCode}`);
      const pairing = response.value as { token?: string };
      if (!pairing.token) throw new Error("Bridge pairing response did not contain a token");
      if (lifecycle !== this.lifecycle) throw new Error("Pi browser bridge connection was stopped");
      await new Promise<void>((resolve, reject) => {
        const socket = new this.WebSocketCtor(`${this.wsUrl}?role=pi&token=${encodeURIComponent(pairing.token!)}`);
        if (lifecycle !== this.lifecycle) {
          socket.close();
          reject(new Error("Pi browser bridge connection was stopped"));
          return;
        }
        this.socket = socket;
        let timeout!: NodeJS.Timeout;
        let settled = false;
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        timeout = setTimeout(() => {
          if (this.socket === socket) this.socket = undefined;
          fail(new Error("Timed out connecting to the Pi browser bridge"));
          socket.close();
        }, 5000);
        socket.once("open", () => {
          if (lifecycle !== this.lifecycle || this.socket !== socket) {
            socket.close();
            fail(new Error("Pi browser bridge connection was stopped"));
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve();
        });
        socket.on("message", (raw) => this.handleMessage(raw.toString(), socket));
        socket.once("close", () => {
          const error = new Error("Pi browser bridge disconnected");
          if (this.socket === socket) this.socket = undefined;
          this.rejectPendingForSocket(socket, error);
          fail(error);
        });
        socket.once("error", (error) => {
          if (this.socket === socket) this.socket = undefined;
          this.rejectPendingForSocket(socket, error instanceof Error ? error : new Error(String(error)));
          fail(error);
        });
      });
    })();
    let tracked!: Promise<void>;
    tracked = attempt.finally(() => {
      if (this.connecting === tracked) this.connecting = undefined;
    });
    this.connecting = tracked;
    return tracked;
  }

  private rejectPendingForSocket(socket: WebSocket, error: Error): void {
    for (const [id, entry] of this.pending) {
      if (entry.socket !== socket) continue;
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  private handleMessage(raw: string, source: WebSocket): void {
    if (this.socket !== source) return;
    try {
      const message = JSON.parse(raw) as { type?: string; id?: string; result?: unknown; error?: { code?: string; message?: string } };
      if (message.type !== "response" || !message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || "Browser request failed") as Error & { code?: string };
        if (message.error.code) error.code = message.error.code;
        entry.reject(error);
      } else entry.resolve(message.result);
    } catch {
      // Ignore malformed bridge events; the next request will report connection state.
    }
  }
}

const bridge = new BridgeClient();

type CleanupIntent = { readonly params: Record<string, unknown>; readonly priority: number };
const pendingCleanupSessionIds = new Map<string, CleanupIntent>();
const cleanupFlights = new Map<string, Promise<unknown>>();
const cleanupTargetIds = new Map<string, string>();

function cleanupRetainsTabs(value: unknown): boolean {
  if (!value || typeof value !== "object" || !Array.isArray((value as { retained?: unknown }).retained)) return true;
  return (value as { retained: unknown[] }).retained.length > 0;
}

function cleanupFailure(value: unknown): Error | undefined {
  if (!value || typeof value !== "object" || !Array.isArray((value as { failed?: unknown }).failed) || (value as { failed: unknown[] }).failed.length === 0) return undefined;
  const failed = (value as { failed: unknown[] }).failed;
  return new Error(`Browser cleanup failed for ${failed.length} tab(s): ${JSON.stringify(failed)}`);
}

function cleanupIntentPriority(params: Record<string, unknown>): number {
  if (params.mode === "turn") return 4;
  if (params.mode === "disposal") return 3;
  if (params.mode === "context") return 2;
  return 1;
}

const TURN_CLEANUP_CAPABILITIES = ["turnCleanup", "turnScopedMarks", "retainedCleanup", "debuggerLeaseRecovery"] as const;

async function verifyTurnCleanupSupport(session: string, expectedBrowserId?: string): Promise<string> {
  const status = await bridge.request("status", { sessionId: session, ...(expectedBrowserId === undefined ? {} : { expectedBrowserId }) });
  const target = readBrowserTarget(status);
  if (target === undefined) throw new Error("Browser status did not identify an active browser target; turn cleanup was not attempted");
  if (expectedBrowserId !== undefined && target.browserId !== expectedBrowserId) {
    throw new Error(`Browser target changed during turn cleanup; expected ${expectedBrowserId} but the active target is ${target.browserId}`);
  }
  const capabilities = status && typeof status === "object" ? (status as Record<string, unknown>).capabilities : undefined;
  const missing = TURN_CLEANUP_CAPABILITIES.filter((name) => !capabilities || typeof capabilities !== "object" || (capabilities as Record<string, unknown>)[name] !== true);
  if (missing.length > 0) throw new Error(`The connected extension does not support turn cleanup (${missing.join(", ")}); reload pi-control-chrome`);
  cleanupTargetIds.set(session, target.browserId);
  return target.browserId;
}

async function requestCleanup(session: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const previous = cleanupFlights.get(session);
  const run = (async () => {
    if (previous !== undefined) await previous.catch(() => undefined);
    let retryParams = { ...params };
    let retryPriority = cleanupIntentPriority(retryParams);
    try {
      const expectedBrowserId = typeof params.expectedBrowserId === "string" ? params.expectedBrowserId : cleanupTargetIds.get(session);
      let cleanupParams = { ...params, sessionId: session, ...(expectedBrowserId === undefined ? {} : { expectedBrowserId }) };
      retryParams = { ...cleanupParams };
      retryPriority = cleanupIntentPriority(retryParams);
      if (params.mode === "turn") {
        const verifiedBrowserId = await verifyTurnCleanupSupport(session, expectedBrowserId);
        cleanupParams = { ...cleanupParams, expectedBrowserId: verifiedBrowserId };
        retryParams = { ...cleanupParams };
        retryPriority = cleanupIntentPriority(retryParams);
      }
      const value = await bridge.request("cleanup", cleanupParams);
      const failure = cleanupFailure(value);
      if (failure !== undefined) throw failure;
      const pendingIntent = pendingCleanupSessionIds.get(session);
      if (pendingIntent === undefined || retryPriority >= pendingIntent.priority) pendingCleanupSessionIds.delete(session);
      return value;
    } catch (error) {
      const previousIntent = pendingCleanupSessionIds.get(session);
      if (previousIntent === undefined || retryPriority >= previousIntent.priority) {
        pendingCleanupSessionIds.set(session, { params: retryParams, priority: retryPriority });
      }
      throw error;
    } finally {
      if (cleanupFlights.get(session) === run) cleanupFlights.delete(session);
    }
  })();
  cleanupFlights.set(session, run);
  return run;
}

async function retryPendingCleanups(): Promise<void> {
  await Promise.allSettled([...pendingCleanupSessionIds.entries()].map(([session, intent]) => requestCleanup(session, intent.params)));
}

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

type BrowserCallOptions = { allowInactive?: boolean };

async function call(method: string, params: Record<string, unknown> = {}, options: BrowserCallOptions = {}) {
  const requestSessionId = sessionId;
  const requestTurn = turnNumber;
  const requestGeneration = lifecycleGeneration;
  const assertCurrent = () => {
    if (requestGeneration !== lifecycleGeneration || requestSessionId !== sessionId) throw new Error("Pi browser session changed while the request was in flight");
  };
  if (!options.allowInactive && !browserToolsActive) {
    throw new Error("Browser tools are inactive; load the pi-control-chrome Skill after the user explicitly requests browser control");
  }
  if (paused && !["status", "list_tabs", "selected_tab", "cleanup", "context_reset"].includes(method)) {
    throw new Error("Pi browser control is paused; run /chrome resume first");
  }
  if (method === "context_reset") return call("cleanup", params, options);
  if (method === "cleanup") {
    if (!bridgeUsed && !browserActivation.cleanupRequired && !turnCleanupArmed) return { removed: [], released: [], retained: [], failed: [] };
    bridgeUsed = true;
    turnCleanupArmed = true;
    browserActivation.markUsed();
    const value = await requestCleanup(requestSessionId, params);
    assertCurrent();
    if (!cleanupRetainsTabs(value)) turnCleanupArmed = false;
    return value;
  }
  if (method === "status") {
    const { acknowledgeBrowserId, ...statusParams } = params;
    bridgeUsed = true;
    turnCleanupArmed = true;
    browserActivation.markUsed();
    const result = await bridge.request("status", { ...statusParams, sessionId: requestSessionId });
    assertCurrent();
    const targetStability = observeBrowserTarget(result, typeof acknowledgeBrowserId === "string" ? acknowledgeBrowserId : undefined);
    const target = readBrowserTarget(result);
    if (target !== undefined && targetStability.acknowledged) cleanupTargetIds.set(requestSessionId, target.browserId);
    const base = result && typeof result === "object" ? result : { result };
    try {
      const bridgeHealth = await bridge.health();
      assertCurrent();
      return { ...base, targetStability, bridgeHealth };
    } catch {
      assertCurrent();
      return { ...base, targetStability };
    }
  }
  bridgeUsed = true;
  turnCleanupArmed = true;
  browserActivation.markUsed();
  const status = await bridge.request("status", { sessionId: requestSessionId });
  assertCurrent();
  const targetStability = observeBrowserTarget(status);
  const target = readBrowserTarget(status);
  if (targetStability.issue !== undefined || target === undefined) throw new Error("Browser status did not identify an active browser target; run browser_status");
  if (!targetStability.stable || !targetStability.acknowledged) {
    throw new Error(`Browser target changed from ${targetStability.previousBrowser} (${targetStability.previousBrowserId}) to ${targetStability.browser} (${targetStability.browserId}); run browser_status with acknowledgeBrowserId after disabling the other browser extension`);
  }
  cleanupTargetIds.set(requestSessionId, target.browserId);
  const turnParams = method === "mark_handoff" || method === "mark_deliverable" ? { turnId: requestTurn } : {};
  assertCurrent();
  const value = await bridge.request(method, { ...params, ...turnParams, sessionId: requestSessionId, expectedBrowserId: target.browserId });
  assertCurrent();
  return value;
}

function registerBrowserTools(pi: ExtensionAPI) {
  pi.registerTool({
    executionMode: "sequential",
    name: "browser_doctor",
    label: "Browser Doctor",
    description: "Diagnose the local Bridge, extension connection, active browser target and Chrome/Edge competition without changing tabs.",
    parameters: Type.Object({}),
    async execute() {
      try { return textResult(await call("doctor")); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_status",
    label: "Browser Status",
    description: "Return the connected Chrome/Edge browser, target stability and Pi bridge status.",
    parameters: Type.Object({ acknowledgeBrowserId: Type.Optional(Type.String({ description: "Explicitly acknowledge this browserId after confirming a browser switch." })) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("status", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_tabs",
    label: "Browser Tabs",
    description: "List Chrome/Edge windows, tabs, tab groups, ownership and lifecycle state.",
    parameters: Type.Object({}),
    async execute() {
      try { return textResult(await call("list_tabs")); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_selected",
    label: "Selected Browser Tab",
    description: "Return the currently selected Chrome/Edge tab.",
    parameters: Type.Object({}),
    async execute() {
      try { return textResult(await call("selected_tab")); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
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
    executionMode: "sequential",
    name: "browser_select_tab",
    label: "Select Browser Tab",
    description: "Select an existing browser tab by id, optionally focusing its window.",
    parameters: Type.Object({ tabId: Type.Number(), focusWindow: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("select_tab", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
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
    executionMode: "sequential",
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Read the active page title, URL, visible text and interactive elements with stable eN refs.",
    parameters: Type.Object({ tabId: TAB_ID }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("snapshot", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_extract",
    label: "Extract Browser Page",
    description: "Extract the current page as bounded plain text and simple Markdown without fetching it through a separate web scraper.",
    parameters: Type.Object({ tabId: TAB_ID }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("extract", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
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
    executionMode: "sequential",
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
    executionMode: "sequential",
    name: "browser_navigate",
    label: "Navigate Browser",
    description: "Navigate a selected or specified browser tab to a URL and optionally wait for loading to complete.",
    parameters: Type.Object({ tabId: TAB_ID, url: Type.String(), wait: Type.Optional(Type.Boolean()), timeoutMs: Type.Optional(Type.Number()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("navigate", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_wait",
    label: "Wait for Browser Page",
    description: "Wait for a selected browser tab to finish loading or reach a URL/URL fragment.",
    parameters: Type.Object({ tabId: TAB_ID, state: Type.Optional(Type.String()), url: Type.Optional(Type.String()), urlIncludes: Type.Optional(Type.String()), timeoutMs: Type.Optional(Type.Number()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("wait", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_click",
    label: "Click Browser Element",
    description: "Click an element by an eN ref from browser_snapshot or by CSS selector.",
    parameters: Type.Object({ tabId: TAB_ID, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "click" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_double_click",
    label: "Double Click Browser Element",
    description: "Double-click an element by an eN ref or CSS selector.",
    parameters: Type.Object({ tabId: TAB_ID, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "double_click" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_fill",
    label: "Fill Browser Field",
    description: "Fill an input, textarea or contenteditable element by eN ref or CSS selector.",
    parameters: Type.Object({ tabId: TAB_ID, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR, value: Type.String() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "fill" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_type",
    label: "Type Browser Text",
    description: "Type or append text into a focused browser field.",
    parameters: Type.Object({ tabId: TAB_ID, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR, value: Type.String() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "type" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_press_key",
    label: "Press Browser Key",
    description: "Dispatch a keyboard key to an eN ref or CSS selector.",
    parameters: Type.Object({ tabId: TAB_ID, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR, key: Type.String() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "press" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_scroll",
    label: "Scroll Browser",
    description: "Scroll the selected page by a viewport delta.",
    parameters: Type.Object({ tabId: TAB_ID, deltaX: Type.Optional(Type.Number()), deltaY: Type.Optional(Type.Number()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "scroll" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
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
    executionMode: "sequential",
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
    executionMode: "sequential",
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
    executionMode: "sequential",
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
    executionMode: "sequential",
    name: "browser_network",
    label: "Browser Network",
    description: "Enable and read Network request/response events and response bodies from a browser tab.",
    parameters: Type.Object({ tabId: TAB_ID, action: Type.Optional(Type.String()), requestId: Type.Optional(Type.String()), clear: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      try {
        if (params.action === "enable") return textResult(await call("devtools_enable", { ...params, domains: ["Network", "Page"] }));
        if (params.action === "response_body") return textResult(await call("network_response_body", params));
        return textResult(await call("network_requests", params));
      } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_dialog",
    label: "Browser JavaScript Dialog",
    description: "Inspect and accept or dismiss alert, confirm and prompt dialogs using native CDP.",
    parameters: Type.Object({ tabId: TAB_ID, action: Type.String(), promptText: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("dialog", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_upload",
    label: "Browser File Upload",
    description: "Set local files on a page file input using native CDP DOM.setFileInputFiles in Trusted Local Mode.",
    parameters: Type.Object({ tabId: TAB_ID, selector: SELECTOR, nodeId: Type.Optional(Type.Number()), files: Type.Union([Type.String(), Type.Array(Type.String())]) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("upload", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_clipboard",
    label: "Browser Clipboard",
    description: "Read or write plain text through the selected tab's browser clipboard.",
    parameters: Type.Object({ tabId: TAB_ID, action: Type.String(), text: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("clipboard", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_download",
    label: "Browser Download",
    description: "Start, wait for, list, cancel or erase browser downloads and return their paths/status.",
    parameters: Type.Object({ action: Type.String(), url: Type.Optional(Type.String()), filename: Type.Optional(Type.String()), saveAs: Type.Optional(Type.Boolean()), wait: Type.Optional(Type.Boolean()), downloadId: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()), timeoutMs: Type.Optional(Type.Number()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("download", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_evaluate",
    label: "Evaluate Browser JavaScript",
    description: "Evaluate JavaScript in the selected page using the native CDP Runtime.evaluate path.",
    parameters: Type.Object({ tabId: TAB_ID, expression: Type.String(), awaitPromise: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("evaluate", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
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
      executionMode: "sequential",
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
    executionMode: "sequential",
    name: "browser_close_tab",
    label: "Close Browser Tab",
    description: "Close a specified browser tab. Agent-owned tabs must belong to the current session; unowned user tabs require userRequested: true.",
    parameters: Type.Object({ tabId: Type.Number(), userRequested: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("close_tab", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_release",
    label: "Release Browser Tab",
    description: "Release a claimed/Agent tab from the current Pi session without closing the page.",
    parameters: Type.Object({ tabId: Type.Number() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("release", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_mark_handoff",
    label: "Keep Browser Handoff",
    description: "Mark an Agent-owned tab to survive the current turn cleanup for manual user handoff; repeat the mark in a later turn.",
    parameters: Type.Object({ tabId: Type.Number() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("mark_handoff", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_mark_deliverable",
    label: "Keep Browser Deliverable",
    description: "Mark an Agent-owned tab to survive the current turn cleanup as a user-facing deliverable; repeat the mark in a later turn.",
    parameters: Type.Object({ tabId: Type.Number() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("mark_deliverable", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_cleanup",
    label: "Finalize Browser Task",
    description: "Only after the user explicitly asks for browser cleanup: close allowed Agent tabs and release claims while keeping browser tools and the Bridge active.",
    parameters: Type.Object({}),
    async execute() {
      const generation = lifecycleGeneration;
      const value = await call("cleanup");
      if (generation !== lifecycleGeneration) throw new Error("Pi browser session changed while cleanup was completing");
      bridgeUsed = false;
      browserActivation.finalize();
      return textResult(value);
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_context_reset",
    label: "Reset Browser Context",
    description: "Only after the user explicitly asks to reset or clear browser context: finalize resources and hide browser tools without stopping the shared Bridge.",
    parameters: Type.Object({}),
    async execute() {
      const generation = lifecycleGeneration;
      const value = await call("context_reset");
      if (generation !== lifecycleGeneration) throw new Error("Pi browser session changed while context reset was completing");
      bridgeUsed = false;
      turnCleanupArmed = false;
      browserActivation.reset();
      setBrowserTools(browserActivation.active);
      return textResult(value);
    },
  });
}

export default function piControlChrome(pi: ExtensionAPI): void {
  registerBrowserTools(pi);
  const setBrowserTools = (active: boolean) => {
    applyBrowserToolMask(pi, active);
    browserToolsActive = browserActivation.setActive(active);
  };
  const updateStatus = (ctx: ExtensionContext, text: string) => ctx.ui.setStatus("pi-control-chrome", text);
  const humanCall = (method: string, params: Record<string, unknown> = {}) => call(method, params, { allowInactive: true });
  const resetSessionNow = async (ctx: ExtensionContext, status: string, expectedSessionId?: string) => {
    const previousSessionId = sessionId;
    if (expectedSessionId !== undefined && expectedSessionId !== previousSessionId) return;
    const resetGeneration = ++lifecycleGeneration;
    sessionTransitionInFlight = true;
    const needsCleanup = bridgeUsed || turnCleanupArmed || browserActivation.cleanupRequired;
    let cleanupSucceeded = !needsCleanup;
    if (needsCleanup) {
      try {
        await requestCleanup(previousSessionId);
        cleanupSucceeded = true;
      } catch {
        cleanupSucceeded = false;
      }
    }
    await retryPendingCleanups();
    if (lifecycleGeneration !== resetGeneration || sessionId !== previousSessionId) return;
    if (pendingCleanupSessionIds.has(previousSessionId)) cleanupSucceeded = false;
    if (cleanupSucceeded) cleanupTargetIds.delete(previousSessionId);
    bridgeUsed = false;
    turnCleanupArmed = false;
    browserActivation.reset();
    acknowledgedTarget = undefined;
    observedBrowserIds.clear();
    paused = false;
    sessionId = randomUUID();
    turnNumber = 0;
    sessionTransitionInFlight = false;
    browserSkillPaths.clear();
    setBrowserTools(!LAZY_TOOLS);
    updateStatus(ctx, cleanupSucceeded ? status : status + "; browser cleanup pending");
  };
  let sessionResetTail: Promise<void> = Promise.resolve();
  const resetSession = (ctx: ExtensionContext, status: string): Promise<void> => {
    const expectedSessionId = sessionId;
    const run = sessionResetTail.then(() => resetSessionNow(ctx, status, expectedSessionId));
    sessionResetTail = run.catch(() => undefined);
    return run;
  };

  const skillPrompt = /<skill\s+name=["']pi-control-chrome["'](?:\s|>)/u;
  const browserSkillPaths = new Set<string>();
  const normalizedPath = (value: string) => resolve(value).toLowerCase();
  pi.on("before_agent_start", async event => {
    for (const skill of event.systemPromptOptions.skills ?? []) {
      if (skill.name === "pi-control-chrome") browserSkillPaths.add(normalizedPath(skill.filePath));
    }
    if (LAZY_TOOLS && skillPrompt.test(event.prompt)) setBrowserTools(true);
  });
  pi.on("tool_result", event => {
    if (LAZY_TOOLS && !event.isError && event.toolName === "read" && typeof event.input.path === "string" && browserSkillPaths.has(normalizedPath(event.input.path))) {
      setBrowserTools(true);
      return;
    }
    if (event.toolName === "skill" && !event.isError && event.input.name === "pi-control-chrome") {
      setBrowserTools(true);
      return;
    }
  });

  pi.registerCommand("chrome", {
    description: "Control the connected Chrome/Edge browser",
    handler: async (args, ctx) => {
      const generation = lifecycleGeneration;
      const [action = "status", ...rest] = args.trim().split(/\s+/);
      try {
        if (action === "status") {
          const result = await humanCall("status");
          const connected = result.bridgeHealth?.extensionConnected === true;
          updateStatus(ctx, connected ? "chrome: connected" : "chrome: bridge only");
          ctx.ui.notify(JSON.stringify(result), "info");
          return;
        }
        if (action === "connect") {
          await bridge.start();
          await retryPendingCleanups();
          if (generation !== lifecycleGeneration) return;
          paused = false;
          const result = await humanCall("status");
          updateStatus(ctx, result.bridgeHealth?.extensionConnected === true ? "chrome: connected" : "chrome: bridge only");
          ctx.ui.notify(JSON.stringify(result), "info");
          return;
        }
        if (action === "restart") {
          const generation = lifecycleGeneration;
          const result = await bridge.restart();
          if (generation !== lifecycleGeneration) return;
          bridgeUsed = true;
          turnCleanupArmed = true;
          browserActivation.markUsed();
          updateStatus(ctx, result.bridgeHealth?.extensionConnected === true ? "chrome: connected" : "chrome: bridge only");
          ctx.ui.notify(JSON.stringify(result), "info");
          return;
        }
        if (action === "disconnect") {
          await bridge.stop();
          if (generation !== lifecycleGeneration) return;
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
          const result = await humanCall("status");
          if (generation !== lifecycleGeneration) return;
          paused = false;
          updateStatus(ctx, result.bridgeHealth?.extensionConnected === true ? "chrome: connected" : "chrome: bridge only");
          ctx.ui.notify("Pi browser control resumed.", "info");
          return;
        }
        if (action === "tabs") {
          ctx.ui.notify(JSON.stringify(await humanCall("list_tabs"), null, 2), "info");
          return;
        }
        if (action === "cleanup") {
          const generation = lifecycleGeneration;
          const result = await humanCall("cleanup");
          if (generation !== lifecycleGeneration) return;
          ctx.ui.notify(JSON.stringify(result), "info");
          bridgeUsed = false;
          browserActivation.finalize();
          return;
        }
        if (action === "release" && rest[0]) {
          ctx.ui.notify(JSON.stringify(await humanCall("release", { tabId: Number(rest[0]) })), "info");
          return;
        }
        if (action === "profile") {
          const result = await humanCall("status");
          ctx.ui.notify(JSON.stringify({ browser: result.browser, userAgent: result.userAgent, extensionVersion: result.extensionVersion }, null, 2), "info");
          return;
        }
        if (action === "group") {
          const result = await humanCall("list_tabs");
          ctx.ui.notify(JSON.stringify(result.groups || [], null, 2), "info");
          return;
        }
        if (action === "setup") {
          ctx.ui.notify("Load extension/ as an unpacked Chrome/Edge extension, then run /chrome connect and /chrome status.", "info");
          return;
        }
        ctx.ui.notify("用法：/chrome status|connect|restart|disconnect|pause|resume|tabs|profile|group|setup|cleanup|release <tabId>", "warning");
      } catch (error) {
        if (generation !== lifecycleGeneration) return;
        updateStatus(ctx, "chrome: offline");
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    lifecycleGeneration += 1;
    sessionTransitionInFlight = false;
    sessionId = randomUUID();
    turnNumber = 0;
    browserSkillPaths.clear();
    acknowledgedTarget = undefined;
    observedBrowserIds.clear();
    bridgeUsed = false;
    turnCleanupArmed = false;
    browserActivation.reset();
    paused = false;
    setBrowserTools(browserActivation.active);
    updateStatus(ctx, pendingCleanupSessionIds.size > 0 ? "chrome: ready; browser cleanup pending" : "chrome: ready");
  });

  pi.on("turn_start", event => {
    if (sessionTransitionInFlight) return;
    turnNumber = event.turnIndex;
  });

  pi.on("turn_end", async (event, ctx) => {
    const generation = lifecycleGeneration;
    const cleanupSessionId = sessionId;
    const turn = event.turnIndex;
    if (sessionTransitionInFlight) return;
    turnNumber = turn;
    if (turnCleanupArmed || bridgeUsed || browserActivation.cleanupRequired) {
      try {
        const value = await requestCleanup(cleanupSessionId, { mode: "turn", turnId: turn, detachDevtools: true });
        if (generation !== lifecycleGeneration || sessionId !== cleanupSessionId || turnNumber !== turn) return;
        bridgeUsed = false;
        if (!cleanupRetainsTabs(value)) turnCleanupArmed = false;
        browserActivation.finalize();
      } catch {
        if (generation !== lifecycleGeneration || sessionId !== cleanupSessionId || turnNumber !== turn) return;
        ctx.ui.setStatus("pi-control-chrome", "chrome: turn cleanup pending");
      }
    }
    if (generation === lifecycleGeneration && sessionId === cleanupSessionId && turnNumber === turn) turnNumber = turn + 1;
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    await resetSession(ctx, "chrome: session released");
  });
  pi.on("session_before_fork", async (_event, ctx) => {
    await resetSession(ctx, "chrome: session released");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await resetSession(ctx, "chrome: session closed");
    await bridge.stop();
  });
}
