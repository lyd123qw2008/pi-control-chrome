# Changelog

## Unreleased

- Added a maintainer release Skill and a package/version matrix covering Pi, the browser extension, DSH, npm Trusted Publishing, lockfiles, Profile overrides, and post-release runtime verification.

## 0.3.8 - 2026-08-26

- Fixed Pi session transitions to report completed cleanup as successful instead of leaving a false browser-cleanup-pending status; added real-RPC lifecycle coverage for session switching, cleanup retry intent and stale Bridge sockets.

- Aligned Pi and DSH browser lifecycle with Codex: turn end now closes unmarked Agent temporary tabs, releases claimed user tabs without closing them, and detaches the session debugger lease while preserving Bridge, browser tools, and Browser binding.

- Made `browser_mark_handoff` and `browser_mark_deliverable` turn-scoped; the model must repeat a mark in a later turn when the tab is still needed.

- Added lifecycle capability negotiation and browser-target fencing so an older extension or replaced browser cannot silently execute automatic turn cleanup.

- Serialized ownership mutations and retained recovery state after failed tab removal or debugger detach.

- Added FIFO barriers across browser operations, automatic turn cleanup and teardown; Bridge requests now isolate client ids and stale sockets, and failed cleanup intents retain their original lifecycle parameters for retry.

- Required explicit `--session` (and retained-tab `--turn`) identities in managed Skill CLI workflows instead of deriving ownership from a process id.

- Changed Console, Network, Dialog, upload, and other DevTools paths to use an idle debugger lease instead of keeping the browser debugging indicator attached until task cleanup.

- Added a debugger screenshot fallback when Chromium cannot read back an active-tab `captureVisibleTab` image.

## 0.3.7 / 0.3.14 - 2026-08-25

- Browser lifecycle is now session-sticky: task completion and ordinary turn end retain browser state by default; only an explicit user request triggers `browser_cleanup`, which finalizes resources while keeping tools active. `browser_context_reset` explicitly deactivates the lazy catalog. Cleanup failures retain recovery state and browser operations serialize per session.

- Agent and plugin disposal provide final cleanup for resources left after session-sticky browser tasks, while handoff and deliverable tabs remain protected by ownership rules.

- DSH browser tools now wait up to six seconds for the extension's background reconnect before returning `bridge_only`; a timed-out readiness result directs the model to retry `browser_status` before requesting human connection.

- Reused a short-lived, session-owned debugger lease across consecutive browser operations instead of attaching and detaching Chrome DevTools for every call; explicit Console/Network/CDP capture remains persistent and cleanup still releases it.
- Captured ordinary active-tab viewport screenshots through the extension API, reserving DevTools attachment for full-page and background-tab captures.
- Fixed explicit user-requested close to remove ownership metadata even when the target tab belongs to another Agent session.

- Registered the DSH browser Skill from a bundled, DSH-specific Markdown provider with project/user override precedence; legacy Skill services retain a runtime fallback.

- Added DSH `/chrome connect` and `/chrome disconnect` commands; `/chrome status` now reports Bridge-only readiness, and `/chrome restart` waits for extension reconnection.

- Fixed DSH runtime Skill registration to provide the required `runtime` source metadata, allowing the `pi-control-chrome` Skill to load successfully.

- Fixed Pi extension startup to defer active-tool API calls until `session_start`, avoiding the host error that rejects action methods during extension loading.

- Fixed `browser_locator` filtering with `hasSelector`.
- Restricted pairing and health CORS responses to valid Chromium extension origins instead of exposing the pairing response to webpages.
- Added persisted per-Profile browser identity and Pi-side `expectedBrowserId` acknowledgement/preflight handling.
- Enforced session ownership for claim, release, lifecycle marking, Agent cleanup, persistent DevTools cleanup and Agent tab close; unowned user-tab close now requires explicit `userRequested: true`.
- Added Bridge lifecycle fencing, endpoint-aware DSH websocket reuse, shared restart capability checks and startup health reuse.
- Removed the unused Skill CLI token-file setting and clarified Profile patch merging and current architecture documentation.

## 0.3.6 - 2026-08-25

- Shortened the Pi session-ready status while retaining Skill-gated browser activation.
- Updated bundled browser Skill guidance for the DSH `/chrome connect` and `/chrome disconnect` lifecycle commands.


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
