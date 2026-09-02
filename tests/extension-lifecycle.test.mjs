import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const backgroundPath = join(root, "extension", "background.js");
const pageAgentPath = join(root, "extension", "page-agent.js");
const ownedTabsKey = "piControlChromeOwnedTabs";
const tabFencesKey = "piControlChromeTabFences";
const debuggerLeasesKey = "piControlChromeDebuggerLeases";
const profileIdKey = "piControlChromeProfileId";

function eventSource() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return Promise.all(listeners.map((listener) => listener(...args))); },
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadExtension(options = {}) {
  const storage = options.storage ?? { [ownedTabsKey]: {}, [profileIdKey]: "profile-id" };
  const sessionStorage = options.sessionStorage ?? {};
  const tabs = new Map();
  const downloads = new Map();
  let nextDownloadId = 1;
  let nextTabId = Number(options.nextTabId ?? 1000);
  let pageGenerationCalls = 0;
  const executeScriptCalls = [];
  const debuggerCommandCalls = [];
  const removeFailures = new Set();
  let detachFailure = false;
  let debuggerCommandFailure = false;
  const attachedDebuggerTabs = new Set();
  let visibleCaptureFailure = false;
  const runtimeStartup = eventSource();
  const runtimeInstalled = eventSource();
  const tabRemoved = eventSource();
  const tabUpdated = eventSource();
  const tabReplaced = eventSource();
  const tabCreated = eventSource();
  const debuggerEvent = eventSource();
  const debuggerDetach = eventSource();
  const downloadsCreated = eventSource();
  const downloadsChanged = eventSource();
  const alarm = eventSource();
  const chrome = {
    runtime: {
      id: "test-extension",
      getManifest: () => ({ version: "0.3.7" }),
      onStartup: runtimeStartup,
      onInstalled: runtimeInstalled,
    },
    storage: {
      local: {
        async get(defaults) {
          if (options.storageGetDelay) await new Promise((resolve) => setTimeout(resolve, options.storageGetDelay));
          return { ...clone(defaults), ...clone(storage) };
        },
        async set(values) {
          if (typeof options.storageSetFailure === "function" && options.storageSetFailure(values)) throw new Error("simulated storage set failure");
          Object.assign(storage, clone(values));
        },
      },
      session: {
        async get(defaults) {
          const stored = storage[ownedTabsKey];
          const records = stored && typeof stored === "object" && stored.records && typeof stored.records === "object" ? stored.records : stored && typeof stored === "object" ? stored : {};
          const derived = Object.fromEntries(Object.values(records).filter((entry) => entry && typeof entry === "object" && Number.isInteger(Number(entry.tabId)) && typeof entry.tabFence === "string").map((entry) => [`test-extension::${Number(entry.tabId)}`, entry.tabFence]));
          const explicit = sessionStorage[tabFencesKey] && typeof sessionStorage[tabFencesKey] === "object" ? sessionStorage[tabFencesKey] : {};
          return { ...clone(defaults), ...clone(sessionStorage), [tabFencesKey]: { ...derived, ...clone(explicit) } };
        },
        async set(values) { Object.assign(sessionStorage, clone(values)); },
      },
    },
    tabs: {
      onRemoved: tabRemoved,
      onUpdated: tabUpdated,
      onReplaced: tabReplaced,
      onCreated: tabCreated,
      async get(tabId) {
        const tab = tabs.get(Number(tabId));
        if (!tab) throw new Error("tab not found");
        return tab;
      },
      async query() { return [...tabs.values()]; },
      async captureVisibleTab() {
        if (visibleCaptureFailure) throw new Error("image readback failed");
        return "data:image/png;base64,visible-data";
      },
      async create(details = {}) {
        const id = options.createTabId === undefined ? nextTabId++ : Number(options.createTabId);
        const createdUrl = options.createdTabUrl === undefined ? String(details.url || "about:blank") : String(options.createdTabUrl);
        const tab = { id, windowId: Number(details.windowId ?? 1), title: "", url: createdUrl, status: "loading", active: details.active === true };
        tabs.set(id, tab);
        await tabCreated.emit(tab);
        tab.status = "complete";
        return tab;
      },
      async update(tabId, details = {}) {
        const tab = tabs.get(Number(tabId));
        if (!tab) throw new Error("tab not found");
        const changeInfo = {};
        if (details.url !== undefined) {
          tab.url = String(details.url);
          tab.status = "loading";
          changeInfo.url = tab.url;
          changeInfo.status = tab.status;
        }
        if (details.active !== undefined) {
          tab.active = details.active === true;
          changeInfo.active = tab.active;
        }
        await tabUpdated.emit(Number(tabId), changeInfo, tab);
        return tab;
      },
      async goBack(tabId) {
        const tab = tabs.get(Number(tabId));
        if (!tab) throw new Error("tab not found");
        tab.status = "loading";
        await tabUpdated.emit(Number(tabId), { status: "loading" }, tab);
      },
      async goForward(tabId) {
        const tab = tabs.get(Number(tabId));
        if (!tab) throw new Error("tab not found");
        tab.status = "loading";
        await tabUpdated.emit(Number(tabId), { status: "loading" }, tab);
      },
      async reload(tabId) {
        const tab = tabs.get(Number(tabId));
        if (!tab) throw new Error("tab not found");
        tab.status = "loading";
        await tabUpdated.emit(Number(tabId), { status: "loading" }, tab);
      },
      async remove(tabId) {
        const id = Number(tabId);
        if (removeFailures.has(id)) throw new Error("simulated tab close failure");
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
        tabs.delete(id);
        await tabRemoved.emit(id);
      },
    },
    scripting: {
      async executeScript({ target, func, files, args }) {
        executeScriptCalls.push({ tabId: Number(target?.tabId), functionName: func?.name, files: Array.isArray(files) ? [...files] : undefined, args: clone(args) });
        const tab = tabs.get(Number(target.tabId));
        if (options.restrictedPageError && tab?.url === "about:blank") throw new Error(options.restrictedPageError);
        if (Array.isArray(files) && files.length > 0) return [{ result: undefined }];
        if (options.executeScriptException && func.name === (options.executeScriptException.functionName || "collectSnapshot")) return [{ exceptionDetails: options.executeScriptException.details }];
        if (func.name === "pageGeneration") {
          const sequence = Array.isArray(options.pageGenerationSequence) ? options.pageGenerationSequence : [];
          const fallback = { url: tab?.url || "about:blank", timeOrigin: 1, token: "fixture-document-token" };
          const generation = sequence.length > 0 ? sequence[Math.min(pageGenerationCalls++, sequence.length - 1)] : fallback;
          return [{ result: clone(generation ?? fallback) }];
        }
        const scriptedResults = options.executeScriptResults && typeof options.executeScriptResults === "object" ? options.executeScriptResults : {};
        return [{ result: Object.hasOwn(scriptedResults, func.name) ? clone(scriptedResults[func.name]) : undefined }];
      },
    },
    debugger: {
      onEvent: debuggerEvent,
      onDetach: debuggerDetach,
      async attach(debuggee) { attachedDebuggerTabs.add(Number(debuggee.tabId)); },
      async getTargets() { return [...attachedDebuggerTabs].map((tabId) => ({ tabId, attached: true, id: `target-${tabId}` })); },
      async detach(debuggee) { if (detachFailure) throw new Error("simulated debugger detach failure"); attachedDebuggerTabs.delete(Number(debuggee.tabId)); },
      async sendCommand(_debuggee, method, params) {
        debuggerCommandCalls.push({ method, params: clone(params) });
        if (debuggerCommandFailure && method !== "Page.captureScreenshot") throw new Error("simulated debugger command failure");
        if (typeof options.debuggerCommandResult === "function") return clone(await options.debuggerCommandResult(method, params));
        if (method === "Runtime.evaluate" && options.debuggerEvaluateResult !== undefined) return { result: { type: "object", value: clone(options.debuggerEvaluateResult) } };
        return method === "Page.captureScreenshot" ? { data: "debugger-data" } : {};
      },
    },
    downloads: {
      onCreated: downloadsCreated,
      onChanged: downloadsChanged,
      async download(details) {
        const id = nextDownloadId++;
        const item = { id, url: String(details.url), filename: details.filename || "download.bin", state: "in_progress", bytesReceived: 0, totalBytes: 10 };
        downloads.set(id, item);
        await downloadsCreated.emit(item);
        return id;
      },
      async search(query = {}) {
        return query.id === undefined ? [...downloads.values()] : downloads.has(Number(query.id)) ? [downloads.get(Number(query.id))] : [];
      },
      async cancel(id) {
        const item = downloads.get(Number(id));
        if (item) { item.state = "interrupted"; await downloadsChanged.emit({ id: Number(id), state: { current: "interrupted" } }); }
      },
      async erase(query = {}) {
        const id = Number(query.id);
        return downloads.delete(id) ? [id] : [];
      },
    },
    alarms: { create() {}, onAlarm: alarm },
  };
  const heartbeatMessages = [];
  const intervalCallbacks = new Map();
  let nextIntervalId = 1;
  const setIntervalFake = (callback, delay) => {
    const id = nextIntervalId++;
    intervalCallbacks.set(id, { callback, delay });
    return id;
  };
  const clearIntervalFake = (id) => { intervalCallbacks.delete(id); };
  let latestSocket;
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = FakeWebSocket.OPEN;
    listeners = new Map();
    constructor() { latestSocket = this; }
    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }
    send(message) { heartbeatMessages.push(JSON.parse(message)); }
    emit(name, event = {}) { for (const listener of this.listeners.get(name) || []) listener(event); }
  }
  let randomUUIDCalls = 0;
  const context = vm.createContext({
    chrome,
    WebSocket: FakeWebSocket,
    navigator: { userAgent: "Edg/123.0" },
    crypto: { randomUUID: () => { randomUUIDCalls += 1; return randomUUIDCalls === 1 ? "profile-id" : `generated-${randomUUIDCalls}`; } },
    location: { href: options.pageUrl ?? "https://example.test/page" },
    performance: { timeOrigin: options.pageTimeOrigin ?? 1 },
    fetch: async () => ({ ok: true, status: 200, async json() { return { token: "token" }; } }),
    console: { debug() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval: setIntervalFake,
    clearInterval: clearIntervalFake,
    URL,
    AbortController,
  });
  const source = readFileSync(backgroundPath, "utf8");
  const pageAgentSource = readFileSync(pageAgentPath, "utf8");
  const injectedPageAgents = new Set();
  const originalExecuteScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (details) => {
    if (Array.isArray(details.files) && details.files.includes("page-agent.js")) {
      const tabId = Number(details.target.tabId);
      if (!injectedPageAgents.has(tabId)) {
        vm.runInContext(pageAgentSource, context, { filename: join(root, "extension", "page-agent.js") });
        injectedPageAgents.add(tabId);
      }
      return [{ result: undefined }];
    }
    return originalExecuteScript(details);
  };
  vm.runInContext(source + "\nglobalThis.__testApi = { handleRequest, attachDebugger, detachDebugger, persistentDebuggers, orphanedDebuggerAttaches, tabRemovalTombstones, retiredTabRemovalTombstones, browserIdentity, waitForTabState, abortActiveWaits, activeRequestControllers, activeRequestDetails, ownedTabs, ensureProfileIdentity, reserveTabWait, trackDownloadWait, downloadState, pageSnapshotStates, domSnapshotStates, accessibilitySnapshotStates, accessibilitySnapshotObservations, resolveAccessibilityNode, devtoolsState, capturePageObservationState, invalidatePageObservationStateAfterDocumentTransition, pageOperationParams, domCuaOperationParams, tabSnapshotMatches, executeInTab, pageGeneration, refreshOwnedTabDocument, pendingDocumentTransitions };", context, { filename: backgroundPath });
  return {
    api: context.__testApi,
    chrome,
    storage,
    sessionStorage,
    tabs,
    downloads,
    emitDownloadChanged(delta) { return downloadsChanged.emit(delta); },
    emitDebuggerEvent(source, method, params) { return debuggerEvent.emit(source, method, params); },
    emitTabCreated(tab) { return tabCreated.emit(tab); },
    emitTabRemoved(tabId) { return tabRemoved.emit(tabId); },
    emitTabReplaced(addedTabId, removedTabId) { return tabReplaced.emit(addedTabId, removedTabId); },
    emitTabUpdated(tabId, changeInfo, tab) { return tabUpdated.emit(tabId, changeInfo, tab); },
    emitSocketOpen() { latestSocket?.emit("open"); },
    async emitSocketMessage(message) {
      const listeners = latestSocket?.listeners.get("message") || [];
      await Promise.all(listeners.map((listener) => listener({ data: JSON.stringify(message) })));
    },
    runHeartbeat() { for (const { callback } of intervalCallbacks.values()) callback(); },
    heartbeatMessages,
    heartbeatIntervals: intervalCallbacks,
    executeScriptCalls,
    debuggerCommandCalls,
    removeFailures,
    setDetachFailure(value) { detachFailure = value; },
    setDebuggerCommandFailure(value) { debuggerCommandFailure = value; },
    setVisibleCaptureFailure(value) { visibleCaptureFailure = value; },
  };
}

test("Page Agent injection is idempotent, upgrades in place, and resolves bounded observations", () => {
  const document = {};
  const context = vm.createContext({
    crypto: { randomUUID: () => "document-token" },
    document,
    location: { href: "https://example.test/page" },
    performance: { timeOrigin: 123 },
  });
  const source = readFileSync(pageAgentPath, "utf8");

  vm.runInContext(source, context, { filename: pageAgentPath });
  const agent = vm.runInContext("globalThis.__piControlChromePageAgent", context);
  assert.equal(agent.version, 4);
  const identity = agent.documentIdentity();
  assert.equal(identity.url, "https://example.test/page");
  assert.equal(identity.timeOrigin, 123);
  assert.equal(identity.token, "document-token");
  assert.equal(agent.sameDocument(identity, agent.documentIdentity()), true);
  assert.equal(agent.matchesDocument({ url: "https://example.test/page" }, identity), true);
  for (let index = 0; index < 20; index += 1) agent.remember("snapshot", `snapshot-${index}`, { value: index });
  assert.equal(agent.observations.size, 16);
  assert.equal(agent.lookup("snapshot", "snapshot-0"), undefined);
  assert.equal(agent.lookup("snapshot", "snapshot-4")?.value, 4);
  // The extension's isolated world and executeScript function world are distinct
  // realms, so the registry must accept map-like records across that boundary.
  assert.equal(agent.remember("snapshot", "cross-realm", { refs: new Map([["e1", { value: 1 }]]) })?.refs instanceof Map, true);
  agent.remember("snapshot", "expired", { createdAt: Date.now() - agent.ttlMs - 1 });
  assert.equal(agent.lookup("snapshot", "expired"), undefined);

  const original = { isConnected: true, ownerDocument: document };
  const replacement = { isConnected: true, ownerDocument: document };
  agent.remember("snapshot", "resolver", {
    refs: new Map([["e1", { element: agent.retain(original), descriptor: { id: "save" } }]]),
    documentIdentity: identity,
  });
  const resolverOptions = {
    kind: "snapshot",
    observationId: "resolver",
    recordId: "e1",
    currentDocument: identity,
    expectedDocument: identity,
    matchesDescriptor: (element, descriptor) => (element === original || element === replacement) && descriptor.id === "save",
    canSemanticRebind: (descriptor) => descriptor.id === "save",
    findCandidates: () => [replacement],
  };
  const originalResolution = agent.resolveObservedElement(resolverOptions);
  assert.equal(originalResolution.state, "resolved");
  assert.equal(originalResolution.element, original);
  assert.equal(originalResolution.rebound, false);
  original.isConnected = false;
  const reboundResolution = agent.resolveObservedElement(resolverOptions);
  assert.equal(reboundResolution.state, "resolved");
  assert.equal(reboundResolution.element, replacement);
  assert.equal(reboundResolution.rebound, true);
  replacement.isConnected = false;
  const detachedResolution = agent.resolveObservedElement(resolverOptions);
  assert.equal(detachedResolution.state, "detached");
  assert.equal(detachedResolution.reason, "rebind_already_used");
  assert.equal(agent.resolveObservedElement({ ...resolverOptions, expectedDocument: { ...identity, token: "other-document" } }).state, "document_changed");

  agent.version = 3;
  vm.runInContext(source, context, { filename: pageAgentPath });
  const upgraded = vm.runInContext("globalThis.__piControlChromePageAgent", context);
  assert.notEqual(upgraded, agent);
  assert.equal(upgraded.version, 4);
  assert.equal(upgraded.lookup("snapshot", "snapshot-19")?.value, 19);

  vm.runInContext(source, context, { filename: pageAgentPath });
  assert.equal(vm.runInContext("globalThis.__piControlChromePageAgent", context), upgraded);
});

test("page generation reads the Page Agent document identity", async () => {
  const url = "https://example.test/page-generation";
  const fixture = loadExtension({ pageUrl: url, pageTimeOrigin: 321 });
  fixture.tabs.set(399, { id: 399, windowId: 1, title: "page", url });

  await fixture.api.executeInTab(399, fixture.api.pageGeneration);
  const first = fixture.api.pageGeneration();
  const second = fixture.api.pageGeneration();

  assert.equal(first.url, url);
  assert.equal(first.timeOrigin, 321);
  assert.equal(typeof first.token, "string");
  assert.deepEqual(second, first);
});

function record(tabId, lifecycle = "temporary", title = "", url = "") {
  return { tabId, browserId: "edge:test-extension:profile-id", windowId: 1, sessionId: "session-test", createdAt: 1, groupId: 1, owner: "agent", lifecycle, runtimeId: "profile-id", tabFence: `tab:${tabId}`, title, url };
}

function storedRecords(fixture) {
  const stored = fixture.storage[ownedTabsKey];
  return stored?.records || stored || {};
}

function storedRecord(fixture, tabId) {
  return Object.values(storedRecords(fixture)).find((entry) => Number(entry?.tabId) === Number(tabId));
}

test("advertises live-ref and semantic-rebind capabilities", async () => {
  const fixture = loadExtension();
  const status = await fixture.api.handleRequest("status", {});

  assert.equal(status.capabilities.liveRefs, true);
  assert.equal(status.capabilities.semanticRebind, true);
  assert.equal(status.capabilities.axRefs, true);
});

test("keeps the extension Bridge socket alive with application heartbeats", async () => {
  const fixture = loadExtension();
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.emitSocketOpen();
  assert.equal(fixture.heartbeatIntervals.size, 1);
  assert.equal([...fixture.heartbeatIntervals.values()][0].delay, 20_000);
  fixture.runHeartbeat();
  assert.deepEqual(fixture.heartbeatMessages.at(-1), { type: "ping" });
});

test("retains legacy ownership records for explicit stale recovery", async () => {
  const fixture = loadExtension();
  const legacy = record(301);
  delete legacy.runtimeId;
  fixture.storage[ownedTabsKey] = { "301": legacy };

  await fixture.api.handleRequest("list_tabs", {});
  assert.equal(fixture.storage[ownedTabsKey].version, 3);
  const migrated = storedRecord(fixture, 301);
  assert.equal(migrated?.runtimeId.startsWith("legacy-unknown-"), true);
});

test("ordinary ownership mutation preserves malformed records for explicit recovery", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(306, { id: 306, windowId: 1, title: "handoff", url: "about:blank" });
  fixture.storage[ownedTabsKey] = {
    version: 3,
    records: {
      "edge:test-extension:profile-id::306": record(306, "temporary", "handoff", "about:blank"),
      malformed: { tabId: 307, owner: "agent" },
    },
  };
  await fixture.api.handleRequest("mark_handoff", { tabId: 306, sessionId: "session-test", turnId: 4 });
  assert.equal(storedRecord(fixture, 306).lifecycle, "handoff");
  assert.deepEqual(storedRecords(fixture).malformed, { tabId: 307, owner: "agent" });
});

test("DevTools domain command uncertainty is not reported as a partial success", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(308, { id: 308, windowId: 1, title: "debug", url: "about:blank" });
  fixture.setDebuggerCommandFailure(true);
  await assert.rejects(
    fixture.api.handleRequest("devtools_enable", { tabId: 308, sessionId: "session-test", domains: ["Network"] }),
    (error) => error?.code === "BROWSER_OPERATION_UNCERTAIN" && error?.details?.actionState === "unknown",
  );
});

test("repairs malformed current ownership records before access", async () => {
  const fixture = loadExtension();
  fixture.storage[ownedTabsKey] = { version: 3, records: [] };

  await fixture.api.handleRequest("list_tabs", {});
  assert.deepEqual(fixture.storage[ownedTabsKey], { version: 3, records: {} });
});
test("filters malformed entries without a read-side storage write", async () => {
  const fixture = loadExtension();
  fixture.storage[ownedTabsKey] = { version: 3, records: { bad: null, negative: record(-1), fraction: record(1.5), missing: { ...record(302), tabId: undefined }, "edge:test-extension:profile-id::301": record(301) } };

  await fixture.api.handleRequest("list_tabs", {});
  assert.deepEqual(Object.keys(await fixture.api.ownedTabs()), ["edge:test-extension:profile-id::301"]);
  assert.deepEqual(Object.keys(storedRecords(fixture)).sort(), ["bad", "edge:test-extension:profile-id::301", "fraction", "missing", "negative"]);
});

test("captures a screenshot with debugger fallback", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(7, { id: 7, windowId: 1, title: "active", url: "about:blank", active: true });
  fixture.setVisibleCaptureFailure(true);

  const result = await fixture.api.handleRequest("screenshot", { tabId: 7, sessionId: "session-test" });
  assert.equal(result.data, "debugger-data");
});

test("read-only screenshot retries once when a user tab document changes", async () => {
  const generation = (token) => ({ url: "https://example.test/changing-shot", timeOrigin: 1, token });
  const fixture = loadExtension({
    pageGenerationSequence: [generation("one"), generation("one"), generation("one"), generation("two"), generation("two"), generation("two"), generation("two"), generation("two")],
  });
  fixture.tabs.set(319, { id: 319, windowId: 1, title: "changing", url: "https://example.test/changing-shot" });
  const result = await fixture.api.handleRequest("screenshot", { tabId: 319, sessionId: "session-test" });
  assert.equal(result.data, "debugger-data");
});

  test("debugger document epochs reject delayed loader and unqualified events", async () => {
    const fixture = loadExtension();
    fixture.tabs.set(309, { id: 309, windowId: 1, title: "debug", url: "about:blank" });
  await fixture.api.attachDebugger(309, "session-test", { lease: true });
  const source = { tabId: 309, targetId: "target-309" };
  await fixture.emitDebuggerEvent(source, "Page.lifecycleEvent", { frameId: "main", loaderId: "loader-a", name: "load" });
  await fixture.emitDebuggerEvent(source, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "document-a" }] });
  assert.equal(fixture.api.devtoolsState.get("test-extension::309")?.console.length, 1);
  await fixture.emitDebuggerEvent(source, "Page.frameNavigated", { frame: { id: "main" }, frameId: "main", loaderId: "loader-b" });
  await fixture.emitDebuggerEvent(source, "Page.lifecycleEvent", { frameId: "main", loaderId: "loader-a", name: "init" });
  await fixture.emitDebuggerEvent(source, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "stale" }] });
  await fixture.emitDebuggerEvent(source, "Page.lifecycleEvent", { frameId: "main", loaderId: "loader-b", name: "load" });
  await fixture.emitDebuggerEvent(source, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "unqualified-d2" }] });
  await fixture.emitDebuggerEvent(source, "Page.frameStartedLoading", { frameId: "main" });
  await fixture.emitDebuggerEvent(source, "Page.lifecycleEvent", { frameId: "main", name: "load" });
  await fixture.emitDebuggerEvent(source, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "unqualified-d3" }] });
  assert.equal(fixture.api.devtoolsState.get("test-extension::309")?.documentEpoch, 1);
  assert.equal(fixture.api.devtoolsState.get("test-extension::309")?.console.length, 0);
  await fixture.api.detachDebugger(309, "session-test");
});


test("new-tab setup fences an event-before-reservation numeric id reuse", async () => {
  const fixture = loadExtension({ createTabId: 7 });
  await fixture.api.attachDebugger(7, "old-session", { lease: true });
  const result = await fixture.api.handleRequest("new_tab", { url: "https://example.test/new", sessionId: "session-test" });
  assert.equal(result.tab.id, 7);
  assert.equal(fixture.api.persistentDebuggers.has("test-extension::7"), false);
  assert.equal(fixture.api.orphanedDebuggerAttaches.get("test-extension::7")?.tabFence === result.tab.handle.tabFence, false);
  assert.equal(storedRecord(fixture, 7).sessionId, "session-test");
});
test("new-tab can target an explicit browser window", async () => {
  const fixture = loadExtension();
  const result = await fixture.api.handleRequest("new_tab", { url: "about:blank", windowId: 7, wait: false, sessionId: "session-test" });
  assert.equal(result.tab.windowId, 7);
  assert.equal(fixture.tabs.get(result.tab.id).windowId, 7);
});


test("new-tab load wait accepts browser URL canonicalization without requiring redirects", async () => {
  const fixture = loadExtension({ createdTabUrl: "https://example.test/" });
  const result = await fixture.api.handleRequest("new_tab", { url: "https://example.test", wait: true, sessionId: "session-test" });
  assert.equal(result.tab.url, "https://example.test/");
  assert.equal(result.tab.handle.url, "https://example.test/");
});


test("Bridge new-tab wait accepts canonical URL normalization", async () => {
  const fixture = loadExtension({ createdTabUrl: "https://example.test/" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.emitSocketOpen();
  const requestId = "new-tab-canonical";
  await fixture.emitSocketMessage({
    type: "request",
    id: requestId,
    method: "new_tab",
    params: { url: "https://example.test", wait: true, sessionId: "session-test" },
  });
  const response = fixture.heartbeatMessages.find((message) => message.type === "response" && message.id === requestId);
  assert.equal(response?.error, undefined, JSON.stringify(fixture.heartbeatMessages));
  assert.equal(response?.result?.tab?.url, "https://example.test/");
});


test("new-tab setup tolerates a restricted about:blank document", async () => {
  const fixture = loadExtension({ restrictedPageError: 'Cannot access contents of url "about:blank". Extension manifest must request permission to access this host.' });
  const result = await fixture.api.handleRequest("new_tab", { url: "about:blank", wait: false, sessionId: "session-test" });
  assert.equal(result.tab.url, "about:blank");
  assert.equal(result.tab.handle.incarnation, undefined);
  assert.equal(storedRecord(fixture, result.tab.id)?.tabFence, result.tab.handle.tabFence);
});


test("replacement transfer requires the old fence and preserves ownership on the added tab", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(20, { id: 20, windowId: 1, title: "replace", url: "https://example.test/replace" });
  fixture.tabs.set(21, { id: 21, windowId: 1, title: "replace", url: "https://example.test/replace" });
  fixture.tabs.delete(20);
  const oldRecord = record(20, "temporary", "replace", "https://example.test/replace");
  fixture.storage[ownedTabsKey] = { version: 3, records: { ["edge:test-extension:profile-id::20"]: oldRecord } };
  fixture.storage[tabFencesKey] = { "test-extension::20": oldRecord.tabFence };
  fixture.api.accessibilitySnapshotStates.set("test-extension::20", { snapshotId: "old-ax", nodes: [] });
  fixture.api.accessibilitySnapshotStates.set("test-extension::21", { snapshotId: "added-ax", nodes: [] });
  await fixture.emitTabReplaced(21, 20);
  const replacementTombstone = fixture.api.tabRemovalTombstones.get("test-extension::20");
  await fixture.emitTabReplaced(21, 20);
  assert.equal(replacementTombstone?.replacementEpoch, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(storedRecord(fixture, 20), undefined);
  assert.equal(storedRecord(fixture, 21)?.tabId, 21);
  assert.equal(storedRecord(fixture, 21)?.tabFence === oldRecord.tabFence, false);
  assert.equal(fixture.api.accessibilitySnapshotStates.get("test-extension::20"), undefined);
  assert.equal(fixture.api.accessibilitySnapshotStates.get("test-extension::21"), undefined);
});
test("duplicate tab removal events converge without restoring ownership", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(102, { id: 102, windowId: 1, title: "", url: "about:blank" });
  fixture.storage[ownedTabsKey] = { version: 3, records: { "edge:test-extension:profile-id::102": record(102) } };
  fixture.tabs.delete(102);
  await fixture.emitTabRemoved(102);
  await fixture.emitTabRemoved(102);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(storedRecord(fixture, 102), undefined);
});
test("same-id tab reuse keeps delayed removal ownership fenced", async () => {
  const fixture = loadExtension({ createTabId: 7, sessionStorage: { [tabFencesKey]: { "test-extension::7": "tab:old" } } });
  fixture.tabs.set(7, { id: 7, windowId: 1, title: "old", url: "https://example.test/old" });
  await fixture.emitTabRemoved(7);
  const created = await fixture.api.handleRequest("new_tab", { url: "https://example.test/new", sessionId: "session-test" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(created.tab.id, 7);
  assert.equal(storedRecord(fixture, 7)?.sessionId, "session-test");
  assert.equal(storedRecord(fixture, 7)?.tabFence, created.tab.handle.tabFence);
});


test("download waits complete through the tracked barrier and cache download events", async () => {
  const fixture = loadExtension();
  const started = await fixture.api.handleRequest("download", { action: "start", url: "https://example.test/download", wait: false });
  const downloadId = started.download.id;
  const waiting = fixture.api.trackDownloadWait(downloadId, "download-session", () => fixture.api.handleRequest("download", { action: "wait", downloadId, timeoutMs: 1000, sessionId: "download-session" }, { skipDownloadBarrier: true }));
  const completionEvent = new Promise((resolve) => setTimeout(async () => {
    const item = fixture.downloads.get(downloadId);
    item.state = "complete";
    item.bytesReceived = 10;
    await fixture.emitDownloadChanged({ id: downloadId, state: { current: "complete" }, bytesReceived: { current: 10 } });
    resolve();
  }, 20));
  const completed = await waiting;
  await completionEvent;
  assert.equal(completed.download.state, "complete");
  assert.equal(completed.download.bytesReceived, 10);
  const cached = [...fixture.api.downloadState.values()].find((item) => Number(item.id) === downloadId);
  assert.equal(cached.state, "complete");
  assert.equal(cached.bytesReceived, 10);
});
test("cleanup forgets ownership for a tab already closed by the browser", async () => {
  const fixture = loadExtension();
  fixture.storage[ownedTabsKey] = { "edge:test-extension:profile-id::101": record(101) };
  const result = await fixture.api.handleRequest("cleanup", { sessionId: "session-test", mode: "turn", turnId: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(result.removed)), [101]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.failed)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(result.retained)), []);
  assert.equal(storedRecord(fixture, 101), undefined);
});

test("explicit stale ownership recovery forgets records without closing unknown tabs", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(305, { id: 305, windowId: 1, title: "stale agent tab", url: "about:blank" });
  fixture.storage[ownedTabsKey] = {
    version: 3,
    records: { "edge:test-extension:profile-id::305": { ...record(305), runtimeId: "old-runtime" } },
  };
  const result = await fixture.api.handleRequest("cleanup", { sessionId: "session-test", recoverStale: true });
  assert.deepEqual(Array.from(result.recovered), [305]);
  assert.deepEqual(Array.from(result.removed), []);
  assert.deepEqual(Array.from(result.failed), []);
  assert.equal(fixture.tabs.has(305), true);
  assert.equal(storedRecord(fixture, 305), undefined);
});
test("cleanup retains ownership after a real close failure and retries it", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(101, { id: 101, windowId: 1, title: "temporary", url: "about:blank" });
  fixture.storage[ownedTabsKey] = { "edge:test-extension:profile-id::101": record(101, "temporary", "temporary", "about:blank") };
  fixture.removeFailures.add(101);

  const first = await fixture.api.handleRequest("cleanup", { sessionId: "session-test", mode: "turn", turnId: 1 });
  assert.deepEqual(Array.from(first.removed), []);
  assert.deepEqual(Array.from(first.retained), [101]);
  assert.deepEqual(Array.from(first.failed, (entry) => ({ tabId: Number(entry.tabId), error: String(entry.error) })), [{ tabId: 101, error: "Error: simulated tab close failure" }]);
  assert.ok(storedRecord(fixture, 101));

  fixture.removeFailures.delete(101);
  const second = await fixture.api.handleRequest("cleanup", { sessionId: "session-test", mode: "turn", turnId: 2 });
  assert.deepEqual(Array.from(second.removed), [101]);
  assert.deepEqual(Array.from(second.retained), []);
  assert.deepEqual(Array.from(second.failed), []);
  assert.equal(storedRecord(fixture, 101), undefined);
});

test("non-turn cleanup transfers retained tab control without closing it", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(111, { id: 111, windowId: 1, title: "handoff", url: "about:blank" });
  fixture.storage[ownedTabsKey] = { "edge:test-extension:profile-id::111": record(111, "handoff", "handoff", "about:blank") };

  const result = await fixture.api.handleRequest("cleanup", { sessionId: "session-test" });
  assert.deepEqual(Array.from(result.removed), []);
  assert.deepEqual(Array.from(result.released), [111]);
  assert.deepEqual(Array.from(result.retained), []);
  assert.deepEqual(Array.from(result.failed), []);
  assert.equal(fixture.tabs.has(111), true);
  assert.equal(storedRecord(fixture, 111), undefined);
});

test("cleanup leaves another target's ownership record untouched", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(101, { id: 101, windowId: 1, title: "edge", url: "about:blank" });
  fixture.tabs.set(202, { id: 202, windowId: 2, title: "chrome", url: "about:blank" });
  fixture.storage[ownedTabsKey] = {
    version: 3,
    records: {
      "edge:test-extension:profile-id::101": { ...record(101, "temporary", "edge", "about:blank"), browserId: "edge:test-extension:profile-id" },
      "chrome:other-profile::202": { ...record(202), browserId: "chrome:other-profile" },
    },
  };

  const result = await fixture.api.handleRequest("cleanup", { sessionId: "session-test" });
  assert.deepEqual(Array.from(result.removed), [101]);
  assert.equal(storedRecord(fixture, 101), undefined);
  assert.equal(storedRecord(fixture, 202).browserId, "chrome:other-profile");
});
test("extension serializes concurrent claims without overwriting ownership", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(303, { id: 303, windowId: 1, title: "claimable", url: "about:blank", active: true });
  const request = { tabId: 303, windowId: 1, title: "claimable", url: "about:blank" };
  const outcomes = await Promise.allSettled([
    fixture.api.handleRequest("claim_tab", { ...request, sessionId: "session-a" }),
    fixture.api.handleRequest("claim_tab", { ...request, sessionId: "session-b" }),
  ]);
  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((entry) => entry.status === "rejected").length, 1);
  const stored = storedRecord(fixture, 303);
  assert.ok(stored);
  assert.ok(["session-a", "session-b"].includes(stored.sessionId));
});

test("target mismatch errors include a stable diagnostic code", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(306, { id: 306, windowId: 1, title: "target", url: "https://example.test/target" });
  await assert.rejects(
    () => fixture.api.handleRequest("snapshot", {
      tabId: 306,
      handle: { tabId: 306, browserId: "chrome:other", windowId: 1, title: "target", url: "https://example.test/target", tabFence: "tab:306", incarnation: "https://example.test/target\\u00001\\u0000fixture-document-token" },
      sessionId: "session-test",
    }),
    (error) => error?.code === "BROWSER_TARGET_MISMATCH"
      && error?.details?.expectedBrowserId === "chrome:other"
      && error?.details?.currentBrowserId === "edge:test-extension:profile-id",
  );
});

test("browser error pages return a structured unavailable-page diagnostic", async () => {
  const fixture = loadExtension({ restrictedPageError: "Frame with ID 0 is showing error page" });
  fixture.tabs.set(307, { id: 307, windowId: 1, title: "error", url: "about:blank" });
  await assert.rejects(
    () => fixture.api.handleRequest("snapshot", { tabId: 307, sessionId: "session-test" }),
    (error) => error?.code === "BROWSER_PAGE_UNAVAILABLE"
      && error?.details?.tabId === 307
      && /browser error page or restricted page/.test(error?.message || ""),
  );
});


test("page selector failures retain a deterministic diagnostic", async () => {
  const fixture = loadExtension({
    executeScriptException: {
      functionName: "collectSnapshot",
      details: { text: "Uncaught", exception: { description: "Error: Snapshot selector did not match any element: main" } },
    },
  });
  fixture.tabs.set(308, { id: 308, windowId: 1, title: "selector", url: "https://example.test/selector" });
  await assert.rejects(
    () => fixture.api.handleRequest("snapshot", { tabId: 308, selector: "main", sessionId: "session-test" }),
    (error) => error?.code === "BROWSER_SELECTOR_NOT_FOUND"
      && error?.details?.tabId === 308
      && error?.details?.selector === "main",
  );
});

test("accessibility snapshots use Chromium AX and preserve the bounded public tree", async () => {
  const fixture = loadExtension({
    executeScriptResults: {
      collectSnapshot: {
        snapshotId: "snapshot-ax-1",
        __piControlChromeSnapshotUrl: "https://example.test/ax",
        __piControlChromeSnapshotTimeOrigin: 1,
        __piControlChromeSnapshotToken: "fixture-document-token",
        title: "AX test",
        url: "https://example.test/ax",
        text: "Save",
        elements: [],
      },
    },
    debuggerCommandResult: async (method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-main", loaderId: "loader-main" } } };
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return {
        nodes: [
          { nodeId: "root", role: { type: "role", value: "RootWebArea" }, name: { type: "string", value: "AX test" }, ignored: false },
          { nodeId: "button", backendDOMNodeId: 42, role: { type: "role", value: "button" }, name: { type: "string", value: "Save" }, ignored: false, properties: [{ name: "disabled", value: { type: "boolean", value: false } }] },
          { nodeId: "password", backendDOMNodeId: 43, role: { type: "role", value: "textbox" }, name: { type: "string", value: "Account" }, value: { type: "string", value: "hunter2" }, ignored: false },
          { nodeId: "hidden", backendDOMNodeId: 44, role: { type: "role", value: "button" }, name: { type: "string", value: "Hidden" }, ignored: true },
        ],
      };
      if (method === "DOM.describeNode" && params?.backendNodeId === 43) return { node: { nodeName: "INPUT", attributes: ["autocomplete", "current-password", "type", "text"] } };
      return {};
    },
  });
  fixture.tabs.set(309, { id: 309, windowId: 1, title: "AX test", url: "https://example.test/ax", status: "complete" });

  const result = await fixture.api.handleRequest("snapshot", { tabId: 309, accessibilityOnly: true, sessionId: "session-test" });
  const accessibility = result.snapshot.accessibility;
  assert.equal(accessibility.source, "chromium_ax");
  assert.equal(accessibility.mode, "full");
  assert.equal(accessibility.children.length, 2);
  assert.equal(accessibility.children[0].role, "button");
  assert.equal(accessibility.children[0].name, "Save");
  assert.equal(accessibility.children[0].value, undefined);
  assert.equal(accessibility.children[1].role, "textbox");
  assert.equal(accessibility.children[1].name, "Account");
  assert.equal(accessibility.children[1].value, undefined);
  assert.match(accessibility.state, /\[ref=a1\]/);
  assert.match(accessibility.state, /\[ref=a2\]/);
  assert.equal(JSON.stringify(accessibility).includes("backendDOMNodeId"), false);
  assert.equal(JSON.stringify(accessibility).includes("hunter2"), false);
  assert.ok(fixture.debuggerCommandCalls.some(({ method }) => method === "Accessibility.enable"));
  assert.ok(fixture.debuggerCommandCalls.some(({ method }) => method === "Accessibility.getFullAXTree"));
  const limited = await fixture.api.handleRequest("snapshot", { tabId: 309, accessibilityOnly: true, maxChars: 1, sessionId: "session-test" });
  assert.equal(limited.snapshot.accessibility.truncated, true);
});

test("accessibility selector reads use a main-frame partial AX tree", async () => {
  const fixture = loadExtension({
    executeScriptResults: {
      collectSnapshot: {
        snapshotId: "snapshot-ax-selector",
        __piControlChromeSnapshotUrl: "https://example.test/ax-selector",
        __piControlChromeSnapshotTimeOrigin: 1,
        __piControlChromeSnapshotToken: "fixture-document-token",
        title: "AX selector",
        url: "https://example.test/ax-selector",
        text: "Continue",
        elements: [],
      },
    },
    debuggerCommandResult: async (method) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-main" } } };
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.describeNode") return { node: { backendNodeId: 52 } };
      if (method === "Accessibility.getPartialAXTree") return {
        nodes: [{ nodeId: "button", backendDOMNodeId: 52, role: { type: "role", value: "button" }, name: { type: "string", value: "Continue" }, ignored: false, childIds: [] }],
      };
      return {};
    },
  });
  fixture.tabs.set(310, { id: 310, windowId: 1, title: "AX selector", url: "https://example.test/ax-selector", status: "complete" });

  const result = await fixture.api.handleRequest("snapshot", { tabId: 310, selector: "main", accessibilityOnly: true, sessionId: "session-test" });
  assert.equal(result.snapshot.accessibility.children.length, 1);
  assert.equal(result.snapshot.accessibility.children[0].role, "button");
  const methods = fixture.debuggerCommandCalls.map(({ method }) => method);
  assert.ok(methods.indexOf("Accessibility.enable") < methods.indexOf("DOM.enable"));
  assert.ok(methods.indexOf("DOM.querySelector") < methods.indexOf("Accessibility.getPartialAXTree"));
  const partial = fixture.debuggerCommandCalls.find(({ method }) => method === "Accessibility.getPartialAXTree");
  assert.equal(partial.params.fetchRelatives, true);
});

test("accessibility reads report a changing frame instead of mixing AX trees", async () => {
  let frameRead = 0;
  const fixture = loadExtension({
    executeScriptResults: {
      collectSnapshot: {
        snapshotId: "snapshot-ax-changing-frame",
        __piControlChromeSnapshotUrl: "https://example.test/ax-changing-frame",
        __piControlChromeSnapshotTimeOrigin: 1,
        __piControlChromeSnapshotToken: "fixture-document-token",
        title: "AX changing frame",
        url: "https://example.test/ax-changing-frame",
        text: "Changing frame",
        elements: [],
      },
    },
    debuggerCommandResult: async (method) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-main", loaderId: `loader-${++frameRead}` } } };
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return { nodes: [{ nodeId: "button", backendDOMNodeId: 62, role: { type: "role", value: "button" }, name: { type: "string", value: "Continue" }, ignored: false }] };
      return {};
    },
  });
  fixture.tabs.set(313, { id: 313, windowId: 1, title: "AX changing frame", url: "https://example.test/ax-changing-frame", status: "complete" });

  await assert.rejects(
    () => fixture.api.handleRequest("snapshot", { tabId: 313, accessibilityOnly: true, sessionId: "session-test" }),
    (error) => error?.code === "BROWSER_PAGE_CHANGING" && error?.details?.frameChanged === true,
  );
});

test("unavailable Chromium AX falls back to the DOM semantic collector", async () => {
  const fixture = loadExtension({
    executeScriptResults: {
      collectSnapshot: {
        snapshotId: "snapshot-ax-fallback",
        __piControlChromeSnapshotUrl: "https://example.test/ax-fallback",
        __piControlChromeSnapshotTimeOrigin: 1,
        __piControlChromeSnapshotToken: "fixture-document-token",
        title: "AX fallback",
        url: "https://example.test/ax-fallback",
        text: "Fallback",
        elements: [],
      },
      collectDomAccessibilitySnapshot: {
        role: "document",
        name: "AX fallback",
        children: [{ role: "button", name: "Fallback" }],
        state: "- button \\\"Fallback\\\"",
        nodeCount: 1,
        maxChars: 20000,
        maxNodes: 200,
      },
    },
    debuggerCommandResult: async (method) => {
      if (method === "Accessibility.enable") throw new Error("Method not found");
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-main" } } };
      return {};
    },
  });
  fixture.tabs.set(311, { id: 311, windowId: 1, title: "AX fallback", url: "https://example.test/ax-fallback", status: "complete" });

  const result = await fixture.api.handleRequest("snapshot", { tabId: 311, accessibilityOnly: true, sessionId: "session-test" });
  assert.equal(result.snapshot.accessibility.source, "dom_semantic");
  assert.equal(result.snapshot.accessibility.children.length, 1);
  assert.equal(result.snapshot.accessibility.children[0].role, "button");
  assert.equal(result.snapshot.accessibility.children[0].name, "Fallback");
  assert.equal(fixture.debuggerCommandCalls.some(({ method }) => method === "Accessibility.getFullAXTree"), false);
});

test("AX refs map to backend DOM nodes, fence frames, and allow one semantic rebind", async () => {
  let backendNodeId = 42;
  let frameLoaderId = "loader-1";
  const fixture = loadExtension({
    executeScriptResults: {
      collectSnapshot: {
        snapshotId: "snapshot-ax-ref",
        __piControlChromeSnapshotUrl: "https://example.test/ax-ref",
        __piControlChromeSnapshotTimeOrigin: 1,
        __piControlChromeSnapshotToken: "fixture-document-token",
        title: "AX ref",
        url: "https://example.test/ax-ref",
        text: "Save",
        elements: [],
      },
    },
    debuggerCommandResult: async (method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-main", loaderId: frameLoaderId } } };
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return {
        nodes: [
          { nodeId: "root", role: { type: "role", value: "RootWebArea" }, name: { type: "string", value: "AX ref" }, ignored: false },
          { nodeId: `button-${backendNodeId}`, backendDOMNodeId: backendNodeId, role: { type: "role", value: "button" }, name: { type: "string", value: "Save" }, ignored: false },
          { nodeId: "password", backendDOMNodeId: 45, role: { type: "role", value: "textbox" }, name: { type: "string", value: "Account" }, value: { type: "string", value: "hunter2" }, ignored: false },
        ],
      };
      if (method === "DOM.describeNode" && params?.backendNodeId === 45) return { node: { nodeName: "INPUT", attributes: ["autocomplete", "current-password", "type", "text"] } };
      if (method === "DOM.resolveNode") return { object: { objectId: "ax-object" } };
      if (method === "Runtime.callFunctionOn") {
        const operation = params?.arguments?.[0]?.value;
        if (operation === "getAttribute") return { result: { type: "string", value: params?.arguments?.[3]?.value === true ? null : "safe" } };
        return { result: { type: "object", value: { ok: true, operation } } };
      }
      if (method === "Runtime.releaseObject") return {};
      return {};
    },
  });
  fixture.tabs.set(312, { id: 312, windowId: 1, title: "AX ref", url: "https://example.test/ax-ref", status: "complete" });

  const snapshot = await fixture.api.handleRequest("snapshot", { tabId: 312, accessibilityOnly: true, sessionId: "session-test" });
  const ref = snapshot.snapshot.accessibility.children[0].ref;
  assert.match(ref, /^a\d+$/);

  const direct = await fixture.api.resolveAccessibilityNode(312, { ref, snapshotId: snapshot.snapshot.snapshotId, sessionId: "session-test" }, "session-test");
  assert.equal(direct.value.resolvedBy, "ax_backend_node");
  assert.equal(direct.value.rebound, false);

  const action = await fixture.api.handleRequest("interaction", { tabId: 312, ref, snapshotId: snapshot.snapshot.snapshotId, operation: "click", sessionId: "session-test" });
  assert.equal(action.result.ok, true);
  const sensitiveRef = snapshot.snapshot.accessibility.children.find(node => node.name === "Account").ref;
  const sensitiveValue = await fixture.api.handleRequest("locator", { tabId: 312, target: { ref: sensitiveRef }, snapshotId: snapshot.snapshot.snapshotId, action: "getAttribute", attribute: "value", sessionId: "session-test" });
  assert.equal(sensitiveValue.result, null);
  assert.equal(action.result.resolvedBy, "ax_backend_node");
  assert.equal(action.result.rebound, false);
  assert.equal(action.result.element.ref, ref);
  assert.equal(fixture.executeScriptCalls.some((call) => call.functionName === "pageOperation"), false);
  assert.ok(fixture.debuggerCommandCalls.some(({ method }) => method === "DOM.resolveNode"));
  assert.equal(fixture.debuggerCommandCalls.some(({ method, params }) => method === "Runtime.callFunctionOn" && params?.arguments?.[0]?.value === "click"), true);

  backendNodeId = 43;
  const rebound = await fixture.api.handleRequest("interaction", { ref, snapshotId: snapshot.snapshot.snapshotId, operation: "click", sessionId: "session-test", tabId: 312 });
  assert.equal(rebound.result.resolvedBy, "ax_semantic_rebind");
  assert.equal(rebound.result.rebound, true);

  backendNodeId = 44;
  frameLoaderId = "loader-2";
  await assert.rejects(
    () => fixture.api.handleRequest("interaction", { tabId: 312, ref, snapshotId: snapshot.snapshot.snapshotId, operation: "click", sessionId: "session-test" }),
    (error) => error?.code === "BROWSER_DOCUMENT_CHANGED" && error?.details?.snapshotId === snapshot.snapshot.snapshotId,
  );
});

test("extract accepts an unowned user tab without a returned document handle", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(316, { id: 316, windowId: 1, title: "user tab", url: "https://example.test/user" });
  const result = await fixture.api.handleRequest("extract", { tabId: 316, sessionId: "session-test" });
  assert.equal(result.tabId, 316);
  assert.equal(typeof result.incarnation, "string");
});

test("read-only extract retries once when a user tab document changes", async () => {
  const generation = (token) => ({ url: "https://example.test/changing", timeOrigin: 1, token });
  const fixture = loadExtension({
    pageGenerationSequence: [generation("one"), generation("one"), generation("one"), generation("two"), generation("two"), generation("two"), generation("two"), generation("two")],
    executeScriptResults: { extractPage: { title: "changing", url: "https://example.test/changing", text: "stable", markdown: "stable", truncated: false } },
  });
  fixture.tabs.set(317, { id: 317, windowId: 1, title: "changing", url: "https://example.test/changing" });
  const result = await fixture.api.handleRequest("extract", { tabId: 317, sessionId: "session-test" });
  assert.equal(result.tabId, 317);
  assert.equal(result.content.text, "stable");
  assert.equal(result.incarnation, "https://example.test/changing\u00001\u0000two");
});

test("read-only extract reports a changing page after the bounded retry", async () => {
  const generation = (token) => ({ url: "https://example.test/changing", timeOrigin: 1, token });
  const fixture = loadExtension({ pageGenerationSequence: [generation("one"), generation("two"), generation("three"), generation("four")] });
  fixture.tabs.set(318, { id: 318, windowId: 1, title: "changing", url: "https://example.test/changing" });
  await assert.rejects(
    () => fixture.api.handleRequest("extract", { tabId: 318, sessionId: "session-test" }),
    (error) => error?.code === "BROWSER_PAGE_CHANGING"
      && error?.details?.tabId === 318
      && error?.details?.attempts === 2
      && error?.details?.retryable === true
      && error?.details?.inspectFirst === false,
  );
});

test("side-effecting requests keep strict document fencing after read-only re-observation", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(320, { id: 320, windowId: 1, title: "fenced", url: "https://example.test/fenced" });
  const listed = await fixture.api.handleRequest("list_tabs", {});
  const current = listed.tabs.find((entry) => entry.id === 320);
  assert.ok(current);
  const handle = { ...current.handle, incarnation: "https://example.test/fenced\u00001\u0000old-document-token" };
  await assert.rejects(
    () => fixture.api.handleRequest("evaluate", { tabId: 320, handle, sessionId: "session-test", expression: "window.location.href" }),
    /Tab handle is stale: document incarnation changed/,
  );
});

test("a known-dispatched page action succeeds when its post-action document identity is verified", async () => {
  const oldDocument = { url: "https://example.test/action", timeOrigin: 1, token: "old-document" };
  const newDocument = { url: "https://example.test/action", timeOrigin: 2, token: "new-document" };
  const fixture = loadExtension({
    pageGenerationSequence: [oldDocument, newDocument],
    executeScriptResults: { pageOperation: { ok: true, operation: "click", ref: "e1" } },
  });
  fixture.tabs.set(319, { id: 319, windowId: 1, title: "action", url: oldDocument.url, status: "complete" });

  const result = await fixture.api.handleRequest("interaction", { tabId: 319, operation: "click", ref: "e1", snapshotId: "observation-1", sessionId: "session-test" });

  assert.equal(result.result?.ok, true);
  assert.equal(result.result?.postActionDocumentChanged, true);
  const actionCall = fixture.executeScriptCalls.find((call) => call.functionName === "pageOperation");
  assert.equal(actionCall?.args?.[0]?.__expectedActionUrl, oldDocument.url);
  assert.equal(actionCall?.args?.[0]?.__expectedActionTimeOrigin, oldDocument.timeOrigin);
  assert.equal(actionCall?.args?.[0]?.__expectedActionToken, oldDocument.token);
});

test("a dispatched page action remains uncertain when its post-action document identity cannot be verified", async () => {
  const oldDocument = { url: "https://example.test/action", timeOrigin: 1, token: "old-document" };
  const fixture = loadExtension({
    pageGenerationSequence: [oldDocument, {}],
    executeScriptResults: { pageOperation: { ok: true, operation: "click", ref: "e1" } },
  });
  fixture.tabs.set(324, { id: 324, windowId: 1, title: "action", url: oldDocument.url, status: "complete" });

  await assert.rejects(
    () => fixture.api.handleRequest("interaction", { tabId: 324, operation: "click", ref: "e1", snapshotId: "observation-1", sessionId: "session-test" }),
    (error) => error?.code === "BROWSER_OPERATION_UNCERTAIN"
      && error?.details?.actionState === "unknown"
      && error?.details?.inspectFirst === true,
  );
  assert.equal(fixture.executeScriptCalls.some((call) => call.functionName === "pageOperation"), true);
});

test("a side effect is not dispatched when its source document identity is unavailable", async () => {
  const fixture = loadExtension({
    pageGenerationSequence: [{}],
    executeScriptResults: { pageOperation: { ok: true, operation: "click", ref: "e1" } },
  });
  fixture.tabs.set(325, { id: 325, windowId: 1, title: "action", url: "https://example.test/action", status: "complete" });

  await assert.rejects(
    () => fixture.api.handleRequest("interaction", { tabId: 325, operation: "click", ref: "e1", snapshotId: "observation-1", sessionId: "session-test" }),
    (error) => error?.code === "BROWSER_OPERATION_UNCERTAIN" && error?.details?.actionState === "unknown",
  );
  assert.equal(fixture.executeScriptCalls.some((call) => call.functionName === "pageOperation"), false);
});

test("wait-false navigation returns a transition-pending handle without probing a changing document", async () => {
  const fixture = loadExtension({ pageGenerationSequence: [undefined] });
  fixture.tabs.set(326, { id: 326, windowId: 1, title: "old", url: "https://example.test/old", status: "complete" });

  const result = await fixture.api.handleRequest("navigate", {
    tabId: 326,
    url: "https://example.test/new",
    wait: false,
    sessionId: "session-test",
  });

  assert.equal(result.tab.id, 326);
  assert.equal(result.tab.url, "https://example.test/new");
  assert.equal(result.tab.transitionPending, true);
  assert.equal(result.tab.handle.incarnation, undefined);
  assert.equal(result.tab.handle.title, undefined);
  assert.equal(result.tab.handle.url, undefined);
  assert.match(result.tab.handle.tabFence, /^tab:/);
  assert.equal(fixture.executeScriptCalls.some((call) => call.functionName === "pageGeneration"), false);
});

test("a transition-pending handle remains usable for the required load wait", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(334, { id: 334, windowId: 1, title: "source", url: "https://example.test/source", status: "complete" });
  const transition = await fixture.api.handleRequest("navigate", {
    tabId: 334,
    url: "https://example.test/destination",
    wait: false,
    sessionId: "session-test",
  });
  assert.equal(transition.tab.handle.url, undefined);
  const waiting = fixture.api.handleRequest("wait", { handle: transition.tab.handle, state: "load", sessionId: "session-test" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  fixture.tabs.get(334).status = "complete";
  await fixture.emitTabUpdated(334, { status: "complete" }, fixture.tabs.get(334));
  const ready = await waiting;
  assert.equal(ready.condition, "load");
  assert.equal(ready.tab.id, 334);
});

test("a claimed transition-pending handle remains usable for the required load wait", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(335, { id: 335, windowId: 1, title: "source", url: "https://example.test/source", status: "complete" });
  await fixture.api.handleRequest("claim_tab", { tabId: 335, sessionId: "session-test" });
  const transition = await fixture.api.handleRequest("navigate", {
    tabId: 335,
    url: "https://example.test/destination",
    wait: false,
    sessionId: "session-test",
  });

  const waiting = fixture.api.handleRequest("wait", { handle: transition.tab.handle, state: "load", sessionId: "session-test" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  fixture.tabs.get(335).status = "complete";
  await fixture.emitTabUpdated(335, { status: "complete" }, fixture.tabs.get(335));
  const ready = await waiting;

  assert.equal(ready.condition, "load");
  assert.equal(ready.tab.id, 335);
});

test("history back falls back to a fenced CDP history entry when Tabs API falsely reports no entry", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(330, { id: 330, windowId: 1, title: "history", url: "https://example.test/current", status: "complete" });
  fixture.chrome.tabs.goBack = async () => { throw new Error("Cannot find a next page in history."); };
  const commands = [];
  fixture.chrome.debugger.sendCommand = async (_debuggee, method, params = {}) => {
    commands.push({ method, params });
    if (method === "Page.getNavigationHistory") {
      return { currentIndex: 1, entries: [{ id: 10, url: "https://example.test/previous" }, { id: 11, url: "https://example.test/current" }] };
    }
    if (method === "Page.navigateToHistoryEntry") return {};
    return {};
  };

  const result = await fixture.api.handleRequest("back", { tabId: 330, sessionId: "session-test" });

  assert.equal(result.tab.transitionPending, true);
  assert.equal(result.tab.handle.incarnation, undefined);
  assert.deepEqual(commands.map((entry) => entry.method), ["Page.getNavigationHistory", "Page.navigateToHistoryEntry"]);
  assert.equal(commands[1].params.entryId, 10);
  assert.equal(fixture.api.pendingDocumentTransitions.get("test-extension::330")?.observed, false);
});

test("history fallback fails closed when the document changes while selecting an entry", async () => {
  const current = { url: "https://example.test/current", timeOrigin: 1, token: "source" };
  const replacement = { ...current, token: "replacement" };
  const fixture = loadExtension({ pageGenerationSequence: [current, current, replacement, replacement] });
  fixture.tabs.set(336, { id: 336, windowId: 1, title: "history", url: current.url, status: "complete" });
  fixture.chrome.tabs.goBack = async () => { throw new Error("Cannot find a next page in history."); };
  const commands = [];
  fixture.chrome.debugger.sendCommand = async (_debuggee, method) => {
    commands.push(method);
    if (method === "Page.getNavigationHistory") {
      return { currentIndex: 1, entries: [{ id: 10, url: "https://example.test/previous" }, { id: 11, url: current.url }] };
    }
    return {};
  };

  await assert.rejects(
    () => fixture.api.handleRequest("back", { tabId: 336, sessionId: "session-test" }),
    (error) => error?.code === "BROWSER_DOCUMENT_CHANGED" && error?.details?.actionState === "not_completed",
  );
  assert.deepEqual(commands, ["Page.getNavigationHistory"]);
  assert.equal(fixture.api.pendingDocumentTransitions.has("test-extension::336"), false);
});

test("history back without an adjacent CDP entry fails deterministically before dispatch", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(331, { id: 331, windowId: 1, title: "history", url: "https://example.test/first", status: "complete" });
  fixture.chrome.tabs.goBack = async () => { throw new Error("Cannot find a next page in history."); };
  fixture.chrome.debugger.sendCommand = async (_debuggee, method) => method === "Page.getNavigationHistory"
    ? { currentIndex: 0, entries: [{ id: 12, url: "https://example.test/first" }] }
    : {};

  await assert.rejects(
    () => fixture.api.handleRequest("back", { tabId: 331, sessionId: "session-test" }),
    (error) => error?.code === "BROWSER_HISTORY_UNAVAILABLE" && error?.details?.direction === "back",
  );
  assert.equal(fixture.api.pendingDocumentTransitions.has("test-extension::331"), false);
});

test("reload returns a transition-pending handle without probing a changing document", async () => {
  const fixture = loadExtension({ pageGenerationSequence: [undefined] });
  fixture.tabs.set(329, { id: 329, windowId: 1, title: "reload", url: "https://example.test/reload", status: "complete" });
  const result = await fixture.api.handleRequest("reload", { tabId: 329, sessionId: "session-test" });

  assert.equal(result.tab.transitionPending, true);
  assert.equal(result.tab.handle.incarnation, undefined);
  assert.equal(result.tab.handle.url, undefined);
  assert.equal(fixture.executeScriptCalls.some((call) => call.functionName === "pageGeneration"), false);
});

test("document-bound requests reject an unobserved Agent transition before injecting into the source page", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(333, { id: 333, windowId: 1, title: "source", url: "https://example.test/source", status: "complete" });
  const listed = await fixture.api.handleRequest("list_tabs", {});
  const tab = listed.tabs.find((entry) => entry.id === 333);
  assert.ok(tab?.handle?.tabFence);
  fixture.api.pendingDocumentTransitions.set("test-extension::333", {
    tabId: 333,
    tabFence: tab.handle.tabFence,
    startedAt: Date.now(),
    observed: false,
    completed: false,
  });

  await assert.rejects(
    () => fixture.api.handleRequest("evaluate", { tabId: 333, sessionId: "session-test", expression: "document.title" }),
    (error) => error?.code === "BROWSER_DOCUMENT_CHANGED" && error?.details?.transitionPending === true,
  );
  assert.equal(fixture.executeScriptCalls.some((call) => call.functionName === "pageGeneration"), false);
});

test("load wait does not accept the source document before an Agent transition emits lifecycle", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(332, { id: 332, windowId: 1, title: "source", url: "https://example.test/source", status: "complete" });
  const listed = await fixture.api.handleRequest("list_tabs", {});
  const tab = listed.tabs.find((entry) => entry.id === 332);
  assert.ok(tab?.handle?.tabFence);
  const key = "test-extension::332";
  fixture.api.pendingDocumentTransitions.set(key, {
    tabId: 332,
    tabFence: tab.handle.tabFence,
    startedAt: Date.now(),
    observed: false,
    completed: false,
  });
  let settled = false;
  const waiting = fixture.api.waitForTabState(332, { state: "load", timeoutMs: 1000 }, undefined, tab.handle.tabFence).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.equal(settled, false);
  fixture.tabs.get(332).status = "loading";
  await fixture.emitTabUpdated(332, { status: "loading" }, fixture.tabs.get(332));
  fixture.tabs.get(332).status = "complete";
  await fixture.emitTabUpdated(332, { status: "complete" }, fixture.tabs.get(332));
  const ready = await waiting;
  assert.equal(ready.status, "complete");
  assert.equal(fixture.api.pendingDocumentTransitions.has(key), false);
});

test("ordinary ownership refresh remains uncertain for a verified page transition", async () => {
  const fixture = loadExtension({
    pageGenerationSequence: [
      { url: "https://example.test/first", timeOrigin: 1, token: "one" },
      { url: "https://example.test/second", timeOrigin: 2, token: "two" },
    ],
  });
  fixture.tabs.set(327, { id: 327, windowId: 1, title: "first", url: "https://example.test/first", status: "complete" });
  fixture.storage[ownedTabsKey] = {
    version: 3,
    records: {
      "edge:test-extension:profile-id::327": record(327, "temporary", "first", "https://example.test/first"),
    },
  };

  await assert.rejects(
    () => fixture.api.refreshOwnedTabDocument(327, "tab:327", "session-test"),
    (error) => error?.code === "BROWSER_OPERATION_UNCERTAIN" && error?.details?.pageChanged === true,
  );
});

test("waited navigation ownership refresh does not bypass a tab-fence mismatch", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(328, { id: 328, windowId: 1, title: "fenced", url: "https://example.test/fenced", status: "complete" });

  await assert.rejects(
    () => fixture.api.refreshOwnedTabDocument(328, "tab:not-328", "session-test", { allowPageChange: true }),
    (error) => error?.code === "BROWSER_OPERATION_UNCERTAIN" && error?.details?.pageChanged !== true,
  );
});

test("waited navigation ownership refresh tolerates a later verified page transition without overwriting cache", async () => {
  const fixture = loadExtension({
    pageGenerationSequence: [
      { url: "https://example.test/first", timeOrigin: 1, token: "one" },
      { url: "https://example.test/second", timeOrigin: 2, token: "two" },
    ],
  });
  fixture.tabs.set(325, { id: 325, windowId: 1, title: "first", url: "https://example.test/first", status: "complete" });
  fixture.storage[ownedTabsKey] = {
    version: 3,
    records: {
      "edge:test-extension:profile-id::325": record(325, "temporary", "first", "https://example.test/first"),
    },
  };

  const refreshed = await fixture.api.refreshOwnedTabDocument(325, "tab:325", "session-test", { allowPageChange: true });

  assert.equal(refreshed, undefined);
  assert.equal(storedRecord(fixture, 325)?.url, "https://example.test/first");
});

test("title-only tab updates retain remembered page and DOM observations", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(321, { id: 321, windowId: 1, title: "initial", url: "https://example.test/live-ref", status: "complete" });
  fixture.api.pageSnapshotStates.set("test-extension::321", { snapshotId: "observation-1", observations: new Map([["observation-1", { url: "https://example.test/live-ref", timeOrigin: 1, token: "fixture-document-token" }]]) });
  fixture.api.domSnapshotStates.set("test-extension::321", { snapshotId: "dom-observation-1", observations: new Map([["dom-observation-1", { url: "https://example.test/live-ref", timeOrigin: 1, token: "fixture-document-token" }]]) });

  fixture.tabs.get(321).title = "updated";
  await fixture.emitTabUpdated(321, { title: "updated" }, fixture.tabs.get(321));

  assert.equal(fixture.api.pageSnapshotStates.get("test-extension::321")?.observations?.has("observation-1"), true);
  assert.equal(fixture.api.pageSnapshotStates.get("test-extension::321")?.observations?.get("observation-1")?.invalidated, undefined);
  assert.equal(fixture.api.domSnapshotStates.get("test-extension::321")?.observations?.has("dom-observation-1"), true);
  assert.equal(fixture.api.domSnapshotStates.get("test-extension::321")?.observations?.get("dom-observation-1")?.invalidated, undefined);
});

test("document lifecycle tab updates retain bounded provenance for a precise stale-document diagnostic", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(322, { id: 322, windowId: 1, title: "initial", url: "https://example.test/live-ref", status: "complete" });
  fixture.api.pageSnapshotStates.set("test-extension::322", { snapshotId: "observation-1", observations: new Map([["observation-1", { url: "https://example.test/live-ref", timeOrigin: 1, token: "fixture-document-token" }]]) });
  fixture.api.domSnapshotStates.set("test-extension::322", { snapshotId: "dom-observation-1", observations: new Map([["dom-observation-1", { url: "https://example.test/live-ref", timeOrigin: 1, token: "fixture-document-token" }]]) });
  fixture.api.accessibilitySnapshotStates.set("test-extension::322", { snapshotId: "accessibility-1", nodes: [] });

  await fixture.emitTabUpdated(322, { status: "loading" }, fixture.tabs.get(322));

  assert.equal(fixture.api.pageSnapshotStates.get("test-extension::322")?.observations?.has("observation-1"), true);
  assert.equal(fixture.api.pageSnapshotStates.get("test-extension::322")?.observations?.get("observation-1")?.invalidated, true);
  assert.equal(fixture.api.domSnapshotStates.get("test-extension::322")?.observations?.has("dom-observation-1"), true);
  assert.equal(fixture.api.domSnapshotStates.get("test-extension::322")?.observations?.get("dom-observation-1")?.invalidated, true);
  assert.equal(fixture.api.pageOperationParams(322, { snapshotId: "observation-1" }).__snapshotObservationInvalidated, true);
  assert.equal(fixture.api.domCuaOperationParams(322, { snapshotId: "dom-observation-1" }).__domObservationInvalidated, true);
  assert.equal(fixture.api.accessibilitySnapshotStates.get("test-extension::322"), undefined);
});

test("delayed document-transition fallback does not invalidate a new destination observation", async () => {
  const fixture = loadExtension();
  const key = "test-extension::323";
  const oldObservation = { url: "https://example.test/old", timeOrigin: 1, token: "old" };
  const newObservation = { url: "https://example.test/new", timeOrigin: 2, token: "new" };
  const oldAccessibility = { snapshotId: "old", nodes: [] };
  const newAccessibility = { snapshotId: "new", nodes: [] };
  fixture.api.pageSnapshotStates.set(key, { snapshotId: "old", observations: new Map([["old", oldObservation]]) });
  fixture.api.domSnapshotStates.set(key, { snapshotId: "old-dom", observations: new Map([["old-dom", oldObservation]]) });
  fixture.api.accessibilitySnapshotStates.set(key, oldAccessibility);

  const sourceObservations = fixture.api.capturePageObservationState(323);
  fixture.api.pageSnapshotStates.get(key).observations.set("new", newObservation);
  fixture.api.domSnapshotStates.get(key).observations.set("new-dom", newObservation);
  fixture.api.accessibilitySnapshotStates.set(key, newAccessibility);
  fixture.api.invalidatePageObservationStateAfterDocumentTransition(323, sourceObservations);
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(oldObservation.invalidated, true);
  assert.equal(newObservation.invalidated, undefined);
  assert.equal(fixture.api.accessibilitySnapshotStates.get(key), newAccessibility);
});

test("internal ownership snapshots tolerate title-only changes but retain window and URL fences", () => {
  const fixture = loadExtension();
  const before = { windowId: 12, title: "Initial title", url: "https://example.test/page" };
  assert.equal(fixture.api.tabSnapshotMatches(before, { ...before, title: "Updated title" }), true);
  assert.equal(fixture.api.tabSnapshotMatches(before, { ...before, url: "https://example.test/other" }), false);
  assert.equal(fixture.api.tabSnapshotMatches(before, { ...before, windowId: 13 }), false);
});

test("complete document handles tolerate title-only updates", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(312, { id: 312, windowId: 1, title: "initial", url: "https://example.test/title", status: "complete", active: true });
  const listed = await fixture.api.handleRequest("list_tabs", {});
  const current = listed.tabs.find((entry) => entry.id === 312);
  assert.ok(current);
  const handle = { ...current.handle, incarnation: "https://example.test/title\u00001\u0000fixture-document-token" };
  fixture.tabs.get(312).title = "updated";
  const selected = await fixture.api.handleRequest("selected_tab", { tabId: 312, handle });
  assert.equal(selected.tab.title, "updated");
});

test("read-only user handles tolerate title-only updates", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(313, { id: 313, windowId: 1, title: "initial", url: "https://example.test/user-title", status: "complete", active: true });
  const listed = await fixture.api.handleRequest("list_tabs", {});
  const current = listed.tabs.find((entry) => entry.id === 313);
  assert.ok(current);
  fixture.tabs.get(313).title = "updated";
  const selected = await fixture.api.handleRequest("selected_tab", { tabId: 313, handle: current.handle });
  assert.equal(selected.tab.title, "updated");
});

test("evaluate bounds deep, wide and long return values", async () => {
  const wide = {
    items: Array.from({ length: 2_005 }, (_, index) => index),
    long: "x".repeat(200_005),
  };
  let deep = "leaf";
  for (let index = 0; index < 9; index += 1) deep = { value: deep };
  wide.deep = deep;
  for (let index = 0; index < 205; index += 1) wide[`field${index}`] = index;
  const fixture = loadExtension({ debuggerEvaluateResult: wide });
  fixture.tabs.set(7, { id: 7, windowId: 1, title: "evaluate", url: "https://example.test/evaluate" });
  const result = await fixture.api.handleRequest("evaluate", { tabId: 7, sessionId: "session-test", expression: "window.result" });
  assert.equal(result.result.outputTruncated, true);
  assert.equal(result.result.outputLimits.depth, 8);
  assert.equal(Object.keys(result.result.result.value).length, 201);
  assert.equal(result.result.result.value.items.length, 2_001);
  assert.equal(result.result.result.value.long.length, 200_000);
  let boundedDeep = result.result.result.value.deep;
  for (let index = 0; index < 10 && boundedDeep && typeof boundedDeep === "object"; index += 1) boundedDeep = boundedDeep.value;
  assert.equal(boundedDeep, "[Max depth reached]");
});

test("console and network reads apply aggregate output limits", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(314, { id: 314, windowId: 1, title: "events", url: "https://example.test/events" });
  await fixture.api.handleRequest("devtools_enable", { tabId: 314, sessionId: "session-test", domains: ["Runtime", "Network"] });
  const state = fixture.api.devtoolsState.get("test-extension::314");
  state.console.push(...Array.from({ length: 205 }, (_, index) => ({ type: "log", text: `${index}-${"x".repeat(100)}` })));
  state.network.push(...Array.from({ length: 205 }, (_, index) => ({ event: "request", url: `https://example.test/${index}`, body: "x".repeat(100) })));
  const logs = await fixture.api.handleRequest("console_logs", { tabId: 314, sessionId: "session-test" });
  const requests = await fixture.api.handleRequest("network_requests", { tabId: 314, sessionId: "session-test" });
  assert.ok(logs.logs.length <= 200);
  assert.ok(logs.logCharCount <= 20_000);
  assert.equal(logs.logTruncated, true);
  assert.ok(requests.requests.length <= 200);
  assert.ok(requests.requestCharCount <= 20_000);
  assert.equal(requests.requestTruncated, true);
});

test("list_tabs suppresses data-url favicon payloads", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(313, { id: 313, windowId: 1, title: "favicon", url: "https://example.test", favIconUrl: `data:image/png;base64,${"A".repeat(10000)}` });
  const listed = await fixture.api.handleRequest("list_tabs", {});
  assert.equal(listed.tabs.find((entry) => entry.id === 313)?.favicon, "");
});
test("claim revalidates the tab snapshot after ownership reads", async () => {
  const fixture = loadExtension({ storageGetDelay: 30 });
  fixture.tabs.set(304, { id: 304, windowId: 1, title: "claimable", url: "https://example.test/start", active: true });
  const claiming = fixture.api.handleRequest("claim_tab", {
    tabId: 304,
    windowId: 1,
    title: "claimable",
    url: "https://example.test/start",
    sessionId: "session-a",
  });
  setTimeout(() => Object.assign(fixture.tabs.get(304), { url: "https://example.test/changed", title: "changed" }), 10);
  await assert.rejects(claiming, /changed during the claim|Tab handle is stale: title changed/);
  assert.equal(storedRecord(fixture, 304), undefined);
});
test("extension serializes concurrent ownership mutations", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(201, { id: 201, windowId: 1, title: "handoff", url: "about:blank", active: false });
  fixture.tabs.set(202, { id: 202, windowId: 1, title: "deliverable", url: "about:blank", active: false });
  fixture.storage[ownedTabsKey] = { "edge:test-extension:profile-id::201": record(201), "edge:test-extension:profile-id::202": record(202) };
  await Promise.all([
    fixture.api.handleRequest("mark_handoff", { tabId: 201, sessionId: "session-test", turnId: 3 }),
    fixture.api.handleRequest("mark_deliverable", { tabId: 202, sessionId: "session-test", turnId: 3 }),
  ]);
  assert.equal(storedRecord(fixture, 201).lifecycle, "handoff");
  assert.equal(storedRecord(fixture, 202).lifecycle, "deliverable");
  assert.equal(storedRecord(fixture, 201).markTurn, "3");
  assert.equal(storedRecord(fixture, 202).markTurn, "3");
});

test("extension waits for load and URL conditions without choosing a different tab", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(7, { id: 7, windowId: 1, title: "loading", url: "https://example.test/start", status: "loading" });
  const loadingTab = fixture.api.waitForTabState(7, { state: "load", timeoutMs: 1000 });
  setTimeout(() => Object.assign(fixture.tabs.get(7), { status: "complete" }), 20);
  const loaded = await loadingTab;
  assert.equal(loaded.id, 7);
  assert.equal(loaded.status, "complete");

  const urlWait = fixture.api.waitForTabState(7, { state: "url", urlIncludes: "/done", timeoutMs: 1000 });
  setTimeout(() => Object.assign(fixture.tabs.get(7), { url: "https://example.test/done" }), 20);
  const completed = await urlWait;
  assert.equal(completed.url, "https://example.test/done");
  await assert.rejects(() => fixture.api.waitForTabState(7, {
    state: "url",
    url: "https://example.test/done",
    urlIncludes: "/other",
    timeoutMs: 1,
  }), /Timed out waiting for tab 7/);
});

test("extension reports bounded wait timeouts", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(7, { id: 7, windowId: 1, title: "loading", url: "https://example.test/start", status: "loading" });
  await assert.rejects(() => fixture.api.waitForTabState(7, { state: "load", timeoutMs: 1 }), /Timed out waiting for tab 7/);
});

test("page condition timeouts carry tab and state diagnostics", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(315, { id: 315, windowId: 1, title: "wait page", url: "https://example.test/wait", status: "complete" });
  await assert.rejects(
    () => fixture.api.handleRequest("wait", { tabId: 315, state: "visible", target: { role: "button", name: "missing" }, timeoutMs: 1, sessionId: "session-test" }),
    (error) => error?.code === "BROWSER_WAIT_TIMEOUT"
      && error?.details?.tabId === 315
      && error?.details?.state === "visible"
      && error?.details?.url === "https://example.test/wait",
  );
});


  test("cleanup aborts a registered tab wait", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(7, { id: 7, windowId: 1, title: "loading", url: "https://example.test/start", status: "loading" });
  const controller = new AbortController();
  fixture.api.activeRequestControllers.set("wait", controller);
  fixture.api.activeRequestDetails.set("wait", { method: "wait", sessionId: "session-test" });
  const waiting = fixture.api.waitForTabState(7, { state: "load", timeoutMs: 10_000 }, controller.signal);
  const otherController = new AbortController();
  fixture.api.activeRequestControllers.set("other-wait", otherController);
  fixture.api.activeRequestDetails.set("other-wait", { method: "wait", sessionId: "other-session" });
  fixture.api.abortActiveWaits("session-test");
  await assert.rejects(waiting, /Browser wait aborted by lifecycle cleanup/);
  assert.equal(otherController.signal.aborted, false);
});
test("omitted-session cleanup waits only on default-session tab barriers", async () => {
  const fixture = loadExtension();
  const defaultBarrier = fixture.api.reserveTabWait("default-barrier", undefined);
  const otherBarrier = fixture.api.reserveTabWait("other-barrier", "other-session");
  const cleanup = fixture.api.handleRequest("cleanup", {});
  defaultBarrier.release();
  await Promise.race([
    cleanup,
    new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup waited on another session barrier")), 100)),
  ]);
  otherBarrier.release();
});

test("user-requested close cannot cross session ownership", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(7, { id: 7, windowId: 1, title: "owned", url: "https://example.test/owned", status: "complete" });
  fixture.storage[ownedTabsKey] = { version: 3, records: { "edge:test-extension:profile-id::7": record(7) } };
  await assert.rejects(() => fixture.api.handleRequest("close_tab", { tabId: 7, sessionId: "other-session", userRequested: true }), /belongs to another Agent session/);
  assert.equal(fixture.tabs.has(7), true);
  assert.equal(storedRecord(fixture, 7).sessionId, "session-test");
});
test("clipboard rejects unknown actions before touching a tab", async () => {
  const fixture = loadExtension();
  await assert.rejects(() => fixture.api.handleRequest("clipboard", { action: "reed" }), /clipboard action must be read or write/);
});

test("tab removal preserves an attached debugger orphan for explicit recovery", async () => {
  const fixture = loadExtension();
  await fixture.api.attachDebugger(30, "session-test", { lease: true });
  const oldFence = fixture.api.persistentDebuggers.get("test-extension::30")?.tabFence;
  fixture.tabs.delete(30);
  await fixture.emitTabRemoved(30);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fixture.api.orphanedDebuggerAttaches.get("test-extension::30")?.tabFence, oldFence);
  const result = await fixture.api.handleRequest("cleanup", { sessionId: "session-test", recoverStale: true, detachDevtools: true });
  assert.deepEqual(Array.from(result.failed), []);
  assert.equal(fixture.api.orphanedDebuggerAttaches.has("test-extension::30"), false);
});


test("explicit stale recovery detaches a persisted debugger lease after worker restart", async () => {
  const fixture = loadExtension();
  const tab = record(310, "temporary", "debug", "about:blank");
  tab.runtimeId = "old-runtime";
  fixture.tabs.set(310, { id: 310, windowId: 1, title: "debug", url: "about:blank" });
  fixture.storage[ownedTabsKey] = { version: 3, records: { ["edge:test-extension:profile-id::310"]: tab } };
  fixture.storage[tabFencesKey] = { "test-extension::310": tab.tabFence };
  await fixture.api.attachDebugger(310, "session-test", { lease: true });
  fixture.api.persistentDebuggers.clear();
  const result = await fixture.api.handleRequest("cleanup", { sessionId: "session-test", recoverStale: true, detachDevtools: true });
  assert.deepEqual(Array.from(result.recovered), [310]);
  assert.equal(fixture.storage[debuggerLeasesKey]?.length ?? 0, 0);
  assert.equal(fixture.tabs.has(310), true);
});


test("stale recovery reports persisted debugger lease removal failures", async () => {
  let failLeaseRemoval = false;
  const fixture = loadExtension({
    storageSetFailure(values) {
      return failLeaseRemoval && Array.isArray(values[debuggerLeasesKey]) && values[debuggerLeasesKey].length === 0;
    },
  });
  fixture.tabs.set(311, { id: 311, windowId: 1, title: "debug", url: "about:blank" });
  await fixture.api.attachDebugger(311, "session-test", { lease: true });
  fixture.api.persistentDebuggers.clear();
  failLeaseRemoval = true;

  const result = await fixture.api.handleRequest("cleanup", { sessionId: "session-test", recoverStale: true, detachDevtools: true });

  assert.equal(result.failed.some((entry) => entry.tabId === 311), true);
  assert.equal(fixture.storage[debuggerLeasesKey].length, 1);
  assert.equal(fixture.tabs.has(311), true);
});


test("extension keeps a failed debugger detach retryable", async () => {
  const fixture = loadExtension();
  await fixture.api.attachDebugger(7, "session-test");
  fixture.setDetachFailure(true);
  await assert.rejects(() => fixture.api.detachDebugger(7, "session-test"), (error) => error?.code === "BROWSER_OPERATION_UNCERTAIN" && error?.details?.debuggerCleanupPending === true && error?.cause?.message === "simulated debugger detach failure");
  assert.equal([...fixture.api.persistentDebuggers.values()].find((entry) => entry.tabId === 7)?.detachPending, true);

  fixture.setDetachFailure(false);
  await fixture.api.detachDebugger(7, "session-test");
  assert.equal([...fixture.api.persistentDebuggers.values()].some((entry) => entry.tabId === 7), false);
});
