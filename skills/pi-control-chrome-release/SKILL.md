---
name: pi-control-chrome-release
description: Prepare, review, merge, publish, and locally consume pi-control-chrome and its DSH integration package. Use whenever a maintainer asks to commit, create or merge a release PR, publish an npm package, bump package versions, or update an active DSH Profile after release.
compatibility: Requires the pi-control-chrome checkout, Git, GitHub CLI authentication, npm, Corepack pnpm, and access to the repository's Trusted Publishing workflows.
---

# Pi Control Chrome Release

Use this Skill only for explicit maintainer release and dependency-update work. It is separate from the browser-control Skill. Do not publish, commit, merge, or modify an active DSH Profile until the release matrix below has been inspected and the requested release scope is explicit.

The full Chinese checklist is [`docs/RELEASE-CHECKLIST.zh-CN.md`](../../docs/RELEASE-CHECKLIST.zh-CN.md). This Skill is the executable release procedure; the checklist is the detailed reference.

## Non-negotiable release rules

- Inspect every package name and version from its files before making a change. Never infer a target version from the last release.
- Treat the Pi root package, browser extension Manifest, DSH package, private `dsh-profile-config` source repository, and active DSH Profile as separate release surfaces.
- Never publish `dsh-profile-config` itself to npm. Update it through its own private repository PR after the public package releases.
- Do not assume that updating a dependency specifier updates a lockfile, an `overrides` entry, a nested installed package, or an active Profile.
- Do not publish from a local npm login. Use the existing GitHub Actions Trusted Publishing workflows.
- Do not overwrite a published npm version. If a release is incomplete, use a new patch version.
- Before a commit, push, merge, or publish, report the package/version matrix and stop for clarification if the scope is ambiguous.

## Release surfaces

| Surface | Version source | Dependency and metadata checks | Publish or update path |
| --- | --- | --- | --- |
| `pi-control-chrome` | `package.json` | `package-lock.json`, `CHANGELOG.md` | `publish-pi-control-chrome.yml` |
| MV3 extension | `extension/manifest.json` | `extension/background.js`; confirm whether its version follows the root package | Ships with the Pi package; do not silently assume its version is identical |
| `@lyd123qw2008/dsh-tool-control-chrome` | `dsh-tool-control-chrome/package.json` | `pnpm-lock.yaml`, `pnpm-workspace.yaml`, README install examples | `publish-dsh-tool-control-chrome.yml` |
| Private `dsh-profile-config` source | `profiles/web/package.json`, `.agent-presets/` | `profiles/web/pnpm-lock.yaml`, `profiles/web/pnpm-workspace.yaml`, `.agent-presets/*/preset.yml`, `.agent-presets/*/agent.cordis.yml`, README, bootstrap scripts | Update in a separate private Profile configuration PR after npm publication; never publish it |
| Active DSH Profile | `<DSH_HOME>/profiles/web/package.json` | Profile lockfile and `pnpm-workspace.yaml` overrides | Update only after npm publication, then restart DSH |

## Phase 1: inspect before editing

Run from the repository root and record the results:

```powershell
git status --short --branch
git remote -v
gh auth status
npm pkg get name version
npm --prefix dsh-tool-control-chrome pkg get name version
npm view pi-control-chrome version dist-tags --json
npm view @lyd123qw2008/dsh-tool-control-chrome version dist-tags --json
```

If a `dsh-profile-config` checkout is present, also read `profiles/web/package.json`, `profiles/web/pnpm-lock.yaml`, `profiles/web/pnpm-workspace.yaml`, `.agent-presets/*/preset.yml`, `.agent-presets/*/agent.cordis.yml`, the README package list, and the bootstrap scripts before choosing a target. Read all package manifests, lockfiles, `CHANGELOG.md`, and both publish workflows. Build this matrix before editing:

```text
surface/package                         current       target        dependency target       workflow
pi-control-chrome                       <read>        <confirm>     <read>                 publish-pi-control-chrome.yml
extension/manifest.json                 <read>        <confirm>     n/a                    root package
@lyd123qw2008/dsh-tool-control-chrome   <read>        <confirm>     pi-control-chrome       publish-dsh-tool-control-chrome.yml
dsh-profile-config Profile              <read>        <confirm>     DSH <target>            separate Profile PR
active DSH Profile                      <read>        <confirm>     pi-control-chrome       local install
```

A DSH release is not complete when only the root package has been bumped. A Pi release is not complete when only the extension Manifest has been reloaded. Ask the maintainer to choose the exact package set when the matrix has more than one plausible target.

## Phase 2: prepare and test

When DSH depends on a new Pi release, use this order:

1. Prepare the Pi root package, extension code/Manifest decision, tests, lockfile, and Changelog in a focused PR.
2. Run the root checks:

   ```powershell
   npm run check
   npm run test:all
   npm run pack:check
   ```

3. Merge the Pi PR only after CI passes.
4. Publish the root package with `publish-pi-control-chrome.yml`.
5. Verify the published metadata before touching DSH:

   ```powershell
   npm view pi-control-chrome@<pi-version> version dist-tags dependencies --json
   ```

6. Update the DSH package dependency specifier, `dsh-tool-control-chrome/pnpm-lock.yaml`, `dsh-tool-control-chrome/pnpm-workspace.yaml`, and README examples. Inspect `overrides.pi-control-chrome`; it can keep an old Bridge package even when the DSH dependency says otherwise.
7. Bump the DSH package's own version. Run:

   ```powershell
   corepack pnpm --dir dsh-tool-control-chrome run pack:check
   ```

8. Create and merge the DSH release PR, then publish with `publish-dsh-tool-control-chrome.yml`.
9. Verify the published DSH metadata:

   ```powershell
   npm view @lyd123qw2008/dsh-tool-control-chrome@<dsh-version> version dist-tags dependencies --json
   ```

The workflow must pass its install, typecheck, test, build, pack, and publish steps. A local `npm pack --dry-run` is not evidence that npm publication succeeded.

## Phase 3: update private `dsh-profile-config` source

`dsh-profile-config` is a separate private repository and the source of truth for new-machine bootstrap. It is not an npm package and must not be published. After the public Pi and DSH packages are visible on npm:

1. Update `profiles/web/package.json`, `profiles/web/pnpm-lock.yaml`, `profiles/web/pnpm-workspace.yaml`, `.agent-presets/*/preset.yml`, `.agent-presets/*/agent.cordis.yml`, README package examples, and bootstrap-related documentation in the private repository.
2. Ensure both bootstrap scripts copy `.agent-presets/` into `DSH_HOME/.agent-presets` without deleting unrelated user presets.
3. Inspect any `pi-control-chrome` override and update it to the target root version; add the target to `minimumReleaseAgeExclude` when that policy is enabled.
4. Run the Profile checks from that repository:

   ```powershell
   corepack pnpm --dir profiles/web install --frozen-lockfile
   corepack pnpm --dir profiles/web list @lyd123qw2008/dsh-tool-control-chrome --depth 0
   corepack pnpm --dir profiles/web why pi-control-chrome
   ```

5. Create and merge a separate private Profile configuration PR. Do not mix its files into the public `pi-control-chrome` release PR and do not trigger an npm publish for this repository.

## Phase 4: update and verify active DSH Profile

The active Profile is outside this repository. After both npm packages are available, install the exact DSH version:

```powershell
corepack pnpm --dir <DSH_HOME>/profiles/web add @lyd123qw2008/dsh-tool-control-chrome@<dsh-version>
```

Then inspect and fix any root package override before installing again:

```powershell
corepack pnpm --dir <DSH_HOME>/profiles/web why pi-control-chrome
corepack pnpm --dir <DSH_HOME>/profiles/web install
corepack pnpm --dir <DSH_HOME>/profiles/web list @lyd123qw2008/dsh-tool-control-chrome --depth 0
corepack pnpm --dir <DSH_HOME>/profiles/web why pi-control-chrome
```

If the Profile contains `overrides.pi-control-chrome: <old-version>`, update it to the target root version and add the target to `minimumReleaseAgeExclude` when that policy is enabled. Confirm both the installed DSH package and the transitive Pi package from `node_modules` or `pnpm why`; the Profile `package.json` alone is insufficient.

Restart DSH after the Profile install. Load the separate `pi-control-chrome` Skill before browser operations, then verify:

- `/chrome status` or `browser_status` reports `connected: true` for the selected target; use `/chrome targets` and `/chrome profile <browserId>` when multiple targets are ready;
- Bridge health reports the target root version;
- the extension is connected;
- `targetStability.stable: true`;
- `turnCleanup`, `turnScopedMarks`, `retainedCleanup`, `debuggerLeaseRecovery`, and `tabIncarnationFence` are available;
- a read-only browser operation succeeds.

The extension Manifest version may differ from the npm root package version. Use Bridge health, Profile dependency resolution, and npm metadata together.

## Timeout and recovery classification

Do not treat every timeout as a package defect:

- npm/pnpm download timeouts concern registry or optional platform artifacts; rerun the smallest install command after diagnosing the network failure.
- `bridge_only` or `extension_not_connected` concerns the extension connection; retry `browser_status` once, then reload the unpacked extension or use `/chrome connect` as directed by the browser Skill.
- Snapshot/locator timeouts can come from unloaded pages or very large DOMs; retry against a small, targeted page instead of repeating a full-tab query.
- Record which phase failed. Do not publish or bump another version until package metadata and runtime state are separately verified.

## Definition of done

A release is complete only when all of these are true:

- the release matrix was inspected and reported;
- every intended package version and README example is correct;
- relevant lockfiles and Profile overrides resolve the target dependency;
- the correct PR was merged with passing CI;
- the matching Trusted Publishing workflow passed;
- the private `dsh-profile-config` PR updated the bootstrap source without publishing that repository;
- `npm view` confirms the published version and dependencies;
- active Profile installation and `pnpm why` show the target versions when a local update was requested;
- DSH was restarted and browser readiness was verified when runtime validation was requested;
- no unrelated Profile, browser tab, credential, or generated session file was changed.
