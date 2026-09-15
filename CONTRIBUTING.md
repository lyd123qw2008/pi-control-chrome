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

## Plugin scope: capability layer, not a site adapter

This package is the capability layer: page structure, identity and safety boundaries, and generic primitives (waits, extraction, log matching, evaluate, CDP, tab and browser ownership). Site-specific knowledge belongs to the calling Skill.

- Do not add a product name, a site URL, a site selector, or a domain field name (build/revision/branch/status vocabulary, host or image patterns, and similar) to `extension/`, `bridge/`, the Pi/Codex adapters, or the DSH package. Put that logic in the Skill that owns the workflow, as a read-only bounded page script or a typed `selector` extract.
- A behavior may enter the plugin only when it generalizes to a structural principle that holds for unrelated page archetypes, for example "search, header, footer, breadcrumb, pagination, sidebars, and per-row history controls are utilities or lists, never the primary object".
- When the plugin's structural output is wrong for a specific site, fix the generic ranking or noise rule and add an archetype fixture (landmark-free shell, `<main>` application, business page, log pane, hostile page). Do not add a site special case.
- Prefer caller-supplied literals over plugin-side inference: the plugin exposes primitives such as `waitTerminalStates` and `extractLogMatch` so it never needs to recognize a product's terminal strings itself, and it advertises capabilities so a stale runtime is rejected instead of silently degrading.
- Keep plugin tests on generic invariants; assert domain fields in the Skill that owns them.

The full boundary is documented in [`ARCHITECTURE.md`](./ARCHITECTURE.md) (see "Capability layer and personalization layer") and [`DECISIONS.zh-CN.md`](./DECISIONS.zh-CN.md) (section 10).

## Pull requests

Keep changes focused, explain user-visible behavior, and include the commands used for verification. Changes to browser permissions, tab ownership, cleanup, or Bridge authentication should include a regression test.
