---
name: pi-control-chrome
description: Control the user's existing Chrome or Edge profile through the pi-control-chrome extension and local Bridge. Use for browser tabs, logged-in sessions, page inspection, interaction, screenshots, uploads, downloads, dialogs, clipboard, console/network/CDP, and tab handoff or cleanup.
compatibility: Requires Pi with the pi-control-chrome package or extension loaded, the Chromium MV3 extension installed, the local Bridge at 127.0.0.1:17318, and Node.js 22+ for the bundled scripts.
---

# Pi Control Chrome

Use this skill when the task explicitly involves the user's Chrome or Edge browser, existing tabs, browser login state, or browser UI. Prefer the Pi `browser_*` tools from this project for the user's daily browser. Use Playwright or standalone CDP for isolated test profiles or when this Bridge-based surface is unavailable.

## Connection Check

Start by checking the connection:

```text
/chrome status
```

If the Bridge is not connected, try:

```text
/chrome connect
/chrome status
```

The expected healthy state is:

- Browser: Chrome or Edge
- Profile: `current`
- Bridge: `127.0.0.1:17318`
- Extension: connected
- Extension version: the installed project version

The Edge or Chrome Manifest V3 Service Worker may show `不活动` or `inactive` when idle. That is normal; use `/chrome status` or `browser_status` as the connection check.

## Fast Common Workflows

For repeated connection and page-reading workflows, use the bundled script instead of generating a one-off WebSocket or Node script. It talks to the already-running Bridge and reuses the current Chrome/Edge profile without launching a browser or changing directories.

From the Skill directory:

```text
node scripts/browser.mjs status
node scripts/browser.mjs tabs --json
node scripts/browser.mjs group --json
node scripts/browser.mjs view <url> --screenshot <path>
node scripts/browser.mjs snapshot <tabId> --json
node scripts/browser.mjs extract <tabId> --max-chars 12000
node scripts/browser.mjs screenshot <tabId> <path>
node scripts/browser.mjs close <tabId>
node scripts/browser.mjs cleanup --session <sessionId>
```

`view` creates an Agent tab, waits for page load, extracts bounded text, records basic timing, optionally saves a screenshot, and marks the tab as `handoff` so it remains available to the user. Use `--reuse-existing` only when the user explicitly wants an existing exact-URL tab reused; never move a user-owned tab into the Pi group. Use `--temporary` when the page should be cleaned up instead of handed off.

Use the scripts for status, tabs, grouping, open/view, snapshot, extraction, screenshots, close, and cleanup. Use the `browser_*` tools for complex interactions, locator actions, dialogs, uploads, downloads, network/console inspection, and other operations that need incremental page state.

## Tool Selection

Use these tools when available:

- `browser_status`: verify browser, profile, Bridge, and extension state.
- `browser_tabs`: inspect windows, tabs, groups, ownership, lifecycle, and handles.
- `browser_selected`: inspect the selected tab without changing it.
- `browser_new_tab`: create an Agent-owned tab. Prefer `active: false` unless the user needs to see it.
- `browser_select_tab`: select an existing tab explicitly.
- `browser_snapshot`: inspect the page and obtain stable element refs before interacting.
- `browser_accessibility_snapshot`: inspect semantic roles and accessible names.
- `browser_extract`: read bounded visible page text and simple Markdown.
- `browser_locator`: use role, label, placeholder, text, test id, or CSS locators.
- `browser_click`, `browser_double_click`, `browser_fill`, `browser_type`, `browser_press_key`, `browser_scroll`: perform page actions.
- `browser_dom_cua` and `browser_cua`: use visible DOM or coordinate actions when a locator is not sufficient.
- `browser_wait`: wait for page load, URL, or other tab state.
- `browser_screenshot`: capture the current tab, saving it only when a path is needed.
- `browser_evaluate`: run narrowly scoped page JavaScript when the supported browser tools are insufficient.
- `browser_cdp`: use a specific CDP method only when the higher-level tool does not expose the required capability.
- `browser_console`, `browser_network`, and `browser_dialog`: inspect development events and handle JavaScript dialogs.
- `browser_upload`, `browser_download`, and `browser_clipboard`: use only when required by the user's task.
- `browser_claim_tab` and `browser_release`: take and release ownership of an existing user tab.
- `browser_mark_handoff` and `browser_mark_deliverable`: preserve an Agent tab for the user after the current turn.
- `browser_cleanup`: close temporary Agent tabs and release claimed tabs for the current session.
- `browser_close_tab`: close a tab only when it is Agent-owned or the user explicitly asks for it.

## Page Interaction Workflow

1. Run `browser_status` when the browser connection is not already known to be healthy.
2. Run `browser_tabs` or `browser_selected` to identify the target tab.
3. For an existing user tab, confirm its title and URL before acting.
4. Run `browser_snapshot` or `browser_accessibility_snapshot` before clicking or filling.
5. Prefer stable refs from the latest snapshot or semantic locators over coordinates.
6. After navigation or a meaningful action, take a fresh snapshot because refs can become stale.
7. Verify the visible result with a snapshot, extract, URL wait, or evaluation.
8. Clean up Agent-owned temporary tabs before finishing.

Do not reuse a ref after navigation or a DOM-changing action. If a tab handle reports stale state, call `browser_tabs` again and obtain a fresh handle.

## Tab Ownership and Cleanup

- Treat existing user tabs as user-owned by default.
- Do not close, navigate, move, or claim an existing user tab unless the task requires it or the user explicitly asks.
- Before claiming a user tab, use its current tab id, title, and URL snapshot. A changed title or URL means the handle is stale; refresh the tab list.
- Prefer `browser_new_tab` for exploratory work so the user's current page is not disturbed.
- Agent-created tabs are normally temporary and should be closed at the end of the task.
- Mark a tab as `handoff` when the user needs to continue using it manually.
- Mark a tab as `deliverable` when it is a user-facing result that must remain open.
- Use `browser_cleanup` at the end of a browser turn. It preserves handoff and deliverable tabs and releases claimed user tabs without closing them.
- Never delete or alter the user's Pi tab group or unrelated tabs.

## Safety Boundaries

- Do not expose, copy, or extract passwords, cookies, access tokens, private keys, or unrelated personal data.
- Do not inspect browser storage, cookies, passwords, or session stores as a discovery shortcut.
- Do not upload files, download sensitive data, change account security, or submit irreversible actions without the user's explicit instruction.
- For destructive or externally visible actions, verify the target page and intended values immediately before acting.
- Keep page evaluation narrow and visible; do not use it to bypass browser security controls.
- The first extension installation and local pairing are the trust boundary for this project. Do not invent per-action authorization prompts unless the user asks for an additional policy layer.

## Common Commands

```text
/chrome status
/chrome connect
/chrome tabs
/chrome profile
/chrome group
/chrome cleanup
/chrome release <tabId>
```

The browser tools are registered by `pi-extension/index.ts`; the extension and Bridge are implemented under `extension/` and `bridge/`.

## Troubleshooting

### Extension is not connected

1. Confirm Edge or Chrome is running.
2. Confirm the unpacked `extension/` is enabled in `edge://extensions` or `chrome://extensions`.
3. Check that the Bridge responds at `http://127.0.0.1:17318/health`.
4. Run `/chrome connect`, then `/chrome status`.
5. Reload the unpacked extension only if the status still reports no extension connection.

### Service Worker says inactive

This is expected for an idle Manifest V3 Service Worker. Send a harmless `browser_status` request and check the Bridge health instead of treating the inactive label as an error.

### Tab request times out

Refresh `browser_tabs`, confirm the target tab still exists, and retry with its current tab id. Do not keep using a stale handle. If only the standalone E2E test times out while the daily Bridge is running, check for a port collision on `17318` before diagnosing the installed extension.

### Browser controls are paused

Run:

```text
/chrome resume
```

Then retry the browser action.

## Project References

- [Chinese project guide](../../README.zh-CN.md)
- [Feature matrix](../../FEATURES.md)
- [Codex alignment](../../CODEX-ALIGNMENT.zh-CN.md)
- [Architecture](../../ARCHITECTURE.zh-CN.md)
- [Decisions](../../DECISIONS.zh-CN.md)
