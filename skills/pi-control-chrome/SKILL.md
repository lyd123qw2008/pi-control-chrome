---
name: pi-control-chrome
description: Control the user's existing Chrome or Edge profile through the pi-control-chrome extension and local Bridge. Use for browser tabs, logged-in sessions, page inspection, interaction, screenshots, uploads, downloads, dialogs, clipboard, console/network/CDP, tab handoff or cleanup, and diagnosing Bridge, extension, browser-target, or stale-handle problems.
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

## Recovery Playbook

Treat a browser obstacle as a diagnosis problem, not a reason to repeat the last action. Use the smallest recovery path below, and stop when a step says to ask the user.

### Non-negotiable stop conditions

- Run `browser_status` before acting when the target browser is not already confirmed.
- If `browser` or `browserId` is not the browser the user requested, stop. Do not use its tab ids or handles.
- One Bridge endpoint accepts one active extension connection. If Chrome and Edge both connect to `127.0.0.1:17318`, the newer connection replaces the older one and reconnect attempts can make the target alternate.
- If `browserId` changes during a task, stop the task, refresh `browser_status`, and ask the user which browser should remain connected.
- Never recover by closing, navigating, or moving an existing user tab. Prefer an Agent tab.
- Do not expose pairing tokens, cookies, passwords, access tokens, private keys, or unrelated page data in a diagnostic report.

### Wrong browser or a flapping connection

**Symptoms:** `browser_status` reports the wrong browser, `browserId` changes between requests, or control moves between Chrome and Edge.

1. Stop all browser actions and record only `browser`, `browserId`, `profile`, and `extensionVersion`.
2. Ask the user which browser should be controlled.
3. In the unwanted browser, open `chrome://extensions` or `edge://extensions` and disable the Pi Control Chrome extension.
4. Run `browser_status` again. If the target changed, continue only after the user confirms the requested browser and acknowledge it with `browser_status` using `acknowledgeBrowserId`.
5. Confirm the requested browser is stable across the next check before acting.

Do not keep retrying a page action while the two extensions are competing for the Bridge.

### Stale or incompatible Bridge

**Symptoms:** `browser_doctor` reports `recommendation: restart_bridge`, `bridge_target_routing_unavailable`, or a healthy Bridge without an active `browserId`.

1. Stop browser actions and run `browser_doctor` once.
2. Inspect `recovery.available`, `recovery.ownership`, `recovery.method`, and `recovery.requiresUserConfirmation`.
3. When the current host owns the Bridge and exposes its lifecycle action, invoke the host's cooperative restart action (Pi exposes `/chrome restart`). It validates the instance id and owner contract, closes the Bridge cleanly, starts the latest managed Bridge, and leaves browser tabs untouched.
4. Do not terminate a port owner based on the port alone, a PID lookup, or a command-line match, and do not start a second Bridge while the existing one is healthy.
5. Run `browser_doctor` again, then call `browser_status` before retrying the requested operation.
6. Ask the user for host-level help only when the owner action is unavailable or the listener is an unknown legacy/user-owned Bridge. The user should not be asked to find a hidden Bridge terminal as the default recovery path.

### Bridge or extension is offline

**Symptoms:** `browser_status` fails, `extensionConnected` is false, or the request reports `EXTENSION_OFFLINE`.

1. Run `browser_doctor` when available; use `/chrome status` or `browser_status` to separate Bridge failure from extension failure.
2. When the current host owns the Bridge, invoke its managed startup or cooperative restart action. Pi uses `/chrome connect` for startup and `/chrome restart` for an owned Bridge.
3. Check `http://127.0.0.1:17318/health` through the available browser or host diagnostic tool.
4. If the Bridge is healthy, confirm the unpacked extension is enabled in the requested browser's extension page.
5. Run `/chrome connect`, then check `/chrome status` again.
6. Reload the unpacked extension only after the previous checks fail.
7. Ask the user for help only when host recovery is unavailable or the extension must be installed or enabled.

Do not start a second Bridge on port `17318` while the daily Bridge is running. A port collision can make an isolated test look like an installed-extension failure.

### Service Worker is inactive

**Symptom:** the browser extension page labels the Manifest V3 Service Worker as `inactive` or `不活动`.

This is normal for an idle Service Worker. Send a harmless `browser_status` request and check Bridge health. Reload the extension only when the request fails or `extensionConnected` is false.

### Tab, handle, or element is stale

**Symptoms:** a tab id no longer exists, a snapshot ref is rejected, an action reports stale state, or the target moved.

1. Run `browser_tabs` again.
2. Match the target by current title and URL; do not trust an old tab id or ref.
3. Run `browser_snapshot` or `browser_accessibility_snapshot` again.
4. Use refs from that latest snapshot only.
5. If the user tab changed unexpectedly, stop and ask before claiming or navigating it.

Never retry a stale click or fill with the old ref.

### Element cannot be found or an interaction fails

Use this recovery ladder, stopping when the target is unambiguous:

```text
latest browser_snapshot
→ browser_accessibility_snapshot
→ browser_locator
→ browser_dom_cua
→ browser_cua
→ narrowly scoped browser_evaluate
```

After a navigation or DOM-changing action, obtain a fresh snapshot. Do not switch to coordinate clicks merely because the first locator was not tried with the latest page state.

### Navigation or page request times out

1. Run `browser_tabs` and confirm the tab still exists.
2. Use `browser_wait` for the relevant load state, URL, or URL fragment.
3. If the tab was closed or navigated elsewhere, obtain a fresh handle and snapshot.
4. Retry a read-only operation once.
5. Do not automatically repeat a form submission, download, upload, or other externally visible action; ask the user if its completion is unclear.

### Dialog, upload, download, clipboard, Console, or Network trouble

- For a JavaScript dialog, use `browser_dialog` only after confirming the current tab and the intended accept, dismiss, or prompt value.
- For an upload, confirm the target file input and use `browser_upload`; never reveal unrelated local paths.
- For a download, use `browser_download` to inspect status before retrying; do not repeatedly start a download whose completion is uncertain.
- For clipboard failures, confirm the selected tab and retry only the requested clipboard operation.
- For Console or Network data, enable the relevant capture on the current tab and report only data needed for the task.
- If a CDP method fails, prefer the higher-level browser tool before trying another raw method.

### Ownership, handoff, and cleanup trouble

1. Run `browser_tabs` and inspect `owner`, `sessionId`, and `lifecycle`.
2. Release a claimed user tab with `browser_release`; do not close it.
3. Use `browser_mark_handoff` or `browser_mark_deliverable` when the user needs the page preserved.
4. Use `browser_cleanup` only for the current Agent session.
5. Do not delete the Pi group or tabs belonging to another session.

### Isolated E2E test failure

If `npm run smoke:e2e` fails while the daily Bridge is healthy, first check whether the test tried to bind port `17318`. Run the test with an isolated Bridge port and matching temporary extension configuration, or stop the daily Bridge only with the user's approval. Do not diagnose a port collision as a Chrome or Edge compatibility failure.

### Browser controls are paused

**Symptom:** the browser tools report that controls are paused.

Run:

```text
/chrome resume
```

Then call `browser_status` and retry the operation only after the requested browser and Bridge are healthy.

### Escalation report

When recovery does not work, report:

- requested browser and observed `browser`/`browserId`;
- `profile`, `extensionVersion`, and Bridge health fields;
- the last operation and whether the tab was user-owned or Agent-owned;
- the exact safe error code or message;
- the recovery steps already attempted.

Never include the pairing token, cookies, passwords, access tokens, or unrelated page contents.

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

- `browser_doctor`: diagnose Bridge reachability, extension connection, active browser target, and Chrome/Edge competition without changing tabs.
- `browser_status`: verify browser, profile, Bridge, extension, and target stability.
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

## Project References

- [Chinese project guide](../../README-zh-CN.md)
- [Feature matrix](../../FEATURES.md)
- [Codex alignment](../../CODEX-ALIGNMENT.zh-CN.md)
- [Architecture](../../ARCHITECTURE.zh-CN.md)
- [Decisions](../../DECISIONS.zh-CN.md)
