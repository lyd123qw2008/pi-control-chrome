/** Public configuration and output types for the DSH browser-control plugin. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Plugin configuration accepted by Cordis and the settings section. */
export interface Config {
  /** Loopback host where the local Bridge listens. The checked-in extension uses `127.0.0.1`; custom hosts require a matching extension build. Defaults to `127.0.0.1`. */
  bridgeHost?: string
  /** Local Bridge port. The checked-in extension uses `17318`; custom ports require matching extension code and manifest CSP. Defaults to `17318`. */
  bridgePort?: number
  /** Pairing-token file. Defaults to the current user's Pi agent token path. */
  tokenFile?: string
  /** Start the bundled Bridge when no healthy Bridge is running. Defaults to true. */
  autoStartBridge?: boolean
  /** Register browser tools only after the pi-control-chrome Skill loads. Defaults to true. */
  lazyTools?: boolean
  /** Per-request Bridge timeout in milliseconds. Defaults to 120000. */
  requestTimeoutMs?: number
  /** Time to wait for the extension's background reconnect before reporting a disconnected state. Defaults to 6000. */
  extensionReadyTimeoutMs?: number
  /** Optional local Bridge script override for development and tests. */
  bridgeScript?: string
}

/** Fully resolved settings used by the Bridge client. */
export interface ResolvedConfig {
  readonly bridgeHost: string
  readonly bridgePort: number
  readonly tokenFile: string
  readonly autoStartBridge: boolean
  readonly requestTimeoutMs: number
  readonly extensionReadyTimeoutMs: number
  readonly lazyTools: boolean
  readonly bridgeScript?: string
}

/** JSON-compatible result returned by the browser Bridge. */
export type BrowserResult = Record<string, unknown>

/**
 * A semantic or structural browser element target.
 *
 * The target accepts one primary locator (`ref`, `selector`, `role`, `label`,
 * `placeholder`, `text`, or `testId`) and optional narrowing fields.
 */
export interface BrowserElementTarget {
  readonly ref?: string
  readonly selector?: string
  readonly role?: string
  readonly name?: string
  readonly label?: string
  readonly placeholder?: string
  readonly text?: string
  readonly testId?: string
  readonly exact?: boolean
  readonly index?: number
  readonly scopeSelector?: string
  readonly hasText?: string
  readonly hasSelector?: string
}

/** Conditions supported by the browser wait tool. */
export type BrowserWaitState = 'load' | 'url' | 'text' | 'text_gone' | 'visible' | 'hidden' | 'enabled'

/** Logical browser target selected for a session. */
export interface BrowserTarget {
  readonly browser: string
  readonly browserId: string
  readonly profile: string
  readonly state?: string
  readonly connectionId?: string
  readonly connectionGeneration?: number
}

/** Physical Bridge connection fence for a logical browser target. */
export interface BrowserTargetRoute {
  readonly browserId: string
  readonly connectionId?: string
  readonly connectionGeneration?: number
}

/** Screenshot result after optional attachment admission. */
export interface ScreenshotResult extends BrowserResult {
  readonly data?: string
  readonly mimeType?: string
  readonly path?: string
  readonly attachment?: ImageAttachmentRef
}
