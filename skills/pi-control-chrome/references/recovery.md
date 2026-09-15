# Browser recovery and diagnostics

Read this file before recovering a browser, Bridge, target, tab, handle, or cleanup failure. Diagnosis comes before repetition. Stop when a step says to ask the user.

## Stop conditions

- If `browser_status` reports a browser or `browserId` different from the one the user requested, stop. Do not use its tab ids or handles.
- When several targets are ready, do not infer the target from the newest connection, active window, or first list entry. Select the intended `browserId` explicitly and acknowledge it when the status requires acknowledgement.
- A target reconnect or connection-generation change is a recovery event, not permission to replay a side-effecting request. Refresh status, inspect the current page, and retry only a read when its result is known to be safe.
- A changed URL, document incarnation, tab fence, reload, navigation, or closed tab invalidates document-bound observations. Take a new tab handle and snapshot.
- `BROWSER_OPERATION_UNCERTAIN` means the side effect may have happened. Inspect before any retry; never replay it automatically. The envelope names the post-effect failure so you can read the situation before the inspection: `postEffectErrorCode` is the code of the wait that failed (`BROWSER_WAIT_TIMEOUT` when the page never reached the requested state), and a `navigate(wait: true)` that redirected adds `postEffectUrlMismatch` with `postEffectLoaded`. A loaded page at another URL is the ordinary server-redirect case — inspect the tab, and pass `allowRedirects: true` next time instead of treating the navigation as a mystery. It does not mean the page is unreachable, and it never justifies a second submit.
- `BROWSER_TAB_RUNTIME_INHERITED` means the tab's ownership record was written by an earlier extension runtime, so its document identity cannot be re-verified. It is a pre-effect refusal: nothing was dispatched, and retrying cannot help while the record is inherited. A tab this session opened (`owned: "agent"`) is still yours — `browser_close_tab({ tabId })` closes it, or `browser_release({ tabId })` drops the record and leaves the tab open; take a fresh handle afterwards. A `claimed` user tab stays quarantined: `browser_release` drops the record without touching the tab, and closing it needs the user's decision. `browser_cleanup` closes inherited Agent tabs and drops inherited claimed records, so an extension restart does not leave either behind.
- DSH process lifecycle is maintainer-owned. Never invoke a DSH restart command or script, `taskkill`, or a replacement DSH server as automatic recovery; ask the maintainer to restart it manually and wait for confirmation before read-only verification.

## Wrong browser or competing targets

Symptoms include a wrong browser, a changing `browserId`, or Chrome and Edge competing for the Bridge.

1. Stop all page actions and record only `browser`, `browserId`, `profile`, and `extensionVersion`.
2. Ask the user which browser should be controlled.
3. In the unwanted browser, the user can open `chrome://extensions` or `edge://extensions` and disable the Pi Control Chrome extension.
4. Run `browser_status` again. Continue only after the requested browser is confirmed; acknowledge the selected `browserId` when required.
5. Confirm the target remains stable across the next status check before acting.

Do not keep retrying while two browser extensions are competing for one Bridge.

## Bridge or extension recovery

### Stale or incompatible Bridge

Run `browser_doctor` once. Inspect `recovery.available`, `recovery.authority`, `recovery.controlDomain`, `recovery.method`, and `recovery.requiresUserConfirmation`.

If the Bridge reports `capabilities.localUserRestart: true`, after the user explicitly authorizes a Bridge restart, prefer the active Harness's agent-managed Bridge restart entry point; do not ask the user to type a command. Use `/chrome restart` only as a manual fallback when the Harness client entry point is unavailable. The Bridge validates the instance, rejects pending browser work, serializes concurrent restarts, and leaves browser tabs untouched. This restarts the Bridge, not DSH or Edge; never invoke it proactively during Profile updates or release verification. Then run `browser_doctor` when available and call `browser_status` before retrying.

### Quick agent-managed cooperative Bridge restart

Use this sequence when a healthy but stale or incompatible Bridge is serving old capabilities. After the user explicitly authorizes the restart, the agent performs it; do not ask the user to type `/chrome restart`:

```text
browser_doctor (or browser_status in Codex)
→ ask the user to authorize a Bridge restart
→ invoke the current Harness restart entry point
→ browser_doctor (or browser_status in Codex)
→ acknowledge the current browser target
```

Use the entry point that belongs to the active Harness:

- **DSH**: invoke `BrowserBridgeClient.restart()` from the active installed DSH package's `lib/bridge.js`.
- **Pi**: invoke Pi's existing `bridge.restart()` implementation.
- **Codex**: call the exposed `browser_restart` tool with `confirmed: true`; this flag is valid only after the user explicitly confirmed the restart.

The entry point sends a guarded `bridge_restart` request with the current Bridge `instanceId`, waits for the old process to go offline, starts one Bridge on `127.0.0.1:17318`, waits for a new `instanceId`, and lets the extension reconnect. For DSH and Pi, resolve the client from the active installed Harness package rather than an unrelated or stale repository build. It does not restart DSH or Edge, close browser tabs, or clear login state. The Bridge rejects the request while browser work is pending or draining; never replace this with `taskkill` or a second Bridge.

After the restart:

1. Continue only when `extensionConnected: true` and the intended target is ready.
2. If `connectionGeneration` or target stability changed, acknowledge the reported `browserId` with a fresh `browser_status` before any page action.
3. Discard old tab handles and snapshot refs; take a new `browser_tabs` and snapshot observation.
4. Retry the original side effect only after inspecting the current page; never replay an uncertain side effect automatically.

Do not terminate a port owner from a port/PID lookup or command-line match, and do not start a second Bridge while the daily Bridge is healthy. Ask the user for host-level help only when cooperative restart is unavailable or the user has not authorized the Bridge restart.

### Bridge offline or extension disconnected

Symptoms include a failed `browser_status`, `extensionConnected: false`, or `EXTENSION_OFFLINE`.

1. Run `browser_doctor` when available; use `browser_status` to distinguish Bridge and extension failure.
2. If the Bridge is offline, use `/chrome connect` in Pi or the DSH browser client to start the local-user Bridge.
3. Check Bridge health at `http://127.0.0.1:17318/health` through the available host/browser diagnostic surface.
4. If the Bridge is healthy, confirm the requested browser has the unpacked extension enabled.
5. Run `/chrome connect`, then check `browser_status` once more.
6. Reload the unpacked extension only after the previous checks fail.
7. Ask the user for help only when cooperative recovery is unavailable or the extension must be installed or enabled.

Do not start a second Bridge on port `17318` while the daily Bridge is running. A timed-out `bridge_only` result is not permission to dispatch a page action; follow its `nextAction` and retry `browser_status` once.

### Inactive MV3 service worker

An idle Manifest V3 service worker is normal. Send a harmless `browser_status` request and check Bridge health. Reload the extension only when the request fails or `extensionConnected` is false.

### Controls paused

If browser controls report that they are paused, use `/chrome resume`, then call `browser_status`. Retry only after the requested browser and Bridge are healthy.

## Embedded frames and prototype shells

- Page readers are frame-aware by default: same-origin iframe text is included and `frames` metadata identifies readable, loading, and cross-origin frames. Prefer the returned frame content over `browser_evaluate` for routine inspection.
- If `frameLoading` is present or a read returns `BROWSER_PAGE_CHANGING` with `frameChanged`, wait for `load` or the expected URL, then take a fresh snapshot/extract. Do not reuse refs from the interrupted observation.
- Cross-origin frames are intentionally not scripted by the extension. A `frames[].reason` of `cross_origin` is a boundary, not a transient failure; use a user-provided URL/tab or a supported top-level control instead.
- A same-origin embedded document can be read through the parent observation, but its controls still need fresh AX/DOM resolution; never assume a top-level `eN` ref points into the iframe.

## Stale tabs, handles, and elements

1. Check the error code. `BROWSER_DOCUMENT_CHANGED`, stale-handle errors, `BROWSER_TAB_CLOSED`, and `BROWSER_TAB_FENCE_CHANGED` require `browser_tabs`, a current handle, and a fresh observation.
2. A title/focus change or unrelated same-document UI update is not automatically stale. The runtime may still resolve the original connected node or one unique equivalent replacement.
3. For `ELEMENT_TARGET_DETACHED`, `ELEMENT_TARGET_NOT_FOUND`, or `ELEMENT_TARGET_AMBIGUOUS`, take a fresh snapshot and narrow the semantic target. Never choose among ambiguous replacements.
4. If a user tab changed unexpectedly, stop and ask before claiming or navigating it.

For an isolated read on a changing page, the runtime may re-observe once. A persistent document change returns `BROWSER_PAGE_CHANGING`; refresh `browser_tabs` and retry the read. No page side effect was sent in that case.

Read-only requests may also absorb one Bridge/target reconnect internally when the browser identity is unchanged. If that bounded recovery still fails, follow `nextAction` and do not keep replaying the operation. This automatic path is never used for clicks, typing, navigation, uploads, downloads, cleanup, or other side effects.

### Element recovery ladder

Stop when the target becomes unambiguous:

```text
latest browser_snapshot
→ browser_accessibility_snapshot
→ browser_locator
→ browser_dom_cua
→ browser_cua
→ narrowly scoped browser_evaluate
```

After navigation, wait for `load` or the expected URL and take a fresh snapshot. Do not use an old ref after navigation, reload, document replacement, or `BROWSER_DOCUMENT_CHANGED`.

### Navigation or page timeout

1. Run `browser_tabs` and confirm that the tab still exists.
2. Use `browser_wait` for the relevant load state, URL, or URL fragment.
3. If the tab was closed or navigated elsewhere, obtain a fresh handle and snapshot.
4. Retry one read-only operation once.
5. Do not repeat a form submission, upload, download, or other externally visible action when completion is unclear.

## Leases, ownership, and cleanup

Debugger leases include the browser target, tab fence, attach epoch, and CDP target id. Ordinary cleanup must not detach a target that is not tracked by the current extension runtime. Use stale-runtime recovery only after explicit user authorization, and verify the persisted lease identity before and after detach.

For ownership or cleanup trouble:

1. Run `browser_tabs` and inspect `owner`, `sessionId`, and `lifecycle`.
2. Before `browser_claim_tab`, verify the current tab id, title, URL, and window snapshot. A changed URL or document incarnation makes the handle stale; title-only changes do not.
3. Release a claimed user tab with `browser_release`; never close it just to remove a claim.
4. Use `browser_mark_handoff` or `browser_mark_deliverable` when the user needs an Agent tab preserved.
5. Use `browser_cleanup` only after the user explicitly requests cleanup. If an extension runtime changed, pass `recoverStale: true` only after an explicit recovery decision; it forgets unknown-incarnation ownership records without closing unknown tabs.
6. If the selected target is gone, choose a replacement explicitly with `browser_status` before retrying.
7. Cleanup is **session-scoped**: a request only touches records whose `record.sessionId` equals the requesting session (`browser_cleanup` reports the rest as retained, and `recoverStale` cannot release them either). Tabs left behind by a session that no longer exists — a finished CLI or test run — therefore need that session's id, not the current one:
   - `browser_tabs({ owner: "agent" })` shows the owning `sessionId` of each stale tab and `stale: true` for records from an earlier extension runtime;
   - `node skills/pi-control-chrome/scripts/browser.mjs cleanup --session <that-session-id> --browser-id <browserId> --recover-stale` (or the same `cleanup` parameters through the harness client) releases the ownership record; the tab stays open;
   - the released tab is now an ordinary user tab, so close it with `browser_close_tab({ tabId, userRequested: true })` only after the user authorizes closing it.
   Never relay another session's id to *pretend* to be that session for a side effect; use this path only to forget stale ownership of a session that has already ended.

Never delete the browser group or tabs belonging to another session. Do not inspect browser storage, cookies, passwords, or session stores as a discovery shortcut. Automated verification should use an Agent-owned test tab or an isolated browser profile rather than the active DSH GUI tab.

## Escalation report

When recovery does not work, report only:

- requested browser and observed `browser`/`browserId`;
- `profile`, `extensionVersion`, and Bridge health fields;
- the last operation and whether the tab was user-owned or Agent-owned;
- the exact safe error code or message;
- recovery steps already attempted.

Never include pairing tokens, cookies, passwords, access tokens, private keys, or unrelated page contents.
