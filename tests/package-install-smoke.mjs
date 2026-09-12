import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? process.execPath : "npm";
const npmArgs = process.platform === "win32"
  ? [process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
  : [];
const runNpm = (args, options) => execFileSync(npm, [...npmArgs, ...args], options);
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "pi-control-chrome-package-smoke-"));
const installRoot = join(temp, "install");
mkdirSync(installRoot);

try {
  const packed = JSON.parse(runNpm([
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    temp,
    "--json",
  ], { cwd: root, encoding: "utf8" }))[0];
  const tarball = join(temp, packed.filename);

  runNpm([
    "install",
    "--ignore-scripts",
    "--omit=peer",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    tarball,
  ], { cwd: installRoot, stdio: "inherit" });

  const installedRoot = join(installRoot, "node_modules", rootManifest.name);
  const installedManifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
  assert.equal(installedManifest.name, rootManifest.name);
  assert.equal(installedManifest.version, rootManifest.version);

  for (const relativePath of [
    "bridge/server.mjs",
    "codex/mcp-server.mjs",
    "extension/manifest.json",
    "pi-extension/output.js",
    "skills/pi-control-chrome/SKILL.md",
    ".codex-plugin/plugin.json",
  ]) {
    assert.equal(existsSync(join(installedRoot, relativePath)), true, `installed package is missing ${relativePath}`);
  }

  const binPath = join(installRoot, "node_modules", ".bin", "pi-control-chrome-codex");
  const windowsBinPath = `${binPath}.cmd`;
  assert.equal(existsSync(binPath) || existsSync(windowsBinPath), true, "installed package bin link is missing");

  execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    "const output = await import('pi-control-chrome/pi-extension/output.js'); if (typeof output.compactBrowserResult !== 'function') process.exit(1);",
  ], { cwd: installRoot, stdio: "inherit" });

  console.log(JSON.stringify({
    passed: true,
    package: installedManifest.name,
    version: installedManifest.version,
    installedRoot,
  }));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
