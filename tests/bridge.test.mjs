import nodeTest from "node:test";
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
const test = (name, fn) => nodeTest(name, { concurrency: false }, fn);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function getJson(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpGet({ hostname: "127.0.0.1", port, path, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(1000, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

async function stopProcess(child) {
  if (!child?.pid) return;
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", resolve);
  });
  if (process.platform === "win32") spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
  await Promise.race([exited, sleep(2000)]);
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

async function waitHealthTarget(port, browserId, state = "ready") {
  for (let i = 0; i < 50; i += 1) {
    try {
      const result = await getJson(port, "/health");
      if (result.body.targets?.some((target) => target.browserId === browserId && (state === undefined || target.state === state))) return result.body;
    } catch {}
    await sleep(50);
  }
  throw new Error(`bridge did not expose browser target ${browserId} in state ${state}`);
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
     const webpagePair = await getJson(port, "/pair", { Origin: "https://example.com" });
     assert.equal(webpagePair.headers["access-control-allow-origin"], undefined);
     const extensionPair = await getJson(port, "/pair", { Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
     const forbiddenSocket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=pi&token=${encodeURIComponent(pair.body.token)}`, { origin: "https://example.com" });
     const forbiddenCode = await new Promise((resolve, reject) => {
       forbiddenSocket.once("close", (code) => resolve(code));
       forbiddenSocket.once("error", () => {});
       setTimeout(() => reject(new Error("forbidden-origin socket did not close")), 1000);
     });
     assert.equal(forbiddenCode, 1008);


    const connect = (role) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}&token=${encodeURIComponent(pair.body.token)}`);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    extension = await connect("extension");
    const pong = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("extension heartbeat was not acknowledged")), 1000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "pong") return;
        clearTimeout(timer);
        extension.off("message", onMessage);
        resolve(message);
      };
      extension.on("message", onMessage);
      extension.send(JSON.stringify({ type: "ping" }));
    });
    assert.deepEqual(pong, { type: "pong" });
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
        if (message.type === "request") {
          extension.send(JSON.stringify({ type: "response", id: message.id, result: { ok: true, method: message.method, params: message.params } }));
        }
      });
      pi.send(JSON.stringify({ type: "request", id, method: "status", params: { source: "test" } }));
    });

    assert.deepEqual(response.result, { ok: true, method: "status", params: { source: "test" } });
  } finally {
    pi?.close();
    extension?.close();
    await stopProcess(child);
    await sleep(100);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("bridge forwards client cancellation to the selected extension", async () => {
  const port = 17800 + Math.floor(Math.random() * 500);
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-bridge-cancel-test-"));
  const tokenFile = join(temp, "token");
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--token-file", tokenFile], { stdio: "ignore", windowsHide: true });
  let pi;
  let extension;
  try {
    await waitHealth(port);
    const pair = await getJson(port, "/pair");
    const connect = (role) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}&token=${encodeURIComponent(pair.body.token)}`);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    extension = await connect("extension");
    extension.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "edge", browserId: "edge:cancel", profile: "profile-cancel", capabilities: { semanticTargets: true, pageWaitStates: true, tabIncarnationFence: true } }));
    await sleep(25);
    pi = await connect("pi");
    const forwarded = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cancellation request was not forwarded")), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "request") return;
        clearTimeout(timer);
        extension.off("message", onMessage);
        resolve(message);
      };
      extension.on("message", onMessage);
      pi.send(JSON.stringify({ type: "request", id: "cancel-me", method: "wait", params: { state: "text", text: "never" } }));
    });
    assert.equal(forwarded.method, "wait");
    const canceled = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("extension did not receive cancellation")), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "cancel") return;
        clearTimeout(timer);
        extension.off("message", onMessage);
        resolve(message);
      };
      extension.on("message", onMessage);
      pi.send(JSON.stringify({ type: "cancel", id: "cancel-me" }));
    });
    assert.equal((await canceled).id, forwarded.id);
    await sleep(25);
    assert.equal((await getJson(port, "/health")).body.observability.pendingRequests, 0);
  } finally {
    pi?.close();
    extension?.close();
    await stopProcess(child);
    await sleep(100);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("bridge rejects pending requests when an extension changes browser identity on one socket", async () => {
  const port = 17800 + Math.floor(Math.random() * 500);
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-bridge-identity-test-"));
  const tokenFile = join(temp, "token");
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--token-file", tokenFile], { stdio: "ignore", windowsHide: true });
  let pi;
  let extension;
  try {
    await waitHealth(port);
    const pair = await getJson(port, "/pair");
    const connect = (role) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}&token=${encodeURIComponent(pair.body.token)}`);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    extension = await connect("extension");
    extension.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "edge", browserId: "edge:identity-a", profile: "profile-a" }));
    await sleep(25);
    pi = await connect("pi");
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("identity-change response timeout")), 3000);
      pi.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== "identity-pending") return;
        clearTimeout(timer);
        resolve(message);
      });
    });
    const forwarded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("identity-change request was not forwarded")), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "request") return;
        clearTimeout(timer);
        extension.off("message", onMessage);
        resolve(message);
      };
      extension.on("message", onMessage);
    });
    pi.send(JSON.stringify({ type: "request", id: "identity-pending", method: "probe", params: {} }));
    const request = await forwarded;
    extension.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "edge", browserId: "edge:identity-b", profile: "profile-b" }));
    const result = await response;
    assert.equal(result.error.code, "TARGET_CONNECTION_CHANGED");
    assert.equal(request.method, "probe");
  } finally {
    pi?.close();
    extension?.close();
    await stopProcess(child);
    await sleep(100);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("bridge rejects turn cleanup when the extension capability is missing", async () => {
  const port = 17800 + Math.floor(Math.random() * 500);
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-bridge-capability-test-"));
  const tokenFile = join(temp, "token");
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--token-file", tokenFile], { stdio: "ignore", windowsHide: true });
  let pi;
  let extension;
  try {
    await waitHealth(port);
    const pair = await getJson(port, "/pair");
    const connect = (role) => new Promise((resolve, reject) => {
      const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws?role=" + role + "&token=" + encodeURIComponent(pair.body.token));
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    extension = await connect("extension");
    extension.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "edge", browserId: "edge:old", profile: "profile-old", capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true } }));
    await sleep(25);
    const extensionHealth = await getJson(port, "/health");
    assert.equal(extensionHealth.body.capabilities.cooperativeRestart, true);
    assert.equal(extensionHealth.body.extensionCapabilities.turnCleanup, true);
    pi = await connect("pi");

    const forwarded = new Promise((resolve) => {
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "request" || message.method !== "cleanup") return;
        extension.off("message", onMessage);
        resolve(true);
      };
      extension.on("message", onMessage);
      setTimeout(() => {
        extension.off("message", onMessage);
        resolve(false);
      }, 200);
    });
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("capability rejection timeout")), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== "missing-capability") return;
        clearTimeout(timer);
        pi.off("message", onMessage);
        resolve(message);
      };
      pi.on("message", onMessage);
      pi.send(JSON.stringify({ type: "request", id: "missing-capability", method: "cleanup", params: { mode: "turn", sessionId: "session-test", turnId: 1, expectedBrowserId: "edge:old" } }));
    });
    assert.equal(response.error.code, "EXTENSION_CAPABILITY_MISSING");
    assert.match(response.error.message, /tabIncarnationFence/);
    assert.equal(await forwarded, false);
    const semanticResponse = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("semantic capability rejection timeout")), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== "missing-semantic") return;
        clearTimeout(timer);
        pi.off("message", onMessage);
        resolve(message);
      };
      pi.on("message", onMessage);
      pi.send(JSON.stringify({ type: "request", id: "missing-semantic", method: "interaction", params: { tabId: 1, operation: "click", target: { role: "button", name: "Submit" }, expectedBrowserId: "edge:old" } }));
    });
    assert.equal(semanticResponse.error.code, "EXTENSION_CAPABILITY_MISSING");
    assert.match(semanticResponse.error.message, /semanticTargets/);
    const recoveryResponse = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("recovery capability rejection timeout")), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== "missing-recovery") return;
        clearTimeout(timer);
        pi.off("message", onMessage);
        resolve(message);
      };
      pi.on("message", onMessage);
      pi.send(JSON.stringify({ type: "request", id: "missing-recovery", method: "cleanup", params: { sessionId: "session-test", recoverStale: true, expectedBrowserId: "edge:old" } }));
    });
    assert.equal(recoveryResponse.error.code, "EXTENSION_CAPABILITY_MISSING");
    assert.match(recoveryResponse.error.message, /tabIncarnationFence/);
  } finally {
    pi?.close();
    extension?.close();
    await stopProcess(child);
    await sleep(100);
    rmSync(temp, { recursive: true, force: true });
  }
});
test("bridge keeps independent browser targets connected", async () => {
  const port = 17800 + Math.floor(Math.random() * 500);
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-bridge-multi-target-test-"));
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
    first.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "edge", browserId: "edge:profile-a", profile: "profile-a", extensionVersion: "0.3.7" }));
    second.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "chrome", browserId: "chrome:profile-b", profile: "profile-b", extensionVersion: "0.3.7" }));
    await waitHealthTarget(port, "chrome:profile-b");
    const health = (await getJson(port, "/health")).body;
    assert.equal(first.readyState, WebSocket.OPEN);
    assert.equal(second.readyState, WebSocket.OPEN);
    assert.equal(health.extensionConnected, true);
    assert.equal(health.readyTargetCount, 2);
    assert.equal(health.targetAmbiguous, true);
    assert.deepEqual(new Set(health.targets.filter((target) => target.state === "ready").map((target) => target.browserId)), new Set(["edge:profile-a", "chrome:profile-b"]));
  } finally {
    first?.close();
    second?.close();
    await stopProcess(child);
    await sleep(100);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("bridge routes explicit targets and fences disconnected generations", async () => {
  const port = 17800 + Math.floor(Math.random() * 500);
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-bridge-target-routing-test-"));
  const tokenFile = join(temp, "token");
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--token-file", tokenFile], { stdio: "ignore", windowsHide: true });
  let pi;
  let first;
  let second;
  let replacement;
  try {
    await waitHealth(port);
    const pair = await getJson(port, "/pair");
    const connect = (role) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}&token=${encodeURIComponent(pair.body.token)}`);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    const responseFor = (socket, id) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`response timeout for ${id}`)), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== id) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(message);
      };
      socket.on("message", onMessage);
    });
    const respondTo = (socket, resultFor) => socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "request") socket.send(JSON.stringify({ type: "response", id: message.id, result: resultFor(message) }));
    });

    first = await connect("extension");
    first.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "edge", browserId: "edge:profile-a", profile: "profile-a", extensionVersion: "0.3.7" }));
    second = await connect("extension");
    second.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "chrome", browserId: "chrome:profile-b", profile: "profile-b", extensionVersion: "0.3.7" }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    pi = await connect("pi");
    respondTo(first, () => ({ browserId: "edge:profile-a", profile: "profile-a" }));
    respondTo(second, () => ({ browserId: "chrome:profile-b", profile: "profile-b" }));

    const ambiguous = responseFor(pi, "ambiguous");
    pi.send(JSON.stringify({ type: "request", id: "ambiguous", method: "status", params: {} }));
    assert.equal((await ambiguous).error.code, "TARGET_REQUIRED");

    const conflicting = responseFor(pi, "conflicting-target");
    pi.send(JSON.stringify({ type: "request", id: "conflicting-target", method: "status", target: { browserId: "edge:profile-a" }, params: { expectedBrowserId: "chrome:profile-b" } }));
    assert.equal((await conflicting).error.code, "INVALID_BROWSER_TARGET");


    const edgeGeneration = (await getJson(port, "/health")).body.targets.find((target) => target.browserId === "edge:profile-a").connectionGeneration;
    const edgeStatus = responseFor(pi, "edge-status");
    pi.send(JSON.stringify({ type: "request", id: "edge-status", method: "status", target: { browserId: "edge:profile-a", connectionGeneration: edgeGeneration }, params: {} }));
    const edgeResponse = await edgeStatus;
    assert.equal(edgeResponse.result.browserId, "edge:profile-a");
    assert.equal(edgeResponse.result.connectionGeneration, edgeGeneration);

    const firstClosed = new Promise((resolve) => first.once("close", resolve));
    first.close();
    await firstClosed;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const disconnectedHealth = (await getJson(port, "/health")).body;
    assert.equal(disconnectedHealth.targets.find((target) => target.browserId === "edge:profile-a").state, "disconnected");
    assert.equal(disconnectedHealth.targets.find((target) => target.browserId === "chrome:profile-b").state, "ready");

    const unavailable = responseFor(pi, "edge-unavailable");
    pi.send(JSON.stringify({ type: "request", id: "edge-unavailable", method: "status", target: { browserId: "edge:profile-a" }, params: {} }));
    assert.equal((await unavailable).error.code, "TARGET_UNAVAILABLE");

    const chromeStatus = responseFor(pi, "chrome-status");
    pi.send(JSON.stringify({ type: "request", id: "chrome-status", method: "status", target: { browserId: "chrome:profile-b" }, params: {} }));
    assert.equal((await chromeStatus).result.browserId, "chrome:profile-b");

    replacement = await connect("extension");
    replacement.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "edge", browserId: "edge:profile-a", profile: "profile-a", extensionVersion: "0.3.7" }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    respondTo(replacement, () => ({ browserId: "edge:profile-a", profile: "profile-a" }));
    const reconnectedHealth = (await getJson(port, "/health")).body;
    const reconnected = reconnectedHealth.targets.find((target) => target.browserId === "edge:profile-a");
    assert.equal(reconnected.state, "ready");
    assert.ok(reconnected.connectionGeneration > edgeGeneration);

    const staleGeneration = responseFor(pi, "stale-generation");
    pi.send(JSON.stringify({ type: "request", id: "stale-generation", method: "status", target: { browserId: "edge:profile-a", connectionGeneration: edgeGeneration }, params: {} }));
    assert.equal((await staleGeneration).error.code, "TARGET_CONNECTION_CHANGED");

    const currentGeneration = responseFor(pi, "current-generation");
    pi.send(JSON.stringify({ type: "request", id: "current-generation", method: "status", target: { browserId: "edge:profile-a", connectionGeneration: reconnected.connectionGeneration }, params: {} }));
    assert.equal((await currentGeneration).result.browserId, "edge:profile-a");
  } finally {
    pi?.close();
    first?.close();
    second?.close();
    replacement?.close();
    await stopProcess(child);
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
        if (message.type === "request" && message.method === "wait_forever") resolve(message.id);
      });
    });
    pi.send(JSON.stringify({ type: "request", id: pendingId, method: "wait_forever", params: {} }));
    const forwardedId = await pendingForwarded;
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
    extension.send(JSON.stringify({ type: "response", id: forwardedId, result: { ok: true } }));

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
    await stopProcess(child);
    await stopProcess(replacement);
    await sleep(100);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("bridge isolates same ids across Pi clients and survives Pi disconnects", async () => {
  const port = 17800 + Math.floor(Math.random() * 500);
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-bridge-client-isolation-test-"));
  const tokenFile = join(temp, "token");
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--token-file", tokenFile], { stdio: "ignore", windowsHide: true });
  let extension;
  let piA;
  let piB;
  let piC;
  try {
    await waitHealth(port);
    const pair = await getJson(port, "/pair");
    const connect = (role) => new Promise((resolve, reject) => {
      const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws?role=" + role + "&token=" + encodeURIComponent(pair.body.token));
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    const responseFor = (socket, id) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("response timeout for " + id)), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== id) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(message);
      };
      socket.on("message", onMessage);
    });

    extension = await connect("extension");
    piA = await connect("pi");
    piB = await connect("pi");
    const forwarded = [];
    let forwardedResolve;
    const forwardedReady = new Promise((resolve) => { forwardedResolve = resolve; });
    let lostForwardedResolve;
    const lostForwarded = new Promise((resolve) => { lostForwardedResolve = resolve; });
    extension.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "request") return;
      if (message.method === "same_id_probe") {
        forwarded.push(message);
        if (forwarded.length === 2) forwardedResolve(forwarded.slice());
      }
      if (message.method === "disconnect_probe") lostForwardedResolve(message.id);
      if (message.method === "second_probe") extension.send(JSON.stringify({ type: "response", id: message.id, result: { client: "new" } }));
    });

    const aResponse = responseFor(piA, "same");
    const bResponse = responseFor(piB, "same");
    piA.send(JSON.stringify({ type: "request", id: "same", method: "same_id_probe", params: { client: "a" } }));
    piB.send(JSON.stringify({ type: "request", id: "same", method: "same_id_probe", params: { client: "b" } }));
    const forwardedPair = await forwardedReady;
    assert.equal(new Set(forwardedPair.map((message) => message.id)).size, 2);
    const byClient = new Map(forwardedPair.map((message) => [message.params.client, message]));
    extension.send(JSON.stringify({ type: "response", id: byClient.get("b").id, result: { client: "b" } }));
    extension.send(JSON.stringify({ type: "response", id: byClient.get("a").id, result: { client: "a" } }));
    assert.deepEqual((await aResponse).result, { client: "a" });
    assert.deepEqual((await bResponse).result, { client: "b" });

    piA.send(JSON.stringify({ type: "request", id: "lost", method: "disconnect_probe", params: {} }));
    const observedLostId = await lostForwarded;
    piA.close();
    await new Promise((resolve) => piA.once("close", resolve));
    extension.send(JSON.stringify({ type: "response", id: observedLostId, result: { client: "gone" } }));
    assert.equal((await getJson(port, "/health")).body.ok, true);

    piC = await connect("pi");
    const secondResponse = responseFor(piC, "lost");
    piC.send(JSON.stringify({ type: "request", id: "lost", method: "second_probe", params: {} }));
    assert.deepEqual((await secondResponse).result, { client: "new" });
  } finally {
    piA?.close();
    piB?.close();
    piC?.close();
    extension?.close();
    await stopProcess(child);
    await sleep(100);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("bridge rejects malformed and duplicate pending request ids", async () => {
  const port = 17800 + Math.floor(Math.random() * 500);
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-bridge-request-validation-test-"));
  const tokenFile = join(temp, "token");
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--token-file", tokenFile], { stdio: "ignore", windowsHide: true });
  let pi;
  let extension;
  try {
    await waitHealth(port);
    const pair = await getJson(port, "/pair");
    const connect = (role) => new Promise((resolve, reject) => {
      const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws?role=" + role + "&token=" + encodeURIComponent(pair.body.token));
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    const responseMatching = (socket, predicate) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("response validation timeout")), 3000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (!predicate(message)) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(message);
      };
      socket.on("message", onMessage);
    });
    extension = await connect("extension");
    pi = await connect("pi");
    const malformed = responseMatching(pi, (message) => message.type === "response" && message.error?.code === "INVALID_REQUEST_ID");
    pi.send(JSON.stringify({ type: "request", id: 0, method: "status", params: {} }));
    assert.equal((await malformed).error.code, "INVALID_REQUEST_ID");

    let malformedForwardedId;
    const malformedForwarded = new Promise((resolve) => {
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "request" || message.method !== "malformed_probe") return;
        extension.off("message", onMessage);
        malformedForwardedId = message.id;
        resolve();
      };
      extension.on("message", onMessage);
    });
    const malformedResponse = responseMatching(pi, (message) => message.type === "response" && message.id === "malformed-response");
    pi.send(JSON.stringify({ type: "request", id: "malformed-response", method: "malformed_probe", params: {} }));
    await malformedForwarded;
    extension.send(JSON.stringify({ type: "response", id: malformedForwardedId }));
    extension.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "edge", browserId: "edge:malformed", profile: "malformed", capabilities: { tabIncarnationFence: true } }));
    await waitHealthTarget(port, "edge:malformed");
    let malformedSideEffectId;
    const malformedSideEffectForwarded = new Promise((resolve) => {
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "request" || message.method !== "new_tab") return;
        extension.off("message", onMessage);
        malformedSideEffectId = message.id;
        resolve();
      };
      extension.on("message", onMessage);
    });
    const malformedSideEffectResponse = responseMatching(pi, (message) => message.type === "response" && message.id === "side-effect-malformed");
    pi.send(JSON.stringify({ type: "request", id: "side-effect-malformed", method: "new_tab", params: { url: "about:blank", sessionId: "session-test" } }));
    await malformedSideEffectForwarded;
    extension.send(JSON.stringify({ type: "response", id: malformedSideEffectId }));
    assert.equal((await malformedSideEffectResponse).error.code, "BROWSER_OPERATION_UNCERTAIN");
    assert.equal((await getJson(port, "/health")).body.observability.drainingRequests, 1);
    extension.send(JSON.stringify({ type: "response", id: malformedSideEffectId, result: { late: true } }));
    await sleep(50);
    const drainingDuplicate = responseMatching(pi, (message) => message.type === "response" && message.id === "side-effect-malformed");
    pi.send(JSON.stringify({ type: "request", id: "side-effect-malformed", method: "new_tab", params: { url: "about:blank", sessionId: "session-test" } }));
    assert.equal((await drainingDuplicate).error.code, "BROWSER_OPERATION_UNCERTAIN");

    let forwardedId;
    const forwarded = new Promise((resolve) => {
      extension.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "request" && message.method === "duplicate_probe") {
          forwardedId = message.id;
          resolve(message.id);
        }
      });
    });
    pi.send(JSON.stringify({ type: "request", id: "duplicate", method: "duplicate_probe", params: {} }));
    await forwarded;
    const duplicate = responseMatching(pi, (message) => message.type === "response" && message.id === "duplicate" && message.error?.code === "DUPLICATE_REQUEST_ID");
    const closed = new Promise((resolve) => pi.once("close", resolve));
    pi.send(JSON.stringify({ type: "request", id: "duplicate", method: "duplicate_probe", params: {} }));
    assert.equal((await duplicate).error.code, "DUPLICATE_REQUEST_ID");
    await closed;
    extension.send(JSON.stringify({ type: "response", id: forwardedId, result: { ok: true } }));
    await sleep(50);
  } finally {
    pi?.close();
    extension?.close();
    await stopProcess(child);
    await sleep(100);
    rmSync(temp, { recursive: true, force: true });
  }
});
