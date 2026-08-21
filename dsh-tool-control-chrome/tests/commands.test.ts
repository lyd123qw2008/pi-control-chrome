import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserBridgeClient } from '../src/bridge.js'
import { registerChromeCommand } from '../src/commands.js'

type Handler = (invocation: { rawInput: string; agent: { session: { id: string } }; signal: AbortSignal }) => Promise<{ kind: string; text?: string }>

function setup(bridge: Pick<BrowserBridgeClient, 'request' | 'health' | 'restart'>): { handler: Handler; commands: Map<string, unknown> } {
  const commands = new Map<string, unknown>()
  const ctx = {
    commands: {
      register(definition: { name: string; handler: Handler }) {
        commands.set(definition.name, definition.handler)
        return () => { commands.delete(definition.name) }
      },
    },
  } as unknown as Context
  registerChromeCommand(ctx, bridge as BrowserBridgeClient)
  return { handler: commands.get('chrome') as Handler, commands }
}

function invocation(rawInput: string) {
  return { rawInput, agent: { session: { id: 'session-test' } }, signal: new AbortController().signal }
}

describe('DSH /chrome command', () => {
  it('registers status and includes local-user Bridge diagnostics', async () => {
    const request = vi.fn(async () => ({ connected: true, browser: 'chrome', browserId: 'chrome:test' }))
    const health = vi.fn(async () => ({ ok: true, startedBy: 'pi', controlDomain: 'local_user', capabilities: { cooperativeRestart: true }, restart: { available: true } }))
    const { handler } = setup({ request, health, restart: vi.fn() })
    const result = await handler(invocation('status'))
    expect(result.kind).toBe('success')
    expect(result.text).toContain('local_user')
    expect(request).toHaveBeenCalledWith('status', { sessionId: 'session-test' }, expect.any(AbortSignal))
  })

  it('allows a human restart command without launcher-label checks', async () => {
    const restart = vi.fn(async () => ({ ok: true, restarted: true, bridgeHealth: { startedBy: 'pi' } }))
    const { handler } = setup({ request: vi.fn(), health: vi.fn(), restart })
    const result = await handler(invocation('restart'))
    expect(result.kind).toBe('success')
    expect(restart).toHaveBeenCalledOnce()
  })

  it('rejects unsupported arguments without touching the Bridge', async () => {
    const request = vi.fn()
    const health = vi.fn()
    const restart = vi.fn()
    const { handler } = setup({ request, health, restart })
    const result = await handler(invocation('restart now'))
    expect(result).toEqual({ kind: 'error', text: 'Usage: /chrome status|doctor|restart|tabs' })
    expect(request).not.toHaveBeenCalled()
    expect(health).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })
})
