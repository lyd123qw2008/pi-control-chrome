---
name: pi-control-chrome
description: Control the user's existing Chrome or Edge profile through pi-control-chrome browser tools and the local Bridge. Use for browser tabs, logged-in sessions, page inspection, interaction, screenshots, uploads, downloads, dialogs, clipboard, console/network/CDP, tab handoff or cleanup, and diagnosing Bridge, extension, browser-target, or stale-handle problems.
whenToUse: Only when the user explicitly requests control of the existing Chrome or Edge browser.
compatibility: Requires a host with pi-control-chrome browser tools, the Chromium MV3 extension installed, the local Bridge at 127.0.0.1:17318, and Node.js 22+ when the bundled CLI is used.
---

# pi-control-chrome

Use this Skill only when the user explicitly asks to use the existing Chrome or Edge browser, its tabs, logged-in session, or browser UI. In the legacy `lazy-full` host mode, loading this Skill is the activation gate for the raw `browser_*` tools. In DSH `progressive` mode, only the fixed core tools `browser_capabilities`, `browser_call`, and `browser_status` are present from session start; loading this Skill supplies the workflow contract but does not change the tool set. Do not use browser control for ordinary public web search; use a search capability instead. Playwright or standalone CDP is for isolated test profiles or an explicit human/developer workflow when the Bridge surface is unavailable.

## Progressive DSH facade

When the host exposes the three-tool progressive facade instead of the complete raw catalog:

1. Treat capability discovery as a schema-first workflow. If the operation name is known but its argument contract is not, request that exact operation's schema with `detail: "schema"` before calling it:
   ```json
   { "operation": "browser_tabs", "detail": "schema", "apiRevision": "browser-api-v2" }
   ```
2. Use the `operation` field for one operation's schema. Use the `group` field only for a whole catalog group, and only with an exact group ID returned by the catalog (for example `observe`). Never derive a group from an operation suffix: `browser_tabs` is an operation in group `observe`; `tabs` is not a group.
3. If neither the operation name nor its group is known, request the capability summary first, then request the schema for only the operation you will call. Do not request every operation schema at once.
4. After the schema is known, call `browser_call` with the exact discovered `operation`, its `arguments`, and the returned `apiRevision`. Do not silently reinterpret an invalid `group` as an operation; correct the request explicitly.
5. Call the fixed `browser_status` tool before the first real browser action. Capability discovery is local metadata and does not prove that the Bridge or extension is connected.
6. All other operations, including lifecycle operations, go through `browser_call`; confirmation-protected lifecycle calls require `arguments.confirmed: true` only after explicit user confirmation.
7. Never expect capability discovery or `browser_call` to register another tool. The model-visible tool set is fixed for the whole session.

The progressive facade is a structured alternative to a persistent browser client runtime: operation names are registry-validated, arbitrary Node.js or Bridge methods are not accepted, and all existing target, lease, confirmation, cleanup, and uncertain-side-effect rules still apply.

## Core contract

- After the Skill loads, or immediately when the progressive facade is already visible, call `browser_status` before the first browser action. It is the small read: identity once plus a `capabilityRevision`, a `bridge` summary, and target stability. If a healthy read is not enough, discover `browser_doctor` and call it through `browser_call` in progressive mode; lazy-full can call the direct raw tool. It carries the diagnostics (capability map, Bridge targets and per-request metrics, `runtime.requiredCapabilityRevision`, recovery detail).
- A loaded runtime can outlive a code update: the extension service worker keeps the code it started with, and a long-running host keeps the tool schemas it imported at startup. After updating this distribution, refresh the active profile; in progressive mode dispatch `browser_reload_extension` through `browser_call` with `arguments.confirmed: true` after the user confirms, while lazy-full uses the direct `browser_reload_extension` tool; restart the host process when tool parameters or validation changed. Compare `browser_status`'s `capabilityRevision` with `browser_doctor`'s `runtime.requiredCapabilityRevision`; an older revision is reported as `extension_runtime_stale`. A missing capability is a runtime-freshness problem, not a page problem: do not fall back silently, and do not re-run a side effect to "refresh" state.
- If more than one browser target is ready, select the requested `browserId` explicitly with `browser_status`; never choose the newest connection, active window, or first list entry. If the target or connection generation changes, refresh status and inspect before retrying. Never replay an interrupted side effect.
- Keep complete tab handles with their `browserId`, `tabFence`, and, for script-accessible pages, document `incarnation`. Put locator fields in `target`, omit unused optional fields, and never send `index: -1` or empty selectors.
- `eN` snapshot refs, `aN` Chromium AX refs, and DOM-CUA node ids are document-scoped observations. Use the matching `snapshotId`; navigation, reload, document replacement, tab closure, or a changed tab fence is a hard boundary. A transition-pending navigation must reach `load` or the expected URL before a fresh snapshot is taken.
- Page actions check document identity before and after dispatch. A confirmed dispatch with a readable post-action identity may remain successful when the page changes; if dispatch or the result cannot be confirmed, return to inspection and treat `BROWSER_OPERATION_UNCERTAIN` as unknown. Never replay it automatically.
- Read-only observations may absorb one transient Bridge/target reconnect and one document-change retry internally; side-effecting requests never use that recovery path. Structured failures expose `actionState`, `retryable`, `inspectFirst`, `nextAction`, and `recommendation` so the Agent can follow one safe recovery step instead of guessing.
- For click-after-failure, disappearing UI, white-screen, slot-crash, or state/screenshot mismatch diagnosis, prefer one explicit `browser_probe_interaction` call. It performs exactly one side effect, waits for the requested settle condition, returns the before/after document identity, captures only post-action Console/pageerror events by default, and reports target existence/visibility/enabled/text afterward. It never replays an uncertain side effect.
- Use `browser_console` with `only: "errors"` and its returned `nextSince` cursor for a manual incremental read; do not treat a clean pre-action Console as evidence that the action is safe.
- `No matching Chromium accessibility node was found` normally means the observed AX tree or target became stale, not that the page is unsupported. Refresh the accessibility observation once; if the result is still absent or ambiguous, follow the returned diagnostic rather than blind retrying.
- Browser target leases are scoped by session, target, tab fence, attach epoch, and CDP target. Use `release_session` for explicit lifecycle cleanup; Pi, DSH, and Codex also release tracked leases after successful context/task cleanup and disposal. Never detach an untracked debugger target; stale-runtime recovery requires explicit user authorization.
- Do not expose passwords, cookies, access tokens, private keys, pairing tokens, or unrelated page data. Do not inspect browser storage, cookies, passwords, or session stores as a discovery shortcut.
- Do not upload files, download sensitive data, change account security, or submit irreversible actions without an explicit user request. Verify the target and intended value immediately before an externally visible side effect.
- DSH process lifecycle is maintainer-owned: never invoke a DSH restart command or script, `taskkill`, or a replacement DSH server automatically. For an explicitly authorized Bridge recovery, the agent should invoke the active Harness restart entry point—DSH `browser_call` for `browser_restart` with `arguments.confirmed: true` in progressive mode, DSH `BrowserBridgeClient.restart()`/lazy-full `browser_restart`, Pi `bridge.restart()`, or Codex `browser_restart` with `confirmed: true`; `/chrome restart` is only a manual fallback, and never a way to restart DSH.
- Quick agent-managed Bridge recovery after explicit user authorization: `browser_doctor` (or `browser_status` in Codex) → invoke the current Harness restart entry point → `browser_doctor`/`browser_status` → acknowledge the current target. This restarts only the Bridge, not DSH or Edge. Follow `references/recovery.md` to refresh target and tab handles.

## Semantic and observation rules

- For common semantic targets, prefer role/name, label, or accessible text. They use Chromium AX-first resolution for locator, wait, and interaction calls. An explicitly unavailable Accessibility domain may fall back to the DOM semantic tree; a text-only target may also use a bounded DOM fallback when a custom clickable element is absent from AX. AX ambiguity, incomplete or truncated trees, unsafe mapping, selector errors, and actionability errors must fail closed.
- `browser_accessibility_snapshot` provides bounded AX observations as `full`, `diff`, or `unchanged`; use `disableDiffing: true` when a full tree is required. An `aN` ref is opaque and valid only with its matching `snapshotId`; it is revalidated against the current tree before use.
- `browser_snapshot`, `browser_extract`, and `browser_dom_cua({ action: "get_visible_dom" })` include readable same-origin iframe text and bounded `frames` metadata by default. Use `includeFrames: false` only when the embedded documents are intentionally out of scope. Cross-origin or still-loading frames are reported with a reason instead of being silently omitted; wait and re-observe when `frameLoading` is present.
- CSS selectors, test ids, placeholders, and operations whose result shape AX cannot preserve remain DOM-driven. For actions and visible/enabled waits, apply an explicit zero-based `index` after visibility filtering so hidden duplicates do not consume it.
- Before an action, inspect with `browser_snapshot` or `browser_accessibility_snapshot`. After navigation or a meaningful UI action, normally take a fresh observation. Use `browser_wait` for `load`, `url`, `text`, `text_gone`, `visible`, `hidden`, or `enabled`; use `textAny` for multiple terminal literals and `failureTextAny` to return a failure terminal state immediately; use `text` for page text and a nested `target` for element state.
- This plugin is a capability layer, not a site adapter. It provides page structure, refs and handles, waits, extraction, log matching, tab and browser ownership, and the security boundaries. Site-specific page handling belongs to the calling Skill: parse a product's own DOM with `browser_evaluate`, read typed regions with `browser_extract({ selector })`, express terminal conditions with `textAny`/`failureTextAny`, and pull log evidence with `logMatch`. Never expect the plugin to know a product's field names, status vocabulary, or layout — and never add site-specific selectors to it.
- Compact `browser_snapshot` returns a **neutral page digest**: regions in document order, repeated containers as counts, and every listed region addressable again by `target`, `ref`, or its `{selector=...}`/`{role name}` address. There is no ranking, no `Primary`, and no key-action ordering — the plugin does not decide which part of a page matters; you do, by zooming into the region you need. Anything a budget drops is reported as `omitted` counts plus a `nextAction`/`recommendation`, so a bounded read is always retrievable: narrow with `browser_snapshot({ target })`, `browser_extract({ selector, maxChars })`, or `browser_locator({ target, action })`. `truncated` marks an incomplete answer by its presence — a complete read omits the field instead of publishing `false` — and those counts survive re-projection, so they measure the whole read rather than the last hop. Page digest text comes from rendered content only, so inline helper scripts are never treated as page content. `values` publishes only the `label: value` pairs the page renders itself, and only when they read as data: a label is short and punctuation-free, a pair inferred from body text must not read as a sentence, and a pair the page declares in a table or `dt`/`dd` may be longer. When a field you need is missing from `values`, read it from the region you already know instead of expecting a domain vocabulary.
- `browser_tabs` narrows at the source: pass `query` (title/URL substring) and `owner` (`user`/`agent`/`claimed`) instead of paging through everything. The listing is complete by default (hard-capped at 200 rows) — a default that silently dropped rows would hide the tab you just created — and `totalTabs`/`matchedTabs`/`omittedTabs` tell a narrowed result from an incomplete one; pass `limit` only when you deliberately want fewer rows, and re-run with a narrower `query` when rows were dropped. `documentIdentity: false` is the cheap discovery mode: the returned handles carry only the tab fence, so re-observe before document-bound work.
- Use the narrowest supported native tool first. Use `browser_evaluate` or `browser_cdp` only when the higher-level tools cannot express the requested operation, and keep the evaluation bounded and page-visible.
- Keep model-visible reads small by default: prefer targeted locators/waits over full snapshots, use `includeFrames: false` for shell/status pages, and request larger `maxChars`/`maxNodes` only when a target is missing. Compact adapters default page reads to roughly 8,000 characters/100 nodes and extracts to roughly 6,000 characters; explicit budgets remain available.
- For externally refreshed status pages such as Jenkins, use `browser_wait` with `reload: true` and `reloadIntervalMs` instead of repeatedly asking the model to reload and inspect. For log-like pages, use `browser_extract` with `scope: "log"`, `tail: true`, optional `logMatch`, and a small `maxChars` budget to read only matching final lines.

## Default flow

For the progressive facade, when an operation contract is not already known:

```text
browser_status
→ browser_capabilities({ operation: "<exact operation>", detail: "schema", apiRevision })
→ browser_call({ operation, arguments, apiRevision })
→ fresh snapshot or AX snapshot
→ semantic action or read
→ verify the result
```

If the operation schema is already known, omit the discovery step. In lazy-full mode, use the direct operation tool after `browser_status`.

For a missing element, stale observation, changing page, offline Bridge, target mismatch, timeout, or cleanup problem, stop and read [the recovery playbook](references/recovery.md) before choosing a recovery action. For dialogs, uploads, downloads, Console/Network, CDP, CLI, or isolated-test workflows, read [the workflow reference](references/workflows.md).

## Ownership and cleanup

- Treat existing tabs as user-owned. Do not close, navigate, move, or claim one unless the task requires it or the user explicitly asks.
- Prefer `browser_new_tab` for exploration. Agent tabs are temporary unless marked with `browser_mark_handoff` or `browser_mark_deliverable`; marks are turn-scoped and must be repeated when needed.
- Use `browser_release` to release a claim without closing a user tab; in progressive mode discover and dispatch it through `browser_call`. Use `browser_cleanup` only after the user explicitly requests immediate cleanup, dispatching it with `arguments.confirmed: true` in progressive mode; it may close only allowed Agent tabs and release current-session claims. Use `browser_context_reset` only when the user asks to reset browser context, also through confirmed `browser_call` in progressive mode.
- The browser group may be shared by sessions. Choose tabs using `owner`, `sessionId`, and `sessionScope`, never `groupId` alone.

## Human diagnostics and Skill-local references

`/chrome status`, `/chrome targets`, `/chrome profile [browserId]`, `/chrome connect`, `/chrome disconnect`, `/chrome doctor`, `/chrome restart`, and `/chrome tabs` are human diagnostics or lifecycle commands. They do not replace loading this Skill or authorize browser actions. `/chrome restart` is a manual fallback; after explicit user authorization, agent-managed recovery uses the active Harness restart entry point described in `references/recovery.md` (progressive DSH uses `browser_call` for `browser_restart` with `arguments.confirmed: true`; lazy-full, Pi and Codex use their direct `browser_restart` entry point). When this distribution includes `scripts/browser.mjs`, that CLI is for explicit human/developer workflows and automated tests, not a model-facing alternative to the Skill-gated native tools.

All Skill references and scripts are resolved from this Skill directory. Read only the linked files here when the workflow requires more detail; do not depend on repository files outside this directory for Skill activation.

- [Recovery and diagnostics](references/recovery.md)
- [Special workflows](references/workflows.md)
