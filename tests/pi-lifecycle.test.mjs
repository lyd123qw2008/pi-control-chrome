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
    },
  };
}

function cleanupValue() {
  return { removed: [], released: [], retained: [], failed: [] };
}

async function createMockBridge() {
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
        capabilities: { localUserRestart: true },
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
      const defaultResult = message.method === "status" ? statusValue() : message.method === "cleanup" ? cleanupValue() : {};
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
  } finally {
    await client.stop();
    await closeServer(server);
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
