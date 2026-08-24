import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserBridgeClient } from '../src/bridge.js'
import { registerChromeCommand } from '../src/commands.js'

type Handler = (invocation: { rawInput: string; agent: { session: { id: string } }; signal: AbortSignal }) => Promise<{ kind: string; text?: string }>

function setup(bridge: Pick<BrowserBridgeClient, 'request' | 'health' | 'start' | 'stop' | 'restart'>): { handler: Handler; commands: Map<string, unknown> } {
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
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, startedBy: 'pi', controlDomain: 'local_user', capabilities: { cooperativeRestart: true }, restart: { available: true } }))
    const { handler } = setup({ request, health, start: vi.fn(), stop: vi.fn(), restart: vi.fn() })
    const result = await handler(invocation('status'))
    expect(result.kind).toBe('success')
    expect(result.text).toContain('local_user')
    expect(request).toHaveBeenCalledWith('status', { sessionId: 'session-test' }, expect.any(AbortSignal))
  })

  it('allows a human restart command without launcher-label checks', async () => {
    const restart = vi.fn(async () => ({ ok: true, restarted: true, bridgeHealth: { extensionConnected: true, startedBy: 'pi' } }))
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, startedBy: 'pi' }))
    const { handler } = setup({ request: vi.fn(async () => ({ connected: true })), health, start: vi.fn(), stop: vi.fn(), restart })
    const result = await handler(invocation('restart'))
    expect(result.kind).toBe('success')
    expect(restart).toHaveBeenCalledOnce()
  })


  it('connects without restarting a healthy Bridge and waits for the extension', async () => {
    const start = vi.fn()
    const stop = vi.fn()
    const restart = vi.fn()
    const request = vi.fn(async () => ({ connected: true, browser: 'edge', browserId: 'edge:test' }))
    const health = vi.fn()
      .mockResolvedValueOnce({ ok: true, extensionConnected: false, browser: 'edge', startedBy: 'dsh' })
      .mockResolvedValue({ ok: true, extensionConnected: true, browser: 'edge', startedBy: 'dsh' })
    const { handler } = setup({ request, health, start, stop, restart })
    const result = await handler(invocation('connect'))
    expect(result.kind).toBe('success')
    expect(start).toHaveBeenCalledOnce()
    expect(health).toHaveBeenCalledTimes(3)
    expect(restart).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith('status', { sessionId: 'session-test' }, expect.any(AbortSignal))
  })

  it('disconnects only the current DSH client and leaves the Bridge running', async () => {
    const start = vi.fn()
    const stop = vi.fn()
    const restart = vi.fn()
    const request = vi.fn()
    const health = vi.fn()
    const { handler } = setup({ request, health, start, stop, restart })
    const result = await handler(invocation('disconnect'))
    expect(result).toEqual({
      kind: 'success',
      text: '{\n  "ok": true,\n  "disconnected": true,\n  "bridge": "left running for later /chrome connect"\n}',
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(health).not.toHaveBeenCalled()
  })

  it('reports Bridge-only status instead of failing while the extension reconnects', async () => {
    const request = vi.fn()
    const health = vi.fn(async () => ({ ok: true, extensionConnected: false, startedBy: 'dsh' }))
    const { handler } = setup({ request, health, start: vi.fn(), stop: vi.fn(), restart: vi.fn() })
    const result = await handler(invocation('status'))
    expect(result.kind).toBe('success')
    expect(result.text).toContain('"connected": false')
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects unsupported arguments without touching the Bridge', async () => {
    const request = vi.fn()
    const health = vi.fn()
    const restart = vi.fn()
    const start = vi.fn()
    const stop = vi.fn()
    const { handler } = setup({ request, health, start, stop, restart })
    const result = await handler(invocation('restart now'))
    expect(result).toEqual({ kind: 'error', text: 'Usage: /chrome status|connect|disconnect|doctor|restart|tabs' })
    expect(request).not.toHaveBeenCalled()
    expect(health).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })
})
