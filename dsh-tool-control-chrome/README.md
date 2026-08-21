# @lyd123qw2008/dsh-tool-control-chrome

DSH model-facing browser tools backed by the local [`pi-control-chrome`](https://github.com/lyd123qw2008/pi-control-chrome) Bridge. It controls the user's existing Chrome or Edge Profile through the installed Manifest V3 extension; it does not read browser profile files or cookies.

## Installation

Install the DSH package in the active Profile:

```powershell
corepack pnpm --dir <DSH_HOME>/profiles/web add @lyd123qw2008/dsh-tool-control-chrome@0.2.0
```

Alternatively add it to the Profile's `package.json`:

```json
{
  "dependencies": {
    "@lyd123qw2008/dsh-tool-control-chrome": "0.2.0"
  }
}
```

Copy [`config/cordis.patch.yml.example`](./config/cordis.patch.yml.example) to the active Profile's `cordis.patch.yml`, then install dependencies with a frozen lockfile.

The package is a function plugin. It registers DSH tools and does not export a default plugin function.

## Browser prerequisite

The DSH package cannot install a browser extension automatically. Install `pi-control-chrome` and load its `extension/` directory once:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the installed `pi-control-chrome/extension/` directory.

The extension must be connected before browser operations can succeed. `browser_doctor` is a read-only diagnostic tool for the Bridge, extension connection, active browser target, and Chrome/Edge competition. Browser operations perform a status preflight; if the active `browserId` changes, the operation fails before dispatching to the new browser. Call `browser_status`, confirm the requested browser, and disable the other browser extension before retrying.

## Configuration

Put deployment settings in `<DSH_HOME>/settings.yaml`; [`config/settings.yaml.example`](./config/settings.yaml.example) contains the same section:

```yaml
control-chrome:
  bridgeHost: 127.0.0.1
  bridgePort: 17318
  tokenFile: C:/Users/<user>/.pi/agent/pi-control-chrome.token
  autoStartBridge: true
  requestTimeoutMs: 120000
```

`tokenFile` is a path, not a token. The plugin never logs or exposes its contents. The default host is loopback; non-loopback hosts are rejected.

The plugin uses the active DSH Agent session id as the browser ownership session id. `browser_cleanup` therefore only handles tabs created or claimed by that Agent session.

## Tools

The package exposes the full browser-control surface:

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

## Model-facing cost

The full catalog contributes 38 tool schemas to each native tool assembly. Descriptions are intentionally scoped to browser tasks; deployments that need a smaller prompt can restrict the package's visible tool layer without changing the Bridge protocol. Screenshots use the DSH attachment store when available, so image bytes are not duplicated in the durable tool result.

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

The package uses the standard DSH `tool/call` and `tool/result` lifecycle. It does not append a provider-specific Session event, so it does not extend DSH's durable event catalog.

Cancellation stops waiting for the DSH tool call and clears the local pending request. The current Bridge protocol does not cancel an already-dispatched browser operation inside the extension; that operation may finish remotely while the DSH call has already settled.

## Known Limitations and Deferred Work

- Browser extension installation and local pairing remain user actions.
- The Bridge is intentionally loopback-only and is not a remote browser-control transport.
- A canceled request currently cannot interrupt an operation already executing inside the browser extension; a backward-compatible Bridge cancellation message is deferred.
- Screenshot output requires the DSH attachment service for a durable image block. Without it, the tool returns the encoded image in its JSON result.

## License

MIT.
