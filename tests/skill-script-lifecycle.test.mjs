import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "skills", "pi-control-chrome", "scripts", "browser.mjs");
const capabilities = { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true };

function runScript(port, ...args) {
  return execFileAsync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, PI_CONTROL_CHROME_BRIDGE_PORT: String(port) },
  });
}

test("browser CLI sends session and turn context with retention marks", async () => {
  let nextTabId = 40;
  const tabs = new Map();
  const markRequests = [];
  const routedRequests = [];
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true, extensionConnected: true, browserId: "edge:test" }));
      return;
    }
    if (request.url === "/pair") {
      response.end(JSON.stringify({ token: "test-token" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "request") return;
      routedRequests.push(message);
      let result;
      if (message.method === "status") {
        result = { connected: true, browser: "edge", browserId: "edge:test", profile: "profile", connectionId: "edge-connection", connectionGeneration: 5, capabilities };
      } else if (message.method === "new_tab") {
        const tab = { id: ++nextTabId, title: "CLI test", url: message.params.url, active: false, owner: "agent", lifecycle: "temporary", groupId: 1, windowId: 1, sessionId: message.params.sessionId };
        tabs.set(tab.id, tab);
        result = { tab, groupId: 1 };
      } else if (message.method === "wait") {
        result = { tab: tabs.get(Number(message.params.tabId)) };
      } else if (message.method === "list_tabs") {
        result = { browser: "edge", browserId: "edge:test", profile: "profile", tabs: [...tabs.values()], groups: [{ id: 1, title: "Pi", color: "blue" }] };
      } else if (message.method === "mark_handoff" || message.method === "mark_deliverable") {
        markRequests.push({ method: message.method, params: message.params });
        const tab = tabs.get(Number(message.params.tabId));
        if (tab) tab.lifecycle = message.method === "mark_handoff" ? "handoff" : "deliverable";
        result = { tab };
      } else {
        result = {};
      }
      socket.send(JSON.stringify({ type: "response", id: message.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const { stdout } = await runScript(port, "open", "https://example.test/", "--inactive", "--browser-id", "edge:test", "--session", "cli-session", "--turn", "4", "--handoff", "--json");
    const output = JSON.parse(stdout);
    assert.equal(output.tab.lifecycle, "handoff");
    assert.equal(output.sessionId, "cli-session");
    assert.equal(output.turnId, 4);
     assert.ok(routedRequests.length > 0);
     assert.ok(routedRequests.every(message => message.target?.browserId === "edge:test"));
     assert.ok(routedRequests.filter(message => message.method !== "status").every(message => message.target?.connectionId === "edge-connection" && message.target?.connectionGeneration === 5));
    assert.deepEqual(markRequests, [{
      method: "mark_handoff",
      params: { tabId: 41, sessionId: "cli-session", turnId: 4, expectedBrowserId: "edge:test" },
    }]);
  } finally {
    websocket.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("browser CLI rejects managed lifecycle commands without explicit identity", async () => {
  await assert.rejects(runScript(1, "open", "https://example.test/"), (error) => error.stderr.includes("open requires --session <id>"));
  await assert.rejects(runScript(1, "view", "https://example.test/", "--session", "cli-session"), (error) => error.stderr.includes("view requires --turn <n>"));
  await assert.rejects(runScript(1, "cleanup"), (error) => error.stderr.includes("cleanup requires --session <id>"));
});
