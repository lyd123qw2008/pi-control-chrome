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
    text: 'Usage: /chrome status|doctor|restart|tabs',
  }
}

/** Register the local-user Bridge commands without exposing lifecycle control to model tools. */
export function registerChromeCommand(ctx: Context, bridge: BrowserBridgeClient): void {
  ctx.commands.register({
    name: 'chrome',
    description: 'Inspect or restart the local Chrome/Edge Bridge.',
    input: { hint: 'status|doctor|restart|tabs' },
    handler: async invocation => {
      const parts = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
      const action = parts[0] ?? 'status'
      if (parts.length > 1) return usage()
      try {
        if (action === 'status') {
          const status = await bridge.request('status', { sessionId: sessionId(invocation) }, invocation.signal)
          const bridgeHealth = await bridge.health()
          return { kind: 'success', text: render({ ...(typeof status === 'object' && status !== null ? status : { status }), bridgeHealth }) }
        }
        if (action === 'doctor') {
          const bridgeHealth = await bridge.health()
          const status = await bridge.request('status', { sessionId: sessionId(invocation) }, invocation.signal)
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
          const result = await bridge.restart()
          return { kind: 'success', text: render(result) }
        }
        return usage()
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
