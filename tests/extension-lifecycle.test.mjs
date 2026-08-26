import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const backgroundPath = join(root, "extension", "background.js");
const ownedTabsKey = "piControlChromeOwnedTabs";

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

function loadExtension() {
  const storage = { [ownedTabsKey]: {} };
  const tabs = new Map();
  const removeFailures = new Set();
  let detachFailure = false;
  let visibleCaptureFailure = false;
  const runtimeStartup = eventSource();
  const runtimeInstalled = eventSource();
  const tabRemoved = eventSource();
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
        async get(defaults) { return { ...clone(defaults), ...clone(storage) }; },
        async set(values) { Object.assign(storage, clone(values)); },
      },
    },
    tabs: {
      onRemoved: tabRemoved,
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
      async remove(tabId) {
        const id = Number(tabId);
        if (removeFailures.has(id)) throw new Error("simulated tab close failure");
        tabs.delete(id);
        await tabRemoved.emit(id);
      },
    },
    debugger: {
      onEvent: debuggerEvent,
      onDetach: debuggerDetach,
      async attach() {},
      async detach() { if (detachFailure) throw new Error("simulated debugger detach failure"); },
      async sendCommand(_debuggee, method) { return method === "Page.captureScreenshot" ? { data: "debugger-data" } : {}; },
    },
    downloads: { onCreated: downloadsCreated, onChanged: downloadsChanged },
    alarms: { create() {}, onAlarm: alarm },
  };
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = FakeWebSocket.OPEN;
    addEventListener() {}
    send() {}
  }
  const context = vm.createContext({
    chrome,
    WebSocket: FakeWebSocket,
    navigator: { userAgent: "Edg/123.0" },
    crypto: { randomUUID: () => "profile-id" },
    fetch: async () => ({ ok: true, status: 200, async json() { return { token: "token" }; } }),
    console: { debug() {}, error() {} },
    setTimeout,
    clearTimeout,
  });
  const source = readFileSync(backgroundPath, "utf8");
  vm.runInContext(source + "\nglobalThis.__testApi = { handleRequest, attachDebugger, detachDebugger, persistentDebuggers };", context, { filename: backgroundPath });
  return {
    api: context.__testApi,
    storage,
    tabs,
    removeFailures,
    setDetachFailure(value) { detachFailure = value; },
    setVisibleCaptureFailure(value) { visibleCaptureFailure = value; },
  };
}

function record(tabId, lifecycle = "temporary") {
  return { tabId, windowId: 1, sessionId: "session-test", createdAt: 1, groupId: 1, owner: "agent", lifecycle };
}

test("extension falls back to debugger capture after visible screenshot readback fails", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(7, { id: 7, windowId: 1, title: "active", url: "about:blank", active: true });
  fixture.setVisibleCaptureFailure(true);

  const result = await fixture.api.handleRequest("screenshot", { tabId: 7, sessionId: "session-test" });
  assert.equal(result.data, "debugger-data");
});

test("extension retains a tab record after failed turn cleanup and retries it", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(101, { id: 101, windowId: 1, title: "temporary", url: "about:blank" });
  fixture.storage[ownedTabsKey] = { "101": record(101) };
  fixture.removeFailures.add(101);

  const first = await fixture.api.handleRequest("cleanup", { sessionId: "session-test", mode: "turn", turnId: 1 });
  assert.deepEqual(Array.from(first.removed), []);
  assert.deepEqual(Array.from(first.retained), [101]);
  assert.deepEqual(Array.from(first.failed, (entry) => ({ tabId: Number(entry.tabId), error: String(entry.error) })), [{ tabId: 101, error: "Error: simulated tab close failure" }]);
  assert.ok(fixture.storage[ownedTabsKey]["101"]);

  fixture.removeFailures.delete(101);
  const second = await fixture.api.handleRequest("cleanup", { sessionId: "session-test", mode: "turn", turnId: 2 });
  assert.deepEqual(Array.from(second.removed), [101]);
  assert.deepEqual(Array.from(second.retained), []);
  assert.deepEqual(Array.from(second.failed), []);
  assert.equal(fixture.storage[ownedTabsKey]["101"], undefined);
});

test("non-turn cleanup transfers retained tab control without closing it", async () => {
  const fixture = loadExtension();
  fixture.tabs.set(111, { id: 111, windowId: 1, title: "handoff", url: "about:blank" });
  fixture.storage[ownedTabsKey] = { "111": record(111, "handoff") };

  const result = await fixture.api.handleRequest("cleanup", { sessionId: "session-test" });
  assert.deepEqual(Array.from(result.removed), []);
  assert.deepEqual(Array.from(result.released), [111]);
  assert.deepEqual(Array.from(result.retained), []);
  assert.deepEqual(Array.from(result.failed), []);
  assert.equal(fixture.tabs.has(111), true);
  assert.equal(fixture.storage[ownedTabsKey]["111"], undefined);
});

test("extension serializes concurrent ownership mutations", async () => {
  const fixture = loadExtension();
  fixture.storage[ownedTabsKey] = { "201": record(201), "202": record(202) };
  await Promise.all([
    fixture.api.handleRequest("mark_handoff", { tabId: 201, sessionId: "session-test", turnId: 3 }),
    fixture.api.handleRequest("mark_deliverable", { tabId: 202, sessionId: "session-test", turnId: 3 }),
  ]);
  assert.equal(fixture.storage[ownedTabsKey]["201"].lifecycle, "handoff");
  assert.equal(fixture.storage[ownedTabsKey]["202"].lifecycle, "deliverable");
  assert.equal(fixture.storage[ownedTabsKey]["201"].markTurn, "3");
  assert.equal(fixture.storage[ownedTabsKey]["202"].markTurn, "3");
});

test("extension keeps a failed debugger detach retryable", async () => {
  const fixture = loadExtension();
  await fixture.api.attachDebugger(7, "session-test");
  fixture.setDetachFailure(true);
  await assert.rejects(() => fixture.api.detachDebugger(7, "session-test"), /simulated debugger detach failure/);
  assert.equal(fixture.api.persistentDebuggers.get(7).detachPending, true);

  fixture.setDetachFailure(false);
  await fixture.api.detachDebugger(7, "session-test");
  assert.equal(fixture.api.persistentDebuggers.has(7), false);
});
