import assert from "node:assert/strict";
import { createServer, get as httpGet } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
const bridge = join(root, "bridge", "server.mjs");
const extension = join(root, "extension");
const edge = process.env.PI_CONTROL_CHROME_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const bridgePort = 17318;
const pagePort = 18180;

if (!existsSync(edge)) {
  console.log(`SKIP: Edge executable not found: ${edge}`);
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-e2e-"));
const profile = join(temp, "profile");
const tokenFile = join(temp, "token");
const site = `<!doctype html><title>Pi Control Chrome E2E</title><h1>Pi Control Chrome E2E</h1><label>Name <input id="name" placeholder="Name"></label><button id="go">Submit</button><div id="out"></div><script>go.onclick=()=>out.textContent='Hello '+document.querySelector('#name').value</script>`;
writeFileSync(join(temp, "index.html"), site);

function localGet(path, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const request = httpGet({ hostname: "127.0.0.1", port: bridgePort, path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function spawnProcess(command, args) {
  return spawn(command, args, { stdio: "ignore", windowsHide: true });
}

function stopProcess(child) {
  if (!child?.pid) return;
  spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

const siteServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(site);
});
await new Promise((resolve) => siteServer.listen(pagePort, "127.0.0.1", resolve));
const bridgeProcess = spawnProcess(process.execPath, [bridge, "--port", String(bridgePort), "--token-file", tokenFile]);
let edgeProcess;
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await localGet("/health")).body.ok) break; } catch {}
    await sleep(100);
  }

  edgeProcess = spawnProcess(edge, [
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "--no-first-run",
    "--no-default-browser-check",
    `http://127.0.0.1:${pagePort}/`,
  ]);

  let health;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    try {
      health = (await localGet("/health")).body;
      if (health.extensionConnected) break;
    } catch {}
  }
  assert.equal(health?.extensionConnected, true, `extension did not connect: ${JSON.stringify(health)}`);

  const token = readFileSync(tokenFile, "utf8").trim();
  const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws?role=pi&token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let sequence = 0;
  const request = (method, params = {}) => {
    const id = `e2e-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`request timeout: ${method}`)), 15000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== id) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ type: "request", id, method, params }));
    });
  };

  const initial = await request("list_tabs");
  assert.ok(initial.tabs.length >= 1);
  const selected = await request("selected_tab");
  assert.ok(selected.tab?.id !== undefined);
  const claimed = await request("claim_tab", {
    tabId: selected.tab.id,
    title: selected.tab.title,
    url: selected.tab.url,
    sessionId: "e2e-session",
  });
  assert.equal(claimed.claimed.owner, "user");
  assert.equal(claimed.claimed.ownership, "claimed");
  await request("navigate", { tabId: selected.tab.id, url: `http://127.0.0.1:${pagePort}/` });
  await sleep(600);
  const snapshot = await request("snapshot", { tabId: selected.tab.id });
  const input = snapshot.snapshot.elements.find((element) => element.tag === "input");
  const button = snapshot.snapshot.elements.find((element) => element.tag === "button");
  assert.ok(input?.ref);
  assert.ok(button?.ref);
  await request("interaction", { tabId: selected.tab.id, operation: "fill", ref: input.ref, value: "Pi" });
  await request("interaction", { tabId: selected.tab.id, operation: "click", ref: button.ref });
  const after = await request("snapshot", { tabId: selected.tab.id });
  assert.match(after.snapshot.text, /Hello Pi/);
  const evaluated = await request("evaluate", { tabId: selected.tab.id, expression: "document.title" });
  assert.equal(evaluated.result?.result?.value, "Pi Control Chrome E2E");
  const screenshot = await request("screenshot", { tabId: selected.tab.id });
  assert.ok(typeof screenshot.data === "string" && screenshot.data.length > 100);

  const created = await request("new_tab", { url: `http://127.0.0.1:${pagePort}/`, active: false, sessionId: "e2e-session" });
  await sleep(700);
  const listed = await request("list_tabs");
  const owned = listed.tabs.find((tab) => tab.id === created.tab.id);
  assert.equal(owned.owner, "agent");
  assert.equal(owned.lifecycle, "temporary");
  const group = listed.groups.find((item) => item.id === owned.groupId);
  assert.equal(group.title, "Pi");
  assert.equal(group.color, "blue");

  await request("mark_handoff", { tabId: created.tab.id });
  const temporary = await request("new_tab", { url: `http://127.0.0.1:${pagePort}/`, active: false, sessionId: "e2e-session" });
  await sleep(300);
  const cleanup = await request("cleanup", { sessionId: "e2e-session" });
  assert.equal(cleanup.removed.includes(created.tab.id), false);
  assert.equal(cleanup.removed.includes(temporary.tab.id), true);
  assert.equal(cleanup.released.includes(selected.tab.id), true);
  await request("close_tab", { tabId: created.tab.id });

  socket.close();
  console.log(JSON.stringify({
    passed: true,
    initialTabs: initial.tabs.length,
    selectedTab: selected.tab.id,
    refs: { input: input.ref, button: button.ref },
    claimedTab: claimed.claimed.id,
    screenshotBytes: Buffer.from(screenshot.data, "base64").length,
    group,
    cleanup,
  }));
} finally {
  siteServer.close();
  stopProcess(edgeProcess);
  stopProcess(bridgeProcess);
  await sleep(1000);
  try { rmSync(temp, { recursive: true, force: true }); } catch {}
}
