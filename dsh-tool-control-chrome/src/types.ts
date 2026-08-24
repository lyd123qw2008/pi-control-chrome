/** Public configuration and output types for the DSH browser-control plugin. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Plugin configuration accepted by Cordis and the settings section. */
export interface Config {
  /** Loopback host where the local Bridge listens. Defaults to `127.0.0.1`. */
  bridgeHost?: string
  /** Local Bridge port. Defaults to `17318`. */
  bridgePort?: number
  /** Pairing-token file. Defaults to the current user's Pi agent token path. */
  tokenFile?: string
  /** Start the bundled Bridge when no healthy Bridge is running. Defaults to true. */
  autoStartBridge?: boolean
  /** Register browser tools only after the pi-control-chrome Skill loads. Defaults to true. */
  lazyTools?: boolean
  /** Per-request Bridge timeout in milliseconds. Defaults to 120000. */
  requestTimeoutMs?: number
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
  readonly lazyTools: boolean
  readonly bridgeScript?: string
}

/** JSON-compatible result returned by the browser Bridge. */
export type BrowserResult = Record<string, unknown>

/** Screenshot result after optional attachment admission. */
export interface ScreenshotResult extends BrowserResult {
  readonly data?: string
  readonly mimeType?: string
  readonly path?: string
  readonly attachment?: ImageAttachmentRef
}
