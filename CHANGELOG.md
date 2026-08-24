# Changelog

## Unreleased

- Reused a short-lived, session-owned debugger lease across consecutive browser operations instead of attaching and detaching Chrome DevTools for every call; explicit Console/Network/CDP capture remains persistent and cleanup still releases it.
- Captured ordinary active-tab viewport screenshots through the extension API, reserving DevTools attachment for full-page and background-tab captures.
- Fixed explicit user-requested close to remove ownership metadata even when the target tab belongs to another Agent session.

- Added explicit `pi-control-chrome` Skill gating for Pi and DSH browser tools. DSH defaults to `lazyTools: true` and registers all 38 tools in the current Agent only after a successful Skill load; `lazyTools: false` preserves eager visibility. Pi hides the native browser tool set until explicit Skill expansion, and activation resets at session boundaries without starting the Bridge during session startup.

- Fixed `browser_locator` filtering with `hasSelector`.
- Restricted pairing and health CORS responses to valid Chromium extension origins instead of exposing the pairing response to webpages.
- Added persisted per-Profile browser identity and Pi-side `expectedBrowserId` acknowledgement/preflight handling.
- Enforced session ownership for claim, release, lifecycle marking, Agent cleanup, persistent DevTools cleanup and Agent tab close; unowned user-tab close now requires explicit `userRequested: true`.
- Added Bridge lifecycle fencing, endpoint-aware DSH websocket reuse, shared restart capability checks and startup health reuse.
- Removed the unused Skill CLI token-file setting and clarified Profile patch merging and current architecture documentation.

## 0.3.2

- Removed the unused `webNavigation` extension permission and private debugger-detach state.
- Simplified Pi Bridge health polling and replaced the hand-rolled HTTP JSON helper with Node's built-in fetch.
- Removed unconsumed Pi client health telemetry and development-only test files from the npm artifact.
- Removed unused browser tool schema fields for accessibility hints, network timeouts and download tab scoping.

## 0.3.1

- Added an explicit local-user restart capability marker so updated Hosts reject older owner-token restart protocols instead of reporting false recovery availability.

## 0.3.0

- Added non-secret instance, launcher and capability metadata to Bridge health and pairing handshakes.
- Added local-user cooperative Bridge restart with instance-race, pending-request and concurrent-restart checks; DSH and Pi Hosts share the restart authority through the authenticated local pairing channel.
- Added DSH `/chrome status|doctor|restart|tabs` commands and kept browser tabs untouched during Bridge restart.
- Added an extension identity handshake and atomic Bridge validation for `expectedBrowserId`, preventing a request from crossing an Edge/Chrome replacement.
- The DSH plugin now rejects an older running Bridge that cannot expose the active browser identity needed for atomic target routing.

## 0.2.4 - 2026-08-17

- Renamed the Chinese README filename so npm and Pi consistently select the English `README.md` as the default package documentation.

## 0.2.3 - 2026-08-17

- Made the default `README.md` English for international Pi and npm users.
- Added an explicit English/Chinese language switch at the top of both README files.

## 0.2.2 - 2026-08-17

- Fixed Agent-created tabs not actually moving into the existing Pi tab group when a Pi group already existed.
- Added the fast `skills/pi-control-chrome/scripts/browser.mjs` CLI for status, tabs, groups, open/view, extraction, screenshots, close and cleanup workflows.

## 0.2.1 - 2026-08-17

- Fixed MV3 Bridge reconnects after the Service Worker goes idle by declaring the `alarms` permission used by the periodic reconnect logic.

## 0.2.0 - 2026-08-17

- Added the bundled `pi-control-chrome` Skill with browser tool selection, tab ownership, cleanup, safety and troubleshooting guidance.
- Added the package `pi.skills` manifest entry for automatic Skill discovery.
- Added Playwright-style locator operations (`css`, role, text, label, placeholder and test id) with count, filtering, indexing, text/attribute/state queries and actions.
- Added accessibility-oriented page snapshots, bounded Markdown/plain-text extraction, viewport/selection metadata and frame-tree information.
- Added DOM CUA and coordinate CUA for mouse, keyboard, scrolling, dragging and text input.
- Added persistent CDP DevTools capture for Console, Network, lifecycle, JavaScript dialogs and file chooser events.
- Added native file upload, browser download lifecycle control and plain-text clipboard read/write.
- Added stale snapshot IDs for DOM refs and explicit tab-handle metadata.
- Added page-load/URL waiting, `/chrome connect|disconnect|pause|resume|profile|group` commands and status/bridge health reporting.
- Added screenshot saving from the Pi tool.
- Extended the Edge and Chrome for Testing E2E fixture to cover the new core controls.

## 0.1.0 - 2026-08-17

- Added the initial local Bridge, Manifest V3 extension and Pi browser tools.
- Added tab claim/release, Pi grouping, handoff/deliverable lifecycle and turn/session cleanup.
- Added basic snapshot, navigation, click/fill, screenshot and native CDP evaluate support.
