---
name: pi-control-chrome
description: Use when the user explicitly requests control of the existing Chrome or Edge browser, including tabs, logged-in pages, screenshots, interaction, uploads, downloads, dialogs, console, Network or CDP.
whenToUse: Only when the user explicitly requests control of the existing Chrome or Edge browser.
compatibility: Requires the DSH pi-control-chrome plugin, the Chromium MV3 extension, and the local Bridge at 127.0.0.1:17318.
---

# Pi Control Chrome for DSH

Use this Skill only when the user explicitly asks to use the existing Chrome or Edge browser, its tabs, logged-in session or browser UI.

Do not activate browser tools merely because browser control might help. For ordinary public research, prefer web_search or another lightweight web capability.

After this Skill loads successfully, the pi-control-chrome plugin makes the browser_* tools available for the current Agent session. Start with browser_status, then browser_tabs or browser_selected, then browser_snapshot before acting. Re-snapshot after navigation or page changes. browser_status and browser operations automatically wait for the extension's background reconnect. If a result still returns `state: "bridge_only"`, follow its `nextAction` and retry browser_status once before asking the user to run `/chrome connect`; do not dispatch a browser operation while the extension is disconnected. A `bridge_offline` result means the local Bridge could not be started or reached and may require `/chrome connect`.

When one Bridge exposes multiple ready browser targets, select the intended `browserId` with `browser_status` before acting; omit `browserId` for automatic discovery when one target is ready, and blank values are treated the same as omitted. Never choose the newest connection, active window or first list entry implicitly. Keep that logical target stable. A target reconnect changes its connection generation; refresh status and inspect the page before retrying, and never automatically replay a side-effecting operation whose outcome is uncertain. Stop if the task would move to another `browserId` without explicit user selection. Never close, navigate, move or claim a user tab unless the task requires it. Preserve handoff and deliverable tabs. Do not expose passwords, cookies, access tokens or unrelated page data.

Use browser_locator, browser_cua, browser_console, browser_network, browser_dialog, browser_upload, browser_download, browser_evaluate or browser_cdp only when the user's task requires that capability. Verify destructive or externally visible actions immediately before performing them.

Browser tools stay active across turns after this Skill loads. At turn end, the host closes unmarked Agent temporary tabs, releases claimed user tabs without closing them, and detaches the current session debugger lease. Mark a tab with browser_mark_handoff or browser_mark_deliverable when it must survive the current turn; these marks are turn-scoped and must be repeated in a later turn. Use browser_cleanup only when the user explicitly asks for immediate browser cleanup; it finalizes current-Agent resources while keeping browser tools and a healthy Bridge available. Use browser_context_reset only when the user explicitly asks to reset or clear this browser context and deactivate the lazy tools. The DSH human commands `/chrome status`, `/chrome targets`, `/chrome profile [browserId]`, `/chrome connect`, `/chrome disconnect`, `/chrome doctor`, `/chrome restart`, and `/chrome tabs` are diagnostics or lifecycle commands; they do not replace loading this Skill for model browser control.
