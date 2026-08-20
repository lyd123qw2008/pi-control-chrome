# Changelog

## Unreleased

- Added the standalone `@lyd123qw2008/dsh-tool-control-chrome` package with the full `browser_*` tool surface, local Bridge reuse, DSH Agent session ownership, screenshot attachment output and real Loader lifecycle coverage.

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
