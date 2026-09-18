# Changelog

## Unreleased

- Add a cache-clean progressive DSH browser exposure mode with a fixed three-tool core facade (`browser_capabilities`, `browser_call`, `browser_status`), shared operation registry/executor, per-operation capability discovery, and legacy `lazy-full` compatibility. All operations, including confirmation-protected lifecycle operations, dispatch through `browser_call`; discovery and dispatch do not mutate the model-visible tool set.
- Bump the progressive host API revision to `browser-api-v2` and require `arguments.confirmed: true` for confirmation-protected lifecycle operations dispatched through the progressive facade.

## 0.6.2 - 2026-09-15

- Finish what 0.6.1 started for inherited tabs. 0.6.1 let close, release and cleanup cross an extension-runtime generation, but they still compared the live tab fence against the fence stored in the record — and a replaced runtime cannot reproduce that fence by definition. A real leftover tab therefore answered `BROWSER_TAB_FENCE_CHANGED` and stayed unclosable, the same wall one check deeper (observed live: the record carried `tab:bb6803dd…` while the new runtime reported `tab:d0f05bd3…`). Closing, releasing or cleaning up an inherited **Agent** record now identifies the tab by its tabId plus this session's own ownership record and uses the fence the current runtime actually observes; a `claimed` user tab keeps the stricter treatment, and document-bound work still refuses with `BROWSER_TAB_RUNTIME_INHERITED` and the exit that works. Verified live: the tab left behind by an earlier runtime closed cleanly.

## 0.6.1 - 2026-09-15

- Let a session clean up after its own runtime. An ownership record outlives the extension runtime that wrote it, and every path that touched such a record refused with a bare message — live, a tab this session had opened became both unreadable and unclosable (`Cannot use tab …; its tab incarnation is unknown after the extension runtime changed`), so only a human could clear it. Closing it became the calling session's own bookkeeping, `browser_release` drops the record without touching the tab, and `browser_cleanup` closes inherited Agent tabs instead of reporting them as a permanent failure; the recorded-fence comparison still had to be removed before a real leftover tab could actually close, which 0.6.2 did. A `claimed` user tab keeps the stricter treatment, because its document identity is what authorised the claim, and document-bound work on an inherited record still fails closed — but now with `BROWSER_TAB_RUNTIME_INHERITED`, `actionState: not_completed`, `retryable: false`, and the exit that works (`browser_close_tab` for an Agent tab, `browser_release` for a claimed one) instead of a message the caller cannot act on. DSH also stops folding that code into its connection-failure fallback.

- Stop publishing nonsense from a table's shape. Reading a real build page published `w: Description · %` and `x: x` as structured data: the declared-pair path took any row with two or more cells and paired the first cell with the rest, so a chart legend's header row became a `label: value` pair and a single-character placeholder cell became a field name. A row that is entirely header cells (`th`/`role=columnheader`) or lives in a `<thead>` is now skipped, because column names are not data, and a label must be at least two characters, because a one-character cell is a coordinate or placeholder. A real row-header pair (`<th>Label</th><td>Value</td>`) still publishes, and the archetype fixture pins all three cases.

- Name the reason a post-effect wait failed instead of leaving a dispatched navigation unexplained. `waitForTabState` threw a code-less `Error` on timeout while the other wait path already reported a structured `BROWSER_WAIT_TIMEOUT`, and the uncertainty envelope can only forward a failure that carries a code — so a `navigate(wait: true)` whose page never reached the requested URL came back as `BROWSER_OPERATION_UNCERTAIN` with `actionState: unknown` and no reason at all (observed live: a Jenkins `/git` URL the server redirects to `/git/`). The timeout now carries `BROWSER_WAIT_TIMEOUT`, and a navigation wait that finished at another URL adds `postEffectUrlMismatch` with `postEffectLoaded`, so a server redirect is distinguishable from a changed tab fence before the inspection. The page's own URL and title stay out of the envelope.

## 0.6.0 - 2026-09-15

- Give all three host adapters one diagnostic contract instead of three implementations: `pi-extension/output.js` now owns `compactDoctorResult`, `compactBridgeHealth`, `capabilityRuntime` and `runtimeDiagnosis`, and Pi, DSH and Codex project through them. `browser_doctor` prints the extension capability map exactly once (inside `runtime.capabilities`), keeps Bridge health with its target inventory and observability, and stops repeating identity, `userAgent` and per-target capability maps inside every nested block. The Bridge keeps its public health contract unchanged — only the model-facing projection drops the duplicated copies — and `browser_targets` now reports compacted Bridge health, because the full health belongs to the doctor.

- Make truncation mean an incomplete answer, and make an unresolvable target name its next step. A selective read (`browser_extract` with `logMatch` or `tail`) no longer reports `truncated` or `omitted.characters` merely because the log is longer than the budget — that is the request, not a loss — so a zero-match log read answers cleanly instead of carrying a large, meaningless omission count; only `matchTruncated` or a cut frame set makes such a read incomplete. `AX_NODE_NOT_FOUND` now carries `nextAction`/`recommendation` and distinguishes an incomplete tree (`frame_incomplete`, retry after load), an exhausted resolution budget (`tree_truncated`, narrow or scope the target), and an absent node (`target_not_found`, use `target.selector`), while `retryable` keeps its meaning of "this exact request may succeed on retry".

- Extend the "bounded read is retrievable" contract beyond the page digest. `browser_extract` reports `sourceCharacters` and `omitted.characters` with `nextAction: "browser_extract"` and a selector-based recovery; `browser_console` and `browser_network` report `omitted.events`/`omitted.requests` against the source-side `logTotalCount`/`requestTotalCount` and point at the `nextSince` cursor (the Bridge now projects those two methods too); a snapshot text or visible-DOM state read reports `omitted.nodes`/`omitted.characters`; `browser_accessibility_snapshot` reports an exact `omitted.nodes` from the captured Chromium AX total, and `browser_evaluate` reports `omitted.items`/`omitted.fields`/`omitted.characters` counted at each depth, array, field and string budget. The DOM semantic fallback path deliberately reports only `truncated` rather than an inexact omission count.

- Stop a second projection from erasing what the first one reported. The same read is projected more than once — the Bridge renders a compact response and a host (or the bundled CLI) then projects that already compacted payload — and the re-projection recomputed its own omission set instead of carrying the upstream one. Live on a Jenkins build page that turned a bounded digest into `truncated: true` with `omitted: {}`: incomplete, and silent about what was missing, which is worse than no count at all. A re-projection now carries the upstream `omitted` counts and its `nextAction`/`recommendation`/`recovery` forward, and adds its own cut to them, because sequential cuts of one read add up exactly. The same page now reads `omitted {"characters":6886,"controls":225,"regions":1}` with `nextAction: "browser_snapshot"` and a recovery path. A truncated visible-DOM or accessibility read no longer returns a bare flag either, and `truncated` now marks an incomplete answer by its presence across every bounded read — a complete read omits the field rather than publishing `false`.

- Report the shadow-DOM boundary of a read instead of reading through it silently. The digest and every `browser_extract` result count open shadow roots (`shadowRoots`, capped at 64) and the digest states that they are outside it, because the page tools observe the light tree and a Custom-Element page would otherwise look empty rather than bounded. `browser_extract` also returns the `resolvedScope` and `resolvedRoot` it chose for `scope: "primary"`/`"log"`, so a convenience scope is auditable and a wrong one is corrected by asking for `scope: "selector"` instead.

- Publish each metadata pair once across nested regions and prefer declared data over prose. Auditing real pages read-only found a build page printing two facts eight times because overlapping regions each republished their ancestor's `label: value` pairs; the first region in document order now keeps the pair and descendants stay silent, while zooming into a descendant still returns it. Pairs the page declares (table row, `dt`/`dd`) are emitted before pairs inferred from free text, so prose lookalikes cannot crowd real data out of the budget. Adds `npm run audit:digests` for read-only real-page auditing.

- Keep `browser_status` small by splitting it from diagnostics. It now prints identity once (target stability no longer repeats `browser`/`browserId`/`profile`/connection fields), carries a single monotonic `capabilityRevision` instead of the boolean capability map, and summarizes the Bridge as `{ok, version, port, extensionConnected, readyTargets}`. The capability map, per-request metrics, target inventory, user agent, and recovery detail moved to `browser_doctor`; actionable state (selection `targets`, a lost `target`, `error`, `completed`/`retryable`, `recommendation`, `nextAction`, `recovery` with issues) stays in the status read. A versioned-but-older extension runtime is reported as `extension_runtime_stale`; an extension that advertises no revision is a notice, because the per-request gates still fail closed with the exact missing capability.

- Derive the extension's advertised capability revision from a single `CAPABILITY_SINCE` table, so a capability can no longer be added to one surface and forgotten in the other; the Bridge relays `capabilityRevision` in its target identity and health.

- Tighten neutral metadata collection with structural rules instead of site vocabulary: a label is at most 32 characters and must not contain sentence punctuation, an inferred `label: value` line must not read as a sentence (no sentence-ending punctuation and no sentence break) and is capped at 120 characters, while a pair the page declares itself in a table row or `dt`/`dd` is capped at 320. Ordinary body text such as `- confirmed: the plugin resolves ... node_modules.` no longer enters `Values:`.

- Make `browser_tabs` filter at the source instead of paging: `query` matches title/URL case-insensitively, `owner` filters ownership, `limit` bounds the returned rows, and `documentIdentity: false` returns tab-fence-only handles. Document identity is probed only for the rows that are returned — a filtered listing no longer injects the Page Agent into tabs the caller did not ask about — and the result reports `totalTabs`/`matchedTabs`/`omittedTabs` with `recommendation: narrow_tab_query`. The default listing stays **complete** (hard-capped at 200 rows): a default that silently dropped rows hid the freshly created tab the bundled CLI looks up, which is the failure mode this rule exists to avoid.

- Retry the isolated multi-profile browser relaunch within a bounded budget, because a force-killed browser can still occupy its `--user-data-dir` and strand the extension handshake.

- Declare a `dsh.bundle.patch` manifest and ship `cordis.patch.yml` so `dsh plugin --profile web add` mounts the DSH package automatically instead of requiring a hand-merged Profile patch; published as `@lyd123qw2008/dsh-tool-control-chrome@0.5.9`.

- Make the isolated browser handshake tolerate a contended runner and capture a bounded tail of browser stderr so an extension load failure is distinguishable from a slow handshake.

- Remove a cross-socket ordering race in the cooperative Bridge restart test by waiting for the Bridge to drain pending browser requests before asserting the restart response.

- List the DSH integration package in the community plugin marketplaces by adding the `dsh-plugin` repository topic, matching npm keywords, and the documented `dsh plugin --profile web add` install command.

- Keep the public CI free of private infrastructure: the reusable-Profile compatibility check moved into the private Profile repository's own workflow, so the public build no longer needs a private-repository token, outside contributors get a green build without one, and the `Compatibility` workflow no longer claims to validate a Profile it never sees.

- Harden release publishing with exact-commit CI/Compatibility gates, a real installed-package smoke test, Node 24-compatible Actions, and cancellation of stale push runs.

- Reduce isolated Chrome/Edge E2E runtime by running browser candidates concurrently and bounding Windows browser/server cleanup.

- Replace the ranked Page Map with a neutral page digest. Regions are listed in document order — semantic landmarks plus containers carrying an id/test id, with a nested wrapper skipped only when it exposes exactly its ancestor's controls, and only `main`/`dialog` suppressing their contents — repeated containers are reported as counts instead of being expanded, and no region is called primary. The ~15 scoring thresholds, utility demotion, and key-action ranking are gone, so identical DOM now yields identical output and the plugin never decides which part of a page matters. See [`docs/COMPACT-READ-CONTRACT.zh-CN.md`](./docs/COMPACT-READ-CONTRACT.zh-CN.md).

- Make every bounded read retrievable. A digest reports what it omitted (`omitted.regions`/`controls`/`fields`/`characters`), names the next step (`nextAction`, `recommendation: narrow_read`) and the recovery path, and keeps every listed region addressable by `target`, `ref`, `{role name}` or `{selector=...}`; a selector-scoped `browser_snapshot`/`browser_extract` returns the same shape for a subtree, so missing context is obtained by narrowing rather than by widening the read. Row-level `primaryTruncated`/`secondaryTruncated`/`actionsTruncated` flags are replaced by these counts.

- Read page digest text from rendered content only. Falling back to `textContent` used to copy inline helper-script source into the summary on pages such as Jenkins.

- Make the published field list site-agnostic and privacy-guarded (`values`, previously `metadata`): it carries the bounded `label: value` pairs the page renders, with no build/CI field-name whitelist and no verdict, host, or image inference, and a `label: value` line whose label names a credential is omitted from both the digest and the model-visible summary.

- Add terminal-result waits and log matching as advertised capabilities: `browser_wait` accepts `textAny` with `failureTextAny` and reports `matchedText`/`terminalState`/`failed`, and `browser_extract({ scope: "log", logMatch })` reports `matchedLineCount`, bounded `matchedLineNumbers`, and `matchTruncated`. The Pi adapter's wait validation now accepts the same fields its schema already advertised.

- Detect a stale extension runtime instead of silently degrading. The extension advertises `waitTerminalStates`, `extractLogMatch`, and `extensionSelfReload`; the Bridge, Pi, and DSH reject a request whose capability is missing.

- Add `browser_reload_extension` so a refreshed distribution can be applied to a running browser without the browser's extension UI. It takes `confirmed: true`, restarts only the extension, and requires refreshed `browser_status`, tab, snapshot, ref, and handle state afterward.

- Document the capability-layer/personalization-layer boundary in `ARCHITECTURE.md`, `ARCHITECTURE.zh-CN.md`, `DECISIONS.zh-CN.md`, `docs/AGENT-CAPABILITY-ARCHITECTURE.zh-CN.md`, `CONTRIBUTING.md`, both READMEs, and the bundled Skill: the plugin owns page structure, identity and safety boundaries, and generic primitives, while a site's DOM shape, workflow, and field names belong to the calling Skill.

- Extend the isolated browser E2E with dedicated archetype pages — a region page with a landmark-free shell, a business page with no CI vocabulary, and a page that patches `String.prototype.trim` — so document order, region addressability, omission counts, credential redaction, and isolated-world immunity are asserted instead of a site's fields.

## 0.5.9 - 2026-09-12

- Harden target lease lifecycle with proactive expiry sweeps, session-scoped release, and automatic release on Pi, DSH, and Codex cleanup/disposal while retaining fail-closed behavior after uncertain cleanup.

- Add Profile compatibility and rollback metadata validation, release workflow concurrency/version guards, and a Node 22/24 CI matrix.

- Add isolated Chrome/Edge browser E2E matrix coverage plus repeated Bridge reconnect/lease invalidation stability coverage.

## 0.5.8 - 2026-09-12

- Add explicit session-scoped `browser_target_lease` acquisition, release, and status operations for opt-in multi-target control; leased target operations fail closed on conflicts, ownership mismatch, disconnect, reconnect, replacement, expiry, or Bridge restart.

- Add bounded Bridge lease and target-recovery observability, including connection/reconnect/disconnect metrics, lease conflict/release/expiry counters, target recovery timestamps, redacted active lease state, Bridge Doctor notices, and sanitized Pi/DSH/Codex recovery diagnostics.

- Add cross-harness lease/recovery contract coverage and isolated multi-Profile browser verification without changing default single-target behavior.

## 0.5.7 - 2026-09-12

- Add lightweight, explicitly confirmed Bridge restart handling for Pi and align restart recovery metadata across Pi, DSH, and Codex without restarting the browser or closing tabs.

- Add non-selecting `browser_targets` inventory across the browser-control surfaces; explicit `browser_status` acknowledgement remains required before controlling a selected target.

- Add an isolated real-browser Bridge restart E2E that verifies instance replacement, extension reconnect, stale target-route rejection, refreshed handles, continued page operations, and cleanup using a temporary Edge profile.

## 0.5.6 - 2026-09-08

- Add `browser_probe_interaction` as an explicit, single-dispatch interaction diagnostic that returns before/after document identity, action confirmation, bounded settle status, post-action Console/pageerror events, and target post-state without replaying uncertain side effects.

- Add bounded incremental Console reads with `since`/`nextSince`, `only: "errors"` filtering, and `Runtime.exceptionThrown` to `pageerror` mapping; expose the capability through Pi, DSH, Codex, Bridge, and the MV3 extension.

- Add isolated real-Edge regression fixtures for post-action Console errors, page errors, removed targets, asynchronous settling, stable state, and Console cursors; update the Skill, README, and release documentation.

- Add the DSH model-facing `browser_restart` tool with explicit confirmation, cooperative Bridge restart, extension reconnect waiting, and target/handle invalidation after the connection fence changes; bump the DSH package to `@lyd123qw2008/dsh-tool-control-chrome@0.5.6`.

## 0.5.5 - 2026-09-05

- Add bounded same-origin embedded-frame traversal to snapshot, extract, Accessibility Snapshot, and DOM-CUA reads, including frame diagnostics, loading state, cross-origin boundaries, and the `includeFrames: false` opt-out.

- Stabilize prototype-shell observations across dynamic iframe loading, document transitions, reconnects, and constrained browser crypto environments while preserving strict side-effect fencing and fail-closed behavior.

- Extend Pi, DSH, and Skill CLI schemas/documentation and real-browser regression coverage for frame-aware reads, lifecycle recovery, semantic controls, and keyboard `press` interactions.

## 0.5.4 - 2026-09-04

- Add a Codex CLI/Desktop plugin manifest and local MCP stdio adapter backed by the existing Bridge and the initial eight browser tools; no additional MCP listening port is required.

## 0.5.3 - 2026-09-03

- Trim the shared Pi/DSH browser Skill entry to its activation, fencing, AX, uncertainty, ownership, and cleanup contract; move detailed recovery and special workflows into Skill-local references and ship the same files in both hosts with load-path parity coverage.

## 0.5.2 - 2026-09-03

- Prefer the real Chromium Accessibility Tree for accessibility snapshots, retain bounded full/diff/unchanged output, safely fall back to the DOM semantic tree when the Accessibility domain is unavailable, and add document-scoped `aN` refs with fenced AX/DOM mapping and limited interactions.

- Make ordinary role/name, label, and accessible-text locator, wait, and interaction targets AX-first. Chromium-computed semantics now resolve through the current backend DOM under the existing document/frame fences; ambiguous or incomplete AX results fail closed, and mapped actions report `resolvedBy: "chromium_ax"`. Added real Edge coverage for shadow DOM, same-origin frames, dynamic redraw, custom ARIA state, and AX-only semantic resolution.

- Preserve structured tab-closed and tab-fence errors through DSH, fail closed before DOM fallback for incomplete or truncated AX trees, and add extension/Pi/DSH contract coverage for AX state, cancellation, mapping failures, and uncertain side effects.

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
