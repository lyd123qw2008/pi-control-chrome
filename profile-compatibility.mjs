#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PLUGIN_NAME = "@lyd123qw2008/dsh-tool-control-chrome";
const PI_NAME = "pi-control-chrome";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    if (key === "help") {
      result.help = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    result[key] = next;
    index += 1;
  }
  return result;
}

function usage() {
  return [
    "Usage: node profile-compatibility.mjs --profile <profiles/web> [--plugin-version <version>] [--pi-version <version>] [--rollback-profile <profiles/web>]",
    "Checks Profile package.json, pnpm-lock.yaml, and pnpm-workspace.yaml without installing or modifying files.",
  ].join("\n");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function versionFromRange(value) {
  if (typeof value !== "string") return undefined;
  const match = value.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match?.[0];
}

function lockBlock(lock, section, key) {
  const sectionStart = lock.indexOf(`${section}:`);
  if (sectionStart < 0) return "";
  const body = lock.slice(sectionStart + section.length + 1);
  const keyPattern = new RegExp(`\\n  ['"]?${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}['"]?:`);
  const match = keyPattern.exec(body);
  if (!match) return "";
  const start = match.index + 1;
  const remainder = body.slice(start);
  const next = remainder.search(/\n  ['"][^\n]+['"]?:|\n  [A-Za-z0-9_@'"].*:/);
  return next < 0 ? remainder : remainder.slice(0, next);
}

function importerDependency(lock, name) {
  const escaped = name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
  const match = lock.match(new RegExp(`\\n\\s{6}['"]?${escaped}['"]?:\\n\\s{8}specifier:\\s*([^\\n]+)\\n\\s{8}version:\\s*([^\\n]+)`));
  if (!match) return undefined;
  return { specifier: match[1].trim().replace(/^['"]|['"]$/g, ""), version: match[2].trim().replace(/^['"]|['"]$/g, "") };
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

function inspectProfile(profilePath, expected = {}) {
  const profile = resolve(profilePath);
  const errors = [];
  const packageJson = readJson(resolve(profile, "package.json"));
  const lock = readFileSync(resolve(profile, "pnpm-lock.yaml"), "utf8");
  const workspace = readFileSync(resolve(profile, "pnpm-workspace.yaml"), "utf8");
  const pluginVersion = packageJson.dependencies?.[PLUGIN_NAME];
  const piVersion = expected.piVersion;
  const declaredPluginVersion = versionFromRange(pluginVersion);
  const importer = importerDependency(lock, PLUGIN_NAME);
  assert(typeof pluginVersion === "string" && !pluginVersion.startsWith("link:"), `${profile}: package.json must pin ${PLUGIN_NAME}`, errors);
  assert(declaredPluginVersion !== undefined, `${profile}: package.json has no concrete ${PLUGIN_NAME} version`, errors);
  if (expected.pluginVersion !== undefined) assert(declaredPluginVersion === expected.pluginVersion, `${profile}: expected plugin ${expected.pluginVersion}, found ${declaredPluginVersion}`, errors);
  assert(importer !== undefined, `${profile}: pnpm-lock.yaml importer is missing ${PLUGIN_NAME}`, errors);
  if (importer !== undefined) {
    assert(importer.specifier === pluginVersion, `${profile}: lock importer specifier ${importer.specifier} does not match package.json ${pluginVersion}`, errors);
    assert(importer.version === pluginVersion, `${profile}: lock importer version ${importer.version} does not match package.json ${pluginVersion}`, errors);
  }
  const pluginKey = `${PLUGIN_NAME}@${declaredPluginVersion}`;
  const pluginPackageBlock = lockBlock(lock, "packages", pluginKey);
  const pluginSnapshotBlock = lockBlock(lock, "snapshots", pluginKey);
  assert(pluginPackageBlock.length > 0, `${profile}: lock packages entry ${pluginKey} is missing`, errors);
  assert(pluginSnapshotBlock.length > 0, `${profile}: lock snapshots entry ${pluginKey} is missing`, errors);
  const lockedPiMatch = pluginSnapshotBlock.match(/\n\s{6}pi-control-chrome:\s*([^\s\n]+)/);
  const lockedPiVersion = lockedPiMatch?.[1];
  assert(lockedPiVersion !== undefined, `${profile}: ${pluginKey} snapshot does not resolve pi-control-chrome`, errors);
  if (piVersion !== undefined) {
    assert(lockedPiVersion === piVersion, `${profile}: expected pi-control-chrome ${piVersion}, found ${lockedPiVersion}`, errors);
    assert(lock.includes(`  ${PI_NAME}@${piVersion}:`), `${profile}: lock packages entry ${PI_NAME}@${piVersion} is missing`, errors);
    assert(lock.includes(`  ${PI_NAME}@${piVersion}:`), `${profile}: lock snapshots entry ${PI_NAME}@${piVersion} is missing`, errors);
  }
  const workspaceAllows = (name, version) => workspace.split(/\r?\n/).some(line => line.includes(name) && new RegExp(`(?:^|[|\\s])${version.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:$|[|\\s'\"])`).test(line));
  assert(workspaceAllows(PLUGIN_NAME, declaredPluginVersion), `${profile}: workspace release-age allowlist omits ${PLUGIN_NAME}@${declaredPluginVersion}`, errors);
  if (lockedPiVersion !== undefined) assert(workspaceAllows(PI_NAME, lockedPiVersion), `${profile}: workspace release-age allowlist omits ${PI_NAME}@${lockedPiVersion}`, errors);
  return { profile, pluginVersion: declaredPluginVersion, piVersion: lockedPiVersion, errors };
}

const args = parseArgs(process.argv.slice(2));
if (args.help === true) {
  console.log(usage());
  process.exit(0);
}
const profile = args.profile ?? process.env.DSH_PROFILE_WEB;
if (!profile) {
  console.error(usage());
  process.exit(2);
}
const expectedPluginVersion = args["plugin-version"];
const expectedPiVersion = args["pi-version"];
const current = inspectProfile(profile, { pluginVersion: expectedPluginVersion, piVersion: expectedPiVersion });
const rollback = args["rollback-profile"] === undefined ? undefined : inspectProfile(args["rollback-profile"]);
const errors = [...current.errors, ...(rollback?.errors ?? [])];
const result = {
  ok: errors.length === 0,
  current,
  ...(rollback === undefined ? {} : { rollback }),
};
console.log(JSON.stringify(result, null, 2));
if (errors.length > 0) process.exit(1);
