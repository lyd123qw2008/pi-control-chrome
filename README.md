# pi-control-chrome

[English](./README.md) · [简体中文](./README-zh-CN.md)

Codex-aligned Chrome and Edge browser control for Pi. It reuses the user's existing Chromium profile through a local WebSocket Bridge and a Manifest V3 extension.

> The Stage 1/2 core implementation is complete. Later-stage capabilities remain tracked separately in [`FEATURES.md`](./FEATURES.md).

## What it provides

- Reuses the current Chrome or Edge profile, login state, cookies, extensions, and tabs.
- Lets Pi inspect and claim explicitly selected existing tabs without moving them by default.
- Places Agent-created tabs in a dedicated blue `Pi` tab group.
- Tracks Agent ownership, sessions, `handoff`, and `deliverable` lifecycle states.
- Cleans up temporary Agent tabs at the end of a session while preserving user and handoff tabs.
- Provides DOM, accessibility, locator, coordinate, and native CDP controls.
- Supports screenshots, page extraction, Console, Network, JavaScript dialogs, file upload, downloads, and clipboard text.
- Includes a reusable `pi-control-chrome` Skill and a fast CLI for common browser workflows.

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

The Bridge binds to loopback and requires a local pairing token. Host-managed Bridge instances also expose a non-secret instance id, owner, and capability list; only the owning host can request a cooperative restart. Unknown legacy instances are left untouched. Installing the extension and completing local pairing are the trust boundary; normal browser operations do not request repeated per-action authorization.

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

This repository also contains the standalone [`@lyd123qw2008/dsh-tool-control-chrome`](./dsh-tool-control-chrome/README.md) package. It registers the same browser-control surface as model-facing DeepSeek Harness tools and routes calls through the local Bridge. Install the DSH package in the active DSH Profile, copy its `config/cordis.patch.yml.example`, and keep Bridge settings in `<DSH_HOME>/settings.yaml`.

The DSH package reuses this project's Bridge and Manifest V3 extension. It does not install browser extensions automatically, read Chrome Profile files, or expose the Bridge beyond loopback.

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
/chrome tabs
```

The extension is shared by Chrome and Edge and uses Chromium Manifest V3 capability detection rather than separate browser-specific implementations. One Bridge endpoint currently accepts one active extension connection. Chrome and Edge may both remain open, but loading the shared extension in both against the same Bridge makes the newer connection replace the older one; use one controlled browser per Bridge.

## Skill CLI

The bundled Skill provides a fast CLI for common workflows without generating temporary Bridge code:

```powershell
node skills/pi-control-chrome/scripts/browser.mjs status
node skills/pi-control-chrome/scripts/browser.mjs tabs --json
node skills/pi-control-chrome/scripts/browser.mjs group --json
node skills/pi-control-chrome/scripts/browser.mjs view https://example.com --screenshot "$env:TEMP\example.png"
node skills/pi-control-chrome/scripts/browser.mjs cleanup --session <session-id>
```

The CLI reuses the currently connected browser and supports these environment variables:

```text
PI_CONTROL_CHROME_BRIDGE_HOST
PI_CONTROL_CHROME_BRIDGE_PORT
PI_CONTROL_CHROME_TOKEN_FILE
```

Use the `browser_*` Pi tools for complex interactions, locators, CUA, CDP, dialogs, uploads, downloads, and other page-specific controls.

## Development and tests

```powershell
cd <path-to>/pi-control-chrome
npm install
npm run check
npm test
npm run test:skill
npm run pack:check
```

`npm run test:skill` requires a connected Chrome or Edge profile and the local Bridge. The high-coverage browser smoke test is:

```powershell
npm run smoke:e2e
```

The smoke test defaults to Edge. Run the same coverage against Chrome for Testing with:

```powershell
$env:PI_CONTROL_CHROME_BROWSER = "<path-to>\chrome-for-testing\chrome.exe"
npm run smoke:e2e
```

This uses an isolated temporary browser profile and does not touch the normal user profile. The installed Google Chrome may reject command-line unpacked-extension flags; load `extension/` manually from `chrome://extensions` for a normal-profile check.

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
- [`skills/pi-control-chrome/SKILL.md`](./skills/pi-control-chrome/SKILL.md) — bundled Pi Skill.
- [`CHANGELOG.md`](./CHANGELOG.md) — release history.

## Current future scope

The following items are planned for later stages and do not block the current browser-control loop:

- Parallel control of multiple browser profiles.
- WebMCP, GSuite export, and browsing history APIs.
- Dedicated media-download interfaces.
- Capability discovery.
- Chrome Web Store and Edge Add-ons release packages.
- Dedicated Brave and Chromium acceptance coverage.

## License

MIT. See [`LICENSE`](./LICENSE).
