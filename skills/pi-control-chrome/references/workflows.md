# Browser workflows

Use this reference for a special capability or a human/developer workflow. The native `browser_*` tools remain the model-facing surface; the tool descriptions are authoritative for arguments and output budgets.

## Native tool choice

- `browser_doctor`: diagnose Bridge reachability, extension connection, browser-target selection, Chrome/Edge competition, and cooperative recovery metadata without changing tabs.
- `browser_status`: verify the selected browser, profile, Bridge, extension, and target stability.
- `browser_tabs` / `browser_selected`: inspect windows, tabs, ownership, lifecycle, and current handles.
- `browser_snapshot`: read one bounded semantic DOM state and obtain document-scoped `eN` refs.
- `browser_accessibility_snapshot`: read bounded Chromium AX state and obtain `aN` refs with a matching `snapshotId`.
- `browser_extract`: read bounded visible text or simple Markdown.
- `browser_locator`: resolve a semantic or CSS target and perform supported reads/actions; use an explicit `index` only when intentional ambiguity remains.
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
- `browser_console`: enable/read Runtime Console and Log entries; report only information needed for the task.
- `browser_network`: enable/read Network events. For a response body, use the matching `requestId` and `loaderId` from the current listing; reacquire both after navigation.
- `browser_evaluate`: use narrowly scoped, page-visible JavaScript only when native tools are insufficient. Returned values are bounded; do not use evaluation to bypass browser security or inspect hidden storage.
- `browser_cdp`: use a specific CDP method only when a higher-level tool does not expose the required capability.

A JavaScript dialog, upload, download, clipboard write, form submission, account change, or other externally visible operation is a side effect. Verify the current page and intended value immediately before dispatch, and inspect first if the result is uncertain.

## Waits and semantic targets

- Use `browser_wait` for `load`, `url`, `text`, `text_gone`, `visible`, `hidden`, or `enabled`.
- Use `text` for page text conditions and a nested `target` for element conditions. Add `url` or `urlIncludes` when the wait must remain on a particular page.
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

The bundled `scripts/browser.mjs` is for explicit human/developer workflows and automated tests. Managed `open`, `view`, and `cleanup` require an explicit `--session <id>`; `view` retention marks also require `--turn <n>`. Read-only `tabs`, `view`, `snapshot`, and `extract` negotiate compact responses by default; use `--raw` only for human/developer diagnostics that need compatibility fields such as `frameTree`. Do not invoke the script through a model shell as an alternative to the native Skill-gated tools.

## Isolated verification

When running automated browser verification, use an Agent-owned test tab or an isolated browser profile rather than the active DSH GUI tab. If an isolated test Bridge is needed, give it a separate port and temporary extension configuration; never stop or replace the daily Bridge merely to make a test pass.
