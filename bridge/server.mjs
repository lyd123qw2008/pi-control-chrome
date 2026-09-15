#!/usr/bin/env node

import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { compactBrowserResult } from "../pi-extension/output.js";

const DEFAULT_PORT = 17318;
const DEFAULT_TOKEN_FILE = join(
  process.env.USERPROFILE || process.env.HOME || process.cwd(),
  ".pi",
  "agent",
  "pi-control-chrome.token",
);
const DRAINING_TIMEOUT_MS = 180_000;
const MAX_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const WAIT_REQUEST_GRACE_MS = 15_000;
const DEBUG = process.env.PI_CONTROL_CHROME_DEBUG === "1";
const BRIDGE_SERVICE = "pi-control-chrome";
const BRIDGE_CAPABILITIES = Object.freeze({
  browserIdentity: true,
  atomicTargetRouting: true,
  cooperativeRestart: true,
  localUserRestart: true,
  multiTargetRouting: true,
  targetList: true,
  targetLeases: true,
  connectionGeneration: true,
  targetScopedEvents: true,
  semanticTargetRequests: true,
  pageWaitStates: true,
  longWait: true,
  requestCancellation: true,
  compactResponses: true,
  compactPageMap: true,
  interactionDiagnostics: true,
  incrementalConsole: true,
});
const RESPONSE_MODES = new Set(["compact", "raw"]);
const COMPACT_MODEL_READ_BUDGETS = Object.freeze({ snapshotChars: 8_000, snapshotNodes: 100, extractChars: 6_000, domChars: 8_000, domNodes: 100 });
const TAB_INCARNATION_METHODS = new Set([
  "list_tabs", "selected_tab", "select_tab", "new_tab", "navigate", "snapshot", "extract", "wait", "back", "forward", "reload",
  "close_tab", "locator", "interaction", "probe_interaction", "dom_cua", "cua", "screenshot", "evaluate", "cdp", "devtools_enable",
  "devtools_disable", "console_logs", "network_requests", "network_response_body", "dialog", "upload", "clipboard",
  "keypress", "scroll", "claim_tab", "release", "mark_handoff", "mark_deliverable", "download", "cleanup",
]);
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
const startedBy = ["dsh", "pi", "codex"].includes(startedByValue) ? startedByValue : "unknown";
const startupMarkerValue = argValue("--startup-marker", "");
const startupMarker = typeof startupMarkerValue === "string" && startupMarkerValue.length > 0 ? startupMarkerValue : undefined;

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
const draining = new Map();
const extensionTargets = new Map();
const targetGenerations = new Map();
const targetLeases = new Map();
const configuredTargetLeaseTtlMs = Number(process.env.PI_CONTROL_CHROME_TARGET_LEASE_TTL_MS);
const TARGET_LEASE_TTL_MS = Number.isFinite(configuredTargetLeaseTtlMs) && configuredTargetLeaseTtlMs >= 100
  ? configuredTargetLeaseTtlMs
  : 10 * 60 * 1000;
const TARGET_LEASE_CONTROL_METHODS = new Set(["list_targets", "doctor", "status", "target_lease"]);
const diagnostics = [];
const MAX_DIAGNOSTICS = 100;
const startedAt = Date.now();
const metrics = {
  requests: 0,
  routedRequests: 0,
  requestTimeouts: 0,
  requestErrors: 0,
  targetConnections: 0,
  targetDisconnects: 0,
  targetReconnects: 0,
  targetReplacements: 0,
  targetLeaseAcquisitions: 0,
  targetLeaseRenewals: 0,
  targetLeaseReleases: 0,
  targetLeaseSessionReleases: 0,
  targetLeaseConflicts: 0,
  targetLeaseNotOwned: 0,
  targetLeaseExpirations: 0,
  targetLeaseInvalidations: 0,
  modelResponses: 0,
  modelResponseBytes: 0,
  compactModelResponses: 0,
  compactModelResponseBytes: 0,
};
let lastTargetDisconnectAt;
let lastTargetReconnectAt;
let lastTargetReplacementAt;
let requestCounter = 0;
let connectionSequence = 0;
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
    ...(Number.isInteger(value.capabilityRevision) ? { capabilityRevision: value.capabilityRevision } : {}),
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

function setExtensionIdentity(client, value, excludeBridgeRequestId) {
  const identity = extensionIdentity(value);
  if (!identity) return false;
  const previousIdentity = client.browserIdentity;
  const existing = extensionTargets.get(identity.browserId);
  if (existing?.client && existing.client !== client && existing.client.acceptedSequence > client.acceptedSequence) {
    recordDiagnostic("stale_target_handshake", {
      browserId: identity.browserId,
      staleSequence: client.acceptedSequence,
      currentSequence: existing.client.acceptedSequence,
    });
    client.close(1012, "stale browser target connection");
    return false;
  }
  if (existing?.client === client && (!previousIdentity || previousIdentity.browserId === identity.browserId)) {
    client.browserIdentity = identity;
    existing.extensionVersion = identity.extensionVersion;
    existing.capabilityRevision = identity.capabilityRevision;
    existing.profile = identity.profile;
    existing.browser = identity.browser;
    existing.capabilities = identity.capabilities;
    existing.userAgent = identity.userAgent;
    existing.state = "ready";
    existing.lastSeenAt = Date.now();
    return true;
  }

  if (previousIdentity && previousIdentity.browserId !== identity.browserId) {
    rejectPendingForExtension(client, "TARGET_CONNECTION_CHANGED", "The extension identified a different browser target; pending requests were canceled.", excludeBridgeRequestId);
    const previous = extensionTargets.get(previousIdentity.browserId);
    clearTargetLease(previousIdentity.browserId, "target_replaced");
    if (previous?.client === client) {
      previous.client = undefined;
      previous.state = "replaced";
      previous.lastSeenAt = Date.now();
      previous.lastError = "The extension identified a different browser target.";
      broadcastTargetEvent(previous, "target_replaced", { previousBrowserId: previous.browserId, browserId: identity.browserId });
    }
  }

  const previousConnection = existing?.client;
  if (previousConnection && previousConnection !== client) clearTargetLease(identity.browserId, "target_replaced");
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
    lastTargetReplacementAt = Date.now();
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
    lastTargetReconnectAt = Date.now();
  } else {
    metrics.targetConnections += 1;
  }
  client.browserIdentity = identity;
  client.connectionId = record.connectionId;
  client.connectionGeneration = record.connectionGeneration;
  extensionTargets.set(identity.browserId, record);
  recordDiagnostic(generation > 1 ? "target_reconnected" : "target_connected", {
    browserId: record.browserId,
    connectionId: record.connectionId,
    connectionGeneration: record.connectionGeneration,
    ...(existing?.connectionId === undefined ? {} : { previousConnectionId: existing.connectionId }),
    ...(existing?.connectionGeneration === undefined ? {} : { previousConnectionGeneration: existing.connectionGeneration }),
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
  if (explicitTarget === undefined && (expectedConnectionId !== undefined || expectedConnectionGeneration !== undefined)) {
    return { error: "browserId is required when a connection fence is supplied." };
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

function clearTargetLease(browserId, reason = "target_unavailable") {
  const lease = targetLeases.get(browserId);
  if (lease === undefined) return false;
  targetLeases.delete(browserId);
  metrics.targetLeaseReleases += 1;
  if (reason === "lease_expired") metrics.targetLeaseExpirations += 1;
  else if (reason !== "explicit_release" && reason !== "session_release") metrics.targetLeaseInvalidations += 1;
  recordDiagnostic("target_lease_released", {
    browserId,
    reason,
    sessionId: lease.sessionId,
    connectionId: lease.connectionId,
    connectionGeneration: lease.connectionGeneration,
  });
  return true;
}

function leaseObservability() {
  const heldTargets = [];
  for (const [browserId] of targetLeases) {
    const lease = activeTargetLease(browserId);
    if (lease === undefined) continue;
    heldTargets.push({
      browserId,
      state: "held",
      connectionId: lease.connectionId,
      connectionGeneration: lease.connectionGeneration,
      expiresAt: lease.expiresAt,
    });
  }
  return { activeCount: heldTargets.length, heldTargets };
}

function targetRecoveryObservability(targets = listTargets(), ready = readyTargets()) {
  return {
    trackedTargets: targets.length,
    readyTargets: ready.length,
    disconnectedTargets: targets.filter(target => target.state !== "ready").length,
    lastTargetDisconnectAt,
    lastTargetReconnectAt,
    lastTargetReplacementAt,
  };
}

function observabilityDocument(targets = listTargets(), ready = readyTargets()) {
  return {
    pendingRequests: pending.size,
    drainingRequests: draining.size,
    metrics: { ...metrics },
    targetRecovery: targetRecoveryObservability(targets, ready),
    targetLeases: leaseObservability(),
    recentEvents: diagnostics.slice(-20),
  };
}

function clearTargetLeasesForClient(client, reason = "client_disconnected") {
  for (const [browserId, lease] of targetLeases) {
    if (lease.client === client) clearTargetLease(browserId, reason);
  }
}

function activeTargetLease(browserId) {
  const lease = targetLeases.get(browserId);
  if (lease === undefined) return undefined;
  if (lease.expiresAt <= Date.now()) {
    clearTargetLease(browserId, "lease_expired");
    return undefined;
  }
  return lease;
}

function sweepExpiredTargetLeases() {
  for (const [browserId, lease] of targetLeases) {
    if (lease.expiresAt <= Date.now()) clearTargetLease(browserId, "lease_expired");
  }
}

const targetLeaseExpiryTimer = setInterval(sweepExpiredTargetLeases, Math.min(TARGET_LEASE_TTL_MS, 30_000));
targetLeaseExpiryTimer.unref?.();

function leaseView(lease, sessionId) {
  if (lease === undefined) return { state: "available", owner: "none" };
  return {
    state: "held",
    owner: lease.sessionId === sessionId ? "current_session" : "other_session",
    connectionId: lease.connectionId,
    connectionGeneration: lease.connectionGeneration,
    expiresAt: lease.expiresAt,
  };
}

function targetLeaseError(code, message, details = {}) {
  return { code, message, details: { actionState: "not_started", retryable: true, inspectFirst: false, ...details } };
}

function targetLeaseResponseObservability() {
  const document = observabilityDocument();
  return {
    metrics: document.metrics,
    targetRecovery: document.targetRecovery,
    targetLeases: document.targetLeases,
  };
}

function handleTargetLease(client, id, message) {
  const params = requestParams(message);
  const action = nonEmptyString(params.action);
  const sessionId = nonEmptyString(params.sessionId);
  const browserId = nonEmptyString(params.browserId);
  if (!action || !["acquire", "release", "release_session", "status"].includes(action) || !sessionId || (["acquire", "release"].includes(action) && !browserId)) {
    sendError(client, id, "INVALID_TARGET_LEASE", "target_lease requires action acquire, release, release_session or status, sessionId, and browserId for acquire/release.");
    return;
  }
  if (action === "status") {
    const entries = browserId === undefined ? [...extensionTargets.keys()] : [browserId];
    send(client, {
      type: "response",
      id,
      result: {
        ok: true,
        action,
        leases: entries.map(currentBrowserId => ({ browserId: currentBrowserId, lease: leaseView(activeTargetLease(currentBrowserId), sessionId) })),
        observability: targetLeaseResponseObservability(),
      },
    });
    return;
  }
  if (action === "release_session") {
    const released = [];
    for (const [currentBrowserId, lease] of targetLeases) {
      if (lease.client === client && lease.sessionId === sessionId && clearTargetLease(currentBrowserId, "session_release")) {
        released.push(currentBrowserId);
      }
    }
    metrics.targetLeaseSessionReleases += released.length > 0 ? 1 : 0;
    if (released.length > 0) recordDiagnostic("target_lease_session_released", { sessionId, browserIds: released });
    send(client, {
      type: "response",
      id,
      result: {
        ok: true,
        action,
        released,
        releasedCount: released.length,
        observability: targetLeaseResponseObservability(),
      },
    });
    return;
  }
  const target = extensionTargets.get(browserId);
  if (!target || target.state !== "ready" || target.client?.readyState !== 1) {
    const failure = targetLeaseError("TARGET_UNAVAILABLE", `Browser target ${browserId} is not connected.`, { browserId, nextAction: "browser_targets", recommendation: "refresh_browser_targets", targetLease: { state: "unavailable", owner: "none" } });
    sendError(client, id, failure.code, failure.message, failure.details);
    return;
  }
  const existing = activeTargetLease(browserId);
  if (action === "release") {
    if (existing === undefined) {
      send(client, { type: "response", id, result: { ok: true, action, released: false, browserId, lease: leaseView(undefined, sessionId), observability: targetLeaseResponseObservability() } });
      return;
    }
    if (existing.client !== client || existing.sessionId !== sessionId) {
      metrics.targetLeaseNotOwned += 1;
      recordDiagnostic("target_lease_not_owned", { browserId, sessionId, ownerSessionId: existing.sessionId });
      const failure = targetLeaseError("TARGET_LEASE_NOT_OWNED", `Browser target ${browserId} is leased by another session.`, { browserId, nextAction: "browser_target_lease", recommendation: "release_target_lease", targetLease: leaseView(existing, sessionId) });
      sendError(client, id, failure.code, failure.message, failure.details);
      return;
    }
    clearTargetLease(browserId, "explicit_release");
    send(client, { type: "response", id, result: { ok: true, action, released: true, browserId, lease: leaseView(undefined, sessionId), observability: targetLeaseResponseObservability() } });
    return;
  }
  if (existing !== undefined && (existing.client !== client || existing.sessionId !== sessionId)) {
    metrics.targetLeaseConflicts += 1;
    recordDiagnostic("target_lease_conflict", { browserId, sessionId, ownerSessionId: existing.sessionId });
    const failure = targetLeaseError("TARGET_LEASE_CONFLICT", `Browser target ${browserId} is already leased by another session.`, { browserId, nextAction: "browser_target_lease", recommendation: "choose_another_browser_target", targetLease: leaseView(existing, sessionId) });
    sendError(client, id, failure.code, failure.message, failure.details);
    return;
  }
  const lease = existing ?? {
    client,
    sessionId,
    browserId,
    connectionId: target.connectionId,
    connectionGeneration: target.connectionGeneration,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + TARGET_LEASE_TTL_MS,
  };
  lease.expiresAt = Date.now() + TARGET_LEASE_TTL_MS;
  targetLeases.set(browserId, lease);
  if (existing === undefined) metrics.targetLeaseAcquisitions += 1;
  else metrics.targetLeaseRenewals += 1;
  recordDiagnostic(existing === undefined ? "target_lease_acquired" : "target_lease_renewed", { browserId, sessionId, connectionId: target.connectionId, connectionGeneration: target.connectionGeneration });
  send(client, {
    type: "response",
    id,
    result: {
      ok: true,
      action,
      acquired: true,
      browserId,
      target: publicTarget(target),
      lease: leaseView(lease, sessionId),
      observability: targetLeaseResponseObservability(),
    },
  });
}

function enforceTargetLease(client, message, target) {
  if (!target || TARGET_LEASE_CONTROL_METHODS.has(message.method)) return undefined;
  const lease = activeTargetLease(target.browserId);
  if (lease === undefined) return undefined;
  const params = requestParams(message);
  const sessionId = nonEmptyString(params.sessionId);
  if (lease.client !== client || lease.sessionId !== sessionId) {
    metrics.targetLeaseConflicts += 1;
    recordDiagnostic("target_lease_conflict", { browserId: target.browserId, sessionId, ownerSessionId: lease.sessionId, method: message.method });
    return targetLeaseError("TARGET_LEASE_CONFLICT", `Browser target ${target.browserId} is leased by another session.`, { browserId: target.browserId, nextAction: "browser_target_lease", recommendation: "acquire_or_choose_another_browser_target", targetLease: leaseView(lease, sessionId) });
  }
  if (lease.connectionId !== target.connectionId || lease.connectionGeneration !== target.connectionGeneration) {
    const previousLease = leaseView(lease, sessionId);
    clearTargetLease(target.browserId, "connection_changed");
    return targetLeaseError("TARGET_LEASE_STALE", `Browser target ${target.browserId} was reconnected; reacquire its target lease.`, { browserId: target.browserId, nextAction: "browser_target_lease", recommendation: "reacquire_target_lease", targetLease: previousLease });
  }
  const now = Date.now();
  if (lease.expiresAt - now <= TARGET_LEASE_TTL_MS / 2) {
    metrics.targetLeaseRenewals += 1;
    recordDiagnostic("target_lease_renewed", { browserId: target.browserId, sessionId, connectionId: target.connectionId, connectionGeneration: target.connectionGeneration, reason: "operation" });
  }
  lease.expiresAt = now + TARGET_LEASE_TTL_MS;
  return undefined;
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

function responseBrowserIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, "browserId")) return { present: false };
  return { present: true, browserId: nonEmptyString(value.browserId) };
}

function decorateTargetResult(value, target) {
  if (!target || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const responseIdentity = responseBrowserIdentity(value);
  return {
    ...value,
    browserId: responseIdentity.browserId ?? target.browserId,
    profile: nonEmptyString(value.profile) ?? target.profile,
    connectionId: target.connectionId,
    connectionGeneration: target.connectionGeneration,
  };
}

function requestParams(message) {
  return message.params && typeof message.params === "object" && !Array.isArray(message.params) ? message.params : {};
}

function compactRequestParams(method, params = {}) {
  if (params.responseMode !== "compact") return params;
  const budgeted = { ...params };
  if (method === "snapshot") {
    if (budgeted.maxChars === undefined) budgeted.maxChars = COMPACT_MODEL_READ_BUDGETS.snapshotChars;
    if (budgeted.maxNodes === undefined) budgeted.maxNodes = COMPACT_MODEL_READ_BUDGETS.snapshotNodes;
  } else if (method === "extract") {
    if (budgeted.maxChars === undefined) budgeted.maxChars = COMPACT_MODEL_READ_BUDGETS.extractChars;
  } else if (method === "dom_cua" && params.action === "get_visible_dom") {
    if (budgeted.maxChars === undefined) budgeted.maxChars = COMPACT_MODEL_READ_BUDGETS.domChars;
    if (budgeted.maxNodes === undefined) budgeted.maxNodes = COMPACT_MODEL_READ_BUDGETS.domNodes;
  }
  return budgeted;
}

function extensionCapabilities(extension) {
  return extension?.browserIdentity?.capabilities ?? extension?.capabilities ?? {};
}

function routedRequestTimeoutMs(method, params = {}) {
  if (method !== "wait") return DRAINING_TIMEOUT_MS;
  const requested = Number(params.timeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) return DRAINING_TIMEOUT_MS;
  const bounded = Math.min(Math.floor(requested), MAX_WAIT_TIMEOUT_MS);
  return Math.min(MAX_WAIT_TIMEOUT_MS + WAIT_REQUEST_GRACE_MS, Math.max(DRAINING_TIMEOUT_MS, bounded + WAIT_REQUEST_GRACE_MS));
}

function negotiateCompactPageParams(method, params = {}, extension) {
  if (params.responseMode !== "compact") return params;
  const capabilities = extensionCapabilities(extension);
  const negotiated = { ...params };
  if (method === "snapshot" && params.accessibilityOnly !== true && negotiated.pageMap === undefined && capabilities.compactPageMap === true) {
    negotiated.pageMap = true;
  }
  if (method === "extract" && negotiated.scope === undefined && capabilities.scopedExtract === true) {
    negotiated.scope = negotiated.tail === true ? "log" : "primary";
  }
  return negotiated;
}

function extensionRequestParams(params) {
  if (!Object.prototype.hasOwnProperty.call(params, "responseMode")) return params;
  const { responseMode: _responseMode, ...extensionParams } = params;
  return extensionParams;
}

function compactResponseToolName(method, params = {}) {
  if (method === "snapshot") return params.accessibilityOnly === true ? "browser_accessibility_snapshot" : "browser_snapshot";
  if (method === "extract") return "browser_extract";
  if (method === "list_tabs") return "browser_tabs";
  if (method === "selected_tab") return "browser_selected";
  if (method === "dom_cua" && params.action === "get_visible_dom") return "browser_dom_cua";
  return undefined;
}

function responseForClient(entry, value) {
  const decorated = decorateTargetResult(value, entry.target);
  if (entry.params.responseMode !== "compact") return decorated;
  const toolName = compactResponseToolName(entry.method, entry.params);
  return toolName === undefined ? decorated : compactBrowserResult(toolName, entry.params, decorated);
}

function isSideEffectingRequest(method, params = {}) {
  if (["navigate", "back", "forward", "reload", "select_tab", "new_tab", "close_tab", "upload", "cua", "keypress", "scroll", "cleanup", "claim_tab", "release", "mark_handoff", "mark_deliverable", "evaluate", "cdp", "devtools_enable", "devtools_disable", "probe_interaction"].includes(method)) return true;
  if (method === "interaction") return ["click", "double_click", "dblclick", "fill", "type", "press", "select", "check", "uncheck", "set_checked", "hover", "focus", "scroll"].includes(String(params.action || params.operation || ""));
  if (method === "locator") return ["click", "double_click", "dblclick", "fill", "type", "press", "select", "check", "uncheck", "set_checked", "hover", "focus", "scroll"].includes(String(params.action || ""));
  if (method === "dom_cua") return params.action !== "get_visible_dom";
  if (method === "download") return !["list", "wait"].includes(String(params.action || ""));
  if (method === "clipboard") return params.action === "write";
  if (method === "dialog") return ["accept", "dismiss"].includes(String(params.action || ""));
  if (method === "console_logs" || method === "network_requests") return params.clear === true;
  return false;
}


function isTargetLocator(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.combine === "and" || value.combine === "or") return isTargetLocator(value.left) || isTargetLocator(value.right);
  if (value.strategy !== undefined) return false;
  return ["ref", "selector", "role", "label", "placeholder", "text", "testId"].some((key) => value[key] !== undefined);
}

function pendingFailure(entry, code, message) {
  if (!isSideEffectingRequest(entry.method, entry.params)) return { code, message };
  return {
    code: "BROWSER_OPERATION_UNCERTAIN",
    message: `${message} The ${entry.method} operation may have taken effect; inspect the current browser state before retrying`,
    details: { actionState: "unknown", retryable: false, inspectFirst: true },
  };
}

function sendPendingFailure(entry, code, message) {
  if (!entry.client) return false;
  const failure = pendingFailure(entry, code, message);
  return sendError(entry.client, entry.clientRequestId, failure.code, failure.message, failure.details);
}

function hasAccessibilityReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (typeof value.ref === "string" && /^a\d+$/.test(value.ref))
    || hasAccessibilityReference(value.target)
    || hasAccessibilityReference(value.locator)
    || hasAccessibilityReference(value.left)
    || hasAccessibilityReference(value.right);
}

function missingExtensionCapabilities(method, params = {}, extension) {
  const required = [];
  if (method === "dom_cua") required.push("domCuaSnapshots");
  if (["interaction", "locator", "wait"].includes(method) && params.snapshotId !== undefined) required.push("snapshotRefs");
  if (["interaction", "locator", "wait"].includes(method) && hasAccessibilityReference(params)) required.push("axRefs");
  if (method === "cleanup" && params.mode === "turn") required.push("turnCleanup", "turnScopedMarks", "retainedCleanup", "debuggerLeaseRecovery", "tabIncarnationFence");
  if (method === "cleanup" && params.recoverStale === true) required.push("tabIncarnationFence", "debuggerLeaseRecovery");
  if ((method === "mark_handoff" || method === "mark_deliverable") && params.turnId !== undefined) required.push("turnScopedMarks");
  if (method === "interaction" && params.target !== undefined) required.push("semanticTargets");
  if (method === "locator" && (params.target !== undefined || isTargetLocator(params.locator))) required.push("semanticTargets");
  if (method === "snapshot" && params.pageMap === true) required.push("compactPageMap");
  if (method === "extract" && (params.scope === "primary" || params.scope === "log")) required.push("scopedExtract");
  if (method === "extract" && params.tail === true) required.push("tailExtract");
  if (method === "extract" && params.logMatch !== undefined) required.push("extractLogMatch");
  if (method === "reload_extension") required.push("extensionSelfReload");
  if (method === "wait") {
    const state = String(params.state || "load");
    if (params.target !== undefined) required.push("semanticTargets");
    if (["text", "text_gone", "visible", "hidden", "enabled"].includes(state)) required.push("pageWaitStates");
    if (params.textAny !== undefined || params.failureTextAny !== undefined) required.push("waitTerminalStates");
    if (params.reload === true) required.push("reloadAwareWait");
    if (Number(params.timeoutMs) > 120_000) required.push("longWait");
  }
  if (TAB_INCARNATION_METHODS.has(method)) required.push("tabIncarnationFence");
  const capabilities = extensionCapabilities(extension);
  return [...new Set(required)].filter((name) => capabilities?.[name] !== true);
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
  if (pending.size !== 0 || draining.size !== 0) {
    sendError(client, id, "BRIDGE_IN_USE", "The Bridge has a pending or draining browser request.");
    return;
  }
  restarting = true;
  for (const browserId of targetLeases.keys()) clearTargetLease(browserId, "bridge_restart");
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

function rejectPendingForExtension(extension, code, message, excludeBridgeRequestId) {
  for (const [id, entry] of pending.entries()) {
    if (id === excludeBridgeRequestId || entry.extension !== extension) continue;
    cancelPendingEntry(id, entry, code);
    sendPendingFailure(entry, code, message);
  }
}

function detachPendingForClient(client) {
  for (const [bridgeRequestId, entry] of pending) {
    if (entry.client !== client) continue;
    cancelPendingEntry(bridgeRequestId, entry, "pi_client_disconnected");
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

function sendSerialized(client, serialized) {
  if (client?.readyState !== 1) return false;
  try {
    client.send(serialized);
    return true;
  } catch {
    return false;
  }
}

function send(client, message) {
  try {
    return sendSerialized(client, JSON.stringify(message));
  } catch {
    return false;
  }
}

function cancelExtensionRequest(bridgeRequestId, entry) {
  if (!entry.extension) return false;
  return send(entry.extension, { type: "cancel", id: bridgeRequestId });
}
function markDraining(bridgeRequestId, entry, reason) {
  const existing = draining.get(bridgeRequestId);
  if (existing !== undefined) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    if (draining.get(bridgeRequestId)?.timer !== timer) return;
    draining.delete(bridgeRequestId);
    recordDiagnostic("request_drain_expired", { method: entry.method, browserId: entry.target?.browserId, reason });
  }, DRAINING_TIMEOUT_MS);
  timer.unref?.();
  draining.set(bridgeRequestId, { client: entry.client, clientRequestId: entry.clientRequestId, extension: entry.extension, method: entry.method, params: entry.params, target: entry.target, timer, reason });
}

function clearDraining(bridgeRequestId, extension) {
  const entry = draining.get(bridgeRequestId);
  if (entry === undefined || entry.extension !== extension) return;
  clearTimeout(entry.timer);
  draining.delete(bridgeRequestId);
}
function cancelPendingEntry(bridgeRequestId, entry, reason) {
  cancelExtensionRequest(bridgeRequestId, entry);
  clearTimeout(entry.timer);
  pending.delete(bridgeRequestId);
  markDraining(bridgeRequestId, entry, reason);
}

function rejectMalformedExtensionResponse(bridgeRequestId, entry, code, message, reason) {
  clearTimeout(entry.timer);
  pending.delete(bridgeRequestId);
  const sideEffecting = isSideEffectingRequest(entry.method, entry.params);
  if (sideEffecting) {
    cancelExtensionRequest(bridgeRequestId, entry);
    markDraining(bridgeRequestId, entry, reason);
  }
  metrics.requestErrors += 1;
  sendPendingFailure(entry, code, message);
}

function sendError(client, id, code, message, details) {
  return send(client, { type: "response", id, error: { code, message, ...(details === undefined ? {} : { details }) } });
}

function broadcast(message) {
  for (const client of clients) send(client, message);
}

function handleMessage(client, message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "ping" && client.role === "extension") {
    send(client, { type: "pong" });
    return;
  }

  if (message.type === "cancel" && client.role === "pi") {
    const clientRequestId = nonEmptyString(message.id);
    if (!clientRequestId) return;
    for (const [bridgeRequestId, entry] of pending) {
      if (entry.client !== client || entry.clientRequestId !== clientRequestId) continue;
      cancelPendingEntry(bridgeRequestId, entry, "pi_request_canceled");
      recordDiagnostic("request_canceled", { method: entry.method, browserId: entry.target?.browserId, connectionId: entry.connectionId, connectionGeneration: entry.connectionGeneration });
      return;
    }
    return;
  }

  if (message.type === "request" && client.role === "pi") {
    metrics.requests += 1;
    const id = nonEmptyString(message.id);
    if (!id) {
      metrics.requestErrors += 1;
      sendError(client, `req-${++requestCounter}`, "INVALID_REQUEST_ID", "request.id must be a non-empty string.");
      return;
    }
    const drainingDuplicate = [...draining.values()].find((entry) => entry.clientRequestId === id);
    if (drainingDuplicate) {
      metrics.requestErrors += 1;
      const failure = pendingFailure(drainingDuplicate, "DUPLICATE_REQUEST_ID", "A request with this id is still draining after cancellation or a failed dispatch.");
      recordDiagnostic("request_rejected", { method: drainingDuplicate.method, errorCode: failure.code });
      sendError(client, id, failure.code, failure.message, failure.details);
      return;
    }
    const duplicate = [...pending.entries()].find(([, entry]) => entry.client === client && entry.clientRequestId === id);
    if (duplicate) {
      metrics.requestErrors += 1;
      const [bridgeRequestId, entry] = duplicate;
      cancelPendingEntry(bridgeRequestId, entry, "duplicate_request_id");
      const failure = pendingFailure(entry, "DUPLICATE_REQUEST_ID", "A request with this id is already pending on this client; the original request was canceled and may still be draining.");
      recordDiagnostic("request_rejected", { method: entry.method, errorCode: failure.code });
      sendError(client, id, failure.code, failure.message, failure.details);
      client.close(1008, "duplicate request id");
      return;
    }
    if (typeof message.method !== "string" || message.method.length === 0) {
      metrics.requestErrors += 1;
      sendError(client, id, "INVALID_REQUEST", "request.method must be a non-empty string.");
      return;
    }
    if (message.params !== undefined && (message.params === null || typeof message.params !== "object" || Array.isArray(message.params))) {
      metrics.requestErrors += 1;
      sendError(client, id, "INVALID_REQUEST", "request.params must be an object.");
      return;
    }
    const params = compactRequestParams(message.method, requestParams(message));
    if (params.responseMode !== undefined && (typeof params.responseMode !== "string" || !RESPONSE_MODES.has(params.responseMode))) {
      metrics.requestErrors += 1;
      sendError(client, id, "INVALID_REQUEST", "request.params.responseMode must be compact or raw.");
      return;
    }
    if (params.responseMode === "compact" && compactResponseToolName(message.method, params) === undefined) {
      metrics.requestErrors += 1;
      sendError(client, id, "INVALID_REQUEST", "request.params.responseMode=compact is only supported for bounded browser read responses.");
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
           observability: targetLeaseResponseObservability(),
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
    if (message.method === "target_lease") {
      handleTargetLease(client, id, message);
      return;
    }
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
    const negotiatedParams = negotiateCompactPageParams(message.method, params, extension);
    const missingCapabilities = missingExtensionCapabilities(message.method, negotiatedParams, extension);
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
    const leaseFailure = enforceTargetLease(client, message, target);
    if (leaseFailure !== undefined) {
      metrics.requestErrors += 1;
      recordDiagnostic("request_rejected", { method: message.method, errorCode: leaseFailure.code, browserId: target?.browserId });
      sendError(client, id, leaseFailure.code, leaseFailure.message, leaseFailure.details);
      return;
    }
    const entry = {
      client,
      clientRequestId: id,
      extension,
      method: message.method,
      params: negotiatedParams,
      target,
      connectionId: target?.connectionId,
      connectionGeneration: target?.connectionGeneration,
      timer: undefined,
    };
    pending.set(bridgeRequestId, entry);
    entry.timer = setTimeout(() => {
      if (pending.get(bridgeRequestId) !== entry) return;
      cancelPendingEntry(bridgeRequestId, entry, "request_timeout");
      metrics.requestTimeouts += 1;
      recordDiagnostic("request_timeout", {
        method: message.method,
        browserId: target?.browserId,
        connectionId: target?.connectionId,
        connectionGeneration: target?.connectionGeneration,
      });
      if (entry.client) {
         const failure = pendingFailure(entry, "TIMEOUT", `Browser request timed out: ${message.method || "unknown"}`);
         sendError(entry.client, entry.clientRequestId, failure.code, failure.message, failure.details);
       }
    }, routedRequestTimeoutMs(message.method, negotiatedParams));
    const forwarded = {
      type: "request",
      id: bridgeRequestId,
      method: message.method,
      params: extensionRequestParams(negotiatedParams),
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
        markDraining(bridgeRequestId, entry, "extension_send_failed");
      }
      metrics.requestErrors += 1;
      const failure = pendingFailure(entry, "EXTENSION_OFFLINE", "Chrome/Edge extension disconnected while dispatching the request.");
      sendError(client, id, failure.code, failure.message, failure.details);
    }
    return;
  }

  if (message.type === "hello" && client.role === "extension") {
    if (!setExtensionIdentity(client, message)) debug("extension hello did not contain a browser identity");
    return;
  }

  if (message.type === "response" && client.role === "extension") {
    const bridgeRequestId = String(message.id);
    const entry = pending.get(bridgeRequestId);
    if (!entry) {
      const drained = draining.get(bridgeRequestId);
      if (drained?.extension === client && isSideEffectingRequest(drained.method, drained.params)) {
        recordDiagnostic("late_response_ignored", { method: drained.method, browserId: drained.target?.browserId, reason: drained.reason });
        return;
      }
      clearDraining(bridgeRequestId, client);
      return;
    }
    if (entry.extension !== client || (entry.connectionId !== undefined && client.connectionId !== entry.connectionId) || (entry.connectionGeneration !== undefined && client.connectionGeneration !== entry.connectionGeneration)) return;
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = message.error !== undefined;
    if ((!hasResult && !hasError) || (hasResult && hasError)) {
      rejectMalformedExtensionResponse(
        bridgeRequestId,
        entry,
        "INVALID_BRIDGE_RESPONSE",
        "The extension returned a response without exactly one result or error.",
        "malformed_response_envelope",
      );
      return;
    }
    const responseIdentity = responseBrowserIdentity(message.result);
    if (entry.method === "status" && !setExtensionIdentity(client, message.result, bridgeRequestId)) debug("extension status did not contain a browser identity");
    if (entry.method === "status" && entry.target && responseIdentity.browserId !== undefined && responseIdentity.browserId !== entry.target.browserId) {
      rejectMalformedExtensionResponse(
        bridgeRequestId,
        entry,
        "TARGET_CONNECTION_CHANGED",
        `Browser target ${entry.target.browserId} changed while status was in flight.`,
        "target_rejection_delivery_failed",
      );
      recordDiagnostic("response_rejected", { method: entry.method, browserId: entry.target.browserId, responseBrowserId: responseIdentity.browserId, connectionId: entry.connectionId, connectionGeneration: entry.connectionGeneration });
      return;
    }
    if (entry.target && ((responseIdentity.present && responseIdentity.browserId === undefined) || (responseIdentity.browserId !== undefined && responseIdentity.browserId !== entry.target.browserId))) {
      recordDiagnostic("response_rejected", {
        method: entry.method,
        browserId: entry.target.browserId,
        ...(responseIdentity.browserId === undefined ? {} : { responseBrowserId: responseIdentity.browserId }),
        connectionId: entry.connectionId,
        connectionGeneration: entry.connectionGeneration,
      });
      rejectMalformedExtensionResponse(
        bridgeRequestId,
        entry,
        "INVALID_BROWSER_TARGET",
        responseIdentity.browserId === undefined
          ? "The extension response contained an invalid browserId."
          : `The extension response identified ${responseIdentity.browserId}, expected ${entry.target.browserId}.`,
        "target_rejection_delivery_failed",
      );
      return;
    }
    const errorPayload = message.error;
    const malformedError = errorPayload !== undefined && (errorPayload === null || typeof errorPayload !== "object" || Array.isArray(errorPayload) || typeof errorPayload.code !== "string" || typeof errorPayload.message !== "string");
    if (malformedError) {
      rejectMalformedExtensionResponse(
        bridgeRequestId,
        entry,
        "INVALID_BRIDGE_RESPONSE",
        "The extension returned a malformed error response.",
        "malformed_response_delivery_failed",
      );
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(bridgeRequestId);
    if (entry.client) {
      if (message.error) metrics.requestErrors += 1;
      const outbound = {
        ...message,
        id: entry.clientRequestId,
        ...(message.error ? {} : { result: responseForClient(entry, message.result) }),
      };
      let delivered = false;
      try {
        const serialized = JSON.stringify(outbound);
        if (entry.client.role === "pi") {
          const bytes = Buffer.byteLength(serialized, "utf8");
          metrics.modelResponses += 1;
          metrics.modelResponseBytes += bytes;
          if (entry.params.responseMode === "compact") {
            metrics.compactModelResponses += 1;
            metrics.compactModelResponseBytes += bytes;
          }
        }
        delivered = sendSerialized(entry.client, serialized);
      } catch {
        delivered = false;
      }
      if (!delivered && isSideEffectingRequest(entry.method, entry.params)) markDraining(bridgeRequestId, entry, "client_response_send_failed");
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
    ...(startupMarker === undefined ? {} : { startupMarker }),
    controlDomain: "local_user",
    capabilities: {
      ...BRIDGE_CAPABILITIES,
      multiTargetRouting: true,
      targetList: true,
      targetLeases: true,
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
      extensionCapabilityRevision: singleTarget.capabilityRevision,
      userAgent: singleTarget.userAgent,
      extensionCapabilities: singleTarget.capabilities,
      connectionId: singleTarget.connectionId,
      connectionGeneration: singleTarget.connectionGeneration,
    }),
    unidentifiedExtensionConnections: extensionConnections().filter(client => !client.browserIdentity).length,
    observability: {
      startedAt,
      ...observabilityDocument(targets, ready),
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
  const recovery = health.observability?.targetRecovery;
  if (recovery?.disconnectedTargets > 0) {
    notices.push({ code: "target_recovery_pending", message: `${recovery.disconnectedTargets} browser target(s) are disconnected; refresh browser_targets before retrying.` });
  }
  const leaseSummary = health.observability?.targetLeases;
  if (leaseSummary?.activeCount > 0) {
    notices.push({ code: "target_leases_active", message: `${leaseSummary.activeCount} browser target lease(s) are active; release or renew them explicitly before switching ownership.` });
  }
  if (health.observability?.metrics?.targetLeaseConflicts > 0) {
    notices.push({ code: "target_lease_conflicts", message: "Target lease conflicts have occurred; inspect target lease status before retrying multi-target operations." });
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
  const requestUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
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
  const requestUrl = new URL(request.url || "/ws", `http://127.0.0.1:${port}`);
  const suppliedToken = requestUrl.searchParams.get("token");
  const role = requestUrl.searchParams.get("role");
  if (suppliedToken !== token || (role !== "pi" && role !== "extension")) {
    client.close(1008, "invalid pairing");
    return;
  }

  client.role = role;
  client.acceptedSequence = ++connectionSequence;
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
    ...(startupMarker === undefined ? {} : { startupMarker }),
    controlDomain: "local_user",
    capabilities: {
      ...BRIDGE_CAPABILITIES,
      multiTargetRouting: true,
      targetList: true,
      targetLeases: true,
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
      clearTargetLeasesForClient(client, "pi_client_disconnected");
      detachPendingForClient(client);
      broadcast({ type: "event", event: "connection", role: "pi", connected: false });
    }
    if (client.role === "extension") {
      rejectPendingForExtension(client, "EXTENSION_OFFLINE", "Chrome/Edge extension disconnected.");
      const target = targetForClient(client);
      if (target) clearTargetLease(target.browserId, "target_disconnected");
      if (target) {
        metrics.targetDisconnects += 1;
        lastTargetDisconnectAt = Date.now();
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
  clearInterval(targetLeaseExpiryTimer);
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  for (const entry of draining.values()) clearTimeout(entry.timer);
  draining.clear();
  for (const client of clients) client.close(1012, "restarting");
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
