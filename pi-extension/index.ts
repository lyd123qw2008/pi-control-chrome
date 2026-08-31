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
import { compactBrowserResult } from "./output.js";

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
let browserTargetUsed = false;
let turnCleanupArmed = false;
let lifecycleGeneration = 0;
let sessionTransitionInFlight = false;
let sessionStartBlocked = false;
let browserRunId: string | undefined;
let browserRunSequence = 0;
let agentRunCleanupDone = false;
const activeWaitControllers = new Set<AbortController>();
const BRIDGE_WAIT_DELAY_MS = 100;
const BRIDGE_WAIT_ATTEMPTS = 30;
let paused = false;

type BrowserTarget = {
  browser: string;
  browserId: string;
  profile: string;
  state?: string;
  connectionId?: string;
  connectionGeneration?: number;
};
type BrowserTargetRoute = {
  readonly browserId: string;
  readonly connectionId?: string;
  readonly connectionGeneration?: number;
};

type TargetStability = {
  stable: boolean;
  changed: boolean;
  acknowledged: boolean;
  requiresAcknowledgement: boolean;
  connectionChanged: boolean;
  competition: string;
  observedBrowserIds: string[];
  browser?: string;
  browserId?: string;
  profile?: string;
  connectionId?: string;
  connectionGeneration?: number;
  previousBrowser?: string;
  previousBrowserId?: string;
  previousConnectionId?: string;
  previousConnectionGeneration?: number;
  issue?: string;
};
let acknowledgedTarget: BrowserTarget | undefined;
const observedBrowserIds = new Set<string>();

function readBrowserTarget(value: unknown): BrowserTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.browser !== "string" || !record.browser || typeof record.browserId !== "string" || !record.browserId || typeof record.profile !== "string" || !record.profile) return undefined;
  return {
    browser: record.browser,
    browserId: record.browserId,
    profile: record.profile,
    ...(typeof record.state === "string" && record.state.length > 0 ? { state: record.state } : {}),
    ...(typeof record.connectionId === "string" && record.connectionId.length > 0 ? { connectionId: record.connectionId } : {}),
    ...(Number.isInteger(record.connectionGeneration) && Number(record.connectionGeneration) > 0 ? { connectionGeneration: Number(record.connectionGeneration) } : {}),
  };
}

function optionalBrowserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const browserId = value.trim();
  return browserId.length === 0 ? undefined : browserId;
}

function observeBrowserTarget(value: unknown, acknowledgeBrowserId?: string): TargetStability {
  const target = readBrowserTarget(value);
  if (!target) return { stable: false, changed: false, acknowledged: false, requiresAcknowledgement: false, connectionChanged: false, competition: "unknown", observedBrowserIds: [...observedBrowserIds], issue: "status_missing_browser_target" };
  const previous = acknowledgedTarget;
  const changed = previous !== undefined && previous.browserId !== target.browserId;
  const connectionChanged = previous !== undefined
    && previous.browserId === target.browserId
    && (previous.connectionId !== target.connectionId || previous.connectionGeneration !== target.connectionGeneration);
  const acknowledged = previous === undefined || (!changed && !connectionChanged) || acknowledgeBrowserId === target.browserId;
  observedBrowserIds.add(target.browserId);
  if (acknowledged) acknowledgedTarget = target;
  return {
    stable: !changed && !connectionChanged,
    changed,
    acknowledged,
    requiresAcknowledgement: (changed || connectionChanged) && !acknowledged,
    connectionChanged,
    competition: previous === undefined ? "unknown" : changed ? "changed" : connectionChanged ? "reconnected" : "stable_observed",
    browser: target.browser,
    browserId: target.browserId,
    profile: target.profile,
    connectionId: target.connectionId,
    connectionGeneration: target.connectionGeneration,
    observedBrowserIds: [...observedBrowserIds],
    ...(previous === undefined ? {} : {
      previousBrowser: previous.browser,
      previousBrowserId: previous.browserId,
      ...(previous.connectionId === undefined ? {} : { previousConnectionId: previous.connectionId }),
      ...(previous.connectionGeneration === undefined ? {} : { previousConnectionGeneration: previous.connectionGeneration }),
    }),
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

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, fallback: string): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(fallback));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error(fallback));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

const TAB_ID = Type.Optional(Type.Number({ description: "Chrome/Edge tab id. Omit to use the active tab." }));
const TAB_HANDLE = Type.Optional(Type.Object({
  tabId: Type.Number(),
  browserId: Type.Optional(Type.String()),
  windowId: Type.Optional(Type.Number()),
  groupId: Type.Optional(Type.Number()),
  title: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  tabFence: Type.Optional(Type.String()),
  incarnation: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
}, { additionalProperties: false }));
const SELECTOR = Type.Optional(Type.String({ description: "Optional CSS selector. Prefer a semantic target or a ref from browser_snapshot." }));
const OUTPUT_MAX_CHARS = Type.Optional(Type.Integer({ minimum: 1, description: "Optional output character budget; the extension caps this at 100000." }));
const OUTPUT_MAX_NODES = Type.Optional(Type.Integer({ minimum: 1, description: "Optional output node budget; the extension caps this at 1000." }));
const WAIT_STATE = Type.Optional(Type.Union([
  Type.Literal("load"),
  Type.Literal("url"),
  Type.Literal("text"),
  Type.Literal("text_gone"),
  Type.Literal("visible"),
  Type.Literal("hidden"),
  Type.Literal("enabled"),
], { description: "Wait condition. Defaults to load when omitted." }));
const TIMEOUT_MS = Type.Optional(Type.Number({ minimum: 1, description: "Optional positive timeout in milliseconds." }));
const INDEX = Type.Optional(Type.Integer({ minimum: 0 }));
const ELEMENT_TARGET = Type.Optional(Type.Object({
  ref: Type.Optional(Type.String()),
  selector: Type.Optional(Type.String()),
  role: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  placeholder: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  testId: Type.Optional(Type.String()),
  exact: Type.Optional(Type.Boolean()),
  index: Type.Optional(Type.Integer({ minimum: 0 })),
  scopeSelector: Type.Optional(Type.String()),
  hasText: Type.Optional(Type.String()),
  hasSelector: Type.Optional(Type.String()),
}, { additionalProperties: false }));

/** Client for the local Pi-to-Bridge WebSocket protocol. */
export class BridgeClient {
  private readonly origin: string;
  private readonly wsUrl: string;
  private readonly WebSocketCtor: typeof WebSocket;
  private socket?: WebSocket;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; socket: WebSocket; method: string; params: Record<string, unknown>; removeAbort?: () => void }>();
  private connecting?: Promise<void>;
  private restarting?: Promise<any>;
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
    for (const [id, entry] of this.pending) {
      try {
        if (entry.socket.readyState === this.WebSocketCtor.OPEN) entry.socket.send(JSON.stringify({ type: "cancel", id }));
      } catch {
        // The socket is already closing; disconnect cleanup still rejects the local request.
      }
      clearTimeout(entry.timer);
      entry.removeAbort?.();
      entry.reject(localBrowserRequestError(entry.method, entry.params, new Error("Pi browser bridge stopped"), true));
    }
    this.pending.clear();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    const restarting = this.restarting;
    if (restarting !== undefined) await restarting.catch(() => {});
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
    if (this.restarting !== undefined) return this.restarting;
    const operation = this.restartNow();
    this.restarting = operation;
    try {
      return await operation;
    } finally {
      if (this.restarting === operation) this.restarting = undefined;
    }
  }

  private async restartNow(): Promise<any> {
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

  async request(method: string, params: Record<string, unknown> = {}, target?: BrowserTargetRoute, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) throw signal.reason ?? new Error(`Browser request aborted: ${method}`);
    await raceAbort(this.connect(), signal, `Browser request aborted: ${method}`);
    if (signal?.aborted) throw signal.reason ?? new Error(`Browser request aborted: ${method}`);
    const socket = this.socket;
    if (!socket || socket.readyState !== this.WebSocketCtor.OPEN) throw new Error("Pi browser bridge is not connected");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let removeAbort: (() => void) | undefined;
      const rejectRequest = (error: unknown, cancelRemote = false) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        if (cancelRemote) {
          try {
            if (entry.socket.readyState === this.WebSocketCtor.OPEN) entry.socket.send(JSON.stringify({ type: "cancel", id }));
          } catch {
            // The request is still rejected locally when the Bridge socket is closing.
          }
        }
        clearTimeout(entry.timer);
        removeAbort?.();
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const timer = setTimeout(() => rejectRequest(localBrowserRequestError(method, params, new Error(`Browser request timed out: ${method}`), true), true), 120_000);
      this.pending.set(id, { resolve, reject, timer, socket, method, params, removeAbort: () => removeAbort?.() });
      if (signal !== undefined) {
        const onAbort = () => rejectRequest(localBrowserRequestError(method, params, signal.reason ?? new Error(`Browser request aborted: ${method}`), true), true);
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
        }
      }
      if (!this.pending.has(id)) return;
      try {
        socket.send(JSON.stringify({ type: "request", id, method, params, ...(target === undefined ? {} : { target }) }));
      } catch (error) {
        rejectRequest(localBrowserRequestError(method, params, error, true), true);
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
      try {
        if (socket.readyState === this.WebSocketCtor.OPEN) socket.send(JSON.stringify({ type: "cancel", id }));
      } catch {
        // The close event already represents the failed remote request.
      }
      clearTimeout(entry.timer);
      entry.removeAbort?.();
      entry.reject(localBrowserRequestError(entry.method, entry.params, error, true));
      this.pending.delete(id);
    }
  }

  private settlePending(id: string, error?: Error, value?: unknown, cancelRemote = false): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (cancelRemote) {
      try {
        if (entry.socket.readyState === this.WebSocketCtor.OPEN) entry.socket.send(JSON.stringify({ type: "cancel", id }));
      } catch {
        // The response is already invalid; local settlement still protects the caller.
      }
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.removeAbort?.();
    const settledError = error === undefined ? undefined : cancelRemote
      ? localBrowserRequestError(entry.method, entry.params, error, true)
      : error;
    if (settledError !== undefined) entry.reject(settledError);
    else entry.resolve(value);
  }

  private handleMessage(raw: string, source: WebSocket): void {
    if (this.socket !== source) return;
    try {
      const message = JSON.parse(raw) as { type?: string; id?: string; result?: unknown; error?: { code?: string; message?: string; details?: unknown } };
      if (message.type !== "response" || !message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
      const hasError = message.error !== undefined;
      if ((!hasResult && !hasError) || (hasResult && hasError)) {
        this.settlePending(message.id, new Error("Browser Bridge returned a response without exactly one result or error"), undefined, true);
        return;
      }
      if (message.error !== undefined) {
        const rawError: unknown = message.error;
        if (rawError === null || typeof rawError !== "object" || Array.isArray(rawError)) {
          this.settlePending(message.id, new Error("Browser Bridge returned a malformed error response"), undefined, true);
          return;
        }
        const errorPayload = rawError as { code?: unknown; message?: unknown; details?: unknown };
        if (typeof errorPayload.code !== "string" || typeof errorPayload.message !== "string") {
          this.settlePending(message.id, new Error("Browser Bridge returned a malformed error response"), undefined, true);
          return;
        }
        const error = new Error(errorPayload.message) as Error & { code?: string; details?: unknown };
        error.code = errorPayload.code;
        if (errorPayload.details !== undefined) error.details = errorPayload.details;
        this.settlePending(message.id, error);
      } else this.settlePending(message.id, undefined, message.result);
    } catch {
      // A frame without a usable id cannot be associated with one pending request.
    }
  }
}

const bridge = new BridgeClient();

type CleanupIntent = { readonly params: Record<string, unknown>; readonly priority: number; readonly inspectFirst?: boolean };
const pendingCleanupSessionIds = new Map<string, CleanupIntent>();
const cleanupFlights = new Map<string, Promise<unknown>>();
const cleanupTargetRoutes = new Map<string, BrowserTargetRoute>();
let resumeBlockedSession: ((ctx?: ExtensionContext) => boolean) | undefined;

function abortActiveBrowserWaits(): void {
  for (const controller of activeWaitControllers) controller.abort(new Error("Browser wait aborted by lifecycle cleanup"));
  activeWaitControllers.clear();
}

function targetRoute(target: BrowserTarget): BrowserTargetRoute {
  return {
    browserId: target.browserId,
    ...(target.connectionId === undefined ? {} : { connectionId: target.connectionId }),
    ...(target.connectionGeneration === undefined ? {} : { connectionGeneration: target.connectionGeneration }),
  };
}

function routeForBrowserId(browserId: string): BrowserTargetRoute {
  return { browserId };
}

function bridgeRequest(method: string, params: Record<string, unknown>, route?: BrowserTargetRoute, signal?: AbortSignal): Promise<any> {
  return route === undefined ? bridge.request(method, params, undefined, signal) : bridge.request(method, params, route, signal);
}

function isTargetLocator(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.combine === "and" || record.combine === "or") return isTargetLocator(record.left) || isTargetLocator(record.right);
  if (record.strategy !== undefined) return false;
  return ["ref", "selector", "role", "label", "placeholder", "text", "testId"].some(key => record[key] !== undefined);
}

const TAB_INCARNATION_METHODS = new Set([
  "list_tabs", "selected_tab", "select_tab", "new_tab", "navigate", "snapshot", "extract", "wait", "back", "forward", "reload",
  "close_tab", "locator", "interaction", "dom_cua", "cua", "screenshot", "evaluate", "cdp", "devtools_enable",
  "devtools_disable", "console_logs", "network_requests", "network_response_body", "dialog", "upload", "clipboard",
  "keypress", "scroll", "claim_tab", "release", "mark_handoff", "mark_deliverable", "download", "cleanup",
]);

function isSideEffectingBrowserRequest(method: string, params: Record<string, unknown>): boolean {
  if (["navigate", "back", "forward", "reload", "select_tab", "new_tab", "close_tab", "upload", "cua", "dom_cua", "keypress", "cleanup"].includes(method)) return method !== "dom_cua" || params.action !== "get_visible_dom";
  if (method === "interaction") return ["click", "double_click", "dblclick", "fill", "type", "press", "select", "check", "uncheck", "set_checked", "hover", "focus", "scroll"].includes(String(params.operation || params.action || ""));
  if (method === "locator") return ["click", "double_click", "dblclick", "fill", "type", "press", "select", "check", "uncheck", "set_checked", "hover", "focus", "scroll"].includes(String(params.action || ""));
  if (method === "download") return !["list", "wait"].includes(String(params.action || ""));
  if (method === "clipboard") return params.action === "write";
  if (method === "dialog") return ["accept", "dismiss"].includes(String(params.action || ""));
  if (method === "console_logs" || method === "network_requests") return params.clear === true;
  if (["devtools_enable", "devtools_disable", "evaluate", "cdp", "select_tab", "release", "claim_tab", "mark_handoff", "mark_deliverable"].includes(method)) return true;
  return false;
}

function localBrowserRequestError(method: string, params: Record<string, unknown>, reason: unknown, outcomeUncertain: boolean): Error & { code?: string; details?: unknown } {
  const sideEffecting = isSideEffectingBrowserRequest(method, params);
  const source = reason instanceof Error ? reason : new Error(String(reason));
  if (!outcomeUncertain) return source;
  const error = sideEffecting
    ? new Error(`Browser ${method} operation outcome is uncertain after cancellation; inspect the current browser state before retrying`)
    : source;
  const result = error as Error & { code?: string; details?: unknown };
  if (sideEffecting) {
    result.code = "BROWSER_OPERATION_UNCERTAIN";
    result.details = { actionState: "unknown", retryable: false, inspectFirst: true };
  } else if (result.code === undefined) {
    result.code = "BROWSER_REQUEST_CANCELED";
  }
  return result;
}

function compactResponseParams(method: string, params: Record<string, unknown>, health: unknown): Record<string, unknown> {
  const supported = method === "snapshot" || method === "extract" || method === "list_tabs" || method === "selected_tab" || (method === "dom_cua" && params.action === "get_visible_dom");
  if (!supported || params.responseMode !== undefined) return params;
  const capabilities = health && typeof health === "object" && !Array.isArray(health)
    ? (health as { capabilities?: unknown }).capabilities
    : undefined;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities) || (capabilities as Record<string, unknown>).compactResponses !== true) return params;
  return { ...params, responseMode: "compact" };
}

function assertBridgeRequestCapabilities(method: string, params: Record<string, unknown>, health: unknown, status?: unknown): void {
  const bridgeCapabilities = health && typeof health === "object" ? (health as { capabilities?: unknown }).capabilities : undefined;
  const bridgeRecord = bridgeCapabilities && typeof bridgeCapabilities === "object" && !Array.isArray(bridgeCapabilities) ? bridgeCapabilities as Record<string, unknown> : {};
  const extensionCapabilities = status && typeof status === "object" ? (status as { capabilities?: unknown }).capabilities : undefined;
  const extensionRecord = extensionCapabilities && typeof extensionCapabilities === "object" && !Array.isArray(extensionCapabilities) ? extensionCapabilities as Record<string, unknown> : {};
  const requiredBridge: string[] = [];
  const requiredExtension: string[] = [];
  if (params.responseMode === "compact") requiredBridge.push("compactResponses");
  const requireTargetSupport = () => {
    requiredBridge.push("semanticTargetRequests");
    requiredExtension.push("semanticTargets");
  };
  if (method === "interaction" && params.target !== undefined) requireTargetSupport();
  if (method === "locator" && (params.target !== undefined || isTargetLocator(params.locator))) requireTargetSupport();
  if (method === "wait") {
    const state = String(params.state || "load");
    if (params.target !== undefined) requireTargetSupport();
    if (["text", "text_gone", "visible", "hidden", "enabled"].includes(state)) {
      requiredBridge.push("pageWaitStates");
      requiredExtension.push("pageWaitStates");
    }
  }
  if (TAB_INCARNATION_METHODS.has(method)) requiredExtension.push("tabIncarnationFence");
  if (["interaction", "locator", "wait"].includes(method) && params.snapshotId !== undefined) requiredExtension.push("snapshotRefs");
  const missing = [
    ...requiredBridge.filter(name => bridgeRecord[name] !== true),
    ...requiredExtension.filter(name => extensionRecord[name] !== true),
  ];
  if (missing.length > 0) {
    const error = new Error(`The browser Bridge or extension does not support: ${[...new Set(missing)].join(", ")}; update pi-control-chrome before sending this request.`) as Error & { code?: string };
    error.code = "BRIDGE_CAPABILITY_MISSING";
    throw error;
  }
}

function bridgeErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function targetRecords(value: unknown): BrowserTarget[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { targets?: unknown }).targets)) return [];
  return (value as { targets: unknown[] }).targets
    .map(readBrowserTarget)
    .filter((target): target is BrowserTarget => target !== undefined);
}

async function availableTargets(session: string): Promise<BrowserTarget[]> {
  return targetRecords(await bridgeRequest("list_targets", { sessionId: session }));
}

async function targetRequiredDetails(session: string): Promise<BrowserTarget[]> {
  return (await availableTargets(session)).filter(target => (target as BrowserTarget & { state?: string }).state === undefined || (target as BrowserTarget & { state?: string }).state === "ready");
}

async function targetRecoveryResult(session: string, error: unknown): Promise<Record<string, unknown>> {
  const code = bridgeErrorCode(error);
  const targets = code === "TARGET_UNAVAILABLE" || code === "TARGET_CONNECTION_CHANGED" ? await availableTargets(session).catch(() => []) : [];
  return {
    connected: false,
    state: code === "TARGET_CONNECTION_CHANGED" ? "target_reconnecting" : "target_unavailable",
    targetUnavailable: true,
    completed: false,
    retryable: code === "TARGET_UNAVAILABLE",
    nextAction: "browser_status",
    recommendation: "refresh_browser_targets",
    error: {
      code: code ?? "TARGET_UNAVAILABLE",
      message: error instanceof Error ? error.message : String(error),
    },
    targets,
  };
}
function cleanupRetainsTabs(value: unknown): boolean {
  if (!value || typeof value !== "object" || !Array.isArray((value as { retained?: unknown }).retained)) return true;
  return (value as { retained: unknown[] }).retained.length > 0;
}

function cleanupFailure(value: unknown): Error | undefined {
  if (!value || typeof value !== "object" || !Array.isArray((value as { failed?: unknown }).failed) || (value as { failed: unknown[] }).failed.length === 0) return undefined;
  const failed = (value as { failed: unknown[] }).failed;
  const uncertain = failed.some(entry => entry && typeof entry === "object" && ((entry as { code?: unknown }).code === "BROWSER_OPERATION_UNCERTAIN" || (entry as { details?: { code?: unknown } }).details?.code === "BROWSER_OPERATION_UNCERTAIN"));
  const error = new Error(`Browser cleanup failed for ${failed.length} tab(s): ${JSON.stringify(failed)}`) as Error & { code?: string; details?: unknown };
  if (uncertain) {
    error.code = "BROWSER_OPERATION_UNCERTAIN";
    error.details = { actionState: "unknown", retryable: false, inspectFirst: true };
  }
  return error;
}

function cleanupIntentPriority(params: Record<string, unknown>): number {
  if (params.recoverStale === true) return 5;
  if (params.mode === "turn") return 4;
  if (params.mode === "disposal") return 3;
  if (params.mode === "context") return 2;
  return 1;
}

function currentBrowserTurnId(): string | number {
  return browserRunId ?? turnNumber;
}

const TURN_CLEANUP_CAPABILITIES = ["turnCleanup", "turnScopedMarks", "retainedCleanup", "debuggerLeaseRecovery", "tabIncarnationFence"] as const;

async function refreshCleanupRoute(session: string, browserId?: string, requireIncarnationFence = false): Promise<BrowserTargetRoute> {
  const route = browserId === undefined ? undefined : routeForBrowserId(browserId);
  const status = await bridgeRequest("status", { sessionId: session, ...(browserId === undefined ? {} : { expectedBrowserId: browserId }) }, route);
  const target = readBrowserTarget(status);
  if (target === undefined) throw new Error("Browser status did not identify an active browser target; cleanup was not attempted");
  if (browserId !== undefined && target.browserId !== browserId) throw new Error(`Browser target changed during cleanup; expected ${browserId} but the active target is ${target.browserId}`);
  if (requireIncarnationFence) {
    const capabilities = status && typeof status === "object" ? (status as Record<string, unknown>).capabilities : undefined;
    const missing = ["tabIncarnationFence", "debuggerLeaseRecovery"].filter(name => !capabilities || typeof capabilities !== "object" || (capabilities as Record<string, unknown>)[name] !== true);
    if (missing.length > 0) throw new Error(`The connected extension does not support stale-runtime ownership recovery (${missing.join(", ")}); reload pi-control-chrome`);
  }
  const currentRoute = targetRoute(target);
  cleanupTargetRoutes.set(session, currentRoute);
  return currentRoute;
}

async function verifyTurnCleanupSupport(session: string, expectedBrowserId?: string): Promise<BrowserTargetRoute> {
  const storedRoute = cleanupTargetRoutes.get(session);
  const route = expectedBrowserId === undefined ? (storedRoute === undefined ? undefined : routeForBrowserId(storedRoute.browserId)) : routeForBrowserId(expectedBrowserId);
  const status = await bridgeRequest("status", { sessionId: session, ...(expectedBrowserId === undefined ? {} : { expectedBrowserId }) }, route);
  const target = readBrowserTarget(status);
  if (target === undefined) throw new Error("Browser status did not identify an active browser target; turn cleanup was not attempted");
  if (expectedBrowserId !== undefined && target.browserId !== expectedBrowserId) {
    throw new Error(`Browser target changed during turn cleanup; expected ${expectedBrowserId} but the active target is ${target.browserId}`);
  }
  const capabilities = status && typeof status === "object" ? (status as Record<string, unknown>).capabilities : undefined;
  const missing = TURN_CLEANUP_CAPABILITIES.filter((name) => !capabilities || typeof capabilities !== "object" || (capabilities as Record<string, unknown>)[name] !== true);
  if (missing.length > 0) throw new Error(`The connected extension does not support turn cleanup (${missing.join(", ")}); reload pi-control-chrome`);
  const currentRoute = targetRoute(target);
  cleanupTargetRoutes.set(session, currentRoute);
  return currentRoute;
}

type CleanupRequestOptions = { readonly automatic?: boolean };

function cleanupInspectionRequiredError(session: string): Error & { code?: string; details?: unknown } {
  const error = new Error(`Browser cleanup for session ${session} requires inspection before retrying` ) as Error & { code?: string; details?: unknown };
  error.code = "BROWSER_OPERATION_UNCERTAIN";
  error.details = { actionState: "unknown", retryable: false, inspectFirst: true, inspectionRequired: true };
  return error;
}

async function requestCleanup(session: string, params: Record<string, unknown> = {}, options: CleanupRequestOptions = {}): Promise<unknown> {
  const existingIntent = pendingCleanupSessionIds.get(session);
  if (options.automatic === true && existingIntent?.inspectFirst === true) throw cleanupInspectionRequiredError(session);
  abortActiveBrowserWaits();
  const previous = cleanupFlights.get(session);
  const run = (async () => {
    if (previous !== undefined) await previous.catch(() => undefined);
    const pendingIntent = pendingCleanupSessionIds.get(session);
    const inheritedParams = pendingIntent?.params.recoverStale === true && params.recoverStale !== true
      ? { ...params, recoverStale: true }
      : params;
    let retryParams = { ...inheritedParams };
    let retryPriority = cleanupIntentPriority(retryParams);
    try {
      if (options.automatic === true && pendingCleanupSessionIds.get(session)?.inspectFirst === true) throw cleanupInspectionRequiredError(session);
      const expectedBrowserId = typeof inheritedParams.expectedBrowserId === "string" ? inheritedParams.expectedBrowserId : undefined;
      let route = expectedBrowserId === undefined ? cleanupTargetRoutes.get(session) : routeForBrowserId(expectedBrowserId);
      const selectedBrowserId = expectedBrowserId ?? route?.browserId;
      if (inheritedParams.mode === "turn") {
        route = await verifyTurnCleanupSupport(session, selectedBrowserId);
      } else {
        route = await refreshCleanupRoute(session, selectedBrowserId, inheritedParams.recoverStale === true);
      }
      const cleanupParams = { ...inheritedParams, sessionId: session, ...(route === undefined ? {} : { expectedBrowserId: route.browserId }) };
      retryParams = { ...cleanupParams };
      retryPriority = cleanupIntentPriority(retryParams);
      const value = await bridgeRequest("cleanup", cleanupParams, route);
      const failure = cleanupFailure(value);
      if (failure !== undefined) throw failure;
      const currentIntent = pendingCleanupSessionIds.get(session);
      if (currentIntent === undefined || retryPriority >= currentIntent.priority) pendingCleanupSessionIds.delete(session);
      return value;
    } catch (error) {
      const previousIntent = pendingCleanupSessionIds.get(session);
      const inspectFirst = bridgeErrorCode(error) === "BROWSER_OPERATION_UNCERTAIN";
      if (previousIntent === undefined || retryPriority >= previousIntent.priority || inspectFirst) {
        pendingCleanupSessionIds.set(session, { params: retryParams, priority: retryPriority, ...(inspectFirst ? { inspectFirst: true } : {}) });
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
  await Promise.allSettled([...pendingCleanupSessionIds.entries()].filter(([, intent]) => intent.inspectFirst !== true).map(([session, intent]) => requestCleanup(session, intent.params, { automatic: true })));
}

function textResult(value: unknown, details?: unknown) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) ?? String(value) }],
    details,
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const record = error && typeof error === "object" ? error as { code?: unknown; details?: unknown } : {};
  const code = typeof record.code === "string" ? record.code : undefined;
  return {
    content: [{ type: "text", text: `Browser error: ${message}` }],
    details: { error: message, ...(code === undefined ? {} : { code }), ...(record.details === undefined ? {} : { details: record.details }) },
  };
}

type BrowserCallOptions = { allowInactive?: boolean };

function validateWaitRequest(params: Record<string, unknown>): void {
  const state = params.state === undefined ? "load" : String(params.state);
  if (!["load", "url", "text", "text_gone", "visible", "hidden", "enabled"].includes(state)) throw new Error(`Unsupported browser wait state: ${state}`);
  const hasText = params.text !== undefined;
  const hasTarget = params.target !== undefined;
  if (state === "text" || state === "text_gone") {
    if (hasTarget) throw new Error(`${state} wait cannot combine text with target`);
    if (typeof params.text !== "string" || !params.text.trim()) throw new Error(`${state} wait requires text`);
  } else if (["visible", "hidden", "enabled"].includes(state)) {
    if (params.exact !== undefined) throw new Error(`${state} wait exact matching belongs inside target`);
    if (hasText) throw new Error(`${state} wait cannot combine target with text`);
    if (!hasTarget) throw new Error(`${state} wait requires target`);
  } else if (state === "url") {
    if (hasText || hasTarget) throw new Error("url wait cannot combine URL matching with text or target");
    if ((typeof params.url !== "string" || !params.url) && (typeof params.urlIncludes !== "string" || !params.urlIncludes)) throw new Error("url wait requires url or urlIncludes");
  } else if (hasText || hasTarget) {
    throw new Error("load wait cannot combine load matching with text or target");
  }
}

function validateLocatorRequest(params: Record<string, unknown>): void {
  if (params.target === undefined) return;
  if (["strategy", "selector", "exact", "name", "index", "hasText", "hasSelector"].some(key => params[key] !== undefined)) throw new Error("locator target cannot be combined with legacy locator fields");
}

async function call(method: string, params: Record<string, unknown> = {}, options: BrowserCallOptions = {}) {
  const lifecycleTracked = !["status", "doctor", "list_tabs", "selected_tab", "cleanup", "context_reset"].includes(method);
  const waitTracked = method === "wait"
    || (method === "navigate" && params.wait !== false)
    || (method === "download" && (params.action === "wait" || (params.action === "start" && params.wait !== false)))
    || (method === "locator" && params.action === "waitFor");
  if (!lifecycleTracked || !waitTracked) return callBrowserRequest(method, params, options);
  const controller = new AbortController();
  activeWaitControllers.add(controller);
  try {
    return await callBrowserRequest(method, params, options, controller.signal);
  } finally {
    activeWaitControllers.delete(controller);
  }
}

function normalizeBrowserParams(params: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...params };
  for (const key of ["snapshotId", "incarnation", "selector", "path"]) {
    if (typeof normalized[key] === "string" && normalized[key].trim().length === 0) delete normalized[key];
  }
  return normalized;
}

async function callBrowserRequest(method: string, params: Record<string, unknown> = {}, options: BrowserCallOptions = {}, requestSignal?: AbortSignal) {
  params = normalizeBrowserParams(params);
  const requestSessionId = sessionId;
  const requestTurn = currentBrowserTurnId();
  const requestGeneration = lifecycleGeneration;
  const assertCurrent = () => {
    if (requestGeneration !== lifecycleGeneration || requestSessionId !== sessionId) throw new Error("Pi browser session changed while the request was in flight");
  };
  if (!options.allowInactive && !browserToolsActive) {
    throw new Error("Browser tools are inactive; load the pi-control-chrome Skill after the user explicitly requests browser control");
  }
  if (sessionTransitionInFlight && method !== "cleanup") {
    const error = new Error("Pi browser session transition is in progress; wait for cleanup to finish before retrying browser operations") as Error & { code?: string };
    error.code = "BROWSER_SESSION_TRANSITION";
    throw error;
  }
  if (paused && !["status", "list_tabs", "selected_tab", "cleanup", "context_reset"].includes(method)) {
    throw new Error("Pi browser control is paused; run /chrome resume first");
  }
  if (method === "wait") validateWaitRequest(params);
  if (method === "locator") validateLocatorRequest(params);
  if (method === "context_reset") return call("cleanup", params, options);
  if (method === "doctor") {
    const route = acknowledgedTarget === undefined ? undefined : routeForBrowserId(acknowledgedTarget.browserId);
    const result = await bridgeRequest("doctor", { sessionId: requestSessionId }, route, requestSignal);
    assertCurrent();
    try {
      const status = await bridgeRequest("status", { sessionId: requestSessionId }, route, requestSignal);
      assertCurrent();
      const targetStability = observeBrowserTarget(status);
      if (targetStability.connectionChanged || targetStability.changed) {
        const base = result && typeof result === "object" ? result : { result };
        const issue = targetStability.connectionChanged
          ? {
            code: "browser_connection_changed",
            message: "The selected browser connection changed; run browser_status with acknowledgeBrowserId before retrying browser operations.",
          }
          : {
            code: "browser_target_changed",
            message: "The active browser target changed; run browser_status with acknowledgeBrowserId after confirming the intended target before retrying browser operations.",
          };
        return { ...base, ok: false, recommendation: targetStability.connectionChanged ? "acknowledge_browser_connection" : "acknowledge_browser_target", targetStability, issues: [issue] };
      }
      const base = result && typeof result === "object" ? result : { result };
      return { ...base, targetStability };
    } catch (error) {
      if (requestSignal?.aborted) throw error;
      return result;
    }
  }
  if (method === "cleanup") {
    if (!bridgeUsed && !browserActivation.cleanupRequired && !turnCleanupArmed && params.recoverStale !== true) return { removed: [], released: [], retained: [], failed: [], recovered: [] };
    bridgeUsed = true;
    browserTargetUsed = true;
    turnCleanupArmed = true;
    browserActivation.markUsed();
    const value = await requestCleanup(requestSessionId, params);
    assertCurrent();
    if (!cleanupRetainsTabs(value)) {
      turnCleanupArmed = false;
      browserTargetUsed = false;
      browserActivation.finalize();
    }
    return value;
  }
  if (method === "status") {
    const { acknowledgeBrowserId, browserId, ...statusParams } = params;
    const explicitBrowserId = optionalBrowserId(browserId);
    const normalizedAcknowledgement = optionalBrowserId(acknowledgeBrowserId);
    const selectionBrowserId = explicitBrowserId ?? normalizedAcknowledgement;
    const requestedBrowserId = selectionBrowserId ?? acknowledgedTarget?.browserId;
    const route = requestedBrowserId === undefined ? undefined : routeForBrowserId(requestedBrowserId);
    let result;
    try {
      result = await bridgeRequest("status", { ...statusParams, sessionId: requestSessionId }, route, requestSignal);
    } catch (error) {
      assertCurrent();
      if (bridgeErrorCode(error) === "TARGET_REQUIRED") {
        const targets = await targetRequiredDetails(requestSessionId);
        assertCurrent();
        return { connected: false, targetRequired: true, error: { code: "TARGET_REQUIRED", message: "Multiple browser targets are connected; provide browserId to select one." }, targets };
      }
      if (bridgeErrorCode(error) === "TARGET_UNAVAILABLE" || bridgeErrorCode(error) === "TARGET_CONNECTION_CHANGED") return targetRecoveryResult(requestSessionId, error);
      throw error;
    }
    assertCurrent();
    const preview = observeBrowserTarget(result);
    const previewTarget = readBrowserTarget(result);
    if (browserTargetUsed
      && preview.changed
      && selectionBrowserId !== undefined
      && previewTarget?.browserId === selectionBrowserId) {
      const base = result && typeof result === "object" ? result : { result };
      return {
        ...base,
        connected: false,
        targetRequired: false,
        state: "target_switch_requires_cleanup",
        ok: false,
        targetStability: preview,
        recommendation: "cleanup_browser_target",
        error: { code: "TARGET_OWNERSHIP_REQUIRES_CLEANUP", message: "Clean up the currently bound browser target before acknowledging a different browser target; ownership is not transferred." },
      };
    }
    const targetStability = selectionBrowserId === undefined ? preview : observeBrowserTarget(result, selectionBrowserId);
    const target = readBrowserTarget(result);
    if (target !== undefined) {
      bridgeUsed = true;
      turnCleanupArmed = true;
      browserActivation.markUsed();
    }
    if (target !== undefined && targetStability.acknowledged) {
      cleanupTargetRoutes.set(requestSessionId, targetRoute(target));
    }
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
  let status;
  const boundRoute = acknowledgedTarget === undefined ? undefined : routeForBrowserId(acknowledgedTarget.browserId);
  try {
    status = await bridgeRequest("status", { sessionId: requestSessionId }, boundRoute, requestSignal);
  } catch (error) {
    assertCurrent();
    if (bridgeErrorCode(error) === "TARGET_REQUIRED") {
      const targets = await targetRequiredDetails(requestSessionId);
      throw new Error(`Multiple browser targets are connected; choose one with browser_status (available: ${targets.map(target => target.browserId).join(", ")})`);
    }
    if (bridgeErrorCode(error) === "TARGET_UNAVAILABLE" || bridgeErrorCode(error) === "TARGET_CONNECTION_CHANGED") return targetRecoveryResult(requestSessionId, error);
    throw error;
  }
  assertCurrent();
  const targetStability = observeBrowserTarget(status);
  const target = readBrowserTarget(status);
  if (targetStability.issue !== undefined || target === undefined) throw new Error("Browser status did not identify an active browser target; run browser_status");
  if (!targetStability.stable || !targetStability.acknowledged) {
    if (targetStability.connectionChanged) throw new Error("Browser connection changed for the selected target; run browser_status to inspect it and acknowledge the current connection before retrying");
    throw new Error(`Browser target changed from ${targetStability.previousBrowser} (${targetStability.previousBrowserId}) to ${targetStability.browser} (${targetStability.browserId}); run browser_status with acknowledgeBrowserId after disabling the other browser extension`);
  }
  cleanupTargetRoutes.set(requestSessionId, targetRoute(target));
  let wireParams = params;
  try {
    const bridgeHealth = await bridge.health();
    assertCurrent();
    wireParams = compactResponseParams(method, params, bridgeHealth);
    assertBridgeRequestCapabilities(method, wireParams, bridgeHealth, status);
  } catch (error) {
    assertCurrent();
    if (bridgeErrorCode(error) === "BRIDGE_CAPABILITY_MISSING") throw error;
    const capabilityError = new Error("Cannot verify browser Bridge request capabilities before sending the browser operation.") as Error & { code?: string };
    capabilityError.code = "BRIDGE_CAPABILITY_MISSING";
    throw capabilityError;
  }
  bridgeUsed = true;
  browserTargetUsed = true;
  turnCleanupArmed = true;
  browserActivation.markUsed();
  const turnParams = method === "mark_handoff" || method === "mark_deliverable" ? { turnId: requestTurn } : {};
  assertCurrent();
  const value = await bridgeRequest(method, { ...wireParams, ...turnParams, sessionId: requestSessionId, expectedBrowserId: target.browserId }, targetRoute(target), requestSignal);
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
    parameters: Type.Object({
      browserId: Type.Optional(Type.String({ description: "Select a connected browser target by browserId." })),
      acknowledgeBrowserId: Type.Optional(Type.String({ description: "Explicitly acknowledge this browserId after confirming a browser switch." })),
    }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("status", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_tabs",
    label: "Browser Tabs",
    description: "List Chrome/Edge windows, tabs, tab groups, ownership and lifecycle state. The Pi group may be shared by sessions; use owner, sessionId and sessionScope, never groupId alone, to choose a tab.",
    parameters: Type.Object({}),
    async execute() {
      try { return textResult(compactBrowserResult("browser_tabs", { sessionId }, await call("list_tabs"))); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_selected",
    label: "Selected Browser Tab",
    description: "Return the currently selected Chrome/Edge tab.",
    parameters: Type.Object({}),
    async execute() {
      try { return textResult(compactBrowserResult("browser_selected", { sessionId }, await call("selected_tab"))); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_claim_tab",
    label: "Claim Browser Tab",
    description: "Claim an existing user tab using its tab id and optional title, URL, or windowId snapshot checks. Fails if any supplied snapshot value changed.",
    parameters: Type.Object({
      tabId: Type.Number(),
      handle: TAB_HANDLE,
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
    parameters: Type.Object({ tabId: Type.Number(), handle: TAB_HANDLE, focusWindow: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("select_tab", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_new_tab",
    label: "New Browser Tab",
    description: "Create an Agent-owned tab and place it in the Pi tab group. Use windowId to target a specific window; otherwise use the current browser window. With wait=true, return a refreshed post-load handle; active=false avoids activation at creation time but cannot prevent later browser or user focus changes.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Initial URL. Defaults to about:blank." })),
      active: Type.Optional(Type.Boolean({ description: "Whether to activate the new tab at creation time; false is best effort if the browser or user later changes focus." })),
      windowId: Type.Optional(Type.Number({ description: "Optional target browser window id. If omitted, use the current browser window." })),
      wait: Type.Optional(Type.Boolean({ description: "Wait for the created tab to finish loading before returning." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Optional positive timeout for the load wait." })),
      allowRedirects: Type.Optional(Type.Boolean({ description: "Allow the final URL to differ from the requested URL while waiting; browser URL canonicalization is accepted even when false." })),
    }),
    async execute(_toolCallId, params) {
      try { return textResult(compactBrowserResult("browser_new_tab", { ...params, sessionId }, await call("new_tab", params))); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Read the active page title and one bounded semantic page state with snapshot-scoped eN refs; ref actions require the returned snapshotId.",
    parameters: Type.Object({ tabId: TAB_ID, handle: TAB_HANDLE, selector: SELECTOR, maxChars: OUTPUT_MAX_CHARS, maxNodes: OUTPUT_MAX_NODES }),
    async execute(_toolCallId, params) {
      try { return textResult(compactBrowserResult("browser_snapshot", params, await call("snapshot", params))); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_extract",
    label: "Extract Browser Page",
    description: "Extract the current page as bounded plain text and simple Markdown without fetching it through a separate web scraper.",
    parameters: Type.Object({ tabId: TAB_ID, handle: TAB_HANDLE, selector: SELECTOR, maxChars: OUTPUT_MAX_CHARS }),
    async execute(_toolCallId, params) {
      try { return textResult(compactBrowserResult("browser_extract", params, await call("extract", params))); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_accessibility_snapshot",
    label: "Browser Accessibility Snapshot",
    description: "Return the bounded accessibility-oriented semantic tree as full, incremental diff or unchanged text; the first read is full and later reads may be diff or unchanged.",
    parameters: Type.Object({ tabId: TAB_ID, handle: TAB_HANDLE, selector: SELECTOR, maxChars: OUTPUT_MAX_CHARS, maxNodes: OUTPUT_MAX_NODES, disableDiffing: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      try {
        const result = await call("snapshot", { ...params, accessibilityOnly: true });
        return textResult(compactBrowserResult("browser_accessibility_snapshot", params, result));
      } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_locator",
    label: "Browser Locator",
    description: "Playwright-style locator operations using semantic targets, css, role, text, label, placeholder and testid strategies plus count, first, last, nth, text, attributes and actions; ref locators require the matching snapshotId.",
    parameters: Type.Object({
      tabId: TAB_ID,
      handle: TAB_HANDLE,
      action: Type.String(),
      target: ELEMENT_TARGET,
      snapshotId: Type.Optional(Type.String()),
      strategy: Type.Optional(Type.String()),
      selector: SELECTOR,
      value: Type.Optional(Type.Unknown()),
      exact: Type.Optional(Type.Boolean()),
      name: Type.Optional(Type.String()),
      index: INDEX,
      hasText: Type.Optional(Type.String()),
      hasSelector: Type.Optional(Type.String()),
      other: Type.Optional(Type.Unknown()),
      attribute: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      timeoutMs: TIMEOUT_MS,
    }),
    async execute(_toolCallId, params) {
      try {
        const locator = params.target ?? {
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
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, url: Type.String(), wait: Type.Optional(Type.Boolean()), timeoutMs: TIMEOUT_MS, allowRedirects: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("navigate", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_wait",
    label: "Wait for Browser Page",
    description: "Wait for a selected browser tab to load, reach a URL, show or hide text, or reach an element state; ref targets require the matching snapshotId.",
    parameters: Type.Object({
      tabId: TAB_ID,
      handle: TAB_HANDLE,
      state: WAIT_STATE,
      url: Type.Optional(Type.String()),
      urlIncludes: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      target: ELEMENT_TARGET,
      snapshotId: Type.Optional(Type.String()),
      exact: Type.Optional(Type.Boolean()),
      timeoutMs: TIMEOUT_MS,
    }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("wait", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_click",
    label: "Click Browser Element",
    description: "Click one visible element by semantic target, a snapshot-scoped eN ref with snapshotId, or CSS selector.",
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR, target: ELEMENT_TARGET, timeoutMs: TIMEOUT_MS }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "click" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_double_click",
    label: "Double Click Browser Element",
    description: "Double-click one visible element by semantic target, a snapshot-scoped eN ref with snapshotId, or CSS selector.",
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR, target: ELEMENT_TARGET, timeoutMs: TIMEOUT_MS }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "double_click" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_fill",
    label: "Fill Browser Field",
    description: "Fill one input, textarea or contenteditable element by semantic target, a snapshot-scoped eN ref with snapshotId, or CSS selector.",
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR, target: ELEMENT_TARGET, value: Type.String(), timeoutMs: TIMEOUT_MS }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "fill" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_type",
    label: "Type Browser Text",
    description: "Type or append text into one focused browser field selected by semantic target, a snapshot-scoped eN ref with snapshotId, or CSS selector.",
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR, target: ELEMENT_TARGET, value: Type.String(), timeoutMs: TIMEOUT_MS }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "type" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_press_key",
    label: "Press Browser Key",
    description: "Dispatch a keyboard key to one element selected by semantic target, a snapshot-scoped eN ref with snapshotId, or CSS selector.",
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, snapshotId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: SELECTOR, target: ELEMENT_TARGET, key: Type.String(), timeoutMs: TIMEOUT_MS }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "press" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_scroll",
    label: "Scroll Browser",
    description: "Scroll the selected page by a viewport delta.",
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, deltaX: Type.Optional(Type.Number()), deltaY: Type.Optional(Type.Number()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("interaction", { ...params, operation: "scroll" })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_dom_cua",
    label: "Browser DOM CUA",
    description: "Use visible DOM node ids from the latest browser_dom_cua snapshot; any supplied nodeId requires its matching snapshotId for click, double-click, type, keypress and scroll operations.",
    parameters: Type.Object({
      tabId: TAB_ID,
      handle: TAB_HANDLE,
      action: Type.Union([Type.Literal("get_visible_dom"), Type.Literal("click"), Type.Literal("double_click"), Type.Literal("type"), Type.Literal("keypress"), Type.Literal("scroll")]),
      snapshotId: Type.Optional(Type.String()),
      nodeId: Type.Optional(Type.String()),
      selector: SELECTOR,
      maxChars: OUTPUT_MAX_CHARS,
      maxNodes: OUTPUT_MAX_NODES,
      value: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      deltaX: Type.Optional(Type.Number()),
      deltaY: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await call("dom_cua", params);
        return textResult(compactBrowserResult("browser_dom_cua", params, result));
      } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_cua",
    label: "Browser Coordinate CUA",
    description: "Use native CDP mouse and keyboard input at viewport coordinates, including click, move, scroll, drag, type and keypress.",
    parameters: Type.Object({
      tabId: TAB_ID,
      handle: TAB_HANDLE,
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
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, fullPage: Type.Optional(Type.Boolean()), path: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      try {
        const result = await call("screenshot", params) as { data: string; mimeType?: string; tabId?: number };
        let savedPath: string | undefined;
        if (params.path) {
          savedPath = resolve(String(params.path));
          await mkdir(dirname(savedPath), { recursive: true });
          await writeFile(savedPath, Buffer.from(result.data, "base64"));
        }
        const { data: _discarded, ...metadata } = result;
        return {
          content: [
            { type: "text", text: `Screenshot captured for tab ${result.tabId ?? "selected"}${savedPath ? ` and saved to ${savedPath}` : ""}.` },
            { type: "image", data: result.data, mimeType: result.mimeType || "image/png" },
          ],
          details: { ...metadata, path: savedPath },
        };
      } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_console",
    label: "Browser Console",
    description: "Enable and read Runtime console and Log entries captured from a browser tab.",
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, action: Type.Optional(Type.String()), clear: Type.Optional(Type.Boolean()) }),
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
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, action: Type.Optional(Type.String()), requestId: Type.Optional(Type.String({ description: "Required for response_body; copy from the current Network listing." })), loaderId: Type.Optional(Type.String({ description: "Required for response_body; copy the matching loaderId from the current Network listing." })), clear: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      try {
        if (params.action === "enable") return textResult(await call("devtools_enable", { ...params, domains: ["Network", "Page"] }));
        if (params.action === "response_body") {
          if (!params.requestId || !params.loaderId) throw new Error("browser_network response_body requires requestId and loaderId from the current Network listing");
          return textResult(await call("network_response_body", params));
        }
        return textResult(await call("network_requests", params));
      } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_dialog",
    label: "Browser JavaScript Dialog",
    description: "Inspect and accept or dismiss alert, confirm and prompt dialogs using native CDP.",
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, action: Type.String(), promptText: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("dialog", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_upload",
    label: "Browser File Upload",
    description: "Set local files on a page file input using native CDP DOM.setFileInputFiles in Trusted Local Mode.",
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, selector: SELECTOR, nodeId: Type.Optional(Type.Number()), incarnation: Type.Optional(Type.String()), files: Type.Union([Type.String(), Type.Array(Type.String())]) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("upload", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_clipboard",
    label: "Browser Clipboard",
    description: "Read or write plain text through the selected tab's browser clipboard.",
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, action: Type.Union([Type.Literal("read"), Type.Literal("write")]), text: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("clipboard", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_download",
    label: "Browser Download",
    description: "Start, wait for, list, cancel or erase browser downloads and return their paths/status.",
    parameters: Type.Object({ action: Type.String(), url: Type.Optional(Type.String()), filename: Type.Optional(Type.String()), saveAs: Type.Optional(Type.Boolean()), wait: Type.Optional(Type.Boolean()), downloadId: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()), timeoutMs: TIMEOUT_MS }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("download", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_evaluate",
    label: "Evaluate Browser JavaScript",
    description: "Evaluate JavaScript in the selected page using the native CDP Runtime.evaluate path.",
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, expression: Type.String(), awaitPromise: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("evaluate", params)); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_cdp",
    label: "Native Browser CDP",
    description: "Send a native Chrome DevTools Protocol command to the selected browser tab.",
    parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, method: Type.String(), params: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
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
      parameters: Type.Object({ tabId: TAB_ID,
      handle: TAB_HANDLE, bypassCache: Type.Optional(Type.Boolean()) }),
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
    parameters: Type.Object({ tabId: Type.Number(), handle: TAB_HANDLE, userRequested: Type.Optional(Type.Boolean()) }),
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
      try { return textResult(await call("mark_handoff", { ...params, turnId: currentBrowserTurnId() })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_mark_deliverable",
    label: "Keep Browser Deliverable",
    description: "Mark an Agent-owned tab to survive the current turn cleanup as a user-facing deliverable; repeat the mark in a later turn.",
    parameters: Type.Object({ tabId: Type.Number() }),
    async execute(_toolCallId, params) {
      try { return textResult(await call("mark_deliverable", { ...params, turnId: currentBrowserTurnId() })); } catch (error) { return errorResult(error); }
    },
  });

  pi.registerTool({
    executionMode: "sequential",
    name: "browser_cleanup",
    label: "Finalize Browser Task",
    description: "Only after the user explicitly asks for browser cleanup: close allowed Agent tabs, release claims, and optionally forget stale-runtime ownership without closing unknown tabs while keeping browser tools and the Bridge active.",

    parameters: Type.Object({ recoverStale: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      const generation = lifecycleGeneration;
      const value = await call("cleanup", params);
      if (generation !== lifecycleGeneration) throw new Error("Pi browser session changed while cleanup was completing");
      const retainsTabs = cleanupRetainsTabs(value);
      bridgeUsed = retainsTabs;
      browserTargetUsed = retainsTabs;
      if (retainsTabs) {
        turnCleanupArmed = true;
        browserActivation.markUsed();
      } else {
        turnCleanupArmed = false;
        browserActivation.finalize();
      }
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
        browserTargetUsed = false;
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
    abortActiveBrowserWaits();
    const needsCleanup = bridgeUsed || turnCleanupArmed || browserActivation.cleanupRequired;
    let cleanupSucceeded = !needsCleanup;
    if (needsCleanup) {
      try {
        await requestCleanup(previousSessionId, {}, { automatic: true });
        cleanupSucceeded = true;
      } catch {
        cleanupSucceeded = false;
      }
    }
    await retryPendingCleanups();
    if (lifecycleGeneration !== resetGeneration || sessionId !== previousSessionId) return;
    cleanupSucceeded = !pendingCleanupSessionIds.has(previousSessionId);
    if (!cleanupSucceeded) {
      bridgeUsed = true;
      browserTargetUsed = true;
      turnCleanupArmed = true;
      browserActivation.markUsed();
      updateStatus(ctx, status + "; browser cleanup pending");
      return;
    }
    cleanupTargetRoutes.delete(previousSessionId);
    bridgeUsed = false;
    browserTargetUsed = false;
    turnCleanupArmed = false;
    browserRunId = undefined;
    browserRunSequence = 0;
    agentRunCleanupDone = false;
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
          const recoverStale = rest.includes("--recover-stale") || rest.includes("recover-stale");
          const result = await humanCall("cleanup", recoverStale ? { recoverStale: true } : {});
          if (generation !== lifecycleGeneration) return;
          ctx.ui.notify(JSON.stringify(result), "info");
          const retainsTabs = cleanupRetainsTabs(result);
          bridgeUsed = retainsTabs;
          browserTargetUsed = retainsTabs;
          turnCleanupArmed = retainsTabs;
          if (retainsTabs) browserActivation.markUsed();
          else browserActivation.finalize();
          return;
        }
        if (action === "release" && rest[0]) {
          ctx.ui.notify(JSON.stringify(await humanCall("release", { tabId: Number(rest[0]) })), "info");
          return;
        }
        if (action === "targets") {
          const result = await bridgeRequest("list_targets", { sessionId });
          if (generation !== lifecycleGeneration) return;
          ctx.ui.notify(JSON.stringify(result, null, 2), "info");
          return;
        }
        if (action === "profile") {
          const result = await humanCall("status", rest[0] ? { browserId: rest[0], acknowledgeBrowserId: rest[0] } : {});
          if (generation !== lifecycleGeneration) return;
          ctx.ui.notify(JSON.stringify(rest[0] ? {
            selected: rest[0],
            browser: result.browser,
            profile: result.profile,
            browserId: result.browserId,
            connectionGeneration: result.connectionGeneration,
          } : { browser: result.browser, profile: result.profile, browserId: result.browserId, userAgent: result.userAgent, extensionVersion: result.extensionVersion }, null, 2), "info");
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
        ctx.ui.notify("用法：/chrome status|connect|restart|disconnect|pause|resume|targets|tabs|profile [browserId]|group|setup|cleanup [--recover-stale]|release <tabId>", "warning");
      } catch (error) {
        if (generation !== lifecycleGeneration) return;
        updateStatus(ctx, "chrome: offline");
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    abortActiveBrowserWaits();
    if (pendingCleanupSessionIds.size > 0 || sessionTransitionInFlight) {
      sessionTransitionInFlight = true;
      await retryPendingCleanups();
      if (pendingCleanupSessionIds.size > 0) {
        bridgeUsed = true;
        browserTargetUsed = true;
        turnCleanupArmed = true;
        browserActivation.reset();
        setBrowserTools(browserActivation.active);
        updateStatus(ctx, "chrome: ready; browser cleanup pending");
        return;
      }
    }
    lifecycleGeneration += 1;
    sessionTransitionInFlight = false;
    sessionId = randomUUID();
    turnNumber = 0;
    browserSkillPaths.clear();
    acknowledgedTarget = undefined;
    observedBrowserIds.clear();
    bridgeUsed = false;
    browserTargetUsed = false;
    turnCleanupArmed = false;
    browserRunId = undefined;
    browserRunSequence = 0;
    agentRunCleanupDone = false;
    browserActivation.reset();
    paused = false;
    setBrowserTools(browserActivation.active);
    updateStatus(ctx, "chrome: ready");
  });

  const runAutomaticTurnCleanup = async (
    ctx: ExtensionContext,
    cleanupSessionId: string,
    generation: number,
    cleanupTurnId: string | number,
  ): Promise<void> => {
    if (sessionTransitionInFlight || generation !== lifecycleGeneration || sessionId !== cleanupSessionId || agentRunCleanupDone) return;
    const needsCleanup = turnCleanupArmed || bridgeUsed || browserActivation.cleanupRequired;
    if (!needsCleanup) {
      agentRunCleanupDone = true;
      browserRunId = undefined;
      return;
    }
    try {
      const value = await requestCleanup(cleanupSessionId, { mode: "turn", turnId: cleanupTurnId, detachDevtools: true }, { automatic: true });
      if (generation !== lifecycleGeneration || sessionId !== cleanupSessionId || sessionTransitionInFlight) return;
      bridgeUsed = false;
      if (cleanupRetainsTabs(value)) {
        browserTargetUsed = true;
        turnCleanupArmed = true;
      } else {
        browserTargetUsed = false;
        turnCleanupArmed = false;
        browserActivation.finalize();
      }
      agentRunCleanupDone = true;
      browserRunId = undefined;
    } catch {
      if (generation !== lifecycleGeneration || sessionId !== cleanupSessionId || sessionTransitionInFlight) return;
      browserTargetUsed = true;
      // The failed intent remains queued for an explicit, safe retry. Start a
      // fresh logical Pi run next time; requestCleanup still retains the exact
      // failed intent in pendingCleanupSessionIds.
      browserRunId = undefined;
      ctx.ui.setStatus("pi-control-chrome", "chrome: turn cleanup pending");
    }
  };

  pi.on("agent_start", () => {
    if (sessionTransitionInFlight) return;
    if (browserRunId === undefined) {
      browserRunSequence += 1;
      browserRunId = `${sessionId}:run-${browserRunSequence}`;
    }
    agentRunCleanupDone = false;
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
    // Pi emits turn_end after every model/tool round. Browser tabs must stay
    // alive for the following round (e.g. new_tab -> snapshot), so defer the
    // actual turn cleanup until agent_settled. Keep the fallback for older Pi
    // hosts that did not include toolResults in the event payload.
    if (Array.isArray(event.toolResults)) {
      if (generation === lifecycleGeneration && sessionId === cleanupSessionId && turnNumber === turn) turnNumber = turn + 1;
      return;
    }
    await runAutomaticTurnCleanup(ctx, cleanupSessionId, generation, currentBrowserTurnId());
    if (generation === lifecycleGeneration && sessionId === cleanupSessionId && turnNumber === turn) turnNumber = turn + 1;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const generation = lifecycleGeneration;
    const cleanupSessionId = sessionId;
    await runAutomaticTurnCleanup(ctx, cleanupSessionId, generation, currentBrowserTurnId());
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
