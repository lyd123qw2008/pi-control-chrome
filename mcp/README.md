# MCP adapter for Codex and other clients

This directory contains the local MCP adapter. It uses MCP `stdio`, so the adapter does not listen on another port. It connects to the existing loopback Bridge at `127.0.0.1:17318` and starts that Bridge only when it is not already running.

The repository root also contains `.codex-plugin/plugin.json` and `.mcp.json`. They package the existing `skills/pi-control-chrome` Skill and the local MCP server for Codex. The same Skill and MCP configuration are used by Codex CLI and Codex Desktop.

## Install the local MCP server

If the repository is installed as a Codex Plugin, its `mcpServers` entry supplies the server automatically. Otherwise, from an npm installation containing this adapter:

```powershell
npm install --global pi-control-chrome
codex mcp add pi-control-chrome -- pi-control-chrome-codex
```

From a checkout:

```powershell
codex mcp add pi-control-chrome -- node C:\path\to\pi-control-chrome\mcp\mcp-server.mjs
```

A manual registration is stored in `~/.codex/config.toml` and is shared by Codex CLI and Codex Desktop. Use `codex mcp list` to verify it and `/mcp` in the Codex TUI to inspect active servers. After installing a local Plugin, start a new Codex session so its Skill and MCP entries are discovered.

## Consuming this from a capability runtime

Any MCP client can launch the same adapter; it does not need a provider-specific integration package. A capability runtime that keeps large reads inside a kernel should configure the command with the complete catalog and caller-owned read policy:

```yaml
id: chrome
label: Chrome / Edge
transport: stdio
command: node
args: [<installed-pi-control-chrome>/mcp/mcp-server.mjs]
env:
  PI_CONTROL_CHROME_TOOLS: all
  PI_CONTROL_CHROME_READ_POLICY: caller
```

`PI_CONTROL_CHROME_TOOLS=all` exposes the complete 44-operation catalog to the client. `PI_CONTROL_CHROME_READ_POLICY=caller` returns page reads as `structured` data without adapter-injected budgets, so the kernel can filter them before it writes a conclusion to a model. The runtime still needs an installed `pi-control-chrome` package because it launches this executable, but it does not need to import or depend on this adapter as a provider-specific npm dependency. Keep the command path in Profile configuration, not in a reusable runtime package.

## Browser setup

Load the repository or installed package's `extension/` directory once through `chrome://extensions` or `edge://extensions`, with Developer mode enabled. The adapter does not install or reload an extension automatically.

The first browser operation must be `browser_status`. When Chrome and Edge, or multiple profiles, are connected, choose the intended `browserId` explicitly and acknowledge it before continuing. Keep returned tab handles; an eN ref stays valid inside its document, so re-observe rather than tracking snapshot IDs by hand; never replay `BROWSER_OPERATION_UNCERTAIN` without inspecting the current page.

The adapter exposes every Bridge operation (44) by default. Set `PI_CONTROL_CHROME_TOOLS=codex` for the bounded thirteen-tool Codex surface — status, targets, target lease, tabs, snapshot, accessibility snapshot, extract, wait, probe interaction, click, fill, restart and extension reload — chosen to work on tabs the user already has. The checked-in `.mcp.json` selects that mode so Codex does not silently grow from 13 tools to 44 during this migration. `PI_CONTROL_CHROME_TOOLS=all` (or `*`) explicitly selects the complete surface, and a comma-separated list chooses any other subset; an unknown name fails the server at startup rather than silently exposing a narrower face. Whichever you pick, the catalog is decided once at startup, so a session's tool list never changes while it runs.

Every tool declares an `outputSchema` and answers with `structuredContent` next to its text block, so a caller reads `result.tabs` instead of parsing a JSON string out of the text.

Where a read's shape and size are decided: the extension bounds collection (`maxChars`/`maxNodes`, hard caps at 20,000 chars and 1,000 nodes); the Bridge owns `responseMode`, and `compact` is the only mode that adds budgets of its own; this server adds the defaults a direct client needs. A client that absorbs the payload itself — a node_repl-style kernel, where a cell filters before anything reaches a model — sets `PI_CONTROL_CHROME_READ_POLICY=caller`: no budgets are injected, reads default to `structured` (the semantic model as data — elements with `ref`s — without the prose rendering or the duplicated accessibility and frame trees) and it can still name `compact` or `raw` per call.

It keeps one isolated browser session per MCP process and cleans that session on normal adapter shutdown. A process crash or forced termination still requires the normal Bridge/extension recovery flow.

Set `PI_CONTROL_CHROME_BRIDGE_PORT` if the Bridge is configured on another loopback port. The extension must be rebuilt with a matching CSP allowlist before using a non-default port.
