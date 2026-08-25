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

Keep the existing browser target and browserId stable. Stop if the target changes, and ask the user which browser should remain connected. Never close, navigate, move or claim a user tab unless the task requires it. Preserve handoff and deliverable tabs. Do not expose passwords, cookies, access tokens or unrelated page data.

Use browser_locator, browser_cua, browser_console, browser_network, browser_dialog, browser_upload, browser_download, browser_evaluate or browser_cdp only when the user's task requires that capability. Verify destructive or externally visible actions immediately before performing them.

Browser tools stay active across turns after this Skill loads. Keep browser state by default when the task is complete. Use browser_cleanup only when the user explicitly asks to close temporary tabs, release claims, or clean the browser task; it finalizes current-Agent temporary tabs and claims while keeping browser tools and a healthy Bridge available. Use browser_context_reset only when the user explicitly asks to reset or clear this browser context and deactivate the lazy tools. Ordinary turn end is a checkpoint and does not close tabs, release claims, disconnect the Bridge, or reload this Skill. The DSH human commands `/chrome status`, `/chrome connect`, `/chrome disconnect`, `/chrome doctor`, `/chrome restart`, and `/chrome tabs` are diagnostics or lifecycle commands; they do not replace loading this Skill for model browser control.
