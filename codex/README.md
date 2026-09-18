# Codex CLI and Desktop

This directory contains the Codex MCP adapter. It uses MCP `stdio`, so the adapter does not listen on another port. It connects to the existing loopback Bridge at `127.0.0.1:17318` and starts that Bridge only when it is not already running.

The repository root also contains `.codex-plugin/plugin.json` and `.mcp.json`. They package the existing `skills/pi-control-chrome` Skill and the local MCP server for Codex. The same Skill and MCP configuration are used by Codex CLI and Codex Desktop.

## Install the local MCP server

If the repository is installed as a Codex Plugin, its `mcpServers` entry supplies the server automatically. Otherwise, from an npm installation containing this adapter:

```powershell
npm install --global pi-control-chrome
codex mcp add pi-control-chrome -- pi-control-chrome-codex
```

From a checkout:

```powershell
codex mcp add pi-control-chrome -- node C:\path\to\pi-control-chrome\codex\mcp-server.mjs
```

A manual registration is stored in `~/.codex/config.toml` and is shared by Codex CLI and Codex Desktop. Use `codex mcp list` to verify it and `/mcp` in the Codex TUI to inspect active servers. After installing a local Plugin, start a new Codex session so its Skill and MCP entries are discovered.

## Browser setup

Load the repository or installed package's `extension/` directory once through `chrome://extensions` or `edge://extensions`, with Developer mode enabled. The adapter does not install or reload an extension automatically.

The first browser operation must be `browser_status`. When Chrome and Edge, or multiple profiles, are connected, choose the intended `browserId` explicitly and acknowledge it before continuing. Keep returned tab handles and snapshot IDs; never replay `BROWSER_OPERATION_UNCERTAIN` without inspecting the current page.

The adapter exposes thirteen `browser_*` tools by default — status, targets, target lease, tabs, snapshot, accessibility snapshot, extract, wait, probe interaction, click, fill, restart and extension reload — chosen to work on tabs the user already has. Set `PI_CONTROL_CHROME_TOOLS=all` to expose every Bridge operation (44), or give a comma-separated list to choose your own subset; an unknown name fails the server at startup rather than silently exposing a narrower face. Whichever you pick, the catalog is decided once at startup, so a session's tool list never changes while it runs.

Every tool declares an `outputSchema` and answers with `structuredContent` next to its text block, so a caller reads `result.tabs` instead of parsing a JSON string out of the text.

Where a read's shape and size are decided is spread across three layers today: the extension bounds collection (`maxChars`/`maxNodes`, hard caps at 20,000 chars and 1,000 nodes), the Bridge owns `responseMode` — it validates the value, strips it before forwarding, and applies its own compact projection — and this server injects `MODEL_READ_BUDGETS` and projects again. A client that absorbs the payload itself (a node_repl-style kernel, where a cell filters before anything reaches a model) therefore cannot ask for the structure it needs: `responseMode` has no value for "the semantic model as data", and no caller-side bound is honoured above the Bridge's own ceilings. Giving such a client the page model as data — elements with `ref`s, without the prose rendering or the duplicated accessibility and frame trees — means adding that mode in the Bridge first, then letting the deployment choose it here.

It keeps one isolated browser session per MCP process and cleans that session on normal adapter shutdown. A process crash or forced termination still requires the normal Bridge/extension recovery flow.

Set `PI_CONTROL_CHROME_BRIDGE_PORT` if the Bridge is configured on another loopback port. The extension must be rebuilt with a matching CSP allowlist before using a non-default port.
