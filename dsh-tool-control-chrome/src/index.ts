/** Register the complete pi-control-chrome browser tool surface in DSH. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { registerChromeCommand } from './commands.js'
import { BrowserBridgeClient, resolveConfig } from './bridge.js'
import { registerBrowserTools } from './tools.js'
import type { Config as ControlChromeConfig } from './types.js'

export type { BrowserResult, ResolvedConfig, ScreenshotResult } from './types.js'
export interface Config extends ControlChromeConfig {}
export { BrowserBridgeClient, resolveConfig } from './bridge.js'
export { BROWSER_TOOL_NAMES, browserToolCatalog } from './tools.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-control-chrome'

/** The DSH registry consumed by the model-facing browser tools. */
export const inject = ['tools', 'commands']

/** Settings namespace carrying the local Bridge connection configuration. */
export const CONTROL_CHROME_SETTINGS_NAMESPACE = settingsNamespace('control-chrome')

/** Cordis configuration schema for the local browser Bridge. */
export const Config: z<Config> = z.object({
  bridgeHost: z.string().default('127.0.0.1'),
  bridgePort: z.number().step(1).min(1).max(65_535).default(17_318),
  tokenFile: z.string(),
  autoStartBridge: z.boolean().default(true),
  requestTimeoutMs: z.number().step(1).min(1).default(120_000),
  bridgeScript: z.string(),
})

/**
 * Install settings-backed browser tools. The plugin opens a Bridge connection
 * lazily on the first browser call and leaves the reusable local Bridge alive
 * when its DSH fiber is disposed.
 *
 * @param ctx - DSH context providing the model tool registry and settings.
 * @param config - initial local Bridge settings.
 */
export function apply(ctx: Context, config: Config): void {
  let currentSource: () => Config = () => config
  const current = () => resolveConfig(currentSource())
  installSettingsSection(ctx, CONTROL_CHROME_SETTINGS_NAMESPACE, Config, config, {
    setSource: source => { currentSource = source },
    onChange: () => {},
  })
  const bridge = new BrowserBridgeClient(current)
  const attachments = ctx.get('attachments') as AttachmentStore | undefined
  registerBrowserTools(ctx, bridge, attachments, current)
  registerChromeCommand(ctx, bridge)
  ctx.effect(() => async () => {
    await bridge.stop()
  }, 'control-chrome: dispose Bridge client')
}
