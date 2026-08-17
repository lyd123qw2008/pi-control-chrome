#!/usr/bin/env node

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const DEFAULT_PORT = 17318;
const DEFAULT_TOKEN_FILE = join(
  process.env.USERPROFILE || process.env.HOME || process.cwd(),
  ".pi",
  "agent",
  "pi-control-chrome.token",
);
const DEBUG = process.env.PI_CONTROL_CHROME_DEBUG === "1";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(argValue("--port", DEFAULT_PORT));
const tokenFile = argValue("--token-file", DEFAULT_TOKEN_FILE);

function ensureToken() {
  if (existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, "utf8").trim();
    if (existing) return existing;
  }
  mkdirSync(dirname(tokenFile), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

const token = ensureToken();
const clients = new Set();
const pending = new Map();
let extensionClient;
let requestCounter = 0;

function debug(...args) {
  if (DEBUG) console.error("[pi-control-chrome]", ...args);
}

function jsonResponse(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    ...extraHeaders,
  });
  res.end(body);
}

function send(client, message) {
  if (client?.readyState !== 1) return false;
  client.send(JSON.stringify(message));
  return true;
}

function sendError(client, id, code, message) {
  send(client, { type: "response", id, error: { code, message } });
}

function broadcast(message) {
  for (const client of clients) send(client, message);
}

function handleMessage(client, message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "request" && client.role === "pi") {
    if (!extensionClient || extensionClient.readyState !== 1) {
      sendError(client, message.id, "EXTENSION_OFFLINE", "Chrome/Edge extension is not connected.");
      return;
    }
    const id = String(message.id || `req-${++requestCounter}`);
    pending.set(id, { client, timer: setTimeout(() => {
      pending.delete(id);
      sendError(client, id, "TIMEOUT", `Browser request timed out: ${message.method || "unknown"}`);
    }, 120_000) });
    send(extensionClient, { type: "request", id, method: message.method, params: message.params ?? {} });
    return;
  }

  if (message.type === "response" && client.role === "extension") {
    const entry = pending.get(String(message.id));
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(String(message.id));
    send(entry.client, message);
    return;
  }

  if (message.type === "event" && client.role === "extension") {
    broadcast(message);
  }
}

const server = createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1:${port}"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    jsonResponse(res, 200, {
      ok: true,
      protocol: 1,
      port,
      extensionConnected: Boolean(extensionClient && extensionClient.readyState === 1),
      piClients: [...clients].filter((client) => client.role === "pi" && client.readyState === 1).length,
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/pair") {
    jsonResponse(res, 200, { ok: true, protocol: 1, token });
    return;
  }

  jsonResponse(res, 404, { ok: false, error: "not_found" });
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (client, request) => {
  const requestUrl = new URL(request.url || "/ws", `http://${request.headers.host || "127.0.0.1:${port}"}`);
  const suppliedToken = requestUrl.searchParams.get("token");
  const role = requestUrl.searchParams.get("role");
  if (suppliedToken !== token || (role !== "pi" && role !== "extension")) {
    client.close(1008, "invalid pairing");
    return;
  }

  client.role = role;
  clients.add(client);
  if (role === "extension") {
    if (extensionClient && extensionClient !== client) extensionClient.close(1012, "replaced");
    extensionClient = client;
    debug("extension connected");
  } else {
    debug("pi client connected");
  }

  send(client, { type: "hello", role: "bridge", protocol: 1, extensionConnected: Boolean(extensionClient) });
  broadcast({ type: "event", event: "connection", role, connected: true });

  client.on("message", (raw) => {
    try {
      handleMessage(client, JSON.parse(raw.toString()));
    } catch (error) {
      debug("invalid message", error instanceof Error ? error.message : String(error));
    }
  });
  client.on("close", () => {
    clients.delete(client);
    if (extensionClient === client) extensionClient = undefined;
    broadcast({ type: "event", event: "connection", role, connected: false });
    debug(`${role} disconnected`);
  });
  client.on("error", (error) => debug(`${role} websocket error`, error.message));
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ ok: true, port, tokenFile, pid: process.pid }));
});

function shutdown() {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("exit", () => {
  for (const entry of pending.values()) clearTimeout(entry.timer);
});

export { tokenFile };
