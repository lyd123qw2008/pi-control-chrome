# Proposed Architecture

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
  ├── session registry
  ├── request routing
  ├── reconnect handling
  ├── authorization state
  └── audit log
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

```ts
interface TabHandle {
  browserId: string;
  windowId: number;
  tabId: number;
  title: string;
  url: string;
  snapshotVersion: string;
  owner: "user" | "agent";
  sessionId?: string;
  groupId?: number;
  state: "claimed" | "released" | "closed" | "stale";
}
```

### Ownership

Every Agent-created window, tab and group should carry a session ownership record. User tabs are never silently moved to the Agent group. Claiming a user tab grants control without changing its physical browser placement.

## Trusted local mode (v1)

The initial extension installation and local pairing are the only user-facing trust boundary. Normal browser operations reuse the paired session and do not ask for shell authorization or browser-action confirmation.

Version 1 intentionally does not add per-session authorization, per-call confirmation, sensitive-action confirmation, audit policy, or site-level permission policy. This follows Pi's trusted local execution model.

The Bridge still needs two mechanical protocol protections: bind to loopback by default and reject requests without the paired local session token. It must not expose a remotely reachable unauthenticated endpoint.

## Protocol principles

- Request IDs are unique and cancellable.
- Browser events are separate from request responses.
- Every response carries the browser, window and tab identity.
- Stale handles fail closed and require a fresh tab snapshot.
- Tab/group cleanup is ownership-aware and idempotent.
- Screenshots can be returned as Pi image content plus a saved path.
- CDP commands are capability-discovered; auditing is optional and deferred beyond the trusted-local v1 mode.

## First implementation slice

Before implementing the full API, build and test only:

1. Extension ↔ Bridge pairing.
2. Pi `chrome_status` and `chrome_tabs` tools.
3. `chrome_snapshot` for the selected tab.
4. `chrome_navigate`, `chrome_click`, `chrome_fill` and `chrome_screenshot`.
5. Agent tab creation with a Pi group.
6. Claim/release and session cleanup.
7. One raw `Runtime.evaluate` CDP method.

The complete feature matrix remains in `FEATURES.md`; no P1/P2 feature should silently expand the first slice before the user confirms the scope.
