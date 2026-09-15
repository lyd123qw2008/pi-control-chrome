# Architecture

## Components

```text
Chrome/Edge MV3 Extension
  ├── service worker
  ├── content script / DOM adapter
  ├── CDP adapter
  ├── tab/group/ownership manager
  └── local Bridge client
          ↕ 127.0.0.1 + pairing token
Local Bridge
  ├── pairing and lifecycle state
  ├── browser-target registry
  ├── target-qualified request routing
  ├── connection-generation fencing
  ├── bounded diagnostics and recovery state
  └── browser target validation
          ↕ Pi Extension protocol
Pi Extension
  ├── browser lifecycle
  ├── browser tools
  ├── `/chrome ...` commands
  ├── tab handle and cleanup state
  └── Pi UI/status/confirmation integration
```

## Core objects

### Browser connection

```ts
interface BrowserConnection {
  browserId: string;
  connectionId: string;
  connectionGeneration: number;
  family: "chrome" | "edge" | "chromium" | "brave";
  profileId: string;
  profileName?: string;
  extensionVersion?: string;
  state: "ready" | "disconnected" | "replaced";
  connectedAt?: number;
  capabilities: string[];
}
```

### Browser target and connection

A logical browser target identifies one browser Profile and remains stable across extension reconnects. The current protocol uses `browserId` as that identity and reports the browser family and Profile identifier with it. A WebSocket is a physical connection to that target, not the target identity itself. Each target connection receives a `connectionId` and monotonic `connectionGeneration`; Bridge requests may include these fields to reject stale sockets and stale operation routes.

A Bridge can keep multiple targets ready at the same time. A request without a target is accepted only when exactly one ready target is available. When multiple targets are ready, Pi, DSH, and the managed Skill CLI require an explicit `browserId`; they never select the newest connection, active window, or first list entry implicitly. One Agent session binds to one target at a time. A target replacement or disconnect does not transfer ownership to another target.

### Recovery and observability

Bridge health exposes the target registry, target state, connection generation, capability metadata, bounded metrics, and recent non-sensitive lifecycle diagnostics. `list_targets` returns the target inventory, and `doctor` returns target-independent Bridge recovery information. Target disconnects preserve the logical target record and pending recovery state while requests routed to that target fail with a deterministic error. Side-effecting browser operations are not automatically replayed after a timeout or connection change; callers must inspect the current page before retrying.

### Tab handle

The extension returns tab metadata with `browserId`, `windowId`, `tabId`, title, URL, group, ownership, session and lifecycle fields. Claim snapshots may supply `tabId` alone or any combination of title, URL and window checks; every supplied value is re-read immediately before the ownership record is written. A mismatch fails closed, and a stale claimed handle requires a fresh tab snapshot.

### Tab identity and document identity

A numeric tab id is scoped to a tab lifetime and is fenced by a durable `tabFence`; lifecycle events never authorize an unrelated reuse of that id. Complete handles also carry a document `incarnation` derived from URL, `performance.timeOrigin`, and a per-document token. Snapshot refs and DOM-CUA node ids are bounded live observations within their originating document: title/focus changes, later observations, and unrelated DOM churn preserve a still-matching original node; one detached node may make one unique, strongly equivalent same-document rebind. Navigation, reload, and document replacement invalidate old observations with `BROWSER_DOCUMENT_CHANGED`; tab closure and a changed tab fence return `BROWSER_TAB_CLOSED` and `BROWSER_TAB_FENCE_CHANGED`, alongside dialogs, file choosers, and Network request-loader mappings. A `navigate(wait: false)`, `back`, `forward`, or `reload` response returns a tab explicitly marked `transitionPending` whose handle omits unstable URL/title and incarnation fields, so callers must wait and re-observe before document-bound work; response-body reads require the matching `requestId` and `loaderId` from the current Network listing. Read-only page reads re-observe a user tab and retry once when its document changes during observation, returning `BROWSER_PAGE_CHANGING` if it remains unstable. Side-effecting page operations check the document before and after execution: a confirmed action remains successful when its post-action identity is readable, including after a transition; only a lost injected result or unverifiable post-action identity is uncertain and non-retryable.

### Debugger leases

Debugger attachment records include browser id, tab fence, attach epoch, and CDP target id. Lease records are persisted in extension local storage so an MV3 worker restart cannot make an attached target appear unowned. Ordinary cleanup does not detach an untracked global debugger target. Explicit `recoverStale: true` may detach a persisted lease only after rechecking the tab fence and target id before and after detachment; an unverified target remains a reported recovery failure.

### Creation and replacement races

The extension serializes ownership mutations and tracks create flights, completion markers, removal intents, and lifecycle tombstones. A `tabs.onCreated` event that arrives before reservation setup is reconciled only when its tab id, window, URL, event sequence, and active create flight agree. Replaced tabs transfer ownership only after old and new fences, stable tab metadata, document identity, and replacement epoch agree. Chrome does not provide an authoritative creation token or atomic incarnation-qualified numeric removal API, so unresolved ambiguity fails closed and is surfaced for inspection.

## Capability layer and personalization layer

This distribution is a capability layer. It knows page *structure* and how to observe or act on a page safely; it deliberately knows nothing about any product's field names, status vocabulary, or layout. Site-specific handling belongs to the calling Skill, which composes it from the generic primitives.

| Concern | Owner | Examples |
| --- | --- | --- |
| Page structure | Capability layer | landmarks, headings, primary page object, utility/boilerplate demotion, secondary regions, key actions, truncation flags |
| Identity, safety, lifecycle | Capability layer | `browserId` / `tabFence` / `incarnation` / `snapshotId`, tab ownership and leases, cleanup, capability advertisement, extension self-reload, no automatic replay of uncertain side effects |
| Generic primitives | Capability layer | wait states including caller-supplied terminal text sets, extract scopes with `tail` and `logMatch`, `evaluate`, CDP, Console, Network, Dialog, Upload, Download, Clipboard |
| Site-agnostic data | Capability layer | rendered-text-only page map, bounded `label: value` pairs, ARIA status regions, redaction of secret-labelled lines |
| A site's DOM shape | Personalization layer (Skill) | selectors, field names, status vocabulary, layout specifics |
| A site's workflow | Personalization layer (Skill) | step ordering, trigger de-duplication, retry policy, evidence contract, reporting |
| Domain parsing | Personalization layer (Skill) | build number, revision, branch, node, duration, or result for a CI page, and the equivalents on any other product page |

Rules:

1. If a site fact can be carried by a caller-supplied literal or a caller-authored page script, it stays out of the plugin.
2. A site fact enters the plugin only after it generalizes to a *structural* principle that holds for unrelated page archetypes — for example "search, header, footer, breadcrumb, pagination, sidebars, and per-row history controls are utility regions or lists, never the primary object". A product name, a site URL, or a site selector never does.
3. Site logic lives in the Skill that owns the workflow: read-only, bounded, self-contained, and documented with its field contract next to that workflow.
4. When the plugin's structural output is wrong for a site, fix the generic ranking or noise rule and add an archetype fixture; do not add a site special case.
5. Tests follow the same split. Plugin tests assert generic invariants over synthetic archetypes (landmark-free shell, `<main>` application, business page, log pane, hostile page). The owning Skill asserts its own domain fields.
6. Capability advertisement is the enforcement point: the plugin exposes primitives such as `waitTerminalStates` and `extractLogMatch` so it never has to recognize a product's terminal strings itself, and a stale runtime is rejected instead of silently degrading.

A review that adds a product name, a site URL, a site selector, or a domain field name to `extension/`, `bridge/`, or a host adapter is out of scope by default; move that logic to the calling Skill.

## Trusted local mode (v1)

The initial extension installation and local pairing are the only user-facing trust boundary. Normal browser operations reuse the paired session and do not ask for shell authorization or browser-action confirmation.

Version 1 intentionally does not add per-session authorization, per-call confirmation, sensitive-action confirmation, audit policy, or site-level permission policy. This follows Pi's trusted local execution model.

The Bridge binds to loopback and requires the paired bearer token for WebSocket browser operations. `GET /pair` is an intentionally unauthenticated loopback bootstrap endpoint because the unpacked extension cannot read the host token file; any local process that can reach the port is therefore inside the trusted-local v1 threat model. The endpoint and Bridge must not be exposed through a network interface or proxy.

## Protocol principles

- Request IDs are unique. Explicit cancellation is best-effort: it stops abort-aware waits and barriers, but an operation already executing in the extension or browser may have side effects. Uncertain side-effecting operations are never replayed automatically.
- Browser events are separate from request responses.
- Tab-oriented responses carry browser, window and tab identity.
- Stale handles fail closed and require a fresh tab snapshot.
- Tab/group cleanup is ownership-aware and idempotent. Unknown-incarnation Agent records remain retained during ordinary cleanup; an explicit `recoverStale` cleanup request forgets them without closing their tabs and reports the recovered ids.
- Screenshots can be returned as Pi image content plus a saved path.
- CDP commands are capability-discovered; auditing is optional and deferred beyond the trusted-local v1 mode.

## Current implementation boundary

The current implementation covers local pairing, Bridge target registry and target-qualified routing, connection-generation fencing, one-target-per-session binding, tab and group ownership, stale-handle checks, page snapshots, semantic role/name/label/placeholder/text/test-id targets, explicit target indexing, DOM waits for load/URL/text/visibility/hidden/enabled states, locator and DOM operations, CUA, native CDP, screenshots, Console, Network, Dialog, Upload, Download and Clipboard controls. The extension advertises `semanticTargets` and `pageWaitStates` capabilities so older extensions are rejected instead of silently ignoring new request fields. DSH and Pi expose separate host adapters over the same target-qualified Bridge protocol. Health, target inventory, doctor diagnostics, target disconnect state, and bounded Bridge metrics are available for recovery.

Deferred scope includes simultaneous multi-target control within one session, WebMCP, GSuite export, history APIs, media-specific downloads, broader capability discovery and browser-store packaging. The feature matrix records the remaining product scope.
