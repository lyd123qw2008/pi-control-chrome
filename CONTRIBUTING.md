# Contributing

## Development setup

```powershell
npm install
```

Load `extension/` as an unpacked Chrome or Edge Manifest V3 extension, then make sure the local Bridge is reachable at `127.0.0.1:17318`.

## Checks and tests

Run the fast checks and deterministic Bridge test:

```powershell
npm run check
npm test
```

Run the live Skill script integration test when an Edge or Chrome profile with the extension is connected:

```powershell
npm run test:skill
```

Run the high-coverage browser smoke test with an isolated test profile:

```powershell
npm run smoke:e2e
npm run smoke:e2e:multi-profile
```

Do not commit browser profiles, Bridge tokens, credentials, screenshots containing private data, or generated session files.

## Publishing and release checklist

Before any version bump, release commit, pull request, merge, npm publication, or active-Profile dependency update, follow [`skills/pi-control-chrome-release/SKILL.md`](./skills/pi-control-chrome-release/SKILL.md) and the detailed [`docs/RELEASE-CHECKLIST.zh-CN.md`](./docs/RELEASE-CHECKLIST.zh-CN.md). Inspect the Pi root package, extension Manifest, DSH package, private `dsh-profile-config` source repository, lockfiles, `pnpm-workspace.yaml` overrides, active DSH Profile, and both publish workflows as one release matrix. Do not infer versions or assume that publishing one package publishes the other; `dsh-profile-config` gets a separate private configuration PR and is never published to npm.

The Pi and DSH packages are published from GitHub Actions, not from a local npm login. The existing workflows are [`Publish Pi Control Chrome`](.github/workflows/publish-pi-control-chrome.yml) and [`Publish DSH Chrome Control Package`](.github/workflows/publish-dsh-tool-control-chrome.yml); do not create a second npm publishing workflow. Verify each result with `npm view <package>@<version> version dist-tags dependencies --json`. Update the active DSH Profile only after the npm package is visible, inspect and correct any old `pi-control-chrome` override, install with a frozen lockfile when appropriate, and restart DSH before runtime verification. The npm packages must have these GitHub workflows configured as their npm Trusted Publishers; the workflows use the `id-token: write` permission.

## Pull requests

Keep changes focused, explain user-visible behavior, and include the commands used for verification. Changes to browser permissions, tab ownership, cleanup, or Bridge authentication should include a regression test.
