---
name: pi-control-chrome
description: Control the user's existing Chrome or Edge profile through the pi-control-chrome extension and local Bridge. Use for browser tabs, logged-in sessions, page inspection, interaction, screenshots, uploads, downloads, dialogs, clipboard, console/network/CDP, tab handoff or cleanup, and diagnosing Bridge, extension, browser-target, or stale-handle problems.
compatibility: Requires Pi with the pi-control-chrome package or extension loaded, the Chromium MV3 extension installed, the local Bridge at 127.0.0.1:17318, and Node.js 22+ for the bundled scripts.
---

# Pi Control Chrome

Use this Skill only when the user explicitly asks to use the existing Chrome or Edge browser, its tabs, logged-in session, or browser UI. Loading this Skill is the activation gate: do not call `browser_*` tools before it has loaded. Prefer the Pi or DSH `browser_*` tools from this project for the user's daily browser. Do not use browser control for ordinary public web search; use a search capability instead. Playwright or standalone CDP is for isolated test profiles or explicit human/developer workflows when this Bridge-based surface is unavailable.

## Connection Check

After this Skill has loaded and the `browser_*` tools are visible, start with `browser_status`. Browser tools remain active across later turns in the current Pi session; do not reload this Skill after every turn. `/chrome status`, `/chrome targets`, `/chrome profile [browserId]`, `/chrome connect`, `/chrome disconnect`, `/chrome doctor`, `/chrome restart`, and `/chrome tabs` are explicit human diagnostics or lifecycle commands; do not use them as a substitute for loading this Skill or as a reason to start browser control for an ordinary task.

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
- A Bridge may expose multiple connected browser targets. When more than one target is ready, select one with `browser_status` and its `browserId`, `/chrome profile <browserId>`, or the managed CLI `--browser-id`; never choose the newest connection, active window, or first list entry by assumption.
- Every complete tab handle includes `tabFence` and, when the page is script-accessible, a document `incarnation` made from URL, `performance.timeOrigin`, and a per-document token. Keep locator fields in `target`, never in `handle`, and omit optional fields instead of sending empty strings or `index: -1`. Snapshot refs and DOM-CUA node ids are document-scoped live observations: title/focus changes and unrelated same-document UI churn do not invalidate them. Navigation, reload, document replacement, tab closure, and a changed tab fence remain hard boundaries; reacquire the relevant observation before acting on the new document. `browser_navigate` with `wait: false`, `browser_back`, `browser_forward`, and `browser_reload` return a tab marked `transitionPending` whose handle omits unstable URL/title and document-incarnation fields, so use `browser_wait` and then a fresh snapshot before document-bound work.
- A page operation checks document identity before and after execution. If an action confirms dispatch and the post-action document identity is readable, it remains successful even when that identity changed; if it loses its injected result or cannot verify the post-action identity, treat `BROWSER_OPERATION_UNCERTAIN` as unknown and inspect before retrying. Do not replay it automatically.
- Debugger leases include the browser target, tab fence, attach epoch, and CDP target id. Ordinary cleanup will not detach a debugger target that is not tracked by the current extension runtime. Use stale-runtime recovery only after the user explicitly authorizes recovery; it verifies the persisted lease identity before and after detach.
- Do not expose pairing tokens, cookies, passwords, access tokens, private keys, or unrelated page data in a diagnostic report.

### Multiple browser targets

`browser_status` includes the selected target and, on a multi-target Bridge, the available target list and connection generation. Use `browser_status` without a selection to discover targets. Once the user or workflow selects a `browserId`, continue using that target; a target connection replacement is a recovery event, not permission to replay a side-effecting operation. Refresh status, inspect the current page, and retry only read-only inspection when the outcome of the interrupted operation is unknown.

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
2. Inspect `recovery.available`, `recovery.authority`, `recovery.controlDomain`, `recovery.method`, and `recovery.requiresUserConfirmation`.
3. When the Bridge exposes `capabilities.localUserRestart: true`, invoke the explicit host command (`/chrome restart` in Pi or DSH). The Bridge validates the instance id, rejects pending browser work, serializes concurrent restart requests, and leaves browser tabs untouched.
4. Do not terminate a port owner based on the port alone, a PID lookup, or a command-line match, and do not start a second Bridge while the existing one is healthy.
5. Run `browser_doctor` again, then call `browser_status` before retrying the requested operation.
6. Ask the user for host-level help only when the Bridge is legacy or lacks `capabilities.localUserRestart: true`. The user should not be asked to find a hidden Bridge terminal as the default recovery path.

### Bridge or extension is offline

**Symptoms:** `browser_status` fails, `extensionConnected` is false, or the request reports `EXTENSION_OFFLINE`.

1. Run `browser_doctor` when available; use `/chrome status` or `browser_status` to separate Bridge failure from extension failure.
2. When the Bridge is offline, invoke `/chrome connect` in Pi or use the DSH browser client; either Host may start the local-user Bridge.
3. Check `http://127.0.0.1:17318/health` through the available browser or host diagnostic tool.
4. If the Bridge is healthy, confirm the unpacked extension is enabled in the requested browser's extension page.
5. Run `/chrome connect`, then check `/chrome status` again.
6. Reload the unpacked extension only after the previous checks fail.
7. Ask the user for help only when cooperative recovery is unavailable or the extension must be installed or enabled.

Do not start a second Bridge on port `17318` while the daily Bridge is running. A port collision can make an isolated test look like an installed-extension failure.

### Service Worker is inactive

**Symptom:** the browser extension page labels the Manifest V3 Service Worker as `inactive` or `不活动`.

This is normal for an idle Service Worker. Send a harmless `browser_status` request and check Bridge health. Reload the extension only when the request fails or `extensionConnected` is false.

### Tab, handle, or element is stale

**Symptoms:** a tab id no longer exists, a snapshot ref is rejected, an action reports stale state, or the target moved.

1. Check the error code first. `BROWSER_DOCUMENT_CHANGED`, a stale handle, or tab-fence failure means the page identity changed; run `browser_tabs`, inspect the current page, and obtain a fresh observation.
2. A title/focus change or unrelated UI update within one document is not itself stale. A ref can still resolve its original connected node, or one unique semantically equivalent replacement.
3. If the resolver reports `ELEMENT_TARGET_DETACHED`, `ELEMENT_TARGET_NOT_FOUND`, or `ELEMENT_TARGET_AMBIGUOUS`, take a fresh snapshot and narrow the semantic target; never choose among ambiguous replacements.
4. If the user tab changed unexpectedly, stop and ask before claiming or navigating it.

Never retry an uncertain click or fill automatically. `BROWSER_PAGE_CHANGING` applies to a read-only page observation whose document changed during the bounded read retry. Refresh `browser_tabs` and retry the read on the current tab; no page side effect was sent. For automated verification, use an Agent-owned test tab or an isolated browser profile rather than the active DSH GUI tab. Keep explicit user-tab inspection available when the user requests a logged-in or currently visible page.

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

After navigation, obtain a fresh snapshot. When navigation used `wait: false`, `browser_back`, `browser_forward`, or `browser_reload`, first use `browser_wait` for `load` or the expected URL; its tab is marked `transitionPending` and its handle intentionally omits unstable URL/title and document-incarnation fields. After a meaningful same-document UI action, prefer a fresh snapshot to update the model's understanding, but do not treat unrelated DOM churn as a reason to switch to coordinate clicks or retry a failed side effect.

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
- For Console or Network data, enable the relevant capture on the current tab and report only data needed for the task. To retrieve a Network response body, pass both `requestId` and its matching `loaderId` from the current listing; reacquire both after navigation.
- If a CDP method fails, prefer the higher-level browser tool before trying another raw method.

### Ownership, handoff, and cleanup trouble

1. Run `browser_tabs` and inspect `owner`, `sessionId`, and `lifecycle`.
2. Release a claimed user tab with `browser_release`; do not close it.
3. Use `browser_mark_handoff` or `browser_mark_deliverable` when the user needs the page preserved.
4. Use `browser_cleanup` only after the user explicitly requests cleanup, and only for the current Agent session.
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

The bundled `scripts/browser.mjs` commands are for explicit human or developer workflows and automated tests only. They connect to the Bridge directly and are not a model-facing alternative to the Skill-gated `browser_*` tools. Managed `open`, `view`, and `cleanup` calls require an explicit `--session <id>`; `view` retention marks also require `--turn <n>`. Read-only `tabs`, `view`, `snapshot`, and `extract` use the negotiated Bridge `responseMode=compact` by default; pass `--raw` only for human/developer diagnostics that need the compatibility fields such as `frameTree`. Do not invoke them through a model shell. For model browser work, use the visible native tools below so the current Agent session, target identity, and ownership protections remain active.

`/chrome status`, `/chrome targets`, `/chrome profile [browserId]`, `/chrome connect`, `/chrome disconnect`, `/chrome doctor`, `/chrome restart`, and `/chrome tabs` remain explicit human diagnostics or lifecycle commands and do not activate model browser tools.

## Tool Selection

Use these tools when available:

- `browser_doctor`: diagnose Bridge reachability, extension connection, active browser target, and Chrome/Edge competition without changing tabs.
- `browser_status`: verify browser, profile, Bridge, extension, and target stability.
- `browser_tabs`: inspect windows, tabs, groups, ownership, lifecycle, and handles.
- `browser_selected`: inspect the selected tab without changing it.
- `browser_new_tab`: create an Agent-owned tab. With `windowId`, it can target a specific browser window returned by `browser_tabs`; otherwise it uses the current browser window. Prefer `active: false` unless the user needs to see it; this avoids activation at creation time but cannot prevent later browser or user focus changes. With `wait: true`, the returned handle is refreshed after loading; `allowRedirects: false` still accepts normal URL canonicalization such as a trailing `/`, while `true` permits an actual destination change.
- `browser_select_tab`: select an existing tab explicitly.
- `browser_snapshot`: inspect one bounded semantic page state and obtain document-scoped live element refs before interacting; pass its matching `snapshotId` with any ref action. The resolver uses the original connected node first and may make one unique semantic rebind in the same document; it never crosses navigation. The default collector keeps visible semantic/actionable nodes, caps text and nodes, and the model-facing result does not include the duplicate raw accessibility tree or frameTree. Optional `selector`, `maxChars`, and `maxNodes` narrow the read.
- `browser_accessibility_snapshot`: inspect semantic roles and accessible names as bounded full, incremental diff, or unchanged text; it includes the current snapshot id and document metadata. The first read is full, later reads may be diff or unchanged; pass `disableDiffing: true` when a full tree is required.
- `browser_extract`: read bounded visible page text and simple Markdown. Optional `selector` and `maxChars` share one output budget.
- `browser_locator`: use role + name, label, placeholder, text, test id, or CSS locators; require a single match or an explicit `index`. Actions and visible/enabled state queries apply an explicit index after visibility filtering, so hidden duplicate controls do not consume it.
- `browser_click`, `browser_double_click`, `browser_fill`, `browser_type`, `browser_press_key`, `browser_scroll`: perform page actions with a semantic `target`, a ref plus its matching `snapshotId`, or a CSS selector.
- `browser_dom_cua` and `browser_cua`: use visible DOM or coordinate actions when a locator is not sufficient. `browser_dom_cua` returns bounded line-oriented node ids for `get_visible_dom`; optional `selector`, `maxChars`, and `maxNodes` limit the read.
- `browser_wait`: wait for page load, URL, text, text disappearance, or an element to become visible, hidden, or enabled. Use `text` for page text and `target` for element conditions. `hidden` succeeds when no visible match exists; `visible` and `enabled` require one visible match and reject multiple visible matches. Visible/enabled waits apply an explicit index after visibility filtering.
- `browser_screenshot`: capture the current tab, saving it only when a path is needed.
- `browser_evaluate`: run narrowly scoped page JavaScript when the supported browser tools are insufficient; returned values are bounded to depth 8, 2,000 array items, 200 object fields, and 200,000 characters.
- `browser_cdp`: use a specific CDP method only when the higher-level tool does not expose the required capability.
- `browser_console`, `browser_network`, and `browser_dialog`: inspect development events and handle JavaScript dialogs; Console and Network listings are limited to 200 entries and 20,000 serialized characters per read.
- `browser_upload`, `browser_download`, and `browser_clipboard`: use only when required by the user's task.
- `browser_claim_tab` and `browser_release`: take and release ownership of an existing user tab.
- `browser_mark_handoff` and `browser_mark_deliverable`: preserve an Agent tab through the current turn cleanup; repeat the mark in a later turn when it is still needed.
- `browser_cleanup`: after explicit user authorization, immediately finalize the current browser task by closing allowed temporary Agent tabs and releasing claimed user tabs without hiding tools or stopping the Bridge. If an extension runtime changed, pass `recoverStale: true` only after an explicit recovery decision; this forgets unknown-incarnation ownership records without closing those tabs and returns their ids in `recovered` for manual inspection.
- `browser_context_reset`: explicitly finalize resources and reset the current browser context; use it only when the model needs browser tools deactivated.
- `browser_close_tab`: close a tab only when it is Agent-owned or the user explicitly asks for it.

## Page Interaction Workflow

1. Run `browser_status` when the browser connection is not already known to be healthy.
2. Run `browser_tabs` or `browser_selected` to identify the target tab.
3. For an existing user tab, confirm its title and URL before acting.
4. Run `browser_snapshot` or `browser_accessibility_snapshot` before clicking or filling.
5. Prefer semantic targets (`role` + `name`, `label`, `placeholder`, `text`, or `testId`) for common interactions; use a ref with the matching `snapshotId`, or use a CSS selector when appropriate.
6. Use `browser_wait` for asynchronous text or element states before proceeding; include `url` or `urlIncludes` when the page identity matters.
7. After navigation, take a fresh snapshot. After a meaningful same-document action, normally re-observe before reasoning about the next step; an existing ref may still be safely usable across unrelated churn or one unique framework replacement.
8. Verify the visible result with a snapshot, extract, URL wait, or evaluation.
9. Do not call `browser_cleanup` merely because the turn or browser task appears complete. The host performs turn cleanup automatically; call it only when the user explicitly asks for immediate cleanup.

Do not reuse a ref after navigation, reload, document replacement, or `BROWSER_DOCUMENT_CHANGED`. If a tab handle reports stale state, call `browser_tabs` again and obtain a fresh handle.

## Tab Ownership and Cleanup

- Treat existing user tabs as user-owned by default.
- Do not close, navigate, move, or claim an existing user tab unless the task requires it or the user explicitly asks.
- Before claiming a user tab, use its current tab id, title, and URL snapshot. A changed URL or document incarnation means the handle is stale; title-only metadata changes do not.
- Prefer `browser_new_tab` for exploratory work so the user's current page is not disturbed.
- Agent-created tabs are temporary by default and the host closes unmarked ones at turn end.
- The `Pi` group can be shared by multiple sessions; `groupId` is visual grouping only. Use `owner`, `sessionId`, and `sessionScope` to choose a tab, and never treat `groupId` alone as ownership.
- Mark a tab as `handoff` when the user needs to continue using it manually; the mark applies to the current turn and must be repeated later.
- Mark a tab as `deliverable` when it is a user-facing result that must remain open through the current turn cleanup.
- Claimed user tabs are released at turn end and are never closed by turn cleanup.
- Use `browser_cleanup` only after the user explicitly asks for immediate cleanup; it preserves currently marked tabs and releases claimed user tabs without closing them. Use `browser_context_reset` only after the user explicitly asks to reset or clear the browser context.
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
- [Agent-first browser runtime design](../../docs/AGENT-BROWSER-RUNTIME-DESIGN.zh-CN.md)
- [Decisions](../../DECISIONS.zh-CN.md)
