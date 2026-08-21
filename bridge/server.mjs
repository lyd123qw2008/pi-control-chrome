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

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extensionIdentity(value) {
  if (!value || typeof value !== "object") return undefined;
  const browser = nonEmptyString(value.browser);
  const browserId = nonEmptyString(value.browserId);
  const profile = nonEmptyString(value.profile);
  if (!browser || !browserId || !profile) return undefined;
  return {
    browser,
    browserId,
    profile,
    ...(nonEmptyString(value.extensionVersion) ? { extensionVersion: value.extensionVersion } : {}),
    ...(nonEmptyString(value.userAgent) ? { userAgent: value.userAgent } : {}),
  };
}

function setExtensionIdentity(client, value) {
  const identity = extensionIdentity(value);
  if (!identity) return false;
  client.browserIdentity = identity;
  return true;
}

function requestExpectedBrowserId(message) {
  if (!message.params || typeof message.params !== "object") return undefined;
  return nonEmptyString(message.params.expectedBrowserId);
}

function rejectPendingForExtension(extension, code, message) {
  for (const [id, entry] of pending.entries()) {
    if (entry.extension !== extension) continue;
    clearTimeout(entry.timer);
    pending.delete(id);
    sendError(entry.client, id, code, message);
  }
}

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
    const id = String(message.id || `req-${++requestCounter}`);
    const activeExtension = extensionClient;
    if (!activeExtension || activeExtension.readyState !== 1) {
      sendError(client, id, "EXTENSION_OFFLINE", "Chrome/Edge extension is not connected.");
      return;
    }
    const expectedBrowserId = requestExpectedBrowserId(message);
    if (message.params && typeof message.params === "object" && message.params.expectedBrowserId !== undefined && !expectedBrowserId) {
      sendError(client, id, "INVALID_BROWSER_TARGET", "expectedBrowserId must be a non-empty string.");
      return;
    }
    if (expectedBrowserId && activeExtension.browserIdentity?.browserId !== expectedBrowserId) {
      const actual = activeExtension.browserIdentity?.browserId;
      sendError(
        client,
        id,
        actual ? "BROWSER_TARGET_CHANGED" : "BROWSER_TARGET_UNAVAILABLE",
        actual
          ? `Browser target changed; expected ${expectedBrowserId} but the active extension is ${actual}.`
          : "The active extension has not identified its browser target yet.",
      );
      return;
    }
    pending.set(id, { client, extension: activeExtension, method: message.method, timer: setTimeout(() => {
      pending.delete(id);
      sendError(client, id, "TIMEOUT", `Browser request timed out: ${message.method || "unknown"}`);
    }, 120_000) });
    if (!send(activeExtension, { type: "request", id, method: message.method, params: message.params ?? {} })) {
      const entry = pending.get(id);
      if (entry) clearTimeout(entry.timer);
      pending.delete(id);
      sendError(client, id, "EXTENSION_OFFLINE", "Chrome/Edge extension disconnected before the request was sent.");
    }
    return;
  }

  if (message.type === "hello" && client.role === "extension") {
    if (!setExtensionIdentity(client, message)) debug("extension hello did not contain a browser identity");
    return;
  }

  if (message.type === "response" && client.role === "extension") {
    const entry = pending.get(String(message.id));
    if (!entry || entry.extension !== client) return;
    if (entry.method === "status") setExtensionIdentity(client, message.result);
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
    const identity = extensionClient?.browserIdentity;
    jsonResponse(res, 200, {
      ok: true,
      protocol: 1,
      port,
      extensionConnected: Boolean(extensionClient && extensionClient.readyState === 1),
      piClients: [...clients].filter((client) => client.role === "pi" && client.readyState === 1).length,
      ...(identity || {}),
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
  client.browserIdentity = undefined;
  clients.add(client);
  if (role === "extension") {
    if (extensionClient && extensionClient !== client) {
      rejectPendingForExtension(extensionClient, "BROWSER_TARGET_CHANGED", "The active Chrome/Edge extension was replaced by another browser extension.");
      extensionClient.close(1012, "replaced");
    }
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
    if (client.role === "extension") rejectPendingForExtension(client, "EXTENSION_OFFLINE", "Chrome/Edge extension disconnected.");
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
