#!/usr/bin/env node

import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";

const DEFAULT_PORT = 17318;
const DEFAULT_TOKEN_FILE = join(
  process.env.USERPROFILE || process.env.HOME || process.cwd(),
  ".pi",
  "agent",
  "pi-control-chrome.token",
);
const DEBUG = process.env.PI_CONTROL_CHROME_DEBUG === "1";
const BRIDGE_SERVICE = "pi-control-chrome";
const BRIDGE_CAPABILITIES = Object.freeze({
  browserIdentity: true,
  atomicTargetRouting: true,
  cooperativeRestart: true,
  localUserRestart: true,
  multiTargetRouting: true,
  targetList: true,
  connectionGeneration: true,
  targetScopedEvents: true,
});
const BRIDGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
})();

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(argValue("--port", DEFAULT_PORT));
const tokenFile = argValue("--token-file", DEFAULT_TOKEN_FILE);
const startedByValue = argValue("--started-by", argValue("--managed-by", "unknown"));
const startedBy = startedByValue === "dsh" || startedByValue === "pi" ? startedByValue : "unknown";

const instanceId = randomUUID();

function ensureToken() {
  if (existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, "utf8").trim();
    if (existing) return existing;
  }
  mkdirSync(dirname(tokenFile), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

const token = ensureToken();
const clients = new Set();
const pending = new Map();
const extensionTargets = new Map();
const targetGenerations = new Map();
const diagnostics = [];
const MAX_DIAGNOSTICS = 100;
const startedAt = Date.now();
const metrics = {
  requests: 0,
  routedRequests: 0,
  requestTimeouts: 0,
  requestErrors: 0,
  targetConnections: 0,
  targetReconnects: 0,
  targetReplacements: 0,
};
let requestCounter = 0;
let restarting = false;

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extensionIdentity(value) {
  if (!value || typeof value !== "object") return undefined;
  const browser = nonEmptyString(value.browser);
  const browserId = nonEmptyString(value.browserId);
  const profile = nonEmptyString(value.profile);
  if (!browser || !browserId || !profile) return undefined;
  return {
    browser,
    browserId,
    profile,
    ...(nonEmptyString(value.extensionVersion) ? { extensionVersion: value.extensionVersion } : {}),
    ...(value.capabilities && typeof value.capabilities === "object" ? { capabilities: value.capabilities } : {}),
    ...(nonEmptyString(value.userAgent) ? { userAgent: value.userAgent } : {}),
  };
}

function publicTarget(record) {
  const { client: _client, ...target } = record;
  return target;
}

function recordDiagnostic(event, fields = {}) {
  diagnostics.push({ event, at: Date.now(), ...fields });
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
}

function targetForClient(client) {
  const browserId = client.browserIdentity?.browserId;
  const record = browserId ? extensionTargets.get(browserId) : undefined;
  return record?.client === client ? record : undefined;
}

function targetEvent(record, event, extra = {}) {
  return {
    type: "event",
    event,
    ...extra,
    target: {
      browserId: record.browserId,
      connectionId: record.connectionId,
      connectionGeneration: record.connectionGeneration,
    },
  };
}

function broadcastTargetEvent(record, event, extra = {}) {
  const message = targetEvent(record, event, extra);
  for (const client of clients) {
    if (client.role === "pi") send(client, message);
  }
}

function setExtensionIdentity(client, value) {
  const identity = extensionIdentity(value);
  if (!identity) return false;
  const previousIdentity = client.browserIdentity;
  const existing = extensionTargets.get(identity.browserId);
  if (existing?.client === client) {
    client.browserIdentity = identity;
    existing.extensionVersion = identity.extensionVersion;
    existing.profile = identity.profile;
    existing.browser = identity.browser;
    existing.capabilities = identity.capabilities;
    existing.userAgent = identity.userAgent;
    existing.state = "ready";
    existing.lastSeenAt = Date.now();
    return true;
  }

  if (previousIdentity && previousIdentity.browserId !== identity.browserId) {
    const previous = extensionTargets.get(previousIdentity.browserId);
    if (previous?.client === client) {
      previous.client = undefined;
      previous.state = "replaced";
      previous.lastSeenAt = Date.now();
      previous.lastError = "The extension identified a different browser target.";
      broadcastTargetEvent(previous, "target_replaced", { previousBrowserId: previous.browserId, browserId: identity.browserId });
    }
  }

  const previousConnection = existing?.client;
  const generation = (targetGenerations.get(identity.browserId) ?? 0) + 1;
  targetGenerations.set(identity.browserId, generation);
  const record = {
    ...identity,
    client,
    connectionId: randomUUID(),
    connectionGeneration: generation,
    state: "ready",
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  if (previousConnection && previousConnection !== client) {
    metrics.targetReplacements += 1;
    const previousRecord = existing;
    if (previousRecord) {
      previousRecord.client = undefined;
      previousRecord.state = "replaced";
      previousRecord.lastSeenAt = Date.now();
      previousRecord.lastError = "The browser target connection was replaced by a newer connection.";
      rejectPendingForExtension(previousConnection, "TARGET_CONNECTION_CHANGED", "The browser target connection was replaced by a newer connection.");
      broadcastTargetEvent(previousRecord, "target_replaced", { connectionGeneration: generation });
    }
    if (previousConnection.readyState === 1) previousConnection.close(1012, "replaced");
  } else if (targetGenerations.get(identity.browserId) > 1) {
    metrics.targetReconnects += 1;
  } else {
    metrics.targetConnections += 1;
  }
  client.browserIdentity = identity;
  client.connectionId = record.connectionId;
  client.connectionGeneration = record.connectionGeneration;
  extensionTargets.set(identity.browserId, record);
  recordDiagnostic("target_connected", {
    browserId: record.browserId,
    connectionId: record.connectionId,
    connectionGeneration: record.connectionGeneration,
    browser: record.browser,
  });
  broadcastTargetEvent(record, generation > 1 ? "target_reconnected" : "target_connected");
  return true;
}

function connectionGeneration(value) {
  if (value === undefined) return undefined;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function requestTargetSelector(message) {
  const params = requestParams(message);
  const target = message.target;
  if (target !== undefined && (!target || typeof target !== "object" || Array.isArray(target))) {
    return { error: "target must be an object." };
  }
  const targetObject = target && typeof target === "object" ? target : {};
  const envelopeBrowserId = targetObject.browserId;
  const parameterBrowserId = params.targetBrowserId ?? params.expectedBrowserId;
  if (envelopeBrowserId !== undefined && parameterBrowserId !== undefined && envelopeBrowserId !== parameterBrowserId) {
    return { error: "target.browserId conflicts with params.expectedBrowserId." };
  }
  const explicitTarget = envelopeBrowserId ?? parameterBrowserId;
  if (explicitTarget !== undefined && !nonEmptyString(explicitTarget)) {
    return { error: "browserId must be a non-empty string." };
  }
  const envelopeGeneration = targetObject.connectionGeneration;
  const parameterGeneration = params.expectedConnectionGeneration;
  if (envelopeGeneration !== undefined && parameterGeneration !== undefined && envelopeGeneration !== parameterGeneration) {
    return { error: "target.connectionGeneration conflicts with params.expectedConnectionGeneration." };
  }
  const envelopeConnectionId = targetObject.connectionId;
  const parameterConnectionId = params.expectedConnectionId;
  if (envelopeConnectionId !== undefined && parameterConnectionId !== undefined && envelopeConnectionId !== parameterConnectionId) {
    return { error: "target.connectionId conflicts with params.expectedConnectionId." };
  }
  const rawGeneration = envelopeGeneration ?? parameterGeneration;
  const expectedConnectionGeneration = connectionGeneration(rawGeneration);
  if (rawGeneration !== undefined && expectedConnectionGeneration === undefined) {
    return { error: "connectionGeneration must be a positive integer." };
  }
  const rawConnectionId = envelopeConnectionId ?? parameterConnectionId;
  const expectedConnectionId = nonEmptyString(rawConnectionId);
  if (rawConnectionId !== undefined && expectedConnectionId === undefined) {
    return { error: "connectionId must be a non-empty string." };
  }
  return {
    browserId: nonEmptyString(explicitTarget),
    expectedConnectionId,
    expectedConnectionGeneration,
    explicit: explicitTarget !== undefined,
  };
}

function readyTargets() {
  return [...extensionTargets.values()].filter(record => record.state === "ready" && record.client?.readyState === 1);
}

function listTargets() {
  return [...extensionTargets.values()].map(publicTarget);
}

function selectExtension(message) {
  const selector = requestTargetSelector(message);
  if (selector.error) return { errorCode: "INVALID_BROWSER_TARGET", errorMessage: selector.error };
  if (selector.browserId) {
    const target = extensionTargets.get(selector.browserId);
    if (!target || target.state !== "ready" || target.client?.readyState !== 1) {
      return { errorCode: "TARGET_UNAVAILABLE", errorMessage: `Browser target ${selector.browserId} is not connected.` };
    }
    if (selector.expectedConnectionId !== undefined && selector.expectedConnectionId !== target.connectionId) {
      return { errorCode: "TARGET_CONNECTION_CHANGED", errorMessage: `Browser target ${selector.browserId} connection changed.` };
    }
    if (selector.expectedConnectionGeneration !== undefined && selector.expectedConnectionGeneration !== target.connectionGeneration) {
      return { errorCode: "TARGET_CONNECTION_CHANGED", errorMessage: `Browser target ${selector.browserId} connection generation changed.` };
    }
    return { target };
  }
  const available = readyTargets();
  if (available.length === 1) {
    const target = available[0];
    if (selector.expectedConnectionId !== undefined && selector.expectedConnectionId !== target.connectionId) {
      return { errorCode: "TARGET_CONNECTION_CHANGED", errorMessage: `Browser target ${target.browserId} connection changed.` };
    }
    if (selector.expectedConnectionGeneration !== undefined && selector.expectedConnectionGeneration !== target.connectionGeneration) {
      return { errorCode: "TARGET_CONNECTION_CHANGED", errorMessage: `Browser target ${target.browserId} connection generation changed.` };
    }
    return { target };
  }
  if (available.length > 1) {
    return { errorCode: "TARGET_REQUIRED", errorMessage: "Multiple browser targets are connected; select a browserId before sending browser requests." };
  }
  const anonymous = [...clients].filter(client => client.role === "extension" && client.readyState === 1 && !client.browserIdentity);
  if (anonymous.length === 1 && !selector.explicit) return { anonymous: anonymous[0] };
  if (anonymous.length > 1) return { errorCode: "TARGET_REQUIRED", errorMessage: "Multiple unidentified browser extensions are connected; reload the extensions and select a browser target." };
  return { errorCode: "EXTENSION_OFFLINE", errorMessage: "Chrome/Edge extension is not connected." };
}

function decorateTargetResult(value, target) {
  if (!target || !value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...value,
    browserId: value.browserId ?? target.browserId,
    profile: value.profile ?? target.profile,
    connectionId: target.connectionId,
    connectionGeneration: target.connectionGeneration,
  };
}

function requestParams(message) {
  return message.params && typeof message.params === "object" ? message.params : {};
}

function missingExtensionCapabilities(message, extension) {
  const params = requestParams(message);
  const required = [];
  if (message.method === "cleanup" && params.mode === "turn") required.push("turnCleanup", "turnScopedMarks", "retainedCleanup", "debuggerLeaseRecovery");
  if ((message.method === "mark_handoff" || message.method === "mark_deliverable") && params.turnId !== undefined) required.push("turnScopedMarks");
  const capabilities = extension.browserIdentity?.capabilities ?? extension.capabilities;
  return required.filter((name) => capabilities?.[name] !== true);
}

function handleBridgeRestart(client, id, message) {
  if (restarting) {
    sendError(client, id, "BRIDGE_IN_USE", "The Bridge is already restarting.");
    return;
  }
  const params = requestParams(message);
  if (params.expectedInstanceId !== instanceId) {
    sendError(client, id, "BRIDGE_INSTANCE_CHANGED", "The Bridge instance changed before the restart request was accepted.");
    return;
  }
  if (pending.size !== 0) {
    sendError(client, id, "BRIDGE_IN_USE", "The Bridge has a pending browser request.");
    return;
  }
  restarting = true;
  const requester = nonEmptyString(params.requester) ?? "unknown";
  if (!send(client, {
    type: "response",
    id,
    result: { ok: true, restarting: true, instanceId, startedBy, controlDomain: "local_user", requester },
  })) {
    restarting = false;
    return;
  }
  broadcast({ type: "event", event: "restarting", instanceId, requester });
  setTimeout(shutdown, 25).unref();
}

function rejectWhileRestarting(client, id) {
  if (!restarting) return false;
  sendError(client, id, "BRIDGE_RESTARTING", "The Bridge is restarting; retry after it reconnects.");
  return true;
}

function rejectPendingForExtension(extension, code, message) {
  for (const [id, entry] of pending.entries()) {
    if (entry.extension !== extension) continue;
    clearTimeout(entry.timer);
    pending.delete(id);
    if (entry.client) sendError(entry.client, entry.clientRequestId, code, message);
  }
}

function detachPendingForClient(client) {
  for (const entry of pending.values()) {
    if (entry.client === client) entry.client = undefined;
  }
}

function debug(...args) {
  if (DEBUG) console.error("[pi-control-chrome]", ...args);
}

function isExtensionOrigin(origin) {
  return typeof origin === "string" && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function extensionCorsHeaders(request) {
  const origin = request.headers.origin;
  if (!isExtensionOrigin(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

function jsonResponse(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function send(client, message) {
  if (client?.readyState !== 1) return false;
  try {
    client.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function sendError(client, id, code, message) {
  send(client, { type: "response", id, error: { code, message } });
}

function broadcast(message) {
  for (const client of clients) send(client, message);
}

function handleMessage(client, message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "request" && client.role === "pi") {
    metrics.requests += 1;
    const id = nonEmptyString(message.id);
    if (!id) {
      metrics.requestErrors += 1;
      sendError(client, `req-${++requestCounter}`, "INVALID_REQUEST_ID", "request.id must be a non-empty string.");
      return;
    }
    if ([...pending.values()].some((entry) => entry.client === client && entry.clientRequestId === id)) {
      metrics.requestErrors += 1;
      sendError(client, id, "DUPLICATE_REQUEST_ID", `A request with id ${id} is already pending on this client.`);
      return;
    }
    if (typeof message.method !== "string" || message.method.length === 0) {
      metrics.requestErrors += 1;
      sendError(client, id, "INVALID_REQUEST", "request.method must be a non-empty string.");
      return;
    }
    if (message.method === "list_targets") {
      send(client, {
        type: "response",
        id,
        result: {
          ok: true,
          protocol: 1,
          instanceId,
          targets: listTargets(),
          extensionConnected: [...clients].some(entry => entry.role === "extension" && entry.readyState === 1),
        },
      });
      return;
    }
    if (message.method === "doctor") {
      send(client, { type: "response", id, result: bridgeDoctor() });
      return;
    }
    const bridgeRequestId = `${instanceId}:${++requestCounter}`;
    if (message.method === "bridge_restart") {
      handleBridgeRestart(client, id, message);
      return;
    }
    if (rejectWhileRestarting(client, id)) return;
    const selected = selectExtension(message);
    if (selected.errorCode) {
      metrics.requestErrors += 1;
      recordDiagnostic("request_rejected", {
        method: message.method,
        errorCode: selected.errorCode,
        browserId: nonEmptyString(requestTargetSelector(message).browserId),
      });
      sendError(client, id, selected.errorCode, selected.errorMessage);
      return;
    }
    const target = selected.target;
    const extension = target?.client ?? selected.anonymous;
    if (!extension || extension.readyState !== 1) {
      metrics.requestErrors += 1;
      sendError(client, id, "EXTENSION_OFFLINE", "Chrome/Edge extension is not connected.");
      return;
    }
    const missingCapabilities = missingExtensionCapabilities(message, extension);
    if (missingCapabilities.length > 0) {
      metrics.requestErrors += 1;
      sendError(client, id, "EXTENSION_CAPABILITY_MISSING", `The selected browser target does not support: ${missingCapabilities.join(", ")}. Reload the pi-control-chrome extension.`);
      return;
    }
    if (target && requestTargetSelector(message).expectedConnectionGeneration !== undefined && requestTargetSelector(message).expectedConnectionGeneration !== target.connectionGeneration) {
      metrics.requestErrors += 1;
      sendError(client, id, "TARGET_CONNECTION_CHANGED", `Browser target ${target.browserId} connection generation changed.`);
      return;
    }
    const entry = {
      client,
      clientRequestId: id,
      extension,
      method: message.method,
      target,
      connectionId: target?.connectionId,
      connectionGeneration: target?.connectionGeneration,
      timer: undefined,
    };
    pending.set(bridgeRequestId, entry);
    entry.timer = setTimeout(() => {
      if (pending.get(bridgeRequestId) !== entry) return;
      pending.delete(bridgeRequestId);
      metrics.requestTimeouts += 1;
      recordDiagnostic("request_timeout", {
        method: message.method,
        browserId: target?.browserId,
        connectionId: target?.connectionId,
        connectionGeneration: target?.connectionGeneration,
      });
      if (entry.client) sendError(entry.client, entry.clientRequestId, "TIMEOUT", `Browser request timed out: ${message.method || "unknown"}`);
    }, 120_000);
    const forwarded = {
      type: "request",
      id: bridgeRequestId,
      method: message.method,
      params: message.params ?? {},
      ...(target === undefined ? {} : {
        target: {
          browserId: target.browserId,
          connectionId: target.connectionId,
          connectionGeneration: target.connectionGeneration,
        },
      }),
    };
    if (target) {
      metrics.routedRequests += 1;
      recordDiagnostic("request_routed", {
        method: message.method,
        browserId: target.browserId,
        connectionId: target.connectionId,
        connectionGeneration: target.connectionGeneration,
      });
    }
    if (!send(extension, forwarded)) {
      if (pending.get(bridgeRequestId) === entry) {
        clearTimeout(entry.timer);
        pending.delete(bridgeRequestId);
      }
      metrics.requestErrors += 1;
      sendError(client, id, "EXTENSION_OFFLINE", "Chrome/Edge extension disconnected before the request was sent.");
    }
    return;
  }

  if (message.type === "hello" && client.role === "extension") {
    if (!setExtensionIdentity(client, message)) debug("extension hello did not contain a browser identity");
    return;
  }

  if (message.type === "response" && client.role === "extension") {
    const entry = pending.get(String(message.id));
    if (!entry || entry.extension !== client || (entry.connectionId !== undefined && client.connectionId !== entry.connectionId) || (entry.connectionGeneration !== undefined && client.connectionGeneration !== entry.connectionGeneration)) return;
    const resultBrowserId = message.result && typeof message.result === "object" && !Array.isArray(message.result) ? nonEmptyString(message.result.browserId) : undefined;
    if (entry.target && resultBrowserId !== undefined && resultBrowserId !== entry.target.browserId) {
      clearTimeout(entry.timer);
      pending.delete(String(message.id));
      metrics.requestErrors += 1;
      recordDiagnostic("response_rejected", {
        method: entry.method,
        browserId: entry.target.browserId,
        responseBrowserId: resultBrowserId,
        connectionId: entry.connectionId,
        connectionGeneration: entry.connectionGeneration,
      });
      if (entry.client) sendError(entry.client, entry.clientRequestId, "INVALID_BROWSER_TARGET", `The extension response identified ${resultBrowserId}, expected ${entry.target.browserId}.`);
      return;
    }
    if (entry.method === "status" && !setExtensionIdentity(client, message.result)) debug("extension status did not contain a browser identity");
    clearTimeout(entry.timer);
    pending.delete(String(message.id));
    if (entry.client) {
      if (message.error) metrics.requestErrors += 1;
      send(entry.client, {
        ...message,
        id: entry.clientRequestId,
        ...(message.error ? {} : { result: decorateTargetResult(message.result, entry.target) }),
      });
    }
    return;
  }

  if (message.type === "event" && client.role === "extension") {
    const target = targetForClient(client);
    if (target) {
      target.lastSeenAt = Date.now();
      broadcastTargetEvent(target, message.event || "browser_event", { payload: message.payload, data: message.data, ...message });
    }
  }
}

function extensionConnections() {
  return [...clients].filter(client => client.role === "extension" && client.readyState === 1);
}

function healthDocument() {
  const targets = listTargets();
  const ready = readyTargets();
  const singleTarget = ready.length === 1 ? ready[0] : undefined;
  return {
    ok: true,
    protocol: 1,
    service: BRIDGE_SERVICE,
    bridgeVersion: BRIDGE_VERSION,
    instanceId,
    startedBy,
    controlDomain: "local_user",
    capabilities: {
      ...BRIDGE_CAPABILITIES,
      multiTargetRouting: true,
      targetList: true,
      connectionGeneration: true,
      targetScopedEvents: true,
    },
    restart: {
      available: true,
      method: "cooperative_restart",
      controlDomain: "local_user",
    },
    port,
    extensionConnected: extensionConnections().length > 0,
    targetCount: targets.length,
    readyTargetCount: ready.length,
    targetAmbiguous: ready.length > 1,
    targets,
    ...(singleTarget === undefined ? {} : {
      browser: singleTarget.browser,
      browserId: singleTarget.browserId,
      profile: singleTarget.profile,
      extensionVersion: singleTarget.extensionVersion,
      userAgent: singleTarget.userAgent,
      extensionCapabilities: singleTarget.capabilities,
      connectionId: singleTarget.connectionId,
      connectionGeneration: singleTarget.connectionGeneration,
    }),
    unidentifiedExtensionConnections: extensionConnections().filter(client => !client.browserIdentity).length,
    observability: {
      startedAt,
      pendingRequests: pending.size,
      metrics: { ...metrics },
      recentEvents: diagnostics.slice(-20),
    },
  };
}

function bridgeDoctor() {
  const health = healthDocument();
  const issues = [];
  const notices = [];
  if (health.extensionConnected !== true) {
    issues.push({ code: "extension_not_connected", message: "The local Bridge is healthy but no browser extension is connected." });
  }
  if (health.targetAmbiguous === true) {
    notices.push({ code: "multiple_browser_targets", message: "Multiple browser targets are connected; bind a session to one browserId before sending browser operations." });
  }
  if (health.unidentifiedExtensionConnections > 0) {
    notices.push({ code: "unidentified_browser_target", message: "At least one extension connection has not completed its browser identity handshake." });
  }
  return {
    ok: issues.length === 0,
    state: health.extensionConnected === true ? "connected" : "bridge_only",
    bridgeHealth: health,
    targets: health.targets,
    issues,
    notices,
    recommendation: issues.length > 0 ? "reload_or_connect_extension" : health.targetAmbiguous ? "select_browser_target" : "ready",
  };
}

const server = createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1:${port}"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...extensionCorsHeaders(req),
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    jsonResponse(res, 200, healthDocument(), extensionCorsHeaders(req));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/pair") {
    jsonResponse(res, 200, { ok: true, protocol: 1, token }, extensionCorsHeaders(req));
    return;
  }

  jsonResponse(res, 404, { ok: false, error: "not_found" });
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (client, request) => {
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined && !isExtensionOrigin(requestOrigin)) {
    client.close(1008, "invalid origin");
    return;
  }
  const requestUrl = new URL(request.url || "/ws", `http://${request.headers.host || "127.0.0.1:${port}"}`);
  const suppliedToken = requestUrl.searchParams.get("token");
  const role = requestUrl.searchParams.get("role");
  if (suppliedToken !== token || (role !== "pi" && role !== "extension")) {
    client.close(1008, "invalid pairing");
    return;
  }

  client.role = role;
  client.browserIdentity = undefined;
  client.connectionId = undefined;
  client.connectionGeneration = undefined;
  clients.add(client);
  debug(`${role} client connected`);

  send(client, {
    type: "hello",
    role: "bridge",
    protocol: 1,
    service: BRIDGE_SERVICE,
    bridgeVersion: BRIDGE_VERSION,
    instanceId,
    startedBy,
    controlDomain: "local_user",
    capabilities: {
      ...BRIDGE_CAPABILITIES,
      multiTargetRouting: true,
      targetList: true,
      connectionGeneration: true,
      targetScopedEvents: true,
    },
    extensionConnected: extensionConnections().length > 0,
    targets: listTargets(),
  });
  if (role !== "extension") broadcast({ type: "event", event: "connection", role, connected: true });

  client.on("message", (raw) => {
    try {
      handleMessage(client, JSON.parse(raw.toString()));
    } catch (error) {
      debug("invalid message", error instanceof Error ? error.message : String(error));
    }
  });
  client.on("close", () => {
    clients.delete(client);
    if (client.role === "pi") {
      detachPendingForClient(client);
      broadcast({ type: "event", event: "connection", role: "pi", connected: false });
    }
    if (client.role === "extension") {
      rejectPendingForExtension(client, "EXTENSION_OFFLINE", "Chrome/Edge extension disconnected.");
      const target = targetForClient(client);
      if (target) {
        target.client = undefined;
        target.state = "disconnected";
        target.lastSeenAt = Date.now();
        target.lastError = "The browser extension connection closed.";
        recordDiagnostic("target_disconnected", {
          browserId: target.browserId,
          connectionId: target.connectionId,
          connectionGeneration: target.connectionGeneration,
        });
        broadcastTargetEvent(target, "target_disconnected", { reason: "socket_closed" });
      }
    }
    debug(`${role} disconnected`);
  });
  client.on("error", (error) => debug(`${role} websocket error`, error.message));
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ ok: true, port, tokenFile, pid: process.pid }));
});

function shutdown() {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  for (const client of clients) client.close(1012, "restarting");
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
