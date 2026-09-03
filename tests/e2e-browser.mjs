import assert from "node:assert/strict";
import { createServer, get as httpGet } from "node:http";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { compactBrowserResult } from "../pi-extension/output.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const bridge = join(root, "bridge", "server.mjs");
const extensionSource = process.env.PI_CONTROL_CHROME_EXTENSION || join(root, "extension");
const browserExecutable = process.env.PI_CONTROL_CHROME_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function freeTcpPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = address && typeof address !== "string" ? address.port : undefined;
  await new Promise((resolve) => probe.close(resolve));
  if (!port) throw new Error("Could not reserve a free Bridge port");
  return port;
}

const configuredBridgePort = process.env.PI_CONTROL_CHROME_BRIDGE_PORT;
const bridgePort = configuredBridgePort === undefined ? await freeTcpPort() : Number(configuredBridgePort);
if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) throw new Error("PI_CONTROL_CHROME_BRIDGE_PORT must be a valid TCP port");
const bridgeStartupMarker = `e2e-${process.pid}-${randomUUID()}`;
let pagePort;

if (!existsSync(browserExecutable)) {
  console.log(`SKIP: browser executable not found: ${browserExecutable}`);
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-e2e-"));
const profile = join(temp, "profile");
const tokenFile = join(temp, "token");
const extension = join(temp, "extension");
cpSync(extensionSource, extension, { recursive: true });
const backgroundFile = join(extension, "background.js");
writeFileSync(backgroundFile, readFileSync(backgroundFile, "utf8").replaceAll("127.0.0.1:17318", `127.0.0.1:${bridgePort}`));
const manifestFile = join(extension, "manifest.json");
writeFileSync(manifestFile, readFileSync(manifestFile, "utf8").replaceAll("127.0.0.1:17318", `127.0.0.1:${bridgePort}`));
const largeGenericPage = Array.from({ length: 600 }, (_, index) => `<div><div><span>Repeated generic content ${index} ${"copy ".repeat(24)}</span></div></div>`).join("");
const site = `<!doctype html>
<title>Pi Control Chrome E2E</title>
<style>#delayed-action,#ambiguous-a,#ambiguous-b,#hidden-action,#indexed-hidden{display:none}</style>
<h1>Pi Control Chrome E2E</h1>
<div id="async-status">Loading...</div>
<label>Name <input id="name" placeholder="Name"></label>
<label>Choice <select id="choice"><option value="one">One</option><option value="two">Two</option></select></label>
<label><input id="agree" type="checkbox"> Agree</label>
<label for="email">Email</label><input id="email" placeholder="Email">
<input id="readonly" value="secret-value" autocomplete="current-password" readonly>
<label for="editor">Editor</label><div id="editor" role="textbox" contenteditable></div>
<input id="file" type="file">
<button id="go" data-testid="submit-button">Submit</button>
<button id="history-action" type="button">History action</button>
<button id="navigate-action" type="button">Navigate action</button>
<button id="dialog" type="button">Dialog</button>
<span id="aria-name">Accessible action</span><button id="aria-button" aria-labelledby="aria-name">Icon</button>
<button id="aria-label-button" aria-label="Labelled action">Icon</button>
<button id="hidden-action">Hidden action</button>
<main><button id="text-action">Text <span>target</span><br>now</button></main>
<button id="delayed-action" data-testid="delayed-button">Ready action</button>
<button id="disabled-action" disabled>Disabled action</button>
<button id="disabled-nested" disabled data-probe="disabled-button"><span>Disabled nested</span></button>
<div id="nested-editor" contenteditable><span>Nested editor</span></div>
<div id="shadow-host"></div>
<iframe id="semantic-frame" title="Semantic frame" srcdoc="<!doctype html><button aria-label='Frame action'>Frame action</button>"></iframe>
<div id="custom-combobox" role="combobox" aria-label="Custom choice" aria-expanded="false" tabindex="0">Choose</div>
<button id="ambiguous-a">Ambiguous</button><button id="ambiguous-b">Ambiguous</button>
<button id="indexed-hidden">Indexed action</button><button id="indexed-visible">Indexed action</button>
<div id="out"></div>
<div id="large-generic-page">${largeGenericPage}</div>
<script>
const marker = new URLSearchParams(location.search).get('marker');
if (marker) document.querySelector('h1').textContent = marker;
const out = document.querySelector('#out');
document.querySelector('#go').addEventListener('click', () => { out.textContent = 'Hello ' + document.querySelector('#name').value; });
document.querySelector('#history-action').addEventListener('click', () => {
  history.pushState({}, '', '?marker=History%20action');
  document.querySelector('h1').textContent = 'History action';
});
document.querySelector('#navigate-action').addEventListener('click', () => {
  // Let the injected click return before the real document navigation begins.
  setTimeout(() => { location.href = '/?marker=Navigate%20action'; }, 150);
});
document.querySelector('#shadow-host').attachShadow({ mode: 'open' }).innerHTML = '<button aria-label="Shadow action">Shadow action</button>';
document.querySelector('#dialog').addEventListener('click', () => setTimeout(() => alert('e2e-dialog'), 0));
document.querySelector('#indexed-visible').addEventListener('click', () => { out.textContent = 'Indexed visible'; });
console.log('page-ready');
setTimeout(() => {
  document.querySelector('#async-status').textContent = 'Async ready';
  document.querySelector('#delayed-action').style.display = 'block';
  document.querySelector('#ambiguous-a').style.display = 'block';
  document.querySelector('#ambiguous-b').style.display = 'block';
}, 350);
</script>`;
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

function isInstalledGoogleChrome(executable) {
  return /(?:^|[\\/])Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/i.test(String(executable));
}

function waitForExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      child.off("exit", finish);
      child.off("error", finish);
      resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
    timer = setTimeout(finish, timeoutMs);
  });
}

async function stopProcess(child) {
  if (!child?.pid) return;
  await new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.once("close", resolve);
    killer.once("error", resolve);
  });
  await waitForExit(child);
}

async function closeSocket(client) {
  if (!client || client.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    client.once("close", resolve);
    client.close();
  });
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
  if (req.url?.startsWith("/slow")) {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(site);
    }, 400);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(site);
});
await new Promise((resolve, reject) => {
  siteServer.once("error", reject);
  siteServer.listen(0, "127.0.0.1", () => {
    const address = siteServer.address();
    if (!address || typeof address === "string") {
      reject(new Error("E2E site server did not expose a TCP port"));
      return;
    }
    pagePort = address.port;
    resolve();
  });
});
const bridgeProcess = spawnProcess(process.execPath, [bridge, "--port", String(bridgePort), "--token-file", tokenFile, "--started-by", "pi", "--startup-marker", bridgeStartupMarker]);
let edgeProcess;
let socket;
try {
  let bridgeHealth;
  for (let i = 0; i < 50; i++) {
    try {
      if (bridgeProcess.exitCode !== null) throw new Error(`Bridge process exited before binding to port ${bridgePort}; isolated launch failed (exit=${bridgeProcess.exitCode})`);
      bridgeHealth = (await localGet("/health")).body;
      if (bridgeHealth.ok === true && bridgeHealth.startupMarker === bridgeStartupMarker && typeof bridgeHealth.instanceId === "string" && bridgeHealth.instanceId.length > 0) break;
    } catch {}
    await sleep(100);
  }
  assert.equal(bridgeHealth?.ok, true, `Bridge did not become healthy on port ${bridgePort}: ${JSON.stringify(bridgeHealth)}`);
  assert.equal(typeof bridgeHealth.instanceId, "string");
  assert.ok(bridgeHealth.instanceId.length > 0);
   assert.equal(bridgeHealth.startupMarker, bridgeStartupMarker);
   assert.equal(bridgeHealth.startedBy, "pi");

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
    if (edgeProcess.exitCode !== null) throw new Error(`browser process exited before extension handshake; isolated launch may have been delegated (exit=${edgeProcess.exitCode})`);
    try {
      health = (await localGet("/health")).body;
      if (health.extensionConnected) break;
    } catch {}
  }
  if (edgeProcess.exitCode !== null) throw new Error(`browser process exited before extension handshake; isolated launch may have been delegated (exit=${edgeProcess.exitCode})`);
  assert.equal(health?.extensionConnected, true, `${isInstalledGoogleChrome(browserExecutable)
    ? "Installed Google Chrome ignored command-line unpacked-extension loading (Chrome logged that --disable-extensions-except is not allowed). Use Chrome for Testing for this isolated smoke, or manually load extension/ in chrome://extensions for a normal-profile check."
    : "extension did not connect"}: ${JSON.stringify(health)}`);
  assert.equal(health.instanceId, bridgeHealth.instanceId);
  assert.equal(health.port, bridgePort);
  await sleep(1500);

  const token = readFileSync(tokenFile, "utf8").trim();
  socket = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws?role=pi&token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let sequence = 0;
  const request = (method, params = {}) => {
    const requestParams = params.sessionId === undefined ? { ...params, sessionId: "e2e-session" } : params;
     const id = `e2e-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`request timeout: ${method} ${JSON.stringify(params)}`)), 15000);
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "response" || message.id !== id) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        if (message.error) {
          const error = new Error(message.error.message);
          error.code = message.error.code;
          error.details = message.error.details;
          reject(error);
        }
        else resolve(message.result);
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ type: "request", id, method, params: requestParams }));
    });
  };

  const initial = await request("list_tabs");
  assert.ok(initial.tabs.length >= 1);
  const initialCompact = await request("list_tabs", { responseMode: "compact" });
  assert.ok(initialCompact.tabs.length >= 1);
  assert.equal(initialCompact.tabs[0].favicon, undefined);
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
  const orderedNavigation = request("navigate", { tabId: selected.tab.id, url: `http://127.0.0.1:${pagePort}/slow?marker=Ordered%20page`, wait: true, timeoutMs: 5000 });
  const orderedWait = request("wait", { state: "text", text: "Ordered page", exact: true, timeoutMs: 5000 });
  const [, orderedResult] = await Promise.all([orderedNavigation, orderedWait]);
  assert.equal(orderedResult.matched, true);
  await request("navigate", { tabId: selected.tab.id, url: `http://127.0.0.1:${pagePort}/`, wait: true });
  await request("wait", { tabId: selected.tab.id, state: "url", urlIncludes: `127.0.0.1:${pagePort}`, timeoutMs: 5000 });
  const loadingGone = await request("wait", { tabId: selected.tab.id, state: "text_gone", text: "Loading...", timeoutMs: 5000 });
  assert.equal(loadingGone.matched, true);
  const asyncReady = await request("wait", { tabId: selected.tab.id, state: "text", text: "Async ready", exact: true, timeoutMs: 5000 });
  assert.equal(asyncReady.matched, true);
  const exactText = await request("wait", { tabId: selected.tab.id, state: "text", text: "Text target now", exact: true, timeoutMs: 5000 });
  assert.equal(exactText.matched, true);
  const nestedTextTarget = { text: "Disabled nested", exact: true };
  const nestedTextCount = await request("locator", { tabId: selected.tab.id, target: nestedTextTarget, locator: nestedTextTarget, action: "count" });
  assert.equal(nestedTextCount.result, 1);
  const nestedTextAttribute = await request("locator", { tabId: selected.tab.id, target: nestedTextTarget, locator: nestedTextTarget, action: "getAttribute", attribute: "data-probe" });
  assert.equal(nestedTextAttribute.result, null);
  const nestedTextEnabled = await request("locator", { tabId: selected.tab.id, target: nestedTextTarget, locator: nestedTextTarget, action: "isEnabled" });
  assert.equal(nestedTextEnabled.result, false);
  await assert.rejects(() => request("wait", {
    tabId: selected.tab.id,
    state: "enabled",
    target: nestedTextTarget,
    timeoutMs: 400,
  }), /Timed out waiting for page condition enabled/);
  const nestedEditorTarget = { role: "textbox", hasText: "Nested editor", exact: true };
  const nestedEditorCount = await request("locator", { tabId: selected.tab.id, target: nestedEditorTarget, locator: nestedEditorTarget, action: "count" });
  assert.equal(nestedEditorCount.result, 1);
  await request("locator", { tabId: selected.tab.id, target: nestedEditorTarget, locator: nestedEditorTarget, action: "fill", value: "Nested updated", timeoutMs: 5000 });
  const canceledWait = assert.rejects(() => request("wait", {
    tabId: selected.tab.id,
    state: "text",
    text: "Cancellation target never appears",
    sessionId: "cancellation-session",
    timeoutMs: 10000,
  }), /Browser wait aborted by lifecycle cleanup/);
  await sleep(150);
  const cleanupStarted = Date.now();
  const cancellationCleanup = await request("cleanup", { sessionId: "cancellation-session", mode: "task" });
  assert.ok(Date.now() - cleanupStarted < 3000);
  assert.deepEqual(cancellationCleanup.failed, []);
  await canceledWait;
  const delayedVisible = await request("wait", {
    tabId: selected.tab.id,
    state: "visible",
    target: { role: "button", name: "Ready action", exact: true },
    timeoutMs: 5000,
  });
  assert.equal(delayedVisible.matched, true);
  const submitEnabled = await request("wait", {
    tabId: selected.tab.id,
    state: "enabled",
    target: { role: "button", name: "Submit", exact: true },
    timeoutMs: 5000,
  });
  assert.equal(submitEnabled.matched, true);
  assert.equal(submitEnabled.element?.resolvedBy, "chromium_ax");
  const absentHidden = await request("wait", {
    tabId: selected.tab.id,
    state: "hidden",
    target: { text: "Never rendered", exact: true },
    timeoutMs: 5000,
  });
  assert.equal(absentHidden.matched, true);
  await assert.rejects(() => request("wait", {
    tabId: selected.tab.id,
    state: "enabled",
    target: { role: "button", name: "Disabled action", exact: true },
    timeoutMs: 300,
  }), /Timed out waiting for page condition enabled/);
  await sleep(100);
  const staleSnapshot = await request("snapshot", { tabId: selected.tab.id });
  const staleNameInput = staleSnapshot.snapshot.elements.find((element) => element.tag === "input" && element.name === "Name");
  assert.ok(staleNameInput?.ref);
  const compactWireSnapshot = await request("snapshot", { tabId: selected.tab.id, responseMode: "compact" });
  assert.equal(compactWireSnapshot.snapshot.elements, undefined);
  assert.equal(compactWireSnapshot.snapshot.accessibility, undefined);
  assert.equal(compactWireSnapshot.snapshot.text, undefined);
  assert.equal(compactWireSnapshot.frameTree, undefined);
  assert.match(compactWireSnapshot.snapshot.state, /\[ref=/);
  await request("evaluate", { tabId: selected.tab.id, expression: "document.title = 'Pi Control Chrome E2E · observed'; document.querySelector('#async-status').textContent = 'Unrelated UI update'" });
  const resilientFill = await request("interaction", { tabId: selected.tab.id, operation: "fill", ref: staleNameInput.ref, snapshotId: staleSnapshot.snapshot.snapshotId, value: "Live ref" });
  assert.equal(resilientFill.result?.resolvedBy, "original_ref");
  assert.equal(resilientFill.result?.rebound, false);
  const resilientValue = await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#name').value" });
  assert.equal(resilientValue.result?.result?.value, "Live ref");
  await request("evaluate", { tabId: selected.tab.id, expression: "document.title = 'Pi Control Chrome E2E'" });

  // The user may switch from tab_a to an Agent-created tab_b to observe work. That
  // visibility change must not invalidate tab_b's ref while its document is intact.
  const observedTab = await request("new_tab", { url: `http://127.0.0.1:${pagePort}/`, active: false, wait: true, sessionId: "e2e-session" });
  const observedSnapshot = await request("snapshot", { tabId: observedTab.tab.id });
  const observedInput = observedSnapshot.snapshot.elements.find((element) => element.tag === "input" && element.name === "Name");
  assert.ok(observedInput?.ref);
  await request("select_tab", { tabId: observedTab.tab.id });
  await request("evaluate", { tabId: observedTab.tab.id, expression: "document.title = 'Pi Control Chrome E2E · tab_b'; document.querySelector('#async-status').textContent = 'Observed tab update'" });
  const observedFill = await request("interaction", { tabId: observedTab.tab.id, operation: "fill", ref: observedInput.ref, snapshotId: observedSnapshot.snapshot.snapshotId, value: "Visible tab" });
  assert.equal(observedFill.result?.resolvedBy, "original_ref");
  await request("close_tab", { tabId: observedTab.tab.id });
  await assert.rejects(
    () => request("interaction", { tabId: observedTab.tab.id, operation: "fill", ref: observedInput.ref, snapshotId: observedSnapshot.snapshot.snapshotId, value: "must not fill" }),
    (error) => error.code === "BROWSER_TAB_CLOSED",
  );

  // A real document replacement is still a hard boundary: an old observation must
  // never rebind into the newly navigated page.
  const navigationTab = await request("new_tab", { url: `http://127.0.0.1:${pagePort}/`, active: false, wait: true, sessionId: "e2e-session" });
  const navigationSnapshot = await request("snapshot", { tabId: navigationTab.tab.id });
  const navigationInput = navigationSnapshot.snapshot.elements.find((element) => element.tag === "input" && element.name === "Name");
  assert.ok(navigationInput?.ref);
  await request("navigate", { tabId: navigationTab.tab.id, url: `http://127.0.0.1:${pagePort}/?marker=New%20document`, wait: true });
  await assert.rejects(
    () => request("interaction", { tabId: navigationTab.tab.id, operation: "fill", ref: navigationInput.ref, snapshotId: navigationSnapshot.snapshot.snapshotId, value: "must not fill" }),
    (error) => error.code === "BROWSER_DOCUMENT_CHANGED",
  );
  await request("close_tab", { tabId: navigationTab.tab.id });

  // `wait: false` returns before the slow destination has loaded. The old ref
  // must nevertheless be blocked during that loading interval, not merely after
  // a later snapshot observes the destination document.
  const loadingTransitionTab = await request("new_tab", { url: `http://127.0.0.1:${pagePort}/`, active: false, wait: true, sessionId: "e2e-session" });
  const loadingTransitionSnapshot = await request("snapshot", { tabId: loadingTransitionTab.tab.id });
  const loadingTransitionInput = loadingTransitionSnapshot.snapshot.elements.find((element) => element.tag === "input" && element.name === "Name");
  assert.ok(loadingTransitionInput?.ref);
  const loadingTransition = await request("navigate", { tabId: loadingTransitionTab.tab.id, url: `http://127.0.0.1:${pagePort}/slow?marker=Loading%20destination`, wait: false });
  assert.equal(loadingTransition.tab?.transitionPending, true);
  assert.equal(loadingTransition.tab?.handle?.incarnation, undefined);
  assert.equal(loadingTransition.tab?.handle?.url, undefined);
  // Dispatch an action immediately after the response: the transition fallback
  // must already fence the old observation, not rely on an arbitrary delay.
  await assert.rejects(
    () => request("interaction", { tabId: loadingTransitionTab.tab.id, operation: "fill", ref: loadingTransitionInput.ref, snapshotId: loadingTransitionSnapshot.snapshot.snapshotId, value: "must not fill during loading" }),
    (error) => error.code === "BROWSER_DOCUMENT_CHANGED",
  );
  await request("wait", { tabId: loadingTransitionTab.tab.id, state: "load", timeoutMs: 5000 });
  const reloadTransitionSnapshot = await request("snapshot", { tabId: loadingTransitionTab.tab.id });
  const reloadTransitionInput = reloadTransitionSnapshot.snapshot.elements.find((element) => element.tag === "input" && element.name === "Name");
  assert.ok(reloadTransitionInput?.ref);
  await request("reload", { tabId: loadingTransitionTab.tab.id });
  await assert.rejects(
    () => request("interaction", { tabId: loadingTransitionTab.tab.id, operation: "fill", ref: reloadTransitionInput.ref, snapshotId: reloadTransitionSnapshot.snapshot.snapshotId, value: "must not fill during reload" }),
    (error) => error.code === "BROWSER_DOCUMENT_CHANGED",
  );
  await request("wait", { tabId: loadingTransitionTab.tab.id, state: "load", timeoutMs: 5000 });

  // Back and forward are document transitions too. Their own completion response
  // must not leave a window where a ref from the page being left is usable.
  const historyBeforeBack = await request("evaluate", { tabId: loadingTransitionTab.tab.id, expression: "history.length" });
  assert.ok(Number(historyBeforeBack.result?.result?.value) >= 2);
  const backTransitionSnapshot = await request("snapshot", { tabId: loadingTransitionTab.tab.id });
  const backTransitionInput = backTransitionSnapshot.snapshot.elements.find((element) => element.tag === "input" && element.name === "Name");
  assert.ok(backTransitionInput?.ref);
  await request("back", { tabId: loadingTransitionTab.tab.id });
  await assert.rejects(
    () => request("interaction", { tabId: loadingTransitionTab.tab.id, operation: "fill", ref: backTransitionInput.ref, snapshotId: backTransitionSnapshot.snapshot.snapshotId, value: "must not fill after back" }),
    (error) => error.code === "BROWSER_DOCUMENT_CHANGED",
  );
  await request("wait", { tabId: loadingTransitionTab.tab.id, state: "load", timeoutMs: 5000 });
  const forwardTransitionSnapshot = await request("snapshot", { tabId: loadingTransitionTab.tab.id });
  const forwardTransitionInput = forwardTransitionSnapshot.snapshot.elements.find((element) => element.tag === "input" && element.name === "Name");
  assert.ok(forwardTransitionInput?.ref);
  await request("forward", { tabId: loadingTransitionTab.tab.id });
  await assert.rejects(
    () => request("interaction", { tabId: loadingTransitionTab.tab.id, operation: "fill", ref: forwardTransitionInput.ref, snapshotId: forwardTransitionSnapshot.snapshot.snapshotId, value: "must not fill after forward" }),
    (error) => error.code === "BROWSER_DOCUMENT_CHANGED",
  );
  await request("wait", { tabId: loadingTransitionTab.tab.id, state: "load", timeoutMs: 5000 });
  await request("close_tab", { tabId: loadingTransitionTab.tab.id });

  const snapshot = await request("snapshot", { tabId: selected.tab.id });
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
  const projectedSnapshot = compactBrowserResult("browser_snapshot", {}, snapshot);
  const projectedSnapshotBytes = Buffer.byteLength(JSON.stringify(projectedSnapshot));
  assert.ok(projectedSnapshotBytes <= 120_000);
  const input = snapshot.snapshot.elements.find((element) => element.tag === "input");
  const button = snapshot.snapshot.elements.find((element) => element.tag === "button");
  assert.ok(input?.ref);
  assert.ok(button?.ref);
  const accessibilityChildren = snapshot.snapshot.accessibility?.children || [];
  assert.ok(accessibilityChildren.some((node) => node.role === "button"));
  assert.ok(accessibilityChildren.every((node) => !["generic", "group", "listitem"].includes(node.role)));
  assert.ok(accessibilityChildren.length <= 200);
  assert.ok((snapshot.snapshot.accessibility?.charCount || 0) <= 20000);
  assert.ok(snapshot.snapshot.text.length <= 8000);
  assert.equal(JSON.stringify(accessibilityChildren).includes("Repeated generic content"), false);
  const limitedSnapshot = await request("snapshot", { tabId: selected.tab.id, maxChars: 100, maxNodes: 1 });
  assert.ok(limitedSnapshot.snapshot.elements.length <= 1);
  assert.equal(limitedSnapshot.snapshot.truncated, true);
  const scopedSnapshot = await request("snapshot", { tabId: selected.tab.id, selector: "main" });
  assert.ok(scopedSnapshot.snapshot.elements.every((element) => element.name.includes("Text") || element.name.includes("target") || element.name.includes("now")));
  const axFull = await request("snapshot", { tabId: selected.tab.id, accessibilityOnly: true, disableDiffing: true });
  assert.equal(axFull.snapshot.accessibility.mode, "full");
  assert.equal(axFull.snapshot.accessibility.source, "chromium_ax");
  const axName = axFull.snapshot.accessibility.children.find((node) => node.role === "textbox" && node.name === "Name");
  const axSubmit = axFull.snapshot.accessibility.children.find((node) => node.role === "button" && node.name === "Submit");
  const axChoice = axFull.snapshot.accessibility.children.find((node) => node.role === "combobox" && node.name === "Choice");
  const axAgree = axFull.snapshot.accessibility.children.find((node) => node.role === "checkbox" && node.name === "Agree");
  assert.match(axName?.ref || "", /^a\d+$/);
  assert.match(axSubmit?.ref || "", /^a\d+$/);
  assert.match(axChoice?.ref || "", /^a\d+$/);
  assert.match(axAgree?.ref || "", /^a\d+$/);
  assert.equal(JSON.stringify(axFull.snapshot.accessibility).includes("secret-value"), false);
  const axSensitive = axFull.snapshot.accessibility.children.find((node) => node.readonly === true);
  assert.match(axSensitive?.ref || "", /^a\d+$/);
  const axSensitiveValue = await request("locator", { tabId: selected.tab.id, target: { ref: axSensitive.ref }, snapshotId: axFull.snapshot.snapshotId, action: "getAttribute", attribute: "value" });
  assert.equal(axSensitiveValue.result, null);
  const axDisabled = axFull.snapshot.accessibility.children.find((node) => node.role === "button" && node.name === "Disabled action");
  assert.match(axDisabled?.ref || "", /^a\d+$/);
  const axUnchanged = await request("snapshot", { tabId: selected.tab.id, accessibilityOnly: true });
  assert.equal(axUnchanged.snapshot.accessibility.mode, "unchanged");
  assert.equal(JSON.stringify(axUnchanged).includes("secret-value"), false);
  const axWait = await request("wait", { tabId: selected.tab.id, state: "visible", target: { ref: axSubmit.ref }, snapshotId: axFull.snapshot.snapshotId, timeoutMs: 1000 });
  assert.equal(axWait.matched, true);
  const axLocatorText = await request("locator", { tabId: selected.tab.id, target: { ref: axName.ref }, snapshotId: axFull.snapshot.snapshotId, action: "getAttribute", attribute: "placeholder" });
  assert.equal(axLocatorText.result, "Name");
  const axFill = await request("interaction", { tabId: selected.tab.id, operation: "fill", ref: axName.ref, snapshotId: axFull.snapshot.snapshotId, value: "AX value" });
  assert.equal(axFill.result?.resolvedBy, "ax_backend_node");
  assert.equal(axFill.result?.rebound, false);
  const axSelect = await request("locator", { tabId: selected.tab.id, target: { ref: axChoice.ref }, snapshotId: axFull.snapshot.snapshotId, action: "select", value: "two" });
  assert.equal(axSelect.result?.resolvedBy, "ax_backend_node");
  const axCheck = await request("locator", { tabId: selected.tab.id, target: { ref: axAgree.ref }, snapshotId: axFull.snapshot.snapshotId, action: "check" });
  assert.equal(axCheck.result?.resolvedBy, "ax_backend_node");
  const axValue = await request("evaluate", { tabId: selected.tab.id, expression: "({ name: document.querySelector('#name').value, choice: document.querySelector('#choice').value, agree: document.querySelector('#agree').checked })" });
  assert.deepEqual(axValue.result?.result?.value, { name: "AX value", choice: "two", agree: true });
  const axClick = await request("interaction", { tabId: selected.tab.id, operation: "click", ref: axSubmit.ref, snapshotId: axFull.snapshot.snapshotId });
  assert.equal(axClick.result?.resolvedBy, "ax_backend_node");
  assert.equal(axClick.result?.rebound, false);
  await assert.rejects(
    () => request("interaction", { tabId: selected.tab.id, operation: "click", ref: axDisabled.ref, snapshotId: axFull.snapshot.snapshotId }),
    (error) => error?.code === "AX_NODE_DISABLED",
  );
  const axAfterClick = await request("snapshot", { tabId: selected.tab.id });
  assert.match(axAfterClick.snapshot.text, /Hello AX value/);
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#aria-label-button').setAttribute('aria-label', 'Changed accessibility')" });
  const axDiff = await request("snapshot", { tabId: selected.tab.id, accessibilityOnly: true });
  assert.equal(axDiff.snapshot.accessibility.mode, "diff");
  assert.match(axDiff.snapshot.accessibility.state, /Changed accessibility/);
  assert.equal(JSON.stringify(axDiff).includes("secret-value"), false);
  const axScoped = await request("snapshot", { tabId: selected.tab.id, accessibilityOnly: true, selector: "main", disableDiffing: true });
  assert.equal(axScoped.snapshot.accessibility.source, "chromium_ax");
  assert.ok(axScoped.snapshot.accessibility.children.some((node) => node.role === "button" && node.ref));
  const compactAx = await request("snapshot", { tabId: selected.tab.id, accessibilityOnly: true, disableDiffing: true, responseMode: "compact" });
  assert.equal(compactAx.children, undefined);
  assert.equal(compactAx.snapshot, undefined);
  assert.equal(typeof compactAx.state, "string");
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#aria-label-button').setAttribute('aria-label', 'Labelled action')" });
  const actionSnapshot = await request("snapshot", { tabId: selected.tab.id });
  const actionInput = actionSnapshot.snapshot.elements.find((element) => element.tag === "input");
  assert.ok(actionInput?.ref);
  const extracted = await request("extract", { tabId: selected.tab.id });
  const compactWireExtract = await request("extract", { tabId: selected.tab.id, responseMode: "compact" });
  assert.equal(compactWireExtract.content.text.length <= 12000, true);
  assert.equal(compactWireExtract.content.markdown.length <= 12000, true);
  assert.equal(compactWireExtract.frameTree, undefined);

  assert.match(extracted.content.text, /Pi Control Chrome E2E/);
  assert.ok(extracted.content.text.length <= 12000);
  assert.ok(extracted.content.markdown.length <= 12000);
  await request("interaction", { tabId: selected.tab.id, operation: "fill", ref: actionInput.ref, snapshotId: actionSnapshot.snapshot.snapshotId, value: "Pi" });
  const afterFillSnapshot = await request("snapshot", { tabId: selected.tab.id });
  const afterFillButton = afterFillSnapshot.snapshot.elements.find((element) => element.tag === "button");
  await request("interaction", { tabId: selected.tab.id, operation: "click", ref: afterFillButton.ref, snapshotId: afterFillSnapshot.snapshot.snapshotId });
  const after = await request("snapshot", { tabId: selected.tab.id });
  assert.match(after.snapshot.text, /Hello Pi/);

  // The click result is known once the injected page action returns. A valid
  // post-action document identity (including a history URL transition) must
  // therefore preserve success rather than misreporting an uncertain effect.
  const historyAction = await request("interaction", {
    tabId: selected.tab.id,
    operation: "click",
    target: { role: "button", name: "History action", exact: true },
  });
  assert.equal(historyAction.result?.ok, true);
  assert.equal(historyAction.result?.postActionDocumentChanged, true);
  await request("wait", { tabId: selected.tab.id, state: "url", urlIncludes: "marker=History%20action", timeoutMs: 5000 });
  await request("navigate", { tabId: selected.tab.id, url: `http://127.0.0.1:${pagePort}/`, wait: true });

  // A known-dispatched click is successful when it returns before a later real
  // navigation becomes observable. The later navigation is verified separately;
  // it must not retroactively turn the completed click into an uncertain result.
  const knownDispatchTab = await request("new_tab", { url: `http://127.0.0.1:${pagePort}/`, active: false, wait: true, sessionId: "e2e-session" });
  const navigateAction = await request("interaction", {
    tabId: knownDispatchTab.tab.id,
    operation: "click",
    target: { role: "button", name: "Navigate action", exact: true },
  });
  assert.equal(navigateAction.result?.ok, true);
  await request("wait", { tabId: knownDispatchTab.tab.id, state: "url", urlIncludes: "marker=Navigate%20action", timeoutMs: 5000 });
  await request("close_tab", { tabId: knownDispatchTab.tab.id });

  const rebindSnapshot = await request("snapshot", { tabId: selected.tab.id });
  const rebindInput = rebindSnapshot.snapshot.elements.find((element) => element.tag === "input" && element.name === "Name");
  assert.ok(rebindInput?.ref);
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#name').outerHTML = '<input id=\"name\" placeholder=\"Name\">'" });
  const reboundFill = await request("interaction", { tabId: selected.tab.id, operation: "fill", ref: rebindInput.ref, snapshotId: rebindSnapshot.snapshot.snapshotId, value: "Rebound" });
  assert.equal(reboundFill.result?.resolvedBy, "semantic_rebind");
  assert.equal(reboundFill.result?.rebound, true);
  const reboundValue = await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#name').value" });
  assert.equal(reboundValue.result?.result?.value, "Rebound");
  // A single observation can make only one controlled hop. A second framework
  // replacement must require a new snapshot rather than silently redirect again.
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#name').outerHTML = '<input id=\"name\" placeholder=\"Name\">'" });
  await assert.rejects(
    () => request("interaction", { tabId: selected.tab.id, operation: "fill", ref: rebindInput.ref, snapshotId: rebindSnapshot.snapshot.snapshotId, value: "must not rebind twice" }),
    (error) => error.code === "ELEMENT_TARGET_DETACHED" && error.details?.reason === "rebind_already_used",
  );

  // Replacement is deliberately fail-closed when a formerly unique semantic field
  // becomes ambiguous, and when it is removed without an equivalent replacement.
  await request("evaluate", { tabId: selected.tab.id, expression: "(() => { const host = document.createElement('div'); host.id = 'rebind-ambiguous-host'; host.innerHTML = '<label>Rebind ambiguity <input placeholder=\"Rebind ambiguity\"></label>'; document.body.append(host); })()" });
  const ambiguousRebindSnapshot = await request("snapshot", { tabId: selected.tab.id });
  const ambiguousRebindInput = ambiguousRebindSnapshot.snapshot.elements.find((element) => element.tag === "input" && element.name === "Rebind ambiguity");
  assert.ok(ambiguousRebindInput?.ref);
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#rebind-ambiguous-host').innerHTML = '<label>Rebind ambiguity <input placeholder=\"Rebind ambiguity\"></label><label>Rebind ambiguity <input placeholder=\"Rebind ambiguity\"></label>'" });
  await assert.rejects(
    () => request("interaction", { tabId: selected.tab.id, operation: "fill", ref: ambiguousRebindInput.ref, snapshotId: ambiguousRebindSnapshot.snapshot.snapshotId, value: "must not choose" }),
    (error) => error.code === "ELEMENT_TARGET_AMBIGUOUS" && error.details?.count === 2,
  );
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#rebind-ambiguous-host').remove()" });

  await request("evaluate", { tabId: selected.tab.id, expression: "(() => { const host = document.createElement('div'); host.id = 'rebind-detached-host'; host.innerHTML = '<label>Rebind detached <input placeholder=\"Rebind detached\"></label>'; document.body.append(host); })()" });
  const detachedRebindSnapshot = await request("snapshot", { tabId: selected.tab.id });
  const detachedRebindInput = detachedRebindSnapshot.snapshot.elements.find((element) => element.tag === "input" && element.name === "Rebind detached");
  assert.ok(detachedRebindInput?.ref);
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#rebind-detached-host').remove()" });
  await assert.rejects(
    () => request("interaction", { tabId: selected.tab.id, operation: "fill", ref: detachedRebindInput.ref, snapshotId: detachedRebindSnapshot.snapshot.snapshotId, value: "must not fill" }),
    (error) => error.code === "ELEMENT_TARGET_DETACHED",
  );

  // A scoped ref cannot consume its one rebind on an equivalent control outside
  // that scope. The later in-scope replacement must remain the only eligible hop.
  await request("evaluate", { tabId: selected.tab.id, expression: "(() => { const left = document.createElement('div'); left.id = 'scoped-rebind-left'; left.innerHTML = '<label>Scoped rebind <input placeholder=\"Scoped rebind\"></label>'; const right = document.createElement('div'); right.id = 'scoped-rebind-right'; document.body.append(left, right); })()" });
  const scopedRebindSnapshot = await request("snapshot", { tabId: selected.tab.id, selector: "#scoped-rebind-left" });
  const scopedRebindInput = scopedRebindSnapshot.snapshot.elements.find((element) => element.tag === "input" && element.name === "Scoped rebind");
  assert.ok(scopedRebindInput?.ref);
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#scoped-rebind-left').innerHTML = ''; document.querySelector('#scoped-rebind-right').innerHTML = '<label>Scoped rebind <input placeholder=\"Scoped rebind\"></label>'" });
  await assert.rejects(
    () => request("interaction", { tabId: selected.tab.id, operation: "fill", snapshotId: scopedRebindSnapshot.snapshot.snapshotId, target: { ref: scopedRebindInput.ref, scopeSelector: "#scoped-rebind-left" }, value: "must not escape scope" }),
    (error) => error.code === "ELEMENT_TARGET_DETACHED",
  );
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#scoped-rebind-left').innerHTML = '<label>Scoped rebind <input placeholder=\"Scoped rebind\"></label>'" });
  const scopedReboundFill = await request("interaction", { tabId: selected.tab.id, operation: "fill", snapshotId: scopedRebindSnapshot.snapshot.snapshotId, target: { ref: scopedRebindInput.ref, scopeSelector: "#scoped-rebind-left" }, value: "Scoped winner" });
  assert.equal(scopedReboundFill.result?.resolvedBy, "semantic_rebind");
  const scopedValues = await request("evaluate", { tabId: selected.tab.id, expression: "JSON.stringify([document.querySelector('#scoped-rebind-left input').value, document.querySelector('#scoped-rebind-right input').value])" });
  assert.deepEqual(JSON.parse(scopedValues.result?.result?.value), ["Scoped winner", ""]);
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#scoped-rebind-left').remove(); document.querySelector('#scoped-rebind-right').remove()" });

  // A node that remains connected but changes its own semantic identity is not a
  // framework replacement and must never be rebound to another target.
  await request("evaluate", { tabId: selected.tab.id, expression: "(() => { const host = document.createElement('div'); host.id = 'changed-ref-host'; host.innerHTML = '<button id=\"changed-ref-button\">Original action</button>'; document.body.append(host); })()" });
  const changedRefSnapshot = await request("snapshot", { tabId: selected.tab.id });
  const changedRefButton = changedRefSnapshot.snapshot.elements.find((element) => element.tag === "button" && element.name === "Original action");
  assert.ok(changedRefButton?.ref);
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#changed-ref-button').textContent = 'Changed action'" });
  await assert.rejects(
    () => request("interaction", { tabId: selected.tab.id, operation: "click", ref: changedRefButton.ref, snapshotId: changedRefSnapshot.snapshot.snapshotId }),
    (error) => error.code === "ELEMENT_TARGET_NOT_FOUND" && error.details?.reason === "original_target_changed",
  );
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#changed-ref-host').remove()" });

  const semanticFill = await request("interaction", {
    tabId: selected.tab.id,
    operation: "fill",
    target: { label: "Name", exact: true },
    value: "Semantic",
    timeoutMs: 5000,
  });
  assert.equal(semanticFill.result?.element?.tag, "input");
  const semanticInput = await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#name').value" });
  assert.equal(semanticInput.result?.result?.value, "Semantic");
  const semanticClick = await request("interaction", {
    tabId: selected.tab.id,
    operation: "click",
    target: { role: "button", name: "Submit", exact: true },
    timeoutMs: 5000,
  });
  assert.equal(semanticClick.result?.resolvedBy, "chromium_ax");
  const semanticAfter = await request("snapshot", { tabId: selected.tab.id });
  assert.match(semanticAfter.snapshot.text, /Hello Semantic/);
  await assert.rejects(() => request("interaction", {
    tabId: selected.tab.id,
    operation: "click",
    target: { role: "button", name: "Ambiguous", exact: true },
    timeoutMs: 1000,
  }), (error) => {
    assert.ok(["ELEMENT_TARGET_AMBIGUOUS", "AX_NODE_AMBIGUOUS"].includes(error.code));
    assert.equal(error.details?.count, 2);
    return true;
  });
  const indexedTarget = { text: "Indexed action", exact: true, index: 0 };
  const indexedVisible = await request("wait", { tabId: selected.tab.id, state: "visible", target: indexedTarget, timeoutMs: 1000 });
  assert.equal(indexedVisible.matched, true);
  await request("interaction", { tabId: selected.tab.id, operation: "click", target: indexedTarget, timeoutMs: 1000 });
  const indexedInteraction = await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#out').textContent" });
  assert.equal(indexedInteraction.result?.result?.value, "Indexed visible");
  await request("locator", { tabId: selected.tab.id, target: indexedTarget, locator: indexedTarget, action: "click", timeoutMs: 1000 });
  const indexedLocator = await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#out').textContent" });
  assert.equal(indexedLocator.result?.result?.value, "Indexed visible");
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
  const semanticAriaLabelledByCount = await request("locator", {
    tabId: selected.tab.id,
    locator: { role: "button", name: "Accessible action", exact: true },
    action: "count",
  });
  assert.equal(semanticAriaLabelledByCount.result, 1);
  const semanticAriaLabelCount = await request("locator", {
    tabId: selected.tab.id,
    locator: { role: "button", name: "Labelled action", exact: true },
    action: "count",
  });
  assert.equal(semanticAriaLabelCount.result, 1);
  const semanticEmailFill = await request("interaction", {
    tabId: selected.tab.id,
    operation: "fill",
    target: { label: "Email", exact: true },
    value: "email@example.test",
    timeoutMs: 5000,
  });
  assert.equal(semanticEmailFill.result?.element?.tag, "input");
  assert.equal(semanticEmailFill.result?.resolvedBy, "chromium_ax");
  const semanticEmail = await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#email').value" });
  assert.equal(semanticEmail.result?.result?.value, "email@example.test");
  const semanticLabelCount = await request("locator", {
    tabId: selected.tab.id,
    locator: { label: "Name", exact: true },
    action: "count",
  });
  assert.equal(semanticLabelCount.result, 1);
  const textLocator = { text: "Text target now", exact: true };
  const textLocatorCount = await request("locator", { tabId: selected.tab.id, target: textLocator, locator: textLocator, action: "count" });
  assert.equal(textLocatorCount.result, 1);
  const textLocatorClick = await request("locator", { tabId: selected.tab.id, target: textLocator, locator: textLocator, action: "click", timeoutMs: 5000 });
  assert.equal(textLocatorClick.result?.element?.tag, "button");
  assert.equal(textLocatorClick.result?.resolvedBy, "chromium_ax");
  const ariaLocator = { role: "button", name: "Labelled action", exact: true };
  const ariaLocatorClick = await request("locator", { tabId: selected.tab.id, target: ariaLocator, locator: ariaLocator, action: "click", timeoutMs: 5000 });
  assert.equal(ariaLocatorClick.result?.element?.tag, "button");
  assert.equal(ariaLocatorClick.result?.resolvedBy, "chromium_ax");
  // The DOM semantic collector does not pierce a shadow tree; the
  // AX-first path still resolves the real Chromium-computed button identity.
  const shadowTarget = { role: "button", name: "Shadow action", exact: true };
  const domShadowCount = await request("locator", { tabId: selected.tab.id, locator: { strategy: "css", value: "#shadow-host button" }, action: "count", timeoutMs: 1000 });
  assert.equal(domShadowCount.result, 0);
  const shadowCount = await request("locator", { tabId: selected.tab.id, target: shadowTarget, locator: shadowTarget, action: "count", timeoutMs: 5000 });
  assert.equal(shadowCount.result, 1);
  const shadowClick = await request("locator", { tabId: selected.tab.id, target: shadowTarget, locator: shadowTarget, action: "click", timeoutMs: 5000 });
  assert.equal(shadowClick.result?.resolvedBy, "chromium_ax");
  assert.equal(shadowClick.result?.element?.tag, "button");
  const frameTarget = { role: "button", name: "Frame action", exact: true };
  const domFrameCount = await request("locator", { tabId: selected.tab.id, locator: { strategy: "css", value: "#semantic-frame button" }, action: "count", timeoutMs: 1000 });
  assert.equal(domFrameCount.result, 0);
  const frameCount = await request("locator", { tabId: selected.tab.id, target: frameTarget, locator: frameTarget, action: "count", timeoutMs: 5000 });
  assert.equal(frameCount.result, 1);
  const frameClick = await request("locator", { tabId: selected.tab.id, target: frameTarget, locator: frameTarget, action: "click", timeoutMs: 5000 });
  assert.equal(frameClick.result?.resolvedBy, "chromium_ax");
  const comboTarget = { role: "combobox", name: "Custom choice", exact: true };
  const combo = await request("locator", { tabId: selected.tab.id, target: comboTarget, locator: comboTarget, action: "click", timeoutMs: 5000 });
  assert.equal(combo.result?.resolvedBy, "chromium_ax");
  assert.equal(combo.result?.element?.expanded, false);
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#shadow-host').shadowRoot.innerHTML = '<button>Shadow action</button>'" });
  const shadowRedraw = await request("locator", { tabId: selected.tab.id, target: shadowTarget, locator: shadowTarget, action: "click", timeoutMs: 5000 });
  assert.equal(shadowRedraw.result?.resolvedBy, "chromium_ax");
  // Hidden/disabled semantics are read from AX first, then checked against the
  // current DOM object before any side effect is dispatched.
  const hiddenLocator = { role: "button", name: "Hidden action", exact: true };
  await assert.rejects(() => request("locator", { tabId: selected.tab.id, target: hiddenLocator, locator: hiddenLocator, action: "click", timeoutMs: 300 }), /(?:No matching Chromium accessibility node|No visible Chromium accessibility node|Timed out waiting for visible element target)/);
  const disabledLocator = { role: "button", name: "Disabled action", exact: true };
  await assert.rejects(() => request("locator", { tabId: selected.tab.id, target: disabledLocator, locator: disabledLocator, action: "click", timeoutMs: 300 }), /(?:The accessibility node is disabled|Element target is disabled)/);
  const readonlyLocator = { selector: "#readonly" };
  await assert.rejects(() => request("locator", { tabId: selected.tab.id, target: readonlyLocator, locator: readonlyLocator, action: "fill", value: "changed", timeoutMs: 5000 }), /Element target is not editable/);
  const ambiguousLocatorTarget = { role: "button", name: "Ambiguous", exact: true };
  await assert.rejects(() => request("locator", { tabId: selected.tab.id, target: ambiguousLocatorTarget, locator: ambiguousLocatorTarget, action: "click", timeoutMs: 1000 }), (error) => {
    assert.ok(["ELEMENT_TARGET_AMBIGUOUS", "AX_NODE_AMBIGUOUS"].includes(error.code));
    assert.equal(error.details?.count, 2);
    return true;
  });
  const editorFill = await request("interaction", { tabId: selected.tab.id, operation: "fill", target: { label: "Editor", exact: true }, value: "Editable", timeoutMs: 5000 });
  assert.equal(editorFill.result?.element?.tag, "div");
  assert.equal(editorFill.result?.resolvedBy, "chromium_ax");
  const editorValue = await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#editor').textContent" });
  assert.equal(editorValue.result?.result?.value, "Editable");
  assert.equal(semanticLabelCount.result, 1);
  const semanticTestIdCount = await request("locator", {
    tabId: selected.tab.id,
    locator: { testId: "submit-button" },
    action: "count",
  });
  assert.equal(semanticTestIdCount.result, 1);
  const filteredLocator = await request("locator", {
    tabId: selected.tab.id,
    locator: { strategy: "css", value: "label" },
    action: "filter",
    hasSelector: "input",
  });
  assert.equal(filteredLocator.result.hasSelector, "input");
  const filteredCount = await request("locator", { tabId: selected.tab.id, locator: filteredLocator.result, action: "count" });
  assert.equal(filteredCount.result, 2);
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

  const staleVisibleDom = await request("dom_cua", { tabId: selected.tab.id, action: "get_visible_dom" });
  const staleDomButton = staleVisibleDom.dom.nodes.find((node) => node.tag === "button" && node.text.includes("Submit"));
  assert.ok(staleDomButton?.node_id);
  await request("evaluate", { tabId: selected.tab.id, expression: "document.title = 'Pi Control Chrome E2E · DOM observed'; document.querySelector('#async-status').textContent = 'Another unrelated UI update'" });
  const resilientDomClick = await request("dom_cua", { tabId: selected.tab.id, action: "click", nodeId: staleDomButton.node_id, snapshotId: staleVisibleDom.dom.snapshotId });
  assert.equal(resilientDomClick.result?.resolvedBy, "original_node");
  await request("evaluate", { tabId: selected.tab.id, expression: "document.title = 'Pi Control Chrome E2E'" });
  const visibleDom = await request("dom_cua", { tabId: selected.tab.id, action: "get_visible_dom" });
  const domButton = visibleDom.dom.nodes.find((node) => node.tag === "button" && node.text.includes("Submit"));
  assert.ok(domButton?.node_id);
  await request("dom_cua", { tabId: selected.tab.id, action: "click", nodeId: domButton.node_id, snapshotId: visibleDom.dom.snapshotId });
  const freshDom = await request("dom_cua", { tabId: selected.tab.id, action: "get_visible_dom" });
  const freshButton = freshDom.dom.nodes.find((node) => node.tag === "button" && node.text.includes("Submit"));
  assert.ok(freshButton?.node_id);
  await assert.rejects(() => request("dom_cua", { tabId: selected.tab.id, action: "type", nodeId: freshButton.node_id, snapshotId: freshDom.dom.snapshotId, value: "invalid" }), /not editable/);
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#go').textContent = 'Changed Submit'" });
  await assert.rejects(
    () => request("dom_cua", { tabId: selected.tab.id, action: "click", nodeId: freshButton.node_id, snapshotId: freshDom.dom.snapshotId }),
    (error) => error.code === "DOM_NODE_NOT_FOUND" && error.details?.reason === "original_target_changed",
  );
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#go').textContent = 'Submit'" });

  // DOM-CUA node ids follow the same one-hop rule as semantic snapshot refs.
  await request("evaluate", { tabId: selected.tab.id, expression: "(() => { const host = document.createElement('div'); host.id = 'dom-rebind-host'; host.innerHTML = '<button id=\"dom-rebind-button\">DOM rebind</button>'; document.body.append(host); })()" });
  const domRebindSnapshot = await request("dom_cua", { tabId: selected.tab.id, action: "get_visible_dom" });
  const domRebindButton = domRebindSnapshot.dom.nodes.find((node) => node.tag === "button" && node.text.includes("DOM rebind"));
  assert.ok(domRebindButton?.node_id);
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#dom-rebind-button').outerHTML = '<button id=\"dom-rebind-button\">DOM rebind</button>'" });
  const domReboundClick = await request("dom_cua", { tabId: selected.tab.id, action: "click", nodeId: domRebindButton.node_id, snapshotId: domRebindSnapshot.dom.snapshotId });
  assert.equal(domReboundClick.result?.resolvedBy, "semantic_rebind");
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#dom-rebind-button').outerHTML = '<button id=\"dom-rebind-button\">DOM rebind</button>'" });
  await assert.rejects(
    () => request("dom_cua", { tabId: selected.tab.id, action: "click", nodeId: domRebindButton.node_id, snapshotId: domRebindSnapshot.dom.snapshotId }),
    (error) => error.code === "DOM_NODE_NOT_FOUND" && error.details?.reason === "rebind_already_used",
  );
  await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#dom-rebind-host').remove()" });

  const compactVisibleDom = await request("dom_cua", { tabId: selected.tab.id, action: "get_visible_dom", responseMode: "compact" });
  assert.equal(compactVisibleDom.dom.nodes, undefined);
  assert.equal(typeof compactVisibleDom.dom.state, "string");
  assert.equal(typeof compactVisibleDom.dom.snapshotId, "string");
  // Coordinate input is viewport-relative, so take a current layout observation and
  // foreground the isolated test tab before sending native mouse/keyboard events.
  const cuaSnapshot = await request("snapshot", { tabId: selected.tab.id });
  const cuaInput = cuaSnapshot.snapshot.elements.find((element) => element.tag === "input" && element.name === "Name");
  assert.ok(cuaInput?.rect);
  await request("select_tab", { tabId: selected.tab.id });
  await request("cua", {
    tabId: selected.tab.id,
    action: "click",
    x: cuaInput.rect.x + Math.max(1, cuaInput.rect.width / 2),
    y: cuaInput.rect.y + Math.max(1, cuaInput.rect.height / 2),
  });
  await request("cua", { tabId: selected.tab.id, action: "type", text: " CUA" });
  const cuaValue = await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#name').value" });
  assert.match(cuaValue.result?.result?.value, /CUA/);

  await request("devtools_enable", { tabId: selected.tab.id, domains: ["Runtime", "Log", "Network", "Page"] });
  await request("evaluate", { tabId: selected.tab.id, expression: "console.error('e2e-console'); fetch('/api/data')", awaitPromise: true });
  await sleep(1200);
  const consoleLogs = await request("console_logs", { tabId: selected.tab.id });
  assert.ok(consoleLogs.logs.some((entry) => String(entry.text).includes("e2e-console")));
  const network = await request("network_requests", { tabId: selected.tab.id });
  const apiResponse = network.requests.find((entry) => entry.event === "response" && entry.url.endsWith("/api/data") && entry.status === 200);
  assert.ok(apiResponse?.requestId);
  const responseBody = await request("network_response_body", { tabId: selected.tab.id, requestId: apiResponse.requestId, loaderId: apiResponse.loaderId });
  assert.match(responseBody.result?.body || "", /pi-control-chrome|e2e/);

  await request("evaluate", { tabId: selected.tab.id, expression: "setTimeout(()=>alert('e2e-dialog'),100); 'scheduled'" });
  await sleep(1200);
  let dialog;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    dialog = await request("dialog", { tabId: selected.tab.id, action: "get" });
    if (dialog.dialog?.message === "e2e-dialog") break;
    await sleep(100);
  }

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
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => request("new_tab", { url: `http://127.0.0.1:${pagePort}/`, active: false, sessionId: "e2e-concurrent" })));
  const concurrentIds = concurrent.map((entry) => entry.tab.id);
  const concurrentListed = await request("list_tabs");
  assert.equal(concurrentIds.filter((id) => concurrentListed.tabs.some((tab) => tab.id === id && tab.owner === "agent")).length, concurrentIds.length);
  const concurrentCleanup = await request("cleanup", { sessionId: "e2e-concurrent", mode: "task" });
  assert.deepEqual([...concurrentCleanup.removed].sort((left, right) => left - right), [...concurrentIds].sort((left, right) => left - right));
  await sleep(700);
  const listed = await request("list_tabs");
  assert.ok(listed.browserId);
  assert.ok(typeof listed.profile === "string" && listed.profile.length > 0);
  assert.ok(listed.tabs[0].handle?.tabId !== undefined);
  const owned = listed.tabs.find((tab) => tab.id === created.tab.id);
  assert.equal(owned.owner, "agent");
  assert.equal(owned.lifecycle, "temporary");
  const group = listed.groups.find((item) => item.id === owned.groupId);
  assert.equal(group.title, "Pi");
  assert.equal(group.color, "blue");

  await assert.rejects(() => request("close_tab", { tabId: created.tab.id, sessionId: "other-session" }), /another Agent session/);
  await assert.rejects(() => request("mark_handoff", { tabId: created.tab.id, sessionId: "other-session", turnId: 1 }), /another Agent session/);
  await assert.rejects(() => request("release", { tabId: selected.tab.id, sessionId: "other-session" }), /another Agent session/);
  await request("mark_handoff", { tabId: created.tab.id, sessionId: "e2e-session", turnId: 1 });
  const temporary = await request("new_tab", { url: `http://127.0.0.1:${pagePort}/`, active: false, sessionId: "e2e-session" });
  await sleep(300);
  const temporaryListed = await request("list_tabs");
  const temporaryOwned = temporaryListed.tabs.find((tab) => tab.id === temporary.tab.id);
  const temporaryGroup = temporaryListed.groups.find((item) => item.id === temporaryOwned.groupId);
  assert.equal(temporaryOwned.groupId, group.id);
  assert.equal(temporaryGroup.title, "Pi");
  assert.equal(temporaryGroup.color, "blue");
  const cleanup = await request("cleanup", { sessionId: "e2e-session", mode: "turn", turnId: 1, expectedBrowserId: listed.browserId });
  assert.equal(cleanup.removed.includes(created.tab.id), false);
  assert.equal(cleanup.removed.includes(temporary.tab.id), true);
  assert.equal(cleanup.released.includes(selected.tab.id), true);
  const staleMarkCleanup = await request("cleanup", { sessionId: "e2e-session", mode: "turn", turnId: 2, expectedBrowserId: listed.browserId });
  assert.equal(staleMarkCleanup.removed.includes(created.tab.id), true);

  await closeSocket(socket);
  console.log(JSON.stringify({
    passed: true,
    initialTabs: initial.tabs.length,
    selectedTab: selected.tab.id,
    refs: { input: input.ref, button: button.ref },
    claimedTab: claimed.claimed.id,
    screenshotBytes: Buffer.from(screenshot.data, "base64").length,
    snapshotBytes,
    projectedSnapshotBytes,
    pageBytes: Buffer.byteLength(site),
    group,
    cleanup,
    staleMarkCleanup,
  }));
} finally {
  await closeSocket(socket);
  await new Promise((resolve) => siteServer.close(resolve));
  await stopProcess(edgeProcess);
  await stopProcess(bridgeProcess);
  try { rmSync(temp, { recursive: true, force: true }); } catch {}
}
