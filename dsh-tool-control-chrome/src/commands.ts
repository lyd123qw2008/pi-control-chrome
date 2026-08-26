/** Human-facing DSH commands for the local Chrome/Edge Bridge. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { bridgeRecovery } from './diagnostics.js'
import type { BrowserBridgeClient } from './bridge.js'

function render(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function sessionId(invocation: CommandInvocation): string {
  return invocation.agent.session.id
}

function usage(): CommandResult {
  return {
    kind: 'error',
    text: 'Usage: /chrome status|targets|profile [browserId]|connect|disconnect|doctor|restart|tabs',
  }
}

const EXTENSION_READY_ATTEMPTS = 40
const EXTENSION_READY_DELAY_MS = 150

function extensionConnected(health: Record<string, unknown>): boolean {
  return health.extensionConnected === true
}

async function waitForExtension(
  bridge: BrowserBridgeClient,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let lastHealth: Record<string, unknown> | undefined
  let lastError: unknown
  for (let attempt = 0; attempt < EXTENSION_READY_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted()
    try {
      lastHealth = await bridge.health()
      if (extensionConnected(lastHealth)) return lastHealth
    } catch (error) {
      lastError = error
    }
    if (attempt + 1 < EXTENSION_READY_ATTEMPTS) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer)
          reject(new Error('Chrome Bridge connection was cancelled.'))
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, EXTENSION_READY_DELAY_MS)
        signal.addEventListener('abort', onAbort, { once: true })
        timer.unref?.()
      })
    }
  }
  if (lastHealth !== undefined) return lastHealth
  throw lastError instanceof Error ? lastError : new Error('Chrome Bridge health was unavailable.')
}

function extensionOffline(bridgeHealth: Record<string, unknown>): CommandResult {
  return {
    kind: 'error',
    text: render({
      ok: false,
      error: 'Chrome/Edge extension is not connected.',
      bridgeHealth,
      recommendation: 'Reload the unpacked extension or run /chrome restart.',
    }),
  }
}

async function browserStatus(
  bridge: BrowserBridgeClient,
  invocation: CommandInvocation,
  browserId?: string,
): Promise<CommandResult> {
  await bridge.start()
  const bridgeHealth = await bridge.health()
  if (!extensionConnected(bridgeHealth)) {
    return {
      kind: 'success',
      text: render({ status: { connected: false }, bridgeHealth }),
    }
  }
  const status = browserId === undefined
    ? await bridge.request('status', { sessionId: sessionId(invocation) }, invocation.signal)
    : await bridge.request('status', { sessionId: sessionId(invocation) }, invocation.signal, { browserId })
  return {
    kind: 'success',
    text: render({
      ...(typeof status === 'object' && status !== null ? status : { status }),
      bridgeHealth: await bridge.health(),
    }),
  }
}

async function connectBrowser(
  bridge: BrowserBridgeClient,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  await bridge.start()
  const bridgeHealth = await waitForExtension(bridge, invocation.signal)
  if (!extensionConnected(bridgeHealth)) return extensionOffline(bridgeHealth)
  const status = await bridge.request('status', { sessionId: sessionId(invocation) }, invocation.signal)
  return {
    kind: 'success',
    text: render({
      connected: true,
      status,
      bridgeHealth: await bridge.health(),
    }),
  }
}

async function restartBrowser(
  bridge: BrowserBridgeClient,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const result = await bridge.restart()
  const bridgeHealth = await waitForExtension(bridge, invocation.signal)
  if (!extensionConnected(bridgeHealth)) return extensionOffline({ ...bridgeHealth, restart: result })
  const status = await bridge.request('status', { sessionId: sessionId(invocation) }, invocation.signal)
  return {
    kind: 'success',
    text: render({ ...result, connected: true, status, bridgeHealth: await bridge.health() }),
  }
}

/** Register the local-user Bridge commands without exposing lifecycle control to model tools. */
export function registerChromeCommand(ctx: Context, bridge: BrowserBridgeClient): void {
  ctx.commands.register({
    name: 'chrome',
    description: 'Connect, inspect, or restart the local Chrome/Edge Bridge.',
    input: { hint: 'status|targets|profile [browserId]|connect|disconnect|doctor|restart|tabs' },
    handler: async invocation => {
      const parts = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
      const action = parts[0] ?? 'status'
      if (parts.length > 1 && action !== 'profile') return usage()
      try {
        if (action === 'status') return browserStatus(bridge, invocation)
        if (action === 'targets') {
          await bridge.start()
          const targets = await bridge.request('list_targets', {}, invocation.signal)
          return { kind: 'success', text: render(targets) }
        }
        if (action === 'profile') {
          if (parts[1] === undefined) {
            await bridge.start()
            const targets = await bridge.request('list_targets', {}, invocation.signal)
            return { kind: 'success', text: render(targets) }
          }
          return browserStatus(bridge, invocation, parts[1])
        }
        if (action === 'connect') return connectBrowser(bridge, invocation)
        if (action === 'disconnect') {
          await bridge.stop()
          return { kind: 'success', text: render({ ok: true, disconnected: true, bridge: 'left running for later /chrome connect' }) }
        }
        if (action === 'doctor') {
          const diagnosis = await bridge.request('doctor', {}, invocation.signal)
          if (typeof diagnosis === 'object' && diagnosis !== null && ('bridgeHealth' in diagnosis || 'targets' in diagnosis)) {
            return { kind: 'success', text: render(diagnosis) }
          }
          const bridgeHealth = await bridge.health()
          const status = bridgeHealth.extensionConnected === true
            ? await bridge.request('status', { sessionId: sessionId(invocation) }, invocation.signal)
            : { connected: false }
          return {
            kind: 'success',
            text: render({
              ...(typeof status === 'object' && status !== null ? status : { status }),
              bridgeHealth,
              recovery: bridgeRecovery(bridgeHealth),
            }),
          }
        }
        if (action === 'tabs') {
          const tabs = await bridge.request('list_tabs', { sessionId: sessionId(invocation) }, invocation.signal)
          return { kind: 'success', text: render(tabs) }
        }
        if (action === 'restart') {
          if (invocation.signal.aborted) return { kind: 'error', text: 'Chrome Bridge restart was cancelled.' }
          return restartBrowser(bridge, invocation)
        }
        return usage()
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
