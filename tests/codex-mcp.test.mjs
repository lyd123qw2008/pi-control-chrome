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
const lifecycleContract = JSON.parse(readFileSync(new URL("./fixtures/browser-lifecycle-contract.json", import.meta.url), "utf8"));
const serverPath = join(root, "codex", "mcp-server.mjs");
const bridgePath = join(root, "bridge", "server.mjs");

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function findFreePort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    const fail = (error) => {
      server.close(() => reject(error));
    };
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!Number.isInteger(port) || port <= 0) {
          reject(new Error("failed to allocate a free test port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

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

function startMcp(port, extraEnv = {}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, ...extraEnv, PI_CONTROL_CHROME_BRIDGE_PORT: String(port) },
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
  const mcp = startMcp(await findFreePort());
  try {
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const initialized = await mcp.nextMessage();
    assert.equal(initialized.result.serverInfo.name, "pi-control-chrome");
    assert.equal(initialized.result.capabilities.tools.listChanged, false);

    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await mcp.nextMessage();
    assert.equal(listed.result.tools.length, 13);
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
      "browser_status",
      "browser_targets",
      "browser_target_lease",
      "browser_restart",
      "browser_reload_extension",
      "browser_tabs",
      "browser_snapshot",
      "browser_accessibility_snapshot",
      "browser_extract",
      "browser_wait",
      "browser_probe_interaction",
      "browser_click",
      "browser_fill",
    ]);
  } finally {
    mcp.child.stdin.end();
    await stopProcess(mcp.child);
  }
});

test("Codex browser_restart requires explicit user confirmation", async () => {
  const mcp = startMcp(await findFreePort());
  try {
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await mcp.nextMessage();
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "browser_restart",
      arguments: { confirmed: false },
    } });
    const result = await mcp.nextMessage();
    assert.equal(result.result.isError, true);
    const errorText = result.result.content[0].text;
    assert.match(errorText, new RegExp(lifecycleContract.restart.confirmationErrorCode));
    assert.match(errorText, /requiresUserConfirmation/);
  } finally {
    mcp.child.stdin.end();
    await stopProcess(mcp.child);
  }
});

test("Codex browser_restart cooperatively replaces the Bridge after confirmation", async () => {
  const bridgePort = await findFreePort();
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-codex-mcp-restart-test-"));
  const tokenFile = join(temp, "token");
  const bridge = spawn(process.execPath, [bridgePath, "--port", String(bridgePort), "--token-file", tokenFile], { stdio: "ignore", windowsHide: true });
  let extension;
  const mcp = startMcp(bridgePort, { PI_CONTROL_CHROME_TOKEN_FILE: tokenFile });
  const identity = {
    browser: "edge",
    browserId: "edge:codex-restart-test",
    profile: "codex-restart-test",
    capabilities: { pageWaitStates: true, tabIncarnationFence: true },
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
      if (message.type === "request" && message.method === "status") extension.send(JSON.stringify({ type: "response", id: message.id, result: identity }));
    });

    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await mcp.nextMessage();
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "browser_status",
      arguments: { browserId: identity.browserId, acknowledgeBrowserId: identity.browserId },
    } });
    const status = await mcp.nextMessage();
    assert.equal(status.result.isError, undefined);
    mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "browser_restart",
      arguments: { confirmed: true },
    } });
    const restarted = await mcp.nextMessage();
    assert.equal(restarted.result.isError, undefined);
    const value = JSON.parse(restarted.result.content[0].text);
    for (const field of lifecycleContract.restart.requiredFields) assert.notEqual(value[field], undefined, `missing restart field: ${field}`);
    assert.equal(value.restarted, true);
    for (const field of lifecycleContract.targetObservability.requiredHealthFields) assert.notEqual(value.bridgeHealth[field], undefined, `missing restart observability field: ${field}`);
    for (const field of lifecycleContract.targetObservability.requiredFields) assert.notEqual(value.bridgeHealth.observability[field], undefined, `missing restart observability detail: ${field}`);
    for (const field of lifecycleContract.targetObservability.metricFields) assert.notEqual(value.bridgeHealth.observability.metrics[field], undefined, `missing restart observability metric: ${field}`);
    for (const field of lifecycleContract.targetObservability.leaseFields) assert.notEqual(value.bridgeHealth.observability.targetLeases[field], undefined, `missing restart lease observability field: ${field}`);
    assert.notEqual(value.previousInstanceId, value.bridgeHealth.instanceId);
    assert.equal(value.bridgeHealth.startedBy, "codex");
    assert.equal(value.previousBrowserId, identity.browserId);
    assert.equal(value.nextAction, lifecycleContract.restart.nextAction);
    for (const field of ["handleRefreshRequired", "snapshotRefreshRequired", "documentIncarnationRefreshRequired"]) {
      assert.equal(value[field], lifecycleContract.restart.refreshFlags, `restart refresh contract: ${field}`);
    }
    assert.equal(value.targetRequired, true);

    const replacement = await waitHealth(bridgePort);
    assert.equal(replacement.instanceId, value.bridgeHealth.instanceId);
  } finally {
    mcp.child.stdin.end();
    await stopProcess(mcp.child);
    extension?.close();
    await stopProcess(bridge);
    try {
      const current = await getJson(bridgePort, "/health");
      if (current?.ok) {
        const replacementToken = readFileSync(tokenFile, "utf8").trim();
        const replacementSocket = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws?role=pi&token=${encodeURIComponent(replacementToken)}`);
        await new Promise((resolve, reject) => { replacementSocket.once("open", resolve); replacementSocket.once("error", reject); });
        replacementSocket.send(JSON.stringify({ type: "request", id: "cleanup-restart", method: "bridge_restart", params: { expectedInstanceId: current.instanceId, requester: "codex-test" } }));
        await new Promise((resolve) => { replacementSocket.once("message", resolve); replacementSocket.once("close", resolve); setTimeout(resolve, 1000).unref(); });
        replacementSocket.close();
      }
    } catch {}
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Codex MCP adapter routes a selected target through the existing Bridge", async () => {
  const bridgePort = await findFreePort();
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
        : message.method === "list_targets"
          ? { targets: [identity] }
          : identity;
      extension.send(JSON.stringify({ type: "response", id: message.id, result }));
    });

    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await mcp.nextMessage();
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "browser_targets",
      arguments: {},
    } });
    const inventory = await mcp.nextMessage();
    assert.equal(inventory.result.isError, undefined);
    const inventoryValue = JSON.parse(inventory.result.content[0].text);
    for (const field of lifecycleContract.targetInventory.requiredFields) assert.notEqual(inventoryValue[field], undefined, `missing target inventory field: ${field}`);
    assert.equal(lifecycleContract.targetInventory.mustNotSelect, true);
    assert.ok(lifecycleContract.targetInventory.states.includes(inventoryValue.state));
    assert.deepEqual(inventoryValue.targets.map(target => target.browserId), [identity.browserId]);
    for (const field of lifecycleContract.targetObservability.requiredFields) assert.notEqual(inventoryValue.bridgeHealth.observability[field], undefined, `missing target inventory observability detail: ${field}`);
    mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
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
  const bridgePort = await findFreePort();
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
