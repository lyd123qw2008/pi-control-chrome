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
const port = 19000 + Math.floor(Math.random() * 500);
const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-bridge-stability-"));
const tokenFile = join(temp, "token");
const browserId = "edge:stability-profile";
const profile = "stability-profile";
const capabilities = { tabIncarnationFence: true, turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true };
const child = spawn(process.execPath, [serverPath, "--port", String(port), "--token-file", tokenFile], { stdio: "ignore", windowsHide: true });
let extension;
let pi;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function getJson(path) {
  return new Promise((resolve, reject) => {
    const request = httpGet({ hostname: "127.0.0.1", port, path }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(1000, () => request.destroy(new Error("Bridge health timeout")));
    request.on("error", reject);
  });
}
async function waitFor(predicate, label, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {}
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function waitHealth(predicate, label) { return waitFor(() => getJson("/health").then(value => predicate(value) ? value : undefined), label); }
function connect(role) {
  const token = readFileSync(tokenFile, "utf8").trim();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}&token=${encodeURIComponent(token)}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}
function responseFor(socket, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Response timeout for ${id}`)), 3000);
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "response" || message.id !== id) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}
function request(id, method, params) {
  pi.send(JSON.stringify({ type: "request", id, method, params }));
  return responseFor(pi, id);
}
async function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  await new Promise(resolve => {
    socket.once("close", resolve);
    socket.close();
  });
}
async function stopProcess(processHandle) {
  if (!processHandle?.pid) return;
  if (process.platform !== "win32") {
    processHandle.kill("SIGTERM");
    await new Promise(resolve => processHandle.once("exit", resolve));
    return;
  }
  await new Promise(resolve => {
    const killer = spawn("taskkill.exe", ["/PID", String(processHandle.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.once("close", resolve);
    killer.once("error", resolve);
  });
}

try {
  await waitHealth(value => value.ok === true, "Bridge health");
  pi = await connect("pi");
  extension = await connect("extension");
  extension.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "edge", browserId, profile, extensionVersion: "0.5.8", capabilities }));
  let health = await waitHealth(value => value.readyTargetCount === 1 && value.targets?.[0]?.state === "ready", "initial target");
  let generation = health.targets[0].connectionGeneration;
  const rounds = 12;
  for (let index = 0; index < rounds; index += 1) {
    const sessionId = `stability-session-${index}`;
    const acquired = await request(`lease-acquire-${index}`, "target_lease", { action: "acquire", browserId, sessionId });
    assert.equal(acquired.result?.acquired, true);
    await closeSocket(extension);
    health = await waitHealth(value => value.targets?.some(target => target.browserId === browserId && target.state === "disconnected"), `disconnect round ${index}`);
    assert.equal(health.observability.targetLeases.activeCount, 0);
    extension = await connect("extension");
    extension.send(JSON.stringify({ type: "hello", role: "extension", protocol: 1, browser: "edge", browserId, profile, extensionVersion: "0.5.8", capabilities }));
    health = await waitHealth(value => value.targets?.some(target => target.browserId === browserId && target.state === "ready" && target.connectionGeneration > generation), `reconnect round ${index}`);
    generation = health.targets.find(target => target.browserId === browserId).connectionGeneration;
  }
  assert.ok(health.observability.metrics.targetReconnects >= rounds);
  assert.ok(health.observability.metrics.targetLeaseInvalidations >= rounds);
  assert.equal(health.observability.targetLeases.activeCount, 0);
  console.log(JSON.stringify({ passed: true, rounds, reconnects: health.observability.metrics.targetReconnects, leaseInvalidations: health.observability.metrics.targetLeaseInvalidations, finalGeneration: generation }));
} finally {
  await closeSocket(extension);
  await closeSocket(pi);
  await stopProcess(child);
  await sleep(100);
  rmSync(temp, { recursive: true, force: true });
}
