import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";

const bridgePort = 18_700 + Math.floor(Math.random() * 300);
process.env.PI_CONTROL_CHROME_BRIDGE_PORT = String(bridgePort);
process.env.PI_CONTROL_CHROME_LAZY_TOOLS = "false";

const { BridgeClient, default: piControlChrome } = await import("../pi-extension/index.ts");

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function defer() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

class FakeSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url, created) {
    super();
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    created(this);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }

  send(raw) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(JSON.parse(raw));
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    queueMicrotask(() => this.emit("close"));
  }
}

function createPiHarness() {
  const listeners = new Map();
  const tools = new Map();
  const commands = new Map();
  let activeTools = [];
  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(name, listener) {
      const entries = listeners.get(name) ?? [];
      entries.push(listener);
      listeners.set(name, entries);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names) {
      activeTools = [...names];
    },
  };
  return {
    pi,
    tools,
    commands,
    async emit(name, event = {}, ctx = createContext()) {
      for (const listener of listeners.get(name) ?? []) await listener(event, ctx);
    },
  };
}

function createContext() {
  const statuses = [];
  const notifications = [];
  return {
    statuses,
    notifications,
    ui: {
      setStatus(_id, text) {
        statuses.push(text);
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };
}

function statusValue(browserId = "edge:test") {
  return {
    browser: "edge",
    browserId,
    profile: "profile-test",
    capabilities: {
      turnCleanup: true,
      turnScopedMarks: true,
      retainedCleanup: true,
      debuggerLeaseRecovery: true,
      snapshotRefs: true,
      domCuaSnapshots: true,
      tabIncarnationFence: true,
      semanticTargets: true,
      pageWaitStates: true,
      axRefs: true,
    },
  };
}

function cleanupValue() {
  return { removed: [], released: [], retained: [], failed: [] };
}

async function createMockBridge({ targets = [] } = {}) {
  const requests = [];
  const scripts = new Map();
  const waiters = [];
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({
        ok: true,
        extensionConnected: true,
        browser: "edge",
        browserId: "edge:test",
        profile: "profile-test",
        instanceId: "mock-instance",
        capabilities: { localUserRestart: true, semanticTargetRequests: true, pageWaitStates: true },
      }));
      return;
    }
    if (request.url === "/pair") {
      response.end(JSON.stringify({ token: "mock-token" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", (socket) => {
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "request") return;
      requests.push(message);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (!waiters[index].predicate(message)) continue;
        const waiter = waiters.splice(index, 1)[0];
        waiter.resolve(message);
      }
      const queue = scripts.get(message.method) ?? [];
      const script = queue.shift();
      scripts.set(message.method, queue);
      const respond = (result, error) => {
        if (socket.readyState !== 1) return;
        socket.send(JSON.stringify({ type: "response", id: message.id, ...(error ? { error } : { result }) }));
      };
      const defaultResult = message.method === "status" ? statusValue() : message.method === "list_targets" ? { targets } : message.method === "cleanup" ? cleanupValue() : {};
      Promise.resolve(script ? script(message, respond) : respond(defaultResult)).catch(error => respond(undefined, { message: String(error) }));
    });
  });
  await listen(server, bridgePort);
  return {
    requests,
    enqueue(method, script) {
      const queue = scripts.get(method) ?? [];
      queue.push(script);
      scripts.set(method, queue);
    },
    waitForRequest(predicate) {
      const existing = requests.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve: value => {
            clearTimeout(timer);
            resolve(value);
          },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("timed out waiting for mock Bridge request"));
        }, 3000);
        waiters.push(waiter);
      });
    },
    async close() {
      for (const socket of websocket.clients) socket.close();
      await new Promise(resolve => websocket.close(resolve));
      await closeServer(server);
    },
  };
}

test("BridgeClient stops before open and reconnects without stale socket state", async () => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/pair") {
      response.end(JSON.stringify({ token: "fake-token" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  const port = await listen(server);
  const created = [];
  const createdWaiters = [];
  class TestSocket extends FakeSocket {
    constructor(url) {
      super(url, socket => {
        created.push(socket);
        createdWaiters.shift()?.resolve(socket);
      });
    }
  }
  let nextSocketIndex = 0;
  const nextSocket = () => {
    if (created.length > nextSocketIndex) return Promise.resolve(created[nextSocketIndex++]);
    const waiter = defer();
    createdWaiters.push({
      resolve: socket => {
        nextSocketIndex += 1;
        waiter.resolve(socket);
      },
    });
    return waiter.promise;
  };
  const client = new BridgeClient({
    origin: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    WebSocketCtor: TestSocket,
  });
  try {
    const firstStart = client.start();
    const firstSocket = await nextSocket();
    const stopping = client.stop();
    await assert.rejects(firstStart, /Pi browser bridge (?:disconnected|connection was stopped)/);
    await stopping;

    const secondStart = client.start();
    const secondSocket = await nextSocket();
    assert.notEqual(secondSocket, firstSocket);
    secondSocket.open();
    await secondStart;

         const cancelController = new AbortController();
     const canceledRequest = client.request("cancelled", { source: "abort" }, undefined, cancelController.signal);
     await new Promise(resolve => setImmediate(resolve));
     cancelController.abort();
     await assert.rejects(canceledRequest, /aborted|AbortError/);
     assert.equal(secondSocket.sent.at(-1).type, "cancel");
     assert.equal(secondSocket.sent.at(-1).id, secondSocket.sent.at(-2).id);

     const staleRequest = client.request("stale", { source: "old-socket" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondSocket.sent.at(-1).method, "stale");
    secondSocket.readyState = FakeSocket.CLOSED;
    const thirdStart = client.start();
    const thirdSocket = await nextSocket();
    assert.notEqual(thirdSocket, secondSocket);
    thirdSocket.open();
    await thirdStart;
    secondSocket.emit("close");
    const staleOutcome = Promise.race([
      staleRequest,
      new Promise((_, reject) => setTimeout(() => reject(new Error("stale request was not rejected")), 100)),
    ]);
    await assert.rejects(staleOutcome, /Pi browser bridge disconnected/);

    const requestPromise = client.request("probe", { source: "reconnected" });
    await new Promise(resolve => setImmediate(resolve));
    const request = thirdSocket.sent.at(-1);
    thirdSocket.emit("message", Buffer.from(JSON.stringify({ type: "response", id: request.id, result: { ok: true } })));
    assert.deepEqual(await requestPromise, { ok: true });

    const malformedRequestPromise = client.request("navigate", { tabId: 7, url: "https://example.test/next" });
    await new Promise(resolve => setImmediate(resolve));
    const malformedRequest = thirdSocket.sent.at(-1);
    thirdSocket.emit("message", Buffer.from(JSON.stringify({ type: "response", id: malformedRequest.id, result: {}, error: { code: "BAD", message: "also-result" } })));
    await assert.rejects(malformedRequestPromise, error => error.code === "BROWSER_OPERATION_UNCERTAIN" && error.details?.retryable === false);
  } finally {
    await client.stop();
    await closeServer(server);
  }
});

test("Pi requires explicit target selection and routes later operations with the selected connection fence", async () => {
  const mock = await createMockBridge({
    targets: [
      { browser: "edge", browserId: "edge:profile-a", profile: "profile-a", state: "ready", connectionId: "edge-connection", connectionGeneration: 3 },
      { browser: "chrome", browserId: "chrome:profile-b", profile: "profile-b", state: "ready", connectionId: "chrome-connection", connectionGeneration: 7 },
    ],
  });
  const harness = createPiHarness();
  piControlChrome(harness.pi);
  const context = createContext();
  const selectedStatus = async (_message, respond) => respond({ ...statusValue("chrome:profile-b"), browser: "chrome", profile: "profile-b", connectionId: "chrome-connection", connectionGeneration: 7 });
  mock.enqueue("status", async (message, respond) => {
    if (!message.target) {
      respond(undefined, { code: "TARGET_REQUIRED", message: "multiple targets" });
      return;
    }
    await selectedStatus(message, respond);
  });
  mock.enqueue("status", selectedStatus);
  mock.enqueue("status", selectedStatus);
  try {
    await harness.emit("session_start", {}, context);
    const ambiguousResult = await harness.tools.get("browser_status").execute("ambiguous", { browserId: "   " });
    const ambiguous = JSON.parse(ambiguousResult.content[0].text);
    assert.equal(ambiguous.error.code, "TARGET_REQUIRED");
    assert.deepEqual(ambiguous.targets.map(target => target.browserId), ["edge:profile-a", "chrome:profile-b"]);

    const selectedResult = await harness.tools.get("browser_status").execute("selected", { browserId: "chrome:profile-b" });
    const selected = JSON.parse(selectedResult.content[0].text);
    assert.equal(selected.browserId, "chrome:profile-b");
    assert.equal(selected.targetStability.connectionGeneration, 7);

    await harness.tools.get("browser_click").execute("click", { tabId: 7, ref: "e4" });
    const interaction = mock.requests.filter(message => message.method === "interaction").at(-1);
    assert.deepEqual(interaction.target, { browserId: "chrome:profile-b", connectionId: "chrome-connection", connectionGeneration: 7 });
    assert.equal(interaction.params.expectedBrowserId, "chrome:profile-b");
  } finally {
    try {
      await harness.commands.get("chrome").handler("disconnect", context);
    } catch {
      // The test must still release the mock Bridge when disconnect itself fails.
    }
    await mock.close();
  }
});
test("Pi clears a stale target binding only after explicit recovery and target selection", async () => {
  const mock = await createMockBridge({
    targets: [
      { browser: "edge", browserId: "edge:replacement", profile: "profile-replacement", state: "ready", connectionId: "replacement-connection", connectionGeneration: 4 },
      { browser: "chrome", browserId: "chrome:other", profile: "profile-other", state: "ready", connectionId: "other-connection", connectionGeneration: 2 },
    ],
  });
  const harness = createPiHarness();
  piControlChrome(harness.pi);
  const context = createContext();
  try {
    await harness.emit("session_start", {}, context);
    await harness.tools.get("browser_status").execute("bind", {});
    mock.enqueue("status", async (_message, respond) => respond(undefined, { code: "TARGET_UNAVAILABLE", message: "old target disconnected" }));
    await assert.rejects(
      () => harness.tools.get("browser_cleanup").execute("recover-stale", { recoverStale: true }),
      error => error?.code === "TARGET_REQUIRED"
        && error?.details?.reason === "stale_target_binding"
        && error?.details?.staleBrowserId === "edge:test",
    );
    assert.equal(mock.requests.filter(message => message.method === "cleanup").length, 0);

    const statusCount = mock.requests.filter(message => message.method === "status").length;
    const unselected = JSON.parse((await harness.tools.get("browser_status").execute("unselected", {})).content[0].text);
    assert.equal(unselected.targetRequired, true);
    assert.equal(unselected.error.code, "TARGET_REQUIRED");
    assert.deepEqual(unselected.targets.map(target => target.browserId), ["edge:replacement", "chrome:other"]);
    assert.equal(mock.requests.filter(message => message.method === "status").length, statusCount);

    mock.enqueue("status", async (_message, respond) => respond({
      ...statusValue("edge:replacement"),
      connectionId: "replacement-connection",
      connectionGeneration: 4,
    }));
    const selected = JSON.parse((await harness.tools.get("browser_status").execute("select", {
      browserId: "edge:replacement",
      acknowledgeBrowserId: "edge:replacement",
    })).content[0].text);
    assert.equal(selected.browserId, "edge:replacement");
    assert.equal(selected.targetStability.acknowledged, true);

    mock.enqueue("status", async (_message, respond) => respond({
      ...statusValue("edge:replacement"),
      connectionId: "replacement-connection",
      connectionGeneration: 4,
    }));
    mock.enqueue("cleanup", async (_message, respond) => respond(cleanupValue()));
    await harness.tools.get("browser_cleanup").execute("cleanup", { recoverStale: true });
    const cleanup = mock.requests.filter(message => message.method === "cleanup").at(-1);
    assert.equal(cleanup.params.expectedBrowserId, "edge:replacement");
    assert.equal(cleanup.target.browserId, "edge:replacement");
  } finally {
    try {
      await harness.commands.get("chrome").handler("disconnect", context);
    } catch {
      // The test must still release the mock Bridge when disconnect itself fails.
    }
    await mock.close();
  }
});

test("Pi forwards semantic wait and locator targets with session and connection fencing", async () => {
  const mock = await createMockBridge();
  const harness = createPiHarness();
  piControlChrome(harness.pi);
  const context = createContext();
  try {
    for (let index = 0; index < 3; index += 1) {
      mock.enqueue("status", async (_message, respond) => respond({ ...statusValue(), connectionId: "edge-connection", connectionGeneration: 4 }));
    }
    await harness.emit("session_start", {}, context);
    await harness.tools.get("browser_status").execute("bind", {});

    const target = { role: "button", name: "提交", exact: true };
    await harness.tools.get("browser_wait").execute("wait", { state: "visible", target, timeoutMs: 8000 });
    const waitRequest = mock.requests.filter(message => message.method === "wait").at(-1);
    assert.deepEqual(waitRequest.params, { state: "visible", target, timeoutMs: 8000, sessionId: waitRequest.params.sessionId, expectedBrowserId: "edge:test" });
    assert.deepEqual(waitRequest.target, { browserId: "edge:test", connectionId: "edge-connection", connectionGeneration: 4 });

    await harness.tools.get("browser_locator").execute("locator", { action: "count", target });
    const locatorRequest = mock.requests.filter(message => message.method === "locator").at(-1);
    assert.deepEqual(locatorRequest.params, { action: "count", target, sessionId: locatorRequest.params.sessionId, expectedBrowserId: "edge:test", locator: target });
    assert.deepEqual(locatorRequest.target, { browserId: "edge:test", connectionId: "edge-connection", connectionGeneration: 4 });
  } finally {
    try {
      await harness.commands.get("chrome").handler("disconnect", context);
    } catch {
      // The test must still release the mock Bridge when disconnect itself fails.
    }
    await mock.close();
  }
});

test("Pi omits blank browser fields before dispatch", async () => {
  const mock = await createMockBridge();
  const harness = createPiHarness();
  piControlChrome(harness.pi);
  const context = createContext();
  try {
    await harness.emit("session_start", {}, context);
    await harness.tools.get("browser_status").execute("bind", {});
    await harness.tools.get("browser_snapshot").execute("snapshot", { tabId: 7, selector: "", snapshotId: "  ", incarnation: "", maxChars: 1_000 });
    const snapshot = mock.requests.filter(message => message.method === "snapshot").at(-1);
    assert.deepEqual(snapshot.params, { tabId: 7, maxChars: 1_000, sessionId: snapshot.params.sessionId, expectedBrowserId: "edge:test" });
    assert.equal(Object.hasOwn(snapshot.params, "selector"), false);
    assert.equal(Object.hasOwn(snapshot.params, "snapshotId"), false);
    assert.equal(Object.hasOwn(snapshot.params, "incarnation"), false);
  } finally {
    try {
      await harness.commands.get("chrome").handler("disconnect", context);
    } catch {
      // The test must still release the mock Bridge when disconnect itself fails.
    }
    await mock.close();
  }
});
test("Pi refuses AX ref operations when the extension capability is missing", async () => {
  const mock = await createMockBridge();
  const harness = createPiHarness();
  piControlChrome(harness.pi);
  const context = createContext();
  try {
    await harness.emit("session_start", {}, context);
    mock.enqueue("status", async (_message, respond) => {
      const status = statusValue();
      const capabilities = { ...status.capabilities };
      delete capabilities.axRefs;
      respond({ ...status, capabilities });
    });
    const result = await harness.tools.get("browser_click").execute("ax-click", { tabId: 7, ref: "a1", snapshotId: "snapshot-1" });
    assert.equal(result.details.code, "BRIDGE_CAPABILITY_MISSING");
    assert.match(result.content[0].text, /axRefs/);
    assert.equal(mock.requests.filter(message => message.method === "interaction").length, 0);
  } finally {
    try {
      await harness.commands.get("chrome").handler("disconnect", context);
    } catch {
      // The test must still release the mock Bridge when disconnect itself fails.
    }
    await mock.close();
  }
});

test("Pi preserves structured AX and tab lifecycle errors from the Bridge", async () => {
  const mock = await createMockBridge();
  const harness = createPiHarness();
  piControlChrome(harness.pi);
  const context = createContext();
  try {
    await harness.emit("session_start", {}, context);
    mock.enqueue("interaction", async (_message, respond) => respond(undefined, {
      code: "AX_NODE_DISABLED",
      message: "The accessibility node is disabled",
      details: { snapshotId: "snapshot-ax", actionState: "not_completed" },
    }));
    const disabled = await harness.tools.get("browser_click").execute("ax-disabled", { tabId: 7, ref: "a1", snapshotId: "snapshot-ax" });
    assert.equal(disabled.details.code, "AX_NODE_DISABLED");
    assert.deepEqual(disabled.details.details, { snapshotId: "snapshot-ax", actionState: "not_completed" });

    mock.enqueue("locator", async (_message, respond) => respond(undefined, {
      code: "BROWSER_TAB_CLOSED",
      message: "Tab 7 was closed",
      details: { tabId: 7 },
    }));
    const closed = await harness.tools.get("browser_locator").execute("closed-tab", { tabId: 7, action: "count", target: { role: "button" } });
    assert.equal(closed.details.code, "BROWSER_TAB_CLOSED");
    assert.deepEqual(closed.details.details, { tabId: 7 });
  } finally {
    try {
      await harness.commands.get("chrome").handler("disconnect", context);
    } catch {
      // The test must still release the mock Bridge when disconnect itself fails.
    }
    await mock.close();
  }
});

test("Pi refuses stale-runtime recovery when the extension capability is missing", async () => {
  const mock = await createMockBridge();
  const harness = createPiHarness();
  piControlChrome(harness.pi);
  const context = createContext();
  try {
    await harness.emit("session_start", {}, context);
    mock.enqueue("status", async (_message, respond) => {
      const status = statusValue();
      const capabilities = { ...status.capabilities };
      delete capabilities.tabIncarnationFence;
      respond({ ...status, capabilities });
    });
    await assert.rejects(() => harness.tools.get("browser_cleanup").execute("recover-stale", { recoverStale: true }), /stale-runtime ownership recovery/);
    assert.equal(mock.requests.filter(message => message.method === "cleanup").length, 0);
  } finally {
    try {
      await harness.commands.get("chrome").handler("disconnect", context);
    } catch {
      // The test must still release the mock Bridge when disconnect itself fails.
    }
    await mock.close();
  }
});


test("Pi defers browser cleanup until agent_settled so tabs survive tool rounds", async () => {
  const mock = await createMockBridge();
  const harness = createPiHarness();
  piControlChrome(harness.pi);
  const context = createContext();
  try {
    await harness.emit("session_start", {}, context);
    await harness.emit("agent_start", {}, context);
    await harness.tools.get("browser_new_tab").execute("new-tab", { url: "https://example.test/new", active: false });
    const cleanupCountAfterCreate = mock.requests.filter(message => message.method === "cleanup").length;
    const sessionId = mock.requests.filter(message => message.method === "status").at(-1)?.params.sessionId;

    await harness.emit("turn_end", { turnIndex: 0, toolResults: [{ role: "toolResult" }] }, context);
    assert.equal(mock.requests.filter(message => message.method === "cleanup").length, cleanupCountAfterCreate);

    await harness.emit("turn_start", { turnIndex: 1 }, context);
    await harness.tools.get("browser_snapshot").execute("snapshot", { tabId: 7, handle: { tabId: 7 } });
    await harness.emit("turn_end", { turnIndex: 1, toolResults: [{ role: "toolResult" }] }, context);
    assert.equal(mock.requests.filter(message => message.method === "cleanup").length, cleanupCountAfterCreate);

    await harness.emit("agent_settled", {}, context);
    const cleanup = mock.requests.filter(message => message.method === "cleanup").at(-1);
    assert.equal(cleanup.params.mode, "turn");
    assert.equal(cleanup.params.detachDevtools, true);
    assert.equal(cleanup.params.sessionId, sessionId);
    assert.match(String(cleanup.params.turnId), /:run-1$/);
  } finally {
    try {
      await harness.commands.get("chrome").handler("disconnect", context);
    } catch {
      // The test must still release the mock Bridge when disconnect itself fails.
    }
    await mock.close();
  }
});


test("Pi does not automatically retry an inspect-first cleanup intent", async () => {
  const mock = await createMockBridge();
  const harness = createPiHarness();
  piControlChrome(harness.pi);
  const context = createContext();
  try {
    await harness.emit("session_start", {}, context);
    await harness.tools.get("browser_status").execute("status", {});
    mock.enqueue("cleanup", async (_message, respond) => respond({ removed: [], released: [], retained: [], failed: [{ tabId: 77, code: "BROWSER_OPERATION_UNCERTAIN", error: "unknown" }] }));
    await assert.rejects(
      () => harness.tools.get("browser_cleanup").execute("cleanup", {}),
      (error) => error?.code === "BROWSER_OPERATION_UNCERTAIN" && error?.details?.inspectFirst === true,
    );
    const cleanupCount = mock.requests.filter(message => message.method === "cleanup").length;
    await harness.emit("turn_end", { turnIndex: 0 }, context);
    assert.equal(mock.requests.filter(message => message.method === "cleanup").length, cleanupCount);
    assert.match(context.statuses.at(-1), /pending/);
    mock.enqueue("cleanup", async (_message, respond) => respond(cleanupValue()));
    await harness.tools.get("browser_cleanup").execute("cleanup", {});
  } finally {
    try {
      await harness.commands.get("chrome").handler("disconnect", context);
    } catch {
      // The test must still release the mock Bridge when disconnect itself fails.
    }
    await mock.close();
  }
});


test("Pi lifecycle fencing rejects stale completions and retries the original turn cleanup intent", async () => {
  const mock = await createMockBridge();
  const harness = createPiHarness();
  piControlChrome(harness.pi);
  const context = createContext();
  try {
    await harness.emit("session_start", {}, context);

    const staleStatus = defer();
    mock.enqueue("status", async (_message, respond) => {
      await staleStatus.promise;
      respond(statusValue("edge:stale"));
    });
    const staleRequest = harness.tools.get("browser_status").execute("stale-status", {});
    const staleStatusRequest = await mock.waitForRequest(message => message.method === "status");
    const switchPromise = harness.emit("session_before_switch", {}, context);
    await switchPromise;
    assert.equal(context.statuses.at(-1), "chrome: session released");
    staleStatus.resolve();
    const staleResult = await staleRequest;
    assert.match(staleResult.details.error, /Pi browser session changed while the request was in flight/);
    const newStatusResult = await harness.tools.get("browser_status").execute("new-status", {});
    const newStatus = JSON.parse(newStatusResult.content[0].text);
    assert.equal(newStatus.targetStability.competition, "unknown");
    const newStatusRequest = mock.requests.filter(message => message.method === "status").at(-1);
    await harness.emit("turn_end", { turnIndex: 0 }, context);
    const newTurnCleanup = mock.requests.filter(message => message.method === "cleanup").at(-1);
    assert.equal(newTurnCleanup.params.sessionId, newStatusRequest.params.sessionId);
    assert.notEqual(newTurnCleanup.params.sessionId, staleStatusRequest.params.sessionId);

    await harness.emit("session_start", {}, context);
    await harness.tools.get("browser_status").execute("status", {});
    const currentStatus = mock.requests.filter(message => message.method === "status").at(-1);
    const sessionId = currentStatus.params.sessionId;
    mock.enqueue("cleanup", async (_message, respond) => {
      respond({ removed: [], released: [], retained: [], failed: [{ tabId: 77, error: "close failed" }] });
    });
    await harness.emit("turn_end", { turnIndex: 7 }, context);
    const firstCleanup = mock.requests.filter(message => message.method === "cleanup").at(-1);
    assert.deepEqual(firstCleanup.params, {
      mode: "turn",
      turnId: 7,
      detachDevtools: true,
      sessionId,
      expectedBrowserId: "edge:test",
    });

    const cleanupCountBeforeReset = mock.requests.filter(message => message.method === "cleanup").length;
    mock.enqueue("cleanup", async (_message, respond) => respond(cleanupValue()));
    mock.enqueue("cleanup", async (_message, respond) => {
      respond({ removed: [], released: [], retained: [], failed: [{ tabId: 77, error: "retry still failed" }] });
    });
    await harness.emit("session_before_switch", {}, context);
    const resetCleanupRequests = mock.requests.filter(message => message.method === "cleanup").slice(cleanupCountBeforeReset);
    assert.equal(resetCleanupRequests[0].params.sessionId, sessionId);
    assert.equal(resetCleanupRequests[0].params.mode, undefined);
    assert.deepEqual(resetCleanupRequests[1].params, firstCleanup.params);

    mock.enqueue("cleanup", async (_message, respond) => respond(cleanupValue()));
    await harness.commands.get("chrome").handler("connect", context);
    const cleanupRequests = mock.requests.filter(message => message.method === "cleanup");
    const retryCleanup = cleanupRequests.at(-1);
    assert.deepEqual(retryCleanup.params, firstCleanup.params);
  } finally {
    try {
      await harness.commands.get("chrome").handler("disconnect", context);
    } catch {
      // The test must still release the mock Bridge when disconnect itself fails.
    }
    await mock.close();
  }
});
