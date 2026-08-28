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
        const tab = { id, windowId: Number(details.windowId ?? 1), title: "", url: String(details.url || "about:blank"), status: "loading", active: details.active === true };
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
        return [{ result: func.name === "pageGeneration" ? { url: tab?.url || "about:blank", timeOrigin: 1, token: "fixture-document-token" } : undefined }];
      },
    },
    debugger: {
      onEvent: debuggerEvent,
      onDetach: debuggerDetach,
      async attach(debuggee) { attachedDebuggerTabs.add(Number(debuggee.tabId)); },
      async getTargets() { return [...attachedDebuggerTabs].map((tabId) => ({ tabId, attached: true, id: `target-${tabId}` })); },
      async detach(debuggee) { if (detachFailure) throw new Error("simulated debugger detach failure"); attachedDebuggerTabs.delete(Number(debuggee.tabId)); },
      async sendCommand(_debuggee, method) { if (debuggerCommandFailure && method !== "Page.captureScreenshot") throw new Error("simulated debugger command failure"); return method === "Page.captureScreenshot" ? { data: "debugger-data" } : {}; },
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
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = FakeWebSocket.OPEN;
    addEventListener() {}
    send() {}
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
test("new-tab setup rotates a persisted fence even without debugger state", async () => {
  const fixture = loadExtension({ createTabId: 7, sessionStorage: { [tabFencesKey]: { "test-extension::7": "tab:old" } } });
  const result = await fixture.api.handleRequest("new_tab", { url: "https://example.test/new", sessionId: "session-test" });
  assert.notEqual(result.tab.handle.tabFence, "tab:old");
  assert.equal(storedRecord(fixture, 7)?.tabFence, result.tab.handle.tabFence);
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
