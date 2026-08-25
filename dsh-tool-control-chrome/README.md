# @lyd123qw2008/dsh-tool-control-chrome

DSH model-facing browser tools backed by the local [`pi-control-chrome`](https://github.com/lyd123qw2008/pi-control-chrome) Bridge. It controls the user's existing Chrome or Edge Profile through the installed Manifest V3 extension; it does not read browser profile files or cookies.

## Installation

Install the DSH package in the active Profile:

```powershell
corepack pnpm --dir <DSH_HOME>/profiles/web add @lyd123qw2008/dsh-tool-control-chrome@0.3.11
```

Alternatively add it to the Profile's `package.json`:

```json
{
  "dependencies": {
    "@lyd123qw2008/dsh-tool-control-chrome": "0.3.11"
  }
}
```

Merge the `insert` entry from [`config/cordis.patch.yml.example`](./config/cordis.patch.yml.example) into the active Profile's `cordis.patch.yml`, preserve unrelated patch entries, then install dependencies with a frozen lockfile.

The package is a function plugin. It registers the `pi-control-chrome` Skill when the optional DSH Skill service is present, registers browser tools according to `lazyTools`, and registers the `/chrome` human command; it does not export a default plugin function.

## Browser prerequisite

The DSH package cannot install a browser extension automatically. Install `pi-control-chrome` and load its `extension/` directory once:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the installed `pi-control-chrome/extension/` directory.

The active DSH Profile should include the standard `@deepseek-ai/dsh-skill` service so the Skill registry and model-facing `skill` tool are available. This plugin contributes a bundled `skills/pi-control-chrome/SKILL.md` through the registry's provider API; it does not require the service as a hard injection, so human diagnostics and eager compatibility mode remain loadable in profiles without Skills. The bundled provider uses the standard bundled rank (`600`), so project `.dsh/skills` and `.agents/skills`, configured custom roots, and user Skill roots can override the same name according to DSH precedence. The bundled document is DSH-specific and lists only the DSH `/chrome` commands; Pi-only command guidance is kept out of this package. Older Skill services without `registerProvider` use a legacy runtime registration fallback, which cannot provide the same user-root override behavior.

The extension must be connected before browser operations can succeed. `browser_status` is a read-only readiness check and returns `state: "connected"`, `state: "bridge_only"` when the Bridge is healthy but the extension has not connected, or `state: "bridge_offline"` when the local Bridge cannot be reached. These disconnected results are normal structured tool results, not thrown `EXTENSION_OFFLINE` errors; browser operations return the same state without dispatching a browser action. Run `/chrome connect` and call `browser_status` again after the extension reconnects. The extension reconnects in the background; DSH does not reload it or replay a browser operation. `browser_doctor` remains the immediate diagnostic tool for the Bridge, extension connection, active browser target, Chrome/Edge competition, and recovery metadata (`recovery.available`, `recovery.authority`, `recovery.controlDomain`, `recovery.method`, and `recovery.requiresUserConfirmation`). Browser operations perform a status preflight and carry the expected `browserId` into the Bridge, which validates it atomically before dispatch. Any paired DSH or Pi Host can request a local-user cooperative restart from the same control domain when the Bridge exposes `capabilities.localUserRestart: true` and has no pending browser request. The Bridge does not use its launcher label as authorization, and a legacy Bridge without the capability is left untouched. If the active `browserId` changes, the operation fails before reaching the new browser. Call `browser_status`, confirm the requested browser, disable the other browser extension, and call `browser_status` with `acknowledgeBrowserId` before retrying. The extension status contract must provide non-empty `browser`, `browserId`, and `profile` fields; `pi-control-chrome` 0.3.4 persists an opaque Profile identity and sends it in the identity handshake.

## Configuration

Put deployment settings in `<DSH_HOME>/settings.yaml`; copy the `control-chrome` section from [`config/settings.yaml.example`](./config/settings.yaml.example).

`tokenFile` is a path, not a token. The plugin never logs or exposes its contents. The default host is loopback; non-loopback hosts are rejected. `autoStartBridge` starts the configured Bridge when the port is offline. `lazyTools` defaults to `true`: only the `pi-control-chrome` Skill metadata is available at load time, and the complete 38-tool catalog is registered in the current Agent after a successful named Skill load. Set `lazyTools: false` for legacy eager tool visibility during migration or debugging. A Bridge with `capabilities.localUserRestart: true` may be restarted by an explicitly invoked DSH or Pi Host command in the same local-user control domain. The Bridge validates its instance id and serializes restart requests; it rejects requests while a browser operation is pending. A legacy Bridge without that capability is left untouched.

The plugin uses the active DSH Agent session id as the browser ownership session id. `browser_cleanup` therefore only handles tabs created or claimed by that Agent session.

## Tools

The package defines the complete browser-control surface, but default `lazyTools: true` keeps all `browser_*` schemas out of the initial global and ordinary Agent assemblies. After the `pi-control-chrome` Skill succeeds, the current Agent receives all 38 tools together; there is no Core/Advanced activation split in this phase.

- `browser_doctor`, `browser_status`, `browser_tabs`, `browser_selected`;
- `browser_claim_tab`, `browser_select_tab`, `browser_new_tab`;
- `browser_snapshot`, `browser_accessibility_snapshot`, `browser_extract`;
- `browser_navigate`, `browser_wait`, `browser_back`, `browser_forward`, `browser_reload`;
- `browser_click`, `browser_double_click`, `browser_fill`, `browser_type`, `browser_press_key`, `browser_scroll`;
- `browser_screenshot`, which stores image bytes through the DSH attachment service when available;
- `browser_locator`, `browser_dom_cua`, `browser_cua`;
- `browser_console`, `browser_network`, `browser_dialog`;
- `browser_upload`, `browser_download`, `browser_clipboard`;
- `browser_evaluate`, `browser_cdp`;
- `browser_close_tab`, `browser_release`, `browser_mark_handoff`, `browser_mark_deliverable`, `browser_cleanup`.

Browser tools are model-facing DSH tools, not a `ctx.web` search provider. Web search configuration does not enable them.

## Human commands

The plugin registers the DSH `/chrome` command independently from its model-facing tools. These commands are explicit human diagnostics and do not activate model browser tools:

```text
/chrome status
/chrome connect
/chrome disconnect
/chrome doctor
/chrome restart
/chrome tabs
```

`/chrome connect` starts or reuses the local Bridge, establishes the current DSH client connection, waits for the browser extension, and reports the final status without restarting a healthy Bridge. `/chrome disconnect` closes only the current DSH client connection; it leaves the shared Bridge and browser extension available for a later `/chrome connect`. `/chrome restart` explicitly restarts a compatible Bridge and waits for the browser extension to reconnect before returning. These commands preserve browser tabs and return an error for a legacy Bridge without `capabilities.localUserRestart: true` when a restart is requested.

## Model-facing cost

With default `lazyTools: true`, the initial model assembly contributes the Skill's short name and description but no browser tool schemas. A successful Skill load adds all 38 browser schemas to that Agent's next assembly; repeated loads are idempotent and other Agent sessions remain unaffected. `lazyTools: false` contributes all 38 schemas from plugin load for compatibility. Browser descriptions are intentionally scoped to browser tasks. Screenshots use the DSH attachment store when available, so image bytes are not duplicated in the durable tool result.

## Development

From this directory:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm run check
corepack pnpm test
corepack pnpm run build
corepack pnpm run pack:check
```

The package tests use a fake Bridge for protocol and tool behavior. Browser acceptance requires the real `pi-control-chrome` extension and a connected Chrome or Edge Profile.

## Session and cancellation behavior

The package uses the standard DSH `tool/call` and `tool/result` lifecycle. It does not append a provider-specific Session event, so it does not extend DSH's durable event catalog. Skill activation is session-scoped. `browser_cleanup` removes the current Agent's scoped browser tools after its result is committed; Agent disposal removes the scope and requests Bridge cleanup only if that session made a real browser request. Loading the Skill without calling a browser tool does not start or contact the Bridge.

Cancellation stops waiting for the DSH tool call and clears the local pending request. The current Bridge protocol does not cancel an already-dispatched browser operation inside the extension; that operation may finish remotely while the DSH call has already settled.

## Known Limitations and Deferred Work

- Browser extension installation and local pairing remain user actions.
- The Bridge is intentionally loopback-only and is not a remote browser-control transport.
- A canceled request currently cannot interrupt an operation already executing inside the browser extension; a backward-compatible Bridge cancellation message is deferred.
- Screenshot output requires the DSH attachment service for a durable image block. Without it, the tool returns the encoded image in its JSON result.

## License

MIT.
