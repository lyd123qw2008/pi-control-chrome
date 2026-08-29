const BRIDGE_ORIGIN = "http://127.0.0.1:17318";
const BRIDGE_WS = "ws://127.0.0.1:17318/ws";
const OWNED_TABS_SCHEMA_VERSION = 3;
const OWNED_TABS_KEY = "piControlChromeOwnedTabs";
const PROFILE_ID_KEY = "piControlChromeProfileId";
const GROUP_TITLE = "Pi";
const GROUP_COLOR = "blue";
const GROUP_MARKERS_KEY = "piControlChromeGroupMarkers";
const DEBUGGER_LEASES_KEY = "piControlChromeDebuggerLeases";
const TAB_FENCES_KEY = "piControlChromeTabFences";
const MAX_EVENTS = 500;
const CREATION_RESERVATION_TTL_MS = 30_000;
const DOWNLOAD_CACHE_MAX = 200;
const DOWNLOAD_CACHE_RETENTION_MS = 15 * 60_000;
const EXTENSION_CAPABILITIES = Object.freeze({
  turnCleanup: true,
  turnScopedMarks: true,
  retainedCleanup: true,
  debuggerLeaseRecovery: true,
  targetQualifiedHandles: true,
  targetScopedState: true,
  semanticTargets: true,
  pageWaitStates: true,
  requestCancellation: true,
  snapshotRefs: true,
  domCuaSnapshots: true,
  tabIncarnationFence: true,
});

const RUNTIME_INSTANCE_ID = crypto.randomUUID();
const DEBUGGER_LEASE_IDLE_MS = 15_000;
const BRIDGE_HEARTBEAT_INTERVAL_MS = 20_000;

let socket;
let connecting;
let reconnectTimer;
let heartbeatTimer;
let heartbeatSocket;
let connectedAt;
let cachedToken;
let profileIdentity;
let profileIdentityInitialization;
let runtimeInstanceIdentity;
let runtimeIdentityInitialization;

const persistentDebuggers = new Map();
const debuggerAttachers = new Map();
const devtoolsState = new Map();
const debuggerAttachEpochs = new Map();
const orphanedDebuggerAttaches = new Map();
const pageSnapshotStates = new Map();
const domSnapshotStates = new Map();
const accessibilitySnapshotStates = new Map();
const tabFenceTokens = new Map();
const createdTabReservations = new Map();
const createdTabFlights = new Set();
const createdTabEvents = new Map();
const tabRemovalTombstones = new Map();
const tabRemovalIntents = new Map();
const retiredTabRemovalTombstones = new Map();
const piGroupIds = new Set();
let piGroupMarkersLoaded = false;
let piGroupMarkerMutationTail = Promise.resolve();
let debuggerLeasePersistenceTail = Promise.resolve();
let removalLifecycleSequence = 0;
let createdTabEventSequence = 0;
const crossSessionReadParams = new WeakSet();
const TAB_FENCE_SYMBOL = Symbol("piControlChromeTabFence");

const downloadState = new Map();
let downloadStateTail = Promise.resolve();
let bridgeRequestTail = Promise.resolve();
let tabFenceInitialization;
let tabFenceMutationTail = Promise.resolve();
let tabFencePersistenceFailure;
let tabFenceStateLoaded = false;
let ownedTabsMutationTail = Promise.resolve();
const tabWaitBarriers = new Map();
const downloadWaitBarriers = new Map();
const activeRequestControllers = new Map();
const activeRequestDetails = new Map();
let cleanupInFlight = Promise.resolve();

function sessionKey(sessionId) {
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : "default";
}

function enqueueDownloadStateUpdate(task) {
  const run = downloadStateTail.then(task, task);
  downloadStateTail = run.then(() => undefined, () => undefined);
  return run;
}

function isTerminalDownloadState(value) {
  return ["complete", "interrupted", "canceled", "cancelled", "removed"].includes(String(value || "").toLowerCase());
}

function pruneDownloadState() {
  const now = Date.now();
  const activeIds = new Set([...downloadWaitBarriers.values()].map((record) => Number(record.downloadId)));
  for (const [key, item] of downloadState) {
    if (!isTerminalDownloadState(item.state) || activeIds.has(Number(item.id))) continue;
    if (Number(item.lastSeenAt || 0) + DOWNLOAD_CACHE_RETENTION_MS <= now) downloadState.delete(key);
  }
  if (downloadState.size <= DOWNLOAD_CACHE_MAX) return;
  const removable = [...downloadState.entries()]
    .filter(([, item]) => isTerminalDownloadState(item.state) && !activeIds.has(Number(item.id)))
    .sort((left, right) => Number(left[1].lastSeenAt || 0) - Number(right[1].lastSeenAt || 0));
  for (const [key] of removable) {
    if (downloadState.size <= DOWNLOAD_CACHE_MAX) break;
    downloadState.delete(key);
  }
}


function abortActiveWaits(sessionId) {
  const expected = sessionKey(sessionId);
  for (const [id, details] of activeRequestDetails) {
    if (sessionKey(details.sessionId) !== expected) continue;
    const abortable = details.method === "wait"
      || (details.method === "download" && (details.params?.action === "wait" || (details.params?.action === "start" && details.params?.wait !== false)))
      || (details.method === "new_tab" && details.params?.wait === true)
      || (details.method === "navigate" && details.params?.wait !== false)
      || (details.method === "locator" && details.params?.action === "waitFor");
    if (!abortable) continue;
    activeRequestControllers.get(id)?.abort(new Error("Browser wait aborted by lifecycle cleanup"));
  }
}
function abortActiveRequestsForSocket(target, reason) {
  for (const [id, details] of activeRequestDetails) {
    if (details.socket !== target) continue;
    activeRequestControllers.get(id)?.abort(new Error(reason));
    activeRequestControllers.delete(id);
    activeRequestDetails.delete(id);
  }
}
let ownedTabsMigration;
let ownedTabsMigrationComplete = false;

function log(...args) {
  if (globalThis.PI_CONTROL_CHROME_DEBUG) console.debug("[pi-control-chrome]", ...args);
}

function boundedTimeout(value, fallback, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error("timeoutMs must be a positive finite number");
  return Math.min(parsed, maximum);
}

function validateWaitParams(params = {}) {
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
  return state;
}

function validateLocatorParams(params = {}) {
  if (params.target === undefined) return;
  if (["strategy", "selector", "exact", "name", "index", "hasText", "hasSelector"].some((key) => params[key] !== undefined)) throw new Error("locator target cannot be combined with legacy locator fields");
}

function boundedPush(list, value) {
  list.push(value);
  if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
}

function boundedEventCollection(entries, maxChars = 20_000, maxItems = 200) {
  const items = [];
  let charCount = 2;
  let truncated = false;
  for (const entry of entries) {
    const serialized = JSON.stringify(entry);
    const cost = (typeof serialized === "string" ? serialized : String(entry)).length + (items.length > 0 ? 1 : 0);
    if (items.length >= maxItems || charCount + cost > maxChars) {
      truncated = true;
      break;
    }
    items.push(entry);
    charCount += cost;
  }
  return { items, charCount, truncated, maxChars, maxItems };
}

function runtimeStateKey(tabId) {
  return `${chrome.runtime.id}::${Number(tabId)}`;
}

function downloadStateKey(downloadId, browserId = browserIdentity().browserId) {
  return `${browserId}::download::${Number(downloadId)}`;
}

function debuggerAttachEpoch(tabId) {
  return debuggerAttachEpochs.get(runtimeStateKey(tabId)) || 0;
}

function invalidateDebuggerAttach(tabId) {
  const key = runtimeStateKey(tabId);
  const epoch = (debuggerAttachEpochs.get(key) || 0) + 1;
  debuggerAttachEpochs.set(key, epoch);
  return epoch;
}

function stateForTab(tabId) {
  const key = runtimeStateKey(tabId);
  let state = devtoolsState.get(key);
  if (!state) {
    state = {
      console: [],
      network: [],
      lifecycle: [],
      requestLoaders: new Map(),
      dialog: undefined,
      dialogSequence: 0,
      fileChooser: undefined,
      documentEpoch: 0,
      mainFrameId: undefined,
      frameLoaders: new Map(),
      activeLoaderIds: new Set(),
      retiredLoaderIds: new Set(),
      acceptUnqualifiedEvents: false,
    };
    devtoolsState.set(key, state);
  }
  return state;
}

function boundedEventText(value, limit = 4096) {
  const text = typeof value === "string" ? value : (() => {
    try { return JSON.stringify(value) ?? ""; } catch { return String(value ?? ""); }
  })();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

const SENSITIVE_EVENT_FIELD = /(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|credential)/i;
const EVALUATE_OUTPUT_LIMITS = Object.freeze({ depth: 8, arrayItems: 2_000, objectFields: 200, stringChars: 200_000 });

function boundEvaluateValue(value, state, depth = 0, ancestors = new WeakSet()) {
  if (typeof value === "string") {
    if (value.length <= EVALUATE_OUTPUT_LIMITS.stringChars) return value;
    state.truncated = true;
    return `${value.slice(0, EVALUATE_OUTPUT_LIMITS.stringChars - 3)}...`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= EVALUATE_OUTPUT_LIMITS.depth) {
    state.truncated = true;
    return "[Max depth reached]";
  }
  if (ancestors.has(value)) {
    state.truncated = true;
    return "[Circular]";
  }
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.slice(0, EVALUATE_OUTPUT_LIMITS.arrayItems).map((entry) => boundEvaluateValue(entry, state, depth + 1, ancestors));
    if (value.length > EVALUATE_OUTPUT_LIMITS.arrayItems) {
      state.truncated = true;
      result.push(`[${value.length - EVALUATE_OUTPUT_LIMITS.arrayItems} more items omitted]`);
    }
  } else {
    result = {};
    const entries = Object.entries(value);
    for (const [key, entry] of entries.slice(0, EVALUATE_OUTPUT_LIMITS.objectFields)) result[key] = boundEvaluateValue(entry, state, depth + 1, ancestors);
    if (entries.length > EVALUATE_OUTPUT_LIMITS.objectFields) {
      state.truncated = true;
      result.__piControlChromeTruncatedFields = `${entries.length - EVALUATE_OUTPUT_LIMITS.objectFields} fields omitted`;
    }
  }
  ancestors.delete(value);
  return result;
}

function boundEvaluateResult(value) {
  const state = { truncated: false };
  const bounded = boundEvaluateValue(value, state);
  if (!state.truncated || !bounded || typeof bounded !== "object" || Array.isArray(bounded)) return bounded;
  return { ...bounded, outputTruncated: true, outputLimits: { ...EVALUATE_OUTPUT_LIMITS } };
}

function redactEventText(value, limit = 2048) {
  const text = boundedEventText(value, limit);
  return text.replace(/(["']?(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|credential)["']?\s*[:=]\s*)(["'][^"']*["']|[^,;&\s}]+)/gi, "$1[redacted]");
}

function boundedEventHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
  return Object.fromEntries(Object.entries(headers).slice(0, 64).map(([key, value]) => [boundedEventText(key, 256), SENSITIVE_EVENT_FIELD.test(key) ? "[redacted]" : redactEventText(value, 1024)]));
}

function boundedEventArgs(args) {
  return (Array.isArray(args) ? args : []).slice(0, 20).map((value) => redactEventText(remoteValue(value), 2048));
}

function remoteValue(value) {
  if (!value) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, "value")) return value.value;
  return value.unserializableValue ?? value.description ?? value.type;
}

function formatConsoleEvent(method, params) {
  if (method === "Runtime.consoleAPICalled") {
    return {
      type: "console",
      level: params.type,
      text: boundedEventText(boundedEventArgs(params.args).join(" ")),
      args: boundedEventArgs(params.args),
      url: redactEventText(params.stackTrace?.callFrames?.[0]?.url, 2048),
      line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      timestamp: params.timestamp,
    };
  }
  if (method === "Log.entryAdded") {
    const entry = params.entry || {};
    return {
      type: "log",
      level: entry.level,
      text: redactEventText(entry.text, 4096),
      url: redactEventText(entry.url, 2048),
      line: entry.lineNumber,
      source: entry.source,
      timestamp: entry.timestamp,
    };
  }
  return undefined;
}

function boundedNetworkResponseBody(result) {
  if (!result || typeof result !== "object") return { body: redactEventText(result, 32768), base64Encoded: false };
  return {
    body: redactEventText(result.body, 32768),
    base64Encoded: result.base64Encoded === true,
  };
}


function formatNetworkEvent(method, params) {
  if (method === "Network.requestWillBeSent") {
    return {
      event: "request",
      requestId: params.requestId,
      loaderId: params.loaderId,
      url: redactEventText(params.request?.url, 4096),
      method: boundedEventText(params.request?.method, 32),
      headers: boundedEventHeaders(params.request?.headers),
      postData: redactEventText(params.request?.postData, 8192),
      type: params.type,
      timestamp: params.timestamp,
      wallTime: params.wallTime,
    };
  }
  if (method === "Network.responseReceived") {
    return {
      event: "response",
      requestId: params.requestId,
      loaderId: params.loaderId,
      url: redactEventText(params.response?.url, 4096),
      status: params.response?.status,
      statusText: params.response?.statusText,
      mimeType: params.response?.mimeType,
      headers: boundedEventHeaders(params.response?.headers),
      type: params.type,
      timestamp: params.timestamp,
    };
  }
  if (method === "Network.loadingFinished") {
    return { event: "finished", requestId: params.requestId, loaderId: params.loaderId, encodedDataLength: params.encodedDataLength, timestamp: Date.now() };
  }
  if (method === "Network.loadingFailed") {
    return { event: "failed", requestId: params.requestId, loaderId: params.loaderId, errorText: boundedEventText(params.errorText), canceled: params.canceled, timestamp: Date.now() };
  }
  return undefined;
}

function debuggerLoaderId(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resetDebuggerDocumentState(state, mainFrameId) {
  const previousLoaders = [...state.activeLoaderIds];
  for (const loaderId of previousLoaders) state.retiredLoaderIds.add(loaderId);
  while (state.retiredLoaderIds.size > 128) state.retiredLoaderIds.delete(state.retiredLoaderIds.values().next().value);
  state.console.length = 0;
  state.network.length = 0;
  state.lifecycle.length = 0;
  state.requestLoaders.clear();
  state.dialog = undefined;
  state.dialogSequence = Number(state.dialogSequence || 0) + 1;
  state.fileChooser = undefined;
  state.documentEpoch = Number(state.documentEpoch || 0) + 1;
  state.mainFrameId = mainFrameId;
  state.frameLoaders.clear();
  state.activeLoaderIds.clear();
  state.acceptUnqualifiedEvents = false;
}

function setDebuggerFrameLoader(state, frameId, loaderId) {
  if (typeof frameId !== "string" || frameId.length === 0) return;
  const previous = state.frameLoaders.get(frameId);
  if (previous && previous !== loaderId) {
    state.activeLoaderIds.delete(previous);
    state.retiredLoaderIds.add(previous);
    while (state.retiredLoaderIds.size > 128) state.retiredLoaderIds.delete(state.retiredLoaderIds.values().next().value);
    for (const [requestId, request] of state.requestLoaders) if (request.loaderId === previous) state.requestLoaders.delete(requestId);
  }
  if (typeof loaderId === "string") {
    state.frameLoaders.set(frameId, loaderId);
    state.activeLoaderIds.add(loaderId);
  } else {
    state.frameLoaders.delete(frameId);
  }
}

function isTopLevelDebuggerFrame(state, frameId, frame) {
  if (frame && Object.prototype.hasOwnProperty.call(frame, "parentId")) return frame.parentId === undefined || frame.parentId === null || frame.parentId === "";
  if (typeof frameId === "string" && typeof state.mainFrameId === "string") return frameId === state.mainFrameId;
  return state.mainFrameId === undefined;
}

chrome.debugger?.onEvent?.addListener((source, method, params = {}) => {
  const tabId = source?.tabId;
  if (tabId === undefined) return;
  const key = runtimeStateKey(tabId);
  const debuggerRecord = persistentDebuggers.get(key);
  if (!debuggerRecord || debuggerRecord.tabFence !== tabFenceTokens.get(key) || !debuggerSourceMatches(debuggerRecord, source)) return;
  const state = stateForTab(tabId);
  const frame = params.frame && typeof params.frame === "object" ? params.frame : undefined;
  const frameId = typeof params.frameId === "string" ? params.frameId : typeof frame?.id === "string" ? frame.id : undefined;
  const loaderId = debuggerLoaderId(params.loaderId ?? frame?.loaderId);
  if (method === "Page.frameStartedLoading") {
    if (!isTopLevelDebuggerFrame(state, frameId, undefined)) return;
    if (state.documentEpoch === 0 && state.mainFrameId === undefined && frameId) state.mainFrameId = frameId;
    return;
  }
  if (method === "Page.frameNavigated") {
    const topLevel = isTopLevelDebuggerFrame(state, frameId, frame);
    if (typeof loaderId === "string" && state.retiredLoaderIds.has(loaderId)) return;
    const knownLoader = typeof frameId === "string" ? state.frameLoaders.get(frameId) : undefined;
    if (typeof loaderId !== "string") {
      if (topLevel) resetDebuggerDocumentState(state, frameId);
      else setDebuggerFrameLoader(state, frameId, undefined);
      return;
    }
    if (knownLoader === loaderId) return;
    if (topLevel) {
      resetDebuggerDocumentState(state, frameId);
      setDebuggerFrameLoader(state, frameId, loaderId);
    } else setDebuggerFrameLoader(state, frameId, loaderId);
    return;
  }
  if (method === "Page.lifecycleEvent") {
    const lifecycleName = String(params.name || "");
    const topLevel = isTopLevelDebuggerFrame(state, frameId, undefined);
    if (typeof loaderId !== "string") return;
    if (state.retiredLoaderIds.has(loaderId)) return;
    const knownLoader = typeof frameId === "string" ? state.frameLoaders.get(frameId) : undefined;
    if (topLevel && state.mainFrameId === undefined && frameId) state.mainFrameId = frameId;
    if (knownLoader !== undefined && knownLoader !== loaderId) {
      if (lifecycleName !== "init") return;
      if (topLevel) resetDebuggerDocumentState(state, frameId);
    }
    setDebuggerFrameLoader(state, frameId, loaderId);
    if (!state.activeLoaderIds.has(loaderId)) return;
    state.acceptUnqualifiedEvents = lifecycleName !== "init" && state.documentEpoch === 0;
    boundedPush(state.lifecycle, {
      name: params.name,
      frameId: boundedEventText(params.frameId, 128),
      loaderId: boundedEventText(params.loaderId, 256),
      url: redactEventText(params.url, 4096),
      timestamp: params.timestamp,
    });
    return;
  }
  const networkEvent = formatNetworkEvent(method, params);
  if (networkEvent) {
    const requestId = networkEvent.requestId === undefined ? undefined : String(networkEvent.requestId);
    const knownRequest = requestId === undefined ? undefined : state.requestLoaders.get(requestId);
    const eventLoaderId = debuggerLoaderId(networkEvent.loaderId) ?? knownRequest?.loaderId;
    if (typeof eventLoaderId !== "string" || !state.activeLoaderIds.has(eventLoaderId)) return;
    networkEvent.loaderId = eventLoaderId;
    if (networkEvent.event === "request" && requestId !== undefined) {
      if (state.requestLoaders.size >= MAX_EVENTS) state.requestLoaders.delete(state.requestLoaders.keys().next().value);
      state.requestLoaders.set(requestId, { loaderId: eventLoaderId });
      if (state.documentEpoch === 0) state.acceptUnqualifiedEvents = true;
    }
    boundedPush(state.network, networkEvent);
    return;
  }
  const consoleEvent = formatConsoleEvent(method, params);
  if (consoleEvent && state.acceptUnqualifiedEvents) boundedPush(state.console, consoleEvent);
  if (method === "Page.javascriptDialogClosed") {
    if (state.acceptUnqualifiedEvents) {
      state.dialog = undefined;
      state.dialogSequence = Number(state.dialogSequence || 0) + 1;
    }
    return;
  }
  if (method === "Page.javascriptDialogOpening") {
    if (!state.acceptUnqualifiedEvents) return;
    state.dialogSequence = Number(state.dialogSequence || 0) + 1;
    state.dialog = {
      type: params.type,
      message: redactEventText(params.message, 4096),
      defaultPrompt: redactEventText(params.defaultPrompt, 2048),
      url: redactEventText(params.url, 4096),
      hasBrowserHandler: params.hasBrowserHandler,
    };
    return;
  }
  if (method === "Page.fileChooserOpened") {
    if (!state.acceptUnqualifiedEvents) return;
    const chooser = {
      mode: boundedEventText(params.mode, 64),
      backendNodeId: Number.isFinite(params.backendNodeId) ? params.backendNodeId : undefined,
      timestamp: Date.now(),
    };
    state.fileChooser = chooser;
    const fence = debuggerRecord.tabFence;
    if (typeof fence === "string") {
      void readTabIncarnation(Number(tabId), fence).then((incarnation) => {
        if (state.fileChooser === chooser && typeof incarnation === "string") chooser.incarnation = incarnation;
      }).catch(() => {});
    }
  }
});

chrome.debugger?.onDetach?.addListener((source, reason) => {
  if (source?.tabId === undefined) return;
  const id = Number(source.tabId);
  const key = runtimeStateKey(id);
  const record = persistentDebuggers.get(key);
  const pending = debuggerAttachers.get(key);
  if (!record && pending) {
    if (pending.epoch === debuggerAttachEpoch(id)) invalidateDebuggerAttach(id);
    return;
  }
  if (!record || record.detaching || !debuggerSourceMatches(record, source)) return;
  void (async () => {
    try {
      const attached = await debuggerTargetAttached(id);
      if (attached !== false) {
        if (persistentDebuggers.get(key) === record) {
          record.detachPending = true;
          scheduleDebuggerDetachRetry(id, record.sessionId, record);
        }
        return;
      }
      const currentFence = await tabFenceFor(id);
      const currentRecord = persistentDebuggers.get(key);
      if (currentRecord !== record || currentRecord.tabFence !== currentFence) return;
      if (record.releaseTimer !== undefined) clearTimeout(record.releaseTimer);
      invalidateDebuggerAttach(id);
      persistentDebuggers.delete(key);
      devtoolsState.delete(key);
      void removePersistedDebuggerLease(record).catch((error) => log("could not clear persisted debugger lease after external detach", error));
      log(`debugger detached for tab ${source.tabId}`, reason);
    } catch (error) {
      if (persistentDebuggers.get(key) === record) {
        record.detachPending = true;
        scheduleDebuggerDetachRetry(id, record.sessionId, record);
      }
      throw error;
    }
  })().catch((error) => log(`could not process debugger detach for tab ${source.tabId}`, error));
});

chrome.tabs?.onUpdated?.addListener((tabId, changeInfo = {}) => {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id < 0) return;
  const key = runtimeStateKey(id);
  // Any tab update can invalidate refs; URL/loading changes also reset debugger data tied to the old document.
  pageSnapshotStates.delete(key);
  domSnapshotStates.delete(key);
  accessibilitySnapshotStates.delete(key);
  if (changeInfo.url !== undefined || changeInfo.status === "loading") {
    const state = devtoolsState.get(key) || (persistentDebuggers.has(key) ? stateForTab(id) : undefined);
    if (state) resetDebuggerDocumentState(state, state.mainFrameId);
  }
});

chrome.tabs?.onCreated?.addListener((tab) => {
  if (tab?.id === undefined) return;
  const eventSequence = ++createdTabEventSequence;
  const eventObservedAt = Date.now();
  const removalIntent = tabRemovalIntents.get(runtimeStateKey(Number(tab.id)));
  if (removalIntent) removalIntent.replacementObserved = true;
  void (async () => {
    await ensureTabFenceState();
    const id = Number(tab.id);
    const key = runtimeStateKey(id);
    let currentTab;
    try {
      currentTab = await chrome.tabs.get(id);
    } catch (error) {
      if (isMissingTabError(error)) return;
      throw error;
    }
    if (Number(currentTab.id) !== id || Number(currentTab.windowId) !== Number(tab.windowId)) return;
    let reservation = createdTabReservations.get(key);
    if (!reservation || reservation.active !== true || reservation.expiresAt < Date.now() || !creationMarkerMatches(currentTab, reservation)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      reservation = createdTabReservations.get(key);
      const completedMarker = createdTabEvents.get(key);
      const retryFlights = activeCreationFlightsFor(currentTab);
      if (retryFlights.length > 0 && reservation?.active !== true && reservation?.completedHold !== true) return;
      if (reservation?.completedHold === true && creationMarkerMatches(currentTab, reservation)) {
        const currentFence = tabFenceTokens.get(key);
        if (currentFence === reservation.fence) {
          reservation.eventObserved = true;
          deactivateCreatedTabReservation(key, reservation, true);
          return;
        }
        deactivateCreatedTabReservation(key, reservation, true);
      }
      if (!reservation && completedMarker?.completed === true && creationMarkerMatches(currentTab, completedMarker)) return;
      if (reservation?.rollback === true || (reservation && eventSequence <= Number(reservation.createdAfterSequence || 0))) return;
      if (!reservation || reservation.active !== true || reservation.expiresAt < Date.now() || eventSequence <= Number(reservation.createdAfterSequence || 0) || !creationMarkerMatches(currentTab, reservation)) {
        await reconcileUnreservedCreatedTab(currentTab, eventObservedAt);
        return;
      }
    }
    if (reservation?.active === true) {
      const matchingFlights = activeCreationFlightsFor(currentTab);
      if (reservation.flight === undefined || matchingFlights.length !== 1 || matchingFlights[0] !== reservation.flight) {
        log(`created tab ${id} could not prove its create-flight identity; retaining lifecycle state for review`);
        return;
      }
    }
    const existingTombstone = tabRemovalTombstones.get(key);
    if (existingTombstone?.replaced) return;
    if (existingTombstone) {
      existingTombstone.tabId = id;
      existingTombstone.superseded = true;
      existingTombstone.retiredAt = existingTombstone.retiredAt ?? Date.now();
      const retiredKey = `${key}:${++removalLifecycleSequence}`;
      existingTombstone.retiredKey = retiredKey;
      retiredTabRemovalTombstones.set(retiredKey, existingTombstone);
      if (existingTombstone.retryTimer !== undefined) clearTimeout(existingTombstone.retryTimer);
      if (existingTombstone.replacementTransferTimer !== undefined) clearTimeout(existingTombstone.replacementTransferTimer);
      tabRemovalTombstones.delete(key);
      scheduleRetiredTabFinalization(id, existingTombstone, existingTombstone.observedFence ?? tabFenceTokens.get(key));
    }
    const fence = reservation.fence;
    if (typeof fence !== "string") return;
    if (!prepareCreatedTabRuntimeState(id, fence)) return;
    rememberCreatedTabEvent(currentTab, fence, reservation.completed === true);
    reservation.eventObserved = true;
  })().catch((error) => log(`could not process created tab ${tab.id}`, error));
});
chrome.tabs?.onRemoved?.addListener((tabId) => {
  const id = Number(tabId);
  const key = runtimeStateKey(id);
  const removalIntent = tabRemovalIntents.get(key);
  if (removalIntent) removalIntent.removalObserved = true;
  const previous = tabRemovalTombstones.get(key);
  if (previous?.replaced) {
    previous.tabId = id;
    previous.removalObserved = true;
    if (Number.isInteger(Number(previous.addedTabId)) && previous.replacementTransferTimer === undefined && previous.replacementTransferInFlight !== true) {
      scheduleReplacedTabTransfer(Number(previous.addedTabId), id, previous, previous.observedFence ?? tabFenceTokens.get(key));
    }
    return;
  }
  if (previous) {
    previous.tabId = id;
    if (previous.retryTimer !== undefined) clearTimeout(previous.retryTimer);
    if (previous.replacementTransferTimer !== undefined) clearTimeout(previous.replacementTransferTimer);
    previous.retiredAt = previous.retiredAt ?? Date.now();
    const retiredKey = `${key}:${++removalLifecycleSequence}`;
    previous.retiredKey = retiredKey;
    retiredTabRemovalTombstones.set(retiredKey, previous);
    scheduleRetiredTabFinalization(id, previous, previous.observedFence ?? tabFenceTokens.get(key));
  }
  const tombstone = { tabId: id, superseded: false, replaced: false, observedFence: tabFenceTokens.get(key), removedAt: Date.now() };
  tabRemovalTombstones.set(key, tombstone);
  deactivateCreatedTabReservation(key, createdTabReservations.get(key), true);
  createdTabEvents.delete(key);
  pageSnapshotStates.delete(key);
  domSnapshotStates.delete(key);
  accessibilitySnapshotStates.delete(key);
  void (async () => {
    await ensureTabFenceState();
    if (tabRemovalTombstones.get(key) !== tombstone) return;
    try {
      await chrome.tabs.get(id);
      scheduleRemovedTabFinalization(id, tombstone, tombstone.observedFence ?? tabFenceTokens.get(key));
      return;
    } catch (error) {
      if (!isMissingTabError(error)) {
        log(`could not confirm removal of tab ${id}`, error);
        scheduleRemovedTabFinalization(id, tombstone, tombstone.observedFence ?? tabFenceTokens.get(key));
        return;
      }
    }
    if (tabRemovalTombstones.get(key) !== tombstone || tombstone.superseded || tombstone.replaced) return;
    const previousOrphan = orphanedDebuggerAttaches.get(key);
    const record = persistentDebuggers.get(key);
    const attachEpoch = invalidateDebuggerAttach(id);
    if (record?.releaseTimer !== undefined) clearTimeout(record.releaseTimer);
    persistentDebuggers.delete(key);
    if (record) orphanedDebuggerAttaches.set(key, { ...record, epoch: attachEpoch, pendingProbe: true, orphanedAt: Date.now() });
    else if (previousOrphan) orphanedDebuggerAttaches.set(key, { ...previousOrphan, epoch: attachEpoch, pendingProbe: true, orphanedAt: Date.now() });
    devtoolsState.delete(key);
    const attachedInfo = await debuggerTargetInfo(id);
    if (attachedInfo?.attached === false) {
      const orphan = orphanedDebuggerAttaches.get(key);
      orphanedDebuggerAttaches.delete(key);
      await removePersistedDebuggerLease(orphan || record).catch((error) => log("could not clear persisted debugger lease after tab removal", error));
    } else {
      tombstone.recoveryPending = true;
      tombstone.finalizationError = "The removed tab still has an unverified debugger target; explicit recovery is required";
    }
    const observedFence = tombstone.observedFence ?? tabFenceTokens.get(key);
    if (typeof observedFence !== "string") {
      const owned = await ownedTabs();
      const current = owned[targetStateKey(id)];
      if (!current) {
        tabRemovalTombstones.delete(key);
        return;
      }
      if (typeof current.tabFence === "string") {
        tombstone.observedFence = current.tabFence;
        const finalized = await finalizeRemovedTab(id, tombstone, current.tabFence);
        if (!finalized) scheduleRemovedTabFinalization(id, tombstone, current.tabFence);
      } else {
        tombstone.recoveryPending = true;
        tombstone.finalizationError = `Removed tab ${id} has ownership without a prior tab fence`;
      }
      return;
    }
    const finalized = await finalizeRemovedTab(id, tombstone, observedFence);
    if (!finalized) scheduleRemovedTabFinalization(id, tombstone, observedFence);
  })().catch((error) => {
    tombstone.finalizationError = error instanceof Error ? error.message : String(error);
    const expectedFence = tombstone.observedFence ?? tabFenceTokens.get(key);
    if (typeof expectedFence === "string") scheduleRemovedTabFinalization(id, tombstone, expectedFence);
    log("could not finish closed tab cleanup", error);
  });
});
function scheduleReplacedTabTransfer(addedTabId, removedTabId, tombstone, expectedFence) {
  if (tombstone.replacementTransferTimer !== undefined || tombstone.replacementTransferCount >= 5) {
    if (tombstone.replacementTransferCount >= 5) {
      tombstone.replaced = true;
      tombstone.replacementRetryCount = 0;
      scheduleRemovedTabFinalization(removedTabId, tombstone, expectedFence);
    }
    return;
  }
  tombstone.replacementTransferCount = (tombstone.replacementTransferCount || 0) + 1;
  const delay = Math.min(30_000, 1_000 * 2 ** (tombstone.replacementTransferCount - 1));
  tombstone.replacementTransferTimer = setTimeout(async () => {
    tombstone.replacementTransferTimer = undefined;
    if (tabRemovalTombstones.get(runtimeStateKey(removedTabId)) !== tombstone) return;
    try {
      await ensureTabFenceState();
      const fence = expectedFence ?? tombstone.observedFence ?? tabFenceTokens.get(runtimeStateKey(removedTabId));
      if (typeof fence !== "string") throw new Error(`Replacement for tab ${removedTabId} has no prior tab fence`);
      try {
        await chrome.tabs.get(Number(removedTabId));
        scheduleReplacedTabTransfer(addedTabId, removedTabId, tombstone, fence);
        return;
      } catch (error) {
        if (!isMissingTabError(error)) throw error;
      }
      if (typeof tombstone.addedFence !== "string") throw new Error(`Replacement for tab ${removedTabId} has no captured added-tab fence`);
      if (tombstone.addedIdentityCaptured !== true) {
        const captured = await captureReplacementIdentity(addedTabId, tombstone);
        if (!captured) {
          tombstone.finalizationError = `Replacement for tab ${addedTabId} is not currently identity-verifiable`;
          scheduleReplacedTabTransfer(addedTabId, removedTabId, tombstone, fence);
          return;
        }
      } else if (!(await captureReplacementIdentity(addedTabId, tombstone))) {
        tombstone.recoveryPending = true;
        tombstone.finalizationError = `Replacement for tab ${addedTabId} changed or cannot be identity-verified`;
        scheduleReplacedTabTransfer(addedTabId, removedTabId, tombstone, fence);
        return;
      }
      const transferred = await transferReplacedTabOwnership(addedTabId, removedTabId, fence, tombstone);
      if (transferred) {
        tombstone.replaced = true;
        tombstone.replacementRetryCount = 0;
        const finalized = await finalizeReplacedTabOwnership(removedTabId, tombstone, fence);
        if (!finalized) scheduleRemovedTabFinalization(removedTabId, tombstone, fence);
        return;
      }
      if (tombstone.transferResolved === true) {
        tombstone.replaced = true;
        tombstone.replacementRetryCount = 0;
        scheduleRemovedTabFinalization(removedTabId, tombstone, fence);
      } else {
        tombstone.recoveryPending = true;
        tombstone.finalizationError = tombstone.finalizationError || `Replacement for tab ${addedTabId} could not be identity-verified; ownership was retained`;
        scheduleReplacedTabTransfer(addedTabId, removedTabId, tombstone, fence);
      }
    } catch (error) {
      tombstone.finalizationError = error instanceof Error ? error.message : String(error);
      scheduleReplacedTabTransfer(addedTabId, removedTabId, tombstone, expectedFence);
    }
  }, delay);
  tombstone.replacementTransferTimer.unref?.();
}

chrome.tabs?.onReplaced?.addListener((addedTabId, removedTabId) => {
  const addedId = Number(addedTabId);
  const removedId = Number(removedTabId);
  if (!Number.isInteger(addedId) || !Number.isInteger(removedId)) return;
  const removedKey = runtimeStateKey(removedId);
  const existingTombstone = tabRemovalTombstones.get(removedKey);
  if (existingTombstone?.replaced && Number(existingTombstone.addedTabId) === addedId) return;
  if (existingTombstone?.superseded && !existingTombstone.replaced) return;
  const tombstone = existingTombstone ?? { superseded: false, observedFence: tabFenceTokens.get(removedKey) };
  if (existingTombstone === undefined) tabRemovalTombstones.set(removedKey, tombstone);
  else if (tombstone.observedFence === undefined) tombstone.observedFence = tabFenceTokens.get(removedKey);
  tombstone.superseded = false;
  tombstone.replaced = true;
  tombstone.tabId = removedId;
  tombstone.addedTabId = addedId;
  deactivateCreatedTabReservation(removedKey, createdTabReservations.get(removedKey), true);
  createdTabEvents.delete(removedKey);
  pageSnapshotStates.delete(removedKey);
  domSnapshotStates.delete(removedKey);
  devtoolsState.delete(removedKey);
  const removedDebugger = persistentDebuggers.get(removedKey);
  const removedOrphan = orphanedDebuggerAttaches.get(removedKey);
  const removedAttachEpoch = invalidateDebuggerAttach(removedId);
  if (removedDebugger?.releaseTimer !== undefined) clearTimeout(removedDebugger.releaseTimer);
  persistentDebuggers.delete(removedKey);
  if (removedDebugger) orphanedDebuggerAttaches.set(removedKey, { ...removedDebugger, epoch: removedAttachEpoch, pendingProbe: true, orphanedAt: Date.now() });
  else if (removedOrphan) orphanedDebuggerAttaches.set(removedKey, { ...removedOrphan, epoch: removedAttachEpoch, pendingProbe: true, orphanedAt: Date.now() });
  const addedKey = runtimeStateKey(addedId);
  const addedReservation = createdTabReservations.get(addedKey);
  tombstone.replacementEpoch = Number(tombstone.replacementEpoch || 0) + 1;
  tombstone.replacementTransferInFlight = true;
  pageSnapshotStates.delete(addedKey);
  domSnapshotStates.delete(addedKey);
  devtoolsState.delete(addedKey);
  const addedDebugger = persistentDebuggers.get(addedKey);
  if (addedDebugger?.releaseTimer !== undefined) clearTimeout(addedDebugger.releaseTimer);
  persistentDebuggers.delete(addedKey);
  const addedAttachEpoch = invalidateDebuggerAttach(addedId);
  if (addedDebugger) orphanedDebuggerAttaches.set(addedKey, { ...addedDebugger, epoch: addedAttachEpoch, pendingProbe: true, orphanedAt: Date.now() });
  if (addedReservation?.active === true && addedReservation.expiresAt >= Date.now() && typeof addedReservation.fence === "string") tombstone.addedFence = addedReservation.fence;
  else tombstone.addedFence = rotateTabFence(addedId);
  void (async () => {
    await ensureTabFenceState();
    if (tabRemovalTombstones.get(removedKey) !== tombstone) return;
    const expectedFence = tombstone.observedFence ?? tabFenceTokens.get(removedKey);
    if (typeof expectedFence !== "string") {
      tombstone.finalizationError = `Replacement for tab ${removedId} has no prior tab fence`;
      scheduleReplacedTabTransfer(addedId, removedId, tombstone, expectedFence);
      return;
    }
    try {
      const captured = await captureReplacementIdentity(addedId, tombstone);
      if (!captured) {
        tombstone.finalizationError = tombstone.addedIdentityCaptured === true
          ? `Replacement for tab ${addedId} could not be identity-verified`
          : `Replacement for tab ${addedId} is not currently available`;
        scheduleReplacedTabTransfer(addedId, removedId, tombstone, expectedFence);
        return;
      }
      try {
        await chrome.tabs.get(removedId);
        scheduleReplacedTabTransfer(addedId, removedId, tombstone, expectedFence);
        return;
      } catch (error) {
        if (!isMissingTabError(error)) throw error;
      }
      const transferred = await transferReplacedTabOwnership(addedId, removedId, expectedFence, tombstone);
      if (transferred) {
        tombstone.replaced = true;
        tombstone.replacementRetryCount = 0;
        const finalized = await finalizeReplacedTabOwnership(removedId, tombstone, expectedFence);
        if (!finalized) scheduleRemovedTabFinalization(removedId, tombstone, expectedFence);
        return;
      }
      if (tombstone.transferResolved === true) {
        tombstone.replaced = true;
        tombstone.replacementRetryCount = 0;
        scheduleRemovedTabFinalization(removedId, tombstone, expectedFence);
      } else {
        tombstone.recoveryPending = true;
        tombstone.finalizationError = tombstone.finalizationError || `Replacement for tab ${addedId} could not be identity-verified; ownership was retained`;
        scheduleReplacedTabTransfer(addedId, removedId, tombstone, expectedFence);
      }
    } finally {
      if (tabRemovalTombstones.get(removedKey) === tombstone) tombstone.replacementTransferInFlight = false;
    }
  })().catch((error) => {
    tombstone.finalizationError = error instanceof Error ? error.message : String(error);
    tombstone.replacementTransferInFlight = false;
    scheduleReplacedTabTransfer(addedId, removedId, tombstone, tombstone.observedFence ?? tabFenceTokens.get(removedKey));
    log(`could not finish replaced tab cleanup for ${removedId}`, error);
  });
});

chrome.downloads?.onCreated?.addListener((item) => {
  void enqueueDownloadStateUpdate(async () => {
    await ensureProfileIdentity();
    downloadState.set(downloadStateKey(item.id), {
      id: item.id,
      browserId: browserIdentity().browserId,
      url: boundedEventText(item.url, 4096),
      filename: boundedEventText(item.filename, 2048),
      state: boundedEventText(item.state, 64),
      bytesReceived: item.bytesReceived,
      totalBytes: item.totalBytes,
      danger: boundedEventText(item.danger, 128),
      mime: boundedEventText(item.mime, 256),
      startTime: item.startTime,
      endTime: item.endTime,
      lastSeenAt: Date.now(),
    });
    pruneDownloadState();
  }).catch((error) => log("could not record download state", error));
});

chrome.downloads?.onChanged?.addListener((delta) => {
  void enqueueDownloadStateUpdate(async () => {
    await ensureProfileIdentity();
    const current = downloadState.get(downloadStateKey(delta.id)) || { id: delta.id, browserId: browserIdentity().browserId };
    const item = chrome.downloads?.search ? (await chrome.downloads.search({ id: delta.id }))[0] : undefined;
    const changed = (key) => delta[key] && typeof delta[key] === "object" && Object.prototype.hasOwnProperty.call(delta[key], "current") ? delta[key].current : current[key];
    downloadState.set(downloadStateKey(delta.id), {
      ...current,
      filename: item?.filename ?? changed("filename"),
      url: item?.url ?? changed("url"),
      state: item?.state ?? changed("state"),
      bytesReceived: item?.bytesReceived ?? changed("bytesReceived"),
      totalBytes: item?.totalBytes ?? changed("totalBytes"),
      danger: item?.danger ?? changed("danger"),
      mime: item?.mime ?? changed("mime"),
      startTime: item?.startTime ?? changed("startTime"),
      endTime: item?.endTime ?? changed("endTime"),
      lastSeenAt: Date.now(),
    });
    pruneDownloadState();
  }).catch((error) => log("could not update download state", error));
});

async function getPairingToken() {
  if (cachedToken) return cachedToken;
  const response = await fetch(`${BRIDGE_ORIGIN}/pair`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Bridge pairing failed: HTTP ${response.status}`);
  const data = await response.json();
  if (!data.token) throw new Error("Bridge pairing response did not contain a token");
  cachedToken = data.token;
  return cachedToken;
}

function stopBridgeHeartbeat(target) {
  if (target !== undefined && heartbeatSocket !== target) return;
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
  heartbeatSocket = undefined;
}

function startBridgeHeartbeat(target) {
  stopBridgeHeartbeat();
  heartbeatSocket = target;
  heartbeatTimer = setInterval(() => {
    if (socket !== target || target.readyState !== WebSocket.OPEN) {
      stopBridgeHeartbeat(target);
      return;
    }
    if (!send({ type: 'ping' }, target)) stopBridgeHeartbeat(target);
  }, BRIDGE_HEARTBEAT_INTERVAL_MS);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect().catch((error) => {
      console.error("[pi-control-chrome] reconnect failed", error);
      scheduleReconnect();
    });
  }, 1500);
}

async function ensureProfileIdentity() {
  if (profileIdentity) return profileIdentity;
  if (profileIdentityInitialization) return profileIdentityInitialization;
  const initialization = (async () => {
    const data = await chrome.storage.local.get({ [PROFILE_ID_KEY]: "" });
    const identity = typeof data[PROFILE_ID_KEY] === "string" && data[PROFILE_ID_KEY].length > 0
      ? data[PROFILE_ID_KEY]
      : crypto.randomUUID();
    if (data[PROFILE_ID_KEY] !== identity) {
      await chrome.storage.local.set({ [PROFILE_ID_KEY]: identity });
      const check = await chrome.storage.local.get({ [PROFILE_ID_KEY]: "" });
      if (check[PROFILE_ID_KEY] !== identity) throw new Error("browser profile identity read-back did not match the requested identity");
    }
    profileIdentity = identity;
    return identity;
  })();
  profileIdentityInitialization = initialization;
  initialization.catch(() => {
    if (profileIdentityInitialization === initialization) profileIdentityInitialization = undefined;
  });
  return initialization;
}

async function ensureRuntimeIdentity() {
  if (runtimeInstanceIdentity) return runtimeInstanceIdentity;
  if (runtimeIdentityInitialization) return runtimeIdentityInitialization;
  const initialization = Promise.resolve().then(() => {
    runtimeInstanceIdentity = RUNTIME_INSTANCE_ID;
    return runtimeInstanceIdentity;
  });
  runtimeIdentityInitialization = initialization;
  initialization.catch(() => {
    if (runtimeIdentityInitialization === initialization) runtimeIdentityInitialization = undefined;
  });
  return initialization;
}

async function ensureTabFenceState() {
  if (tabFenceStateLoaded) return;
  if (tabFenceInitialization) return tabFenceInitialization;
  const initialization = (async () => {
    const session = chrome.storage.session;
    if (!session?.get) {
      tabFenceStateLoaded = true;
      return;
    }
    const data = await session.get({ [TAB_FENCES_KEY]: {} });
    const stored = data[TAB_FENCES_KEY];
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const [key, value] of Object.entries(stored)) {
        if (typeof value === "string" && value.length > 0 && !tabFenceTokens.has(key)) tabFenceTokens.set(key, value);
      }
    }
    tabFenceStateLoaded = true;
  })();
  tabFenceInitialization = initialization;
  initialization.catch(() => {
    if (tabFenceInitialization === initialization) tabFenceInitialization = undefined;
  });
  return initialization;
}

async function persistTabFenceState() {
  const run = tabFenceMutationTail.then(async () => {
    await ensureTabFenceState();
    const session = chrome.storage.session;
    if (!session?.set) return;
    const expected = Object.fromEntries(tabFenceTokens);
    await session.set({ [TAB_FENCES_KEY]: expected });
    if (typeof session.get === "function") {
      const check = await session.get({ [TAB_FENCES_KEY]: {} });
      const persisted = check[TAB_FENCES_KEY];
      if (!sameStorageValue(persisted, expected)) throw uncertainBrowserOperationError("tab fence", { fencePersistenceUncertain: true });
    }
  });
  tabFenceMutationTail = run.then(() => undefined, () => undefined);
  try {
    await run;
    tabFencePersistenceFailure = undefined;
  } catch (error) {
    tabFencePersistenceFailure = error;
    throw error;
  }
}

function rotateTabFence(tabId) {
  const key = runtimeStateKey(tabId);
  const token = `tab:${crypto.randomUUID()}`;
  tabFenceTokens.set(key, token);
  void persistTabFenceState().catch((error) => log("could not persist tab fence", error));
  return token;
}

async function forgetTabFence(tabId, expectedFence) {
  await ensureTabFenceState();
  const key = runtimeStateKey(tabId);
  const currentFence = tabFenceTokens.get(key);
  if (currentFence !== expectedFence) return;
  if (expectedFence === undefined && tabFenceTokens.has(key)) return;
  tabFenceTokens.delete(key);
  await persistTabFenceState();
}

async function tabFenceFor(tabId, create = false) {
  await ensureTabFenceState();
  const key = runtimeStateKey(tabId);
  await tabFenceMutationTail;
  if (tabFencePersistenceFailure) {
    try {
      await persistTabFenceState();
    } catch {
      const error = uncertainBrowserOperationError("tab fence", { tabId, fencePersistenceFailed: true });
      error.code = "BROWSER_FENCE_UNAVAILABLE";
      error.cause = tabFencePersistenceFailure;
      throw error;
    }
  }
  const existing = tabFenceTokens.get(key);
  if (existing !== undefined || !create) return existing;
  const created = `tab:${crypto.randomUUID()}`;
  tabFenceTokens.set(key, created);
  await persistTabFenceState();
  return tabFenceTokens.get(key) === created ? created : tabFenceTokens.get(key);
}

function browserIdentity() {
  const manifest = chrome.runtime.getManifest();
  const userAgent = navigator.userAgent;
  const browser = /Edg\//i.test(userAgent) ? "edge" : /Chrome\//i.test(userAgent) ? "chrome" : "chromium";
  return {
    browser,
    browserId: `${browser}:${chrome.runtime.id}:${profileIdentity || "uninitialized"}`,
    profile: profileIdentity || "uninitialized",
    userAgent,
    extensionVersion: manifest.version,
  };
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const previousSocket = socket;
  if (previousSocket) {
    abortActiveRequestsForSocket(previousSocket, "Browser request aborted because the Bridge connection was replaced");
    if (previousSocket.readyState !== WebSocket.CLOSED) previousSocket.close();
    if (socket === previousSocket) {
      socket = undefined;
      connectedAt = undefined;
    }
  }
  if (connecting) return connecting;
  const attempt = (async () => {
    await ensureProfileIdentity();
    const token = await getPairingToken();
    const next = new WebSocket(`${BRIDGE_WS}?role=extension&token=${encodeURIComponent(token)}`);
    socket = next;
    next.addEventListener("open", () => {
      connectedAt = Date.now();
      send({ type: "hello", role: "extension", protocol: 1, capabilities: EXTENSION_CAPABILITIES, ...browserIdentity() }, next);
      startBridgeHeartbeat(next);
      log("connected to Pi bridge");
    });
    next.addEventListener("message", async (event) => {
      if (socket !== next) return;
      let id;
      let requestController;
      let requestMethod;
      let requestParams = {};
      try {
        const message = JSON.parse(event.data);
        if (message.type === "cancel") {
          activeRequestControllers.get(String(message.id))?.abort(new Error("Browser request canceled"));
          return;
        }
        id = message.id;
        if (message.type !== "request") return;
        requestMethod = message.method;
        const method = requestMethod;
        const requestKey = String(id);
        requestController = new AbortController();
        const priorCleanup = cleanupInFlight;
        const run = async (requestParams = message.params && typeof message.params === "object" && !Array.isArray(message.params) ? message.params : {}, dispatchOptions = {}) => {
          if (socket !== next || next.readyState !== WebSocket.OPEN) {
            return { ok: false, error: { code: "BRIDGE_SOCKET_STALE", message: "Browser request was received on a stale Bridge connection" } };
          }
          const target = message.target;
          if (target !== undefined && (!target || typeof target !== "object" || Array.isArray(target))) {
            return { ok: false, error: { code: "INVALID_BROWSER_TARGET", message: "target must be an object" } };
          }
          const envelopeBrowserId = target?.browserId;
          const parameterBrowserId = requestParams.expectedBrowserId;
          if (envelopeBrowserId !== undefined && parameterBrowserId !== undefined && envelopeBrowserId !== parameterBrowserId) {
            return { ok: false, error: { code: "INVALID_BROWSER_TARGET", message: "target.browserId conflicts with expectedBrowserId" } };
          }
          const expectedBrowserId = envelopeBrowserId ?? parameterBrowserId;
          if (expectedBrowserId !== undefined && (typeof expectedBrowserId !== "string" || expectedBrowserId.length === 0)) {
            return { ok: false, error: { code: "INVALID_BROWSER_TARGET", message: "expected browserId must be a non-empty string" } };
          }
          if (expectedBrowserId !== undefined && expectedBrowserId !== browserIdentity().browserId) {
            return { ok: false, error: { code: "INVALID_BROWSER_TARGET", message: `Browser target mismatch; expected ${expectedBrowserId} but this extension is ${browserIdentity().browserId}` } };
          }
          let result;
          try {
            result = await handleRequest(message.method, requestParams, { signal: requestController.signal, cleanupFence: priorCleanup, ...dispatchOptions });
          } catch (error) {
            if (requestController.signal.aborted) {
              if (isSideEffectingRequest(message.method, requestParams)) throw uncertainBrowserOperationError(message.method);
              throw abortError(requestController.signal, "Browser request aborted");
            }
            throw error;
          }
          if (requestController.signal.aborted) {
            return { ok: false, error: isSideEffectingRequest(message.method, requestParams)
              ? { code: "BROWSER_OPERATION_UNCERTAIN", message: `Browser ${message.method} operation may have taken effect before cancellation; inspect the current browser state before retrying` }
              : { code: "BROWSER_REQUEST_CANCELED", message: "Browser request was canceled" } };
          }
          if (socket !== next || next.readyState !== WebSocket.OPEN) {
            return { ok: false, error: { code: "BROWSER_OPERATION_UNCERTAIN", message: "Browser request completed after its Bridge connection became stale; do not replay side-effecting operations automatically" } };
          }
          return { ok: true, result };
        };
        const params = message.params && typeof message.params === "object" && !Array.isArray(message.params) ? message.params : {};
        requestParams = params;
        activeRequestControllers.set(requestKey, requestController);
        activeRequestDetails.set(requestKey, { method: message.method, sessionId: params.sessionId, params, socket: next });
        if (message.method === "cleanup") abortActiveWaits(params.sessionId);
        const priorBridgeRequests = bridgeRequestTail;
        const waitOutsideQueue = message.method === "wait"
          || (message.method === "download" && (params.action === "wait" || (params.action === "start" && params.wait !== false)))
          || (message.method === "new_tab" && params.wait === true)
          || (message.method === "navigate" && params.wait !== false)
          || (message.method === "locator" && params.action === "waitFor");
        let response;
        if (message.method === "new_tab" && params.wait === true) {
          let reservation;
          try {
            response = await enqueueBridgeRequest(async () => {
              await awaitWithSignal(priorCleanup, requestController.signal);
              assertRequestActive(requestController.signal);
              reservation = reserveTabWait(`new_tab:${id}`, params.sessionId);
              await awaitWithSignal(reservation.before, requestController.signal);
              assertRequestActive(requestController.signal);
              return run({ ...params, wait: false }, { skipCleanupFence: true });
            });
            if (response.ok && response.result?.tab?.id !== undefined) {
              const newTabId = response.result.tab.id;
              const newTabFence = response.result.tabFence;
              reservation.rekey(newTabId);
              await awaitWithSignal(reservation.before, requestController.signal);

              const readyTab = await waitAfterEffect("new_tab", async () => {
                await waitForTabState(newTabId, { state: "load", timeoutMs: params.timeoutMs, ...(params.allowRedirects === true ? {} : { url: params.url }) }, requestController.signal, newTabFence);
                await assertTabFence(newTabId, newTabFence, "read");
                return tabEntryFor(newTabId, newTabFence, "read");
              }, { tabId: newTabId });
              response = { ok: true, result: { ...response.result, tab: readyTab } };
              if (socket !== next || next.readyState !== WebSocket.OPEN) response = { ok: false, error: { code: "BROWSER_OPERATION_UNCERTAIN", message: "Browser tab creation completed after its Bridge connection became stale; inspect the current browser state before retrying" } };
            }
          } finally {
            reservation?.release();
          }
        } else if (message.method === "navigate" && params.wait !== false) {
          const navigationKey = params.tabId === undefined || params.tabId === null ? `navigate:${id}` : Number(params.tabId);
          let reservation;
          let navigationTabId;
          let navigationTabFence;
          try {
            response = await enqueueBridgeRequest(async () => {
              await awaitWithSignal(priorCleanup, requestController.signal);
              assertRequestActive(requestController.signal);
              reservation = reserveTabWait(navigationKey, params.sessionId);
              await awaitWithSignal(reservation.before, requestController.signal);
              assertRequestActive(requestController.signal);
              const navigationTarget = await getTab(params.tabId, params, false);
              assertRequestActive(requestController.signal);
              navigationTabFence = authorizedTabFence(navigationTarget);
              navigationTabId = navigationTarget.id;
              if (navigationKey !== navigationTabId) reservation.rekey(navigationTabId);
              await awaitWithSignal(reservation.before, requestController.signal);
              assertRequestActive(requestController.signal);
              return run({ ...params, tabId: navigationTabId, wait: false }, { skipTabId: navigationTabId, skipCleanupFence: true, expectedTabFence: navigationTabFence });
            });
            if (response.ok && navigationTabId !== undefined && response.result?.tab?.id !== undefined) {
              const readyTab = await waitAfterEffect("navigate", async () => {
                await waitForTabState(navigationTabId, { state: "load", timeoutMs: params.timeoutMs, ...(params.allowRedirects === true ? {} : { url: params.url }) }, requestController.signal, navigationTabFence);
                await assertTabFence(navigationTabId, navigationTabFence, "read");
                await refreshOwnedTabDocument(navigationTabId, navigationTabFence, params.sessionId);
                return tabEntryFor(navigationTabId, navigationTabFence, "navigate");
              }, { tabId: navigationTabId });
              if (socket !== next || next.readyState !== WebSocket.OPEN) response = { ok: false, error: { code: "BROWSER_OPERATION_UNCERTAIN", message: "Browser navigation completed after its Bridge connection became stale; inspect the current page before retrying" } };
              else response = { ok: true, result: { tab: readyTab } };
            }
          } finally {
            reservation?.release();
          }
        } else if (message.method === "download" && params.action === "start" && params.wait !== false) {
          response = await enqueueBridgeRequest(() => run({ ...params, wait: false }));
          const downloadId = response.ok ? response.result?.download?.id : undefined;
          if (response.ok && downloadId !== undefined) {
            const download = await waitAfterEffect("download", () => trackDownloadWait(downloadId, params.sessionId, () => waitForDownload(downloadId, params.timeoutMs, requestController.signal)), { downloadId });
            if (socket !== next || next.readyState !== WebSocket.OPEN) response = { ok: false, error: { code: "BROWSER_OPERATION_UNCERTAIN", message: "Browser download completed after its Bridge connection became stale; inspect the download state before retrying" } };
            else response = { ok: true, result: { download } };
          }
        } else if (message.method === "cleanup") {
          const cleanupTask = enqueueBridgeRequest(() => run(params, { skipCleanupFence: true }));
          const cleanupFence = cleanupTask.then(() => undefined, () => undefined);
          cleanupInFlight = cleanupFence;
          try {
            response = await cleanupTask;
          } finally {
            if (cleanupInFlight === cleanupFence) cleanupInFlight = Promise.resolve();
          }
        } else if (message.method === "wait") {
          crossSessionReadParams.add(params);
          const waitKey = params.tabId === undefined || params.tabId === null ? `wait:${id}` : Number(params.tabId);
          let reservation;
          let waitTabId;
          let waitTabFence;
          try {
            await enqueueBridgeRequest(async () => {
              await awaitWithSignal(priorCleanup, requestController.signal);
              assertRequestActive(requestController.signal);
              reservation = reserveTabWait(waitKey, params.sessionId);
              await awaitWithSignal(reservation.before, requestController.signal);
              assertRequestActive(requestController.signal);
              const tab = await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
              assertRequestActive(requestController.signal);
              waitTabFence = authorizedTabFence(tab);
              waitTabId = tab.id;
              if (waitKey !== waitTabId) reservation.rekey(waitTabId);
              await awaitWithSignal(reservation.before, requestController.signal);
              assertRequestActive(requestController.signal);
              return { ok: true };
            });
            if (waitTabId === undefined) throw new Error("Browser wait could not resolve its tab target");
            response = await run({ ...params, tabId: waitTabId }, { skipTabId: waitTabId, skipTabBarrier: true, expectedTabFence: waitTabFence });
          } finally {
            reservation?.release();
          }
        } else if (message.method === "download" && params.action === "wait") {
          await awaitWithSignal(priorBridgeRequests, requestController.signal);
          response = await trackDownloadWait(Number(params.downloadId), params.sessionId, () => run(undefined, { skipDownloadBarrier: true }));
        } else if (message.method === "locator" && params.action === "waitFor") {
          let reservation;
          let locatorTabId;
          let locatorTabFence;
          const locatorKey = params.tabId === undefined || params.tabId === null ? `locator:${id}` : Number(params.tabId);
          try {
            await enqueueBridgeRequest(async () => {
              await awaitWithSignal(priorCleanup, requestController.signal);
              assertRequestActive(requestController.signal);
              reservation = reserveTabWait(locatorKey, params.sessionId);
              await awaitWithSignal(reservation.before, requestController.signal);
              assertRequestActive(requestController.signal);
              const tab = await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
              assertRequestActive(requestController.signal);
              locatorTabId = tab.id;
              locatorTabFence = authorizedTabFence(tab);
              if (locatorKey !== locatorTabId) reservation.rekey(locatorTabId);
              await awaitWithSignal(reservation.before, requestController.signal);
              assertRequestActive(requestController.signal);
              return { ok: true };
            });
            if (locatorTabId === undefined) throw new Error("Locator wait could not resolve its tab target");
            response = await run({ ...params, tabId: locatorTabId }, { skipTabId: locatorTabId, skipTabBarrier: true, expectedTabFence: locatorTabFence });
          } finally {
            reservation?.release();
          }
        } else if (waitOutsideQueue) {
          response = await run();
        } else {
          response = await enqueueBridgeRequest(run);
        }
        activeRequestControllers.delete(requestKey);
        activeRequestDetails.delete(requestKey);
        if (!response.ok) {
          send({ type: "response", id, error: response.error }, next);
          return;
        }
        send({ type: "response", id, result: response.result }, next);
      } catch (error) {
        activeRequestControllers.delete(String(id));
        activeRequestDetails.delete(String(id));
        const message = error instanceof Error ? error.message : String(error);
        const code = requestController?.signal.aborted
          ? (isSideEffectingRequest(requestMethod, requestParams) ? "BROWSER_OPERATION_UNCERTAIN" : "BROWSER_REQUEST_CANCELED")
          : error && typeof error === "object" && typeof error.code === "string" ? error.code : "BROWSER_ERROR";
        const details = error && typeof error === "object" && error.details && typeof error.details === "object" ? error.details : undefined;
        send({ type: "response", id, error: { code, message, ...(details === undefined ? {} : { details }) } }, next);
      }
    });
    next.addEventListener("close", () => {
      stopBridgeHeartbeat(next);
      abortActiveRequestsForSocket(next, "Browser request aborted because the Bridge connection closed");
      if (socket !== next) return;
      activeRequestControllers.clear();
      activeRequestDetails.clear();
      connectedAt = undefined;
      socket = undefined;
      scheduleReconnect();
    });
    next.addEventListener("error", (error) => log("bridge websocket error", error));
  })();
  connecting = attempt;
  try {
    await attempt;
  } finally {
    if (connecting === attempt) connecting = undefined;
  }
}

function send(message, target = socket) {
  if (!target || target.readyState !== WebSocket.OPEN) return false;
  try {
    target.send(JSON.stringify(message));
    return true;
  } catch (error) {
    log("WebSocket send failed", error);
    return false;
  }
}

function enqueueBridgeRequest(task) {
  const run = bridgeRequestTail.then(task);
  bridgeRequestTail = run.then(() => undefined, () => undefined);
  return run;
}

const TAB_REQUEST_METHODS = new Set(["selected_tab", "select_tab", "wait", "navigate", "back", "forward", "reload", "close_tab", "extract", "snapshot", "locator", "interaction", "dom_cua", "cua", "screenshot", "evaluate", "cdp", "devtools_enable", "devtools_disable", "console_logs", "network_requests", "network_response_body", "dialog", "upload", "clipboard", "keypress", "scroll", "claim_tab", "release", "mark_handoff", "mark_deliverable"]);

function sessionBarrierKey(key, sessionId) {
  return JSON.stringify([sessionKey(sessionId), String(key)]);
}

async function waitForTabBarrier(tabId, sessionId) {
  const expectedSession = sessionKey(sessionId);
  const barriers = [];
  const direct = tabWaitBarriers.get(sessionBarrierKey(Number(tabId), expectedSession));
  if (direct !== undefined && direct.sessionId === expectedSession) barriers.push(direct.promise);
  for (const record of tabWaitBarriers.values()) {
    if (record.unresolved && record.sessionId === expectedSession && !barriers.includes(record.promise)) barriers.push(record.promise);
  }
  await Promise.all(barriers);
}

async function waitForAllTabBarriers(sessionId) {
  const expectedSession = sessionKey(sessionId);
  const barriers = [...tabWaitBarriers.values()]
    .filter((record) => record.sessionId === expectedSession)
    .map((record) => record.promise);
  await Promise.allSettled(barriers);
}

function reserveTabWait(key, sessionId) {
  const normalizedSession = sessionKey(sessionId);
  let currentKey = sessionBarrierKey(key, normalizedSession);
  let previous = tabWaitBarriers.get(currentKey);
  let before = previous?.promise ?? Promise.resolve();
  let resolveHold;
  const hold = new Promise((resolve) => { resolveHold = resolve; });
  const record = { promise: before.then(() => hold, () => hold), sessionId: normalizedSession, unresolved: typeof key === "string" };
  tabWaitBarriers.set(currentKey, record);
  let released = false;
  return {
    get before() { return before; },
    rekey(nextKey) {
      const nextBarrierKey = sessionBarrierKey(nextKey, normalizedSession);
      if (released || currentKey === nextBarrierKey) return;
      if (tabWaitBarriers.get(currentKey) === record) tabWaitBarriers.delete(currentKey);
      previous = tabWaitBarriers.get(nextBarrierKey);
      before = previous?.promise ?? Promise.resolve();
      record.promise = before.then(() => hold, () => hold);
      record.unresolved = false;
      currentKey = nextBarrierKey;
      tabWaitBarriers.set(currentKey, record);
    },
    release() {
      if (released) return;
      released = true;
      resolveHold();
      if (tabWaitBarriers.get(currentKey) === record) tabWaitBarriers.delete(currentKey);
    },
  };
}

let downloadWaitSequence = 0;

async function waitForDownloadBarrier(downloadId, sessionId) {
  const expectedSession = sessionKey(sessionId);
  const id = Number(downloadId);
  const barriers = [...downloadWaitBarriers.values()]
    .filter((record) => record.sessionId === expectedSession && record.downloadId === id)
    .map((record) => record.promise);
  await Promise.all(barriers);
}

async function waitForAllDownloadBarriers(sessionId) {
  const expectedSession = sessionKey(sessionId);
  await Promise.allSettled([...downloadWaitBarriers.values()]
    .filter((record) => record.sessionId === expectedSession)
    .map((record) => record.promise));
}

function trackDownloadWait(downloadId, sessionId, task) {
  const id = Number(downloadId);
  const expectedSession = sessionKey(sessionId);
  const key = `${sessionBarrierKey(id, expectedSession)}::${++downloadWaitSequence}`;
  const run = Promise.resolve().then(task);
  const barrier = run.finally(() => {
    if (downloadWaitBarriers.get(key)?.promise === barrier) downloadWaitBarriers.delete(key);
  });
  downloadWaitBarriers.set(key, { promise: barrier, sessionId: expectedSession, downloadId: id });
  return barrier;
}

function targetStateKey(tabId, browserId = browserIdentity().browserId) {
  return `${browserId}::${Number(tabId)}`;
}

function nonNegativeTabId(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function recordTabId(record, key) {
  const candidate = record && Object.prototype.hasOwnProperty.call(record, "tabId") ? record.tabId : String(key).split("::").at(-1);
  const tabId = Number(candidate);
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : Number.NaN;
}

function isRecordObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameStorageValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameStorageValue(value, right[index]));
  }
  if (isRecordObject(left) || isRecordObject(right)) {
    if (!isRecordObject(left) || !isRecordObject(right)) return false;
    const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
    const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameStorageValue(left[key], right[key]));
  }
  return false;
}

async function migrateOwnedTabs() {
  const data = await chrome.storage.local.get({ [OWNED_TABS_KEY]: null });
  const stored = data[OWNED_TABS_KEY];
  if (stored && stored.version === OWNED_TABS_SCHEMA_VERSION && isRecordObject(stored.records)) return;
  if (stored === null || stored === undefined) return;
  if (!isRecordObject(stored)) {
    await saveOwnedTabs({});
    return;
  }
  const currentBrowserId = browserIdentity().browserId;
  const records = {};
  const source = stored.version === 2 && isRecordObject(stored.records) ? stored.records : stored;
  for (const [legacyKey, value] of Object.entries(source)) {
    if (!isRecordObject(value)) continue;
    const tabId = Number(value.tabId ?? legacyKey);
    if (!Number.isInteger(tabId) || tabId < 0) continue;
    const browserId = typeof value.browserId === "string" && value.browserId.length > 0 ? value.browserId : currentBrowserId;
    const owner = value.owner === "claimed" ? "claimed" : "agent";
    const lifecycle = owner === "claimed" ? "claimed" : ["temporary", "created", "handoff", "deliverable"].includes(value.lifecycle) ? value.lifecycle : "temporary";
    const runtimeId = typeof value.runtimeId === "string" && value.runtimeId.length > 0 ? value.runtimeId : `legacy-unknown-${runtimeInstanceIdentity}`;
    records[targetStateKey(tabId, browserId)] = {
      ...value,
      tabId,
      browserId,
      sessionId: typeof value.sessionId === "string" && value.sessionId.length > 0 ? value.sessionId : "default",
      createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
      owner,
      lifecycle,
      runtimeId,
      title: typeof value.title === "string" ? value.title : "",
      url: typeof value.url === "string" ? value.url : "",
    };
  }
  await saveOwnedTabs(records);
}

async function ensureOwnedTabsMigration() {
  if (ownedTabsMigrationComplete) return;
  if (ownedTabsMigration === undefined) {
    ownedTabsMigration = migrateOwnedTabs().then(() => {
      ownedTabsMigrationComplete = true;
    }).finally(() => {
      ownedTabsMigration = undefined;
    });
  }
  await ownedTabsMigration;
}

function sanitizeOwnedRecords(records) {
  const sanitized = {};
  for (const [key, value] of Object.entries(records)) {
    if (!isRecordObject(value) || !Object.prototype.hasOwnProperty.call(value, "tabId") || !nonNegativeTabId(value.tabId) || recordTabId(value, key) !== value.tabId) continue;
    if (typeof value.browserId !== "string" || value.browserId.length === 0 || typeof value.sessionId !== "string" || value.sessionId.length === 0) continue;
    if (key !== targetStateKey(value.tabId, value.browserId)) continue;
    if (!Number.isFinite(value.createdAt) || typeof value.title !== "string" || typeof value.url !== "string" || typeof value.runtimeId !== "string" || value.runtimeId.length === 0) continue;
    if (value.tabFence !== undefined && (typeof value.tabFence !== "string" || value.tabFence.length === 0)) continue;
    if (value.incarnation !== undefined && (typeof value.incarnation !== "string" || value.incarnation.length === 0)) continue;
    if (!(value.owner === "agent" || value.owner === "claimed")) continue;
    const validLifecycle = value.owner === "claimed"
      ? value.lifecycle === "claimed"
      : ["temporary", "created", "handoff", "deliverable"].includes(value.lifecycle);
    if (!validLifecycle) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

async function storedOwnedRecords() {
  await ensureProfileIdentity();
  await ensureRuntimeIdentity();
  await ensureOwnedTabsMigration();
  const data = await chrome.storage.local.get({ [OWNED_TABS_KEY]: null });
  const stored = data[OWNED_TABS_KEY];
  return stored && stored.version === OWNED_TABS_SCHEMA_VERSION && isRecordObject(stored.records) ? stored.records : {};
}

async function ownedTabs() {
  return sanitizeOwnedRecords(await storedOwnedRecords());
}

async function assertOwnedTabFence(record, action) {
  let currentTab;
  try {
    currentTab = await chrome.tabs.get(Number(record.tabId));
  } catch (caughtError) {
    if (!isMissingTabError(caughtError)) throw caughtError;
    const error = new Error(`Cannot ${action} tab ${record.tabId}; the tab was closed; inspect the current browser state before retrying`);
    error.code = "BROWSER_TAB_CLOSED";
    throw error;
  }
  if (Number(currentTab.id) !== Number(record.tabId)) {
    const error = new Error(`Cannot ${action} tab ${record.tabId}; its tab identity changed; inspect the current browser state before retrying`);
    error.code = "BROWSER_TAB_FENCE_CHANGED";
    throw error;
  }
  const tabFence = await tabFenceFor(record.tabId);
  if (typeof record.tabFence !== "string" || tabFence !== record.tabFence) {
    const error = new Error(`Cannot ${action} tab ${record.tabId}; its tab incarnation is unknown; inspect the tab before retrying`);
    error.code = "BROWSER_TAB_FENCE_CHANGED";
    throw error;
  }
}

async function ownedTabForSession(tabId, sessionId, action, required = false, allowOtherSession = false) {
  const owned = await ownedTabs();
  const record = owned[targetStateKey(tabId)];
  if (!record) {
    if (required) throw new Error(`Cannot ${action} tab ${tabId}; it is not owned by an Agent session`);
    return undefined;
  }
  if (record.runtimeId !== runtimeInstanceIdentity) throw new Error(`Cannot ${action} tab ${tabId}; its tab incarnation is unknown after the extension runtime changed`);
  if (record.browserId !== undefined && record.browserId !== browserIdentity().browserId) throw new Error(`Cannot ${action} tab ${tabId}; it belongs to another browser target`);
  if (record.sessionId !== sessionKey(sessionId) && !allowOtherSession) throw new Error(`Cannot ${action} tab ${tabId}; it belongs to another Agent session`);
  try {
    await assertOwnedTabFence(record, action);
  } catch (error) {
    if (action === "release" && error?.code === "BROWSER_TAB_CLOSED") return record;
    throw error;
  }
  return record;
}

async function saveOwnedTabs(value) {
  try {
    await chrome.storage.local.set({ [OWNED_TABS_KEY]: { version: OWNED_TABS_SCHEMA_VERSION, records: value } });
    const check = await chrome.storage.local.get({ [OWNED_TABS_KEY]: null });
    const stored = check[OWNED_TABS_KEY];
    if (!stored || stored.version !== OWNED_TABS_SCHEMA_VERSION || !isRecordObject(stored.records) || !sameStorageValue(stored.records, value)) throw new Error("ownership storage read-back did not match the requested records");
  } catch (error) {
    if (error?.code === "BROWSER_OPERATION_UNCERTAIN") throw error;
    const uncertain = uncertainBrowserOperationError("ownership", { ownershipWriteUncertain: true });
    uncertain.cause = error;
    throw uncertain;
  }
}

function recoverMalformedOwnedRecords(sessionId, browserId) {
  const run = ownedTabsMutationTail.then(async () => {
    const stored = await storedOwnedRecords();
    const valid = sanitizeOwnedRecords(stored);
    const recovered = [];
    const records = {};
    for (const [key, value] of Object.entries(stored)) {
      if (Object.prototype.hasOwnProperty.call(valid, key)) {
        records[key] = valid[key];
        continue;
      }
      const candidate = isRecordObject(value) ? value : {};
      const matchesSession = candidate.sessionId === sessionId;
      const matchesBrowser = candidate.browserId === undefined || candidate.browserId === browserId;
      const tabId = Number(candidate.tabId ?? recordTabId(candidate, key));
      if (matchesSession && matchesBrowser && Number.isInteger(tabId) && tabId >= 0) recovered.push(tabId);
      else records[key] = value;
    }
    await saveOwnedTabs(records);
    return recovered;
  });
  ownedTabsMutationTail = run.then(() => undefined, () => undefined);
  return run;
}

async function assertOwnershipRecordsCurrent(records, keys, action, tolerateMissing = new Set()) {
  for (const key of keys) {
    const record = records[key];
    if (!record || typeof record.tabFence !== "string") continue;
    let currentTab;
    try {
      currentTab = await chrome.tabs.get(Number(record.tabId));
    } catch (error) {
      if (isMissingTabError(error) && tolerateMissing.has(key)) continue;
      const uncertain = uncertainBrowserOperationError(action, { tabId: Number(record.tabId), ownershipWriteUncertain: true });
      uncertain.cause = error;
      throw uncertain;
    }
    const currentFence = await tabFenceFor(record.tabId);
    if (Number(currentTab.id) !== Number(record.tabId) || currentFence !== record.tabFence) throw uncertainBrowserOperationError(action, { tabId: Number(record.tabId), tabFenceChanged: true, ownershipWriteUncertain: true });
  }
}

function mutateOwnedTabs(mutator) {
  const run = ownedTabsMutationTail.then(async () => {
    const stored = await storedOwnedRecords();
    const owned = sanitizeOwnedRecords(stored);
    const before = Object.fromEntries(Object.entries(owned).map(([key, value]) => [key, JSON.stringify(value)]));
    const result = await mutator(owned);
    const unchangedKeys = new Set(Object.keys(owned).filter((key) => before[key] !== undefined && before[key] === JSON.stringify(owned[key])));
    await assertOwnershipRecordsCurrent(owned, Object.keys(owned), "ownership", unchangedKeys);
    const preserved = Object.fromEntries(Object.entries(stored).filter(([key]) => !Object.prototype.hasOwnProperty.call(before, key)));
    await saveOwnedTabs({ ...preserved, ...owned });
    await assertOwnershipRecordsCurrent(owned, Object.keys(owned), "ownership", unchangedKeys);
    return result;
  });
  ownedTabsMutationTail = run.then(() => undefined, () => undefined);
  return run;
}

async function recordOwnedTab(tab, sessionId, owner = "agent", lifecycle = "temporary", expectedFence) {
  return mutateOwnedTabs(async (owned) => {
    const fenceBeforeLookup = expectedFence ?? await tabFenceFor(tab.id, true);
    const currentTab = await chrome.tabs.get(Number(tab.id)).catch(() => undefined);
    if (!currentTab) throw new Error(`Tab ${tab.id} was closed before ownership could be recorded`);
    if (owner === "claimed" && !tabSnapshotMatches(tab, currentTab)) throw new Error(`Tab ${tab.id} changed during the claim; take a new browser_tabs snapshot`);
    const browserId = browserIdentity().browserId;
    const key = targetStateKey(tab.id, browserId);
    const tabFence = await tabFenceFor(tab.id, true);
    if (tabFence !== fenceBeforeLookup) throw new Error(`Tab ${tab.id} changed during setup; inspect the current browser state before retrying`);
    const incarnation = await readTabIncarnation(tab.id, tabFence);
    if (owner === "claimed" && typeof incarnation !== "string") throw documentIdentityUnavailableError(tab.id, "claim");
    if (tab.incarnation !== undefined && incarnation !== undefined && tab.incarnation !== incarnation) throw new Error(`Tab ${tab.id} incarnation changed during the claim`);
    const existing = owned[key];
    if (existing) {
      if (existing.runtimeId !== runtimeInstanceIdentity) throw new Error(`Cannot ${owner === "claimed" ? "claim" : "record"} tab ${tab.id}; its tab incarnation is unknown after the extension runtime changed`);
      throw new Error(`Tab ${tab.id} is already owned; release it before claiming or recording it again`);
    }
    const finalTab = await chrome.tabs.get(Number(tab.id)).catch(() => undefined);
    if (!finalTab) throw new Error(`Tab ${tab.id} was closed before ownership could be recorded`);
    await assertTabFence(tab.id, tabFence, "record");
    if (owner === "claimed" && !tabSnapshotMatches(tab, finalTab)) throw new Error(`Tab ${tab.id} changed during the claim; take a new browser_tabs snapshot`);
    const finalIncarnation = await readTabIncarnation(tab.id, tabFence);
    if (owner === "claimed" && (typeof incarnation !== "string" || typeof finalIncarnation !== "string" || incarnation !== finalIncarnation)) {
      if (typeof incarnation !== "string" || typeof finalIncarnation !== "string") throw documentIdentityUnavailableError(tab.id, "claim");
      throw new Error(`Tab ${tab.id} document incarnation changed during ownership recording`);
    }
    const latestTab = await chrome.tabs.get(Number(tab.id)).catch(() => undefined);
    if (!latestTab) throw new Error(`Tab ${tab.id} was closed before ownership could be recorded`);
    await assertTabFence(tab.id, tabFence, "record");
    if (owner === "claimed" && !tabSnapshotMatches(tab, latestTab)) throw new Error(`Tab ${tab.id} changed during the claim; take a new browser_tabs snapshot`);
    const latestIncarnation = await readTabIncarnation(tab.id, tabFence);
    if (owner === "claimed" && (typeof incarnation !== "string" || typeof latestIncarnation !== "string" || incarnation !== latestIncarnation)) {
      if (typeof incarnation !== "string" || typeof latestIncarnation !== "string") throw documentIdentityUnavailableError(tab.id, "claim");
      throw new Error(`Tab ${tab.id} document incarnation changed during ownership recording`);
    }
    owned[key] = {
      tabId: latestTab.id,
      browserId,
      windowId: latestTab.windowId,
      sessionId: sessionKey(sessionId),
      createdAt: Date.now(),
      groupId: tab.groupId,
      owner,
      lifecycle,
      runtimeId: runtimeInstanceIdentity,
      tabFence,
      ...(latestIncarnation === undefined ? {} : { incarnation: latestIncarnation }),
      title: latestTab.title || "",
      url: latestTab.url || "",
      };
    return owned[key];
  });
}

async function refreshOwnedTabDocument(tabId, expectedFence, sessionId) {
  try {
    const currentTab = await chrome.tabs.get(Number(tabId));
    const currentFence = await tabFenceFor(tabId, true);
    if (currentFence !== expectedFence) throw uncertainBrowserOperationError("document refresh", { tabId: Number(tabId) });
    const incarnation = await readTabIncarnation(tabId, expectedFence);
    const latestTab = await chrome.tabs.get(Number(tabId));
    await assertTabFence(tabId, expectedFence, "document refresh");
    if (!tabSnapshotMatches(currentTab, latestTab)) throw uncertainBrowserOperationError("document refresh", { tabId: Number(tabId), pageChanged: true });
    const latestIncarnation = await readTabIncarnation(tabId, expectedFence);
    if (incarnation !== latestIncarnation || (incarnation === undefined && latestIncarnation === undefined && String(currentTab.url || "") !== String(latestTab.url || ""))) throw uncertainBrowserOperationError("document refresh", { tabId: Number(tabId), pageChanged: true });
    return mutateOwnedTabs((owned) => {
      const key = targetStateKey(tabId);
      const record = owned[key];
      if (!record) return record;
      if (record.sessionId !== sessionKey(sessionId) || record.tabFence !== expectedFence || record.runtimeId !== runtimeInstanceIdentity) throw uncertainBrowserOperationError("document refresh", { tabId: Number(tabId) });
      const refreshed = { ...record, windowId: latestTab.windowId, title: latestTab.title || "", url: latestTab.url || "" };
      if (typeof latestIncarnation === "string") refreshed.incarnation = latestIncarnation;
      else delete refreshed.incarnation;
      owned[key] = refreshed;
      return refreshed;
    });
  } catch (error) {
    if (error?.code === "BROWSER_OPERATION_UNCERTAIN") throw error;
    const uncertain = uncertainBrowserOperationError("document refresh", { tabId: Number(tabId) });
    uncertain.cause = error;
    throw uncertain;
  }
}

async function updateOwnedTab(tabId, patch, sessionId) {
  return mutateOwnedTabs(async (owned) => {
    const key = targetStateKey(tabId);
    const record = owned[key];
    if (!record) throw new Error(`Agent-owned tab not found: ${tabId}`);
    if (record.owner !== "agent") throw new Error(`Cannot update tab ${tabId}; only Agent-owned tabs can be marked for handoff or delivery`);
    if (record.runtimeId !== runtimeInstanceIdentity) throw new Error(`Cannot update tab ${tabId}; its tab incarnation is unknown after the extension runtime changed`);
    if (record.browserId !== undefined && record.browserId !== browserIdentity().browserId) throw new Error(`Cannot update tab ${tabId}; it belongs to another browser target`);
    if (record.sessionId !== sessionKey(sessionId)) throw new Error(`Cannot update tab ${tabId}; it belongs to another Agent session`);
    await assertOwnedTabFence(record, "update");
    owned[key] = { ...record, ...patch };
    return owned[key];
  });
}

async function forgetOwnedTab(tabId, sessionId, allowOtherSession = false, expectedFence, expectedOwnershipPresent) {
  return mutateOwnedTabs((owned) => {
    const key = targetStateKey(tabId);
    const record = owned[key];
    if (expectedOwnershipPresent === true && (!record || record.tabFence !== expectedFence)) return false;
    if (expectedOwnershipPresent === false && record) return;
    if (record?.browserId !== undefined && record.browserId !== browserIdentity().browserId && !allowOtherSession) {
      throw new Error(`Cannot forget tab ${tabId}; it belongs to another browser target`);
    }
    if (record && record.sessionId !== sessionKey(sessionId) && !allowOtherSession) {
      throw new Error(`Cannot forget tab ${tabId}; it belongs to another Agent session`);
    }
    if (record) deactivateCreatedTabReservation(runtimeStateKey(tabId), createdTabReservations.get(runtimeStateKey(tabId)), true);
    delete owned[key];
    return record !== undefined;
  });
}

async function forgetOwnedTabRecord(tabId, expectedFence) {
  return mutateOwnedTabs((owned) => {
    const key = targetStateKey(tabId);
    const record = owned[key];
    if (!record || typeof expectedFence !== "string" || record.tabFence !== expectedFence) return;
    delete owned[key];
  });
}

function authorizedTabFence(tab) {
  return typeof tab?.[TAB_FENCE_SYMBOL] === "string" ? tab[TAB_FENCE_SYMBOL] : undefined;
}

function attachTabFence(tab, fence) {
  if (typeof fence !== "string") return tab;
  try {
    Object.defineProperty(tab, TAB_FENCE_SYMBOL, { configurable: true, enumerable: false, value: fence });
  } catch {
    return { ...tab, [TAB_FENCE_SYMBOL]: fence };
  }
  return tab;
}

function tabSnapshotMatches(left, right) {
  const same = (key) => left?.[key] === undefined || (right?.[key] !== undefined && String(left[key] || "") === String(right[key] || ""));
  return same("windowId") && same("title") && same("url");
}
function creationFlightMatches(tab, flight) {
  if (!flight || flight.active !== true) return false;
  if (flight.tabId !== undefined) return Number(flight.tabId) === Number(tab?.id)
    && (!Number.isFinite(flight.windowId) || Number(tab?.windowId) === Number(flight.windowId));
  if (Number.isFinite(flight.windowId) && Number(tab?.windowId) !== Number(flight.windowId)) return false;
  const eventUrl = String(tab?.url || "");
  return eventUrl === String(flight.url || "");
}

function activeCreationFlightsFor(tab) {
  return [...createdTabFlights].filter((flight) => creationFlightMatches(tab, flight));
}

function creationMarkerMatches(tab, marker) {
  return marker && Number(marker.tabId) === Number(tab.id)
    && (marker.windowId === undefined || Number(marker.windowId) === Number(tab.windowId))
    && (marker.url === undefined || String(marker.url) === String(tab.url || ""));
}

function rememberCreatedTabEvent(tab, fence, completed = false) {
  if (tab?.id === undefined || typeof fence !== "string") return;
  const key = runtimeStateKey(tab.id);
  const marker = { tabId: Number(tab.id), windowId: tab.windowId, url: tab.url || "", title: tab.title || "", fence, completed, createdAt: Date.now(), sequence: ++createdTabEventSequence };
  createdTabEvents.set(key, marker);
  const timer = setTimeout(() => {
    if (createdTabEvents.get(key) === marker) createdTabEvents.delete(key);
  }, 30_000);
  timer.unref?.();
}

function deactivateCreatedTabReservation(key, reservation, force = false) {
  if (!reservation || createdTabReservations.get(key) !== reservation) return;
  if (!force && reservation.completed === true && reservation.eventObserved !== true && reservation.rollback !== true) {
    reservation.active = false;
    reservation.completedHold = true;
    reservation.expiryTimer = setTimeout(() => {
      if (createdTabReservations.get(key) === reservation) deactivateCreatedTabReservation(key, reservation, true);
    }, CREATION_RESERVATION_TTL_MS);
    reservation.expiryTimer.unref?.();
    return;
  }
  reservation.active = false;
  if (reservation.expiryTimer !== undefined) clearTimeout(reservation.expiryTimer);
  createdTabReservations.delete(key);
}

function prepareCreatedTabRuntimeState(tabId, fence) {
  const id = Number(tabId);
  const key = runtimeStateKey(id);
  const oldDebugger = persistentDebuggers.get(key);
  const oldOrphan = orphanedDebuggerAttaches.get(key);
  if (oldDebugger && oldDebugger.tabFence === fence) {
    log(`created tab ${id} reused an existing debugger fence; retaining debugger state for review`);
    return false;
  }
  if (oldOrphan && oldOrphan.tabFence === fence) {
    log(`created tab ${id} reused an orphaned debugger fence; retaining orphan state for review`);
    return false;
  }
  if (oldDebugger) {
    const orphanEpoch = invalidateDebuggerAttach(id);
    if (oldDebugger.releaseTimer !== undefined) clearTimeout(oldDebugger.releaseTimer);
    orphanedDebuggerAttaches.set(key, { ...oldDebugger, epoch: orphanEpoch, pendingProbe: true, orphanedAt: Date.now() });
    persistentDebuggers.delete(key);
  } else if (!oldOrphan) {
    invalidateDebuggerAttach(id);
  }
  pageSnapshotStates.delete(key);
  domSnapshotStates.delete(key);
  accessibilitySnapshotStates.delete(key);
  devtoolsState.delete(key);
  return true;
}

function retireTabRemovalTombstone(key, tabId, tombstone) {
  if (!tombstone || tombstone.superseded || tombstone.replaced) return tombstone?.retiredKey;
  tombstone.tabId = Number(tabId);
  tombstone.superseded = true;
  tombstone.retiredAt = tombstone.retiredAt ?? Date.now();
  const retiredKey = `${key}:${++removalLifecycleSequence}`;
  tombstone.retiredKey = retiredKey;
  retiredTabRemovalTombstones.set(retiredKey, tombstone);
  if (tombstone.retryTimer !== undefined) clearTimeout(tombstone.retryTimer);
  if (tombstone.replacementTransferTimer !== undefined) clearTimeout(tombstone.replacementTransferTimer);
  tabRemovalTombstones.delete(key);
  return retiredKey;
}

async function reconcileUnreservedCreatedTab(tab, eventObservedAt = Date.now()) {
  const run = ownedTabsMutationTail.then(() => reconcileUnreservedCreatedTabNow(tab, eventObservedAt));
  ownedTabsMutationTail = run.then(() => undefined, () => undefined);
  return run;
}

async function reconcileUnreservedCreatedTabNow(tab, eventObservedAt) {
  const id = Number(tab?.id);
  if (!Number.isInteger(id) || id < 0) return;
  const key = runtimeStateKey(id);
  const eventTab = { ...tab };
  const previousFence = tabFenceTokens.get(key);
  const initialTombstone = tabRemovalTombstones.get(key);
  if (initialTombstone?.replaced) return;
  const owned = await ownedTabs();
  const currentTab = await chrome.tabs.get(id).catch((error) => {
    if (isMissingTabError(error)) return undefined;
    throw error;
  });
  if (!currentTab
    || Number(currentTab.windowId) !== Number(eventTab.windowId)
    || String(currentTab.title || "") !== String(eventTab.title || "")
    || String(currentTab.url || "") !== String(eventTab.url || "")) return;
  const fenceBeforeMutation = await tabFenceFor(id, true);
  if (previousFence !== undefined && fenceBeforeMutation !== previousFence) return;
  if (tabRemovalTombstones.get(key) !== initialTombstone) return;
  const ownershipKey = targetStateKey(id);
  const record = owned[ownershipKey];
  if (record && Number.isFinite(Number(record.createdAt)) && Number(record.createdAt) >= Number(eventObservedAt)) return;
  let tombstone = initialTombstone;
  if (!tombstone && record && typeof record.tabFence === "string" && (previousFence === undefined || previousFence === record.tabFence)) {
    tombstone = { tabId: id, superseded: false, replaced: false, observedFence: record.tabFence, removedAt: Date.now(), removedRecord: { ...record } };
    tabRemovalTombstones.set(key, tombstone);
  }
  const retiredKey = retireTabRemovalTombstone(key, id, tombstone);
  const nextFence = rotateTabFence(id);
  pageSnapshotStates.delete(key);
  domSnapshotStates.delete(key);
  accessibilitySnapshotStates.delete(key);
  devtoolsState.delete(key);
  const debuggerRecord = persistentDebuggers.get(key);
  if (debuggerRecord?.releaseTimer !== undefined) clearTimeout(debuggerRecord.releaseTimer);
  persistentDebuggers.delete(key);
  const attachEpoch = invalidateDebuggerAttach(id);
  if (debuggerRecord) orphanedDebuggerAttaches.set(key, { ...debuggerRecord, epoch: attachEpoch, tabFence: debuggerRecord.tabFence, pendingProbe: true, orphanedAt: Date.now() });
  if (retiredKey !== undefined) scheduleRetiredTabFinalization(id, tombstone, tombstone.observedFence ?? previousFence);
  log(`rotated the tab fence for an unreserved created tab ${id}`, { previousFence, nextFence });
}


async function assertTabFence(tabId, expectedFence, action = "use") {
  if (typeof expectedFence !== "string") return;
  const currentFence = await tabFenceFor(tabId);
  if (currentFence !== expectedFence) {
    throw uncertainBrowserOperationError(action, { tabId });
  }
  try {
    await chrome.tabs.get(Number(tabId));
  } catch {
    throw uncertainBrowserOperationError(action, { tabId });
  }
  const fenceAfterLookup = await tabFenceFor(tabId);
  if (fenceAfterLookup !== expectedFence) throw uncertainBrowserOperationError(action, { tabId });
}

async function removeTabWithFence(tabId, expectedFence, operation = "close") {
  const id = Number(tabId);
  await assertTabFence(id, expectedFence, operation);
  const key = runtimeStateKey(id);
  if (tabRemovalIntents.has(key)) throw uncertainBrowserOperationError(operation, { tabId: id, removalInFlight: true });
  const intent = { tabId: id, expectedFence, operation, removalObserved: false, replacementObserved: false, startedAt: Date.now() };
  tabRemovalIntents.set(key, intent);
  try {
    try {
      await chrome.tabs.remove(id);
    } catch (error) {
      if (!isMissingTabError(error)) throw error;
      intent.removalObserved = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    let currentTab;
    try {
      currentTab = await chrome.tabs.get(id);
    } catch (error) {
      if (!isMissingTabError(error)) throw error;
    }
    if (currentTab || intent.replacementObserved || !intent.removalObserved) {
      throw uncertainBrowserOperationError(operation, { tabId: id, removalObserved: intent.removalObserved, replacementObserved: intent.replacementObserved, tabStillLive: Boolean(currentTab) });
    }
    return true;
  } finally {
    if (tabRemovalIntents.get(key) === intent) tabRemovalIntents.delete(key);
  }
}

async function getTab(tabId, handle = {}, allowOtherSession = false, allowRecordedSnapshotChange = false, allowBlockedPageDocumentCheck = false) {
  const hasNestedHandle = isRecordObject(handle.handle);
  const tabHandle = hasNestedHandle ? handle.handle : {};
  const handleTabId = tabHandle.tabId !== undefined ? Number(tabHandle.tabId) : undefined;
  const explicitTabId = tabId !== undefined && tabId !== null ? Number(tabId) : handleTabId;
  let tab;
  if (explicitTabId !== undefined) {
    try {
      tab = await chrome.tabs.get(explicitTabId);
    } catch (error) {
      if (isMissingTabError(error)) {
        const closed = new Error(`Tab ${explicitTabId} was closed before the request could start`);
        closed.code = "BROWSER_TAB_CLOSED";
        closed.details = { tabId: explicitTabId };
        throw closed;
      }
      throw error;
    }
  } else {
    tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  }
  if (!tab) throw new Error("No active browser tab is available");
  const fenceBeforeLookup = explicitTabId === undefined ? undefined : await tabFenceFor(explicitTabId, true);
  const fenceBeforeVerification = fenceBeforeLookup ?? await tabFenceFor(tab.id, true);
  const verifiedTab = await chrome.tabs.get(Number(tab.id)).catch(() => undefined);
  if (!verifiedTab) throw new Error(`Tab ${tab.id} was closed before the request could start`);
  if (explicitTabId === undefined) {
    const selected = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!selected || Number(selected.id) !== Number(verifiedTab.id)) throw new Error("The selected browser tab changed before the request could start; take a new browser_tabs snapshot");
  }
  const fenceAfterVerification = await tabFenceFor(verifiedTab.id, true);
  if (fenceBeforeVerification !== fenceAfterVerification) throw new Error(`Tab ${verifiedTab.id} changed before the request could start; take a new browser_tabs snapshot`);
  tab = verifiedTab;


  const hasCompleteNestedHandle = hasNestedHandle
    && tabHandle.windowId !== undefined
    && tabHandle.title !== undefined
    && tabHandle.url !== undefined
    && tabHandle.tabFence !== undefined
    && tabHandle.incarnation !== undefined;
  const hasHandleDocumentIdentity = typeof tabHandle.incarnation === "string" && tabHandle.incarnation.length > 0;
  const allowCrossSessionRead = allowOtherSession || crossSessionReadParams.has(handle);
  const requestSessionId = handle.sessionId ?? tabHandle.sessionId;
  if (tabHandle.tabId !== undefined && Number(tabHandle.tabId) !== Number(tab.id)) throw new Error("Tab handle is stale: tab id changed; take a new browser_tabs snapshot");
  if (tabHandle.expectedBrowserId !== undefined && String(tabHandle.expectedBrowserId) !== browserIdentity().browserId) throw browserTargetMismatchError(tabHandle.expectedBrowserId);
  if (tabHandle.browserId !== undefined && String(tabHandle.browserId) !== browserIdentity().browserId) throw browserTargetMismatchError(tabHandle.browserId);
  if (tabHandle.expectedTitle !== undefined && String(tabHandle.expectedTitle) !== String(tab.title || "")) throw new Error("Tab handle is stale: title changed; take a new browser_tabs snapshot");
  if (tabHandle.expectedUrl !== undefined && String(tabHandle.expectedUrl) !== String(tab.url || "")) throw new Error("Tab handle is stale: URL changed; take a new browser_tabs snapshot");
  if (tabHandle.windowId !== undefined && Number(tabHandle.windowId) !== Number(tab.windowId)) throw new Error("Tab handle is stale: window changed; take a new browser_tabs snapshot");
  if (tabHandle.title !== undefined && !hasHandleDocumentIdentity && !allowBlockedPageDocumentCheck && String(tabHandle.title) !== String(tab.title || "")) throw new Error("Tab handle is stale: title changed; take a new browser_tabs snapshot");
  if (tabHandle.url !== undefined && !allowBlockedPageDocumentCheck && String(tabHandle.url) !== String(tab.url || "")) throw new Error("Tab handle is stale: URL changed; take a new browser_tabs snapshot");
  if (tabHandle.tabFence !== undefined && fenceAfterVerification !== String(tabHandle.tabFence)) throw new Error("Tab handle is stale: tab incarnation changed; take a new browser_tabs snapshot");
  if (tabHandle.incarnation !== undefined && !allowBlockedPageDocumentCheck) {
    const incarnation = await readTabIncarnation(tab.id, fenceAfterVerification);
    if (typeof incarnation !== "string") throw documentIdentityUnavailableError(tab.id, "use");
    if (incarnation !== String(tabHandle.incarnation)) throw new Error("Tab handle is stale: document incarnation changed; take a new browser_tabs snapshot");
  }
  const owned = await ownedTabs();
  const lifecycleTombstone = tabRemovalTombstones.get(runtimeStateKey(tab.id));
  if (lifecycleTombstone) throw uncertainBrowserOperationError("tab lookup", { tabId: tab.id, removalPending: true });
  const record = owned[targetStateKey(tab.id)];
  if (record) {
    if (record.runtimeId !== runtimeInstanceIdentity) throw new Error(`Cannot use tab ${tab.id}; its tab incarnation is unknown after the extension runtime changed`);
    if (record.browserId !== undefined && record.browserId !== browserIdentity().browserId) throw browserTargetMismatchError(record.browserId);
    if (record.sessionId !== sessionKey(requestSessionId) && !allowCrossSessionRead) throw new Error(`Cannot use tab ${tab.id}; it belongs to another Agent session`);
    await assertOwnedTabFence(record, "use");
    if (explicitTabId !== undefined && !allowRecordedSnapshotChange && !hasCompleteNestedHandle && record.owner === "claimed") {
      if (Number(record.windowId) !== Number(tab.windowId) || String(record.title ?? "") !== String(tab.title ?? "") || String(record.url ?? "") !== String(tab.url ?? "")) {
        throw new Error("Owned tab changed since it was recorded; take a new browser_tabs snapshot");
      }
      const incarnation = await readTabIncarnation(tab.id, fenceAfterVerification);
      if (typeof record.incarnation !== "string" || typeof incarnation !== "string" || record.incarnation !== incarnation) {
        throw new Error("Owned tab document changed or cannot be verified; take a new browser_tabs snapshot");
      }
    }
  }
  const finalTab = await chrome.tabs.get(Number(tab.id));
  const finalFence = await tabFenceFor(finalTab.id, true);
  if (finalFence !== fenceAfterVerification) throw uncertainBrowserOperationError("tab lookup", { tabId: finalTab.id });
  if (tabHandle.expectedTitle !== undefined && String(tabHandle.expectedTitle) !== String(finalTab.title || "")) throw new Error("Tab handle is stale: title changed; take a new browser_tabs snapshot");
  if (tabHandle.expectedUrl !== undefined && String(tabHandle.expectedUrl) !== String(finalTab.url || "")) throw new Error("Tab handle is stale: URL changed; take a new browser_tabs snapshot");
  if (tabHandle.windowId !== undefined && Number(tabHandle.windowId) !== Number(finalTab.windowId)) throw new Error("Tab handle is stale: window changed; take a new browser_tabs snapshot");
  if (tabHandle.title !== undefined && !hasHandleDocumentIdentity && !allowBlockedPageDocumentCheck && String(tabHandle.title) !== String(finalTab.title || "")) throw new Error("Tab handle is stale: title changed; take a new browser_tabs snapshot");
  if (tabHandle.url !== undefined && !allowBlockedPageDocumentCheck && String(tabHandle.url) !== String(finalTab.url || "")) throw new Error("Tab handle is stale: URL changed; take a new browser_tabs snapshot");
  if (tabHandle.incarnation !== undefined && !allowBlockedPageDocumentCheck) {
    const incarnation = await readTabIncarnation(finalTab.id, finalFence);
    if (typeof incarnation !== "string") throw documentIdentityUnavailableError(tab.id, "use");
    if (incarnation !== String(tabHandle.incarnation)) throw new Error("Tab handle is stale: document incarnation changed; take a new browser_tabs snapshot");
  }
  return attachTabFence(finalTab, finalFence);
}

async function listGroups() {
  if (!chrome.tabGroups?.query) return [];
  const groups = await chrome.tabGroups.query({});
  return groups.map((group) => ({
    id: group.id,
    windowId: group.windowId,
    title: group.title || "",
    color: group.color,
    collapsed: Boolean(group.collapsed),
  }));
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  const owned = await ownedTabs();
  const identity = browserIdentity();
  const entries = (await Promise.all(tabs.map(async (queriedTab) => {
    let tab;
    try {
      tab = await chrome.tabs.get(queriedTab.id);
    } catch (error) {
      if (isMissingTabError(error)) return undefined;
      throw error;
    }
    const stored = owned[targetStateKey(tab.id)];
    const record = stored && (stored.browserId === undefined || stored.browserId === identity.browserId) ? stored : undefined;
    const tabFence = await tabFenceFor(tab.id, true);
    const currentTab = await chrome.tabs.get(tab.id).catch((error) => {
      if (isMissingTabError(error)) return undefined;
      throw error;
    });
    if (!currentTab) return undefined;
    const currentFence = await tabFenceFor(tab.id, true);
    if (currentFence !== tabFence) throw uncertainBrowserOperationError("list_tabs", { tabId: tab.id });
    tab = currentTab;
    const checksDocument = record?.owner === "claimed";
    const incarnation = record ? await readTabIncarnation(tab.id, currentFence) : undefined;
    return {
      id: tab.id,
      browserId: identity.browserId,
      favicon: typeof tab.favIconUrl === "string" && /^https?:\/\//i.test(tab.favIconUrl) ? tab.favIconUrl.slice(0, 2048) : "",
      windowId: tab.windowId,
      index: tab.index,
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      title: tab.title || "",
      url: tab.url || "",
      status: tab.status,
      groupId: tab.groupId,
      owner: record?.owner === "agent" ? "agent" : "user",
      ownership: record?.owner,
      sessionId: record?.sessionId,
      lifecycle: record?.lifecycle,
      handle: { tabId: tab.id, browserId: identity.browserId, windowId: tab.windowId, title: tab.title || "", url: tab.url || "", groupId: tab.groupId, sessionId: record?.sessionId, tabFence: currentFence, ...(incarnation === undefined ? {} : { incarnation }) },
      stale: record !== undefined && (record.runtimeId !== runtimeInstanceIdentity || Number(record.windowId) !== Number(tab.windowId) || record.tabFence !== currentFence || (checksDocument && (record.url !== (tab.url || "") || record.title !== (tab.title || "") || (record.incarnation === undefined || incarnation !== record.incarnation)))),
    };
  }))).filter((entry) => entry !== undefined);
  return {
    browserId: identity.browserId,
    profile: identity.profile,
    tabs: entries,
    groups: await listGroups(),
  };
}

async function tabEntryFor(tabId, expectedFence, action = "read") {
  await assertTabFence(tabId, expectedFence, action);
  const listed = (await listTabs()).tabs.find((entry) => Number(entry.id) === Number(tabId));
  await assertTabFence(tabId, expectedFence, action);
  if (!listed) throw new Error(`Tab ${tabId} was not present while assembling the response`);
  return listed;
}

async function recoverRetiredTabWithoutFence(tabId, tombstone, sessionId, browserId) {
  const retiredKey = tombstone.retiredKey;
  if (typeof retiredKey !== "string" || retiredTabRemovalTombstones.get(retiredKey) !== tombstone) return false;
  const finalized = await mutateOwnedTabs((owned) => {
    if (retiredTabRemovalTombstones.get(retiredKey) !== tombstone) return false;
    const key = targetStateKey(tabId);
    const record = owned[key];
    if (!record) return true;
    if (record.sessionId !== sessionId || (record.browserId !== undefined && record.browserId !== browserId) || !Number.isFinite(Number(record.createdAt)) || Number(record.createdAt) > Number(tombstone.retiredAt || 0)) {
      tombstone.recoveryPending = true;
      tombstone.finalizationError = `Retired tab ${tabId} ownership could not be attributed without a tab fence`;
      return false;
    }
    delete owned[key];
    tombstone.removedRecord = { ...record };
    return true;
  });
  if (!finalized) return false;
  retiredTabRemovalTombstones.delete(retiredKey);
  return true;
}

async function finalizeRetiredTabOwnership(tabId, tombstone, expectedFence) {
  if (typeof expectedFence !== "string") {
    tombstone.recoveryPending = true;
    tombstone.finalizationError = `Retired tab ${tabId} has no prior tab fence`;
    return false;
  }
  const key = runtimeStateKey(tabId);
  const retiredKey = tombstone.retiredKey;
  if (typeof retiredKey !== "string" || retiredTabRemovalTombstones.get(retiredKey) !== tombstone) return false;
  let currentFence = await tabFenceFor(tabId);
  try {
    await chrome.tabs.get(Number(tabId));
    if (currentFence === expectedFence) return false;
  } catch (error) {
    if (!isMissingTabError(error)) throw error;
  }
  const finalized = await mutateOwnedTabs(async (owned) => {
    if (retiredTabRemovalTombstones.get(retiredKey) !== tombstone) return false;
    currentFence = await tabFenceFor(tabId);
    try {
      await chrome.tabs.get(Number(tabId));
      if (currentFence === expectedFence) return false;
    } catch (error) {
      if (!isMissingTabError(error)) throw error;
    }
    const ownershipKey = targetStateKey(tabId);
    const record = owned[ownershipKey];
    const retiredAt = Number(tombstone.retiredAt || 0);
    if (record && (record.tabFence !== expectedFence || !Number.isFinite(Number(record.createdAt)) || Number(record.createdAt) > retiredAt)) {
      tombstone.recoveryPending = true;
      tombstone.finalizationError = `Retired tab ${tabId} still has ownership that cannot be attributed to the removed tab`;
      return false;
    }
    if (record) {
      tombstone.removedRecord = { ...record };
      delete owned[ownershipKey];
    }
    return true;
  });
  if (!finalized || retiredTabRemovalTombstones.get(retiredKey) !== tombstone) return false;
  if (tabFenceTokens.get(key) === expectedFence) {
    tabFenceTokens.delete(key);
    try {
      await persistTabFenceState();
    } catch (error) {
      if (tabFenceTokens.get(key) === undefined && retiredTabRemovalTombstones.get(retiredKey) === tombstone) tabFenceTokens.set(key, expectedFence);
      throw error;
    }
  }
  if (retiredTabRemovalTombstones.get(retiredKey) !== tombstone) return false;
  retiredTabRemovalTombstones.delete(retiredKey);
  return true;
}

function scheduleRetiredTabFinalization(tabId, tombstone, expectedFence) {
  const retiredKey = tombstone.retiredKey;
  if (typeof retiredKey !== "string" || retiredTabRemovalTombstones.get(retiredKey) !== tombstone) return;
  if (tombstone.retiredRetryTimer !== undefined) return;
  const retryCount = Number(tombstone.retiredRetryCount || 0);
  if (retryCount >= 8) {
    tombstone.recoveryPending = true;
    tombstone.finalizationError = tombstone.finalizationError || `Retired tab ${tabId} could not be reconciled automatically`;
    return;
  }
  tombstone.retiredRetryCount = retryCount + 1;
  const delay = Math.min(30_000, 1_000 * 2 ** retryCount);
  tombstone.retiredRetryTimer = setTimeout(async () => {
    tombstone.retiredRetryTimer = undefined;
    if (retiredTabRemovalTombstones.get(retiredKey) !== tombstone) return;
    try {
      const finalized = await finalizeRetiredTabOwnership(tabId, tombstone, expectedFence);
      if (!finalized) scheduleRetiredTabFinalization(tabId, tombstone, expectedFence);
    } catch (error) {
      tombstone.finalizationError = error instanceof Error ? error.message : String(error);
      scheduleRetiredTabFinalization(tabId, tombstone, expectedFence);
    }
  }, delay);
  tombstone.retiredRetryTimer.unref?.();
}

async function finalizeRemovedTab(tabId, tombstone, expectedFence) {
  if (typeof expectedFence !== "string") return false;
  const key = runtimeStateKey(tabId);
  const finalized = await mutateOwnedTabs(async (owned) => {
    if (tabRemovalTombstones.get(key) !== tombstone || tombstone.superseded || tombstone.replaced) return false;
    if (tabFenceTokens.get(key) !== expectedFence) return false;
    const ownershipKey = targetStateKey(tabId);
    const record = owned[ownershipKey];
    if (record && record.tabFence !== expectedFence) return false;
    if (record) tombstone.removedRecord = { ...record };
    if (record) delete owned[ownershipKey];
    return true;
  });
  if (!finalized) return false;
  if (tabRemovalTombstones.get(key) !== tombstone || tombstone.superseded || tombstone.replaced) return false;
  try {
    await chrome.tabs.get(Number(tabId));
    return false;
  } catch (error) {
    if (!isMissingTabError(error)) throw error;
  }
  if (tabRemovalTombstones.get(key) !== tombstone || tombstone.superseded || tombstone.replaced || tabFenceTokens.get(key) !== expectedFence) return false;
  const debuggerResidue = persistentDebuggers.has(key) || orphanedDebuggerAttaches.has(key) || debuggerAttachers.has(key);
  if (!debuggerResidue && tabFenceTokens.get(key) === expectedFence) {
    tabFenceTokens.delete(key);
    try {
      await persistTabFenceState();
    } catch (error) {
      if (tabFenceTokens.get(key) === undefined && tabRemovalTombstones.get(key) === tombstone && !tombstone.superseded && !tombstone.replaced) tabFenceTokens.set(key, expectedFence);
      throw error;
    }
  }
  if (tabRemovalTombstones.get(key) !== tombstone || tombstone.superseded || tombstone.replaced || (!debuggerResidue && tabFenceTokens.get(key) === expectedFence)) return false;
  if (!debuggerResidue) debuggerAttachEpochs.delete(key);
  if (tabRemovalTombstones.get(key) === tombstone) tabRemovalTombstones.delete(key);
  return true;
}

async function finalizeReplacedTabOwnership(tabId, tombstone, expectedFence) {
  if (typeof expectedFence !== "string") return false;
  if (tombstone.transferProven !== true && tombstone.transferResolved !== true) {
    tombstone.recoveryPending = true;
    tombstone.finalizationError = tombstone.finalizationError || `Replacement for tab ${tabId} could not be identity-verified; ownership was retained`;
    return false;
  }
  const key = runtimeStateKey(tabId);
  try {
    await chrome.tabs.get(Number(tabId));
    return false;
  } catch (error) {
    if (!isMissingTabError(error)) throw error;
  }
  const finalized = await mutateOwnedTabs(async (owned) => {
    if (tabRemovalTombstones.get(key) !== tombstone || !tombstone.replaced || tombstone.superseded) return false;
    if (tabFenceTokens.get(key) !== expectedFence) return false;
    const ownershipKey = targetStateKey(tabId);
    const record = owned[ownershipKey];
    if (record && (record.runtimeId !== runtimeInstanceIdentity || record.browserId !== browserIdentity().browserId)) return false;
    if (record && record.tabFence !== expectedFence) return false;
    try {
      await chrome.tabs.get(Number(tabId));
      return false;
    } catch (error) {
      if (!isMissingTabError(error)) throw error;
    }
    if (record) tombstone.removedRecord = { ...record };
    if (record) delete owned[ownershipKey];
    return true;
  });
  if (!finalized) return false;
  if (tabRemovalTombstones.get(key) !== tombstone || tombstone.superseded) return false;
  try {
    await chrome.tabs.get(Number(tabId));
    return false;
  } catch (error) {
    if (!isMissingTabError(error)) throw error;
  }
  const debuggerResidue = persistentDebuggers.has(key) || orphanedDebuggerAttaches.has(key) || debuggerAttachers.has(key);
  if (!debuggerResidue && tabFenceTokens.get(key) === expectedFence) {
    tabFenceTokens.delete(key);
    try {
      await persistTabFenceState();
    } catch (error) {
      if (tabFenceTokens.get(key) === undefined && tabRemovalTombstones.get(key) === tombstone) tabFenceTokens.set(key, expectedFence);
      throw error;
    }
  }
  if (tabRemovalTombstones.get(key) !== tombstone || tombstone.superseded || (!debuggerResidue && tabFenceTokens.get(key) === expectedFence)) return false;
  if (!debuggerResidue) debuggerAttachEpochs.delete(key);
  if (tabRemovalTombstones.get(key) === tombstone) tabRemovalTombstones.delete(key);
  return true;
}

async function captureReplacementIdentity(addedTabId, tombstone) {
  if (typeof tombstone.addedFence !== "string") return false;
  let addedTab;
  try {
    addedTab = await chrome.tabs.get(Number(addedTabId));
  } catch (error) {
    if (isMissingTabError(error)) return false;
    throw error;
  }
  const currentFence = await tabFenceFor(Number(addedTabId), true);
  if (currentFence !== tombstone.addedFence) return false;
  if (tombstone.addedIdentityCaptured === true) {
    if (Number(addedTab.windowId) !== Number(tombstone.addedWindowId)
      || String(addedTab.title || "") !== String(tombstone.addedTitle || "")
      || String(addedTab.url || "") !== String(tombstone.addedUrl || "")) return false;
    if (typeof tombstone.addedIncarnation !== "string") return false;
    return (await readTabIncarnation(Number(addedTabId), tombstone.addedFence)) === tombstone.addedIncarnation;
  }
  const incarnation = await readTabIncarnation(Number(addedTabId), tombstone.addedFence);
  tombstone.addedWindowId = addedTab.windowId;
  tombstone.addedTitle = addedTab.title || "";
  tombstone.addedUrl = addedTab.url || "";
  tombstone.addedIncarnation = incarnation;
  tombstone.addedIdentityCaptured = true;
  return typeof incarnation === "string";
}

async function transferReplacedTabOwnership(addedTabId, removedTabId, expectedFence, tombstone) {
  if (typeof expectedFence !== "string" || typeof tombstone.addedFence !== "string" || typeof tombstone.addedIncarnation !== "string") return false;
  const replacementEpoch = tombstone.replacementEpoch;
  await ensureProfileIdentity();
  let currentAddedTab;
  try {
    currentAddedTab = await chrome.tabs.get(Number(addedTabId));
  } catch (error) {
    if (isMissingTabError(error)) return false;
    throw error;
  }
  if (Number(currentAddedTab.id) !== Number(addedTabId)
    || Number(currentAddedTab.windowId) !== Number(tombstone.addedWindowId)
    || String(currentAddedTab.title || "") !== String(tombstone.addedTitle || "")
    || String(currentAddedTab.url || "") !== String(tombstone.addedUrl || "")) return false;
  const currentAddedIncarnation = await readTabIncarnation(Number(addedTabId), tombstone.addedFence);
  if (currentAddedIncarnation !== tombstone.addedIncarnation) return false;
  try {
    await chrome.tabs.get(Number(removedTabId));
    return false;
  } catch (error) {
    if (!isMissingTabError(error)) throw error;
  }
  const newFence = tombstone.addedFence;
  const browserId = browserIdentity().browserId;
  let newIncarnation = tombstone.addedIncarnation;
  const transferred = await mutateOwnedTabs(async (owned) => {
    const oldKey = targetStateKey(removedTabId, browserId);
    const oldFence = tabFenceTokens.get(runtimeStateKey(removedTabId));
    const record = owned[oldKey] ?? tombstone.removedRecord;
    if (tabRemovalTombstones.get(runtimeStateKey(removedTabId)) !== tombstone || tombstone.superseded || tombstone.replacementEpoch !== replacementEpoch || oldFence !== expectedFence) return false;
    if (!record) {
      tombstone.transferResolved = true;
      return false;
    }
    if (record.browserId !== browserId || record.runtimeId !== runtimeInstanceIdentity || record.tabFence !== expectedFence) return false;
    let latestAddedTab;
    try {
      latestAddedTab = await chrome.tabs.get(Number(addedTabId));
    } catch (error) {
      if (isMissingTabError(error)) return false;
      throw error;
    }
    try {
      await chrome.tabs.get(Number(removedTabId));
      return false;
    } catch (error) {
      if (!isMissingTabError(error)) throw error;
    }
    if (tabFenceTokens.get(runtimeStateKey(removedTabId)) !== expectedFence) return false;
    const currentNewFence = await tabFenceFor(Number(addedTabId), true);
    if (currentNewFence !== newFence
      || tombstone.replacementEpoch !== replacementEpoch
      || Number(latestAddedTab.id) !== Number(addedTabId)
      || Number(latestAddedTab.windowId) !== Number(tombstone.addedWindowId)
      || String(latestAddedTab.title || "") !== String(tombstone.addedTitle || "")
      || String(latestAddedTab.url || "") !== String(tombstone.addedUrl || "")) return false;
    const latestAddedIncarnation = await readTabIncarnation(Number(addedTabId), newFence);
    if (latestAddedIncarnation !== tombstone.addedIncarnation) return false;
    if (record.owner === "claimed") {
      if (String(record.title || "") !== String(latestAddedTab.title || "") || String(record.url || "") !== String(latestAddedTab.url || "")) return false;
      if (typeof record.incarnation !== "string" || typeof newIncarnation !== "string" || record.incarnation !== newIncarnation) return false;
    }
    const newKey = targetStateKey(addedTabId, browserId);
    if (owned[newKey]) return false;
    owned[newKey] = {
      ...record,
      tabId: Number(addedTabId),
      windowId: latestAddedTab.windowId,
      groupId: latestAddedTab.groupId,
      tabFence: newFence,
      title: latestAddedTab.title || "",
      url: latestAddedTab.url || "",
      ...(newIncarnation === undefined ? {} : { incarnation: newIncarnation }),
    };
    delete owned[oldKey];
    tombstone.transferProven = true;
    return true;
  });
  return transferred === true;
}

async function scheduleRemovedTabFinalization(tabId, tombstone, expectedFence) {
  const replacementRetry = tombstone.replaced === true;
  if (replacementRetry && typeof expectedFence !== "string") {
    tombstone.recoveryPending = true;
    tombstone.finalizationError = `Replacement for tab ${tabId} has no prior tab fence`;
    return;
  }
  const retryCount = replacementRetry ? (tombstone.replacementRetryCount || 0) : (tombstone.retryCount || 0);
  if (tombstone.retryTimer !== undefined || retryCount >= 5) {
    if (retryCount >= 5) {
      tombstone.recoveryPending = true;
      tombstone.finalizationError = tombstone.finalizationError || `Tab ${tabId} lifecycle reconciliation requires manual review`;
    }
    return;
  }
  if (replacementRetry) tombstone.replacementRetryCount = retryCount + 1;
  else tombstone.retryCount = retryCount + 1;
  const delay = Math.min(30_000, 1_000 * 2 ** retryCount);
  tombstone.retryTimer = setTimeout(async () => {
    tombstone.retryTimer = undefined;
    if (tabRemovalTombstones.get(runtimeStateKey(tabId)) !== tombstone || (tombstone.superseded && !tombstone.replaced)) return;
    if (tombstone.replaced) {
      try {
        const finalized = await finalizeReplacedTabOwnership(tabId, tombstone, expectedFence);
        if (!finalized) scheduleRemovedTabFinalization(tabId, tombstone, expectedFence);
      } catch (error) {
        tombstone.finalizationError = error instanceof Error ? error.message : String(error);
        scheduleRemovedTabFinalization(tabId, tombstone, expectedFence);
      }
      return;
    }
    try {
      await chrome.tabs.get(Number(tabId));
      scheduleRemovedTabFinalization(tabId, tombstone, expectedFence ?? tombstone.observedFence ?? tabFenceTokens.get(runtimeStateKey(tabId)));
      return;
    } catch (error) {
      if (!isMissingTabError(error)) {
        tombstone.finalizationError = error instanceof Error ? error.message : String(error);
        scheduleRemovedTabFinalization(tabId, tombstone, expectedFence);
        return;
      }
    }
    try {
      const finalized = await finalizeRemovedTab(tabId, tombstone, expectedFence);
      if (!finalized) scheduleRemovedTabFinalization(tabId, tombstone, expectedFence);
    } catch (error) {
      tombstone.finalizationError = error instanceof Error ? error.message : String(error);
      scheduleRemovedTabFinalization(tabId, tombstone, expectedFence);
    }
  }, delay);
  tombstone.retryTimer.unref?.();
}
async function ensurePiGroupMarkers() {
  if (piGroupMarkersLoaded) return;
  await ensureProfileIdentity();
  const data = await chrome.storage.local.get({ [GROUP_MARKERS_KEY]: [] });
  const markers = Array.isArray(data[GROUP_MARKERS_KEY]) ? data[GROUP_MARKERS_KEY] : [];
  const currentBrowserId = browserIdentity().browserId;
  for (const marker of markers) {
    if (!marker || typeof marker !== "object" || marker.browserId !== currentBrowserId) continue;
    const groupId = Number(marker.groupId);
    if (Number.isInteger(groupId) && groupId >= 0) piGroupIds.add(groupId);
  }
  piGroupMarkersLoaded = true;
}

async function persistPiGroupMarker(groupId, windowId) {
  const run = piGroupMarkerMutationTail.then(async () => {
    await ensurePiGroupMarkers();
    const data = await chrome.storage.local.get({ [GROUP_MARKERS_KEY]: [] });
    const markers = Array.isArray(data[GROUP_MARKERS_KEY]) ? data[GROUP_MARKERS_KEY].filter((marker) => marker && typeof marker === "object") : [];
    const currentBrowserId = browserIdentity().browserId;
    const next = markers.filter((marker) => !(marker.browserId === currentBrowserId && Number(marker.groupId) === Number(groupId)));
    next.push({ browserId: currentBrowserId, groupId: Number(groupId), windowId: Number(windowId), updatedAt: Date.now() });
    await chrome.storage.local.set({ [GROUP_MARKERS_KEY]: next });
    const check = await chrome.storage.local.get({ [GROUP_MARKERS_KEY]: [] });
    const persisted = Array.isArray(check[GROUP_MARKERS_KEY]) ? check[GROUP_MARKERS_KEY].filter((marker) => marker && typeof marker === "object") : [];
    if (!sameStorageValue(persisted, next)) throw uncertainBrowserOperationError("group", { groupPersistenceUncertain: true });
    piGroupIds.add(Number(groupId));
  });
  piGroupMarkerMutationTail = run.then(() => undefined, () => undefined);
  return run;
}

async function findOrCreatePiGroup(windowId) {
  if (!chrome.tabGroups?.query || !chrome.tabs?.query) return undefined;
  await ensurePiGroupMarkers();
  const groups = await chrome.tabGroups.query({ windowId });
  const markedGroups = groups.filter((group) => {
    const groupId = Number(group.id);
    return Number.isInteger(groupId)
      && piGroupIds.has(groupId)
      && String(group.title || "") === GROUP_TITLE
      && String(group.color || "") === GROUP_COLOR;
  });
  if (markedGroups.length > 1) throw uncertainBrowserOperationError("group", { windowId: Number(windowId), ambiguousGroupIds: markedGroups.map((group) => Number(group.id)) });
  return markedGroups.length === 1 ? Number(markedGroups[0].id) : undefined;
}
async function putInPiGroup(tab, expectedFence) {
  if (!chrome.tabs.group || !chrome.tabGroups?.update || tab.id === undefined) return undefined;
  await assertTabFence(tab.id, expectedFence, "group");
  const existingGroupId = await findOrCreatePiGroup(tab.windowId);
  await assertTabFence(tab.id, expectedFence, "group");
  const groupId = await chrome.tabs.group(existingGroupId === undefined
    ? { tabIds: [tab.id] }
    : { tabIds: [tab.id], groupId: existingGroupId });
  await assertTabFence(tab.id, expectedFence, "group");
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false });
  await persistPiGroupMarker(Number(groupId), tab.windowId);
  await assertTabFence(tab.id, expectedFence, "group");
  return groupId;
}

function collectAccessibilitySnapshot(options = {}) {
  const MAX_CHARS = 100_000;
  const MAX_NODES = 1_000;
  const DEFAULT_CHARS = 20_000;
  const DEFAULT_NODES = 200;
  const valueLimit = (value, fallback, maximum) => {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) throw new Error("Snapshot output limits must be positive integers");
    return Math.min(number, maximum);
  };
  const maxChars = valueLimit(options.maxChars, DEFAULT_CHARS, MAX_CHARS);
  const maxNodes = valueLimit(options.maxNodes, DEFAULT_NODES, MAX_NODES);
  const bound = (value, limit = 240) => {
    const text = String(value ?? "");
    if (limit <= 0) return "";
    if (text.length <= limit) return text;
    if (limit <= 3) return text.slice(0, limit);
    return `${text.slice(0, limit - 3)}...`;
  };
  const isContentEditableHost = (element) => {
    const attr = element.getAttribute("contenteditable");
    return attr !== null && ["", "true", "plaintext-only"].includes(attr.trim().toLowerCase());
  };
  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const isContentEditable = (element) => element.isContentEditable === true || isContentEditableHost(element);
  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase();
    if (element.getAttribute("role")) return element.getAttribute("role").trim().split(/\s+/)[0].toLowerCase().slice(0, 64);
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return undefined;
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      if (type === "range") return "slider";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      return "textbox";
    }
    if (tag === "textarea" || isContentEditableHost(element)) return "textbox";
    if (tag === "select") return element.multiple ? "listbox" : "combobox";
    if (tag === "option") return "option";
    if (tag === "img") return "img";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "li") return "listitem";
    if (tag === "ul" || tag === "ol") return "list";
    return undefined;
  };
  const textOf = (element) => normalize(element.innerText || element.textContent || "");
  const referencedText = (element) => normalize(String(element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "").join(" "));
  const labelTextOf = (element) => {
    const labels = [];
    if (element.labels) labels.push(...Array.from(element.labels));
    if (element.id) labels.push(...Array.from(document.querySelectorAll("label")).filter((label) => label.htmlFor === element.id));
    const wrapping = element.closest?.("label");
    if (wrapping) labels.push(wrapping);
    return normalize([...new Set(labels)].map((label) => label.innerText || label.textContent || "").join(" "));
  };
  const isValueBearing = (element) => {
    const role = String(element.getAttribute("role") || "").trim().toLowerCase();
    return ["input", "textarea", "select"].includes(element.tagName.toLowerCase()) || isContentEditableHost(element) || ["textbox", "searchbox", "combobox", "listbox", "spinbutton", "slider"].includes(role);
  };
  const sensitiveField = (element) => {
    const tag = element.tagName.toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && ["password", "hidden"].includes(type)) return true;
    const hints = [element.getAttribute("autocomplete"), element.getAttribute("name"), element.id, element.getAttribute("aria-label"), element.getAttribute("placeholder"), element.getAttribute("title"), labelTextOf(element), referencedText(element)].filter(Boolean).join(" ").toLowerCase();
    return /password|passcode|one[-_ ]?time|otp|token|secret|api[-_ ]?key|access[-_ ]?key|auth|credential|credit[-_ ]?card|cc[-_ ]?(?:number|exp(?:iry)?|csc|cvv)|bank[-_ ]?account|routing[-_ ]?number|private[-_ ]?key|license[-_ ]?key|ssn|social[-_ ]?security|tax[-_ ]?id|pin|cvv|cvc|security[-_ ]?code|bearer/.test(hints);
  };
  const exposedValue = (element) => sensitiveField(element) ? undefined : "value" in element ? String(element.value || "").slice(0, 240) : undefined;
  const accessibleName = (element) => {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || "").toLowerCase();
    const valueName = tag === "input" && ["button", "submit", "reset", "image"].includes(type) ? String(element.value || "") : "";
    const textName = isValueBearing(element) ? "" : textOf(element);
    return normalize(referencedText(element) || normalize(element.getAttribute("aria-label") || labelTextOf(element) || element.getAttribute("alt") || textName || valueName || element.getAttribute("placeholder") || element.getAttribute("title") || "")).slice(0, 240);
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const style = getComputedStyle(current);
      if (current.hidden || String(current.getAttribute("aria-hidden") || "").toLowerCase() === "true" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0 || style.pointerEvents === "none") return false;
      current = current.parentElement;
    }
    return true;
  };
  const disabled = (element) => Boolean(element.matches?.(":disabled") || element.disabled || String(element.getAttribute("aria-disabled") || "").toLowerCase() === "true");
  const root = (() => {
    if (options.selector === undefined || (typeof options.selector === "string" && options.selector.trim().length === 0)) return document.body || document.documentElement;
    try {
      const selected = document.querySelector(String(options.selector));
      if (!selected) throw new Error(`Snapshot selector did not match any element: ${String(options.selector)}`);
      return selected;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Snapshot selector did not match")) throw error;
      throw new Error(`Invalid snapshot selector: ${String(options.selector)}`);
    }
  })();
  const candidates = [];
  const candidateSelector = "a,button,input,textarea,select,summary,[role],[contenteditable]";
  if (root.matches?.(candidateSelector) || implicitRole(root)) candidates.push(root);
  candidates.push(...Array.from(root.querySelectorAll(candidateSelector)));
  const nodes = [];
  let charCount = 0;
  let truncated = false;
  const pathOf = (element) => {
    const parts = [];
    let current = element;
    while (current && current !== root && current.nodeType === Node.ELEMENT_NODE) {
      let ordinal = 0;
      let sibling = current;
      while ((sibling = sibling.previousElementSibling)) ordinal += 1;
      parts.push(`${current.tagName.toLowerCase()}:${ordinal}`);
      current = current.parentElement;
    }
    return parts.reverse().join("/");
  };
  for (const element of candidates) {
    if (!visible(element)) continue;
    const role = implicitRole(element);
    if (!role || ["generic", "group", "listitem"].includes(role)) continue;
    const node = {
      key: pathOf(element),
      role,
      name: bound(accessibleName(element)),
      value: exposedValue(element),
      disabled: disabled(element),
      checked: "checked" in element ? Boolean(element.checked) : element.getAttribute("aria-checked") === "true" ? true : undefined,
      level: /^h[1-6]$/i.test(element.tagName) ? Number(element.tagName[1]) : undefined,
    };
    const cost = JSON.stringify(node).length;
    if (nodes.length >= maxNodes || charCount + cost > maxChars) {
      truncated = true;
      break;
    }
    nodes.push(node);
    charCount += cost;
  }
  const publicNodes = nodes.map(({ key: _key, ...node }) => node);
  const state = publicNodes.map((node) => {
    const name = node.name ? ` ${JSON.stringify(String(node.name))}` : "";
    const value = node.value === undefined ? "" : ` value=${JSON.stringify(String(node.value))}`;
    const disabled = node.disabled ? " disabled" : "";
    const checked = node.checked === undefined ? "" : ` checked=${node.checked === true}`;
    const level = node.level === undefined ? "" : ` level=${node.level}`;
    return `- ${node.role}${name}${value}${disabled}${checked}${level}`;
  }).join("\n");
  return {
    role: "document",
    name: bound(document.title),
    children: publicNodes,
    state,
    nodeCount: publicNodes.length,
    charCount: state.length,
    truncated,
    maxChars,
    maxNodes,
    __piControlChromeAccessibilityNodes: nodes,
  };
}

function collectSnapshot(options = {}) {
  const includeLiveState = false;
  const MAX_CHARS = 100_000;
  const MAX_NODES = 1_000;
  const DEFAULT_CHARS = 20_000;
  const DEFAULT_NODES = 200;
  const PAGE_TEXT_CHARS = 8_000;
  const valueLimit = (value, fallback, maximum) => {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) throw new Error("Snapshot output limits must be positive integers");
    return Math.min(number, maximum);
  };
  const maxChars = valueLimit(options.maxChars, DEFAULT_CHARS, MAX_CHARS);
  const maxNodes = valueLimit(options.maxNodes, DEFAULT_NODES, MAX_NODES);
  const pageTextLimit = Math.min(PAGE_TEXT_CHARS, maxChars);
  const bound = (value, limit) => {
    const text = String(value ?? "");
    if (limit <= 0) return "";
    if (text.length <= limit) return text;
    if (limit <= 3) return text.slice(0, limit);
    return `${text.slice(0, limit - 3)}...`;
  };
  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const domFingerprint = () => {
    let hash = 2166136261;
    const add = (value) => { for (const character of String(value ?? "")) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); };
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { add(`text:${node.nodeValue}`); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      add(`<${node.tagName}`);
      for (const attribute of Array.from(node.attributes).sort((left, right) => left.name.localeCompare(right.name))) {
        if (attribute.name.startsWith("data-pi-control-chrome-") || ["data-pi-snapshot-id", "data-pi-dom-snapshot-id"].includes(attribute.name)) continue;
        add(`${attribute.name}=${attribute.value}`);
      }
      if (includeLiveState && "value" in node) add(`value:${node.value}`);
      if (includeLiveState && "checked" in node) add(`checked:${node.checked}`);
      if (includeLiveState && "selected" in node) add(`selected:${node.selected}`);
      for (const child of Array.from(node.childNodes)) visit(child);
      add("</>");
    };
    visit(document.documentElement);
    return String(hash >>> 0);
  };
  const isContentEditableHost = (element) => {
    const attr = element.getAttribute("contenteditable");
    return attr !== null && ["", "true", "plaintext-only"].includes(attr.trim().toLowerCase());
  };
  const textOf = (element) => normalize(element.innerText || element.textContent || "");
  const referencedText = (element) => normalize(String(element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "").join(" "));
  const labelTextOf = (element) => {
    const labels = [];
    if (element.labels) labels.push(...Array.from(element.labels));
    if (element.id) labels.push(...Array.from(document.querySelectorAll("label")).filter((label) => label.htmlFor === element.id));
    const wrapping = element.closest?.("label");
    if (wrapping) labels.push(wrapping);
    return normalize([...new Set(labels)].map((label) => label.innerText || label.textContent || "").join(" "));
  };
  const isValueBearing = (element) => {
    const role = String(element.getAttribute("role") || "").trim().toLowerCase();
    return ["input", "textarea", "select"].includes(element.tagName.toLowerCase()) || isContentEditableHost(element) || ["textbox", "searchbox", "combobox", "listbox", "spinbutton", "slider"].includes(role);
  };
  const sensitiveField = (element) => {
    const tag = element.tagName.toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && ["password", "hidden"].includes(type)) return true;
    const hints = [element.getAttribute("autocomplete"), element.getAttribute("name"), element.id, element.getAttribute("aria-label"), element.getAttribute("placeholder"), element.getAttribute("title"), labelTextOf(element), referencedText(element)].filter(Boolean).join(" ").toLowerCase();
    return /password|passcode|one[-_ ]?time|otp|token|secret|api[-_ ]?key|access[-_ ]?key|auth|credential|credit[-_ ]?card|cc[-_ ]?(?:number|exp(?:iry)?|csc|cvv)|bank[-_ ]?account|routing[-_ ]?number|private[-_ ]?key|license[-_ ]?key|ssn|social[-_ ]?security|tax[-_ ]?id|pin|cvv|cvc|security[-_ ]?code|bearer/.test(hints);
  };
  const exposedValue = (element) => sensitiveField(element) ? undefined : "value" in element ? String(element.value || "").slice(0, 240) : undefined;
  const accessibleName = (element) => {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || "").toLowerCase();
    const valueName = tag === "input" && ["button", "submit", "reset", "image"].includes(type) ? String(element.value || "") : "";
    const textName = isValueBearing(element) ? "" : textOf(element);
    return normalize(referencedText(element) || normalize(element.getAttribute("aria-label") || labelTextOf(element) || element.getAttribute("alt") || textName || valueName || element.getAttribute("placeholder") || element.getAttribute("title") || "")).slice(0, 240);
  };
  const roleOf = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0].toLowerCase();
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return undefined;
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      if (type === "range") return "slider";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      return "textbox";
    }
    if (tag === "textarea" || isContentEditableHost(element)) return "textbox";
    if (tag === "select") return element.multiple ? "listbox" : "combobox";
    if (tag === "option") return "option";
    if (tag === "img") return "img";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    return undefined;
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const style = getComputedStyle(current);
      if (current.hidden || String(current.getAttribute("aria-hidden") || "").toLowerCase() === "true" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0 || style.pointerEvents === "none") return false;
      current = current.parentElement;
    }
    return true;
  };
  const disabled = (element) => Boolean(element.matches?.(":disabled") || element.disabled || String(element.getAttribute("aria-disabled") || "").toLowerCase() === "true");
  const snapshotId = crypto.randomUUID();
  const documentTokenKey = "__piControlChromeDocumentToken";
  let documentToken = globalThis[documentTokenKey];
  if (typeof documentToken !== "string" || documentToken.length === 0) {
    documentToken = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    try { Object.defineProperty(globalThis, documentTokenKey, { configurable: false, enumerable: false, value: documentToken }); } catch { globalThis[documentTokenKey] = documentToken; }
  }
  document.querySelectorAll("[data-pi-control-chrome-ref]").forEach((element) => element.removeAttribute("data-pi-control-chrome-ref"));
  document.documentElement.setAttribute("data-pi-snapshot-id", snapshotId);
  const observerKey = "__piControlChromeSnapshotObserver";
  globalThis[observerKey]?.disconnect?.();
  const observer = new MutationObserver((mutations) => {
    if (!mutations.some((mutation) => mutation.type === "childList" || mutation.type === "characterData" || (mutation.type === "attributes" && !["data-pi-dom-snapshot-id", "data-pi-snapshot-id"].includes(mutation.attributeName)))) return;
    const root = document.documentElement;
    if (root.hasAttribute("data-pi-snapshot-id")) root.setAttribute("data-pi-snapshot-id", crypto.randomUUID());
    if (root.hasAttribute("data-pi-dom-snapshot-id")) root.setAttribute("data-pi-dom-snapshot-id", crypto.randomUUID());
  });
  observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
  globalThis[observerKey] = observer;
  const root = (() => {
    if (options.selector === undefined || (typeof options.selector === "string" && options.selector.trim().length === 0)) return document.body || document.documentElement;
    try {
      const selected = document.querySelector(String(options.selector));
      if (!selected) throw new Error(`Snapshot selector did not match any element: ${String(options.selector)}`);
      return selected;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Snapshot selector did not match")) throw error;
      throw new Error(`Invalid snapshot selector: ${String(options.selector)}`);
    }
  })();
  const candidateSelector = "a,button,input,textarea,select,summary,[role],[contenteditable]";
  const candidates = [];
  if (root.matches?.(candidateSelector)) candidates.push(root);
  candidates.push(...Array.from(root.querySelectorAll(candidateSelector)));
  const elements = [];
  let elementCharCount = 0;
  let elementsTruncated = false;
  let counter = 0;
  for (const element of candidates) {
    if (element.hasAttribute("contenteditable") && !isContentEditableHost(element) && !element.getAttribute("role")) continue;
    if (!visible(element)) continue;
    const role = roleOf(element);
    if (!role || ["generic", "group", "listitem"].includes(role)) continue;
    const rect = element.getBoundingClientRect();
    const ref = `e${++counter}`;
    const entry = {
      ref,
      tag: element.tagName.toLowerCase(),
      role,
      name: accessibleName(element).slice(0, 240),
      value: exposedValue(element),
      disabled: disabled(element),
      checked: "checked" in element ? Boolean(element.checked) : undefined,
      href: element instanceof HTMLAnchorElement ? bound(element.href, 4_096) : undefined,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
    const cost = JSON.stringify(entry).length;
    if (elements.length >= maxNodes || elementCharCount + cost > maxChars) {
      elementsTruncated = true;
      break;
    }
    element.setAttribute("data-pi-control-chrome-ref", ref);
    elements.push(entry);
    elementCharCount += cost;
  }
  const snapshotFingerprint = domFingerprint();
  document.documentElement.setAttribute("data-pi-control-chrome-snapshot-fingerprint", snapshotFingerprint);
  observer.takeRecords();
  const rawPageText = root.innerText || root.textContent || "";
  const pageText = bound(rawPageText.replace(/\n{3,}/g, "\n\n"), pageTextLimit);
  return {
    snapshotId,
    __piControlChromeSnapshotFingerprint: snapshotFingerprint,
    __piControlChromeSnapshotUrl: location.href,
    __piControlChromeSnapshotTimeOrigin: typeof performance?.timeOrigin === "number" ? performance.timeOrigin : undefined,
    __piControlChromeSnapshotToken: documentToken,
    title: bound(document.title, 240),
    url: location.href,
    text: pageText,
    textTruncated: rawPageText.length > pageTextLimit,
    selectedText: bound(window.getSelection?.()?.toString() || "", 240),
    viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
    elements,
    elementCount: elements.length,
    elementCharCount,
    maxChars,
    maxNodes,
    truncated: elementsTruncated || rawPageText.length > pageTextLimit,
    accessibility: undefined,
  };
}

function extractPage(options = {}) {
  const MAX_CHARS = 100_000;
  const DEFAULT_CHARS = 12_000;
  const maxChars = (() => {
    if (options.maxChars === undefined) return DEFAULT_CHARS;
    const requested = Number(options.maxChars);
    if (!Number.isInteger(requested) || requested < 1) throw new Error("Extract maxChars must be a positive integer");
    return Math.min(requested, MAX_CHARS);
  })();
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const bound = (value) => {
    const text = String(value ?? "");
    if (maxChars <= 0) return "";
    if (text.length <= maxChars) return text;
    if (maxChars <= 3) return text.slice(0, maxChars);
    return `${text.slice(0, maxChars - 3)}...`;
  };
  const root = (() => {
    if (options.selector === undefined || (typeof options.selector === "string" && options.selector.trim().length === 0)) return document.body || document.documentElement;
    try {
      const selected = document.querySelector(String(options.selector));
      if (!selected) throw new Error(`Extract selector did not match any element: ${String(options.selector)}`);
      return selected;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Extract selector did not match")) throw error;
      throw new Error(`Invalid extract selector: ${String(options.selector)}`);
    }
  })();
  const markdown = [];
  const markdownSelector = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,a";
  const markdownElements = [];
  if (root.matches?.(markdownSelector)) markdownElements.push(root);
  markdownElements.push(...Array.from(root.querySelectorAll(markdownSelector)));
  for (const element of markdownElements) {
    const text = clean(element.innerText || element.textContent);
    if (!text) continue;
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) markdown.push(`${"#".repeat(Number(tag[1]))} ${text}`);
    else if (tag === "li") markdown.push(`- ${text}`);
    else if (tag === "blockquote") markdown.push(`> ${text}`);
    else if (tag === "pre") markdown.push("```\n" + (element.textContent || "") + "\n```");
    else if (tag === "a" && element.getAttribute("href")) markdown.push(`[${text}](<${element.href}>)`);
    else markdown.push(text);
  }
  const sourceText = (root.innerText || root.textContent || "").replace(/\n{3,}/g, "\n\n");
  const text = bound(sourceText);
  const remainingChars = Math.max(0, maxChars - text.length);
  const rawMarkdown = [...new Set(markdown)].join("\n\n");
  const markdownText = remainingChars > 0 ? bound(rawMarkdown.slice(0, remainingChars)) : "";
  return { title: clean(document.title).slice(0, 240), url: location.href, text, markdown: markdownText, maxChars, truncated: sourceText.length > maxChars || rawMarkdown.length > remainingChars };
}

async function pageOperation(params = {}) {
  const includeLiveState = false;
  try {
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const matches = (value, matcher, exact) => {
      const left = normalize(value);
      const right = normalize(matcher);
      if (!right) return false;
      return exact === true ? left === right : left.toLowerCase().includes(right.toLowerCase());
    };
    const timeoutLimit = (value, fallback, maximum) => {
      const parsed = value === undefined ? fallback : Number(value);
      if (!Number.isFinite(parsed) || parsed < 1) throw new Error("timeoutMs must be a positive finite number");
      return Math.min(parsed, maximum);
    };
    const domFingerprint = () => {
      let hash = 2166136261;
      const add = (value) => { for (const character of String(value ?? "")) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); };
      const visit = (node) => {
        if (node.nodeType === Node.TEXT_NODE) { add(`text:${node.nodeValue}`); return; }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        add(`<${node.tagName}`);
        for (const attribute of Array.from(node.attributes).sort((left, right) => left.name.localeCompare(right.name))) {
          if (attribute.name.startsWith("data-pi-control-chrome-") || ["data-pi-snapshot-id", "data-pi-dom-snapshot-id"].includes(attribute.name)) continue;
          add(`${attribute.name}=${attribute.value}`);
        }
      if (includeLiveState && "value" in node) add(`value:${node.value}`);
      if (includeLiveState && "checked" in node) add(`checked:${node.checked}`);
      if (includeLiveState && "selected" in node) add(`selected:${node.selected}`);
      for (const child of Array.from(node.childNodes)) visit(child);
        add("</>");
      };
      visit(document.documentElement);
      return String(hash >>> 0);
    };
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const style = getComputedStyle(current);
      if (current.hidden || String(current.getAttribute("aria-hidden") || "").toLowerCase() === "true" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0) return false;
      current = current.parentElement;
    }
    return true;
  };
  const isInteractable = (element) => {
    if (!isVisible(element)) return false;
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      if (getComputedStyle(current).pointerEvents === "none") return false;
      current = current.parentElement;
    }
    return true;
  };
  const dispatchDoubleClick = (element) => {
    for (const detail of [1, 2]) {
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, detail, button: 0, buttons: 1 }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, detail, button: 0, buttons: 0 }));
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, detail, button: 0, buttons: 0 }));
    }
    element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window, detail: 2, button: 0, buttons: 0 }));
  };
  const isDisabled = (element) => Boolean(
    element.matches?.(":disabled") || element.disabled || String(element.getAttribute("aria-disabled") || "").toLowerCase() === "true",
  );
  const isContentEditableHost = (element) => {
    const attr = element.getAttribute("contenteditable");
    return attr !== null && ["", "true", "plaintext-only"].includes(attr.trim().toLowerCase());
  };
  const roleOf = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0].toLowerCase();
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return undefined;
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      if (type === "range") return "slider";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      return "textbox";
    }
    if (tag === "textarea" || isContentEditableHost(element)) return "textbox";
    if (tag === "select") return element.multiple ? "listbox" : "combobox";
    if (tag === "option") return "option";
    if (tag === "img") return "img";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    return undefined;
  };
  const textOf = (element) => normalize(element.innerText || element.textContent || "");
  const isContentEditable = (element) => element.isContentEditable === true || isContentEditableHost(element);
  const isValueBearing = (element) => {
    const role = String(element.getAttribute("role") || "").trim().toLowerCase();
    return ["input", "textarea", "select"].includes(element.tagName.toLowerCase()) || isContentEditableHost(element) || ["textbox", "searchbox", "combobox", "listbox", "spinbutton", "slider"].includes(role);
  };
  const referencedText = (element) => {
    const ids = String(element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    return normalize(ids.map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "").join(" "));
  };
  const labelsOf = (element) => {
    const labels = [];
    if (element.labels) labels.push(...Array.from(element.labels));
    if (element.id) labels.push(...Array.from(document.querySelectorAll("label")).filter((label) => label.htmlFor === element.id));
    const wrapping = element.closest?.("label");
    if (wrapping) labels.push(wrapping);
    return [...new Set(labels)];
  };
  const labelTextOf = (element) => normalize(labelsOf(element).map((label) => label.innerText || label.textContent || "").join(" "));
  const labelTextsOf = (element) => labelsOf(element).map((label) => normalize(label.innerText || label.textContent || "")).filter(Boolean);
  const nameOf = (element) => {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || "").toLowerCase();
    const valueName = tag === "input" && ["button", "submit", "reset", "image"].includes(type) ? String(element.value || "") : "";
    const textName = isValueBearing(element) ? "" : textOf(element);
    return referencedText(element) || normalize(
      element.getAttribute("aria-label") || labelTextOf(element) || element.getAttribute("alt") ||
      textName || valueName || element.getAttribute("placeholder") || element.getAttribute("title") || "",
    );
  };
  const isActionable = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = roleOf(element);
    return ["a", "button", "input", "textarea", "select", "summary"].includes(tag) || ["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "slider", "spinbutton", "tab", "menuitem", "switch"].includes(role);
  };
  const isFormControl = (element) => ["input", "textarea", "select", "button"].includes(element.tagName.toLowerCase()) || isContentEditableHost(element) || ["textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "spinbutton", "slider"].includes(roleOf(element));
  const isEditable = (element) => {
    if (isDisabled(element) || element.readOnly || String(element.getAttribute("aria-readonly") || "").toLowerCase() === "true") return false;
    const tag = element.tagName.toLowerCase();
    if (isContentEditable(element) || tag === "textarea") return true;
    if (tag !== "input") return false;
    return !["hidden", "button", "submit", "reset", "image", "checkbox", "radio", "file", "range", "color"].includes((element.getAttribute("type") || "text").toLowerCase());
  };
  const requireEditable = (element, target) => {
    if (!isEditable(element)) {
      const error = new Error(`Element target is not editable: ${targetText(target)}`);
      error.code = "ELEMENT_NOT_EDITABLE";
      throw error;
    }
  };
  const diagnosticText = (value, maximum = 240) => {
    const text = String(value ?? "");
    return text.length <= maximum ? text : `${text.slice(0, maximum - 3)}...`;
  };
  const allElements = (root) => root === document ? Array.from(document.querySelectorAll("*")) : Array.from(root.querySelectorAll("*"));
  const selectorElements = (root, selector) => {
    try {
      return Array.from(root.querySelectorAll(String(selector)));
    } catch (error) {
      throw new Error(`Invalid CSS selector: ${diagnosticText(selector)}`);
    }
  };
  const normalizedSpec = (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Element target must be an object");
    const spec = { ...input };
    const primaryKeys = ["ref", "selector", "role", "label", "placeholder", "text", "testId"];
    const validate = () => {
      if (spec.name !== undefined && spec.role === undefined) throw new Error("Element target name narrowing requires role");
      const primaryCount = primaryKeys.filter((key) => spec[key] !== undefined).length;
      if (primaryCount !== 1) throw new Error("Element target must use exactly one primary locator");
      return spec;
    };
    if (spec.strategy === undefined) return validate();
    const strategy = String(spec.strategy).toLowerCase();
    const value = spec.value;
    delete spec.strategy;
    delete spec.value;
    if (strategy === "css") spec.selector = String(value || "*");
    else if (strategy === "role") spec.role = String(value || "");
    else if (strategy === "text") spec.text = String(value ?? "");
    else if (strategy === "label") spec.label = String(value ?? "");
    else if (strategy === "placeholder") spec.placeholder = String(value ?? "");
    else if (strategy === "testid") spec.testId = String(value ?? "");
    else throw new Error(`Unsupported locator strategy: ${strategy}`);
    if (strategy !== "role") delete spec.name;
    return validate();
  };
  const selectIndexedElement = (elements, indexValue, indexAfterVisibility) => {
    const index = Number(indexValue);
    if (!Number.isInteger(index) || index < 0) throw new Error("Locator index must be a non-negative integer");
    const candidates = indexAfterVisibility ? elements.filter(isInteractable) : elements;
    return candidates[index] ? [candidates[index]] : [];
  };
  const elementsFor = (input, options = {}) => {
    if (input?.combine === "and" || input?.combine === "or") {
      const left = elementsFor(input.left, options);
      const right = new Set(elementsFor(input.right, options));
      let combined = input.combine === "and" ? left.filter((element) => right.has(element)) : [...new Set([...left, ...right])];
      if (input.hasText !== undefined) combined = combined.filter((element) => matches(element.innerText || element.textContent, input.hasText, input.exact));
      if (input.hasSelector !== undefined) combined = combined.filter((element) => selectorElements(element, input.hasSelector).length > 0);
      const unique = [...new Set(combined)];
      if (input.index !== undefined) return selectIndexedElement(unique, input.index, options.indexAfterVisibility === true);
      return unique;
    }
    const spec = normalizedSpec(input);
    let root = document;
    if (spec.scopeSelector !== undefined) {
      try {
        root = document.querySelector(String(spec.scopeSelector));
      } catch (error) {
        throw new Error(`Invalid scopeSelector: ${diagnosticText(spec.scopeSelector)}`);
      }
      if (!root) return [];
    }
    const candidates = allElements(root);
    let elements;
    if (spec.ref !== undefined) {
      const ref = String(spec.ref);
      if (!/^e\d+$/.test(ref)) throw new Error("Element ref must match eN, such as e12");
      elements = candidates.filter((element) => element.getAttribute("data-pi-control-chrome-ref") === ref);
    } else if (spec.selector !== undefined) {
      elements = selectorElements(root, spec.selector);
    } else if (spec.role !== undefined) {
      const role = String(spec.role).trim().toLowerCase();
      elements = candidates.filter((element) => roleOf(element) === role);
    } else if (spec.label !== undefined) {
      elements = candidates.filter(isFormControl).filter((element) => labelTextsOf(element).some((label) => matches(label, spec.label, spec.exact)) || matches(element.getAttribute("aria-label"), spec.label, spec.exact));
    } else if (spec.placeholder !== undefined) {
      elements = candidates.filter((element) => matches(element.getAttribute("placeholder"), spec.placeholder, spec.exact));
    } else if (spec.text !== undefined) {
      const textMatches = candidates.filter((element) => matches(element.innerText || element.textContent, spec.text, spec.exact));
      const matchingSet = new Set(textMatches);
      const leafMatches = textMatches.filter((element) => !Array.from(element.children).some((child) => matchingSet.has(child)));
      if (options.projectTextToActionable === true) {
        const textTargets = [];
        for (const element of leafMatches) {
          let target = element;
          if (!isActionable(element)) {
            let parent = element.parentElement;
            while (parent) {
              if (matchingSet.has(parent) && isActionable(parent)) {
                target = parent;
                break;
              }
              parent = parent.parentElement;
            }
          }
          textTargets.push(target);
        }
        elements = [...new Set(textTargets)];
      } else {
        elements = leafMatches;
      }
    } else if (spec.testId !== undefined) {
      elements = candidates.filter((element) => element.getAttribute("data-testid") === String(spec.testId));
    }
    if (spec.name !== undefined && spec.role !== undefined) elements = elements.filter((element) => matches(nameOf(element), spec.name, spec.exact));
    if (spec.hasText !== undefined) elements = elements.filter((element) => matches(element.innerText || element.textContent, spec.hasText, spec.exact));
    if (spec.hasSelector !== undefined) elements = elements.filter((element) => selectorElements(element, spec.hasSelector).length > 0);
    const unique = [...new Set(elements)];
    if (spec.index !== undefined) return selectIndexedElement(unique, spec.index, options.indexAfterVisibility === true);
    return unique;
  };
  const describe = (element, includeContent = true) => {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      role: roleOf(element),
      ...(includeContent ? { name: nameOf(element).slice(0, 240), text: isValueBearing(element) ? "" : textOf(element).slice(0, 240) } : {}),
      disabled: isDisabled(element),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  };
  const targetText = (spec) => {
    try { return diagnosticText(JSON.stringify(spec)); } catch (error) { return "the requested element"; }
  };
  const strict = (spec, options = {}) => {
    const elements = elementsFor(spec, options);
    if (elements.length !== 1) {
      const candidates = elements.slice(0, 5).map((element) => describe(element, false));
      const error = new Error(`Locator resolved to ${elements.length} elements; add index or narrow the target.`);
      error.code = elements.length > 1 ? "ELEMENT_TARGET_AMBIGUOUS" : "ELEMENT_TARGET_NOT_FOUND";
      error.details = { count: elements.length, candidates };
      throw error;
    }
    return elements[0];
  };
  const waitForElement = async (spec, timeoutMs) => {
    const deadline = Date.now() + timeoutLimit(timeoutMs, 5000, 30000);
    let lastCount = 0;
    while (Date.now() < deadline) {
      if (containsRefTarget(spec)) requireCurrentSnapshot();
      const found = elementsFor(spec, { projectTextToActionable: true, indexAfterVisibility: true }).filter(isInteractable);
      lastCount = found.length;
      if (found.length === 1) {
        if (isDisabled(found[0])) {
          const error = new Error(`Element target is disabled: ${targetText(spec)}`);
          error.code = "ELEMENT_TARGET_DISABLED";
          throw error;
        }
        return found[0];
      }
      if (found.length > 1) {
        const candidates = found.slice(0, 5).map((element) => describe(element, false));
        const error = new Error(`Element target matched ${found.length} visible elements; add index or narrow the target.`);
        error.code = "ELEMENT_TARGET_AMBIGUOUS";
        error.details = { count: found.length, candidates };
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const error = new Error(`Timed out waiting for visible element target (${lastCount} matches): ${targetText(spec)}`);
    error.code = "ELEMENT_TARGET_NOT_FOUND";
    error.details = { count: lastCount };
    throw error;
  };
  const pageVisibleText = (root = document.body) => {
    if (!root) return "";
    const walker = document.createTreeWalker(root, 4);
    const parts = [];
    let node = walker.nextNode();
    while (node) {
      if (node.parentElement && isVisible(node.parentElement)) parts.push(node.nodeValue || "");
      node = walker.nextNode();
    }
    return normalize(parts.join(" "));
  };
  const pageTextMatches = (text, exact) => {
    if (exact === true) {
      return [document.body, ...Array.from(document.querySelectorAll("body *"))]
        .filter((element) => element && isVisible(element))
        .some((element) => matches(pageVisibleText(element), text, true));
    }
    return matches(pageVisibleText(), text, false);
  };
  const containsRefTarget = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value) && (value.ref !== undefined || ((value.combine === "and" || value.combine === "or") && (containsRefTarget(value.left) || containsRefTarget(value.right)))));
  const staleSnapshotError = () => {
    const error = new Error("Snapshot is stale; take a new browser_snapshot before using this ref");
    error.code = "STALE_SNAPSHOT";
    error.details = { snapshotId: params.snapshotId };
    return error;
  };
  const requireCurrentSnapshot = () => {
    const currentSnapshotId = document.documentElement?.getAttribute("data-pi-snapshot-id");
    const expectedFingerprint = params.__expectedSnapshotFingerprint;
    const expectedUrl = params.__expectedSnapshotUrl;
    const expectedTimeOrigin = params.__expectedSnapshotTimeOrigin;
    const expectedToken = params.__expectedSnapshotToken;
    const currentToken = globalThis["__piControlChromeDocumentToken"];
    if (typeof params.snapshotId !== "string" || !params.snapshotId || currentSnapshotId !== params.snapshotId
      || typeof expectedFingerprint !== "string" || domFingerprint() !== expectedFingerprint
      || typeof expectedUrl !== "string" || location.href !== expectedUrl
      || (typeof expectedTimeOrigin === "number" && performance.timeOrigin !== expectedTimeOrigin)
      || (typeof expectedToken === "string" && currentToken !== expectedToken)) throw staleSnapshotError();
  };
  if (params.pageOperation === "wait") {
    const state = String(params.state || "load");
    if (state === "text" || state === "text_gone") {
      if (typeof params.text !== "string" || !normalize(params.text)) throw new Error(`${state} wait requires text`);
      const present = pageTextMatches(params.text, params.exact);
      return { matched: state === "text" ? present : !present };
    }
    if (!["visible", "hidden", "enabled"].includes(state)) throw new Error(`Unsupported page wait state: ${state}`);
    if (containsRefTarget(params.target)) requireCurrentSnapshot();
    const found = elementsFor(params.target, { projectTextToActionable: true, indexAfterVisibility: state !== "hidden" });
    const visible = found.filter(isVisible);
    if (state === "hidden") return { matched: visible.length === 0, count: visible.length };
    if (visible.length > 1) {
      const candidates = visible.slice(0, 5).map((element) => describe(element, false));
      const error = new Error(`Element target matched ${visible.length} visible elements; narrow the target before waiting for ${state}.`);
      error.code = "ELEMENT_TARGET_AMBIGUOUS";
      error.details = { count: visible.length, candidates };
      throw error;
    }
    if (state === "visible") return {
      matched: visible.length === 1,
      count: visible.length,
      ...(visible.length === 1 ? { element: describe(visible[0]) } : {}),
    };
    const enabled = visible.length === 1 && !isDisabled(visible[0]);
    return {
      matched: enabled,
      count: visible.length,
      ...(visible.length === 1 ? { element: describe(visible[0]) } : {}),
    };
  }
  if (params.pageOperation === "interaction") {
    const targetUsesRef = containsRefTarget(params.target);
    if (params.ref !== undefined || targetUsesRef) {
      requireCurrentSnapshot();
    } else if (params.snapshotId !== undefined) {
      requireCurrentSnapshot();
    }
    let element;
    if (params.operation === "scroll") {
      window.scrollBy(Number(params.deltaX || 0), Number(params.deltaY || 0));
      return { ok: true, operation: params.operation };
    }
    if (params.target !== undefined) {
      if (params.ref !== undefined || params.selector !== undefined) throw new Error("Element target cannot be combined with ref or selector");
      element = await waitForElement(params.target, params.timeoutMs);
    } else if (params.selector) {
      element = await waitForElement({ selector: String(params.selector) }, params.timeoutMs);
    } else if (/^e\d+$/.test(String(params.ref || ""))) {
      element = await waitForElement({ ref: String(params.ref) }, params.timeoutMs);
    }
    if (!element) throw new Error(`Element not found: ${params.target ? targetText(params.target) : params.ref || params.selector || "unknown"}`);
    if (params.operation === "click") element.click();
    else if (params.operation === "double_click") dispatchDoubleClick(element);
    else if (params.operation === "focus") element.focus();
    else if (params.operation === "hover") element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    else if (params.operation === "fill") {
      requireEditable(element, params.target || params.ref || params.selector);
      element.focus();
      const text = String(params.value ?? "");
      if ("value" in element) {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(element, text); else element.value = text;
      } else document.execCommand("selectAll", false);
      if (!("value" in element)) document.execCommand("insertText", false, text);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (params.operation === "type") {
      requireEditable(element, params.target || params.ref || params.selector);
      element.focus();
      const text = String(params.value ?? "");
      if ("value" in element) {
        const current = String(element.value || "");
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(element, current + text); else element.value = current + text;
        element.dispatchEvent(new Event("input", { bubbles: true }));
      } else document.execCommand("insertText", false, text);
    } else if (params.operation === "press") {
      element.focus();
      const key = String(params.key || "Enter");
      const keydown = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true });
      element.dispatchEvent(keydown);
      element.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true }));
      if (key === "Enter" && !keydown.defaultPrevented && element.form) element.form.requestSubmit?.();
    } else if (params.operation === "select") {
      const values = Array.isArray(params.value) ? params.value.map(String) : [String(params.value ?? "")];
      if (element.tagName.toLowerCase() !== "select") throw new Error("select requires a <select> element");
      if (!element.multiple && values.length > 1) throw new Error("Cannot select multiple values in a single-select element");
      const options = Array.from(element.options);
      if (values.some((value) => !options.some((option) => option.value === value || option.label === value))) throw new Error("Select value did not match any option");
      for (const option of options) option.selected = values.includes(option.value) || values.includes(option.label);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (["check", "uncheck", "set_checked"].includes(params.operation)) {
      const checked = params.operation === "check" ? true : params.operation === "uncheck" ? false : Boolean(params.value);
      if (!("checked" in element)) throw new Error("check/uncheck/set_checked requires a checkbox or radio element");
      if (Boolean(element.checked) !== checked) element.click();
      if (Boolean(element.checked) !== checked) throw new Error(`Could not set checked state to ${checked}`);
    } else throw new Error(`Unsupported interaction operation: ${params.operation}`);
    if (params.target !== undefined) return { ok: true, operation: params.operation, target: params.target, element: describe(element) };
    return { ok: true, operation: params.operation, ref: params.ref || params.selector };
  }
  const locator = params.locator || params.target || { strategy: "css", value: "*" };
  const action = String(params.action || "");
  const usesRef = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value) && (value.ref !== undefined || ((value.combine === "and" || value.combine === "or") && (usesRef(value.left) || usesRef(value.right)))));
  if (usesRef(locator)) {
    requireCurrentSnapshot();
  } else if (params.snapshotId !== undefined) {
    requireCurrentSnapshot();
  }
  const actionProjection = action === "focus" || ["click", "dblclick", "fill", "type", "press", "select", "check", "uncheck", "set_checked", "hover", "isVisible", "isEnabled", "first", "last", "nth"].includes(action);
  const resolve = () => elementsFor(locator, { projectTextToActionable: actionProjection, indexAfterVisibility: actionProjection });
  if (action === "filter") return { ...locator, hasText: params.value !== undefined ? String(params.value) : locator.hasText, hasSelector: params.hasSelector ?? locator.hasSelector };
  if (action === "and" || action === "or") return { combine: action, left: locator, right: params.other };
  if (action === "count") return resolve().length;
  if (action === "all") return resolve().map(describe);
  if (action === "allTextContents") return resolve().map((element) => element.textContent);
  if (action === "first" || action === "last" || action === "nth") return { ...locator, index: action === "first" ? 0 : action === "last" ? Math.max(0, resolve().length - 1) : Number(params.index) };
  if (action === "textContent") return strict(locator, { projectTextToActionable: actionProjection, indexAfterVisibility: actionProjection }).textContent;
  if (action === "innerText") return strict(locator, { projectTextToActionable: actionProjection, indexAfterVisibility: actionProjection }).innerText;
  if (action === "getAttribute") return strict(locator, { projectTextToActionable: actionProjection, indexAfterVisibility: actionProjection }).getAttribute(String(params.attribute));
  if (action === "isVisible") return isVisible(strict(locator, { projectTextToActionable: actionProjection, indexAfterVisibility: actionProjection }));
  if (action === "isEnabled") return !isDisabled(strict(locator, { projectTextToActionable: actionProjection, indexAfterVisibility: actionProjection }));
  if (action === "focus") { const element = actionProjection ? await waitForElement(locator, params.timeoutMs) : strict(locator); element.focus(); return { ok: true }; }
  if (["click", "dblclick", "fill", "type", "press", "select", "check", "uncheck", "set_checked", "hover"].includes(action)) {
    const element = actionProjection ? await waitForElement(locator, params.timeoutMs) : strict(locator);
    if (action === "click") element.click();
    else if (action === "dblclick") dispatchDoubleClick(element);
    else if (action === "hover") element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    else if (action === "fill" || action === "type") {
      requireEditable(element, locator);
      element.focus();
      const text = String(params.value ?? "");
      const current = action === "type" && "value" in element ? String(element.value || "") : "";
      if ("value" in element) {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(element, current + text); else element.value = current + text;
      } else {
        if (action === "fill") document.execCommand("selectAll", false);
        document.execCommand("insertText", false, text);
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      if (action === "fill") element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (action === "press") {
      element.focus();
      const key = String(params.key || "Enter");
      const keydown = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true });
      element.dispatchEvent(keydown);
      element.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true }));
      if (key === "Enter" && !keydown.defaultPrevented && element.form) element.form.requestSubmit?.();
    } else if (action === "select") {
      if (element.tagName.toLowerCase() !== "select") throw new Error("select requires a <select>");
      const values = (Array.isArray(params.value) ? params.value : [params.value]).map(String);
      if (!element.multiple && values.length > 1) throw new Error("Cannot select multiple values in a single-select element");
      const options = Array.from(element.options);
      if (values.some((value) => !options.some((option) => option.value === value || option.label === value))) throw new Error("Select value did not match any option");
      for (const option of options) option.selected = values.includes(option.value) || values.includes(option.label);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const checked = action === "check" ? true : action === "uncheck" ? false : Boolean(params.value);
      if (!("checked" in element)) throw new Error("setChecked requires a checkbox or radio");
      if (Boolean(element.checked) !== checked) element.click();
      if (Boolean(element.checked) !== checked) throw new Error(`Could not set checked state to ${checked}`);
    }
    const rect = element.getBoundingClientRect();
    return { ok: true, element: describe(element), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }
  if (action === "waitFor") {
    const deadline = Date.now() + timeoutLimit(params.timeoutMs, 5000, 30000);
    while (Date.now() < deadline) {
      const found = resolve().filter(isVisible);
      if (found.length > 0) {
        if (usesRef(locator)) requireCurrentSnapshot();
        return { ok: true, count: found.length };
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new Error("Timed out waiting for locator");
  }
  throw new Error(`Unsupported locator action: ${action}`);
  } catch (error) {
    const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    const detectedCode = message.includes("matched ") && message.includes("elements")
      ? "ELEMENT_TARGET_AMBIGUOUS"
      : message.includes("Timed out waiting for visible element target")
        ? "ELEMENT_TARGET_NOT_FOUND"
        : message.includes("disabled")
          ? "ELEMENT_TARGET_DISABLED"
          : message.includes("Invalid CSS selector") || message.includes("Invalid scopeSelector") || message.includes("primary locator") || message.includes("Element target must be") || message.includes("Element ref must")
            ? "INVALID_ELEMENT_TARGET"
            : "BROWSER_ERROR";
    const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : detectedCode;
    const details = error && typeof error === "object" && error.details && typeof error.details === "object" ? error.details : undefined;
    return { __piControlError: true, error: { code, message, ...(details === undefined ? {} : { details }) } };
  }
}

function collectVisibleDom(options = {}) {
  const includeLiveState = true;
  const MAX_CHARS = 100_000;
  const MAX_NODES = 1_000;
  const DEFAULT_CHARS = 20_000;
  const DEFAULT_NODES = 200;
  const valueLimit = (value, fallback, maximum) => {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) throw new Error("DOM output limits must be positive integers");
    return Math.min(number, maximum);
  };
  const maxChars = valueLimit(options.maxChars, DEFAULT_CHARS, MAX_CHARS);
  const maxNodes = valueLimit(options.maxNodes, DEFAULT_NODES, MAX_NODES);
  const bound = (value, limit = 160) => {
    const text = String(value ?? "");
    if (limit <= 0) return "";
    if (text.length <= limit) return text;
    if (limit <= 3) return text.slice(0, limit);
    return `${text.slice(0, limit - 3)}...`;
  };
  const domFingerprint = () => {
    let hash = 2166136261;
    const add = (value) => { for (const character of String(value ?? "")) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); };
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { add(`text:${node.nodeValue}`); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      add(`<${node.tagName}`);
      for (const attribute of Array.from(node.attributes).sort((left, right) => left.name.localeCompare(right.name))) {
        if (attribute.name.startsWith("data-pi-control-chrome-") || ["data-pi-snapshot-id", "data-pi-dom-snapshot-id"].includes(attribute.name)) continue;
        add(`${attribute.name}=${attribute.value}`);
      }
      if (includeLiveState && "value" in node) add(`value:${node.value}`);
      if (includeLiveState && "checked" in node) add(`checked:${node.checked}`);
      if (includeLiveState && "selected" in node) add(`selected:${node.selected}`);
      for (const child of Array.from(node.childNodes)) visit(child);
      add("</>");
    };
    visit(document.documentElement);
    return String(hash >>> 0);
  };
  document.querySelectorAll("[data-pi-control-chrome-dom-id]").forEach((element) => element.removeAttribute("data-pi-control-chrome-dom-id"));
  const snapshotId = crypto.randomUUID();
  const documentTokenKey = "__piControlChromeDocumentToken";
  let documentToken = globalThis[documentTokenKey];
  if (typeof documentToken !== "string" || documentToken.length === 0) {
    documentToken = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    try { Object.defineProperty(globalThis, documentTokenKey, { configurable: false, enumerable: false, value: documentToken }); } catch { globalThis[documentTokenKey] = documentToken; }
  }
  document.documentElement?.setAttribute("data-pi-dom-snapshot-id", snapshotId);
  const observerKey = "__piControlChromeSnapshotObserver";
  globalThis[observerKey]?.disconnect?.();
  const observer = new MutationObserver((mutations) => {
    if (!mutations.some((mutation) => mutation.type === "childList" || mutation.type === "characterData" || (mutation.type === "attributes" && !["data-pi-dom-snapshot-id", "data-pi-snapshot-id"].includes(mutation.attributeName)))) return;
    const root = document.documentElement;
    if (root?.hasAttribute("data-pi-snapshot-id")) root.setAttribute("data-pi-snapshot-id", crypto.randomUUID());
    if (root?.hasAttribute("data-pi-dom-snapshot-id")) root.setAttribute("data-pi-dom-snapshot-id", crypto.randomUUID());
  });
  observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
  globalThis[observerKey] = observer;
  let counter = 0;
  const nodes = [];
  let charCount = 0;
  let truncated = false;
  const root = (() => {
    if (options.selector === undefined) return document.body;
    try {
      const selected = document.querySelector(String(options.selector));
      if (!selected) throw new Error(`DOM selector did not match any element: ${String(options.selector)}`);
      return selected;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("DOM selector did not match")) throw error;
      throw new Error(`Invalid DOM selector: ${String(options.selector)}`);
    }
  })();
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const style = getComputedStyle(current);
      if (current.hidden || String(current.getAttribute("aria-hidden") || "").toLowerCase() === "true" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0 || style.pointerEvents === "none") return false;
      current = current.parentElement;
    }
    return rect.width > 0 && rect.height > 0;
  };
  const isActionable = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = String(element.getAttribute("role") || "").trim().toLowerCase();
    const overflow = getComputedStyle(element).overflow;
    return ["a", "button", "input", "textarea", "select", "option", "summary", "iframe"].includes(tag)
      || role.length > 0
      || element.hasAttribute("contenteditable")
      || element.hasAttribute("tabindex")
      || ["auto", "scroll"].includes(overflow);
  };
  const walk = (element, parentId = undefined) => {
    if (truncated || !visible(element)) return undefined;
    const include = element === root || isActionable(element);
    let currentParent = parentId;
    let node;
    if (include) {
      const id = `d${++counter}`;
      element.setAttribute("data-pi-control-chrome-dom-id", id);
      const rect = element.getBoundingClientRect();
      const text = bound(element.innerText || element.textContent || "");
      node = { node_id: id, parent_id: parentId, tag: element.tagName.toLowerCase(), role: bound(element.getAttribute("role") || "", 64) || undefined, text, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, children: [] };
      const cost = JSON.stringify(node).length + (nodes.length > 0 ? 1 : 0);
      if (nodes.length >= maxNodes || charCount + cost > maxChars) {
        truncated = true;
        element.removeAttribute("data-pi-control-chrome-dom-id");
        return undefined;
      }
      nodes.push(node);
      charCount += cost;
      currentParent = id;
    }
    let firstDescendantId;
    for (const child of Array.from(element.children)) {
      const childStart = nodes.length;
      const childCharCount = charCount;
      const childId = walk(child, currentParent);
      if (childId) {
        if (node) {
          const linkCost = JSON.stringify(childId).length + (node.children.length > 0 ? 1 : 0);
          if (charCount + linkCost > maxChars) {
            nodes.length = childStart;
            charCount = childCharCount;
            truncated = true;
            break;
          }
          node.children.push(childId);
          charCount += linkCost;
        } else {
          firstDescendantId = firstDescendantId || childId;
        }
      }
      if (truncated) break;
    }
    return node?.node_id || firstDescendantId;
  };
  if (root) walk(root);
  const domFingerprintValue = domFingerprint();
  document.documentElement?.setAttribute("data-pi-control-chrome-dom-fingerprint", domFingerprintValue);
  observer.takeRecords();
  return {
    snapshotId,
    __piControlChromeDomFingerprint: domFingerprintValue,
    __piControlChromeDomUrl: location.href,
    __piControlChromeDomTimeOrigin: typeof performance?.timeOrigin === "number" ? performance.timeOrigin : undefined,
    __piControlChromeDomToken: documentToken,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    nodes,
    nodeCount: nodes.length,
    charCount,
    maxChars,
    maxNodes,
    truncated,
  };
}

function runDomCua({ action, nodeId, snapshotId, value, key, deltaX, deltaY, __expectedDomFingerprint, __expectedDomUrl, __expectedDomTimeOrigin, __expectedDomToken }) {
  const includeLiveState = true;
  try {
  const domFingerprint = () => {
    let hash = 2166136261;
    const add = (value) => { for (const character of String(value ?? "")) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); };
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { add(`text:${node.nodeValue}`); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      add(`<${node.tagName}`);
      for (const attribute of Array.from(node.attributes).sort((left, right) => left.name.localeCompare(right.name))) {
        if (attribute.name.startsWith("data-pi-control-chrome-") || ["data-pi-snapshot-id", "data-pi-dom-snapshot-id"].includes(attribute.name)) continue;
        add(`${attribute.name}=${attribute.value}`);
      }
      if (includeLiveState && "value" in node) add(`value:${node.value}`);
      if (includeLiveState && "checked" in node) add(`checked:${node.checked}`);
      if (includeLiveState && "selected" in node) add(`selected:${node.selected}`);
      for (const child of Array.from(node.childNodes)) visit(child);
      add("</>");
    };
    visit(document.documentElement);
    return String(hash >>> 0);
  };
  if (!["get_visible_dom", "click", "double_click", "type", "keypress", "scroll"].includes(action)) throw new Error("DOM CUA action must be get_visible_dom, click, double_click, type, keypress or scroll");
  const expectedFingerprint = __expectedDomFingerprint;
  const currentSnapshotId = document.documentElement?.getAttribute("data-pi-dom-snapshot-id");
  if (nodeId !== undefined && (!snapshotId || currentSnapshotId !== String(snapshotId) || typeof expectedFingerprint !== "string" || domFingerprint() !== expectedFingerprint || typeof __expectedDomUrl !== "string" || location.href !== __expectedDomUrl || (typeof __expectedDomTimeOrigin === "number" && performance.timeOrigin !== __expectedDomTimeOrigin) || (typeof __expectedDomToken === "string" && globalThis["__piControlChromeDocumentToken"] !== __expectedDomToken))) {
    const error = new Error("DOM snapshot is stale; take a new browser_dom_cua get_visible_dom snapshot before using this node");
    error.code = "STALE_DOM_SNAPSHOT";
    error.details = { snapshotId };
    throw error;
  }
  const element = nodeId ? document.querySelector(`[data-pi-control-chrome-dom-id="${CSS.escape(String(nodeId))}"]`) : undefined;
  const isActionable = (target) => {
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    let current = target;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const style = getComputedStyle(current);
      if (current.hidden || String(current.getAttribute("aria-hidden") || "").toLowerCase() === "true" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0 || style.pointerEvents === "none") return false;
      current = current.parentElement;
    }
    return !(target.matches?.(":disabled") || target.disabled || String(target.getAttribute("aria-disabled") || "").toLowerCase() === "true");
  };
  const isEditable = (target) => {
    if (target.readOnly || String(target.getAttribute("aria-readonly") || "").toLowerCase() === "true") return false;
    if (target.isContentEditable === true) return true;
    if (target instanceof HTMLTextAreaElement) return true;
    if (!(target instanceof HTMLInputElement)) return false;
    return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(String(target.type || "text").toLowerCase());
  };
  const dispatchDoubleClick = (target) => {
    for (const detail of [1, 2]) {
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, detail, button: 0, buttons: 1 }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, detail, button: 0, buttons: 0 }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, detail, button: 0, buttons: 0 }));
    }
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window, detail: 2, button: 0, buttons: 0 }));
  };
  if (!element && action !== "get_visible_dom" && nodeId !== undefined) { const error = new Error(`DOM node not found: ${nodeId}`); error.code = "DOM_NODE_NOT_FOUND"; throw error; }
  if (!element && action !== "get_visible_dom" && action !== "scroll") { const error = new Error(`DOM node not found: ${nodeId}`); error.code = "DOM_NODE_NOT_FOUND"; throw error; }
  if (element && action !== "get_visible_dom" && !isActionable(element)) { const error = new Error(`DOM node is not actionable: ${nodeId}`); error.code = "DOM_NODE_NOT_ACTIONABLE"; throw error; }
  if (element && action === "type" && !isEditable(element)) { const error = new Error(`DOM node is not editable: ${nodeId}`); error.code = "DOM_NODE_NOT_EDITABLE"; throw error; }
  if (action === "click") element.click();
  else if (action === "double_click") dispatchDoubleClick(element);
  else if (action === "type") {
    element.focus();
    if ("value" in element) {
      const text = String(value ?? ""); const current = String(element.value || "");
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, current + text); else element.value = current + text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else document.execCommand("insertText", false, String(value ?? ""));
  } else if (action === "keypress") {
    element.focus(); element.dispatchEvent(new KeyboardEvent("keydown", { key: String(key), code: String(key), bubbles: true, cancelable: true })); element.dispatchEvent(new KeyboardEvent("keyup", { key: String(key), code: String(key), bubbles: true }));
  } else if (action === "scroll") {
    if (element) element.scrollBy(Number(deltaX || 0), Number(deltaY || 0)); else window.scrollBy(Number(deltaX || 0), Number(deltaY || 0));
  }
  return { ok: true, action, nodeId };
  } catch (error) {
    const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "BROWSER_ERROR";
    const details = error && typeof error === "object" && error.details && typeof error.details === "object" ? error.details : undefined;
    return { __piControlError: true, error: { code, message, ...(details === undefined ? {} : { details }) } };
  }
}

async function executeInTab(tabId, func, args = [], expectedFence) {
  const fence = expectedFence ?? await tabFenceFor(tabId, true);
  await assertTabFence(tabId, fence, "access");
  let result;
  try {
    result = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  } catch (error) {
    if (isRestrictedPageError(error)) throw pageUnavailableError(tabId);
    throw error;
  }
  if (expectedFence !== undefined) {
    try {
      await assertTabFence(tabId, expectedFence, "access");
    } catch (error) {
      if (error && typeof error === "object") {
        error.code = "BROWSER_OPERATION_UNCERTAIN";
        error.details = { actionState: "unknown", retryable: false, inspectFirst: true, tabId };
      }
      throw error;
    }
  }
  const value = result?.[0]?.result;
  const exceptionDetails = result?.[0]?.exceptionDetails;
  if (value === undefined && exceptionDetails && typeof exceptionDetails === "object") {
    const exception = exceptionDetails.exception && typeof exceptionDetails.exception === "object" ? exceptionDetails.exception : undefined;
    const rawMessage = typeof exception?.description === "string" ? exception.description : typeof exceptionDetails.text === "string" ? exceptionDetails.text : "Injected page script failed";
    const message = rawMessage.replace(/^Error:\s*/, "").slice(0, 1_000);
    const selector = args[0] && typeof args[0] === "object" && typeof args[0].selector === "string" ? args[0].selector : undefined;
    const isMissingSelector = /(?:Snapshot|Extract) selector did not match any element:/.test(message);
    const isInvalidSelector = /Invalid (?:snapshot|extract) selector:/.test(message);
    const error = new Error(message);
    error.code = isMissingSelector ? "BROWSER_SELECTOR_NOT_FOUND" : isInvalidSelector ? "BROWSER_SELECTOR_INVALID" : "BROWSER_SCRIPT_ERROR";
    error.details = { tabId, ...(selector === undefined ? {} : { selector }) };
    throw error;
  }
  if (value && typeof value === "object" && value.__piControlError === true && value.error && typeof value.error.message === "string") {
    const error = new Error(value.error.message);
    error.code = typeof value.error.code === "string" ? value.error.code : "BROWSER_ERROR";
    if (value.error.details && typeof value.error.details === "object") error.details = value.error.details;
    throw error;
  }
  return value;
}

function publicAccessibilityNode(node) {
  if (!isRecordObject(node)) return node;
  const { key: _key, ...publicNode } = node;
  return publicNode;
}

function accessibilityNodeLine(node, prefix = "- ") {
  const role = String(node?.role || "generic").slice(0, 64);
  const name = typeof node?.name === "string" && node.name.length > 0 ? ` ${JSON.stringify(node.name.slice(0, 240))}` : "";
  const value = node?.value === undefined ? "" : ` value=${JSON.stringify(String(node.value).slice(0, 240))}`;
  const disabled = node?.disabled === true ? " disabled" : "";
  const checked = node?.checked === undefined ? "" : ` checked=${node.checked === true}`;
  const level = node?.level === undefined ? "" : ` level=${node.level}`;
  return `${prefix}${role}${name}${value}${disabled}${checked}${level}`;
}

function accessibilityStateText(nodes, prefix = "- ") {
  return nodes.map((node) => accessibilityNodeLine(node, prefix)).join("\n");
}

function accessibilityRevision(tabId, snapshot, accessibility, diffRequested, remember = true) {
  const rawNodes = Array.isArray(accessibility?.__piControlChromeAccessibilityNodes)
    ? accessibility.__piControlChromeAccessibilityNodes.filter((node) => isRecordObject(node))
    : Array.isArray(accessibility?.children)
      ? accessibility.children.filter((node) => isRecordObject(node))
      : [];
  const key = runtimeStateKey(tabId);
  const generation = {
    url: typeof snapshot?.__piControlChromeSnapshotUrl === "string" ? snapshot.__piControlChromeSnapshotUrl : "",
    timeOrigin: snapshot?.__piControlChromeSnapshotTimeOrigin,
    token: typeof snapshot?.__piControlChromeSnapshotToken === "string" ? snapshot.__piControlChromeSnapshotToken : undefined,
  };
  const previous = accessibilitySnapshotStates.get(key);
  const sameDocument = previous !== undefined
    && previous.url === generation.url
    && previous.timeOrigin === generation.timeOrigin
    && previous.token === generation.token;
  const currentByKey = new Map(rawNodes.map((node, index) => [String(node.key || `${node.role || "generic"}:${index}`), node]));
  const fullState = accessibilityStateText(rawNodes);
  let mode = "full";
  let state = fullState;
  let changedNodeCount = rawNodes.length;
  if (diffRequested && sameDocument && previous) {
    const previousByKey = new Map(previous.nodes.map((node) => [String(node.key || ""), node]));
    const added = rawNodes.filter((node) => !previousByKey.has(String(node.key || "")));
    const changed = rawNodes.filter((node) => {
      const old = previousByKey.get(String(node.key || ""));
      return old !== undefined && JSON.stringify(publicAccessibilityNode(old)) !== JSON.stringify(publicAccessibilityNode(node));
    });
    const removed = previous.nodes.filter((node) => !currentByKey.has(String(node.key || "")));
    changedNodeCount = added.length + changed.length + removed.length;
    const diffLines = [
      ...added.map((node) => accessibilityNodeLine(node, "+ ")),
      ...changed.map((node) => accessibilityNodeLine(node, "~ ")),
      ...removed.map((node) => accessibilityNodeLine(node, "- ")),
    ];
    const diffState = diffLines.join("\n");
    const tooBroad = changedNodeCount > Math.max(1, Math.floor(Math.max(previous.nodes.length, rawNodes.length) / 2));
    if (changedNodeCount === 0) {
      mode = "unchanged";
      state = "";
    } else if (!tooBroad && diffState.length < fullState.length) {
      mode = "diff";
      state = diffState;
    }
  }
  const publicNodes = rawNodes.map(publicAccessibilityNode);
  if (remember) accessibilitySnapshotStates.set(key, {
    snapshotId: String(snapshot?.snapshotId || ""),
    url: generation.url,
    timeOrigin: generation.timeOrigin,
    token: generation.token,
    nodes: rawNodes.map((node) => ({ ...node })),
  });
  return {
    role: "document",
    name: typeof accessibility?.name === "string" ? accessibility.name : "",
    ...(mode === "full" ? { children: publicNodes } : {}),
    state,
    mode,
    baseSnapshotId: previous?.snapshotId,
    nodeCount: publicNodes.length,
    changedNodeCount,
    charCount: state.length,
    truncated: accessibility?.truncated === true,
    maxChars: accessibility?.maxChars,
    maxNodes: accessibility?.maxNodes,
  };
}

function rememberPageSnapshot(tabId, snapshot) {
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.snapshotId !== "string" || typeof snapshot.__piControlChromeSnapshotFingerprint !== "string") return;
  pageSnapshotStates.set(runtimeStateKey(tabId), {
    snapshotId: snapshot.snapshotId,
    fingerprint: snapshot.__piControlChromeSnapshotFingerprint,
    url: typeof snapshot.__piControlChromeSnapshotUrl === "string" ? snapshot.__piControlChromeSnapshotUrl : "",
    timeOrigin: snapshot.__piControlChromeSnapshotTimeOrigin,
    token: typeof snapshot.__piControlChromeSnapshotToken === "string" ? snapshot.__piControlChromeSnapshotToken : undefined,
  });
  delete snapshot.__piControlChromeSnapshotFingerprint;
  delete snapshot.__piControlChromeSnapshotUrl;
  delete snapshot.__piControlChromeSnapshotTimeOrigin;
  delete snapshot.__piControlChromeSnapshotToken;
}

function rememberDomSnapshot(tabId, snapshot) {
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.snapshotId !== "string" || typeof snapshot.__piControlChromeDomFingerprint !== "string") return;
  domSnapshotStates.set(runtimeStateKey(tabId), {
    snapshotId: snapshot.snapshotId,
    fingerprint: snapshot.__piControlChromeDomFingerprint,
    url: typeof snapshot.__piControlChromeDomUrl === "string" ? snapshot.__piControlChromeDomUrl : "",
    timeOrigin: snapshot.__piControlChromeDomTimeOrigin,
    token: typeof snapshot.__piControlChromeDomToken === "string" ? snapshot.__piControlChromeDomToken : undefined,
  });
  delete snapshot.__piControlChromeDomFingerprint;
  delete snapshot.__piControlChromeDomUrl;
  delete snapshot.__piControlChromeDomTimeOrigin;
  delete snapshot.__piControlChromeDomToken;
}

function pageOperationParams(tabId, params = {}) {
  const snapshotId = typeof params.snapshotId === "string" ? params.snapshotId : undefined;
  const state = pageSnapshotStates.get(runtimeStateKey(tabId));
  const match = snapshotId !== undefined && state?.snapshotId === snapshotId;
  return {
    ...params,
    __expectedSnapshotFingerprint: match ? state.fingerprint : undefined,
    __expectedSnapshotUrl: match ? state.url : undefined,
    __expectedSnapshotTimeOrigin: match ? state.timeOrigin : undefined,
    __expectedSnapshotToken: match ? state.token : undefined,
  };
}

function domCuaOperationParams(tabId, params = {}) {
  const snapshotId = typeof params.snapshotId === "string" ? params.snapshotId : undefined;
  const state = domSnapshotStates.get(runtimeStateKey(tabId));
  const match = snapshotId !== undefined && state?.snapshotId === snapshotId;
  return {
    ...params,
    __expectedDomFingerprint: match ? state.fingerprint : undefined,
    __expectedDomUrl: match ? state.url : undefined,
    __expectedDomTimeOrigin: match ? state.timeOrigin : undefined,
    __expectedDomToken: match ? state.token : undefined,
  };
}

function isLostExecutionContext(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /execution context was destroyed|context.*destroyed|frame.*(?:detached|removed|no longer exists)|cannot access (?:contents of )?the page|no frame with given id|receiving end does not exist/.test(message);
}

function pageChangingDuringReadError(method, details = {}) {
  const error = new Error(`Browser ${method} read was not stable because the tab document changed during observation; retry the read on the current tab`);
  error.code = "BROWSER_PAGE_CHANGING";
  error.details = { actionState: "not_completed", retryable: true, inspectFirst: false, pageChanged: true, ...details };
  return error;
}
function isPageChangingDuringRead(error) {
  if (error && typeof error === "object") {
    if (error.code === "BROWSER_PAGE_CHANGING") return true;
    if (error.code === "BROWSER_OPERATION_UNCERTAIN" && error.details?.pageChanged === true) return true;
  }
  return isLostExecutionContext(error);
}
async function readOnlyWithRetry(method, tabId, signal, operation) {
  let lastError;
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    assertRequestActive(signal);
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isPageChangingDuringRead(error)) throw error;
      lastError = error;
      if (attempt === attempts) break;
      await waitWithSignal(25, signal);
    }
  }
  const details = lastError && typeof lastError === "object" && lastError.details && typeof lastError.details === "object" ? lastError.details : {};
  throw pageChangingDuringReadError(method, { tabId: Number(tabId), attempts, ...details });
}

function uncertainPageOperationError() {
  const error = new Error("Browser page operation outcome is uncertain because the page execution context was lost; inspect the page before retrying");
  error.code = "BROWSER_OPERATION_UNCERTAIN";
  error.details = { actionState: "unknown", retryable: false, inspectFirst: true };
  return error;
}

function uncertainScreenshotError() {
  const error = new Error("Browser screenshot outcome is uncertain because the active tab changed during capture; inspect the current tab before retrying");
  error.code = "BROWSER_OPERATION_UNCERTAIN";
  error.details = { actionState: "unknown", retryable: false, inspectFirst: true };
  return error;
}

function isTabFenceError(error) {
  return Boolean(error && typeof error === "object" && ["BROWSER_TAB_FENCE_CHANGED", "BROWSER_TAB_CLOSED"].includes(error.code));
}

function uncertainBrowserOperationError(method, details = {}) {
  const error = new Error(`Browser ${method} operation outcome is uncertain after cancellation or a post-effect wait failure; inspect the current browser state before retrying`);
  error.code = "BROWSER_OPERATION_UNCERTAIN";
  error.details = { actionState: "unknown", retryable: false, inspectFirst: true, ...details };
  return error;
}

async function waitAfterEffect(method, wait, details = {}) {
  try {
    return await wait();
  } catch (error) {
    if (method === "wait" || isTabFenceError(error)) throw error;
    throw uncertainBrowserOperationError(method, details);
  }
}

function isSideEffectingRequest(method, params = {}) {
  if (["navigate", "back", "forward", "reload", "select_tab", "new_tab", "close_tab", "upload", "cua", "keypress", "dom_cua", "cleanup"].includes(method)) return method !== "dom_cua" || params.action !== "get_visible_dom";
  if (method === "interaction") return isSideEffectingPageOperation(params);
  if (method === "locator") return SIDE_EFFECTING_PAGE_ACTIONS.has(String(params.action || ""));
  if (method === "download") return !["list", "wait"].includes(String(params.action || ""));
  if (method === "clipboard") return params.action === "write";
  if (method === "dialog") return ["accept", "dismiss"].includes(String(params.action || ""));
  if (method === "console_logs" || method === "network_requests") return params.clear === true;
  if (["devtools_enable", "devtools_disable"].includes(method)) return true;
  if (["evaluate", "cdp", "select_tab", "release", "claim_tab", "mark_handoff", "mark_deliverable"].includes(method)) return true;
  return false;
}

const LOCATOR_ACTIONS = new Set(["click", "dblclick", "fill", "type", "press", "select", "check", "uncheck", "set_checked", "hover", "focus", "waitFor"]);
const SIDE_EFFECTING_PAGE_ACTIONS = new Set(["click", "double_click", "dblclick", "fill", "type", "press", "select", "check", "uncheck", "set_checked", "hover", "focus", "scroll"]);

function isSideEffectingPageOperation(params) {
  return SIDE_EFFECTING_PAGE_ACTIONS.has(String(params.operation || params.action || ""));
}

const STRUCTURED_PAGE_ERROR_CODES = new Set(["ELEMENT_NOT_EDITABLE", "ELEMENT_TARGET_AMBIGUOUS", "ELEMENT_TARGET_NOT_FOUND", "ELEMENT_TARGET_DISABLED", "INVALID_ELEMENT_TARGET", "STALE_SNAPSHOT", "STALE_DOM_SNAPSHOT", "DOM_NODE_NOT_FOUND", "DOM_NODE_NOT_ACTIONABLE", "DOM_NODE_NOT_EDITABLE", "BROWSER_TAB_FENCE_CHANGED", "BROWSER_TAB_CLOSED", "BROWSER_OPERATION_UNCERTAIN", "BROWSER_PAGE_CHANGING"]);

function isStructuredPageError(error) {
  return Boolean(error && typeof error === "object" && STRUCTURED_PAGE_ERROR_CODES.has(error.code));
}

function uncertainPageFailure(params, error) {
  if (!isSideEffectingPageOperation(params) || isStructuredPageError(error)) return error;
  const uncertain = uncertainBrowserOperationError(params.pageOperation || params.operation || "page", { action: String(params.action || params.operation || "") });
  uncertain.cause = error;
  return uncertain;
}

function isSemanticLocator(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.combine === "and" || value.combine === "or") return isSemanticLocator(value.left) || isSemanticLocator(value.right);
  if (value.strategy !== undefined) return false;
  return ["ref", "selector", "role", "label", "placeholder", "text", "testId"].some((key) => value[key] !== undefined);
}

async function executeWithLocatorWait(tabId, params, signal, expectedFence) {
  const timeoutMs = boundedTimeout(params.timeoutMs, 5000, 30000);
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    assertRequestActive(signal);
    await assertTabFence(tabId, expectedFence, "access");
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const before = await executeInTab(tabId, pageGeneration, [], expectedFence);
      const value = await executeInTab(tabId, pageOperation, [pageOperationParams(tabId, params)], expectedFence);
      const after = await executeInTab(tabId, pageGeneration, [], expectedFence);
      if (!pageGenerationsMatch(before, after)) throw uncertainPageOperationError();
      assertRequestActive(signal);
      return value;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) {
        if (isSideEffectingPageOperation(params)) throw uncertainPageOperationError();
        throw abortError(signal, "Browser request aborted");
      }
      const retryable = (error && typeof error === "object" && error.code === "ELEMENT_TARGET_NOT_FOUND")
        || (String(params.action || "") === "waitFor" && error instanceof Error && error.message === "Timed out waiting for locator");
      if (isLostExecutionContext(error)) {
        if (signal?.aborted) throw abortError(signal, "Browser request aborted");
        if (String(params.action || "") === "waitFor") {
          await waitWithSignal(Math.min(100, remaining), signal);
          continue;
        }
        throw uncertainPageOperationError();
      }
      if (!retryable) throw error;
      await waitWithSignal(Math.min(100, remaining), signal);
    }
  }
  throw lastError || new Error("Timed out waiting for element target");
}

async function executeLocatorOperation(tabId, params, signal, expectedFence) {
  return executeWithLocatorWait(tabId, { ...params, pageOperation: "locator" }, signal, expectedFence);
}

async function executeDomCuaOperation(tabId, params, signal, expectedFence) {
  try {
    const before = await executeInTab(tabId, pageGeneration, [], expectedFence);
    const value = await executeInTab(tabId, runDomCua, [domCuaOperationParams(tabId, params)], expectedFence);
    const after = await executeInTab(tabId, pageGeneration, [], expectedFence);
    if (!pageGenerationsMatch(before, after)) throw uncertainPageOperationError();
    if (signal?.aborted && params.action !== "get_visible_dom") throw uncertainPageOperationError();
    return value;
  } catch (error) {
    if (isLostExecutionContext(error)) throw uncertainPageOperationError();
    if (signal?.aborted && params.action !== "get_visible_dom") throw uncertainPageOperationError();
    throw uncertainPageFailure(params, error);
  }
}

function pageGenerationIdentity(generation) {
  if (!generation || typeof generation.url !== "string" || typeof generation.timeOrigin !== "number" || typeof generation.token !== "string") return undefined;
  return `${generation.url}\u0000${generation.timeOrigin}\u0000${generation.token}`;
}
function pageGenerationsMatch(left, right) {
  return Boolean(left && right
    && left.url === right.url
    && left.timeOrigin === right.timeOrigin
    && typeof left.token === "string"
    && typeof right.token === "string"
    && left.token === right.token);
}

async function executePageOperation(tabId, params, signal, expectedFence) {
  try {
    const before = await executeInTab(tabId, pageGeneration, [], expectedFence);
    const value = params.pageOperation === "interaction" && params.target !== undefined
      ? await executeWithLocatorWait(tabId, params, signal, expectedFence)
      : await executeInTab(tabId, pageOperation, [pageOperationParams(tabId, params)], expectedFence);
    const after = await executeInTab(tabId, pageGeneration, [], expectedFence);
    if (!pageGenerationsMatch(before, after)) throw uncertainPageOperationError();
    if (signal?.aborted) {
      if (isSideEffectingPageOperation(params)) throw uncertainPageOperationError();
      throw abortError(signal, "Browser request aborted");
    }
    if (value === null || value === undefined) throw uncertainPageOperationError();
    return value;
  } catch (error) {
    if (signal?.aborted) {
      if (isSideEffectingPageOperation(params)) throw uncertainPageOperationError();
      throw abortError(signal, "Browser request aborted");
    }
    if (isLostExecutionContext(error)) throw uncertainPageOperationError();
    throw uncertainPageFailure(params, error);
  }
}

async function executeReadOnlyPageOperation(tabId, params, signal, expectedFence) {
  if (signal?.aborted) throw abortError(signal, "Browser request aborted");
  await assertTabFence(tabId, expectedFence, "access");
  try {
    const before = await executeInTab(tabId, pageGeneration, [], expectedFence);
    const value = await executeInTab(tabId, pageOperation, [pageOperationParams(tabId, params)], expectedFence);
    const after = await executeInTab(tabId, pageGeneration, [], expectedFence);
    if (!before || !after || before.url !== after.url || before.timeOrigin !== after.timeOrigin || typeof before.token !== "string" || typeof after.token !== "string" || before.token !== after.token) return undefined;
    return { value, generation: after };
  } catch (error) {
    if (isTabFenceError(error) || error?.code === "BROWSER_OPERATION_UNCERTAIN") throw error;
    if (isLostExecutionContext(error)) {
      if (signal?.aborted) throw abortError(signal, "Browser request aborted");
      return undefined;
    }
    throw error;
  }
}

function pageGeneration() {
  const tokenKey = "__piControlChromeDocumentToken";
  let token = globalThis[tokenKey];
  if (typeof token !== "string" || token.length === 0) {
    token = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    try { Object.defineProperty(globalThis, tokenKey, { configurable: false, enumerable: false, value: token }); } catch { globalThis[tokenKey] = token; }
  }
  return {
    url: location.href,
    timeOrigin: typeof performance?.timeOrigin === "number" ? performance.timeOrigin : undefined,
    token,
  };
}

function isRestrictedPageError(error) {
  if (error && typeof error === "object" && error.code === "BROWSER_PAGE_UNAVAILABLE") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /cannot access (?:contents of (?:the )?(?:page|url)|(?:the )?page)|extensions (?:gallery|store)|refused to execute script|frame with id .* showing error page|showing error page/.test(message);
}
function pageUnavailableError(tabId) {
  const error = new Error(`Tab ${Number(tabId)} is a browser error page or restricted page and cannot be scripted; navigate it to a scriptable page, then take a new browser_tabs snapshot`);
  error.code = "BROWSER_PAGE_UNAVAILABLE";
  error.details = { tabId: Number(tabId), pageIdentityVerified: false };
  return error;
}
function browserTargetMismatchError(expectedBrowserId) {
  const currentBrowserId = browserIdentity().browserId;
  const error = new Error(`Tab handle belongs to browser target ${String(expectedBrowserId)}; current target is ${currentBrowserId}. Refresh browser_status and browser_tabs before retrying`);
  error.code = "BROWSER_TARGET_MISMATCH";
  error.details = { expectedBrowserId: String(expectedBrowserId), currentBrowserId };
  return error;
}
function documentIdentityUnavailableError(tabId, action) {
  const error = pageUnavailableError(tabId);
  error.message = `Cannot ${String(action)} tab ${Number(tabId)}; its document identity could not be verified because the page is restricted or a browser error page. Navigate it to a scriptable page, then take a new browser_tabs snapshot`;
  error.details = { tabId: Number(tabId), action: String(action), pageIdentityVerified: false };
  return error;
}

async function readTabIncarnation(tabId, expectedFence, readOnly = false) {
  if (!chrome.scripting?.executeScript) return undefined;
  try {
    const first = await executeInTab(tabId, pageGeneration, [], expectedFence);
    const firstIdentity = pageGenerationIdentity(first);
    if (firstIdentity === undefined) return undefined;
    const second = await executeInTab(tabId, pageGeneration, [], expectedFence);
    const secondIdentity = pageGenerationIdentity(second);
    if (secondIdentity === undefined) return undefined;
    if (firstIdentity !== secondIdentity) throw readOnly ? pageChangingDuringReadError("document", { tabId: Number(tabId), pageChanged: true }) : uncertainBrowserOperationError("document", { tabId: Number(tabId), pageChanged: true });
    return firstIdentity;
  } catch (error) {
    if (error && typeof error === "object" && ["BROWSER_TAB_FENCE_CHANGED", "BROWSER_TAB_CLOSED", "BROWSER_OPERATION_UNCERTAIN"].includes(error.code)) throw error;
    if (isRestrictedPageError(error)) return undefined;
    throw error;
  }
  return undefined;
}
async function assertPageGenerationStable(tabId, expectedFence, generation, action, readOnly = false) {
  if (!generation || typeof generation.url !== "string" || typeof generation.timeOrigin !== "number") {
    throw readOnly ? pageChangingDuringReadError(action, { tabId: Number(tabId), pageGenerationUnavailable: true }) : uncertainBrowserOperationError(action, { tabId: Number(tabId), pageGenerationUnavailable: true });
  }
  const current = await executeInTab(tabId, pageGeneration, [], expectedFence);
  await assertTabFence(tabId, expectedFence, action);
  if (!current || current.url !== generation.url || current.timeOrigin !== generation.timeOrigin || typeof generation.token !== "string" || typeof current.token !== "string" || current.token !== generation.token) {
    throw readOnly ? pageChangingDuringReadError(action, { tabId: Number(tabId), pageChanged: true }) : uncertainBrowserOperationError(action, { tabId: Number(tabId), pageChanged: true });
  }
}
function tabUrlMatches(tab, params = {}) {
  const url = String(tab.url || "");
  if (params.url !== undefined && url !== String(params.url)) return false;
  if (params.urlIncludes !== undefined && !url.includes(String(params.urlIncludes))) return false;
  return true;
}

async function waitForPageCondition(tabId, params = {}, signal, expectedFence, expectedIncarnation) {
  const timeoutMs = boundedTimeout(params.timeoutMs, 30000, 120000);
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let lastResult;
  let lastTab;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError(signal, "Browser request aborted");
    const tab = await chrome.tabs.get(Number(tabId));
    lastTab = tab;
    await assertTabFence(tabId, expectedFence, "wait");
    assertRequestActive(signal);
    if (Date.now() >= deadline) break;
    if (tabUrlMatches(tab, params)) {
      const observedUrl = String(tab.url || "");
      const observedPage = await executeReadOnlyPageOperation(tabId, { ...params, pageOperation: "wait" }, signal, expectedFence);
      if (expectedIncarnation !== undefined && pageGenerationIdentity(observedPage?.generation) !== expectedIncarnation) {
        const stale = new Error(`Tab ${tabId} document changed while waiting; take a new browser_tabs snapshot`);
        stale.code = "BROWSER_TAB_FENCE_CHANGED";
        stale.details = { tabId: Number(tabId), expectedIncarnation };
        throw stale;
      }
      lastResult = observedPage?.value;
      assertRequestActive(signal);
      if (Date.now() >= deadline) break;
      if (lastResult?.matched === true) {
        const currentTab = await chrome.tabs.get(Number(tabId));
        await assertTabFence(tabId, expectedFence, "wait");
        assertRequestActive(signal);
        if (Date.now() >= deadline) break;
        let currentGeneration;
        try {
          currentGeneration = await executeInTab(tabId, pageGeneration, [], expectedFence);
        } catch (error) {
          if (isLostExecutionContext(error)) {
            await waitWithSignal(Math.min(100, Math.max(1, deadline - Date.now())), signal);
            continue;
          }
          throw error;
        }
        assertRequestActive(signal);
        const urlStable = observedUrl === String(currentTab.url || "");
        const generationStable = observedPage?.generation?.url === currentGeneration?.url
          && observedPage?.generation?.timeOrigin === currentGeneration?.timeOrigin
          && typeof observedPage?.generation?.token === "string"
          && typeof currentGeneration?.token === "string"
          && observedPage.generation.token === currentGeneration.token;
        if (urlStable && generationStable && tabUrlMatches(currentTab, params)) return { result: { ...lastResult, elapsedMs: Date.now() - startedAt }, generation: currentGeneration };
        lastResult = { ...lastResult, matched: false, urlMatched: false };
      }
    } else {
      lastResult = { matched: false, urlMatched: false };
    }
    await waitWithSignal(100, signal);
  }
  const state = String(params.state || "load");
  const matchCount = typeof lastResult?.count === "number" ? lastResult.count : undefined;
  const count = matchCount === undefined ? "" : ` (${matchCount} matches)`;
  const error = new Error(`Timed out waiting for page condition ${state}${count}`);
  error.code = "BROWSER_WAIT_TIMEOUT";
  error.details = {
    tabId: Number(tabId),
    state,
    ...(matchCount === undefined ? {} : { count: matchCount }),
    ...(lastTab?.title === undefined ? {} : { title: String(lastTab.title || "") }),
    ...(lastTab?.url === undefined ? {} : { url: String(lastTab.url || "") }),
  };
  throw error;
}

function clearDebuggerLease(record) {
  if (record?.releaseTimer !== undefined) {
    clearTimeout(record.releaseTimer);
    record.releaseTimer = undefined;
  }
}

function scheduleDebuggerDetachRetry(tabId, sessionId, expectedRecord) {
  const id = Number(tabId);
  const record = expectedRecord ?? persistentDebuggers.get(runtimeStateKey(id));
  if (!record || persistentDebuggers.get(runtimeStateKey(id)) !== record || record.sessionId !== sessionKey(sessionId) || Number(record.activeUsers || 0) > 0 || (record.lease !== true && record.detachPending !== true)) return;
  clearDebuggerLease(record);
  record.releaseTimer = setTimeout(() => {
    const current = persistentDebuggers.get(runtimeStateKey(id));
    if (!current || current !== record || current.sessionId !== sessionKey(sessionId) || Number(current.activeUsers || 0) > 0 || current.detaching) return;
    detachDebugger(id, sessionId, record.tabFence, { record, attachEpoch: record.attachEpoch, tabFence: record.tabFence }).catch((error) => {
      log("debugger detach retry failed", error);
      scheduleDebuggerDetachRetry(id, sessionId, record);
    });
  }, DEBUGGER_LEASE_IDLE_MS);
  record.releaseTimer.unref?.();
}

function scheduleDebuggerRelease(tabId, sessionId, expectedRecord) {
  const id = Number(tabId);
  const record = expectedRecord ?? persistentDebuggers.get(runtimeStateKey(id));
  if (!record || persistentDebuggers.get(runtimeStateKey(id)) !== record || record.lease !== true || record.sessionId !== sessionKey(sessionId) || Number(record.activeUsers || 0) > 0) return;
  scheduleDebuggerDetachRetry(id, sessionId, record);
}

function serializeDebuggerLease(record) {
  return {
    tabId: Number(record.tabId),
    browserId: record.browserId,
    sessionId: record.sessionId,
    tabFence: record.tabFence,
    targetId: record.targetId,
    attachedAt: Number(record.attachedAt || Date.now()),
  };
}

function validDebuggerLease(value) {
  return value && typeof value === "object"
    && Number.isInteger(Number(value.tabId)) && Number(value.tabId) >= 0
    && typeof value.browserId === "string" && value.browserId.length > 0
    && typeof value.sessionId === "string" && value.sessionId.length > 0
    && typeof value.tabFence === "string" && value.tabFence.length > 0
    && typeof value.targetId === "string" && value.targetId.length > 0;
}

async function updatePersistedDebuggerLeases(update) {
  const run = debuggerLeasePersistenceTail.then(async () => {
    const data = await chrome.storage.local.get({ [DEBUGGER_LEASES_KEY]: [] });
    const stored = Array.isArray(data[DEBUGGER_LEASES_KEY]) ? data[DEBUGGER_LEASES_KEY].filter(validDebuggerLease) : [];
    const next = update(stored);
    await chrome.storage.local.set({ [DEBUGGER_LEASES_KEY]: next });
    const check = await chrome.storage.local.get({ [DEBUGGER_LEASES_KEY]: [] });
    const persisted = Array.isArray(check[DEBUGGER_LEASES_KEY]) ? check[DEBUGGER_LEASES_KEY].filter(validDebuggerLease) : [];
    if (!sameStorageValue(persisted, next)) throw uncertainBrowserOperationError("debugger lease", { leasePersistenceUncertain: true });
    return next;
  });
  debuggerLeasePersistenceTail = run.then(() => undefined, () => undefined);
  return run;
}

async function persistDebuggerLease(record) {
  const serialized = serializeDebuggerLease(record);
  await updatePersistedDebuggerLeases((stored) => [
    ...stored.filter((entry) => !(
      entry.browserId === serialized.browserId
      && Number(entry.tabId) === serialized.tabId
      && entry.tabFence === serialized.tabFence
      && entry.targetId === serialized.targetId
    )),
    serialized,
  ]);
}

async function removePersistedDebuggerLease(record) {
  if (!record) return;
  const serialized = serializeDebuggerLease(record);
  await updatePersistedDebuggerLeases((stored) => stored.filter((entry) => !(
    entry.browserId === serialized.browserId
    && Number(entry.tabId) === serialized.tabId
    && entry.tabFence === serialized.tabFence
    && entry.targetId === serialized.targetId
  )));
}

async function persistedDebuggerLeases() {
  const data = await chrome.storage.local.get({ [DEBUGGER_LEASES_KEY]: [] });
  return Array.isArray(data[DEBUGGER_LEASES_KEY]) ? data[DEBUGGER_LEASES_KEY].filter(validDebuggerLease) : [];
}

async function recoverPersistedDebuggerLeases(sessionId, browserId) {
  const requestedSession = sessionKey(sessionId);
  const failures = [];
  const removeLease = async (lease) => {
    try {
      await removePersistedDebuggerLease(lease);
      return true;
    } catch (error) {
      failures.push({ tabId: lease.tabId, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };
  for (const lease of await persistedDebuggerLeases()) {
    if (lease.browserId !== browserId || lease.sessionId !== requestedSession) continue;
    const key = runtimeStateKey(lease.tabId);
    if (persistentDebuggers.has(key) || orphanedDebuggerAttaches.has(key)) continue;
    let currentTab;
    try {
      currentTab = await chrome.tabs.get(lease.tabId);
    } catch (error) {
      if (isMissingTabError(error)) {
        const missingTabInfo = await debuggerTargetInfo(lease.tabId);
        if (missingTabInfo?.attached === false) await removeLease(lease);
        else failures.push({ tabId: lease.tabId, error: "A persisted debugger lease refers to a closed tab whose DevTools state is still unverified" });
        continue;
      }
      failures.push({ tabId: lease.tabId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const currentFence = await tabFenceFor(lease.tabId).catch(() => undefined);
    if (currentFence !== lease.tabFence) {
      failures.push({ tabId: lease.tabId, error: "A persisted debugger lease belongs to an earlier tab incarnation; inspect the current tab before retrying" });
      continue;
    }
    const info = await debuggerTargetInfo(lease.tabId);
    if (info === null || info === undefined) {
      failures.push({ tabId: lease.tabId, error: "A persisted debugger lease could not be verified; inspect the tab before retrying" });
      continue;
    }
    if (info.attached !== true) {
      if (!(await removeLease(lease))) continue;
      continue;
    }
    if (info.targetId !== lease.targetId) {
      failures.push({ tabId: lease.tabId, error: "A persisted debugger lease target changed; inspect the current tab before retrying" });
      continue;
    }
    const beforeFence = await tabFenceFor(lease.tabId).catch(() => undefined);
    const beforeInfo = await debuggerTargetInfo(lease.tabId);
    if (beforeFence !== lease.tabFence || beforeInfo?.attached !== true || beforeInfo.targetId !== lease.targetId) {
      failures.push({ tabId: lease.tabId, error: "A persisted debugger lease changed while cleanup was preparing recovery" });
      continue;
    }
    try {
      await chrome.debugger.detach({ tabId: lease.tabId });
    } catch (error) {
      failures.push({ tabId: lease.tabId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const afterFence = await tabFenceFor(lease.tabId).catch(() => undefined);
    const afterInfo = await debuggerTargetInfo(lease.tabId);
    if (afterFence !== lease.tabFence || afterInfo === null || afterInfo === undefined || afterInfo.attached === true) {
      failures.push({ tabId: lease.tabId, error: "A persisted debugger lease changed while cleanup was detaching it; inspect the tab before retrying" });
      continue;
    }
    if (!(await removeLease(lease))) continue;
    void currentTab;
  }
  return failures;
}

async function debuggerTargetInfo(tabId) {
  try {
    const targets = await chrome.debugger.getTargets();
    const candidates = targets.filter((entry) => Number(entry.tabId) === Number(tabId));
    const pageTargets = candidates.filter((entry) => entry.type === undefined || entry.type === "page");
    if (pageTargets.length > 1) return undefined;
    const target = pageTargets[0];
    if (!target) {
      try {
        await chrome.tabs.get(Number(tabId));
        return { attached: false };
      } catch (error) {
        if (isMissingTabError(error)) return { attached: false };
        return null;
      }
    }
    const targetId = typeof target.id === "string" && target.id.length > 0 ? target.id : typeof target.targetId === "string" && target.targetId.length > 0 ? target.targetId : undefined;
    return {
      attached: target.attached === true,
      ...(targetId === undefined ? {} : { targetId }),
    };
  } catch {
    return null;
  }
}

async function debuggerTargetAttached(tabId) {
  const info = await debuggerTargetInfo(tabId);
  return info === undefined ? undefined : info === null ? null : info.attached;
}

function debuggerSourceMatches(record, source) {
  if (source?.targetId === undefined) return Number(record?.tabId) === Number(source?.tabId);
  return typeof record?.targetId === "string" && record.targetId === source.targetId;
}

function stageDebuggerOrphan(tabId, orphan) {
  const id = Number(tabId);
  const key = runtimeStateKey(id);
  if (debuggerAttachEpoch(id) !== orphan.epoch || persistentDebuggers.has(key) || tabRemovalTombstones.get(key)?.superseded === true || tabRemovalTombstones.get(key)?.replaced === true) return false;
  const current = orphanedDebuggerAttaches.get(key);
  if (current && Number(current.epoch || 0) > Number(orphan.epoch || 0)) return false;
  orphanedDebuggerAttaches.set(key, { ...orphan, pendingProbe: true });
  return true;
}

async function storeDebuggerOrphan(tabId, orphan, expectedPending) {
  const id = Number(tabId);
  const key = runtimeStateKey(id);
  if (debuggerAttachEpoch(id) !== orphan.epoch || persistentDebuggers.has(key) || tabRemovalTombstones.get(key)?.superseded === true || tabRemovalTombstones.get(key)?.replaced === true) return false;
  const pending = expectedPending ?? debuggerAttachers.get(key);
  if (expectedPending !== undefined && debuggerAttachers.get(key) && debuggerAttachers.get(key) !== expectedPending) return false;
  if (pending && pending.epoch !== orphan.epoch) return false;
  let currentFence;
  try {
    currentFence = await tabFenceFor(id);
    await chrome.tabs.get(id);
  } catch {
    return false;
  }
  const currentPending = debuggerAttachers.get(key);
  const currentTombstone = tabRemovalTombstones.get(key);
  const pendingIdentityChanged = expectedPending === undefined ? pending !== currentPending : currentPending !== undefined && currentPending !== expectedPending;
  if (pendingIdentityChanged || (currentPending && currentPending.epoch !== orphan.epoch) || currentTombstone?.superseded === true || currentTombstone?.replaced === true || currentFence !== orphan.tabFence || debuggerAttachEpoch(id) !== orphan.epoch || persistentDebuggers.has(key)) return false;
  const current = orphanedDebuggerAttaches.get(key);
  if (current && Number(current.epoch || 0) > Number(orphan.epoch || 0)) return false;
  orphanedDebuggerAttaches.set(key, orphan);
  return true;
}

async function attachDebugger(tabId, sessionId, options = {}, expectedFence) {
  await ensureProfileIdentity();
  const id = Number(tabId);
  const currentFence = await tabFenceFor(id, true);
  if (expectedFence !== undefined && currentFence !== expectedFence) throw new Error(`Cannot attach DevTools for tab ${id}; its tab incarnation changed; inspect the current browser state before retrying`);
  const tabFence = expectedFence ?? currentFence;
  const requestedSession = sessionKey(sessionId);
  let existing = persistentDebuggers.get(runtimeStateKey(id));
  if (existing?.detaching) {
    await existing.detaching;
    const latest = persistentDebuggers.get(runtimeStateKey(id));
    if (latest && (latest !== existing || latest.tabFence !== tabFence)) throw uncertainBrowserOperationError("devtools_enable", { tabId: id });
    return attachDebugger(id, sessionId, options, expectedFence);
  }
  if (existing) {
    const targetInfo = await debuggerTargetInfo(id);
    const targetAttached = targetInfo === undefined ? undefined : targetInfo === null ? null : targetInfo.attached;
    const currentExisting = persistentDebuggers.get(runtimeStateKey(id));
    if (currentExisting !== existing || existing.detaching) {
      if (existing.detaching) await existing.detaching;
      return attachDebugger(id, sessionId, options, expectedFence);
    }
    if (targetAttached === false && currentExisting === existing) {
      invalidateDebuggerAttach(id);
      if (existing.releaseTimer !== undefined) clearTimeout(existing.releaseTimer);
      persistentDebuggers.delete(runtimeStateKey(id));
      devtoolsState.delete(runtimeStateKey(id));
      await removePersistedDebuggerLease(existing);
      existing = undefined;
    } else if (targetAttached !== true) {
      throw uncertainBrowserOperationError("devtools_enable", { tabId: id, debuggerCleanupPending: true });
    } else if (typeof existing.targetId !== "string" || typeof targetInfo?.targetId !== "string" || existing.targetId !== targetInfo.targetId) {
      throw uncertainBrowserOperationError("devtools_enable", { tabId: id, debuggerCleanupPending: true });
    }
  }
  if (existing) {
    if (existing.tabFence !== tabFence) throw new Error(`Cannot use DevTools for tab ${id}; its tab incarnation is unknown; inspect the tab before retrying`);
    if (existing.detaching) {
      await existing.detaching;
      return attachDebugger(id, sessionId, options, expectedFence);
    }
    if (existing.sessionId !== requestedSession) throw new Error(`DevTools for tab ${id} belongs to another Agent session`);
    existing.detachPending = false;
    if (options.lease === true) {
      existing.lease = true;
      existing.closeWhenIdle = false;
    } else {
      clearDebuggerLease(existing);
      existing.lease = false;
      existing.closeWhenIdle = false;
    }
    return;
  }
  const orphan = orphanedDebuggerAttaches.get(runtimeStateKey(id));
  if (orphan) {
    const fence = await tabFenceFor(id);
    const attached = await debuggerTargetAttached(id);
    if (attached === false) {
      orphanedDebuggerAttaches.delete(runtimeStateKey(id));
    } else {
      throw uncertainBrowserOperationError("devtools_enable", { tabId: id, debuggerCleanupPending: true, orphanedFence: orphan.tabFence, currentFence: fence });
    }
  }
  const inFlight = debuggerAttachers.get(runtimeStateKey(id));
  if (inFlight) {
    await inFlight.promise;
    return attachDebugger(id, sessionId, options, expectedFence);
  }
  const attachingEpoch = invalidateDebuggerAttach(id);
  const attaching = (async () => {
    const epoch = attachingEpoch;
    const orphanBase = {
      tabId: id,
      browserId: browserIdentity().browserId,
      sessionId: requestedSession,
      tabFence,
      epoch,
      createdAt: Date.now(),
    };
    try {
      await chrome.debugger.attach({ tabId: id }, "1.3");
    } catch (error) {
      stageDebuggerOrphan(id, orphanBase);
      const info = await debuggerTargetInfo(id);
      if (info?.attached === false) {
        const currentOrphan = orphanedDebuggerAttaches.get(runtimeStateKey(id));
        if (currentOrphan?.epoch === epoch) orphanedDebuggerAttaches.delete(runtimeStateKey(id));
        throw error;
      }
      await storeDebuggerOrphan(id, { ...orphanBase, ...(info?.targetId === undefined ? {} : { targetId: info.targetId }), attachError: error instanceof Error ? error.message : String(error) });
      const uncertain = uncertainBrowserOperationError("devtools_enable", { tabId: id, debuggerCleanupPending: true });
      uncertain.cause = error;
      throw uncertain;
    }
    const targetInfo = await debuggerTargetInfo(id);
    if (targetInfo === null || targetInfo?.attached !== true || typeof targetInfo.targetId !== "string" || targetInfo.targetId.length === 0) {
      stageDebuggerOrphan(id, { ...orphanBase, ...(targetInfo?.targetId === undefined ? {} : { targetId: targetInfo.targetId }) });
      await storeDebuggerOrphan(id, { ...orphanBase, ...(targetInfo?.targetId === undefined ? {} : { targetId: targetInfo.targetId }) });
      throw uncertainBrowserOperationError("devtools_enable", { tabId: id, debuggerCleanupPending: true, targetVerification: "unavailable" });
    }
    const finalTargetInfo = await debuggerTargetInfo(id);
    const currentFence = await tabFenceFor(id);
    const currentPending = debuggerAttachers.get(runtimeStateKey(id));
    if (finalTargetInfo === null || finalTargetInfo?.attached !== true || finalTargetInfo.targetId !== targetInfo.targetId
      || debuggerAttachEpoch(id) !== epoch || currentFence !== tabFence || currentPending?.epoch !== epoch || persistentDebuggers.has(runtimeStateKey(id))) {
      stageDebuggerOrphan(id, { ...orphanBase, targetId: finalTargetInfo?.targetId ?? targetInfo.targetId });
      await storeDebuggerOrphan(id, { ...orphanBase, targetId: finalTargetInfo?.targetId ?? targetInfo.targetId });
      throw uncertainBrowserOperationError("devtools_enable", { tabId: id, debuggerCleanupPending: true });
    }
    orphanedDebuggerAttaches.delete(runtimeStateKey(id));
    const debuggerRecord = {
      tabId: id,
      browserId: browserIdentity().browserId,
      attachedAt: Date.now(),
      attachEpoch: epoch,
      sessionId: requestedSession,
      tabFence,
      targetId: targetInfo.targetId,
      lease: options.lease === true,
      activeUsers: 0,
      closeWhenIdle: false,
      releaseTimer: undefined,
    };
    persistentDebuggers.set(runtimeStateKey(id), debuggerRecord);
    try {
      await persistDebuggerLease(debuggerRecord);
    } catch (error) {
      if (persistentDebuggers.get(runtimeStateKey(id)) === debuggerRecord) debuggerRecord.detachPending = true;
      const uncertain = uncertainBrowserOperationError("devtools_enable", { tabId: id, debuggerCleanupPending: true, leasePersistenceUncertain: true });
      uncertain.cause = error;
      throw uncertain;
    }
    const persistedFence = await tabFenceFor(id).catch(() => undefined);
    const persistedRecord = persistentDebuggers.get(runtimeStateKey(id));
    if (persistedRecord !== debuggerRecord || persistedFence !== tabFence || debuggerAttachEpoch(id) !== epoch) {
      if (persistedRecord === debuggerRecord) debuggerRecord.detachPending = true;
      throw uncertainBrowserOperationError("devtools_enable", { tabId: id, debuggerCleanupPending: true, leasePersistenceChanged: true });
    }
  })();
  debuggerAttachers.set(runtimeStateKey(id), { tabId: id, browserId: browserIdentity().browserId, sessionId: requestedSession, tabFence, epoch: attachingEpoch, promise: attaching });
  try {
    await attaching;
  } finally {
    if (debuggerAttachers.get(runtimeStateKey(id))?.promise === attaching) debuggerAttachers.delete(runtimeStateKey(id));
  }
}

async function acquireDebugger(tabId, sessionId, expectedFence) {
  const id = Number(tabId);
  await attachDebugger(id, sessionId, { lease: true }, expectedFence);
  const record = persistentDebuggers.get(runtimeStateKey(id));
  if (!record || record.sessionId !== sessionKey(sessionId)) throw new Error(`DevTools for tab ${id} is no longer attached`);
  clearDebuggerLease(record);
  record.activeUsers = Number(record.activeUsers || 0) + 1;
  return { record, tabId: id, tabFence: record.tabFence, attachEpoch: record.attachEpoch };
}

async function releaseDebugger(tabId, sessionId, expectedFence, lease) {
  const id = Number(tabId);
  const key = runtimeStateKey(id);
  const current = persistentDebuggers.get(key);
  const record = lease?.record ?? current;
  if (!record) {
    if (lease) throw uncertainBrowserOperationError("devtools", { tabId: id, debuggerCleanupPending: true });
    return;
  }
  if (lease && (current !== record || record.attachEpoch !== lease.attachEpoch || record.tabFence !== lease.tabFence)) {
    throw uncertainBrowserOperationError("devtools", { tabId: id, debuggerCleanupPending: true });
  }
  if (expectedFence !== undefined && record.tabFence !== expectedFence) {
    if (lease) throw uncertainBrowserOperationError("devtools", { tabId: id, debuggerCleanupPending: true });
    return;
  }
  if (sessionKey(sessionId) !== record.sessionId) throw new Error(`DevTools for tab ${id} belongs to another Agent session`);
  record.activeUsers = Math.max(0, Number(record.activeUsers || 0) - 1);
  if (record.activeUsers > 0) return;
  if (record.closeWhenIdle) {
    await detachDebugger(id, sessionId, expectedFence, lease);
    return;
  }
  scheduleDebuggerRelease(id, sessionId, record);
}

async function detachDebugger(tabId, sessionId, expectedFence, lease) {
  await ensureProfileIdentity();
  const id = Number(tabId);
  const key = runtimeStateKey(id);
  const currentRecord = persistentDebuggers.get(key);
  const record = lease?.record ?? currentRecord;
  if (!record) {
    const orphan = orphanedDebuggerAttaches.get(key);
    if (!orphan) {
      const info = await debuggerTargetInfo(id);
      if (info?.attached === false) return;
      throw uncertainBrowserOperationError("devtools_disable", { tabId: id, debuggerCleanupPending: true, untrackedDebugger: true });
    }
    if (orphan.sessionId !== sessionKey(sessionId)) throw new Error(`DevTools for tab ${id} belongs to another Agent session`);
    const currentFence = await tabFenceFor(id).catch(() => undefined);
    if (expectedFence !== undefined && orphan.tabFence !== expectedFence) throw uncertainBrowserOperationError("devtools_disable", { tabId: id, debuggerCleanupPending: true });
    if (currentFence !== orphan.tabFence) throw uncertainBrowserOperationError("devtools_disable", { tabId: id, debuggerCleanupPending: true });
    const info = await debuggerTargetInfo(id);
    if (info?.attached === false) {
      orphanedDebuggerAttaches.delete(key);
      return;
    }
    throw uncertainBrowserOperationError("devtools_disable", { tabId: id, debuggerCleanupPending: true });
  }
  if (lease && (currentRecord !== record || record.attachEpoch !== lease.attachEpoch || record.tabFence !== lease.tabFence)) throw uncertainBrowserOperationError("devtools_disable", { tabId: id, debuggerCleanupPending: true });
  if (expectedFence !== undefined && record.tabFence !== expectedFence) {
    if (lease) throw uncertainBrowserOperationError("devtools_disable", { tabId: id, debuggerCleanupPending: true });
    return;
  }
  if (sessionKey(sessionId) !== record.sessionId) throw new Error(`DevTools for tab ${id} belongs to another Agent session`);
  if (record.detaching) {
    await record.detaching;
    return;
  }
  const detaching = (async () => {
    const currentFence = await tabFenceFor(id);
    if (record.tabFence !== currentFence) throw uncertainBrowserOperationError("devtools_disable", { tabId: id, debuggerCleanupPending: true });
    const currentRecord = persistentDebuggers.get(key);
    if (currentRecord !== record || currentRecord.attachEpoch !== record.attachEpoch) throw uncertainBrowserOperationError("devtools_disable", { tabId: id, debuggerCleanupPending: true });
    const targetInfo = await debuggerTargetInfo(id);
    const targetAttached = targetInfo === undefined ? undefined : targetInfo === null ? null : targetInfo.attached;
    if (targetAttached === true && (typeof record.targetId !== "string" || typeof targetInfo?.targetId !== "string" || record.targetId !== targetInfo.targetId)) {
      record.detachPending = true;
      throw uncertainBrowserOperationError("devtools_disable", { tabId: id, debuggerCleanupPending: true });
    }
    if (targetAttached === false) {
      if (persistentDebuggers.get(key) === record) {
        invalidateDebuggerAttach(id);
        persistentDebuggers.delete(key);
      }
      devtoolsState.delete(key);
      await removePersistedDebuggerLease(record);
      return;
    }
    if (targetAttached !== true) {
      if (persistentDebuggers.get(key) === record) record.detachPending = true;
      throw uncertainBrowserOperationError("devtools_disable", { tabId: id, debuggerCleanupPending: true });
    }
    const finalRecord = persistentDebuggers.get(key);
    const finalFence = await tabFenceFor(id);
    if (finalRecord !== record || finalFence !== record.tabFence) throw uncertainBrowserOperationError("devtools_disable", { tabId: id, debuggerCleanupPending: true });
    clearDebuggerLease(record);
    if (Number(record.activeUsers || 0) > 0) {
      record.closeWhenIdle = true;
      return;
    }
    try {
      await chrome.debugger.detach({ tabId: id });
    } catch (error) {
      if (persistentDebuggers.get(key) === record) record.detachPending = true;
      const uncertain = uncertainBrowserOperationError("devtools_disable", { tabId: id, debuggerCleanupPending: true });
      uncertain.cause = error;
      throw uncertain;
    }
    const afterFence = await tabFenceFor(id).catch(() => undefined);
    const afterRecord = persistentDebuggers.get(key);
    const afterInfo = await debuggerTargetInfo(id);
    if (afterFence !== record.tabFence || (afterRecord && afterRecord !== record) || afterInfo === null || afterInfo === undefined || afterInfo.attached === true) {
      if (afterRecord === record) record.detachPending = true;
      throw uncertainBrowserOperationError("devtools_disable", { tabId: id, debuggerCleanupPending: true });
    }
    if (afterRecord === record) persistentDebuggers.delete(key);
    if (!persistentDebuggers.has(key)) devtoolsState.delete(key);
    await removePersistedDebuggerLease(record);
  })();
  record.detaching = detaching;
  try {
    await detaching;
  } finally {
    if (record.detaching === detaching) record.detaching = undefined;
    if (persistentDebuggers.get(key) === record && record.detachPending === true) scheduleDebuggerDetachRetry(id, sessionId, record);
  }
}

async function debuggerCommand(tabId, method, params = {}, expectedFence, lease) {
  const id = Number(tabId);
  if (lease) {
    const current = persistentDebuggers.get(runtimeStateKey(id));
    if (current !== lease.record || current.attachEpoch !== lease.attachEpoch || current.tabFence !== lease.tabFence) throw uncertainBrowserOperationError(method, { tabId: id, debuggerCleanupPending: true });
  }
  await assertTabFence(id, expectedFence, "use");
  if (lease) {
    const current = persistentDebuggers.get(runtimeStateKey(id));
    if (current !== lease.record || current.attachEpoch !== lease.attachEpoch || current.tabFence !== lease.tabFence) throw uncertainBrowserOperationError(method, { tabId: id, debuggerCleanupPending: true });
  }
  return chrome.debugger.sendCommand({ tabId: id }, method, params);
}

async function withDebugger(tabId, callback, sessionId, expectedFence) {
  const id = Number(tabId);
  const fence = expectedFence ?? await tabFenceFor(id, true);
  await assertTabFence(id, fence, "use");
  const lease = await acquireDebugger(id, sessionId, fence);
  let operationError;
  try {
    const result = await callback((method, params) => debuggerCommand(id, method, params, fence, lease));
    await assertTabFence(id, fence, "use");
    const current = persistentDebuggers.get(runtimeStateKey(id));
    if (current !== lease.record || current.attachEpoch !== lease.attachEpoch || current.tabFence !== lease.tabFence) throw uncertainBrowserOperationError("devtools", { tabId: id, debuggerCleanupPending: true });
    return result;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseDebugger(id, sessionId, fence, lease);
    } catch (error) {
      if (operationError) log(`could not release stale debugger lease for tab ${id}`, error);
      else {
        const uncertain = uncertainBrowserOperationError("devtools", { tabId: id, debuggerCleanupPending: true });
        uncertain.cause = error;
        throw uncertain;
      }
    }
  }
}

async function enableDevtools(tabId, domains = ["Runtime", "Log", "Network", "Page"], sessionId, expectedFence) {
  const id = Number(tabId);
  const lease = await acquireDebugger(id, sessionId, expectedFence);
  let operationError;
  try {
    const enabled = [];
    const failed = [];
    for (const domain of domains) {
      try {
        await debuggerCommand(id, `${domain}.enable`, {}, expectedFence, lease);
        enabled.push(domain);
      } catch (error) {
        if (isTabFenceError(error) || error?.code === "BROWSER_OPERATION_UNCERTAIN") throw error;
        const uncertain = uncertainBrowserOperationError("devtools_enable", { tabId: id, domain, enabled: [...enabled], actionState: "unknown" });
        uncertain.cause = error;
        throw uncertain;
      }
    }
    await assertTabFence(id, expectedFence, "devtools_enable");
    const currentRecord = persistentDebuggers.get(runtimeStateKey(id));
      if (currentRecord !== lease.record || currentRecord.attachEpoch !== lease.attachEpoch || currentRecord.tabFence !== lease.tabFence) throw uncertainBrowserOperationError("devtools_enable", { tabId: id });

      const state = stateForTab(id);
      if (domains.includes("Page")) {
        let frameTree;
        try {
          frameTree = await debuggerCommand(id, "Page.getFrameTree", {}, expectedFence, lease);
        } catch (error) {
          if (isTabFenceError(error) || error?.code === "BROWSER_OPERATION_UNCERTAIN") throw error;
          const uncertain = uncertainBrowserOperationError("devtools_enable", { tabId: id, domain: "Page.getFrameTree", enabled: [...enabled], actionState: "unknown" });
          uncertain.cause = error;
          throw uncertain;
        }
        const frame = frameTree?.frameTree?.frame;
        const frameId = typeof frame?.id === "string" ? frame.id : undefined;
        const loaderId = debuggerLoaderId(frame?.loaderId);
        if (frameId !== undefined) state.mainFrameId = frameId;
        if (frameId !== undefined && loaderId !== undefined) setDebuggerFrameLoader(state, frameId, loaderId);
      }
      state.acceptUnqualifiedEvents = true;
      return { tabId: id, enabled, failed, attached: true };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseDebugger(id, sessionId, expectedFence, lease);
    } catch (error) {
      if (operationError) log(`could not release stale debugger lease for tab ${id}`, error);
      else {
        const uncertain = uncertainBrowserOperationError("devtools_enable", { tabId: id, debuggerCleanupPending: true });
        uncertain.cause = error;
        throw uncertain;
      }
    }
  }
}

async function disableDevtools(tabId, sessionId, expectedFence) {
  await detachDebugger(tabId, sessionId, expectedFence);
  return { tabId: Number(tabId), attached: false };
}

async function waitForTabState(tabId, params = {}, signal, expectedFence, expectedIncarnation) {
  const timeoutMs = boundedTimeout(params.timeoutMs, 30000, 120000);
  const deadline = Date.now() + timeoutMs;
  const assertExpectedIncarnation = async () => {
    if (expectedIncarnation === undefined) return;
    const currentIncarnation = await readTabIncarnation(tabId, expectedFence);
    if (currentIncarnation !== expectedIncarnation) {
      const stale = new Error(`Tab ${tabId} document changed while waiting; take a new browser_tabs snapshot`);
      stale.code = "BROWSER_TAB_FENCE_CHANGED";
      stale.details = { tabId: Number(tabId), expectedIncarnation, currentIncarnation };
      throw stale;
    }
  };
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError(signal, "Browser request aborted");
    const tab = await chrome.tabs.get(Number(tabId));
    await assertTabFence(tabId, expectedFence, "wait");
    await assertExpectedIncarnation();
    assertRequestActive(signal);
    if (Date.now() >= deadline) break;
    const urlMatches = tabUrlMatches(tab, params);
    const stateMatches = (params.state === "url" && urlMatches) || (params.state !== "url" && tab.status === "complete" && urlMatches);
    if (stateMatches) {
      const currentTab = await chrome.tabs.get(Number(tabId));
      await assertTabFence(tabId, expectedFence, "wait");
      await assertExpectedIncarnation();
      assertRequestActive(signal);
      const currentUrlMatches = tabUrlMatches(currentTab, params);
      const currentStateMatches = params.state === "url" ? currentUrlMatches : currentTab.status === "complete" && currentUrlMatches;
      if (currentStateMatches) return currentTab;
    }
    await waitWithSignal(100, signal);
  }
  throw new Error(`Timed out waiting for tab ${tabId}`);
}

async function createTab(params) {
  const creationStartSequence = createdTabEventSequence;
  const creationStartedAt = Date.now();
  const creationFlight = { active: true, url: String(params.url || "about:blank"), startedAt: creationStartedAt, sessionId: sessionKey(params.sessionId) };
  createdTabFlights.add(creationFlight);
  let tab;
  try {
    tab = await chrome.tabs.create({ url: params.url || "about:blank", active: params.active === true });
    creationFlight.tabId = Number(tab.id);
    creationFlight.windowId = Number(tab.windowId);
  } catch (error) {
    creationFlight.active = false;
    createdTabFlights.delete(creationFlight);
    const uncertain = uncertainBrowserOperationError("new_tab", { url: params.url || "about:blank" });
    uncertain.cause = error;
    throw uncertain;
  }
  const createdTabKey = runtimeStateKey(tab.id);
  const creationMarker = createdTabEvents.get(createdTabKey);
  const existingReservation = createdTabReservations.get(createdTabKey);
  if (existingReservation?.active === true) {
    creationFlight.active = false;
    createdTabFlights.delete(creationFlight);
    const uncertain = uncertainBrowserOperationError("new_tab", { tabId: tab.id, concurrentCreation: true, existingReservation: true });
    uncertain.cause = new Error(`Tab ${tab.id} already has an active creation reservation`);
    throw uncertain;
  }
  const matchingMarker = creationMarker && creationMarker.completed !== true && Number(creationMarker.sequence) > creationStartSequence && creationMarker.createdAt >= creationStartedAt && creationMarkerMatches(tab, creationMarker) && typeof creationMarker.fence === "string" ? creationMarker : undefined;
  const currentFence = tabFenceTokens.get(createdTabKey);
  const createdFence = matchingMarker?.fence !== undefined && currentFence === matchingMarker.fence ? matchingMarker.fence : rotateTabFence(tab.id);
  const reservation = {
    tabId: Number(tab.id),
    windowId: tab.windowId,
    url: tab.url || "",
    title: tab.title || "",
    fence: createdFence,
    nonce: crypto.randomUUID(),
    flight: creationFlight,
    createdAt: Date.now(),
    createdAfterSequence: creationStartSequence,
    expiresAt: Date.now() + CREATION_RESERVATION_TTL_MS,
    active: true,
    completed: false,
  };
  reservation.expiryTimer = setTimeout(() => {
    if (createdTabReservations.get(createdTabKey) === reservation) deactivateCreatedTabReservation(createdTabKey, reservation, true);
  }, CREATION_RESERVATION_TTL_MS);
  reservation.expiryTimer.unref?.();
  createdTabReservations.set(createdTabKey, reservation);
  let recorded = false;
  try {
    if (!prepareCreatedTabRuntimeState(tab.id, createdFence)) throw uncertainBrowserOperationError("new_tab", { tabId: tab.id, debuggerCleanupPending: true });
    await recordOwnedTab({ ...tab, groupId: tab.groupId }, params.sessionId, "agent", "temporary", createdFence);
    recorded = true;
    const groupId = await putInPiGroup(tab, createdFence);
    await updateOwnedTab(tab.id, { groupId }, params.sessionId);
    await assertTabFence(tab.id, createdFence, "create");
    const currentTab = await chrome.tabs.get(tab.id);
    await assertTabFence(tab.id, createdFence, "create");
    const listedTab = (await listTabs()).tabs.find((entry) => entry.id === currentTab.id);
    if (!listedTab) throw new Error(`Created tab ${tab.id} was closed before setup completed`);
    if (listedTab.handle?.tabFence !== createdFence) throw new Error(`Created tab ${tab.id} changed before setup completed`);
    await assertTabFence(tab.id, createdFence, "create");
    reservation.completed = true;
    deactivateCreatedTabReservation(createdTabKey, reservation);
    rememberCreatedTabEvent(currentTab, createdFence, true);
    createdTabFlights.delete(creationFlight);
    return { tab: listedTab, groupId, tabFence: createdFence };
  } catch (error) {
    reservation.active = false;
    reservation.rollback = true;
    createdTabFlights.delete(creationFlight);
    let removalConfirmed = false;
    let removalError;
    let ownershipCleanupError;
    let ownershipMayExist = recorded;
    try {
      const currentTab = await chrome.tabs.get(tab.id);
      const currentFence = await tabFenceFor(tab.id);
      const currentReservation = createdTabReservations.get(createdTabKey);
      if (createdFence === undefined || currentReservation !== reservation || currentFence !== createdFence || Number(currentTab.windowId) !== Number(reservation.windowId)) {
        removalError = new Error(`Created tab ${tab.id} is no longer the tab opened by this request`);
      } else {
        const removed = await removeTabWithFence(tab.id, createdFence, "new_tab");
        if (removed === true) removalConfirmed = true;
        try {
          const afterRemovalTab = await chrome.tabs.get(tab.id);
          const afterRemovalFence = await tabFenceFor(tab.id);
          removalError = new Error(`Created tab ${tab.id} remained live after removal; its outcome is uncertain`);
          removalError.code = "BROWSER_OPERATION_UNCERTAIN";
          removalError.details = { tabId: tab.id, afterRemovalFence, expectedFence: createdFence, replacementPresent: Boolean(afterRemovalTab) };
        } catch (afterRemovalError) {
          if (isMissingTabError(afterRemovalError)) removalConfirmed = true;
          else removalError = afterRemovalError;
        }
      }
    } catch (cleanupError) {
      if (isMissingTabError(cleanupError)) removalConfirmed = true;
      else {
        removalError = cleanupError;
        log("could not remove a tab after setup failed", cleanupError);
      }
    }
    try {
      const owned = await ownedTabs();
      const currentRecord = owned[targetStateKey(tab.id)];
      if (currentRecord?.owner === "agent" && currentRecord.sessionId === sessionKey(params.sessionId) && currentRecord.tabFence === createdFence) ownershipMayExist = true;
    } catch (ownershipReadError) {
      ownershipCleanupError = ownershipReadError;
      log("could not verify failed tab creation ownership", ownershipReadError);
    }
    if (ownershipMayExist && removalConfirmed) {
      try {
        const forgotten = await forgetOwnedTab(tab.id, params.sessionId, false, createdFence, true);
        if (!forgotten) {
          const remaining = (await ownedTabs())[targetStateKey(tab.id)];
          if (remaining?.tabFence === createdFence) ownershipCleanupError = new Error(`Ownership for failed tab creation ${tab.id} could not be removed`);
        }
      } catch (cleanupError) {
        ownershipCleanupError = cleanupError;
        log("could not remove the failed tab creation ownership record", cleanupError);
      }
    }
    if (removalError || ownershipCleanupError) {
      deactivateCreatedTabReservation(createdTabKey, reservation);
      const uncertain = uncertainBrowserOperationError("new_tab", { tabId: tab.id, ownershipRetained: Boolean(ownershipCleanupError) || (ownershipMayExist && !removalConfirmed) });

      uncertain.details.cleanupError = String(ownershipCleanupError || removalError);
      uncertain.cause = error;
      throw uncertain;
    }
    deactivateCreatedTabReservation(createdTabKey, reservation);
    const marker = createdTabEvents.get(createdTabKey);
    if (removalConfirmed && marker?.fence === createdFence) createdTabEvents.delete(createdTabKey);
    throw error;
  }
}

async function settleDebuggerAttaches(sessionId, detach) {
  const requestedSession = sessionKey(sessionId);
  const failures = [];
  for (const pending of [...debuggerAttachers.values()]) {
    if (pending.sessionId !== requestedSession) continue;
    let pendingError;
    try {
      await pending.promise;
    } catch (error) {
      pendingError = error;
    }
    const key = runtimeStateKey(pending.tabId);
    const currentPending = debuggerAttachers.get(key);
    if (currentPending && (currentPending !== pending || currentPending.epoch !== pending.epoch || currentPending.tabFence !== pending.tabFence)) continue;
    if (pendingError) {
      const attachedInfo = await debuggerTargetInfo(pending.tabId);
      if (attachedInfo?.attached !== false) {
        await storeDebuggerOrphan(pending.tabId, {
          tabId: pending.tabId,
          browserId: pending.browserId,
          sessionId: requestedSession,
          tabFence: pending.tabFence,
          epoch: pending.epoch,
          createdAt: Date.now(),
          ...(attachedInfo?.targetId === undefined ? {} : { targetId: attachedInfo.targetId }),
          attachError: pendingError instanceof Error ? pendingError.message : String(pendingError),
        }, pending);
      }
      failures.push({ tabId: pending.tabId, error: pendingError instanceof Error ? pendingError.message : String(pendingError) });
      continue;
    }
    if (!detach) continue;
    const record = persistentDebuggers.get(key);
    if (!record || record.attachEpoch !== pending.epoch || record.tabFence !== pending.tabFence || record.sessionId !== requestedSession) continue;
    try {
      await detachDebugger(pending.tabId, sessionId, pending.tabFence, { record, attachEpoch: pending.epoch, tabFence: pending.tabFence });
    } catch (error) {
      failures.push({ tabId: pending.tabId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return failures;
}

function isMissingTabError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:no|cannot find|could not find) tab(?: with)?(?: id)?\s*[:#-]?\s*\d+|tab (?:not found|does not exist)/i.test(message);
}
function isRecoverableStaleOwnershipError(error) {
  return Boolean(error && typeof error === "object" && ["BROWSER_TAB_CLOSED", "BROWSER_TAB_FENCE_CHANGED"].includes(error.code));
}

async function cleanup(params) {
  await ensureProfileIdentity();
  const sessionId = sessionKey(params.sessionId);
  const detachDevtools = params.detachDevtools !== false;
  const recoverStale = params.recoverStale === true;
  const turnCleanup = params.mode === "turn";
  const turnId = params.turnId === undefined || params.turnId === null ? undefined : String(params.turnId);
  const targetId = browserIdentity().browserId;
  if (turnCleanup && turnId === undefined) throw new Error("Turn cleanup requires turnId");
  const debuggerFailures = detachDevtools ? await settleDebuggerAttaches(sessionId, detachDevtools) : [];
  if (detachDevtools && !recoverStale) {
    for (const lease of await persistedDebuggerLeases()) {
      const key = runtimeStateKey(lease.tabId);
      if (lease.browserId === targetId && lease.sessionId === sessionId && !persistentDebuggers.has(key) && !orphanedDebuggerAttaches.has(key)) {
        debuggerFailures.push({ tabId: lease.tabId, error: "A debugger lease from an earlier extension runtime requires explicit stale recovery before cleanup can detach it" });
      }
    }
  }
  if (recoverStale && detachDevtools) debuggerFailures.push(...await recoverPersistedDebuggerLeases(sessionId, targetId));
  if (detachDevtools) for (const [key, orphan] of orphanedDebuggerAttaches) {
    if (orphan.sessionId !== sessionId) continue;
    if (orphan.browserId !== undefined && orphan.browserId !== targetId) continue;
    let currentFence;
    let tabPresent = true;
    try {
      currentFence = await tabFenceFor(orphan.tabId);
      await chrome.tabs.get(orphan.tabId);
    } catch (error) {
      if (isMissingTabError(error)) tabPresent = false;
      else {
        debuggerFailures.push({ tabId: orphan.tabId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    if (orphan.epoch !== undefined && debuggerAttachEpoch(orphan.tabId) !== orphan.epoch) {
      debuggerFailures.push({ tabId: orphan.tabId, error: "A debugger attach changed while cleanup was preparing recovery" });
      continue;
    }
    const attachedInfo = await debuggerTargetInfo(orphan.tabId);
    if (attachedInfo === null || attachedInfo === undefined) {
      debuggerFailures.push({ tabId: orphan.tabId, error: "A stale debugger attach could not be verified; inspect the tab's DevTools state before retrying" });
      continue;
    }
    if (!attachedInfo.attached) {
      if (!tabPresent) {
        try {
          await forgetTabFence(orphan.tabId, orphan.tabFence);
        } catch (error) {
          debuggerFailures.push({ tabId: orphan.tabId, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }
      try {
        await removePersistedDebuggerLease(orphan);
      } catch (error) {
        debuggerFailures.push({ tabId: orphan.tabId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      orphanedDebuggerAttaches.delete(key);
      continue;
    }
    if (orphan.targetId !== undefined && attachedInfo.targetId !== undefined && orphan.targetId !== attachedInfo.targetId) {
      debuggerFailures.push({ tabId: orphan.tabId, error: "A debugger attach target changed while cleanup was preparing recovery" });
      continue;
    }
    if (typeof orphan.targetId !== "string" || typeof attachedInfo.targetId !== "string" || orphan.targetId !== attachedInfo.targetId) {
      debuggerFailures.push({ tabId: orphan.tabId, error: "A stale debugger attach has no stable target identity; inspect the tab's DevTools state before retrying" });
      continue;
    }
    if (currentFence !== orphan.tabFence) {
      debuggerFailures.push({ tabId: orphan.tabId, error: "A debugger attach from an earlier tab incarnation remains unresolved; inspect the current tab before retrying" });
      continue;
    }
    const currentRecord = persistentDebuggers.get(key);
    if (currentRecord) {
      debuggerFailures.push({ tabId: orphan.tabId, error: "A debugger attach is already tracked for the current tab incarnation" });
      continue;
    }
    const beforeDetachFence = await tabFenceFor(orphan.tabId);
    let tabPresentBeforeDetach = true;
    try {
      await chrome.tabs.get(orphan.tabId);
    } catch (error) {
      if (isMissingTabError(error)) tabPresentBeforeDetach = false;
      else {
        debuggerFailures.push({ tabId: orphan.tabId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    if (beforeDetachFence !== orphan.tabFence || persistentDebuggers.has(key) || (tabPresent && !tabPresentBeforeDetach)) {
      debuggerFailures.push({ tabId: orphan.tabId, error: "A debugger attach changed while cleanup was preparing recovery" });
      continue;
    }
    try {
      await chrome.debugger.detach({ tabId: orphan.tabId });
      const afterFence = await tabFenceFor(orphan.tabId).catch(() => undefined);
      const afterEpoch = debuggerAttachEpoch(orphan.tabId);
      const afterInfo = await debuggerTargetInfo(orphan.tabId);
      let afterTabPresent = true;
      try {
        await chrome.tabs.get(orphan.tabId);
      } catch (error) {
        if (isMissingTabError(error)) afterTabPresent = false;
        else throw error;
      }
      const epochChanged = orphan.epoch !== undefined && afterEpoch !== orphan.epoch;
      const targetChanged = afterInfo?.attached === true && orphan.targetId !== undefined && afterInfo.targetId !== orphan.targetId;
      if (afterFence !== orphan.tabFence || afterTabPresent || epochChanged || afterInfo === null || afterInfo === undefined || afterInfo.attached === true || targetChanged || persistentDebuggers.has(key)) {
        debuggerFailures.push({ tabId: orphan.tabId, error: "A stale debugger attach changed while cleanup was detaching it; inspect the tab before retrying" });
        continue;
      }
      if (!afterTabPresent) await forgetTabFence(orphan.tabId, orphan.tabFence);
      try {
        await removePersistedDebuggerLease(orphan);
      } catch (error) {
        debuggerFailures.push({ tabId: orphan.tabId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      orphanedDebuggerAttaches.delete(key);
    } catch (error) {
      debuggerFailures.push({ tabId: orphan.tabId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const retiredFailures = [];
  const retiredRecovered = [];
  const malformedRecovered = recoverStale ? await recoverMalformedOwnedRecords(sessionId, targetId) : [];
  const ownedForRetiredRecovery = await ownedTabs();
  for (const [retiredKey, tombstone] of retiredTabRemovalTombstones) {
    const tabId = Number(tombstone.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) {
      retiredFailures.push({ tabId: String(retiredKey), error: "Retired tab tombstone has no valid tab identity" });
      continue;
    }
    const record = ownedForRetiredRecovery[targetStateKey(tabId)];
    const previousRecord = tombstone.removedRecord || record;
    if (previousRecord && (previousRecord.sessionId !== sessionId || (previousRecord.browserId !== undefined && previousRecord.browserId !== targetId))) continue;
    if (!previousRecord && !recoverStale) continue;
    if (!recoverStale) {
      retiredFailures.push({ tabId, error: "Retired tab ownership requires explicit stale recovery before automatic cleanup can continue" });
      continue;
    }
    const expectedFence = tombstone.observedFence;
    if (typeof expectedFence !== "string") {
      if (recoverStale) {
        try {
          const recoveredWithoutFence = await recoverRetiredTabWithoutFence(tabId, tombstone, sessionId, targetId);
          if (recoveredWithoutFence) retiredRecovered.push(tabId);
          else retiredFailures.push({ tabId, error: tombstone.finalizationError || "Retired tab ownership could not be forgotten safely without a tab fence" });
        } catch (error) {
          retiredFailures.push({ tabId, error: error instanceof Error ? error.message : String(error) });
        }
      } else {
        retiredFailures.push({ tabId, error: "Retired tab ownership has no stable tab fence; manual review is required" });
      }
      continue;
    }
    try {
      const finalized = await finalizeRetiredTabOwnership(tabId, tombstone, expectedFence);
      if (finalized) retiredRecovered.push(tabId);
      else retiredFailures.push({ tabId, error: tombstone.finalizationError || "Retired tab ownership could not be reconciled safely" });
    } catch (error) {
      retiredFailures.push({ tabId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const result = await mutateOwnedTabs(async (owned) => {
    const removed = [];
    const released = [];
    const failed = [];
    const recovered = [];
    for (const [key, record] of Object.entries(owned)) {
      if (record.browserId !== undefined && record.browserId !== targetId) continue;
      if (record.sessionId !== sessionId) continue;
      const tabId = recordTabId(record, key);
      if (record.runtimeId !== runtimeInstanceIdentity) {
        if (recoverStale) {
          recovered.push(tabId);
          delete owned[key];
        } else {
          failed.push({ tabId, error: "Tab incarnation is unknown after the extension runtime changed; ownership retained for manual review" });
        }
        continue;
      }
      const activeReplacement = tabRemovalTombstones.get(runtimeStateKey(tabId));
      if (activeReplacement?.replaced === true && Number(activeReplacement.addedTabId) >= 0) {
        if (!activeReplacement.removedRecord) activeReplacement.removedRecord = { ...record };
        if (!activeReplacement.replacementTransferInFlight && activeReplacement.replacementTransferTimer === undefined) scheduleReplacedTabTransfer(Number(activeReplacement.addedTabId), tabId, activeReplacement, activeReplacement.observedFence ?? record.tabFence);
        const uncertain = uncertainBrowserOperationError("cleanup", { tabId, replacementPending: true });
        failed.push({ tabId, error: "Tab replacement ownership reconciliation is still pending; inspect the replacement before retrying", code: uncertain.code, details: uncertain.details });
        continue;
      }
      try {
        await chrome.tabs.get(tabId);
      } catch (error) {
        if (isMissingTabError(error)) {
          removed.push(tabId);
          delete owned[key];
          continue;
        }
        failed.push({ tabId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      try {
        await assertOwnedTabFence(record, "cleanup");
      } catch (error) {
        if (recoverStale && isRecoverableStaleOwnershipError(error)) {
          recovered.push(tabId);
          delete owned[key];
        } else {
          failed.push({ tabId, error: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
      if (record.owner === "claimed") {
        released.push(tabId);
        delete owned[key];
        continue;
      }
      if (record.owner !== "agent") continue;
      const markedForTurn = turnCleanup && turnId !== undefined && ["handoff", "deliverable"].includes(record.lifecycle) && String(record.markTurn || "") === turnId;
      if (!turnCleanup && ["handoff", "deliverable"].includes(record.lifecycle)) {
        released.push(tabId);
        delete owned[key];
        continue;
      }
      const removable = ["temporary", "created"].includes(record.lifecycle) || (turnCleanup && !markedForTurn);
      if (!removable) continue;
      try {
        await chrome.tabs.get(tabId);
        await assertOwnedTabFence(record, "close");
        await removeTabWithFence(tabId, record.tabFence, "cleanup");
        removed.push(tabId);
        delete owned[key];
      } catch (error) {
        if (isMissingTabError(error)) {
          removed.push(tabId);
          delete owned[key];
          continue;
        }
        const uncertain = uncertainBrowserOperationError("cleanup", { tabId, actionState: "unknown", inspectFirst: true, retryable: false });
        failed.push({ tabId, error: error instanceof Error ? error.message : String(error), code: uncertain.code, details: uncertain.details });
        log(`could not close tab ${tabId} during cleanup`, error);
      }
    }
    const retained = Object.entries(owned)
      .filter(([, record]) => record.sessionId === sessionId && (record.browserId === undefined || record.browserId === targetId))
      .map(([key, record]) => recordTabId(record, key));
    return { removed, released, retained, failed, recovered };
  });
  if (detachDevtools) {
    for (const record of [...persistentDebuggers.values()]) {
      if (record.sessionId !== sessionKey(sessionId)) continue;
      const current = persistentDebuggers.get(runtimeStateKey(record.tabId));
      if (current !== record || current.tabFence !== record.tabFence) continue;
      try {
        await detachDebugger(record.tabId, sessionId, record.tabFence, { record, attachEpoch: record.attachEpoch, tabFence: record.tabFence });
      } catch (error) {
        debuggerFailures.push({ tabId: record.tabId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const finalResult = { ...result, failed: [...result.failed, ...retiredFailures], recovered: [...result.recovered, ...retiredRecovered, ...malformedRecovered] };
  return debuggerFailures.length === 0 ? finalResult : { ...finalResult, failed: [...finalResult.failed, ...debuggerFailures] };
}

async function listDownloads(params = {}) {
  pruneDownloadState();
  if (!chrome.downloads?.search) return [...downloadState.values()];
  const items = await chrome.downloads.search({ limit: Number(params.limit || 100), orderBy: ["-startTime"] });
  return items.map((item) => ({ id: item.id, url: item.url, filename: item.filename, state: item.state, bytesReceived: item.bytesReceived, totalBytes: item.totalBytes, danger: item.danger, mime: item.mime, startTime: item.startTime, endTime: item.endTime }));
}

async function waitForDownload(id, timeoutMs = 30000, signal) {
  const deadline = Date.now() + boundedTimeout(timeoutMs, 30000, 120000);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError(signal, "Browser request aborted");
    const items = await chrome.downloads.search({ id: Number(id) });
    assertRequestActive(signal);
    if (Date.now() >= deadline) break;
    const item = items[0];
    if (item && (item.state === "complete" || item.state === "interrupted")) return item;
    await waitWithSignal(200, signal);
  }
  throw new Error(`Timed out waiting for download ${id}`);
}

async function uploadFiles(tabId, params, expectedFence) {
  const files = (Array.isArray(params.files) ? params.files : [params.files]).filter(Boolean).map(String);
  if (!files.length) throw new Error("upload requires at least one file path");
  let dispatched = false;
  try {
    return await withDebugger(tabId, async (sendCommand) => {
      const beforeIncarnation = await readTabIncarnation(tabId, expectedFence);
      await sendCommand("DOM.enable");
      let nodeId = params.nodeId ? Number(params.nodeId) : undefined;
      if (nodeId && (typeof params.incarnation !== "string" || beforeIncarnation === undefined || params.incarnation !== beforeIncarnation)) throw new Error("upload nodeId requires a matching current document incarnation; reacquire the input before retrying");
      if (!nodeId && params.selector) {
        const document = await sendCommand("DOM.getDocument", { depth: -1, pierce: true });
        const found = await sendCommand("DOM.querySelector", { nodeId: document.root.nodeId, selector: String(params.selector) });
        nodeId = found.nodeId;
      }
      const chooser = stateForTab(tabId).fileChooser;
      if (!nodeId && chooser?.backendNodeId) {
        if (typeof chooser.incarnation !== "string" || beforeIncarnation === undefined || chooser.incarnation !== beforeIncarnation) throw new Error("The intercepted file chooser belongs to an earlier document; trigger it again before uploading");
        dispatched = true;
        await sendCommand("DOM.setFileInputFiles", { backendNodeId: chooser.backendNodeId, files });
      } else if (nodeId) {
        dispatched = true;
        await sendCommand("DOM.setFileInputFiles", { nodeId, files });
      } else throw new Error("No file input matched and no intercepted file chooser is available");
      const afterIncarnation = await readTabIncarnation(tabId, expectedFence);
      if (beforeIncarnation !== undefined && afterIncarnation !== beforeIncarnation) throw uncertainBrowserOperationError("upload", { tabId: Number(tabId), pageChanged: true });
      const currentState = stateForTab(tabId);
      if (currentState.fileChooser === chooser) currentState.fileChooser = undefined;
      return { tabId: Number(tabId), files, nodeId, ...(afterIncarnation === undefined ? {} : { incarnation: afterIncarnation }) };
    }, params.sessionId, expectedFence);
  } catch (error) {
    if (error?.code === "BROWSER_OPERATION_UNCERTAIN" || !dispatched) throw error;
    const uncertain = uncertainBrowserOperationError("upload", { tabId: Number(tabId) });
    uncertain.cause = error;
    throw uncertain;
  }
}

async function clipboardText(tabId, action, text, expectedFence) {
  if (action !== "read" && action !== "write") throw new Error("clipboard action must be read or write");
  const beforeIncarnation = await readTabIncarnation(tabId, expectedFence);
  try {
    const value = action === "read"
      ? await executeInTab(tabId, async () => navigator.clipboard.readText(), [], expectedFence)
      : await executeInTab(tabId, async (nextText) => {
        await navigator.clipboard.writeText(String(nextText ?? ""));
        return { ok: true };
      }, [text], expectedFence);
    const afterIncarnation = await readTabIncarnation(tabId, expectedFence);
    if ((beforeIncarnation !== undefined || afterIncarnation !== undefined)
      && (typeof beforeIncarnation !== "string" || typeof afterIncarnation !== "string" || beforeIncarnation !== afterIncarnation)) {
      throw uncertainBrowserOperationError("clipboard", { tabId: Number(tabId), pageChanged: true });
    }
    return value;
  } catch (error) {
    if (error?.code === "BROWSER_OPERATION_UNCERTAIN") throw error;
    if (action === "read") throw error;
    const uncertain = uncertainBrowserOperationError("clipboard", { tabId: Number(tabId), actionState: "unknown" });
    uncertain.cause = error;
    throw uncertain;
  }
}

function keyParts(key) {
  const value = String(key || "");
  const named = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    Delete: { key: "Delete", code: "Delete", keyCode: 46 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    Space: { key: " ", code: "Space", keyCode: 32 },
  };
  return named[value] || { key: value.length === 1 ? value : value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, keyCode: value.length === 1 ? value.toUpperCase().charCodeAt(0) : 0 };
}

async function coordinateAction(tabId, params, signal, expectedFence) {
  if (signal?.aborted) throw uncertainBrowserOperationError("cua");
  let dispatched = false;
  const beforeIncarnation = await readTabIncarnation(tabId, expectedFence);
  try {
    const result = await withDebugger(tabId, async (sendCommand) => {
      const dispatch = (method, commandParams) => {
        dispatched = true;
        return sendCommand(method, commandParams);
      };
      if (signal?.aborted) throw uncertainBrowserOperationError("cua");
      const action = params.action;
      const x = Number(params.x || 0);
      const y = Number(params.y || 0);
      if (action === "click" || action === "double_click") {
        const count = action === "double_click" ? 2 : 1;
        await dispatch("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        for (let i = 0; i < count; i += 1) {
          await dispatch("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: params.button || "left", clickCount: i + 1 });
          await dispatch("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: params.button || "left", clickCount: i + 1 });
        }
        if (signal?.aborted) throw uncertainBrowserOperationError("cua");
        return { ok: true, action, x, y };
      }
      if (action === "move") return dispatch("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      if (action === "scroll") return dispatch("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: Number(params.deltaX || 0), deltaY: Number(params.deltaY || 0) });
      if (action === "drag") {
        const path = Array.isArray(params.path) && params.path.length ? params.path : [{ x, y }, { x: Number(params.toX), y: Number(params.toY) }];
        const first = path[0];
        await dispatch("Input.dispatchMouseEvent", { type: "mouseMoved", x: Number(first.x), y: Number(first.y) });
        await dispatch("Input.dispatchMouseEvent", { type: "mousePressed", x: Number(first.x), y: Number(first.y), button: params.button || "left", clickCount: 1 });
        for (const point of path.slice(1)) await dispatch("Input.dispatchMouseEvent", { type: "mouseMoved", x: Number(point.x), y: Number(point.y), button: params.button || "left" });
        const last = path[path.length - 1];
        await dispatch("Input.dispatchMouseEvent", { type: "mouseReleased", x: Number(last.x), y: Number(last.y), button: params.button || "left", clickCount: 1 });
        return { ok: true, action, path };
      }
      if (action === "type") {
        await dispatch("Input.insertText", { text: String(params.text ?? "") });
        return { ok: true, action };
      }
      if (action === "keypress") {
        const part = keyParts(params.key);
        await dispatch("Input.dispatchKeyEvent", { type: "keyDown", key: part.key, code: part.code, windowsVirtualKeyCode: part.keyCode, nativeVirtualKeyCode: part.keyCode });
        await dispatch("Input.dispatchKeyEvent", { type: "keyUp", key: part.key, code: part.code, windowsVirtualKeyCode: part.keyCode, nativeVirtualKeyCode: part.keyCode });
        return { ok: true, action, key: params.key };
      }
      throw new Error(`Unsupported coordinate action: ${action}`);
    }, params.sessionId, expectedFence);
    const afterIncarnation = await readTabIncarnation(tabId, expectedFence);
    if (typeof beforeIncarnation !== "string" || typeof afterIncarnation !== "string" || beforeIncarnation !== afterIncarnation) throw uncertainBrowserOperationError("cua", { tabId: Number(tabId), pageChanged: true });
    return result;
  } catch (error) {
    if (error?.code === "BROWSER_OPERATION_UNCERTAIN" || !dispatched) throw error;
    const uncertain = uncertainBrowserOperationError("cua", { tabId: Number(tabId) });
    uncertain.cause = error;
    throw uncertain;
  }
}

async function documentFencedDebuggerOperation(tabId, callback, sessionId, expectedFence, method) {
  const beforeIncarnation = await readTabIncarnation(tabId, expectedFence);
  const result = await withDebugger(tabId, callback, sessionId, expectedFence);
  const afterIncarnation = await readTabIncarnation(tabId, expectedFence);
  if (typeof beforeIncarnation !== "string" || typeof afterIncarnation !== "string" || beforeIncarnation !== afterIncarnation) throw uncertainBrowserOperationError(method, { tabId: Number(tabId), pageChanged: true });
  return result;
}

async function captureScreenshot(tab, params, expectedFence, signal) {
  const format = params.format || "png";
  return readOnlyWithRetry("screenshot", tab.id, signal, async () => {
    const beforeIncarnation = await readTabIncarnation(tab.id, expectedFence, true);
    const result = await withDebugger(tab.id, (sendCommand) => sendCommand("Page.captureScreenshot", { format, captureBeyondViewport: params.fullPage === true }), params.sessionId, expectedFence);
    const afterIncarnation = await readTabIncarnation(tab.id, expectedFence, true);
    if (beforeIncarnation !== undefined && afterIncarnation !== undefined && beforeIncarnation !== afterIncarnation) throw pageChangingDuringReadError("screenshot", { tabId: tab.id, pageChanged: true });
    return { tabId: tab.id, data: result.data, mimeType: `image/${format}` };
  });
}

function abortError(signal, fallback) {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

function waitWithSignal(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal, "Browser request aborted"));
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal, "Browser request aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, Number(milliseconds) || 0));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Browser request aborted"));
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Browser request aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => {});
    }),
  ]);
}

function assertRequestActive(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Browser request aborted");
}

async function assertSelectedTab(tabId, action = "selected_tab", windowId, requireLastFocused = true) {
  const query = requireLastFocused ? { active: true, lastFocusedWindow: true } : { active: true, windowId: Number(windowId) };
  const active = (await chrome.tabs.query(query))[0];
  if (Number(active?.id) !== Number(tabId) || active?.active !== true) throw uncertainBrowserOperationError(action, { tabId: Number(tabId), selectionChanged: true });
}

function allowsReadOnlyDocumentChange(method, params = {}) {
  return ["selected_tab", "extract", "snapshot", "screenshot"].includes(method)
    || (method === "dom_cua" && params.action === "get_visible_dom");
}

function isReadOnlyTabRequest(method, params = {}) {
  if (["selected_tab", "extract", "snapshot", "screenshot", "network_response_body"].includes(method)) return true;
  if (method === "wait") return true;
  if (method === "locator") return !SIDE_EFFECTING_PAGE_ACTIONS.has(String(params.action || ""));
  if (method === "dom_cua") return params.action === "get_visible_dom";
  if (method === "console_logs" || method === "network_requests") return params.clear !== true;
  if (method === "dialog") return params.action === "get";
  if (method === "clipboard") return params.action === "read";
  return false;
}

async function handleRequest(method, params, dispatchOptions = {}) {
  const signal = dispatchOptions.signal;
  assertRequestActive(signal);
  if (method === "wait") validateWaitParams(params);
  if (method === "locator") validateLocatorParams(params);
  if (method === "clipboard" && params.action !== "read" && params.action !== "write") throw new Error("clipboard action must be read or write");
  let requestTab;
  let requestTabFence;
  let requestTabIncarnation;
  if (dispatchOptions.skipCleanupFence !== true && method !== "cleanup" && method !== "download" && method !== "status" && method !== "list_tabs" && method !== "list_targets") {
    await awaitWithSignal(dispatchOptions.cleanupFence || cleanupInFlight, signal);
    assertRequestActive(signal);
  }
  if (method === "cleanup") {
    const cleanupSessionId = sessionKey(params.sessionId);
    abortActiveWaits(cleanupSessionId);
    await awaitWithSignal(waitForAllTabBarriers(cleanupSessionId), signal);
    await awaitWithSignal(waitForAllDownloadBarriers(cleanupSessionId), signal);
    assertRequestActive(signal);
  } else if (TAB_REQUEST_METHODS.has(method)) {
    const allowRecordedSnapshotChange = dispatchOptions.expectedTabFence !== undefined || method === "dialog";
    const allowReadOnlyDocumentChange = allowsReadOnlyDocumentChange(method, params);
    if (method === "devtools_disable") {
      try {
        requestTab = await getTab(params.tabId, params, isReadOnlyTabRequest(method, params), allowRecordedSnapshotChange, method === "dialog" || allowReadOnlyDocumentChange);
        requestTabFence = authorizedTabFence(requestTab);
      } catch (error) {
        if (!isMissingTabError(error)) throw error;
      }
    } else {
      requestTab = await getTab(params.tabId, params, isReadOnlyTabRequest(method, params), allowRecordedSnapshotChange, method === "dialog" || allowReadOnlyDocumentChange);
      requestTabFence = authorizedTabFence(requestTab);
      const suppliedHandle = isRecordObject(params.handle) ? params.handle : undefined;
      requestTabIncarnation = typeof suppliedHandle?.incarnation === "string" ? suppliedHandle.incarnation : undefined;
    }
    if (dispatchOptions.expectedTabFence !== undefined && requestTabFence !== dispatchOptions.expectedTabFence) throw uncertainBrowserOperationError(method, { tabId: params.tabId });
    if (requestTab && (params.tabId === undefined || params.tabId === null)) params = { ...params, tabId: requestTab.id };
    if (requestTab && Number(requestTab.id) !== Number(dispatchOptions.skipTabId)) {
      await awaitWithSignal(waitForTabBarrier(requestTab.id, params.sessionId), signal);
      assertRequestActive(signal);
    }
  }
  if (method === "download" && dispatchOptions.skipDownloadBarrier !== true && !["list", "cancel", "erase"].includes(params.action) && params.downloadId !== undefined) {
    await awaitWithSignal(waitForDownloadBarrier(params.downloadId, params.sessionId), signal);
    assertRequestActive(signal);
  }
  if (method === "status") {
    return { connected: true, ...browserIdentity(), capabilities: EXTENSION_CAPABILITIES, bridge: BRIDGE_ORIGIN, connectedAt };
  }
  if (method === "list_tabs") return listTabs();
  if (method === "selected_tab") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    await assertSelectedTab(tab.id);
    const listed = await tabEntryFor(tab.id, expectedFence, "read");
    await assertSelectedTab(tab.id);
    return { tab: listed };
  }
  if (method === "select_tab") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    try {
      await assertTabFence(tab.id, expectedFence, "select");
      await chrome.tabs.update(tab.id, { active: true });
      if (params.focusWindow === true) {
        await assertTabFence(tab.id, expectedFence, "select");
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      await assertTabFence(tab.id, expectedFence, "select");
      if (signal?.aborted) throw uncertainBrowserOperationError(method, { tabId: tab.id });
      const listed = await waitAfterEffect(method, () => tabEntryFor(tab.id, expectedFence, method), { tabId: tab.id });
      await assertSelectedTab(tab.id, "select", tab.windowId, params.focusWindow === true);
      return { tab: listed };
    } catch (error) {
      if (error?.code === "BROWSER_OPERATION_UNCERTAIN") throw error;
      const uncertain = uncertainBrowserOperationError(method, { tabId: tab.id });
      uncertain.cause = error;
      throw uncertain;
    }
  }
  if (method === "new_tab") {
    const created = await createTab(params);
    if (signal?.aborted) throw uncertainBrowserOperationError(method);
    if (params.wait === true && created.tab?.id !== undefined) {
      try {
        await waitAfterEffect("new_tab", () => waitForTabState(created.tab.id, { state: "load", timeoutMs: params.timeoutMs, ...(params.allowRedirects === true ? {} : { url: params.url }) }, signal, created.tabFence), { tabId: created.tab.id });
      } catch (error) {
        if (signal?.aborted) throw uncertainBrowserOperationError(method);
        throw error;
      }
    }
    assertRequestActive(signal);
    return created;
  }
  if (method === "wait") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const state = params.state === undefined ? "load" : String(params.state);
    if (!["load", "url", "text", "text_gone", "visible", "hidden", "enabled"].includes(state)) throw new Error(`Unsupported browser wait state: ${state}`);
    if (["text", "text_gone", "visible", "hidden", "enabled"].includes(state)) {
      const result = await waitForPageCondition(tab.id, { ...params, state }, signal, requestTabFence ?? authorizedTabFence(tab), requestTabIncarnation);
      const listed = await tabEntryFor(tab.id, requestTabFence ?? authorizedTabFence(tab), "read");
      await assertPageGenerationStable(tab.id, requestTabFence ?? authorizedTabFence(tab), result.generation, "wait");
      return { tab: listed, condition: state, ...result.result };    }
    const ready = await waitForTabState(tab.id, { state, url: params.url, urlIncludes: params.urlIncludes, timeoutMs: params.timeoutMs }, signal, requestTabFence ?? authorizedTabFence(tab), requestTabIncarnation);
    const listed = await waitAfterEffect("wait", () => tabEntryFor(ready.id, requestTabFence ?? authorizedTabFence(tab), "read"), { tabId: ready.id });
    return { tab: listed, condition: state, matched: true };
  }
  if (method === "navigate") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    await assertTabFence(tab.id, expectedFence, "navigate");
    let updated;
    try {
      updated = await chrome.tabs.update(tab.id, { url: String(params.url) });
    } catch (error) {
      const uncertain = uncertainBrowserOperationError(method, { tabId: tab.id });
      uncertain.cause = error;
      throw uncertain;
    }
    if (signal?.aborted) throw uncertainBrowserOperationError(method);
    let ready = updated;
    if (params.wait !== false) {
      try {
        ready = await waitAfterEffect("navigate", () => waitForTabState(updated.id, { state: "load", timeoutMs: params.timeoutMs, ...(params.allowRedirects === true ? {} : { url: String(params.url) }) }, signal, expectedFence), { tabId: updated.id });
      } catch (error) {
        if (signal?.aborted) throw uncertainBrowserOperationError(method);
        throw error;
      }
    }
    if (signal?.aborted) throw uncertainBrowserOperationError(method);
    if (params.wait !== false) await refreshOwnedTabDocument(tab.id, expectedFence, params.sessionId);
    const listed = await waitAfterEffect("navigate", () => tabEntryFor(ready.id, expectedFence, "navigate"), { tabId: tab.id });
    return { tab: listed };
  }
  if (method === "back" || method === "forward" || method === "reload") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    await assertTabFence(tab.id, expectedFence, method);
    try {
      if (method === "back") await chrome.tabs.goBack(tab.id);
      if (method === "forward") await chrome.tabs.goForward(tab.id);
      if (method === "reload") await chrome.tabs.reload(tab.id, { bypassCache: params.bypassCache === true });
    } catch (error) {
      const uncertain = uncertainBrowserOperationError(method, { tabId: tab.id });
      uncertain.cause = error;
      throw uncertain;
    }
    if (signal?.aborted) throw uncertainBrowserOperationError(method);
    const listed = await waitAfterEffect(method, async () => {
      await assertTabFence(tab.id, expectedFence, method);
      await refreshOwnedTabDocument(tab.id, expectedFence, params.sessionId);
      return tabEntryFor(tab.id, expectedFence, method);
    }, { tabId: tab.id });
    return { tab: listed };
  }
  if (method === "close_tab") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    await assertTabFence(tab.id, expectedFence, "close");
    const userRequested = params.userRequested === true;
    const record = await ownedTabForSession(tab.id, params.sessionId, "close", false, false);
    await assertTabFence(tab.id, expectedFence, "close");
    if (!record && !userRequested) throw new Error("Closing an unowned user tab requires userRequested: true");
    try {
      await removeTabWithFence(tab.id, expectedFence, "close");
    } catch (error) {
      const uncertain = uncertainBrowserOperationError(method, { tabId: tab.id, ownershipRetained: record !== undefined });
      uncertain.cause = error;
      throw uncertain;
    }
    try {
      const forgotten = await forgetOwnedTab(tab.id, params.sessionId, false, record?.tabFence, record !== undefined);
      if (record !== undefined && forgotten !== true) {
        const remaining = (await ownedTabs())[targetStateKey(tab.id)];
        if (remaining) throw uncertainBrowserOperationError(method, { tabId: tab.id, ownershipRetained: true });
      }
    } catch (error) {
      if (error?.code === "BROWSER_OPERATION_UNCERTAIN") throw error;
      const uncertain = uncertainBrowserOperationError(method, { tabId: tab.id, ownershipRetained: true });
      uncertain.cause = error;
      throw uncertain;
    }
    return { closed: tab.id };
  }
  if (method === "extract") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    return readOnlyWithRetry("extract", tab.id, signal, async () => {
      const beforeIncarnation = await readTabIncarnation(tab.id, expectedFence, true);
      const content = await executeInTab(tab.id, extractPage, [{
        ...(params.maxChars === undefined ? {} : { maxChars: params.maxChars }),
        ...(params.selector === undefined ? {} : { selector: params.selector }),
      }], expectedFence);
      const afterIncarnation = await readTabIncarnation(tab.id, expectedFence, true);
      if (typeof beforeIncarnation !== "string" || typeof afterIncarnation !== "string" || afterIncarnation !== beforeIncarnation) throw pageChangingDuringReadError("extract", { tabId: tab.id, pageChanged: true });
      const listed = await tabEntryFor(tab.id, expectedFence, "extract");
      if (listed.handle?.incarnation !== undefined && listed.handle.incarnation !== afterIncarnation) throw pageChangingDuringReadError("extract", { tabId: tab.id, pageChanged: true });
      return { tabId: tab.id, tab: listed, content, incarnation: afterIncarnation };
    });
  }
  if (method === "snapshot") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    const snapshotOptions = {
      ...(params.maxChars === undefined ? {} : { maxChars: params.maxChars }),
      ...(params.maxNodes === undefined ? {} : { maxNodes: params.maxNodes }),
      ...(params.selector === undefined ? {} : { selector: params.selector }),
    };
    return readOnlyWithRetry("snapshot", tab.id, signal, async () => {
      const snapshot = await executeInTab(tab.id, collectSnapshot, [snapshotOptions], expectedFence);
      const snapshotGeneration = snapshot && { url: snapshot.__piControlChromeSnapshotUrl, timeOrigin: snapshot.__piControlChromeSnapshotTimeOrigin, token: snapshot.__piControlChromeSnapshotToken };
      const accessibility = snapshot ? await executeInTab(tab.id, collectAccessibilitySnapshot, [snapshotOptions], expectedFence) : undefined;
      let frameTree;
      try { frameTree = await withDebugger(tab.id, (sendCommand) => sendCommand("Page.getFrameTree"), params.sessionId, expectedFence); } catch (error) {
        if (error && typeof error === "object" && ["BROWSER_OPERATION_UNCERTAIN", "BROWSER_TAB_FENCE_CHANGED", "BROWSER_TAB_CLOSED"].includes(error.code)) throw error;
      }
      await assertPageGenerationStable(tab.id, expectedFence, snapshotGeneration, "snapshot", true);
      if (snapshot) {
        const accessibilityOnly = params.accessibilityOnly === true;
        snapshot.accessibility = accessibilityRevision(tab.id, snapshot, accessibility, accessibilityOnly && params.disableDiffing !== true, accessibilityOnly);
      }
      rememberPageSnapshot(tab.id, snapshot);
      const listed = await tabEntryFor(tab.id, expectedFence, "snapshot");
      return { tabId: tab.id, tab: listed, snapshot, frameTree };
    });
  }
  if (method === "locator") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    const result = await executeLocatorOperation(tab.id, { ...params, pageOperation: "locator" }, signal, expectedFence);
    if (isSideEffectingPageOperation(params)) await refreshOwnedTabDocument(tab.id, expectedFence, params.sessionId);
    return { tabId: tab.id, result };
  }
  if (method === "interaction") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    const result = await executePageOperation(tab.id, { ...params, pageOperation: "interaction" }, signal, expectedFence);
    if (isSideEffectingPageOperation(params)) await refreshOwnedTabDocument(tab.id, expectedFence, params.sessionId);
    return { tabId: tab.id, result };
  }
  if (method === "dom_cua") {
    if (!["get_visible_dom", "click", "double_click", "type", "keypress", "scroll"].includes(params.action)) throw new Error("DOM CUA action must be get_visible_dom, click, double_click, type, keypress or scroll");
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    if (params.action === "get_visible_dom") {
      return readOnlyWithRetry("dom_cua", tab.id, signal, async () => {
        const dom = await executeInTab(tab.id, collectVisibleDom, [{
          ...(params.maxChars === undefined ? {} : { maxChars: params.maxChars }),
          ...(params.maxNodes === undefined ? {} : { maxNodes: params.maxNodes }),
          ...(params.selector === undefined ? {} : { selector: params.selector }),
        }], expectedFence);
        const domGeneration = dom && { url: dom.__piControlChromeDomUrl, timeOrigin: dom.__piControlChromeDomTimeOrigin, token: dom.__piControlChromeDomToken };
        await assertPageGenerationStable(tab.id, expectedFence, domGeneration, "dom_cua", true);
        rememberDomSnapshot(tab.id, dom);
        const listed = await tabEntryFor(tab.id, expectedFence, "snapshot");
        return { tabId: tab.id, tab: listed, dom };
      });
    }
    const result = await executeDomCuaOperation(tab.id, params, signal, expectedFence);
    await refreshOwnedTabDocument(tab.id, expectedFence, params.sessionId);
    return { tabId: tab.id, result };
  }
  if (method === "cua") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    return { tabId: tab.id, result: await coordinateAction(tab.id, params, signal, expectedFence) };
  }
  if (method === "screenshot") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    return captureScreenshot(tab, params, expectedFence, signal);
  }
  if (method === "evaluate") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    try {
      const result = await documentFencedDebuggerOperation(tab.id, (sendCommand) => sendCommand("Runtime.evaluate", { expression: String(params.expression || "undefined"), awaitPromise: params.awaitPromise !== false, returnByValue: true }), params.sessionId, expectedFence, method);
      return { tabId: tab.id, result: boundEvaluateResult(result) };
    } catch (error) {
      if (error?.code === "BROWSER_OPERATION_UNCERTAIN") throw error;
      const uncertain = uncertainBrowserOperationError(method, { tabId: tab.id });
      uncertain.cause = error;
      throw uncertain;
    }
  }
  if (method === "cdp") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    try {
      const result = await documentFencedDebuggerOperation(tab.id, (sendCommand) => sendCommand(String(params.method), params.params || {}), params.sessionId, expectedFence, method);
      return { tabId: tab.id, result };
    } catch (error) {
      if (error?.code === "BROWSER_OPERATION_UNCERTAIN") throw error;
      const uncertain = uncertainBrowserOperationError(method, { tabId: tab.id });
      uncertain.cause = error;
      throw uncertain;
    }
  }
  if (method === "devtools_enable") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    return enableDevtools(tab.id, params.domains || ["Runtime", "Log", "Network", "Page"], params.sessionId, expectedFence);
  }
  if (method === "devtools_disable") {
    const handle = isRecordObject(params.handle) ? params.handle : params;
    const tabId = requestTab?.id ?? params.tabId ?? handle.tabId;
    if (tabId === undefined || tabId === null) throw new Error("devtools_disable requires tabId or a tab handle");
    const expectedFence = requestTabFence ?? persistentDebuggers.get(runtimeStateKey(Number(tabId)))?.tabFence;
    return disableDevtools(tabId, params.sessionId, expectedFence);
  }
  if (method === "console_logs") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    await enableDevtools(tab.id, ["Runtime", "Log"], params.sessionId, expectedFence);
    await assertTabFence(tab.id, expectedFence, "read console logs");
    const state = stateForTab(tab.id);
    const logs = boundedEventCollection(state.console);
    if (params.clear === true) state.console.length = 0;
    return { tabId: tab.id, logs: logs.items, logCount: logs.items.length, logCharCount: logs.charCount, logTruncated: logs.truncated, maxLogChars: logs.maxChars, maxLogs: logs.maxItems };
  }
  if (method === "network_requests") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    await enableDevtools(tab.id, ["Network", "Page"], params.sessionId, expectedFence);
    await assertTabFence(tab.id, expectedFence, "read network requests");
    const state = stateForTab(tab.id);
    const requests = boundedEventCollection(state.network);
    if (params.clear === true) state.network.length = 0;
    return { tabId: tab.id, requests: requests.items, requestCount: requests.items.length, requestCharCount: requests.charCount, requestTruncated: requests.truncated, maxRequestChars: requests.maxChars, maxRequests: requests.maxItems };
  }
  if (method === "network_response_body") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    const requestId = String(params.requestId || "");
    if (!requestId) throw new Error("network_response_body requires requestId");
    const state = stateForTab(tab.id);
    const request = state.requestLoaders.get(requestId);
    if (!request || typeof params.loaderId !== "string" || request.loaderId !== params.loaderId) {
      const stale = new Error("The network request belongs to an earlier or unverified document; request a fresh browser_network listing");
      stale.code = "BROWSER_TAB_FENCE_CHANGED";
      throw stale;
    }
    const beforeIncarnation = await readTabIncarnation(tab.id, expectedFence);
    const result = await withDebugger(tab.id, async (sendCommand) => {
      await sendCommand("Network.enable");
      return sendCommand("Network.getResponseBody", { requestId });
    }, params.sessionId, expectedFence);
    const afterIncarnation = await readTabIncarnation(tab.id, expectedFence);
    if (typeof beforeIncarnation !== "string" || typeof afterIncarnation !== "string" || beforeIncarnation !== afterIncarnation) throw uncertainBrowserOperationError("network_response_body", { tabId: tab.id, pageChanged: true });
    return { tabId: tab.id, result: boundedNetworkResponseBody(result), loaderId: params.loaderId };
  }
  if (method === "dialog") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    await assertTabFence(tab.id, expectedFence, "read dialog");
    const state = stateForTab(tab.id);
    if (params.action === "get") {
      if (state.dialog) {
        await assertTabFence(tab.id, expectedFence, "read dialog");
        return { tabId: tab.id, dialog: state.dialog };
      }
      return { tabId: tab.id, dialog: state.dialog };
    }
    if (!["accept", "dismiss"].includes(params.action)) throw new Error("dialog action must be get, accept or dismiss");
    let dispatched = false;
    const expectedDialog = state.dialog;
    const expectedDialogSequence = Number(state.dialogSequence || 0);
    const expectedDocumentEpoch = Number(state.documentEpoch || 0);
    try {
      const dialog = await withDebugger(tab.id, async (sendCommand) => {
        dispatched = true;
        await sendCommand("Page.handleJavaScriptDialog", { accept: params.action === "accept", promptText: params.promptText });
        if (state.documentEpoch !== expectedDocumentEpoch || (state.dialog !== undefined && state.dialog !== expectedDialog) || (state.dialogSequence !== expectedDialogSequence && state.dialog !== undefined)) throw uncertainBrowserOperationError("dialog", { tabId: tab.id, pageChanged: true });
        if (state.dialog === expectedDialog) state.dialog = undefined;
        return expectedDialog;
      }, params.sessionId, expectedFence);
      return { tabId: tab.id, handled: params.action, dialog };
    } catch (error) {
      if (error?.code === "BROWSER_OPERATION_UNCERTAIN" || !dispatched) throw error;
      const uncertain = uncertainBrowserOperationError("dialog", { tabId: tab.id, action: params.action });
      uncertain.cause = error;
      throw uncertain;
    }
  }
  if (method === "upload") {
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    return uploadFiles(tab.id, params, expectedFence);
  }
  if (method === "clipboard") {
    if (params.action !== "read" && params.action !== "write") throw new Error("clipboard action must be read or write");
    const tab = requestTab ?? await getTab(params.tabId, params, isReadOnlyTabRequest(method, params));
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    const action = params.action;
    return { tabId: tab.id, action, text: action === "read" ? await clipboardText(tab.id, "read", undefined, expectedFence) : undefined, result: action === "write" ? await clipboardText(tab.id, "write", params.text, expectedFence) : undefined };
  }
  if (method === "download") {
    if (params.action === "list") return { downloads: await listDownloads(params) };
    if (params.action === "start") {
      if (!params.url) throw new Error("download start requires url");
      let id;
      try {
        id = await chrome.downloads.download({ url: String(params.url), filename: params.filename ? String(params.filename) : undefined, saveAs: params.saveAs === true });
      } catch (error) {
        const uncertain = uncertainBrowserOperationError(method, { url: String(params.url), filename: params.filename });
        uncertain.cause = error;
        throw uncertain;
      }
      let item;
      try {
        item = params.wait === false ? (await chrome.downloads.search({ id }))[0] : await waitAfterEffect("download", () => waitForDownload(id, params.timeoutMs, signal), { downloadId: id });
      } catch (error) {
        if (error?.code === "BROWSER_OPERATION_UNCERTAIN") throw error;
        const uncertain = uncertainBrowserOperationError(method, { downloadId: id });
        uncertain.cause = error;
        throw uncertain;
      }
      return { download: item || { id } };
    }
    if (params.action === "wait") return { download: await waitForDownload(Number(params.downloadId), params.timeoutMs, signal) };
    if (params.action === "cancel") {
      try {
        await chrome.downloads.cancel(Number(params.downloadId));
      } catch (error) {
        const uncertain = uncertainBrowserOperationError(method, { downloadId: Number(params.downloadId) });
        uncertain.cause = error;
        throw uncertain;
      }
      return { canceled: Number(params.downloadId) };
    }
    if (params.action === "erase") {
      let erased;
      try {
        erased = await chrome.downloads.erase({ id: Number(params.downloadId) });
      } catch (error) {
        const uncertain = uncertainBrowserOperationError(method, { downloadId: Number(params.downloadId) });
        uncertain.cause = error;
        throw uncertain;
      }
      return { erased };
    }
    throw new Error("download action must be list, start, wait, cancel or erase");
  }
  if (method === "claim_tab") {
    const tab = requestTab ?? await getTab(params.tabId, params, false);
    const expectedFence = requestTabFence ?? authorizedTabFence(tab);
    await assertTabFence(tab.id, expectedFence, "claim");
    if (params.windowId !== undefined && Number(params.windowId) !== Number(tab.windowId)) throw new Error("Tab window changed during the claim");
    if (params.title !== undefined && String(params.title) !== String(tab.title || "")) throw new Error("Tab title changed during the claim");
    if (params.url !== undefined && String(params.url) !== String(tab.url || "")) throw new Error("Tab URL changed during the claim");
    const existing = await ownedTabForSession(tab.id, params.sessionId, "claim");
    if (existing) throw new Error(`Tab ${tab.id} is already owned; release it before claiming again`);
    const currentTab = await getTab(tab.id, params, false);
    await assertTabFence(currentTab.id, expectedFence, "claim");
    if (params.windowId !== undefined && Number(params.windowId) !== Number(currentTab.windowId)) throw new Error("Tab window changed during the claim");
    if (params.title !== undefined && String(params.title) !== String(currentTab.title || "")) throw new Error("Tab title changed during the claim");
    if (params.url !== undefined && String(params.url) !== String(currentTab.url || "")) throw new Error("Tab URL changed during the claim");
    let recorded = false;
    try {
      await recordOwnedTab(currentTab, params.sessionId, "claimed", "claimed", expectedFence);
      recorded = true;
      await assertTabFence(currentTab.id, expectedFence, "claim");
      const claimed = await tabEntryFor(tab.id, expectedFence, "claim");
      return { claimed };
    } catch (error) {
      if (!recorded) throw error;
      if (error?.code === "BROWSER_OPERATION_UNCERTAIN") {
        error.details = { ...(error.details && typeof error.details === "object" ? error.details : {}), ownershipRetained: true };
        throw error;
      }
      const uncertain = uncertainBrowserOperationError("claim_tab", { tabId: Number(tab.id), ownershipRetained: true });
      uncertain.cause = error;
      throw uncertain;
    }
  }
  if (method === "release") {
    if (params.tabId === undefined) throw new Error("tabId is required");
    const reservation = reserveTabWait(Number(params.tabId), params.sessionId);
    try {
      await awaitWithSignal(reservation.before, signal);
      const record = await ownedTabForSession(params.tabId, params.sessionId, "release", true);
      const forgotten = await forgetOwnedTab(params.tabId, params.sessionId, false, record.tabFence, true);
      if (!forgotten) throw uncertainBrowserOperationError(method, { tabId: Number(params.tabId), ownershipRetained: true });
      return { released: [Number(params.tabId)] };
    } finally {
      reservation.release();
    }
  }
  if (method === "mark_handoff" || method === "mark_deliverable") {
    if (params.tabId === undefined) throw new Error("tabId is required");
    const reservation = reserveTabWait(Number(params.tabId), params.sessionId);
    try {
      await awaitWithSignal(reservation.before, signal);
      const lifecycle = method === "mark_handoff" ? "handoff" : "deliverable";
      if (params.turnId === undefined || params.turnId === null || String(params.turnId).trim() === "") throw new Error("turnId is required when marking a tab for handoff or delivery");
      const markTurn = String(params.turnId);
      return { tab: await updateOwnedTab(params.tabId, { lifecycle, ...(markTurn === undefined ? {} : { markTurn }) }, params.sessionId) };
    } finally {
      reservation.release();
    }
  }
  if (method === "cleanup") return cleanup(params);
  throw new Error(`Unsupported browser method: ${method}`);
}

chrome.runtime.onStartup.addListener(() => connect().catch((error) => {
  console.error("[pi-control-chrome] startup bridge connection failed", error);
  scheduleReconnect();
}));
chrome.runtime.onInstalled.addListener(() => connect().catch((error) => {
  console.error("[pi-control-chrome] install bridge connection failed", error);
  scheduleReconnect();
}));
chrome.alarms?.create("pi-control-chrome-reconnect", { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "pi-control-chrome-reconnect") connect().catch((error) => {
    console.error("[pi-control-chrome] alarm bridge connection failed", error);
    scheduleReconnect();
  });
});
connect().catch((error) => {
  console.error("[pi-control-chrome] initial bridge connection failed", error);
  scheduleReconnect();
});
