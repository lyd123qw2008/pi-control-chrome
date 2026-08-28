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

A numeric tab id is scoped to a tab lifetime and is fenced by a durable `tabFence`; lifecycle events never authorize an unrelated reuse of that id. Complete handles also carry a document `incarnation` derived from URL, `performance.timeOrigin`, and a per-document token. Navigation invalidates snapshots, DOM refs, dialogs, file choosers, and Network request-loader mappings; response-body reads require the matching `requestId` and `loaderId` from the current Network listing. Every page operation checks the document before and after execution; an identity change makes a side-effecting result uncertain and non-retryable.

### Debugger leases

Debugger attachment records include browser id, tab fence, attach epoch, and CDP target id. Lease records are persisted in extension local storage so an MV3 worker restart cannot make an attached target appear unowned. Ordinary cleanup does not detach an untracked global debugger target. Explicit `recoverStale: true` may detach a persisted lease only after rechecking the tab fence and target id before and after detachment; an unverified target remains a reported recovery failure.

### Creation and replacement races

The extension serializes ownership mutations and tracks create flights, completion markers, removal intents, and lifecycle tombstones. A `tabs.onCreated` event that arrives before reservation setup is reconciled only when its tab id, window, URL, event sequence, and active create flight agree. Replaced tabs transfer ownership only after old and new fences, stable tab metadata, document identity, and replacement epoch agree. Chrome does not provide an authoritative creation token or atomic incarnation-qualified numeric removal API, so unresolved ambiguity fails closed and is surfaced for inspection.

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
