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

The extension returns tab metadata with `browserId`, `windowId`, `tabId`, title, URL, group, ownership, session and lifecycle fields. A stale claimed handle is detected when its saved title or URL no longer matches the current tab.

### Ownership

Every Agent-created window, tab and group should carry a session ownership record. User tabs are never silently moved to the Agent group. Claiming a user tab grants control without changing its physical browser placement.

## Trusted local mode (v1)

The initial extension installation and local pairing are the only user-facing trust boundary. Normal browser operations reuse the paired session and do not ask for shell authorization or browser-action confirmation.

Version 1 intentionally does not add per-session authorization, per-call confirmation, sensitive-action confirmation, audit policy, or site-level permission policy. This follows Pi's trusted local execution model.

The Bridge still needs two mechanical protocol protections: bind to loopback by default and reject requests without the paired local session token. It must not expose a remotely reachable unauthenticated endpoint.

## Protocol principles

- Request IDs are unique and cancellable.
- Browser events are separate from request responses.
- Tab-oriented responses carry browser, window and tab identity.
- Stale handles fail closed and require a fresh tab snapshot.
- Tab/group cleanup is ownership-aware and idempotent.
- Screenshots can be returned as Pi image content plus a saved path.
- CDP commands are capability-discovered; auditing is optional and deferred beyond the trusted-local v1 mode.

## Current implementation boundary

The current implementation covers local pairing, Bridge target registry and target-qualified routing, connection-generation fencing, one-target-per-session binding, tab and group ownership, stale-handle checks, page snapshots, locator and DOM operations, CUA, native CDP, screenshots, Console, Network, Dialog, Upload, Download and Clipboard controls. DSH and Pi expose separate host adapters over the same target-qualified Bridge protocol. Health, target inventory, doctor diagnostics, target disconnect state, and bounded Bridge metrics are available for recovery.

Deferred scope includes simultaneous multi-target control within one session, WebMCP, GSuite export, history APIs, media-specific downloads, broader capability discovery and browser-store packaging. The feature matrix records the remaining product scope.
