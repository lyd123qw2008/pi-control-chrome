# Changelog

## Unreleased

- Prefer the real Chromium Accessibility Tree for accessibility snapshots, retain bounded full/diff/unchanged output, safely fall back to the DOM semantic tree when the Accessibility domain is unavailable, and add document-scoped `aN` refs with fenced AX/DOM mapping and limited interactions.

## 0.5.1 - 2026-09-02

- Centralized Page Agent document identity, weak element retention, and bounded observed-element resolution behind the v4 runtime contract while preserving document fences, fail-closed errors, and one-time same-document semantic rebinds.

- Exposed the typed `pi-control-chrome/pi-extension/output.js` projection subpath so host integrations can reuse the single bounded model-output implementation.

## 0.5.0 - 2026-09-02

- Reworked `snapshotId + eN` snapshot refs and `snapshotId + nodeId` DOM-CUA targets as document-scoped live observations. Title/focus changes, later observations, and unrelated same-document DOM churn no longer invalidate a still-connected original target.

- Permit one fail-closed, same-document semantic rebind only when a detached original has exactly one strongly equivalent replacement within its original scope. Ambiguous, weak, changed, cross-document, and second-hop replacements remain rejected.

- Added pre-dispatch document fencing for side-effecting page and DOM-CUA operations, retained invalidated observation provenance for explicit document-change errors, and preserved successful confirmed actions when a readable post-action document identity changes.

- Made `navigate(wait: false)`, back, forward, and reload return fenced `transitionPending` handles without unstable title, URL, or document-incarnation fields. Document-bound requests reject while a transition is pending until `browser_wait` completes.

- Added a bounded isolated-world Page Agent registry, Chrome/Edge history fallback fencing, Pi/DSH transition-pending projections, and real-browser regression coverage on Edge and Chrome for Testing.

## 0.4.4 - 2026-08-31

- Hardened `browser_new_tab` waiting and tab identity: normal URL canonicalization such as a trailing `/` is accepted with `allowRedirects: false`, an optional `windowId` is forwarded to tab creation, and `wait: true` returns a refreshed post-load handle with the current tab fence and document incarnation.

- Preserved session-aware browser result projection and delayed Pi Agent temporary-tab cleanup until the Agent settles, preventing a temporary tab from being closed between consecutive browser tool calls; added lifecycle and output-projection regression coverage.

## 0.4.3 - 2026-08-29

- Migrate the managed Skill CLI and DSH/Pi page-read consumers to a negotiated `responseMode=compact` Bridge response. Keep `responseMode=raw` as an explicit human/developer diagnostic path, retain old unspecified-mode compatibility, validate invalid modes, and make Pi/DSH projections idempotent for already compact results.

## 0.4.2 - 2026-08-29

- Add bounded re-observation for read-only page reads on user tabs: a document change is retried once, persistent movement returns `BROWSER_PAGE_CHANGING`, and side-effecting operations retain strict document fencing. Automated browser verification uses isolated Agent-owned tabs or browser profiles rather than the active DSH GUI tab.

- Add Codex-aligned browser output compaction: the extension bounds semantic accessibility, snapshot, extract, visible DOM, evaluate, Console and Network collection; Pi and DSH expose one compact model-facing state; Accessibility reads support full/diff/unchanged revisions; evaluate values use depth, array, object-field and string limits; data URL favicons and screenshot Base64 are excluded from model results; and selector/budget parameters are available for scoped reads.

## 0.4.1 - 2026-08-28

- Hardened DSH browser arguments against model-emitted blank optional fields, the `index: -1` sentinel, duplicate legacy locators and locator fields accidentally nested in a tab handle; canonical requests now preserve operation values while using one nested target.

- Kept the MV3 extension Bridge socket alive with a 20-second application heartbeat and made restricted `about:blank` tab setup return a usable tab handle without a document incarnation.

- Relaxed complete document handles so title-only metadata updates do not invalidate the handle; tab fences, URLs and document incarnations continue to fence tab replacement and navigation.

## 0.4.0 - 2026-08-28

- Added semantic element targets for common click, fill, type, keypress, locator, and wait operations. Targets support role/name, label, placeholder, text, test id, explicit indexing, and legacy ref/CSS compatibility with strict ambiguity handling.

- Added durable tab fences, document incarnations, debugger lease persistence and explicit stale-runtime recovery. Navigation and lifecycle races now invalidate old page, loader, dialog, file-chooser and DOM state; Network response bodies require the matching `loaderId` from the current listing; uncertain side effects require inspection instead of automatic replay.

- Hardened tab creation, removal and replacement reconciliation against numeric tab-id reuse, event-before-reservation ordering, duplicate lifecycle events and ownership transfer ambiguity. Unverified creation or removal outcomes fail closed.

- Bridge and DSH clients now reject response envelopes that do not contain exactly one valid result or error, preserving uncertainty for side-effecting requests.

- Extended browser waits with text appearance/disappearance and visible, hidden, and enabled element states. URL filters are applied to both tab and page conditions, and asynchronous target checks do not replay side-effecting actions.

- Added DSH/Pi routing and real-browser coverage for semantic targets and asynchronous page waits.

- Added a maintainer release Skill and a package/version matrix covering Pi, the browser extension, DSH, npm Trusted Publishing, lockfiles, Profile overrides, and post-release runtime verification.

- Added a target registry that keeps multiple Chrome/Edge browser Profiles connected to one Bridge, with explicit `browserId` selection, connection IDs, monotonic connection generations, target-scoped events, and stale-route rejection.

- Added target inventory and structured Bridge diagnostics through `health`, `list_targets`, and `doctor`, including bounded non-sensitive lifecycle events and request metrics.

- Extended Pi, DSH, and the managed Skill CLI with explicit browser-target selection and connection-fenced requests while preserving single-target protocol compatibility.

- Qualified browser tab handles, ownership records, cleanup, and target status with the logical browser identity; target disconnects remain recoverable and side-effecting operations are not automatically replayed after an uncertain connection failure.

- Added multi-target Bridge and DSH routing tests, target replacement fencing, disconnected-target recovery coverage, and explicit target selection tests.

- Included the referenced Markdown documentation in the Pi npm tarball without shipping the unrelated documentation screenshots, so packaged README links remain usable.

- Fixed MV3 ownership persistence for real Chrome/Edge storage by avoiding undefined storage defaults and stale read-side writes; live claim and cleanup state now survives concurrent tab-list requests.

## 0.3.8 - 2026-08-26

- Fixed Pi session transitions to report completed cleanup as successful instead of leaving a false browser-cleanup-pending status; added real-RPC lifecycle coverage for session switching, cleanup retry intent and stale Bridge sockets.

- Aligned Pi and DSH browser lifecycle with Codex: turn end now closes unmarked Agent temporary tabs, releases claimed user tabs without closing them, and detaches the session debugger lease while preserving Bridge, browser tools, and Browser binding.

- Made `browser_mark_handoff` and `browser_mark_deliverable` turn-scoped; the model must repeat a mark in a later turn when the tab is still needed.

- Added lifecycle capability negotiation and browser-target fencing so an older extension or replaced browser cannot silently execute automatic turn cleanup.

- Serialized ownership mutations and retained recovery state after failed tab removal or debugger detach.

- Added FIFO barriers across browser operations, automatic turn cleanup and teardown; Bridge requests now isolate client ids and stale sockets, and failed cleanup intents retain their original lifecycle parameters for retry.

- Required explicit `--session` (and retained-tab `--turn`) identities in managed Skill CLI workflows instead of deriving ownership from a process id.

- Changed Console, Network, Dialog, upload, and other DevTools paths to use an idle debugger lease instead of keeping the browser debugging indicator attached until task cleanup.

- Added a debugger screenshot fallback when Chromium cannot read back an active-tab `captureVisibleTab` image.

## 0.3.7 / 0.3.14 - 2026-08-25

- Browser lifecycle is now session-sticky: task completion and ordinary turn end retain browser state by default; only an explicit user request triggers `browser_cleanup`, which finalizes resources while keeping tools active. `browser_context_reset` explicitly deactivates the lazy catalog. Cleanup failures retain recovery state and browser operations serialize per session.

- Agent and plugin disposal provide final cleanup for resources left after session-sticky browser tasks, while handoff and deliverable tabs remain protected by ownership rules.

- DSH browser tools now wait up to six seconds for the extension's background reconnect before returning `bridge_only`; a timed-out readiness result directs the model to retry `browser_status` before requesting human connection.

- Reused a short-lived, session-owned debugger lease across consecutive browser operations instead of attaching and detaching Chrome DevTools for every call; explicit Console/Network/CDP capture remains persistent and cleanup still releases it.
- Captured ordinary active-tab viewport screenshots through the extension API, reserving DevTools attachment for full-page and background-tab captures.
- Enforced explicit user-requested close for unowned user tabs without bypassing another Agent session's ownership.

- Registered the DSH browser Skill from a bundled, DSH-specific Markdown provider with project/user override precedence; legacy Skill services retain a runtime fallback.

- Added DSH `/chrome connect` and `/chrome disconnect` commands; `/chrome status` now reports Bridge-only readiness, and `/chrome restart` waits for extension reconnection.

- Fixed DSH runtime Skill registration to provide the required `runtime` source metadata, allowing the `pi-control-chrome` Skill to load successfully.

- Fixed Pi extension startup to defer active-tool API calls until `session_start`, avoiding the host error that rejects action methods during extension loading.

- Fixed `browser_locator` filtering with `hasSelector`.
- Restricted pairing and health CORS responses to valid Chromium extension origins instead of exposing the pairing response to webpages.
- Added persisted per-Profile browser identity and Pi-side `expectedBrowserId` acknowledgement/preflight handling.
- Enforced session ownership for claim, release, lifecycle marking, Agent cleanup, persistent DevTools cleanup and Agent tab close; unowned user-tab close now requires explicit `userRequested: true`.
- Added Bridge lifecycle fencing, endpoint-aware DSH websocket reuse, shared restart capability checks and startup health reuse.
- Removed the unused Skill CLI token-file setting and clarified Profile patch merging and current architecture documentation.

## 0.3.6 - 2026-08-25

- Shortened the Pi session-ready status while retaining Skill-gated browser activation.
- Updated bundled browser Skill guidance for the DSH `/chrome connect` and `/chrome disconnect` lifecycle commands.


- Removed the unused `webNavigation` extension permission and private debugger-detach state.
- Simplified Pi Bridge health polling and replaced the hand-rolled HTTP JSON helper with Node's built-in fetch.
- Removed unconsumed Pi client health telemetry and development-only test files from the npm artifact.
- Removed unused browser tool schema fields for accessibility hints, network timeouts and download tab scoping.

## 0.3.1

- Added an explicit local-user restart capability marker so updated Hosts reject older owner-token restart protocols instead of reporting false recovery availability.

## 0.3.0

- Added non-secret instance, launcher and capability metadata to Bridge health and pairing handshakes.
- Added local-user cooperative Bridge restart with instance-race, pending-request and concurrent-restart checks; DSH and Pi Hosts share the restart authority through the authenticated local pairing channel.
- Added DSH `/chrome status|doctor|restart|tabs` commands and kept browser tabs untouched during Bridge restart.
- Added an extension identity handshake and atomic Bridge validation for `expectedBrowserId`, preventing a request from crossing an Edge/Chrome replacement.
- The DSH plugin now rejects an older running Bridge that cannot expose the active browser identity needed for atomic target routing.

## 0.2.4 - 2026-08-17

- Renamed the Chinese README filename so npm and Pi consistently select the English `README.md` as the default package documentation.

## 0.2.3 - 2026-08-17

- Made the default `README.md` English for international Pi and npm users.
- Added an explicit English/Chinese language switch at the top of both README files.

## 0.2.2 - 2026-08-17

- Fixed Agent-created tabs not actually moving into the existing Pi tab group when a Pi group already existed.
- Added the fast `skills/pi-control-chrome/scripts/browser.mjs` CLI for status, tabs, groups, open/view, extraction, screenshots, close and cleanup workflows.

## 0.2.1 - 2026-08-17

- Fixed MV3 Bridge reconnects after the Service Worker goes idle by declaring the `alarms` permission used by the periodic reconnect logic.

## 0.2.0 - 2026-08-17

- Added the bundled `pi-control-chrome` Skill with browser tool selection, tab ownership, cleanup, safety and troubleshooting guidance.
- Added the package `pi.skills` manifest entry for automatic Skill discovery.
- Added Playwright-style locator operations (`css`, role, text, label, placeholder and test id) with count, filtering, indexing, text/attribute/state queries and actions.
- Added accessibility-oriented page snapshots, bounded Markdown/plain-text extraction, viewport/selection metadata and frame-tree information.
- Added DOM CUA and coordinate CUA for mouse, keyboard, scrolling, dragging and text input.
- Added persistent CDP DevTools capture for Console, Network, lifecycle, JavaScript dialogs and file chooser events.
- Added native file upload, browser download lifecycle control and plain-text clipboard read/write.
- Added stale snapshot IDs for DOM refs and explicit tab-handle metadata.
- Added page-load/URL waiting, `/chrome connect|disconnect|pause|resume|profile|group` commands and status/bridge health reporting.
- Added screenshot saving from the Pi tool.
- Extended the Edge and Chrome for Testing E2E fixture to cover the new core controls.

## 0.1.0 - 2026-08-17

- Added the initial local Bridge, Manifest V3 extension and Pi browser tools.
- Added tab claim/release, Pi grouping, handoff/deliverable lifecycle and turn/session cleanup.
- Added basic snapshot, navigation, click/fill, screenshot and native CDP evaluate support.
