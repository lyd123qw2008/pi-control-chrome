// Read-only digest audit over whatever real pages are open in the browser. It looks for the
// pathologies a synthetic archetype cannot produce — a page collapsing into one giant region,
// metadata noise from prose, unaddressable regions, or a contract violation — and prints one
// bounded line per page plus a findings summary.
//
// Usage: node tests/audit-digests.mjs [maxPages] [urlFilter]
//   maxPages   how many http(s) pages to audit, default 16
//   urlFilter  optional case-insensitive substring; only matching URLs are audited
import { readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import WebSocket from "ws";

const token = readFileSync("C:/Users/liuyd/.pi/agent/pi-control-chrome.token", "utf8").trim();
const socket = new WebSocket(`ws://127.0.0.1:17318/ws?role=pi&token=${encodeURIComponent(token)}`);
let sequence = 0;

function request(method, params = {}) {
  const id = `audit-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 60_000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "response" || message.id !== id) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      if (message.error) reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else resolve(message.result);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ type: "request", id, method, params: { ...params, sessionId: "audit-session" } }));
  });
}

async function waitBridgeIdle(timeoutMs = 60_000) {
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

const clip = (value, limit) => (typeof value === "string" && value.length > limit ? `${value.slice(0, limit - 1)}…` : String(value ?? ""));

function analyse(state) {
  const headerIndex = state.indexOf("Regions (document order):");
  const regionLines = headerIndex < 0 ? [] : state.slice(headerIndex).split("\n").filter((line) => /^- /.test(line));
  const detailLines = headerIndex < 0 ? [] : state.slice(headerIndex).split("\n").filter((line) => /^\s{2}controls:/.test(line));
  const valueLines = state.split("\n").filter((line) => /^\s*values:/.test(line));
  const values = valueLines.flatMap((line) => line.replace(/^\s*values:\s*/, "").split(", ")).filter(Boolean);
  const controls = regionLines.map((line) => Number((line.match(/\(controls=(\d+)/) ?? [])[1] ?? 0));
  const totalControls = controls.reduce((sum, value) => sum + value, 0);
  const largestControls = controls.length === 0 ? 0 : Math.max(...controls);
  const flags = [];
  // Contract violations: these must never appear in any digest.
  if (state.includes("Primary") || state.includes("Key actions")) flags.push("VIOLATION:ranking");
  if (/undefined|\[object Object\]/.test(state)) flags.push("VIOLATION:internal");
  if (regionLines.some((line) => !/\[ref=e\d+\]/.test(line))) flags.push("VIOLATION:no-ref");
  if (state.includes("truncated") && !state.includes("Omitted:") && !valueLines.some((line) => line.includes("omitted"))) flags.push("check:truncation");
  // Pathologies worth a look, not violations.
  if (totalControls > 120 && largestControls / Math.max(1, totalControls) > 0.8) flags.push("dominant-region");
  if (regionLines.length <= 2 && totalControls > 60) flags.push("few-regions");
  // A ref is a valid address on its own; a region without a stable `{...}` address is only harder
  // to re-address, not a violation.
  if (regionLines.some((line) => !/\{[^}]+\}/.test(line))) flags.push("ref-only-region");
  const phraseValues = values.filter((entry) => {
    const label = entry.split("=")[0] ?? "";
    return label.trim().split(/\s+/).length >= 3;
  });
  if (phraseValues.length > 0) flags.push(`phrase-values=${phraseValues.length}`);
  const longValues = values.filter((entry) => (entry.split("=").slice(1).join("=") ?? "").length > 140);
  if (longValues.length > 0) flags.push(`long-values=${longValues.length}`);
  if (state.length > 6_500) flags.push("oversize");
  return { regionLines, detailLines, values, totalControls, flags };
}

await new Promise((resolve, reject) => { socket.on("open", resolve); socket.on("error", reject); });
const maxPages = Number(process.argv[2] ?? 16);
const urlFilter = (process.argv[3] ?? "").toLowerCase();
console.log(`bridge idle: ${await waitBridgeIdle()}`);

const listing = await request("list_tabs", {});
const candidates = listing.tabs
  .filter((tab) => /^https?:/i.test(tab.url ?? ""))
  .filter((tab) => urlFilter === "" || `${tab.url}\n${tab.title}`.toLowerCase().includes(urlFilter))
  .slice(0, maxPages);
console.log(`auditing ${candidates.length} of ${listing.totalTabs} tabs\n`);

const findings = [];
for (const tab of candidates) {
  try {
    const snapshot = await request("snapshot", { tabId: tab.id, responseMode: "compact" });
    const state = snapshot.snapshot?.state ?? "";
    const analysis = analyse(state);
    const sample = analysis.regionLines.slice(0, 3).map((line) => clip(line, 110)).join(" || ");
    console.log(`${String(state.length).padStart(6)}B  r=${String(analysis.regionLines.length).padStart(2)} ctrl=${String(analysis.totalControls).padStart(4)} v=${String(analysis.values.length).padStart(2)}  [${analysis.flags.join(",") || "ok"}]  ${clip(tab.title, 40)}`);
    console.log(`        ${clip(tab.url, 100)}`);
    console.log(`        ${sample}`);
    if (analysis.flags.length > 0) findings.push({ title: tab.title, url: tab.url, flags: analysis.flags, analysis, state });
  } catch (error) {
    console.log(`${"FAILED".padStart(6)}   ${clip(tab.title, 40)}  (${error.message})`);
    findings.push({ title: tab.title, url: tab.url, flags: [`error:${error.message}`], analysis: undefined, state: "" });
  }
}

console.log("\n== findings ==");
if (findings.length === 0) console.log("no pathology found on the audited pages");
for (const finding of findings) {
  console.log(`- [${finding.flags.join(",")}] ${clip(finding.title, 60)}`);
  console.log(`  ${clip(finding.url, 110)}`);
  if (finding.analysis !== undefined) {
    for (const line of finding.analysis.regionLines.slice(0, 4)) console.log(`  ${clip(line, 150)}`);
    if (finding.analysis.values.length > 0) console.log(`  values: ${clip(finding.analysis.values.slice(0, 6).join(" | "), 240)}`);
  }
}
socket.close();
