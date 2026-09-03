---
name: pi-control-chrome
description: Control the user's existing Chrome or Edge profile through pi-control-chrome browser tools and the local Bridge. Use for browser tabs, logged-in sessions, page inspection, interaction, screenshots, uploads, downloads, dialogs, clipboard, console/network/CDP, tab handoff or cleanup, and diagnosing Bridge, extension, browser-target, or stale-handle problems.
whenToUse: Only when the user explicitly requests control of the existing Chrome or Edge browser.
compatibility: Requires a host with pi-control-chrome browser tools, the Chromium MV3 extension installed, the local Bridge at 127.0.0.1:17318, and Node.js 22+ when the bundled CLI is used.
---

# pi-control-chrome

Use this Skill only when the user explicitly asks to use the existing Chrome or Edge browser, its tabs, logged-in session, or browser UI. Loading this Skill is the activation gate: do not call `browser_*` tools before it has loaded. Do not use browser control for ordinary public web search; use a search capability instead. Playwright or standalone CDP is for isolated test profiles or an explicit human/developer workflow when the Bridge surface is unavailable.

## Core contract

- After the Skill loads and browser tools are visible, call `browser_status` before the first browser action. A healthy result identifies Chrome or Edge, profile `current`, the Bridge at `127.0.0.1:17318`, a connected extension, and the selected target.
- If more than one browser target is ready, select the requested `browserId` explicitly with `browser_status`; never choose the newest connection, active window, or first list entry. If the target or connection generation changes, refresh status and inspect before retrying. Never replay an interrupted side effect.
- Keep complete tab handles with their `browserId`, `tabFence`, and, for script-accessible pages, document `incarnation`. Put locator fields in `target`, omit unused optional fields, and never send `index: -1` or empty selectors.
- `eN` snapshot refs, `aN` Chromium AX refs, and DOM-CUA node ids are document-scoped observations. Use the matching `snapshotId`; navigation, reload, document replacement, tab closure, or a changed tab fence is a hard boundary. A transition-pending navigation must reach `load` or the expected URL before a fresh snapshot is taken.
- Page actions check document identity before and after dispatch. A confirmed dispatch with a readable post-action identity may remain successful when the page changes; if dispatch or the result cannot be confirmed, return to inspection and treat `BROWSER_OPERATION_UNCERTAIN` as unknown. Never replay it automatically.
- Browser target leases are scoped by target, tab fence, attach epoch, and CDP target. Never detach an untracked debugger target; stale-runtime recovery requires explicit user authorization.
- Do not expose passwords, cookies, access tokens, private keys, pairing tokens, or unrelated page data. Do not inspect browser storage, cookies, passwords, or session stores as a discovery shortcut.
- Do not upload files, download sensitive data, change account security, or submit irreversible actions without an explicit user request. Verify the target and intended value immediately before an externally visible side effect.

## Semantic and observation rules

- For common semantic targets, prefer role/name, label, or accessible text. They use Chromium AX-first resolution for locator, wait, and interaction calls. Only an explicitly unavailable Accessibility domain may fall back to the DOM semantic tree; AX ambiguity, incomplete or truncated trees, unsafe mapping, selector errors, and actionability errors must fail closed.
- `browser_accessibility_snapshot` provides bounded AX observations as `full`, `diff`, or `unchanged`; use `disableDiffing: true` when a full tree is required. An `aN` ref is opaque and valid only with its matching `snapshotId`; it is revalidated against the current tree before use.
- CSS selectors, test ids, placeholders, and operations whose result shape AX cannot preserve remain DOM-driven. For actions and visible/enabled waits, apply an explicit zero-based `index` after visibility filtering so hidden duplicates do not consume it.
- Before an action, inspect with `browser_snapshot` or `browser_accessibility_snapshot`. After navigation or a meaningful UI action, normally take a fresh observation. Use `browser_wait` for `load`, `url`, `text`, `text_gone`, `visible`, `hidden`, or `enabled`; use `text` for page text and a nested `target` for element state.
- Use the narrowest supported native tool first. Use `browser_evaluate` or `browser_cdp` only when the higher-level tools cannot express the requested operation, and keep the evaluation bounded and page-visible.

## Default flow

```text
browser_status
→ browser_tabs / browser_selected
→ fresh snapshot or AX snapshot
→ semantic action or read
→ verify the result
```

For a missing element, stale observation, changing page, offline Bridge, target mismatch, timeout, or cleanup problem, stop and read [the recovery playbook](references/recovery.md) before choosing a recovery action. For dialogs, uploads, downloads, Console/Network, CDP, CLI, or isolated-test workflows, read [the workflow reference](references/workflows.md).

## Ownership and cleanup

- Treat existing tabs as user-owned. Do not close, navigate, move, or claim one unless the task requires it or the user explicitly asks.
- Prefer `browser_new_tab` for exploration. Agent tabs are temporary unless marked with `browser_mark_handoff` or `browser_mark_deliverable`; marks are turn-scoped and must be repeated when needed.
- Use `browser_release` to release a claim without closing a user tab. Use `browser_cleanup` only after the user explicitly requests immediate cleanup; it may close only allowed Agent tabs and release current-session claims. Use `browser_context_reset` only when the user asks to reset browser context.
- The browser group may be shared by sessions. Choose tabs using `owner`, `sessionId`, and `sessionScope`, never `groupId` alone.

## Human diagnostics and Skill-local references

`/chrome status`, `/chrome targets`, `/chrome profile [browserId]`, `/chrome connect`, `/chrome disconnect`, `/chrome doctor`, `/chrome restart`, and `/chrome tabs` are human diagnostics or lifecycle commands. They do not replace loading this Skill or authorize browser actions. When this distribution includes `scripts/browser.mjs`, that CLI is for explicit human/developer workflows and automated tests, not a model-facing alternative to the Skill-gated native tools.

All Skill references and scripts are resolved from this Skill directory. Read only the linked files here when the workflow requires more detail; do not depend on repository files outside this directory for Skill activation.

- [Recovery and diagnostics](references/recovery.md)
- [Special workflows](references/workflows.md)
