# Contributing

## Development setup

```powershell
npm install
```

Load `extension/` as an unpacked Chrome or Edge Manifest V3 extension, then make sure the local Bridge is reachable at `127.0.0.1:17318`.

## Checks and tests

Run the fast checks and deterministic Bridge test:

```powershell
npm run check
npm test
```

Run the live Skill script integration test when an Edge or Chrome profile with the extension is connected:

```powershell
npm run test:skill
```

Run the high-coverage browser smoke test with an isolated test profile:

```powershell
npm run smoke:e2e
```

Do not commit browser profiles, Bridge tokens, credentials, screenshots containing private data, or generated session files.

## Pull requests

Keep changes focused, explain user-visible behavior, and include the commands used for verification. Changes to browser permissions, tab ownership, cleanup, or Bridge authentication should include a regression test.
