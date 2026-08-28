# pi-control-chrome

[English](./README.md) · [简体中文](./README-zh-CN.md)

Codex-aligned Chrome and Edge browser control for Pi. It reuses the user's existing Chromium profile through a local WebSocket Bridge and a Manifest V3 extension.

> The Stage 1/2 core implementation is complete. Later-stage capabilities remain tracked separately in [`FEATURES.md`](./FEATURES.md).

## What it provides

- Reuses the current Chrome or Edge profile, login state, cookies, extensions, and tabs.
- Lets Pi inspect and claim explicitly selected existing tabs without moving them by default.
- Places Agent-created tabs in a dedicated blue `Pi` tab group.
- Tracks Agent ownership, sessions, `handoff`, and `deliverable` lifecycle states.
- Closes unmarked Agent temporary tabs at turn end, releases claimed user tabs without closing them, and preserves only handoff or deliverable tabs marked for the current turn.
- Provides DOM, accessibility, locator, coordinate, and native CDP controls.
- Supports screenshots, page extraction, Console, Network, JavaScript dialogs, file upload, downloads, and clipboard text.
- Captures ordinary active-tab viewport screenshots without opening a DevTools debugger session; full-page and background-tab captures use a short session-owned debugger lease.
- Persists debugger lease identity across an MV3 worker restart. Ordinary cleanup reports an unverified old lease instead of detaching an untracked target; explicit stale recovery verifies the current tab fence and CDP target identity before detaching it.
- Fences tab handles with a tab incarnation and document identity. Navigation invalidates page snapshots, locator refs, DOM-CUA node ids, dialog/file-chooser observations, and Network request-loader mappings; side-effecting operations that lose that identity return an uncertain result and are not replayed automatically.
- Includes a reusable `pi-control-chrome` Skill. Browser tool schemas are hidden until that Skill is explicitly loaded for the current session; the bundled CLI remains available for explicit human/developer workflows and tests.

## Semantic page interaction

The common click and form tools accept a semantic `target` such as `{ "role": "button", "name": "Submit" }`, `{ "label": "Email" }`, `{ "placeholder": "Search" }`, `{ "text": "Next" }`, or `{ "testId": "submit-button" }`. Semantic interactions wait for one visible match and fail closed when a target is missing, hidden, disabled, or ambiguous; use an explicit zero-based `index` only when multiple matches are intentional. `browser_snapshot` returns snapshot-scoped `eN` refs and a `snapshotId`; pass that `snapshotId` with every ref-based interaction or element-state wait. CSS selectors remain supported.

Text targets used by action and element-state locators project a matching text leaf to its nearest actionable ancestor, so `isEnabled` and `browser_wait` report the state of the control that receives the action. `browser_wait` supports `load`, `url`, `text`, `text_gone`, `visible`, `hidden`, and `enabled`. Text conditions use `text`; element conditions use the same semantic `target` accepted by interactions. `url` and `urlIncludes` can constrain every wait condition. `hidden` succeeds when the target has no visible matches, including an absent target or multiple hidden matches; `visible` and `enabled` require one visible match, and multiple visible matches fail closed. Browser page matching runs inside the selected tab, while the Bridge continues to enforce the existing browser target and connection-generation fence. If a side-effecting interaction loses its injected result after navigation, it reports an uncertain outcome and is never replayed automatically.

## Architecture

```text
Pi Extension
     ↕ WebSocket
127.0.0.1 Local Bridge
     ↕ WebSocket
Chrome / Edge Manifest V3 Extension
     ↕
Current Chromium Profile
```

The Bridge binds to loopback and requires a local pairing token for WebSocket operations. Its `/pair` bootstrap response is intentionally available to any caller on that loopback port so an unpacked extension can pair without reading the host token file; any local process or installed extension that can reach the port is therefore trusted with browser control. Keep the Bridge port off network proxies. Host-launched instances expose a non-secret instance id, launcher label and capability list; any paired DSH or Pi Host in the same local-user control domain may request a cooperative restart when the Bridge exposes `capabilities.localUserRestart: true` and has no pending browser request. The instance id prevents stale restart races, and a restart lock serializes concurrent requests. Unknown legacy Bridges remain untouched when they do not expose the local-user capability. Installing the extension and completing local pairing are the trust steps; normal browser operations do not request repeated per-action authorization.

## Installation

### From npm (recommended)

```powershell
pi install npm:pi-control-chrome
```

### From GitHub

```powershell
pi install git:github.com/lyd123qw2008/pi-control-chrome
```

### From a local checkout

```powershell
pi install <path-to>/pi-control-chrome
```

The package registers the Pi extension and the bundled Skill through its `package.json` `pi` manifest. It requires Node.js 22 or newer.

### DSH integration

This repository also contains the standalone [`@lyd123qw2008/dsh-tool-control-chrome`](./dsh-tool-control-chrome/README.md) package. It registers the same browser-control surface as model-facing DeepSeek Harness tools and routes calls through the local Bridge. Install the DSH package in the active DSH Profile, merge the `insert` entry from its `config/cordis.patch.yml.example` into the existing `cordis.patch.yml`, and keep Bridge settings in `<DSH_HOME>/settings.yaml`.

The DSH package reuses this project's Bridge and Manifest V3 extension. Its default `lazyTools: true` mode exposes only the `pi-control-chrome` Skill metadata initially; after a successful Skill load, all 39 `browser_*` tools are registered in that Agent and remain active across turns in the current Agent session. At turn end, the host closes unmarked Agent temporary tabs, releases claimed user tabs without closing them, and detaches the session debugger lease. Bridge, browser tools, and Browser binding remain available for later turns. A model must call `browser_mark_handoff` or `browser_mark_deliverable` to preserve an Agent tab through the current turn cleanup, and repeat the mark in a later turn when needed. Only an explicit user request to close temporary tabs, release claims, or clean the browser task may trigger `browser_cleanup`; it performs immediate task cleanup while retaining the lazy tools and healthy Bridge. `browser_context_reset` is the separate explicit user-requested operation that finalizes resources and deactivates lazy tools. Agent and plugin disposal retry final cleanup; failed recovery blocks a replacement Agent that reuses the same session ID until cleanup succeeds. Set `lazyTools: false` for eager visibility. Pi registers the same native tools once but hides them with its active-tool set until the explicit `/skill:pi-control-chrome` expansion or another successful Skill activation. Ordinary web search does not activate browser control. The DSH package also provides human-only `/chrome status`, `/chrome targets`, `/chrome profile [browserId]`, `/chrome connect`, `/chrome disconnect`, `/chrome doctor`, `/chrome restart`, and `/chrome tabs` commands. It does not install browser extensions automatically, read Chrome Profile files, or expose the Bridge beyond loopback.

## Load the browser extension

Pi cannot install an unpacked browser extension automatically. Load the shared `extension/` directory once in Chrome or Edge:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository or installed package's `extension/` directory.
5. Start or reload Pi.

Check the connection in Pi:

```text
/chrome status
/chrome targets
/chrome profile <browserId>
/chrome tabs
```

The extension is shared by Chrome and Edge and uses Chromium Manifest V3 capability detection rather than separate browser-specific implementations. One Bridge can now keep multiple identified browser targets connected at once. Each target is keyed by its stable `browserId`; requests use target-qualified routing and connection-generation fencing, so a newer connection for Profile A cannot replace Profile B or satisfy Profile A's stale requests. When multiple targets are available, select one explicitly with `/chrome profile <browserId>` or `browser_status`/the Skill CLI `--browser-id`; the runtime never guesses from the newest connection or active window.

## Skill CLI

The bundled scripts are for explicit human/developer workflows and automated tests. They connect to the Bridge directly and must not be invoked by a model shell as a substitute for the Skill-gated native tools:

```powershell
node skills/pi-control-chrome/scripts/browser.mjs status --browser-id <browserId>
node skills/pi-control-chrome/scripts/browser.mjs tabs --browser-id <browserId> --json
node skills/pi-control-chrome/scripts/browser.mjs group --browser-id <browserId> --json
node skills/pi-control-chrome/scripts/browser.mjs view https://example.com --browser-id <browserId> --session example-session --turn 1 --screenshot "$env:TEMP\example.png"
node skills/pi-control-chrome/scripts/browser.mjs cleanup --browser-id <browserId> --session <session-id> [--recover-stale]
```

Managed CLI commands use explicit lifecycle identity: `open` and `cleanup` require `--session <id>`, and `view` requires both `--session <id>` and `--turn <n>` unless it is explicitly temporary. The CLI does not derive ownership from a process id, so a later invocation can address the same tabs safely. Use `cleanup --recover-stale` only for an explicit recovery decision after an extension runtime change; it forgets matching unknown-incarnation ownership records without closing those tabs and reports their ids in `recovered` for manual inspection.

The bundled scripts support these environment variables. The Pi extension also accepts `PI_CONTROL_CHROME_BRIDGE_PORT` when the local Bridge uses another loopback port; its host remains `127.0.0.1`:

```text
PI_CONTROL_CHROME_BRIDGE_HOST   # bundled CLI only
PI_CONTROL_CHROME_BRIDGE_PORT   # bundled CLI and Pi extension
```

The checked-in browser extension still connects to `127.0.0.1:17318` and its manifest CSP allowlist is fixed to that endpoint. Use a matching rebuilt extension and CSP before pointing the Pi extension or DSH client at another endpoint.

Use the native `browser_*` Pi or DSH tools for model browser work. They preserve the current Agent session, target identity, and tab ownership protections.

## Development and tests

```powershell
cd <path-to>/pi-control-chrome
npm install
npm run check
npm test
npm run test:pi:lifecycle
npm run test:skill
npm run pack:check
```

`npm run test:skill` requires a connected Chrome or Edge profile and the local Bridge. The high-coverage browser smoke test is:

```powershell
npm run smoke:e2e
```

The multi-target acceptance test launches two isolated temporary Edge/Chrome profiles and verifies explicit routing, target disconnect isolation, and same-Profile reconnection fencing:

```powershell
npm run smoke:e2e:multi-profile
```

The smoke test defaults to Edge. Run the same coverage against Chrome for Testing with:

```powershell
$env:PI_CONTROL_CHROME_BROWSER = "<path-to>\chrome-for-testing\chrome.exe"
npm run smoke:e2e
```

This requests a unique temporary `--user-data-dir` rather than the normal user profile. The harness fails if the browser process exits before the extension handshake, which detects common Windows singleton delegation; Chrome for Testing provides the most reliable isolated executable. The installed Google Chrome may reject command-line unpacked-extension flags; load `extension/` manually from `chrome://extensions` for a normal-profile check.

## Design principles

1. **Install once, operate with low friction.** Extension installation and local pairing are the user-facing trust steps.
2. **The extension is the browser capability boundary.** Pi communicates with it only through the local Bridge.
3. **User tabs are preserved by default.** Claiming a tab establishes control ownership; it does not move the tab into the Agent group.
4. **Agent tabs are reclaimable.** Agent-created tabs carry ownership and session metadata and are cleaned up according to lifecycle policy.
5. **Chrome and Edge share one implementation.** The extension uses Manifest V3 and capability detection.
6. **Observable behavior is aligned without copying private Codex runtime code.** Pi uses its own Bridge protocol and Extension API.

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — English architecture documentation.
- [`README-zh-CN.md`](./README-zh-CN.md) — Simplified Chinese guide.
- [`FEATURES.md`](./FEATURES.md) — feature scope and future work.
- [`CODEX-ALIGNMENT.zh-CN.md`](./CODEX-ALIGNMENT.zh-CN.md) — Codex behavior alignment notes.
- [`DECISIONS.zh-CN.md`](./DECISIONS.zh-CN.md) — project decisions.
- [`docs/RELEASE-CHECKLIST.zh-CN.md`](./docs/RELEASE-CHECKLIST.zh-CN.md) — package/version, dependency, PR, npm publication and active DSH Profile release checklist.
- [`skills/pi-control-chrome-release/SKILL.md`](./skills/pi-control-chrome-release/SKILL.md) — executable release procedure for Pi and DSH packages.
- [`skills/pi-control-chrome/SKILL.md`](./skills/pi-control-chrome/SKILL.md) — bundled Pi Skill.
- [`CHANGELOG.md`](./CHANGELOG.md) — release history.
- [`BROWSER-ACTIVATION-DESIGN.zh-CN.md`](./BROWSER-ACTIVATION-DESIGN.zh-CN.md) — browser capability activation and on-demand Skill design.
- [`docs/BROWSER-LIFECYCLE-CODEX-ALIGNED.zh-CN.md`](./docs/BROWSER-LIFECYCLE-CODEX-ALIGNED.zh-CN.md) — implemented Codex-aligned browser lifecycle.

## Current future scope

The following items are planned for later stages and do not block the current browser-control loop:

- WebMCP, GSuite export, and browsing history APIs.
- Dedicated media-download interfaces.
- Capability discovery beyond the current Bridge target and extension capability handshake.
- Chrome Web Store and Edge Add-ons release packages.
- Dedicated Brave and Chromium acceptance coverage.
- Cross-Bridge orchestration and simultaneous multi-target control within one session.

## License

MIT. See [`LICENSE`](./LICENSE).
