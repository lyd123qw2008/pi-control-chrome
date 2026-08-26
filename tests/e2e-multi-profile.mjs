import assert from "node:assert/strict";
import { createServer, get as httpGet } from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
const bridgePath = join(root, "bridge", "server.mjs");
const extensionSource = process.env.PI_CONTROL_CHROME_EXTENSION || join(root, "extension");
const browserExecutable = process.env.PI_CONTROL_CHROME_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

if (!existsSync(browserExecutable)) {
  console.log(`SKIP: browser executable not found: ${browserExecutable}`);
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not allocate a free local port");
  return port;
}

function localGet(port, path, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const request = httpGet({ hostname: "127.0.0.1", port, path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

async function waitFor(read, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (predicate(last)) return last;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`${label} timed out: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function spawnIgnored(command, args) {
  return spawn(command, args, { stdio: "ignore", windowsHide: true });
}

async function stopProcess(child) {
  if (!child?.pid) return;
  await new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.once("error", resolve);
    killer.once("close", resolve);
  });
}

function route(target) {
  return {
    browserId: target.browserId,
    connectionId: target.connectionId,
    connectionGeneration: target.connectionGeneration,
  };
}

function connectPi(port, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=pi&token=${encodeURIComponent(token)}`);
  const open = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let sequence = 0;
  const request = async (method, params = {}, target) => {
    await open;
    const id = `multi-profile-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`request timeout: ${method}`)), 15_000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== id) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        if (message.error) {
          const error = new Error(message.error.message || "Browser request failed");
          error.code = message.error.code;
          reject(error);
        } else {
          resolve(message.result);
        }
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ type: "request", id, method, params, ...(target === undefined ? {} : { target }) }));
    });
  };
  return { socket, request };
}

async function prepareExtension(temp, bridgePort) {
  const extension = join(temp, "extension");
  cpSync(extensionSource, extension, { recursive: true });
  for (const relativePath of ["background.js", "manifest.json"]) {
    const file = join(extension, relativePath);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("127.0.0.1:17318", `127.0.0.1:${bridgePort}`));
  }
  return extension;
}

function spawnBrowser(profile, extension, pageUrl) {
  return spawnIgnored(browserExecutable, [
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "--no-first-run",
    "--no-default-browser-check",
    pageUrl,
  ]);
}

const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-multi-profile-e2e-"));
const bridgePort = await freePort();
const pagePort = await freePort();
const tokenFile = join(temp, "token");
const extension = await prepareExtension(temp, bridgePort);
const profileA = join(temp, "profile-a");
const profileB = join(temp, "profile-b");
const site = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Pi Control Chrome Multi Profile E2E</title><h1>multi-profile-e2e</h1>");
});
await new Promise((resolve) => site.listen(pagePort, "127.0.0.1", resolve));

let bridgeProcess;
let browserA;
let browserB;
let pi;
try {
  bridgeProcess = spawnIgnored(process.execPath, [bridgePath, "--port", String(bridgePort), "--token-file", tokenFile]);
  await waitFor(() => localGet(bridgePort, "/health"), (value) => value.body?.ok === true, "Bridge health");

  const pageUrl = `http://127.0.0.1:${pagePort}/`;
  const pageUrlA = `${pageUrl}?profile=a`;
  const pageUrlB = `${pageUrl}?profile=b`;
  browserA = spawnBrowser(profileA, extension, pageUrlA);
  browserB = spawnBrowser(profileB, extension, pageUrlB);
  const health = await waitFor(
    async () => (await localGet(bridgePort, "/health")).body,
    (value) => value.readyTargetCount === 2 && value.targets?.filter((target) => target.state === "ready").length === 2,
    "two isolated browser targets",
    60_000,
  );
  const readyTargets = health.targets.filter((target) => target.state === "ready");
  assert.equal(new Set(readyTargets.map((target) => target.browserId)).size, 2);
  assert.equal(new Set(readyTargets.map((target) => target.connectionId)).size, 2);

  const token = readFileSync(tokenFile, "utf8").trim();
  pi = connectPi(bridgePort, token);
  const targets = await pi.request("list_targets");
  assert.equal(targets.targets.filter((target) => target.state === "ready").length, 2);
  const readyTargetCandidates = targets.targets.filter((target) => target.state === "ready");
  const targetListings = await Promise.all(readyTargetCandidates.map((target) => pi.request("list_tabs", {}, route(target))));
  const targetAIndex = targetListings.findIndex((listing) => listing.tabs?.some((tab) => tab.url === pageUrlA));
  const targetBIndex = targetListings.findIndex((listing) => listing.tabs?.some((tab) => tab.url === pageUrlB));
  assert.notEqual(targetAIndex, -1);
  assert.notEqual(targetBIndex, -1);
  assert.notEqual(targetAIndex, targetBIndex);
  const targetA = readyTargetCandidates[targetAIndex];
  const targetB = readyTargetCandidates[targetBIndex];
  assert.notEqual(targetA.browserId, targetB.browserId);
  assert.notEqual(targetA.connectionId, targetB.connectionId);

  await assert.rejects(() => pi.request("status"), (error) => error.code === "TARGET_REQUIRED");
  const statusA = await pi.request("status", {}, route(targetA));
  const statusB = await pi.request("status", {}, route(targetB));
  assert.equal(statusA.browserId, targetA.browserId);
  assert.equal(statusB.browserId, targetB.browserId);

  await assert.rejects(
    () => pi.request("status", { expectedBrowserId: targetB.browserId }, route(targetA)),
    (error) => error.code === "INVALID_BROWSER_TARGET",
  );
  const listedA = await pi.request("list_tabs", {}, route(targetA));
  const listedB = await pi.request("list_tabs", {}, route(targetB));
  assert.equal(listedA.browserId, targetA.browserId);
  assert.equal(listedB.browserId, targetB.browserId);
  assert.ok(listedA.tabs.length >= 1);
  assert.ok(listedB.tabs.length >= 1);
  assert.ok(listedA.tabs.every((tab) => tab.browserId === targetA.browserId));
  assert.ok(listedB.tabs.every((tab) => tab.browserId === targetB.browserId));
  assert.equal(new Set(listedA.tabs.map((tab) => tab.id)).size, listedA.tabs.length);
  assert.equal(new Set(listedB.tabs.map((tab) => tab.id)).size, listedB.tabs.length);

  const oldGenerationA = targetA.connectionGeneration;
  await stopProcess(browserA);
  browserA = undefined;
  const disconnected = await waitFor(
    async () => (await localGet(bridgePort, "/health")).body,
    (value) => value.targets?.some((target) => target.browserId === targetA.browserId && target.state === "disconnected")
      && value.targets?.some((target) => target.browserId === targetB.browserId && target.state === "ready"),
    "target A disconnect while target B remains ready",
  );
  assert.equal(disconnected.targets.find((target) => target.browserId === targetB.browserId).state, "ready");
  await assert.rejects(() => pi.request("status", {}, route(targetA)), (error) => error.code === "TARGET_UNAVAILABLE");
  const unaffectedB = await pi.request("list_tabs", {}, route(targetB));
  assert.equal(unaffectedB.browserId, targetB.browserId);

  browserA = spawnBrowser(profileA, extension, pageUrlA);
  const reconnectedHealth = await waitFor(
    async () => (await localGet(bridgePort, "/health")).body,
    (value) => value.targets?.some((target) => target.browserId === targetA.browserId && target.state === "ready"
      && target.connectionGeneration > oldGenerationA),
    "target A reconnection with a new generation",
    60_000,
  );
  const reconnectedA = reconnectedHealth.targets.find((target) => target.browserId === targetA.browserId);
  await assert.rejects(() => pi.request("status", {}, route(targetA)), (error) => error.code === "TARGET_CONNECTION_CHANGED");
  const currentA = await pi.request("status", {}, route(reconnectedA));
  assert.equal(currentA.browserId, targetA.browserId);
  assert.equal(currentA.connectionGeneration, reconnectedA.connectionGeneration);

  console.log(JSON.stringify({
    passed: true,
    targets: [targetA.browserId, targetB.browserId],
    oldGenerationA,
    newGenerationA: reconnectedA.connectionGeneration,
    targetBUnaffected: unaffectedB.browserId === targetB.browserId,
  }));
} finally {
  pi?.socket.close();
  await stopProcess(browserA);
  await stopProcess(browserB);
  await stopProcess(bridgeProcess);
  await new Promise((resolve) => site.close(resolve));
  try {
    rmSync(temp, { recursive: true, force: true });
  } catch {
    // Temporary browser profiles can remain locked briefly after process teardown.
  }
}
