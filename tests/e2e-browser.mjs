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
const browserExecutable = process.env.PI_CONTROL_CHROME_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const bridgePort = 17318;
const pagePort = 18180;

if (!existsSync(browserExecutable)) {
  console.log(`SKIP: browser executable not found: ${browserExecutable}`);
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-e2e-"));
const profile = join(temp, "profile");
const tokenFile = join(temp, "token");
const site = `<!doctype html><title>Pi Control Chrome E2E</title><h1>Pi Control Chrome E2E</h1><label>Name <input id="name" placeholder="Name"></label><label>Choice <select id="choice"><option value="one">One</option><option value="two">Two</option></select></label><label><input id="agree" type="checkbox"> Agree</label><input id="file" type="file"><button id="go" data-testid="submit-button">Submit</button><button id="dialog" type="button">Dialog</button><div id="out"></div><script>document.querySelector('#go').addEventListener('click',()=>document.querySelector('#out').textContent='Hello '+document.querySelector('#name').value);document.querySelector('#dialog').addEventListener('click',()=>setTimeout(()=>alert('e2e-dialog'),0));console.log('page-ready');</script>`;
const uploadPath = join(temp, "upload.txt");
writeFileSync(join(temp, "index.html"), site);
writeFileSync(uploadPath, "pi-control-chrome upload test");

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
  if (req.url === "/api/data") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, source: "e2e" }));
    return;
  }
  if (req.url === "/download.txt") {
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": "attachment; filename=pi-control-chrome-download.txt" });
    res.end("downloaded by pi-control-chrome");
    return;
  }
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

  edgeProcess = spawnProcess(browserExecutable, [
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
  await request("navigate", { tabId: selected.tab.id, url: `http://127.0.0.1:${pagePort}/`, wait: true });
  await request("wait", { tabId: selected.tab.id, state: "url", urlIncludes: `127.0.0.1:${pagePort}`, timeoutMs: 5000 });
  await sleep(600);
  const snapshot = await request("snapshot", { tabId: selected.tab.id });
  const input = snapshot.snapshot.elements.find((element) => element.tag === "input");
  const button = snapshot.snapshot.elements.find((element) => element.tag === "button");
  assert.ok(input?.ref);
  assert.ok(button?.ref);
  assert.ok(snapshot.snapshot.accessibility?.children?.some((node) => node.role === "button"));
  const extracted = await request("extract", { tabId: selected.tab.id });
  assert.match(extracted.content.markdown, /Pi Control Chrome E2E/);
  await request("interaction", { tabId: selected.tab.id, operation: "fill", ref: input.ref, value: "Pi" });
  await request("interaction", { tabId: selected.tab.id, operation: "click", ref: button.ref });
  const after = await request("snapshot", { tabId: selected.tab.id });
  assert.match(after.snapshot.text, /Hello Pi/);
  const evaluated = await request("evaluate", { tabId: selected.tab.id, expression: "document.title" });
  assert.equal(evaluated.result?.result?.value, "Pi Control Chrome E2E");

  const roleCount = await request("locator", {
    tabId: selected.tab.id,
    locator: { strategy: "role", value: "button", name: "Submit", exact: true },
    action: "count",
  });
  assert.equal(roleCount.result, 1);
  const placeholderCount = await request("locator", {
    tabId: selected.tab.id,
    locator: { strategy: "placeholder", value: "Name", exact: true },
    action: "count",
  });
  assert.equal(placeholderCount.result, 1);
  await request("locator", {
    tabId: selected.tab.id,
    locator: { strategy: "placeholder", value: "Name", exact: true },
    action: "fill",
    value: "Locator",
  });
  await request("locator", {
    tabId: selected.tab.id,
    locator: { strategy: "role", value: "button", name: "Submit", exact: true },
    action: "click",
  });
  const locatorAfter = await request("snapshot", { tabId: selected.tab.id });
  assert.match(locatorAfter.snapshot.text, /Hello Locator/);
  await request("locator", { tabId: selected.tab.id, locator: { strategy: "css", value: "#choice" }, action: "select", value: "two" });
  await request("locator", { tabId: selected.tab.id, locator: { strategy: "css", value: "#agree" }, action: "check" });
  const controlState = await request("evaluate", { tabId: selected.tab.id, expression: "JSON.stringify({choice:document.querySelector('#choice').value,checked:document.querySelector('#agree').checked})" });
  assert.deepEqual(JSON.parse(controlState.result?.result?.value), { choice: "two", checked: true });

  const visibleDom = await request("dom_cua", { tabId: selected.tab.id, action: "get_visible_dom" });
  const domButton = visibleDom.dom.nodes.find((node) => node.tag === "button" && node.text.includes("Submit"));
  assert.ok(domButton?.node_id);
  await request("dom_cua", { tabId: selected.tab.id, action: "click", nodeId: domButton.node_id });
  const inputRect = input.rect;
  await request("cua", { tabId: selected.tab.id, action: "click", x: inputRect.x + 4, y: inputRect.y + 4 });
  await request("cua", { tabId: selected.tab.id, action: "type", text: " CUA" });
  const cuaValue = await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#name').value" });
  assert.match(cuaValue.result?.result?.value, /CUA/);

  await request("devtools_enable", { tabId: selected.tab.id, domains: ["Runtime", "Log", "Network", "Page"] });
  await request("evaluate", { tabId: selected.tab.id, expression: "console.error('e2e-console'); fetch('/api/data')", awaitPromise: true });
  await sleep(700);
  const consoleLogs = await request("console_logs", { tabId: selected.tab.id });
  assert.ok(consoleLogs.logs.some((entry) => String(entry.text).includes("e2e-console")));
  const network = await request("network_requests", { tabId: selected.tab.id });
  const apiResponse = network.requests.find((entry) => entry.event === "response" && entry.url.endsWith("/api/data") && entry.status === 200);
  assert.ok(apiResponse?.requestId);
  const responseBody = await request("network_response_body", { tabId: selected.tab.id, requestId: apiResponse.requestId });
  assert.match(responseBody.result?.body || "", /pi-control-chrome|e2e/);

  await request("evaluate", { tabId: selected.tab.id, expression: "setTimeout(()=>alert('e2e-dialog'),100); 'scheduled'" });
  await sleep(500);
  const dialog = await request("dialog", { tabId: selected.tab.id, action: "get" });
  assert.equal(dialog.dialog?.message, "e2e-dialog");
  await request("dialog", { tabId: selected.tab.id, action: "accept" });

  await request("upload", { tabId: selected.tab.id, selector: "#file", files: uploadPath });
  const uploadCount = await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#file').files.length" });
  assert.equal(uploadCount.result?.result?.value, 1);

  const clipboardText = `pi-clipboard-${Date.now()}`;
  await request("clipboard", { tabId: selected.tab.id, action: "write", text: clipboardText });
  const clipboard = await request("clipboard", { tabId: selected.tab.id, action: "read" });
  assert.equal(clipboard.text, clipboardText);

  const download = await request("download", { action: "start", url: `http://127.0.0.1:${pagePort}/download.txt`, wait: true, timeoutMs: 15000 });
  assert.equal(download.download?.state, "complete");
  assert.match(download.download?.filename || "", /pi-control-chrome-download/);

  const screenshot = await request("screenshot", { tabId: selected.tab.id });
  assert.ok(typeof screenshot.data === "string" && screenshot.data.length > 100);

  const created = await request("new_tab", { url: `http://127.0.0.1:${pagePort}/`, active: false, sessionId: "e2e-session" });
  await sleep(700);
  const listed = await request("list_tabs");
  assert.ok(listed.browserId);
  assert.equal(listed.profile, "current");
  assert.ok(listed.tabs[0].handle?.tabId !== undefined);
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
