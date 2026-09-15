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
<label for="press-target">Press target</label><input id="press-target" aria-label="Press target" placeholder="Press target">
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
<button id="probe-error" type="button">Probe console error</button>
<button id="probe-pageerror" type="button">Probe page error</button>
<button id="probe-remove" type="button">Probe remove</button>
<button id="probe-async" type="button">Probe async</button><span id="probe-status">Idle</span>
<button id="probe-stable" type="button">Probe stable</button>
<button id="disabled-action" disabled>Disabled action</button>
<button id="disabled-nested" disabled data-probe="disabled-button"><span>Disabled nested</span></button>
<div id="nested-editor" contenteditable><span>Nested editor</span></div>
<div id="shadow-host"></div>
<section aria-labelledby="complex-heading"><h2 id="complex-heading">Complex labels</h2><span id="complex-action-label">Approve</span><span id="complex-context">invoice 42</span><span id="complex-state">ready</span><button id="complex-action" aria-labelledby="complex-action-label complex-context complex-state">Fallback name</button></section>
<label for="native-choice">Native choice</label><select id="native-choice"><option value="red">Red</option><option value="blue">Blue</option></select>
<label><input id="native-agreement" type="checkbox"> Native agreement</label>
<section aria-labelledby="react-heading"><h2 id="react-heading">React-style redraw</h2><div id="react-root"></div></section>
<section aria-labelledby="vue-heading"><h2 id="vue-heading">Vue-style redraw</h2><div id="vue-root"></div></section>
<section aria-labelledby="virtual-heading"><h2 id="virtual-heading">Virtual list</h2><div id="virtual-list" role="listbox" aria-label="Virtual results"></div><button id="virtual-next">Next virtual page</button></section>
<div id="custom-switch" role="switch" aria-label="Custom switch" aria-checked="false" tabindex="0">Custom switch</div>
<div id="custom-combobox" role="combobox" aria-label="Custom choice" aria-expanded="false" tabindex="0">Choose</div>
<iframe id="semantic-frame" title="Semantic frame" srcdoc="<!doctype html><button aria-label='Frame action'>Frame action</button>"></iframe>
<iframe id="cross-origin-frame" title="Cross origin semantic frame" src="__CROSS_ORIGIN_FRAME_URL__"></iframe>
<iframe id="oopif-frame" title="OOPIF semantic frame" src="__OOPIF_FRAME_URL__"></iframe>
<button id="ambiguous-a">Ambiguous</button><button id="ambiguous-b">Ambiguous</button>
<button id="indexed-hidden">Indexed action</button><button id="indexed-visible">Indexed action</button>
<div id="out"></div>
<div id="large-generic-page">${largeGenericPage}</div>
<script>
const marker = new URLSearchParams(location.search).get('marker');
if (marker) document.querySelector('h1').textContent = marker;
if (marker === 'reload-status') {
  const navigation = performance.getEntriesByType('navigation')[0];
  document.querySelector('#async-status').textContent = navigation?.type === 'reload' ? 'Reload ready' : 'Waiting for reload';
}
const out = document.querySelector('#out');
document.querySelector('#go').addEventListener('click', () => { out.textContent = 'Hello ' + document.querySelector('#name').value; });
document.querySelector('#press-target').addEventListener('keydown', event => { out.textContent = 'Pressed ' + event.key; });
document.querySelector('#history-action').addEventListener('click', () => {
  history.pushState({}, '', '?marker=History%20action');
  document.querySelector('h1').textContent = 'History action';
});
document.querySelector('#navigate-action').addEventListener('click', () => {
  // Let the injected click return before the real document navigation begins.
  setTimeout(() => { location.href = '/?marker=Navigate%20action'; }, 150);
});
document.querySelector('#shadow-host').attachShadow({ mode: 'open' }).innerHTML = '<button aria-label="Shadow action">Shadow action</button>';
const makeReactButton = (name) => { const button = document.createElement('button'); button.id = 'react-action'; button.setAttribute('aria-label', name); button.textContent = name; button.addEventListener('click', () => button.replaceWith(makeReactButton('React save ready'))); return button; };
const makeVueButton = (name) => { const button = document.createElement('div'); button.id = 'vue-action'; button.setAttribute('role', 'button'); button.setAttribute('aria-label', name); button.tabIndex = 0; button.textContent = name; button.addEventListener('click', () => button.replaceWith(makeVueButton('Vue action ready'))); return button; };
document.querySelector('#react-root').replaceChildren(makeReactButton('React save'));
document.querySelector('#vue-root').replaceChildren(makeVueButton('Vue action'));
let virtualPage = 0;
const renderVirtual = () => { const list = document.querySelector('#virtual-list'); const start = virtualPage * 3; list.replaceChildren(...Array.from({ length: 3 }, (_, offset) => { const option = document.createElement('div'); option.setAttribute('role', 'option'); option.textContent = 'Virtual row ' + (start + offset + 1); return option; })); };
renderVirtual();
document.querySelector('#virtual-next').addEventListener('click', () => { virtualPage += 1; renderVirtual(); });
document.querySelector('#custom-switch').addEventListener('click', (event) => event.currentTarget.setAttribute('aria-checked', String(event.currentTarget.getAttribute('aria-checked') !== 'true')));
document.querySelector('#custom-combobox').addEventListener('click', (event) => event.currentTarget.setAttribute('aria-expanded', String(event.currentTarget.getAttribute('aria-expanded') !== 'true')));
document.querySelector('#dialog').addEventListener('click', () => setTimeout(() => alert('e2e-dialog'), 0));
document.querySelector('#probe-error').addEventListener('click', () => { console.error('probe-console-error'); });
document.querySelector('#probe-pageerror').addEventListener('click', () => setTimeout(() => { throw new Error('probe-page-error'); }, 0));
document.querySelector('#probe-remove').addEventListener('click', event => event.currentTarget.remove());
document.querySelector('#probe-async').addEventListener('click', () => setTimeout(() => { document.querySelector('#probe-status').textContent = 'Probe async ready'; }, 120));
document.querySelector('#probe-stable').addEventListener('click', () => { document.querySelector('#probe-status').textContent = 'Probe stable ready'; });
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

function spawnProcess(command, args, options = {}) {
  if (options.captureStderr !== true) return spawn(command, args, { stdio: "ignore", windowsHide: true });
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  // The isolated browser is the only component here that reports nothing
  // through the Bridge, so keep a bounded tail of its stderr: an extension
  // load failure and a slow handshake are indistinguishable without it.
  child.diagnostics = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const text = line.trim();
      if (text.length === 0) continue;
      child.diagnostics.push(text);
      if (child.diagnostics.length > 40) child.diagnostics.shift();
    }
  });
  return child;
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
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.once("close", finish);
    killer.once("error", finish);
    timer = setTimeout(() => {
      try { killer.kill(); } catch {}
      try { child.kill(); } catch {}
      finish();
    }, 5_000);
  });
  await waitForExit(child, 5_000);
}

async function closeSocket(client) {
  if (!client || client.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    client.once("close", resolve);
    client.close();
  });
}

const crossOriginFrame = `<!doctype html><title>Cross Origin Frame</title><h1>Cross origin frame</h1><button id="cross-frame-action" aria-label="Cross origin action">Cross origin action</button><label for="cross-frame-input">Cross frame field</label><input id="cross-frame-input"><script>document.querySelector('#cross-frame-action').addEventListener('click', event => { event.currentTarget.setAttribute('aria-label', 'Cross origin clicked'); event.currentTarget.textContent = 'Cross origin clicked'; });</script>`;
const oopifFrame = `<!doctype html><title>OOPIF Frame</title><h1>OOPIF frame</h1><button aria-label="OOPIF action">OOPIF action</button>`;
let crossOriginRequests = 0;
let oopifRequests = 0;
const crossOriginServer = createServer((req, res) => {
  if (req.headers.host?.startsWith("127.0.0.2:")) oopifRequests += 1;
  else crossOriginRequests += 1;
  if (req.url?.split("?", 1)[0] !== "/cross-origin-frame.html") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(req.headers.host?.startsWith("127.0.0.2:") ? oopifFrame : crossOriginFrame);
});
let crossOriginPort;
await new Promise((resolve, reject) => {
  crossOriginServer.once("error", reject);
  crossOriginServer.listen(0, "0.0.0.0", () => {
    const address = crossOriginServer.address();
    if (!address || typeof address === "string") {
      reject(new Error("E2E cross-origin server did not expose a TCP port"));
      return;
    }
    crossOriginPort = address.port;
    resolve();
  });
});
const renderSite = () => site
  .replaceAll("__CROSS_ORIGIN_FRAME_URL__", `http://127.0.0.1:${crossOriginPort}/cross-origin-frame.html`)
  .replaceAll("__OOPIF_FRAME_URL__", `http://127.0.0.2:${crossOriginPort}/cross-origin-frame.html`);
// A standalone landmark-free application shell shaped like the pages that exposed the
// Page Map regression: a header search utility with an inline helper script, a link-heavy
// history side panel, and an unlabelled main-content div that owns the page heading.
const shellPage = [
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Landmark-free build shell</title></head><body>",
  "<header class=\"app-header\">",
  "<div id=\"breadcrumb\"><a href=\"/\">Dashboard</a><a href=\"/job/x/\">job x</a></div>",
  "<form role=\"search\"><input type=\"search\" aria-label=\"search\"><button type=\"submit\">Search</button><a href=\"https://jenkins.io/redirect/search-box\">Action</a></form>",
  "<script>createSearchBox(\"/job/FXYF2_docker_5g-os-console/search/\");</script>",
  "</header>",
  "<div id=\"side-panel\"><h2>Build History</h2>",
  Array.from({ length: 120 }, (_, index) => `<a href="#build-${index}">Historical build ${index}</a>`).join(""),
  Array.from({ length: 30 }, () => "<div class=\"build-row\"><button type=\"button\">Open Job</button><button type=\"button\">Console</button></div>").join(""),
  "</div>",
  "<div id=\"main-panel\">",
  "<h1>Build #706 (2026-9-15 9:08:53)</h1>",
  "<img class=\"icon-blue icon-xlg\" alt=\"Success\" title=\"Success\">",
  "<p>Started 41 min ago</p>",
  "<p>Took 2 min 8 sec on 192.169.2.81</p>",
  "<p>Revision: e00a7ed35b970e1e45390bbaff536acb1999d9d9</p>",
  "<p>refs/remotes/origin/dev</p>",
  "<a href=\"/job/x/706/console\">Console Output</a>",
  "</div>",
  "</body></html>",
].join("\n");
// A plain business page with no build/CI vocabulary at all: the generic metadata layer must
// still publish its labelled fields, proving the extraction is site-agnostic. It also ships
// a hostile built-in polyfill (the kind old Jenkins helper bundles install): the plugin's own
// reads must stay immune because they run in the extension's isolated world.
const genericPage = [
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Order detail</title>",
  "<script>String.prototype.trim = function () { return new String(String.prototype.replace.call(this, /^\\s+|\\s+$/g, '')); };</script>",
  "</head><body>",
  "<div id=\"app-header\"><div id=\"breadcrumb\"><a href=\"/\">Home</a><a href=\"/orders\">Orders</a></div></div>",
  "<div id=\"main-content\">",
  "<h1>Order A-1001</h1>",
  "<p>Order ID: A-1001</p>",
  "<p>Customer: 珠海测试客户</p>",
  "<p>Total: 128.00</p>",
  "<p>Payment: Paid</p>",
  "<p>API token: should-never-appear</p>",
  "<dl><dt>Channel</dt><dd>SMS</dd></dl>",
  "<table><tr><th>Item</th><th>Quantity</th></tr><tr><td>Template pack</td><td>3</td></tr></table>",
  "</div>",
  "<aside id=\"related-orders\">",
  Array.from({ length: 40 }, (_, index) => `<a href="#order-${index}">Related order ${index}</a>`).join(""),
  "</aside>",
  "</body></html>",
].join("\n");
// A dedicated page for the neutral-digest contract: a repeated navigation, a header search
// utility, a landmark-free main container, an action bar and a log pane. It carries no CI
// vocabulary; region listing must not depend on any site knowledge.
const regionsPage = [
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Deployment build</title></head><body>",
  "<section id=\"page-map-fixture\">",
  "<aside id=\"noisy-navigation\"><h2>Navigation</h2>",
  Array.from({ length: 160 }, (_, index) => `<a href="#history-${index}">Historical navigation ${index}</a>`).join(""),
  "</aside>",
  "<form role=\"search\"><input type=\"search\" aria-label=\"Global search\"><button type=\"submit\">Search</button></form>",
  "<main id=\"page-map-form\"><h1>Deployment build</h1><p>Use these current build parameters.</p><p>Build #704</p><p>Revision: abc123</p><p>Branch: dev</p><p>Node: agent-1</p><p>Note: the deployment finished successfully without errors and the log was archived.</p><label for=\"map-branch\">Branch</label><input id=\"map-branch\" value=\"dev\"><button id=\"map-build\">Build</button><table id=\"declared-values\"><tr><th>Change summary</th><td>change-change-change-change-change-change-change-change-change-change-change-change-change-change-change-change-change-change-change-change</td></tr></table></main>",
  "<section id=\"detail-actions\"><a href=\"/console\">Console Output</a><a href=\"/git\">Git Build Data</a></section>",
  "<pre id=\"build-log\">old log line\ncurrent log: build started\ncurrent log: Finished: SUCCESS</pre>",
  "<footer>irrelevant footer history ".repeat(20) + "</footer>",
  "</section>",
  "</body></html>",
].join("\n");
// Archetype matrix for the compact-read contract: each page exercises ONE structural class, so a
// changed digest rule fails on the class it breaks instead of on one site's fixture. The set is the
// executable form of docs/COMPACT-READ-CONTRACT.zh-CN.md section 5, and the vocabulary is generic on
// purpose — no product or CI field names appear here.
const ARCHETYPE_KINDS = ["landmark", "wrapper", "data", "secrets", "bulk", "hostile"];
const archetypePage = (kind) => {
  const body = {
    landmark: [
      "<nav id=\"nav-a\">",
      Array.from({ length: 40 }, (_, index) => `<a href="#l-${index}">Repeated link ${index}</a>`).join(""),
      "</nav>",
      "<main id=\"main-a\"><h1>Landmark heading</h1><p>Revision: abc123</p><label for=\"landmark-branch\">Branch</label><input id=\"landmark-branch\" value=\"dev\"><button id=\"landmark-go\">Run</button></main>",
      "<section id=\"tail-a\"><a href=\"/tail\">Tail link</a></section>",
    ].join(""),
    wrapper: [
      "<section id=\"outer-wrap\"><h2>Outer heading</h2><section id=\"inner-wrap\"><p>Nested content</p><button id=\"wrapper-one\">One</button><button id=\"wrapper-two\">Two</button></section></section>",
      "<main id=\"wrapper-main\"><p>Main content</p></main>",
    ].join(""),
    data: [
      "<main id=\"data-main\"><h1>Declared data</h1>",
      "<p>Revision: abc123</p>",
      `<p>Summary: ${"a".repeat(200)}</p>`,
      "<p>Note: the deployment finished successfully and the log was archived.</p>",
      `<table id="data-table"><tr><th>Change summary</th><td>${"change-".repeat(25)}</td></tr></table>`,
      `<dl id="data-terms"><dt>Operator note</dt><dd>${"b".repeat(150)}</dd></dl>`,
      "</main>",
      // A nested id container and the table inside it both carry the same declared pair: the
      // document-order-first region publishes it and the descendant must not repeat it.
      "<section id=\"data-outer\"><button id=\"data-refresh\">Refresh</button><table id=\"data-nested\"><tr><th>Nested fact</th><td>nested-value-1234</td></tr></table></section>",
    ].join(""),
    secrets: [
      "<main id=\"secrets-main\"><h1>Redaction</h1>",
      "<p>Status: SUCCESS</p>",
      "<p>API token: should-never-appear</p>",
      "<p>Password: hunter2-secret</p>",
      "<script>var secretMark = \"SCRIPT_MARKER_9f3\";</script>",
      "</main>",
    ].join(""),
    bulk: [
      "<main id=\"bulk-main\"><h1>Bulk page</h1>",
      "<nav id=\"bulk-nav\">",
      Array.from({ length: 200 }, (_, index) => `<a href="#b-${index}">Bulk link ${index}</a>`).join(""),
      "</nav>",
      `<p>${"prose ".repeat(400)}</p>`,
      "</main>",
    ].join(""),
    hostile: [
      "<main id=\"hostile-main\"><h1>Hostile shapes</h1>",
      "<div id=\"dup\"><p>first duplicate</p></div><div id=\"dup\"><p>second duplicate</p></div>",
      `${"<div>".repeat(120)}deep${"</div>".repeat(120)}`,
      `<div id="hostile-text">${"x".repeat(20_000)}</div>`,
      "<div id=\"hostile-empty\"></div>",
      "</main>",
    ].join(""),
  }[kind];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Archetype ${kind}</title></head><body>${body ?? "<main><h1>Unknown archetype</h1></main>"}</body></html>`;
};
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
      res.end(renderSite());
    }, 400);
    return;
  }
  if (req.url?.startsWith("/shell")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(shellPage);
    return;
  }
  if (req.url?.startsWith("/regions")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(regionsPage);
    return;
  }
  if (req.url?.startsWith("/archetype/")) {
    const kind = req.url.slice("/archetype/".length).split("?")[0];
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(archetypePage(kind));
    return;
  }
  if (req.url?.startsWith("/generic")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(genericPage);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderSite());
});
await new Promise((resolve, reject) => {
  siteServer.once("error", reject);
  siteServer.listen(0, "0.0.0.0", () => {
    const address = siteServer.address();
    if (!address || typeof address === "string") {
      reject(new Error("E2E site server did not expose a TCP port"));
      return;
    }
    pagePort = address.port;
    resolve();
  });
});
let bridgeProcess = spawnProcess(process.execPath, [bridge, "--port", String(bridgePort), "--token-file", tokenFile, "--started-by", "pi", "--startup-marker", bridgeStartupMarker]);
let edgeProcess;
let socket;
const openSocket = async () => {
  const client = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws?role=pi&token=${encodeURIComponent(readFileSync(tokenFile, "utf8").trim())}`);
  await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
  return client;
};
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
    "--new-window",
    `http://127.0.0.1:${pagePort}/`,
  ], { captureStderr: true });

  // Two isolated browsers may cold-start at the same time in the matrix job, so
  // the handshake budget has to tolerate a contended runner; it still exits as
  // soon as the extension connects.
  const handshakeStartedAt = Date.now();
  let health;
  for (let i = 0; i < 480; i++) {
    await sleep(250);
    if (edgeProcess.exitCode !== null) throw new Error(`browser process exited before extension handshake; isolated launch may have been delegated (exit=${edgeProcess.exitCode})`);
    try {
      health = (await localGet("/health")).body;
      if (health.extensionConnected) break;
    } catch {}
  }
  if (edgeProcess.exitCode !== null) throw new Error(`browser process exited before extension handshake; isolated launch may have been delegated (exit=${edgeProcess.exitCode})`);
  const browserDiagnostics = edgeProcess.diagnostics?.length ? `; browser stderr: ${edgeProcess.diagnostics.join(" | ")}` : "";
  assert.equal(health?.extensionConnected, true, `${isInstalledGoogleChrome(browserExecutable)
    ? "Installed Google Chrome ignored command-line unpacked-extension loading (Chrome logged that --disable-extensions-except is not allowed). Use Chrome for Testing for this isolated smoke, or manually load extension/ in chrome://extensions for a normal-profile check."
    : "extension did not connect"} after ${Date.now() - handshakeStartedAt}ms: ${JSON.stringify(health)}${browserDiagnostics}`);
  assert.equal(health.instanceId, bridgeHealth.instanceId);
  assert.equal(health.port, bridgePort);
  await sleep(1500);

  socket = await openSocket();
  let sequence = 0;
  const request = (method, params = {}, target) => {
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
      socket.send(JSON.stringify({ type: "request", id, method, params: requestParams, ...(target === undefined ? {} : { target }) }));
    });
  };

  const pageOrigin = `http://127.0.0.1:${pagePort}`;
  let initial;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    initial = await request("list_tabs");
    if (initial.tabs.some(tab => typeof tab.url === "string" && tab.url.startsWith(pageOrigin))) break;
    await sleep(250);
  }
  assert.ok(initial.tabs.length >= 1);
  const initialCompact = await request("list_tabs", { responseMode: "compact" });
  assert.ok(initialCompact.tabs.length >= 1);
  assert.equal(initialCompact.tabs[0].favicon, undefined);
  let selectedTab = initial.tabs.find(tab => typeof tab.url === "string" && tab.url.startsWith(pageOrigin));
  if (selectedTab === undefined) {
    const created = await request("new_tab", { url: `${pageOrigin}/`, wait: true, timeoutMs: 10_000, active: true });
    await request("release", { tabId: created.tab.id });
    selectedTab = created.tab;
    initial = { ...initial, tabs: [...initial.tabs, selectedTab] };
  }
  const selected = { tab: selectedTab };
  assert.ok(selected.tab?.id !== undefined);
  assert.ok(selected.tab.url?.startsWith(pageOrigin), `browser did not select the E2E page: ${JSON.stringify(selected.tab)}`);
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
  await request("navigate", { tabId: selected.tab.id, url: `${pageOrigin}/?marker=reload-status`, wait: true });
  const reloadReady = await request("wait", { tabId: selected.tab.id, state: "text", text: "Reload ready", exact: true, reload: true, reloadIntervalMs: 250, timeoutMs: 5000 });
  assert.equal(reloadReady.matched, true);
  await request("navigate", { tabId: selected.tab.id, url: `${pageOrigin}/`, wait: true });
  const loadingGone = await request("wait", { tabId: selected.tab.id, state: "text_gone", text: "Loading...", timeoutMs: 5000 });
  assert.equal(loadingGone.matched, true);
  const asyncReady = await request("wait", { tabId: selected.tab.id, state: "text", text: "Async ready", exact: true, timeoutMs: 5000 });
  assert.equal(asyncReady.matched, true);
   const terminalState = await request("wait", { tabId: selected.tab.id, state: "text", textAny: ["Finished: FAILURE", "Async ready", "Finished: SUCCESS"], exact: true, timeoutMs: 5000 });
   assert.equal(terminalState.matched, true);
   assert.equal(terminalState.matchedText, "Async ready");
   await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#out').textContent = 'Finished: FAILURE'" });
   const failedTerminalState = await request("wait", { tabId: selected.tab.id, state: "text", textAny: ["Finished: SUCCESS"], failureTextAny: ["Finished: FAILURE"], exact: true, timeoutMs: 5000 });
   assert.equal(failedTerminalState.matched, true);
   assert.equal(failedTerminalState.failed, true);
   assert.equal(failedTerminalState.terminalState, "failure");
   assert.equal(failedTerminalState.matchedText, "Finished: FAILURE");
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

  // Real-browser semantic matrix: Chromium-computed names/states, framework-like
  // replacement, virtualized content, native/custom controls, a cross-origin
  // child frame, and a cross-site OOPIF. The OOPIF assertion below verifies
  // that an unattached child target fails closed rather than using DOM fallback.
  await sleep(100);
  const matrixAx = await request("snapshot", { tabId: selected.tab.id, accessibilityOnly: true, disableDiffing: true, responseMode: "raw" });
  assert.equal(matrixAx.snapshot.accessibility.source, "chromium_ax");
  assert.ok(matrixAx.snapshot.accessibility.frameCount >= 3, "cross-origin frame was not present in the AX frame set");
  assert.equal(matrixAx.snapshot.accessibility.frameFailures ?? 0, 0);
  assert.ok(crossOriginRequests > 0, "same-process cross-origin frame did not load");
  assert.ok(oopifRequests > 0, "OOPIF frame did not load");
  assert.ok(matrixAx.frameTree?.frameTree?.childFrames?.some(({ frame }) => frame?.url?.includes(`127.0.0.1:${crossOriginPort}/`)), "cross-origin frame was not present in Page.getFrameTree");
  assert.ok(!matrixAx.frameTree?.frameTree?.childFrames?.some(({ frame }) => frame?.url?.includes(`127.0.0.2:${crossOriginPort}/`)), "OOPIF unexpectedly appeared in the top-target frame tree");
  assert.ok(matrixAx.snapshot.accessibility.children.some((node) => node.role === "button" && node.name === "Cross origin action"));
  const complexTarget = { role: "button", name: "Approve invoice 42 ready", exact: true };
  assert.equal((await request("locator", { tabId: selected.tab.id, target: complexTarget, action: "count" })).result, 1);
  assert.equal((await request("interaction", { tabId: selected.tab.id, target: complexTarget, operation: "click" })).result.resolvedBy, "chromium_ax");
  assert.equal((await request("locator", { tabId: selected.tab.id, target: { role: "combobox", name: "Native choice", exact: true }, action: "select", value: "blue" })).result.resolvedBy, "chromium_ax");
  assert.equal((await request("locator", { tabId: selected.tab.id, target: { role: "checkbox", name: "Native agreement", exact: true }, action: "check" })).result.resolvedBy, "chromium_ax");
  const nativeState = await request("evaluate", { tabId: selected.tab.id, expression: "JSON.stringify({ choice: document.querySelector('#native-choice').value, agreement: document.querySelector('#native-agreement').checked })" });
  assert.deepEqual(JSON.parse(nativeState.result?.result?.value), { choice: "blue", agreement: true });
  const customSwitch = { role: "switch", name: "Custom switch", exact: true };
  assert.equal((await request("interaction", { tabId: selected.tab.id, target: customSwitch, operation: "click" })).result.resolvedBy, "chromium_ax");
  assert.equal((await request("locator", { tabId: selected.tab.id, target: customSwitch, action: "getAttribute", attribute: "aria-checked" })).result, "true");
  const customCombo = { role: "combobox", name: "Custom choice", exact: true };
  assert.equal((await request("interaction", { tabId: selected.tab.id, target: customCombo, operation: "click" })).result.resolvedBy, "chromium_ax");
  assert.equal((await request("locator", { tabId: selected.tab.id, target: customCombo, action: "getAttribute", attribute: "aria-expanded" })).result, "true");
  const reactTarget = { role: "button", name: "React save", exact: true };
  assert.equal((await request("interaction", { tabId: selected.tab.id, target: reactTarget, operation: "click" })).result.resolvedBy, "chromium_ax");
  assert.equal((await request("locator", { tabId: selected.tab.id, target: { role: "button", name: "React save ready", exact: true }, action: "count" })).result, 1);
  const vueTarget = { role: "button", name: "Vue action", exact: true };
  assert.equal((await request("interaction", { tabId: selected.tab.id, target: vueTarget, operation: "click" })).result.resolvedBy, "chromium_ax");
  assert.equal((await request("locator", { tabId: selected.tab.id, target: { role: "button", name: "Vue action ready", exact: true }, action: "count" })).result, 1);
  const virtualTarget = { role: "option", name: "Virtual row 1", exact: true };
  assert.equal((await request("locator", { tabId: selected.tab.id, target: virtualTarget, action: "count" })).result, 1);
  await request("interaction", { tabId: selected.tab.id, target: { role: "button", name: "Next virtual page", exact: true }, operation: "click" });
  assert.equal((await request("locator", { tabId: selected.tab.id, target: { role: "option", name: "Virtual row 4", exact: true }, action: "count" })).result, 1);
  const crossTarget = { role: "button", name: "Cross origin action", exact: true };
  assert.equal((await request("locator", { tabId: selected.tab.id, target: crossTarget, action: "count", timeoutMs: 5000 })).result, 1);
  const oopifTarget = { role: "button", name: "OOPIF action", exact: true };
  assert.equal((await request("locator", { tabId: selected.tab.id, target: oopifTarget, action: "count", timeoutMs: 5000 })).result, 0);
  await assert.rejects(
    () => request("interaction", { tabId: selected.tab.id, target: oopifTarget, operation: "click", timeoutMs: 5000 }),
    (error) => error.code === "AX_NODE_NOT_FOUND",
  );
  const crossClick = await request("interaction", { tabId: selected.tab.id, target: crossTarget, operation: "click", timeoutMs: 5000 });
  assert.equal(crossClick.result.resolvedBy, "chromium_ax");
  assert.equal((await request("interaction", { tabId: selected.tab.id, target: { label: "Cross frame field", exact: true }, operation: "fill", value: "cross-origin", timeoutMs: 5000 })).result.resolvedBy, "chromium_ax");
  const crossAfter = await request("snapshot", { tabId: selected.tab.id, accessibilityOnly: true, disableDiffing: true });
  assert.ok(crossAfter.snapshot.accessibility.children.some((node) => node.role === "button" && node.name === "Cross origin clicked"));

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
  // A dedicated page for the neutral-digest contract: navigation with 160 repeated links, a
  // header search utility, a landmark-free main container, an action bar, and a log pane.
  const regionTab = await request("new_tab", { url: `${pageOrigin}/regions`, active: false, wait: true, sessionId: "e2e-regions" });
  const pageMapWireSnapshot = await request("snapshot", { tabId: regionTab.tab.id, responseMode: "compact" });
  const pageMapState = pageMapWireSnapshot.snapshot.state;
  // Neutral contract: regions are listed in document order, nothing is called "primary", and
  // no key-action ranking exists. Which region matters is the caller's decision.
  assert.doesNotMatch(pageMapState, /Primary/);
  assert.doesNotMatch(pageMapState, /Key actions/);
  assert.match(pageMapState, /Regions \(document order\):/);
  assert.match(pageMapState, /- main "Deployment build"/);
  assert.match(pageMapState, /Deployment build/);
  assert.match(pageMapState, /controls:/);
  assert.match(pageMapState, /link "Console Output"/);
  assert.match(pageMapState, /revision: abc123/);
  assert.match(pageMapState, /branch: dev/);
  assert.match(pageMapState, /node: agent-1/);
  // Metadata stays terse and neutral: an inferred "label: value" line that reads as a sentence is
  // body text, not structured data, while a pair the page itself declares in a table may carry a
  // longer value. Both rules are structural and carry no site vocabulary.
  const valueLines = pageMapState.split("\n").filter((line) => /^\s*values:/.test(line)).join("\n");
  assert.match(valueLines, /revision=abc123/);
  assert.match(valueLines, /change summary=change-change-/);
  assert.doesNotMatch(valueLines, /the deployment finished successfully/);
  // Document order is observable: navigation precedes the search form, which precedes main.
  const navigationIndex = pageMapState.indexOf('- navigation "Navigation"') >= 0
    ? pageMapState.indexOf('- navigation "Navigation"')
    : pageMapState.indexOf('- secondary "Navigation"');
  assert.ok(navigationIndex >= 0 && navigationIndex < pageMapState.indexOf('- main "Deployment build"'));
  // Repeated controls are reported as counts, and only a bounded prefix is published.
  assert.match(pageMapState, /\(controls=160/);
  assert.doesNotMatch(pageMapState, /Historical navigation 159/);
  // The published detail is globally bounded, so an overlapping nested region cannot flood it.
  const publishedRefs = (pageMapState.match(/\[ref=e\d+\]/g) ?? []).length;
  assert.ok(publishedRefs <= 40, `published refs must stay bounded, saw ${publishedRefs}`);
  // Every listed region stays addressable for the follow-up read.
  assert.match(pageMapState, /\{selector=#page-map-fixture\}|\{selector=#detail-actions\}|\{selector=#build-log\}/);
  assert.match(pageMapState, /\[ref=e\d+\]/);
  // Retrieval contract: a bounded read reports what it omitted and how to retrieve it.
  assert.ok(pageMapWireSnapshot.snapshot.omitted, "bounded digest must report omitted counts");
  assert.equal(pageMapWireSnapshot.snapshot.recommendation, "narrow_read");
  assert.match(pageMapWireSnapshot.snapshot.recovery, /browser_snapshot|browser_extract/);
  // Zooming into a listed region returns the same shape for that subtree.
  const zoomed = await request("snapshot", { tabId: regionTab.tab.id, selector: "#page-map-form", responseMode: "compact" });
  assert.match(zoomed.snapshot.state, /Deployment build/);
  assert.doesNotMatch(zoomed.snapshot.state, /Historical navigation 0\b/);
  const logTail = await request("extract", { tabId: regionTab.tab.id, scope: "log", tail: true, maxChars: 120, includeFrames: false });
   const matchedLog = await request("extract", { tabId: regionTab.tab.id, scope: "log", logMatch: "Finished", logMaxMatches: 5, maxChars: 120, includeFrames: false });
   assert.equal(matchedLog.content.logMatch, "Finished");
   assert.equal(matchedLog.content.matchedLineCount, 1);
   assert.deepEqual(matchedLog.content.matchedLineNumbers, [3]);
   assert.match(matchedLog.content.text, /Finished: SUCCESS/);
  assert.equal(logTail.content.scope, "log");
  assert.match(logTail.content.text, /Finished: SUCCESS/);
  assert.doesNotMatch(logTail.content.text, /irrelevant footer history/);
  // Discovery reads are bounded and retrievable: a query narrows the listing at the source and
  // the omitted count names what the budget dropped instead of silently losing rows.
  const filteredTabs = await request("list_tabs", { query: "/regions", limit: 1 });
  assert.equal(filteredTabs.tabs.length, 1);
  assert.ok(filteredTabs.tabs[0].url.endsWith("/regions"), "the query must select the requested tab");
  assert.equal(filteredTabs.filters.query, "/regions");
  assert.ok(Number.isInteger(filteredTabs.totalTabs) && filteredTabs.totalTabs >= 1);
  await request("close_tab", { tabId: regionTab.tab.id, sessionId: "e2e-regions" });
  // Landmark-free application shell. The neutral digest must list its id-carrying containers
  // (`#main-panel`, `#side-panel`) in document order so each is addressable again, must not
  // rank any of them, must not surface inline helper-script text, and must not invent domain
  // fields: only the labelled "Revision:" line is a value.
  const shellTab = await request("new_tab", { url: `${pageOrigin}/shell`, active: false, wait: true, sessionId: "e2e-shell" });
  const shellSnapshot = await request("snapshot", { tabId: shellTab.tab.id, responseMode: "compact" });
  const shellState = shellSnapshot.snapshot.state;
  assert.doesNotMatch(shellState, /Primary/);
  assert.match(shellState, /Regions \(document order\):/);
  assert.match(shellState, /Build #706 \(2026-9-15 9:08:53\)/);
  assert.match(shellState, /revision: e00a7ed35b970e1e45390bbaff536acb1999d9d9/);
  assert.doesNotMatch(shellState, /branch: dev/);
  assert.doesNotMatch(shellState, /node: 192\.169\.2\.81/);
  assert.doesNotMatch(shellState, /duration: 2 min 8 sec/);
  assert.doesNotMatch(shellState, /status: SUCCESS/);
  assert.doesNotMatch(shellState, /status: RUNNING/);
  assert.doesNotMatch(shellState, /createSearchBox/);
  // The id-carrying containers stay addressable for the follow-up read.
  assert.match(shellState, /\{selector=#main-panel\}/);
  assert.match(shellState, /\{selector=#side-panel\}/);
  assert.ok(shellState.indexOf("selector=#side-panel") < shellState.indexOf("selector=#main-panel"), "document order must be preserved");
  // Repeated history controls are counted, and the search utility is one small region.
  assert.match(shellState, /\(controls=180/);
  assert.match(shellState, /form "search"/);
  await request("close_tab", { tabId: shellTab.tab.id, sessionId: "e2e-shell" });
  // Generic-capability check: no CI vocabulary anywhere on this page, yet the labelled
  // fields are still published, the secret-looking label is redacted, and the unrelated
  // link list stays bounded by counts.
  const genericTab = await request("new_tab", { url: `${pageOrigin}/generic`, active: false, wait: true, sessionId: "e2e-generic" });
  const genericSnapshot = await request("snapshot", { tabId: genericTab.tab.id, responseMode: "compact" });
  assert.match(genericSnapshot.snapshot.state, /Order A-1001/);
  assert.match(genericSnapshot.snapshot.state, /order id: A-1001/);
  assert.match(genericSnapshot.snapshot.state, /customer: 珠海测试客户/);
  assert.match(genericSnapshot.snapshot.state, /total: 128\.00/);
  assert.match(genericSnapshot.snapshot.state, /payment: Paid/);
  assert.match(genericSnapshot.snapshot.state, /channel: SMS/);
  assert.doesNotMatch(genericSnapshot.snapshot.state, /should-never-appear/);
  assert.doesNotMatch(genericSnapshot.snapshot.state, /Related order 39/);
  assert.doesNotMatch(genericSnapshot.snapshot.state, /Primary/);
  // The page patched String.prototype.trim to return a boxed String. The plugin's isolated
  // world must still produce plain strings, never a {0:"a",1:"b"} artifact.
  assert.doesNotMatch(genericSnapshot.snapshot.state, /\d"\s*:/);
  assert.match(genericSnapshot.snapshot.state, /Order A-1001/);
  await request("close_tab", { tabId: genericTab.tab.id, sessionId: "e2e-generic" });
  // --- Archetype matrix (docs/COMPACT-READ-CONTRACT.zh-CN.md section 5) ---------------------------
  // Every structural class gets its own page and its own invariant set, so a digest change that
  // breaks one class is reported by that class instead of by a site fixture.
  const valuesOf = (state) => state.split("\n").filter((line) => /^\s*values:/.test(line)).join("\n");
  // Region bullets only: the top-level `Values:` block also renders "- key: value" lines.
  const regionLines = (state) => {
    const start = state.indexOf("Regions (document order):");
    return start < 0 ? [] : state.slice(start).split("\n").filter((line) => /^- /.test(line));
  };
  const readArchetype = async (kind) => {
    const created = await request("new_tab", { url: `${pageOrigin}/archetype/${kind}`, active: false, wait: true, sessionId: `e2e-archetype-${kind}` });
    const tabId = created.tab.id;
    const snapshot = await request("snapshot", { tabId, responseMode: "compact" });
    return { tabId, snapshot, state: snapshot.snapshot.state };
  };

  const archetypeTabs = new Map();
  const archetypeStates = new Map();
  const archetypeSnapshots = new Map();
  for (const kind of ARCHETYPE_KINDS) {
    const { tabId, snapshot, state } = await readArchetype(kind);
    archetypeTabs.set(kind, tabId);
    archetypeStates.set(kind, state);
    archetypeSnapshots.set(kind, snapshot);
    // Cross-class invariants: no ranking survives, every listed region stays addressable, and
    // nothing internal leaks into the model-visible digest.
    assert.match(state, /Regions \(document order\):/, `${kind}: regions must be listed`);
    assert.match(state, /^Page: .+$/m, `${kind}: the page title stays at the top level`);
    assert.doesNotMatch(state, /Primary|Key actions/, `${kind}: no ranking vocabulary`);
    assert.doesNotMatch(state, /undefined|\[object Object\]/, `${kind}: no internal artifacts`);
    for (const line of regionLines(state)) {
      assert.match(line, /\[ref=e\d+\]/, `${kind}: every listed region stays addressable by ref (${line})`);
    }
  }

  {
    // landmark: document order is observable, repeated containers are counted instead of expanded,
    // the digest is deterministic for the same DOM, and a listed region is retrievable by address.
    const state = archetypeStates.get("landmark");
    const tabId = archetypeTabs.get("landmark");
    const bullets = regionLines(state);
    const navIndex = bullets.findIndex((line) => /\(controls=40/.test(line));
    const mainIndex = bullets.findIndex((line) => line.includes("Landmark heading"));
    const tailIndex = bullets.findIndex((line) => /tail/i.test(line));
    assert.ok(navIndex >= 0 && mainIndex > navIndex, `navigation precedes main in document order (${bullets.join(" | ")})`);
    assert.ok(tailIndex > mainIndex, "main precedes the trailing section");
    assert.doesNotMatch(state, /Repeated link 39\b/);
    assert.match(valuesOf(state), /revision=abc123/);
    const repeat = await request("snapshot", { tabId, responseMode: "compact" });
    // Refs are opaque, observation-scoped handles that a fresh observation may renumber; the
    // digest content and its order must be identical for the same DOM.
    const withoutRefs = (value) => value.replace(/\[ref=e\d+\]/g, "[ref]");
    const left = withoutRefs(state);
    const right = withoutRefs(repeat.snapshot.state);
    if (left !== right) {
      let at = 0;
      while (at < left.length && left[at] === right[at]) at += 1;
      console.error(`determinism diff at ${at}\n  first : ${JSON.stringify(left.slice(Math.max(0, at - 80), at + 80))}\n  repeat: ${JSON.stringify(right.slice(Math.max(0, at - 80), at + 80))}\n  lengths: ${left.length} vs ${right.length}`);
    }
    assert.equal(right, left, "the same DOM must produce the same digest");
    const scoped = await request("snapshot", { tabId, selector: "#main-a", responseMode: "compact" });
    assert.match(scoped.snapshot.state, /Landmark heading/);
  }

  {
    // wrapper: a nested wrapper that exposes exactly its ancestor's controls is not listed twice.
    const state = archetypeStates.get("wrapper");
    const addresses = state.match(/\{selector=#(?:outer|inner)-wrap\}/g) ?? [];
    assert.equal(addresses.length, 1, `a redundant wrapper must be listed once, saw ${addresses.join(", ")}`);
    assert.equal(addresses[0], "{selector=#outer-wrap}", "the outer wrapper is the one that stays listed");
    assert.match(state, /Nested content/);
  }

  {
    // data: the metadata rules are structural. A short inferred pair stays, a pair the page declares
    // (table row, dt/dd) may be long, prose or an oversized inferred pair is not data, declared pairs
    // are published before inferred ones, and a nested region does not repeat its ancestor's pair.
    const state = archetypeStates.get("data");
    const values = valuesOf(state);
    assert.match(values, /revision=abc123/, "a short inferred pair is structured data");
    assert.match(values, /change summary=change-change-/, "a declared table pair may carry a long value");
    assert.match(values, /operator note=bbb/, "a declared dt/dd pair may carry a long value");
    assert.doesNotMatch(values, /the deployment finished successfully/, "prose must not become a value");
    assert.doesNotMatch(values, /summary=aaaa/, "an oversized inferred value must be rejected");
    assert.ok(values.indexOf("change summary=") < values.indexOf("revision="), "declared pairs precede inferred pairs");
    const nested = state.match(/nested fact=nested-value-1234/g) ?? [];
    assert.equal(nested.length, 1, `a nested region must not repeat its ancestor's pair, saw ${nested.length}`);
  }

  {
    // secrets: credential-labelled lines and inline helper scripts never enter the digest, while an
    // ordinary pair on the same page still does.
    const state = archetypeStates.get("secrets");
    // The label is normalised (lowercased) while the rendered value keeps its own casing.
    assert.match(valuesOf(state), /status=SUCCESS/);
    assert.doesNotMatch(state, /should-never-appear/);
    assert.doesNotMatch(state, /hunter2-secret/);
    assert.doesNotMatch(state, /SCRIPT_MARKER_9f3/);
  }

  {
    // bulk: a bounded read reports what it dropped and how to retrieve it instead of expanding.
    const state = archetypeStates.get("bulk");
    const snapshot = archetypeSnapshots.get("bulk");
    assert.match(state, /\(controls=200/);
    assert.doesNotMatch(state, /Bulk link 199\b/);
    assert.equal(snapshot.snapshot.truncated, true);
    assert.ok(snapshot.snapshot.omitted?.controls > 0, "a bounded digest reports its omitted controls");
    assert.equal(snapshot.snapshot.nextAction, "browser_snapshot");
    assert.equal(snapshot.snapshot.recommendation, "narrow_read");
    // The same discipline applies to a text read: the source size is reported and the retrieval
    // path is the narrow selector read, not a wider one.
    const bulkExtract = await request("extract", { tabId: archetypeTabs.get("bulk"), maxChars: 200, responseMode: "compact" });
    assert.equal(bulkExtract.content.truncated, true);
    assert.ok(bulkExtract.content.sourceCharacters > 200, "a budgeted extract reports the source size");
    assert.ok(bulkExtract.omitted?.characters > 0, "a budgeted extract reports the dropped characters");
    assert.equal(bulkExtract.nextAction, "browser_extract");
    assert.equal(bulkExtract.recommendation, "narrow_read");
    assert.match(bulkExtract.recovery, /selector/);
    // A tail read answers with the end of the document, so a longer source drops nothing from the
    // answer: it must not report truncation or an omission count.
    const bulkTail = await request("extract", { tabId: archetypeTabs.get("bulk"), tail: true, maxChars: 200, responseMode: "compact" });
    assert.equal(bulkTail.content.truncated, undefined);
    assert.equal(bulkTail.omitted, undefined);
  }

  {
    // hostile: duplicate ids, 120-level nesting, a 20k-character text node and an empty container
    // must stay bounded and readable rather than throwing or leaking internals.
    const state = archetypeStates.get("hostile");
    assert.ok(state.length <= 9_000, `a hostile page must stay bounded, saw ${state.length}`);
    assert.equal(archetypeSnapshots.get("hostile").snapshot.truncated, true);
  }

  for (const kind of ARCHETYPE_KINDS) {
    await request("close_tab", { tabId: archetypeTabs.get(kind), sessionId: `e2e-archetype-${kind}` });
  }
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
  assert.equal(compactWireExtract.content.text.length <= 6000, true);
  assert.equal(compactWireExtract.content.markdown.length <= 6000, true);
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
  const semanticPress = await request("interaction", {
    tabId: selected.tab.id,
    operation: "press",
    target: { role: "textbox", name: "Press target", exact: true },
    key: "Enter",
    timeoutMs: 5000,
  });
  assert.equal(semanticPress.result?.resolvedBy, "chromium_ax");
  const pressedValue = await request("evaluate", { tabId: selected.tab.id, expression: "document.querySelector('#out').textContent" });
  assert.equal(pressedValue.result?.result?.value, "Pressed Enter");
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
  assert.equal(filteredCount.result, 3);
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

  const probeConsoleError = await request("probe_interaction", {
    tabId: selected.tab.id,
    operation: "click",
    selector: "#probe-error",
    only: "errors",
    settleMs: 250,
  });
  assert.equal(probeConsoleError.action?.confirmed, true);
  assert.equal(probeConsoleError.console?.only, "errors");
  assert.ok(probeConsoleError.console?.events?.some((entry) => String(entry.text).includes("probe-console-error")));
  assert.equal(probeConsoleError.postState?.exists, true);
  assert.equal(probeConsoleError.postState?.visible, true);

  const probePageError = await request("probe_interaction", {
    tabId: selected.tab.id,
    operation: "click",
    target: { selector: "#probe-pageerror" },
    only: "errors",
    settleMs: 300,
  });
  assert.equal(probePageError.action?.confirmed, true);
  assert.ok(probePageError.console?.events?.some((entry) => entry.type === "pageerror" && String(entry.text).includes("probe-page-error")));

  const probeRemoved = await request("probe_interaction", {
    tabId: selected.tab.id,
    operation: "click",
    selector: "#probe-remove",
    only: "errors",
    settleMs: 100,
  });
  assert.equal(probeRemoved.action?.confirmed, true);
  assert.equal(probeRemoved.postState?.exists, false);
  assert.equal(probeRemoved.postState?.count, 0);

  const probeAsync = await request("probe_interaction", {
    tabId: selected.tab.id,
    operation: "click",
    selector: "#probe-async",
    settle: { state: "text", text: "Probe async ready", exact: true, timeoutMs: 5000 },
    only: "errors",
  });
  assert.equal(probeAsync.action?.confirmed, true);
  assert.equal(probeAsync.settling?.completed, true);
  assert.equal(probeAsync.postState?.exists, true);
  assert.equal(probeAsync.console?.eventCount, 0);

  const consoleBaseline = await request("console_logs", { tabId: selected.tab.id, only: "all" });
  await request("evaluate", { tabId: selected.tab.id, expression: "console.log('incremental-console-marker')" });
  await sleep(250);
  const consoleDelta = await request("console_logs", { tabId: selected.tab.id, only: "all", since: consoleBaseline.nextSince });
  assert.ok(consoleDelta.logs.some((entry) => String(entry.text).includes("incremental-console-marker")));
  assert.equal(consoleDelta.documentChanged, undefined);

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
  const preRestartHealth = (await localGet("/health")).body;
  const modelMetrics = preRestartHealth.observability?.metrics;
  assert.ok(modelMetrics?.compactModelResponses > 0, `compact response telemetry missing: ${JSON.stringify(modelMetrics)}`);
  assert.ok(modelMetrics.compactModelResponseBytes < modelMetrics.modelResponseBytes, `compact responses were not smaller: ${JSON.stringify(modelMetrics)}`);

  // Restart the isolated Bridge while keeping the isolated browser and its tab alive.
  // The old target route is intentionally retained so the next request proves it is stale.
  const beforeRestartHealth = (await localGet("/health")).body;
  const beforeRestartTabs = await request("list_tabs");
  const beforeRestartTab = beforeRestartTabs.tabs.find((tab) => tab.id === selected.tab.id);
  assert.ok(beforeRestartTab?.handle?.tabId !== undefined);
  assert.equal(beforeRestartTabs.browserId, beforeRestartHealth.browserId);
  const beforeRestartTarget = {
    browserId: beforeRestartHealth.browserId,
    connectionId: beforeRestartHealth.connectionId,
    connectionGeneration: beforeRestartHealth.connectionGeneration,
  };
  const staleHandle = beforeRestartTab.handle;
  const preRestartInstanceId = beforeRestartHealth.instanceId;
  const preRestartConnectionId = beforeRestartHealth.connectionId;
  const restartControl = await request("bridge_restart", { expectedInstanceId: preRestartInstanceId, requester: "e2e" });
  assert.equal(restartControl.ok, true);
  assert.equal(restartControl.restarting, true);
  await closeSocket(socket);
  socket = undefined;
  await waitForExit(bridgeProcess, 5000);
  assert.notEqual(bridgeProcess.exitCode, null, "isolated Bridge did not exit after cooperative restart");

  const replacementMarker = `${bridgeStartupMarker}-restart-${randomUUID()}`;
  bridgeProcess = spawnProcess(process.execPath, [bridge, "--port", String(bridgePort), "--token-file", tokenFile, "--started-by", "pi", "--startup-marker", replacementMarker]);
  let restartedHealth;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (bridgeProcess.exitCode !== null) throw new Error(`replacement Bridge exited before binding to port ${bridgePort}; exit=${bridgeProcess.exitCode}`);
    try {
      restartedHealth = (await localGet("/health")).body;
      if (restartedHealth.ok === true && restartedHealth.startupMarker === replacementMarker && restartedHealth.instanceId !== preRestartInstanceId) break;
    } catch {}
    await sleep(100);
  }
  assert.equal(restartedHealth?.ok, true, `replacement Bridge did not become healthy: ${JSON.stringify(restartedHealth)}`);
  assert.equal(restartedHealth.startupMarker, replacementMarker);
  assert.notEqual(restartedHealth.instanceId, preRestartInstanceId);

  let reconnectedHealth = restartedHealth;
  for (let attempt = 0; attempt < 120 && reconnectedHealth?.extensionConnected !== true; attempt += 1) {
    await sleep(250);
    reconnectedHealth = (await localGet("/health")).body;
  }
  assert.equal(reconnectedHealth?.extensionConnected, true, `extension did not reconnect after isolated Bridge restart: ${JSON.stringify(reconnectedHealth)}`);
  assert.equal(reconnectedHealth.browserId, beforeRestartHealth.browserId);
  assert.equal(reconnectedHealth.targetCount, 1);
  assert.equal(reconnectedHealth.readyTargetCount, 1);
  assert.notEqual(reconnectedHealth.connectionId, preRestartConnectionId);

  socket = await openSocket();
  const restartedTarget = {
    browserId: reconnectedHealth.browserId,
    connectionId: reconnectedHealth.connectionId,
    connectionGeneration: reconnectedHealth.connectionGeneration,
  };
  const restartedStatus = await request("status", {}, restartedTarget);
  assert.equal(restartedStatus.browserId, beforeRestartHealth.browserId);
  const refreshedTabs = await request("list_tabs", {}, restartedTarget);
  const refreshedTab = refreshedTabs.tabs.find((tab) => tab.id === selected.tab.id);
  assert.ok(refreshedTab?.handle?.tabId !== undefined, "selected tab did not survive the isolated Bridge restart");
  await assert.rejects(
    () => request("snapshot", { tabId: selected.tab.id, handle: staleHandle }, beforeRestartTarget),
    (error) => error.code === "TARGET_CONNECTION_CHANGED" || error.code === "TARGET_UNAVAILABLE",
  );
  const restartedSnapshot = await request("snapshot", { tabId: selected.tab.id, handle: refreshedTab.handle }, restartedTarget);
  assert.equal(restartedSnapshot.tab?.id ?? restartedSnapshot.id, selected.tab.id);
  const restartedProbe = await request("probe_interaction", {
    tabId: selected.tab.id,
    operation: "hover",
    selector: "#go",
    only: "errors",
    settleMs: 50,
  }, restartedTarget);
  assert.equal(restartedProbe.action?.confirmed, true);
  const restartEvidence = {
    previousInstanceId: preRestartInstanceId,
    currentInstanceId: reconnectedHealth.instanceId,
    browserId: reconnectedHealth.browserId,
    previousConnectionId: preRestartConnectionId,
    currentConnectionId: reconnectedHealth.connectionId,
    connectionGeneration: reconnectedHealth.connectionGeneration,
    staleHandleRejected: true,
    refreshedHandleWorked: true,
    extensionConnected: reconnectedHealth.extensionConnected,
  };

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
     modelMetrics,
    group,
    cleanup,
    staleMarkCleanup,
    restartEvidence,
  }));
} finally {
  await closeSocket(socket);
  // Stop the browser before closing the HTTP servers so keep-alive page
  // connections cannot hold server.close() open on the Windows runner.
  await stopProcess(edgeProcess);
  await stopProcess(bridgeProcess);
  await new Promise((resolve) => siteServer.close(resolve));
  await new Promise((resolve) => crossOriginServer.close(resolve));
  try { rmSync(temp, { recursive: true, force: true }); } catch {}
}
