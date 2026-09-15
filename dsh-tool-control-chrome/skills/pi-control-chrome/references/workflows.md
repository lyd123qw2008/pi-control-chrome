# Browser workflows

Use this reference for a special capability or a human/developer workflow. The native `browser_*` tools remain the model-facing surface; the tool descriptions are authoritative for arguments and output budgets.

## Native tool choice

- `browser_doctor`: diagnose Bridge reachability, extension connection, browser-target selection, Chrome/Edge competition, and cooperative recovery metadata without changing tabs.
- `browser_status`: verify the selected browser, profile, Bridge, extension, and target stability.
- `browser_targets`: list connected browser targets without changing the active target selection.
- `browser_tabs` / `browser_selected`: inspect windows, tabs, ownership, lifecycle, and current handles.
- `browser_snapshot`: read one bounded semantic DOM state and obtain document-scoped `eN` refs.
- `browser_accessibility_snapshot`: read bounded Chromium AX state and obtain `aN` refs with a matching `snapshotId`.
- `browser_extract`: read bounded visible text or simple Markdown. Set `tail: true` for the end of log-like pages and keep `maxChars` small.
- `browser_locator`: resolve a semantic or CSS target and perform supported reads/actions; use an explicit `index` only when intentional ambiguity remains.
- Compact adapters automatically apply conservative default budgets (about 8,000 characters/100 nodes for page states and 6,000 characters for extracts); raise them explicitly only when a bounded target is missing.
- `browser_dom_cua`: inspect or act on visible DOM node ids when a locator is insufficient.
- `browser_cua`: use native coordinate mouse/keyboard input only when semantic and DOM-CUA tools cannot express the requested interaction.
- `browser_new_tab`: prefer for exploration; use `active: false` unless the user needs to see it. `wait: true` returns a refreshed post-load handle.
- `browser_select_tab`: select an existing tab only after its target and identity are confirmed.

## Special page capabilities

Use these only when the task requires them and confirm the current target/tab first:

- `browser_screenshot`: capture the current tab; save to a path only when a file is needed.
- `browser_dialog`: inspect and accept/dismiss a JavaScript dialog, or provide an explicitly intended prompt value.
- `browser_upload`: confirm the intended file input, then set only the requested local files. Do not reveal unrelated local paths.
- `browser_download`: inspect status before retrying; do not start another externally visible download while completion is unclear.
- `browser_clipboard`: read or write the selected tab's clipboard only for the requested operation.
- `browser_console`: enable/read bounded Runtime Console, `pageerror` and Log entries; use `only: "errors"` and `since`/`nextSince` for action-scoped incremental reads.
- `browser_probe_interaction`: perform exactly one explicit click, form or keyboard action and return target resolution, action confirmation, before/after document identity, post-action Console errors and post-state. Prefer it for click-after-failure, disappearing UI, slot crashes, white screens and screenshot/state mismatches; it never automatically replays an uncertain side effect.
- `browser_network`: enable/read Network events. For a response body, use the matching `requestId` and `loaderId` from the current listing; reacquire both after navigation.
- `browser_evaluate`: use narrowly scoped, page-visible JavaScript only when native tools are insufficient. Returned values are bounded; do not use evaluation to bypass browser security or inspect hidden storage.
- `browser_cdp`: use a specific CDP method only when a higher-level tool does not expose the required capability.

A JavaScript dialog, upload, download, clipboard write, form submission, account change, or other externally visible operation is a side effect. Verify the current page and intended value immediately before dispatch, and inspect first if the result is uncertain.

## Capability layer vs site scripts

This distribution is the capability layer. It knows page *structure* — landmarks, headings, utility regions, repeated controls, readable frames, document identity — and it knows how to observe and act safely. It deliberately knows nothing about a product's field names, status vocabulary, or layout, and it must stay that way: do not add site selectors, product strings, or CI-specific parsing to the plugin. The repository-level statement of this boundary is [Capability layer and personalization layer](https://github.com/lyd123qw2008/pi-control-chrome/blob/main/ARCHITECTURE.md#capability-layer-and-personalization-layer) and [项目决策第 10 节](https://github.com/lyd123qw2008/pi-control-chrome/blob/main/DECISIONS.zh-CN.md).

When a task needs a site's own data, the calling Skill owns that logic and composes it from generic primitives:

- `browser_evaluate` for a bounded, read-only page-side parse of the site's DOM. Return a small object of the fields the task needs; keep the script self-contained and do not use it to reach hidden storage.
- `browser_extract({ selector })` (or `scope: "primary"`) for a typed region, and `scope: "log"` with `tail`/`logMatch` for log-like panes.
- `browser_wait` with `textAny`/`failureTextAny` for the site's own terminal strings, instead of asking the plugin to recognize a verdict vocabulary.
- `browser_snapshot` for structure and refs only: it lists regions in document order and publishes whatever `label: value` pairs the page renders itself, and it never infers domain fields or decides which region matters.

Example site-owned parse (this lives in the calling Skill, not in the plugin):

```js
// browser_evaluate runs in the page's own world, so page patches apply here. A page that
// ships a built-in polyfill (an old String.prototype.trim, for example) can make .trim()
// return a boxed String, which then crosses the evaluate boundary as {0:"a",1:"b"}.
// Coerce the RESULT: wrap the whole trimmed value in String(...), or avoid .trim() and use
// a regex on String(value). The plugin's own reads run in an isolated world and are immune.
(() => {
  const panel = document.querySelector('#main-panel') || document.body;
  const text = String(panel.innerText || '');
  const pick = (re) => { const m = text.match(re); return m ? String(m[1]).trim() : null; };
  const trim = (value) => { const m = /^\s*([\s\S]*?)\s*$/.exec(String(value ?? '')); return m ? m[1] : String(value ?? ''); };
  return {
    heading: trim(panel.querySelector('h1')?.innerText),
    revision: pick(/Revision:\s*([0-9a-f]{6,64})/i),
    branch: pick(/refs\/remotes\/origin\/([^\s]+)/i),
  };
})()
```

The plugin's own reads (`browser_snapshot` Page Map, `browser_extract`) run in the extension's isolated world with native built-ins and are unaffected by such polyfills; only a caller-authored page-side script needs this habit.

If the plugin's structural output is wrong for a page — for example a region is missing from the digest, an address no longer resolves, or script text appears as page content — that is a capability-layer defect to report and fix generically, not a reason to add a site special case.

## Bounded reads and their retrieval path

Every bounded read follows the same contract: report what was omitted and how to retrieve it. When a `browser_snapshot`/`browser_extract` result carries `truncated`/`omitted`:

1. Read the counts to see which dimension was cut (`regions`, `controls`, `fields`, `characters`, `tabs`).
2. Narrow to the region you need with `browser_snapshot({ target })` (or `{ ref }`/`{ selector }`) — a selector-scoped read returns the same digest shape for that subtree, so it can be repeated as deep as needed.
3. Take the text of that region with `browser_extract({ selector, maxChars })`, or a single fact with `browser_locator({ target, action: "text" | "count" | "getAttribute" })`.
4. Use `browser_extract({ scope: "body" | "primary" })` only for bulk prose, and `responseMode: "raw"` only for diagnosis — raw state is unprojected but still bounded and expensive.
5. Read `browser_doctor` for protocol/connection diagnostics; it is not a page-content path.

`browser_tabs` follows the same discipline at the browser level: pass `query` (title/URL substring) and `owner` (`user`/`agent`/`claimed`) to filter at the source instead of paging through everything, and note that the listing is complete by default (hard-capped at 200 rows) — a default that silently dropped rows would hide the very tab a caller just created. Use `totalTabs`/`matchedTabs`/`omittedTabs` to tell a narrowed result from an incomplete one, and pass `limit` only when you deliberately want fewer rows. `documentIdentity: false` is the cheap discovery mode: the returned handles carry only the tab fence, so re-observe the tab before any document-bound call.

There is deliberately no "return the whole page HTML" read: the way to get missing context is to address the subtree you need. If a task genuinely needs a DOM fragment, use a bounded read-only `browser_evaluate` script and keep that script with the Skill that owns the workflow.

## Waits and semantic targets

- Use `browser_wait` for `load`, `url`, `text`, `text_gone`, `visible`, `hidden`, or `enabled`.
- Use `text` for page text conditions and a nested `target` for element conditions. Add `url` or `urlIncludes` when the wait must remain on a particular page.
- For externally refreshed pages such as Jenkins, set `reload: true` with a bounded `reloadIntervalMs` (normally 5000) so reload/polling happens inside one bounded tool call instead of repeated model-visible reads. If the adapter timeout cap is reached, continue the same wait on the same URL; never repeat a side effect. This is opt-in because reload can discard unsaved page state.
- For long logs, wait for completion first and then use `browser_extract({ scope: "log", tail: true, includeFrames: false, maxChars: 4000 })`; do not poll full Console output.
- A text wait may use `textAny: ["success text", "alternate terminal text"]`; the result includes `matchedText`, `terminalState`, and `elapsedMs`. Add `failureTextAny: ["failure text", "abort text"]` with `state: "text"` to return immediately with `failed: true` and `terminalState: "failure"` instead of waiting for the success text.
- Use `browser_extract({ scope: "log", logMatch: "Finished:", logMaxMatches: 20, tail: true })` to filter log lines in the page before they enter the model context. The result reports `matchedLineCount`, bounded `matchedLineNumbers`, and `matchTruncated`; it never requires returning the full log.
- Prefer terminal matching over a broad tail once a page reports completion: `textAny` for the terminal literals plus `logMatch` for the few decisive lines (`Finished:`, `changed build result`, `Tomcat initialized`, deploy end markers) keeps a full log tail out of context. Fall back to a small bounded tail only when no terminal literal matches.
- Runtime freshness: the extension advertises one monotonic `capabilityRevision` (printed by `browser_status`) plus a boolean capability map (printed by `browser_doctor` as `runtime.capabilities` alongside `runtime.requiredCapabilityRevision`). An older revision is reported as `extension_runtime_stale`. If a request fails with a capability or unknown-parameter error while the source already supports it, the loaded runtime is stale. Refresh the active profile, call `browser_reload_extension` with `confirmed: true` after the user confirms the restart (it reloads only the extension; in-flight browser work is cancelled and the same browser target reconnects), then restart the host process when tool parameters changed. Never widen a read or repeat an action to work around a stale runtime.
- `browser_reload_extension` never restarts DSH/Codex/Pi or Chrome/Edge and does not close tabs. After it returns, refresh `browser_status` and discard every tab, `snapshotId`, `ref`, and handle observed before the reload.
- `hidden` succeeds when no visible match exists. `visible` and `enabled` require one visible match and reject multiple visible matches. An explicit index is applied after visibility filtering.
- After `browser_navigate` with `wait: false`, `browser_back`, `browser_forward`, or `browser_reload`, first wait for `load` or the expected URL and then obtain a fresh snapshot.
- For a semantic target, prefer role/name, label, or accessible text. Use placeholder, test id, CSS selector, or `scopeSelector` only when that is what the task specifies. Keep all locator fields under `target`.
- For AX refs, use only the matching `snapshotId`. Do not expose or invent AX node ids, backend DOM ids, frame URLs, or lease data.

## Human commands and bundled CLI

These commands are diagnostics or lifecycle operations, not a substitute for loading the Skill:

```text
/chrome status
/chrome targets
/chrome profile [browserId]
/chrome connect
/chrome disconnect
/chrome doctor
/chrome restart
/chrome tabs
/chrome cleanup
/chrome release <tabId>
```

For an explicitly user-authorized Bridge recovery, the agent may invoke the active Harness restart entry point described in `recovery.md`—DSH `BrowserBridgeClient.restart()`, Pi `bridge.restart()`, or Codex `browser_restart` with `confirmed: true`; do not ask the user to enter `/chrome restart`.

The bundled `scripts/browser.mjs` is for explicit human/developer workflows and automated tests. Managed `open`, `view`, and `cleanup` require an explicit `--session <id>`; `view` retention marks also require `--turn <n>`. Read-only `tabs`, `view`, `snapshot`, and `extract` negotiate compact responses by default; use `--raw` only for human/developer diagnostics that need compatibility fields such as `frameTree`. Do not invoke the script through a model shell as an alternative to the native Skill-gated tools.

## Isolated verification

When running automated browser verification, use an Agent-owned test tab or an isolated browser profile rather than the active DSH GUI tab. If an isolated test Bridge is needed, give it a separate port and temporary extension configuration; never stop or replace the daily Bridge merely to make a test pass.
