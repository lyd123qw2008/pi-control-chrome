// Measure the read cost of a real page, read-only. Prints byte counts only, never payloads, so the
// measurement itself costs no model context. For every read it reports the wire size and the
// model-visible size after the shared projection — the number that actually enters a context.
//
// Usage: node tests/measure-reads.mjs <build-tab-id> <console-tab-id>
//   Find the ids with `browser_tabs({ query: "job/" })`, or run the bundled CLI:
//   node skills/pi-control-chrome/scripts/browser.mjs tabs --json
// The script is explicitly read-only: status, snapshot and extract. It never interacts, navigates,
// closes a tab, or triggers a build, and it waits for the Bridge to drain before measuring so a
// leftover request cannot skew the numbers.
import { readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import WebSocket from "ws";
import { compactExtractResult, compactSnapshotResult, compactStatusResult } from "../pi-extension/output.js";

async function waitBridgeIdle(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await new Promise((resolve) => {
      const request = httpGet({ hostname: "127.0.0.1", port: 17318, path: "/health" }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(undefined); } });
      });
      request.on("error", () => resolve(undefined));
      request.setTimeout(2000, () => { request.destroy(); resolve(undefined); });
    });
    const observability = health?.observability;
    if (observability && observability.pendingRequests === 0 && observability.drainingRequests === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const token = readFileSync("C:/Users/liuyd/.pi/agent/pi-control-chrome.token", "utf8").trim();
const socket = new WebSocket(`ws://127.0.0.1:17318/ws?role=pi&token=${encodeURIComponent(token)}`);
let sequence = 0;

function request(method, params = {}) {
  const id = `measure-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 180_000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "response" || message.id !== id) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      if (message.error) reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else resolve(message.result);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ type: "request", id, method, params: { ...params, sessionId: "measure-session" } }));
  });
}

const size = (value) => {
  try { return JSON.stringify(value ?? null).length; } catch { return 0; }
};
const rows = [];
const measure = async (label, method, params, project) => {
  const started = Date.now();
  try {
    const value = await request(method, params);
    const wire = size(value);
    const projected = project === undefined ? wire : size(project(value));
    rows.push({ label, wire, projected });
    console.log(`${String(wire).padStart(8)} wire  ${String(projected).padStart(8)} model  ${String(Date.now() - started).padStart(6)} ms  ${label}`);
    return value;
  } catch (error) {
    rows.push({ label, wire: -1, projected: -1 });
    console.log(`${"FAILED".padStart(8)}                  ${String(Date.now() - started).padStart(6)} ms  ${label} (${error.message})`);
    return undefined;
  }
};

await new Promise((resolve, reject) => { socket.on("open", resolve); socket.on("error", reject); });
const [buildTab, consoleTab] = process.argv.slice(2).map(Number);
console.log(`bridge idle before measuring: ${await waitBridgeIdle()}`);

console.log("== build page: FXYF2_docker_5g-os-console #701 (read-only) ==");
await measure("status", "status", {}, compactStatusResult);
await measure("snapshot digest (pageMap, compact)", "snapshot", { tabId: buildTab, responseMode: "compact" }, (value) => compactSnapshotResult(value));
await measure("snapshot legacy semantic (unprojected page read)", "snapshot", { tabId: buildTab, maxChars: 20_000, maxNodes: 1_000, responseMode: "raw" }, (value) => compactSnapshotResult(value));
await measure("extract #main-panel (targeted, 600 chars)", "extract", { tabId: buildTab, selector: "#main-panel", maxChars: 600, responseMode: "compact" }, (value) => compactExtractResult(value, 600));
await measure("extract whole page (compact, 12k budget)", "extract", { tabId: buildTab, maxChars: 12_000, responseMode: "compact" }, (value) => compactExtractResult(value, 12_000));
await measure("extract whole page (raw)", "extract", { tabId: buildTab, maxChars: 12_000, responseMode: "raw" }, (value) => compactExtractResult(value, 12_000));

console.log("== console page: #701 console (read-only) ==");
await measure("console log tail (300 chars)", "extract", { tabId: consoleTab, scope: "log", tail: true, maxChars: 300, responseMode: "compact" }, (value) => compactExtractResult(value, 300));
await measure("console logMatch 'Finished' (300 chars)", "extract", { tabId: consoleTab, scope: "log", logMatch: "Finished", tail: true, maxChars: 300, responseMode: "compact" }, (value) => compactExtractResult(value, 300));
await measure("console whole page (compact, 12k budget)", "extract", { tabId: consoleTab, maxChars: 12_000, responseMode: "compact" }, (value) => compactExtractResult(value, 12_000));
await measure("console whole page (raw)", "extract", { tabId: consoleTab, maxChars: 12_000, responseMode: "raw" }, (value) => compactExtractResult(value, 12_000));

console.log("== summary (model-visible bytes) ==");
for (const row of rows) console.log(`${String(row.projected).padStart(8)}  ${row.label}`);
const sum = (predicate) => rows.filter(predicate).reduce((total, row) => total + Math.max(0, row.projected), 0);
const oldPath = sum((row) => /status|legacy semantic|console whole page \(raw\)/.test(row.label));
const newPath = sum((row) => /status|snapshot digest|targeted|logMatch/.test(row.label));
console.log(`verification question, old path (status + legacy page read + raw console): ${oldPath} bytes`);
console.log(`verification question, new path (status + digest + targeted read + logMatch): ${newPath} bytes`);
socket.close();
