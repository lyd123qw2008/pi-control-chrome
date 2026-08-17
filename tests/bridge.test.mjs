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
