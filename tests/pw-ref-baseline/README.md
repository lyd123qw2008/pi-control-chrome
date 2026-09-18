# Playwright ref baseline harness

Manual harness that measures how Playwright's own ref model behaves, so this plugin's
ref contract can be compared against a reference implementation instead of argued about.

**Not part of CI.** It needs `playwright-core` and a locally installed Edge (the scripts
use `channel: "msedge"`, so no browser download is required).

```powershell
npm i --no-save playwright-core@1.64.0-alpha-2026-09-14
node tests/pw-ref-baseline/spike.mjs
node tests/pw-ref-baseline/probe2.mjs
```

Each script starts a throwaway HTTP server, opens a page that reproduces the failure
modes this plugin has hit, and prints `[id] result` lines plus the aria snapshots.

## What the two scripts establish

`spike.mjs`

| id | meaning |
|---|---|
| `M2` | refs stay identical across snapshots while role/name are unchanged |
| `M4` | a label change mints a new number; the old ref dies |
| `M5` | a React-style node replacement mints a new number (no semantic rebind) |
| `M6c` | a `pushState` route change keeps old refs valid |
| `M7d` | a navigation restarts numbering under a new document prefix (`f1eN`, `f2eN`) |
| `M10b` | a locator waits for an element that does not exist yet (~2.9 s) |
| `D2` / `D3` | a dead ref costs a full `timeout` on a raw click, but `normalize()` fails in ~1 ms |

`probe2.mjs`

| id | meaning |
|---|---|
| `A1` / `A2` | the ref prefix increments per document, so old refs cannot collide |
| `B1` | a disabled element is waited for and then reported as a timeout |
| `D1` | a removed element simply stops appearing; its number is not reused |

## Reading the results against this repo

- Our `eN` refs are documented as **document-scoped** (`skills/pi-control-chrome/SKILL.md`).
  `M2`/`M6c` are the reference behaviour for that claim.
- `M5` is where this plugin is deliberately stronger: a unique, strongly equivalent
  same-document replacement is rebound instead of costing another snapshot round trip.
- `D3` is why the resolver must fail fast: waiting on an address that cannot resolve turns
  a 1 ms typed error into a multi-second timeout.
