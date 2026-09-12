import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const testFile = join(root, "tests", "e2e-browser.mjs");
const chromeForTestingCandidates = [
  process.env.PI_CONTROL_CHROME_CHROME,
  "C:\\Program Files\\Google\\Chrome for Testing\\Application\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome for Testing\\chrome.exe",
  "C:\\Users\\lyud\\AppData\\Local\\Google\\Chrome for Testing\\chrome.exe",
  "C:\\Users\\liuyd\\AppData\\Local\\Google\\Chrome for Testing\\chrome.exe",
].filter(Boolean);
const chromeForTesting = chromeForTestingCandidates.find(path => existsSync(path));
const candidates = [
  { name: "edge", path: process.env.PI_CONTROL_CHROME_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
  ...(chromeForTesting === undefined ? [] : [{ name: "chrome-for-testing", path: chromeForTesting }]),
].filter((candidate, index, all) => existsSync(candidate.path) && all.findIndex(other => other.path.toLowerCase() === candidate.path.toLowerCase()) === index);

if (candidates.length === 0) {
  console.log("SKIP: no supported Chrome or Edge executable found");
  process.exit(0);
}

const results = await Promise.all(candidates.map(async candidate => {
  console.log(`RUN: isolated ${candidate.name} profile (${candidate.path})`);
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [testFile], {
      cwd: root,
      env: { ...process.env, PI_CONTROL_CHROME_BROWSER: candidate.path },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal }));
    child.once("error", error => resolve({ code: 1, error }));
  });
  return { candidate, result };
}));
const failure = results.find(({ result }) => result.code !== 0);
if (failure !== undefined) {
  throw new Error(`${failure.candidate.name} isolated E2E failed${failure.result.signal ? ` (${failure.result.signal})` : ""}`);
}
console.log(JSON.stringify({ passed: true, browsers: candidates.map(candidate => candidate.name) }));
