/** Runtime Skill metadata shared by the DSH browser-control plugin. */

export const BROWSER_SKILL_NAME = 'pi-control-chrome'
export const BROWSER_SKILL_DESCRIPTION = 'Use when the user explicitly requests control of the existing Chrome or Edge browser, including tabs, logged-in pages, screenshots, interaction, uploads, downloads, dialogs, console, Network or CDP.'
export const BROWSER_SKILL_CONTENT = `Use this Skill only when the user explicitly asks to use the existing Chrome or Edge browser, its tabs, logged-in session or browser UI.

Do not activate browser tools merely because browser control might help. For ordinary public research, prefer web_search or another lightweight web capability.

After this Skill loads successfully, the pi-control-chrome plugin makes the browser_* tools available for the current Agent session. Start with browser_status, then browser_tabs or browser_selected, then browser_snapshot before acting. Re-snapshot after navigation or page changes.

Keep the existing browser target and browserId stable. Stop if the target changes, and ask the user which browser should remain connected. Never close, navigate, move or claim a user tab unless the task requires it. Preserve handoff and deliverable tabs. Do not expose passwords, cookies, access tokens or unrelated page data.

Use browser_locator, browser_cua, browser_console, browser_network, browser_dialog, browser_upload, browser_download, browser_evaluate or browser_cdp only when the user's task or the page requires that capability. Verify destructive or externally visible actions immediately before performing them.

When the browser task is complete, use browser_cleanup when the current Agent session should release temporary browser state. /chrome status, /chrome doctor and /chrome tabs are human diagnostics and do not replace loading this Skill for model browser control.`
