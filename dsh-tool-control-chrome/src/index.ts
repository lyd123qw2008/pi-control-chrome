/** Register the Skill-gated pi-control-chrome browser tool surface in DSH. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { registerChromeCommand } from './commands.js'
import { BrowserBridgeClient, resolveConfig } from './bridge.js'
import { registerBrowserTools } from './tools.js'
import { registerBrowserSkill } from './skill.js'
import type { Config as ControlChromeConfig } from './types.js'

export type { BrowserElementTarget, BrowserExposureMode, BrowserResult, BrowserTarget, BrowserTargetRoute, BrowserWaitState, ResolvedConfig, ScreenshotResult } from './types.js'
export type { BrowserCapabilityGroup, BrowserCapabilityGroupDescriptor, BrowserCapabilityOperation, BrowserCapabilitySafety, BrowserOperationSpec, BrowserToolSpec } from './tools.js'
export interface Config extends ControlChromeConfig {}
export { BrowserBridgeClient, resolveConfig } from './bridge.js'
export { BROWSER_API_REVISION, BROWSER_TOOL_NAMES, PROGRESSIVE_BROWSER_TOOL_NAMES, browserCapabilityCatalog, browserOperationRegistry, browserToolCatalog } from './tools.js'
export { BROWSER_SKILL_CONTENT, BROWSER_SKILL_DESCRIPTION, BROWSER_SKILL_NAME } from './skill.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-control-chrome'

/** The DSH registry consumed by the model-facing browser tools. */
export const inject = ['tools', 'commands']

/** Settings namespace carrying the local Bridge connection configuration. */
export const CONTROL_CHROME_SETTINGS_NAMESPACE = 'control-chrome' as SettingsNamespace

/** Cordis configuration schema for the local browser Bridge. */
export const Config: z<Config> = z.object({
  bridgeHost: z.string().default('127.0.0.1'),
  bridgePort: z.number().step(1).min(1).max(65_535).default(17_318),
  tokenFile: z.string(),
  autoStartBridge: z.boolean().default(true),
  requestTimeoutMs: z.number().step(1).min(1).max(120_000).default(120_000),
  extensionReadyTimeoutMs: z.number().step(1).min(0).max(120_000).default(6_000),
  lazyTools: z.boolean().default(true),
  exposureMode: z.union([z.const('lazy-full'), z.const('progressive')]).default('lazy-full'),
  bridgeScript: z.string(),
})

/**
 * Install settings-backed browser tools. With the default `lazy-full` exposure
 * and `lazyTools: true`, the complete browser catalog is registered in the
 * current Agent only after the `pi-control-chrome` Skill succeeds. With
 * `exposureMode: 'progressive'`, a fixed browser facade is registered from
 * plugin startup and capability/operation details travel in tool results without
 * changing the model-visible tool set. The Bridge remains lazy until a browser
 * operation runs. Human `/chrome` commands remain available without model Skill
 * activation.
 *
 * @param ctx - DSH context providing the model tool registry and settings.
 * @param config - initial local Bridge settings.
 */
export function apply(ctx: Context, config: Config): void {
  let currentSource: () => Config = () => config
  const current = () => resolveConfig(currentSource())
  const bridge = new BrowserBridgeClient(current)
  const attachments = ctx.get('attachments') as AttachmentStore | undefined
  let disposeBrowserTools: (() => Promise<void>) | undefined
  const initializeBrowserTools = (): void => {
    if (disposeBrowserTools !== undefined) return
    disposeBrowserTools = registerBrowserTools(ctx, bridge, attachments, current)
  }
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(CONTROL_CHROME_SETTINGS_NAMESPACE, Config, { base: config })
    currentSource = () => scope.get()
    // Registration mode is a cache boundary and is captured by registerBrowserTools.
    // When settings already exist, wait for this resolved source instead of observing
    // the empty composition entry and accidentally locking into lazy-full.
    initializeBrowserTools()
  })
  // The catalog is a provider-prefix cache boundary. Do not fall back to the
  // composition entry while the settings provider is still mounting: doing so
  // would permanently capture lazy-full before the user `exposureMode` arrives.
  // DSH composes dsh-settings; hosts that omit it intentionally receive commands
  // and the bundled Skill but no model-facing browser catalog.
  registerBrowserSkill(ctx)
  registerChromeCommand(ctx, bridge)
  ctx.effect(() => async () => {
    try {
      await disposeBrowserTools?.()
    } finally {
      await bridge.stop()
    }
  }, 'control-chrome: dispose browser tools and Bridge client')
}
