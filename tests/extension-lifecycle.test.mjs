import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const backgroundPath = join(root, "extension", "background.js");
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
      async remove(tabId) {
        const id = Number(tabId);
        if (removeFailures.has(id)) throw new Error("simulated tab close failure");
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
        tabs.delete(id);
        await tabRemoved.emit(id);
      },
    },
    scripting: {
      async executeScript({ target, func }) {
        const tab = tabs.get(Number(target.tabId));
        if (options.restrictedPageError && tab?.url === "about:blank") throw new Error(options.restrictedPageError);
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
      async sendCommand(_debuggee, method) {
        if (debuggerCommandFailure && method !== "Page.captureScreenshot") throw new Error("simulated debugger command failure");
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
  vm.runInContext(source + "\nglobalThis.__testApi = { handleRequest, attachDebugger, detachDebugger, persistentDebuggers, orphanedDebuggerAttaches, tabRemovalTombstones, retiredTabRemovalTombstones, browserIdentity, waitForTabState, abortActiveWaits, activeRequestControllers, activeRequestDetails, ownedTabs, ensureProfileIdentity, reserveTabWait, trackDownloadWait, downloadState, pageSnapshotStates, domSnapshotStates, devtoolsState };", context, { filename: backgroundPath });
  return {
    api: context.__testApi,
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
    removeFailures,
    setDetachFailure(value) { detachFailure = value; },
    setDebuggerCommandFailure(value) { debuggerCommandFailure = value; },
    setVisibleCaptureFailure(value) { visibleCaptureFailure = value; },
  };
}

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
  await fixture.emitTabReplaced(21, 20);
  const replacementTombstone = fixture.api.tabRemovalTombstones.get("test-extension::20");
  await fixture.emitTabReplaced(21, 20);
  assert.equal(replacementTombstone?.replacementEpoch, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(storedRecord(fixture, 20), undefined);
  assert.equal(storedRecord(fixture, 21)?.tabId, 21);
  assert.equal(storedRecord(fixture, 21)?.tabFence === oldRecord.tabFence, false);
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
