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
  ├── request routing
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
  id: string;
  family: "chrome" | "edge" | "chromium" | "brave";
  profileId?: string;
  profileName?: string;
  extensionVersion: string;
  connectedAt: number;
  capabilities: string[];
}
```

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

The current implementation covers local pairing, Bridge request routing, one active extension target, tab and group ownership, stale-handle checks, page snapshots, locator and DOM operations, CUA, native CDP, screenshots, Console, Network, Dialog, Upload, Download and Clipboard controls. DSH and Pi expose separate host adapters over the same Bridge protocol.

Deferred scope includes multiple browser Profiles, WebMCP, GSuite export, history APIs, media-specific downloads, capability discovery and browser-store packaging. The feature matrix records the remaining product scope.
