import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const checker = join(root, "profile-compatibility.mjs");

function fixtureProfile(pluginVersion = "0.5.7", piVersion = "0.5.8") {
  const profile = mkdtempSync(join(tmpdir(), "pi-control-chrome-profile-compatibility-"));
  writeFileSync(join(profile, "package.json"), JSON.stringify({ dependencies: { "@lyd123qw2008/dsh-tool-control-chrome": pluginVersion } }));
  writeFileSync(join(profile, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      '@lyd123qw2008/dsh-tool-control-chrome':\n        specifier: ${pluginVersion}\n        version: ${pluginVersion}\n\npackages:\n  '@lyd123qw2008/dsh-tool-control-chrome@${pluginVersion}':\n    resolution: {integrity: sha512-test}\n  pi-control-chrome@${piVersion}:\n    resolution: {integrity: sha512-test}\n\nsnapshots:\n  '@lyd123qw2008/dsh-tool-control-chrome@${pluginVersion}':\n    dependencies:\n      pi-control-chrome: ${piVersion}\n  pi-control-chrome@${piVersion}: {}\n`);
  writeFileSync(join(profile, "pnpm-workspace.yaml"), `minimumReleaseAgeExclude:\n  - '@lyd123qw2008/dsh-tool-control-chrome@0.5.6 || ${pluginVersion}'\n  - pi-control-chrome@0.5.7 || ${piVersion}\n`);
  return profile;
}

test("Profile compatibility checker validates current and rollback-compatible metadata", () => {
  const current = fixtureProfile();
  const rollback = fixtureProfile("0.5.6", "0.5.7");
  try {
    const result = spawnSync(process.execPath, [checker, "--profile", current, "--plugin-version", "0.5.7", "--pi-version", "0.5.8", "--rollback-profile", rollback], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.rollback.pluginVersion, "0.5.6");
    assert.equal(parsed.rollback.piVersion, "0.5.7");
  } finally {
    rmSync(current, { recursive: true, force: true });
    rmSync(rollback, { recursive: true, force: true });
  }
});

test("Profile compatibility checker rejects a version mismatch", () => {
  const profile = fixtureProfile();
  try {
    const result = spawnSync(process.execPath, [checker, "--profile", profile, "--plugin-version", "0.5.8", "--pi-version", "0.5.8"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /expected plugin 0\.5\.8/);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
