import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "skills", "pi-control-chrome", "scripts", "browser.mjs");

async function runScript(...args) {
  const result = await execFileAsync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

function startFixture() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Pi Skill Script Test</title><h1>Pi Skill Script Test</h1><p>browser workflow fixture</p>");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

test("bundled browser CLI completes common Bridge workflows", async () => {
  const fixture = await startFixture();
  const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-skill-test-"));
  const sessionId = `skill-script-test-${process.pid}`;
  let seedTabId;
  let openedTabId;
  let viewedTabId;
  try {
    const status = await runScript("status", "--json");
    assert.equal(status.status.connected, true);
    assert.equal(status.health.extensionConnected, true);

    const seeded = await runScript("open", "about:blank", "--inactive", "--session", `${sessionId}-seed`, "--json");
    seedTabId = seeded.tab.id;
    const groups = await runScript("group", "--json");
    assert.ok(groups.some((group) => group.title === "Pi" && group.color === "blue"));

    const opened = await runScript("open", fixture.url, "--inactive", "--session", sessionId, "--json");
    openedTabId = opened.tab.id;
    assert.equal(opened.tab.owner, "agent");
    assert.equal(opened.tab.lifecycle, "temporary");
    assert.equal(opened.group.title, "Pi");
    assert.equal(opened.group.color, "blue");

    const snapshot = await runScript("snapshot", String(openedTabId), "--json");
    assert.equal(snapshot.tabId, openedTabId);

    const screenshotPath = join(temp, "about-blank.png");
    const screenshot = await runScript("screenshot", String(openedTabId), screenshotPath, "--json");
    assert.equal(screenshot.tabId, openedTabId);
    assert.ok(statSync(screenshotPath).size > 100);

    const viewed = await runScript("view", fixture.url, "--inactive", "--temporary", "--max-chars", "500", "--json");
    viewedTabId = viewed.tab.id;
    assert.equal(viewed.tab.owner, "agent");
    assert.equal(viewed.tab.lifecycle, "temporary");
    assert.equal(viewed.tab.groupId, viewed.group.id);
    assert.equal(viewed.group.title, "Pi");
    assert.equal(viewed.timing.readyState, "complete");
    assert.match(viewed.content.text, /Pi Skill Script Test/);
    assert.match(viewed.content.markdown, /browser workflow fixture/);

    const extracted = await runScript("extract", String(viewedTabId), "--max-chars", "200", "--json");
    assert.match(extracted.content.text, /Pi Skill Script Test/);
    assert.ok(extracted.content.text.length <= 240);

    const cleanup = await runScript("cleanup", "--session", sessionId, "--json");
    assert.ok(cleanup.removed.includes(openedTabId));
    assert.equal(cleanup.removed.includes(viewedTabId), false);

    const closed = await runScript("close", String(viewedTabId), "--json");
    assert.equal(closed.closed, viewedTabId);

    const tabs = await runScript("tabs", "--json");
    assert.equal(tabs.tabs.some((tab) => tab.id === openedTabId), false);
    assert.equal(tabs.tabs.some((tab) => tab.id === viewedTabId), false);
  } finally {
    if (seedTabId !== undefined) {
      try { await runScript("cleanup", "--session", `${sessionId}-seed`, "--json"); } catch {}
    }
    if (openedTabId !== undefined) {
      try { await runScript("close", String(openedTabId), "--json"); } catch {}
    }
    if (viewedTabId !== undefined) {
      try { await runScript("close", String(viewedTabId), "--json"); } catch {}
    }
    fixture.server.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
