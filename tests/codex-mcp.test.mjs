import assert from "node:assert/strict";
import { createServer, get as httpGet } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import WebSocket from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
const serverPath = join(root, "codex", "mcp-server.mjs");
const bridgePath = join(root, "bridge", "server.mjs");

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const request = httpGet({ hostname: "127.0.0.1", port, path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(1000, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

async function waitHealth(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const value = await getJson(port, "/health");
      if (value.ok) return value;
    } catch {}
    await sleep(50);
  }
  throw new Error("Bridge did not become healthy");
}

function stopProcess(child) {
  if (!child?.pid) return Promise.resolve();
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", resolve);
    if (process.platform === "win32") spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else child.kill("SIGTERM");
    setTimeout(resolve, 3000).unref();
  });
}

function startMcp(port) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PI_CONTROL_CHROME_BRIDGE_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const waiter = waiters.shift();
      if (waiter) waiter(JSON.parse(line));
    }
  });
  child.stderr.resume();
  return {
    child,
    nextMessage() {
      return new Promise((resolve, reject) => {
        waiters.push(resolve);
        child.once("exit", () => reject(new Error("MCP server exited before responding")));
      });
    },
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
  };
}

test("Codex plugin manifest points at the shared Skill and stdio MCP server", () => {
  const manifest = JSON.parse(readFileSync(join(root, ".codex-plugin", "plugin.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.equal(manifest.name, "pi-control-chrome");
  assert.equal(manifest.skills, "./skills/pi-control-chrome/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(mcp.mcpServers["pi-control-chrome"].command, "node");
  assert.deepEqual(mcp.mcpServers["pi-control-chrome"].args, ["codex/mcp-server.mjs"]);
});

test("Codex MCP adapter exposes the initial browser tool catalog over stdio", async () => {
  const mcp = startMcp(17980 + Math.floor(Math.random() * 100));
  try {
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const initialized = await mcp.nextMessage();
    assert.equal(initialized.result.serverInfo.name, "pi-control-chrome");
    assert.equal(initialized.result.capabilities.tools.listChanged, false);

    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await mcp.nextMessage();
    assert.equal(listed.result.tools.length, 8);
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
      "browser_status",
      "browser_tabs",
      "browser_snapshot",
      "browser_accessibility_snapshot",
      "browser_extract",
      "browser_wait",
      "browser_click",
      "browser_fill",
    ]);
  } finally {
    mcp.child.stdin.end();
    await stopProcess(mcp.child);
  }
});

test("Codex MCP adapter routes a selected target through the existing Bridge", async () => {
  const bridgePort = 17980 + Math.floor(Math.random() * 100);
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-codex-mcp-test-"));
  const tokenFile = join(temp, "token");
  const bridge = spawn(process.execPath, [bridgePath, "--port", String(bridgePort), "--token-file", tokenFile], { stdio: "ignore", windowsHide: true });
  let extension;
  const mcp = startMcp(bridgePort);
  const identity = {
    browser: "edge",
    browserId: "edge:codex-test",
    profile: "codex-test",
    capabilities: {
      semanticTargets: true,
      pageWaitStates: true,
      snapshotRefs: true,
      axRefs: true,
      tabIncarnationFence: true,
      compactResponses: true,
    },
  };
  try {
    await waitHealth(bridgePort);
    const token = readFileSync(tokenFile, "utf8").trim();
    extension = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws?role=extension&token=${encodeURIComponent(token)}`);
    await new Promise((resolve, reject) => { extension.once("open", resolve); extension.once("error", reject); });
    extension.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, ...identity }));
    await sleep(30);
    extension.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "request") return;
      const result = message.method === "list_tabs"
        ? { ...identity, tabs: [], windows: [], groups: [] }
        : identity;
      extension.send(JSON.stringify({ type: "response", id: message.id, result }));
    });

    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await mcp.nextMessage();
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "browser_status",
      arguments: { browserId: identity.browserId, acknowledgeBrowserId: identity.browserId },
    } });
    const status = await mcp.nextMessage();
    assert.equal(status.result.isError, undefined);
    const statusValue = JSON.parse(status.result.content[0].text);
    assert.equal(statusValue.browserId, identity.browserId);
    assert.equal(statusValue.targetStability.acknowledged, true);

    mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_status", arguments: {} } });
    const stableStatus = await mcp.nextMessage();
    assert.equal(JSON.parse(stableStatus.result.content[0].text).targetStability.acknowledged, true);

    mcp.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_tabs", arguments: {} } });
    const tabs = await mcp.nextMessage();
    assert.equal(tabs.result.isError, undefined);
    assert.deepEqual(JSON.parse(tabs.result.content[0].text).tabs, []);
  } finally {
    mcp.child.stdin.end();
    await stopProcess(mcp.child);
    extension?.close();
    await stopProcess(bridge);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Codex MCP cancellation reaches the Bridge without replaying the browser wait", async () => {
  const bridgePort = 17980 + Math.floor(Math.random() * 100);
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-codex-mcp-cancel-test-"));
  const tokenFile = join(temp, "token");
  const bridge = spawn(process.execPath, [bridgePath, "--port", String(bridgePort), "--token-file", tokenFile], { stdio: "ignore", windowsHide: true });
  let extension;
  const mcp = startMcp(bridgePort);
  const identity = {
    browser: "edge",
    browserId: "edge:codex-cancel-test",
    profile: "codex-cancel-test",
    capabilities: { pageWaitStates: true, tabIncarnationFence: true },
  };
  let cancelSeen = false;
  let waiting = false;
  try {
    await waitHealth(bridgePort);
    const token = readFileSync(tokenFile, "utf8").trim();
    extension = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws?role=extension&token=${encodeURIComponent(token)}`);
    await new Promise((resolve, reject) => { extension.once("open", resolve); extension.once("error", reject); });
    extension.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, ...identity }));
    await sleep(30);
    extension.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "cancel") {
        cancelSeen = true;
        return;
      }
      if (message.type !== "request") return;
      if (message.method === "wait") {
        waiting = true;
        return;
      }
      const result = message.method === "list_tabs" ? { ...identity, tabs: [], windows: [], groups: [] } : identity;
      extension.send(JSON.stringify({ type: "response", id: message.id, result }));
    });

    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await mcp.nextMessage();
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "browser_status",
      arguments: { browserId: identity.browserId, acknowledgeBrowserId: identity.browserId },
    } });
    await mcp.nextMessage();
    mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "browser_wait",
      arguments: { handle: { tabId: 7 }, state: "text", text: "never", timeoutMs: 60_000 },
    } });
    for (let attempt = 0; attempt < 30 && !waiting; attempt += 1) await sleep(20);
    assert.equal(waiting, true);
    const resultPromise = mcp.nextMessage();
    mcp.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } });
    const canceled = await resultPromise;
    assert.equal(canceled.result.isError, true);
    assert.match(canceled.result.content[0].text, /Browser request aborted/);
    for (let attempt = 0; attempt < 30 && !cancelSeen; attempt += 1) await sleep(20);
    assert.equal(cancelSeen, true);
  } finally {
    mcp.child.stdin.end();
    await stopProcess(mcp.child);
    extension?.close();
    await stopProcess(bridge);
    rmSync(temp, { recursive: true, force: true });
  }
});
