// Measure a "read everything now" flow against a "ask the question, then fetch evidence" flow on a
// real page pair (a detail page plus its log page), read-only. Reports model-visible bytes per step
// and in total, so a workflow decision is based on what actually enters a context.
//
// Usage: node tests/measure-flow.mjs <detail-tab-id> <log-url> [selector] [terminalMatch]
//   selector       region read with a targeted extract, default "main"
//   terminalMatch  literal whose log line is the decisive evidence, default "Finished"
// The script only reads: status, snapshot and extract. It opens one temporary Agent tab for the log
// URL, closes it again, and never interacts with or navigates the user's own tabs.
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { compactExtractResult, compactSnapshotResult, compactStatusResult } from "../pi-extension/output.js";

const token = readFileSync("C:/Users/liuyd/.pi/agent/pi-control-chrome.token", "utf8").trim();
const socket = new WebSocket(`ws://127.0.0.1:17318/ws?role=pi&token=${encodeURIComponent(token)}`);
let sequence = 0;
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = `flow-${++sequence}`;
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
  socket.send(JSON.stringify({ type: "request", id, method, params: { ...params, sessionId: "flow-session" } }));
});

const size = (value) => { try { return JSON.stringify(value ?? null).length; } catch { return 0; } };
const step = async (label, method, params, project) => {
  const started = Date.now();
  const value = await request(method, params);
  const wire = size(value);
  const model = project === undefined ? wire : size(project(value));
  console.log(`  ${String(model).padStart(7)} model  ${String(wire).padStart(7)} wire  ${String(Date.now() - started).padStart(6)} ms  ${label}`);
  return { model, wire };
};

await new Promise((resolve, reject) => { socket.on("open", resolve); socket.on("error", reject); });
const detailTab = Number(process.argv[2]);
const logUrl = process.argv[3];
const selector = process.argv[4] ?? "main";
const terminalMatch = process.argv[5] ?? "Finished";

const exhaustive = [];
console.log("== exhaustive: read everything, decide later ==");
exhaustive.push(await step("status", "status", {}, compactStatusResult));
exhaustive.push(await step("detail page (unprojected semantic read)", "snapshot", { tabId: detailTab, maxChars: 20_000, maxNodes: 1_000, responseMode: "raw" }, (value) => compactSnapshotResult(value)));
exhaustive.push(await step("detail page (whole text, raw)", "extract", { tabId: detailTab, maxChars: 12_000, responseMode: "raw" }, (value) => compactExtractResult(value, 12_000)));
const logTab = await request("new_tab", { url: logUrl, active: false, wait: true, timeoutMs: 20_000 });
exhaustive.push(await step("log page (whole text, raw)", "extract", { tabId: logTab.tab.id, maxChars: 12_000, responseMode: "raw", includeFrames: false }, (value) => compactExtractResult(value, 12_000)));

const bounded = [];
console.log("== bounded: ask the question, then fetch evidence ==");
bounded.push(await step("status", "status", {}, compactStatusResult));
bounded.push(await step("detail page digest", "snapshot", { tabId: detailTab, responseMode: "compact" }, (value) => compactSnapshotResult(value)));
bounded.push(await step(`targeted region extract (${selector}, 600)`, "extract", { tabId: detailTab, selector, maxChars: 600, responseMode: "compact" }, (value) => compactExtractResult(value, 600)));
bounded.push(await step(`log line match (${terminalMatch}, 300)`, "extract", { tabId: logTab.tab.id, scope: "log", logMatch: terminalMatch, tail: true, maxChars: 300, responseMode: "compact", includeFrames: false }, (value) => compactExtractResult(value, 300)));
bounded.push(await step("log failure evidence (ERROR, 300)", "extract", { tabId: logTab.tab.id, scope: "log", logMatch: "ERROR", tail: true, maxChars: 300, responseMode: "compact", includeFrames: false }, (value) => compactExtractResult(value, 300)));

await request("close_tab", { tabId: logTab.tab.id });
const total = (rows) => rows.reduce((sum, row) => sum + row.model, 0);
console.log("== result ==");
console.log(`exhaustive: ${exhaustive.length} calls, ${total(exhaustive)} model-visible bytes`);
console.log(`bounded   : ${bounded.length} calls, ${total(bounded)} model-visible bytes`);
console.log(`ratio     : ${(total(bounded) / total(exhaustive)).toFixed(2)}x of the exhaustive cost`);
console.log(`bounded without the orienting digest: ${bounded.length - 1} calls, ${total(bounded) - bounded[1].model} model-visible bytes`);
socket.close();
