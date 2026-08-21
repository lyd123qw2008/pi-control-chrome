import test from "node:test";
import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
const serverPath = join(root, "bridge", "server.mjs");

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const request = httpGet({ hostname: "127.0.0.1", port, path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(1000, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

function stopProcess(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
}

async function waitHealth(port) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const result = await getJson(port, "/health");
      if (result.body.ok) return result.body;
    } catch {}
    await sleep(50);
  }
  throw new Error("bridge did not become healthy");
}

async function waitHealthIdentity(port, browserId) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const result = await getJson(port, "/health");
      if (result.body.browserId === browserId) return result.body;
    } catch {}
    await sleep(50);
  }
  throw new Error(`bridge did not expose browser identity ${browserId}`);
}

test("extension manifest omits the unused webNavigation permission", () => {
  const manifest = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8"));
  assert.equal(manifest.permissions.includes("webNavigation"), false);
});

test("bridge exposes health/pair endpoints and routes Pi requests to extension", async () => {
  const port = 17800 + Math.floor(Math.random() * 500);
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-bridge-test-"));
  const tokenFile = join(temp, "token");
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--token-file", tokenFile], { stdio: "ignore", windowsHide: true });
  let pi;
  let extension;
  try {
    const health = await waitHealth(port);
    assert.equal(health.extensionConnected, false);
     assert.equal(health.startedBy, "unknown");
     assert.equal(health.controlDomain, "local_user");
     assert.equal(health.capabilities.cooperativeRestart, true);
     assert.equal(health.capabilities.localUserRestart, true);
     assert.equal(health.restart.available, true);
     assert.equal("piClients" in health, false);
    const pair = await getJson(port, "/pair");
    assert.equal(pair.status, 200);
    assert.equal(pair.body.token, readFileSync(tokenFile, "utf8").trim());

    const connect = (role) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}&token=${encodeURIComponent(pair.body.token)}`);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    extension = await connect("extension");
    pi = await connect("pi");

    const response = await new Promise((resolve, reject) => {
      const id = "bridge-test";
      const timer = setTimeout(() => reject(new Error("route timeout")), 3000);
      const onPiMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== id) return;
        clearTimeout(timer);
        pi.off("message", onPiMessage);
        resolve(message);
      };
      pi.on("message", onPiMessage);
      extension.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "request" && message.id === id) {
          extension.send(JSON.stringify({ type: "response", id, result: { ok: true, method: message.method, params: message.params } }));
        }
      });
      pi.send(JSON.stringify({ type: "request", id, method: "status", params: { source: "test" } }));
    });

    assert.deepEqual(response.result, { ok: true, method: "status", params: { source: "test" } });
  } finally {
    pi?.close();
    extension?.close();
    stopProcess(child);
    await sleep(100);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("bridge keeps one active extension connection and replaces the older one", async () => {
  const port = 17800 + Math.floor(Math.random() * 500);
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-bridge-replace-test-"));
  const tokenFile = join(temp, "token");
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--token-file", tokenFile], { stdio: "ignore", windowsHide: true });
  let first;
  let second;
  try {
    await waitHealth(port);
    const pair = await getJson(port, "/pair");
    const connect = () => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=extension&token=${encodeURIComponent(pair.body.token)}`);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    first = await connect();
    second = await connect();
    await new Promise((resolve) => first.once("close", resolve));
    assert.equal(first.readyState, WebSocket.CLOSED);
    assert.equal(second.readyState, WebSocket.OPEN);
    assert.equal((await getJson(port, "/health")).body.extensionConnected, true);
  } finally {
    first?.close();
    second?.close();
    stopProcess(child);
    await sleep(100);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("bridge atomically rejects requests for a replaced browser target", async () => {
  const port = 17800 + Math.floor(Math.random() * 500);
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-bridge-target-test-"));
  const tokenFile = join(temp, "token");
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--token-file", tokenFile], { stdio: "ignore", windowsHide: true });
  let pi;
  let first;
  let second;
  try {
    await waitHealth(port);
    const pair = await getJson(port, "/pair");
    const connect = (role) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}&token=${encodeURIComponent(pair.body.token)}`);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    first = await connect("extension");
    first.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "edge", browserId: "edge:test", profile: "current", extensionVersion: "0.2.5" }));
    await waitHealthIdentity(port, "edge:test");
    pi = await connect("pi");

    const acceptedId = "accepted-target";
    first.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "request" && message.id === acceptedId) first.send(JSON.stringify({ type: "response", id: acceptedId, result: { browserId: "edge:test" } }));
    });
    const accepted = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("accepted target request timed out")), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== acceptedId) return;
        clearTimeout(timer);
        pi.off("message", onMessage);
        resolve(message);
      };
      pi.on("message", onMessage);
      pi.send(JSON.stringify({ type: "request", id: acceptedId, method: "status", params: { expectedBrowserId: "edge:test" } }));
    });
    assert.deepEqual(accepted.result, { browserId: "edge:test" });

    second = await connect("extension");
    second.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "chrome", browserId: "chrome:test", profile: "current", extensionVersion: "0.2.5" }));
    await new Promise((resolve) => first.once("close", resolve));
    await waitHealthIdentity(port, "chrome:test");

    const rejectedId = "rejected-target";
    const rejected = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("replaced target request did not fail")), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== rejectedId) return;
        clearTimeout(timer);
        pi.off("message", onMessage);
        resolve(message);
      };
      pi.on("message", onMessage);
      pi.send(JSON.stringify({ type: "request", id: rejectedId, method: "click", params: { expectedBrowserId: "edge:test" } }));
    });
    assert.equal(rejected.error.code, "BROWSER_TARGET_CHANGED");

    const acceptedNewId = "accepted-new-target";
    second.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "request" && message.id === acceptedNewId) second.send(JSON.stringify({ type: "response", id: acceptedNewId, result: { browserId: "chrome:test" } }));
    });
    const acceptedNew = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("new target request timed out")), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== acceptedNewId) return;
        clearTimeout(timer);
        pi.off("message", onMessage);
        resolve(message);
      };
      pi.on("message", onMessage);
      pi.send(JSON.stringify({ type: "request", id: acceptedNewId, method: "status", params: { expectedBrowserId: "chrome:test" } }));
    });
    assert.deepEqual(acceptedNew.result, { browserId: "chrome:test" });
  } finally {
    pi?.close();
    first?.close();
    second?.close();
    stopProcess(child);
    await sleep(100);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("bridge allows a paired local Host to cooperatively restart its instance", async () => {
  const port = 17800 + Math.floor(Math.random() * 500);
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-bridge-restart-test-"));
  const tokenFile = join(temp, "token");
  const args = [serverPath, "--port", String(port), "--token-file", tokenFile, "--started-by", "pi"];
  const child = spawn(process.execPath, args, { stdio: "ignore", windowsHide: true });
  let pi;
  let extension;
  let replacement;
  try {
    const initialHealth = await waitHealth(port);
    assert.equal(initialHealth.startedBy, "pi");
    assert.equal(initialHealth.controlDomain, "local_user");
    assert.equal(initialHealth.capabilities.cooperativeRestart, true);
    assert.equal(initialHealth.capabilities.localUserRestart, true);
    assert.equal(initialHealth.restart.available, true);
    const pair = await getJson(port, "/pair");
    const connect = (role) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}&token=${encodeURIComponent(pair.body.token)}`);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    extension = await connect("extension");
    pi = await connect("pi");
    const pendingId = "pending-browser-request";
    const pendingForwarded = new Promise((resolve) => {
      extension.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "request" && message.id === pendingId) resolve();
      });
    });
    pi.send(JSON.stringify({ type: "request", id: pendingId, method: "wait_forever", params: {} }));
    await pendingForwarded;
    const blockedRestart = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pending-request restart did not fail")), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== "pending-restart") return;
        clearTimeout(timer);
        pi.off("message", onMessage);
        resolve(message);
      };
      pi.on("message", onMessage);
      pi.send(JSON.stringify({
        type: "request",
        id: "pending-restart",
        method: "bridge_restart",
        params: { expectedInstanceId: initialHealth.instanceId, requester: "dsh" },
      }));
    });
    assert.equal(blockedRestart.error.code, "BRIDGE_IN_USE");
    extension.send(JSON.stringify({ type: "response", id: pendingId, result: { ok: true } }));

    const restartId = "restart-local-user";
    const piClosed = new Promise((resolve) => pi.once("close", resolve));
    const extensionClosed = new Promise((resolve) => extension.once("close", resolve));
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("restart response timed out")), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== restartId) return;
        clearTimeout(timer);
        pi.off("message", onMessage);
        resolve(message);
      };
      pi.on("message", onMessage);
      pi.send(JSON.stringify({
        type: "request",
        id: restartId,
        method: "bridge_restart",
        params: {
          expectedInstanceId: initialHealth.instanceId,
          requester: "dsh",
        },
      }));
    });
    assert.deepEqual(response.result, {
      ok: true,
      restarting: true,
      instanceId: initialHealth.instanceId,
      startedBy: "pi",
      controlDomain: "local_user",
      requester: "dsh",
    });
    await Promise.all([piClosed, extensionClosed]);

    replacement = spawn(process.execPath, args, { stdio: "ignore", windowsHide: true });
    const replacementHealth = await waitHealth(port);
    assert.notEqual(replacementHealth.instanceId, initialHealth.instanceId);
  } finally {
    pi?.close();
    extension?.close();
    stopProcess(child);
    stopProcess(replacement);
    await sleep(100);
    rmSync(temp, { recursive: true, force: true });
  }
});
