# @lyd123qw2008/dsh-tool-control-chrome

DSH model-facing browser tools backed by the local [`pi-control-chrome`](https://github.com/lyd123qw2008/pi-control-chrome) Bridge. It controls the user's existing Chrome or Edge Profile through the installed Manifest V3 extension; it does not read browser profile files or cookies.

## Installation

Install the DSH package in the active Profile:

```powershell
corepack pnpm --dir <DSH_HOME>/profiles/web add @lyd123qw2008/dsh-tool-control-chrome@0.3.16
```

Alternatively add it to the Profile's `package.json`:

```json
{
  "dependencies": {
    "@lyd123qw2008/dsh-tool-control-chrome": "0.3.16"
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

The extension must be connected before browser operations can succeed. `browser_status` is a read-only readiness check and returns `state: "connected"`, `state: "bridge_only"` when the Bridge is healthy but the extension has not connected, or `state: "bridge_offline"` when the local Bridge cannot be reached. DSH automatically starts or reuses the Bridge and waits up to `extensionReadyTimeoutMs` (6 seconds by default) for the extension's background reconnect before returning a disconnected state. A timed-out `bridge_only` result is retryable by the model with `browser_status`; it does not immediately require human confirmation. These disconnected results are normal structured tool results, not thrown `EXTENSION_OFFLINE` errors; browser operations return the same state without dispatching a browser action. Run `/chrome connect` only when the automatic wait and one model retry still cannot restore the connection. The extension reconnects in the background; DSH does not reload it or replay a browser operation. `browser_doctor` remains the immediate diagnostic tool for the Bridge, extension connection, active browser target, Chrome/Edge competition, and recovery metadata (`recovery.available`, `recovery.authority`, `recovery.controlDomain`, `recovery.method`, and `recovery.requiresUserConfirmation`). Browser operations perform a status preflight and carry the expected `browserId` into the Bridge, which validates it atomically before dispatch. Any paired DSH or Pi Host can request a local-user cooperative restart from the same control domain when the Bridge exposes `capabilities.localUserRestart: true` and has no pending browser request. The Bridge does not use its launcher label as authorization, and a legacy Bridge without the capability is left untouched. If the active `browserId` changes, the operation fails before reaching the new browser. Call `browser_status` with the intended `browserId`; DSH does not transfer a session to another target or replay the interrupted operation. Call `browser_status` with the intended `browserId` before retrying. The extension status contract must provide non-empty `browser`, `browserId`, and `profile` fields; `pi-control-chrome` 0.3.7 persists an opaque Profile identity and sends it in the identity handshake. Turn cleanup additionally requires the extension to advertise turnCleanup, turnScopedMarks, retainedCleanup, and debuggerLeaseRecovery; an older extension is rejected before automatic cleanup is dispatched.

Browser target selection is explicit when one Bridge exposes multiple Profiles. `browser_status` without `browserId` returns `state: "target_required"` and the ready target list; pass `browserId` to select one. The selected target's `connectionId` and `connectionGeneration` fence later requests, cleanup, and debugger recovery. A target disconnect never transfers a session to another Profile, and side-effecting operations are not replayed after an uncertain connection outcome. Human commands `/chrome targets` and `/chrome profile [browserId]` expose the same inventory and selection flow.

## Configuration

Put deployment settings in `<DSH_HOME>/settings.yaml`; copy the `control-chrome` section from [`config/settings.yaml.example`](./config/settings.yaml.example).

`tokenFile` is a path, not a token. The plugin never logs or exposes its contents. The default host is loopback; non-loopback hosts are rejected. `autoStartBridge` starts the configured Bridge when the port is offline. `extensionReadyTimeoutMs` defaults to 6000 and bounds the model-side wait for the extension's background reconnect. `lazyTools` defaults to `true`: only the `pi-control-chrome` Skill metadata is available at load time, and the complete 39-tool catalog is registered in the current Agent after a successful named Skill load. The catalog remains active across turns in that Agent session. At turn end, the host closes unmarked Agent temporary tabs, releases claimed user tabs without closing them, and detaches the session debugger lease. A model must mark a handoff or deliverable tab for the current turn and repeat the mark in a later turn when needed. Only an explicit user request to close temporary tabs, release claims, or clean the browser task may trigger `browser_cleanup`; it performs immediate current-Agent cleanup while retaining the catalog and healthy Bridge. `browser_context_reset` is the separate explicit user-requested operation that finalizes resources and then deactivates the lazy catalog. Set `lazyTools: false` for eager tool visibility during migration or debugging. A Bridge with `capabilities.localUserRestart: true` may be restarted by an explicitly invoked DSH or Pi Host command in the same local-user control domain. The Bridge validates its instance id and serializes restart requests; it rejects requests while a browser operation is pending. A legacy Bridge without that capability is left untouched.

The plugin uses the active DSH Agent session id as the browser ownership session id. `browser_cleanup` therefore only handles tabs created or claimed by that Agent session.

## Tools

The package defines the complete browser-control surface, but default `lazyTools: true` keeps all `browser_*` schemas out of the initial global and ordinary Agent assemblies. After the `pi-control-chrome` Skill succeeds, the current Agent receives all 39 tools together. The catalog remains active for subsequent turns. At turn end, the host closes unmarked Agent temporary tabs, releases claimed user tabs without closing them, and detaches the debugger lease. `browser_cleanup` is the user-authorized immediate task finalize operation and keeps the catalog active; `browser_context_reset` is the explicit user-authorized operation for finalizing resources and deactivating the lazy catalog. There is no Core/Advanced activation split in this phase.

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
- `browser_close_tab`, `browser_release`, `browser_mark_handoff`, `browser_mark_deliverable`, `browser_cleanup`, `browser_context_reset`.

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

With default `lazyTools: true`, the initial model assembly contributes the Skill's short name and description but no browser tool schemas. A successful Skill load adds all 39 browser schemas to that Agent's next assembly, and the catalog remains active across later turns in the same Agent session. At turn end, the host closes unmarked Agent temporary tabs, releases claimed user tabs without closing them, and detaches the debugger lease. A model must mark a handoff or deliverable tab for the current turn and repeat the mark in a later turn when needed. After an explicit user request, `browser_cleanup` finalizes the current task while keeping the catalog; handoff and deliverable pages stay open while the old session ownership metadata is released. `browser_context_reset` is an explicit user-requested operation that finalizes resources and deactivates the lazy catalog. `lazyTools: false` contributes all 39 schemas from plugin load for compatibility. Browser descriptions are intentionally scoped to browser tasks. Screenshots use the DSH attachment store when available, so image bytes are not duplicated in the durable tool result.

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

The package uses the standard DSH `tool/call` and `tool/result` lifecycle plus the host `session/event` turn boundary for internal cleanup. Browser operations and lifecycle cleanup share a per-session FIFO, and a cleanup response with non-empty `failed` remains recoverable instead of being treated as successful teardown. It does not append a provider-specific model-visible Session event. Skill activation is Agent-scoped and sticky across turns: turn end cleans unmarked temporary tabs, releases claimed user tabs, and detaches the debugger lease without removing tools; user-authorized `browser_cleanup` finalizes resources without removing tools, and user-authorized `browser_context_reset` finalizes resources before removing the lazy scope. Agent disposal and plugin disposal retry cleanup, remove remaining lazy tools, and retain unknown cleanup state for recovery; a replacement Agent reusing a failed session ID remains blocked until final cleanup succeeds. Plugin disposal closes new browser operations, drains active executions, and stops the Bridge in a finally path. Loading the Skill without calling a browser tool does not start or contact the Bridge.

Cancellation stops waiting for the DSH tool call and clears the local pending request. The current Bridge protocol does not cancel an already-dispatched browser operation inside the extension; that operation may finish remotely while the DSH call has already settled.

## Known Limitations and Deferred Work

- Browser extension installation and local pairing remain user actions.
- The Bridge is intentionally loopback-only and is not a remote browser-control transport.
- A canceled request currently cannot interrupt an operation already executing inside the browser extension; a backward-compatible Bridge cancellation message is deferred.
- Screenshot output requires the DSH attachment service for a durable image block. Without it, the tool returns the encoded image in its JSON result.
- Simultaneous control of multiple browser targets within one Agent session is deferred; bind one session to one target and use separate sessions for parallel Profiles.

## License

MIT.
