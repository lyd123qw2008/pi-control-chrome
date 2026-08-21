import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { BrowserBridgeClient } from '../src/bridge.js'
import { BROWSER_TOOL_NAMES, browserToolCatalog, registerBrowserTools } from '../src/tools.js'

function setup(bridge: Pick<BrowserBridgeClient, 'request' | 'health'>, attachments?: AttachmentStore): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
    },
    effect(effect: () => unknown) {
      return effect()
    },
    get(name: string) {
      return name === 'attachments' ? attachments : undefined
    },
  } as unknown as Context
  registerBrowserTools(ctx, bridge as BrowserBridgeClient, attachments, () => ({
    bridgeHost: '127.0.0.1',
    bridgePort: 17318,
    tokenFile: 'C:/test/token',
              autoStartBridge: false,
    requestTimeoutMs: 120_000,
  }))
  return tools
}

function execution(sessionId = 'session-test'): ToolRunContext {
  return {
    agent: { session: { id: sessionId } },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

describe('DSH browser tool catalog', () => {
  it('exposes the complete Pi browser tool surface', () => {
    expect(BROWSER_TOOL_NAMES).toHaveLength(38)
    expect(new Set(BROWSER_TOOL_NAMES).size).toBe(BROWSER_TOOL_NAMES.length)
    expect(browserToolCatalog.core.map(tool => tool.name)).toContain('browser_doctor')
    expect(browserToolCatalog.core.map(tool => tool.name)).toContain('browser_screenshot')
    expect(browserToolCatalog.advanced.map(tool => tool.name)).toContain('browser_cdp')
  })

  it('routes session identity and operation parameters to the Bridge after target validation', async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }
      : { method, params })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const tools = setup({ request, health })
    const result = await tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution())
    expect(result).toEqual({ method: 'interaction', params: { tabId: 7, ref: 'e4', sessionId: 'session-test', operation: 'click', expectedBrowserId: 'edge:test' } })
    expect(request).toHaveBeenLastCalledWith('interaction', { tabId: 7, ref: 'e4', sessionId: 'session-test', operation: 'click', expectedBrowserId: 'edge:test' }, expect.any(AbortSignal))
  })

  it('reports an actionable diagnosis when the Bridge has no extension', async () => {
    const request = vi.fn(async () => ({ connected: false }))
    const health = vi.fn(async () => ({ ok: true, protocol: 1, extensionConnected: false }))
    const tools = setup({ request, health })
    const result = await tools.get('browser_doctor')?.execute({}, execution())
    expect(result).toMatchObject({
      ok: false,
      recommendation: 'enable_or_reload_extension',
      bridgeHealth: { ok: true, extensionConnected: false },
      issues: [{ code: 'extension_not_connected' }],
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('marks first-call browser competition as unverified', async () => {
    const request = vi.fn(async () => ({ connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }))
    const health = vi.fn(async () => ({ ok: true, protocol: 1, extensionConnected: true, browserId: 'edge:test' }))
    const tools = setup({ request, health })
    const result = await tools.get('browser_doctor')?.execute({}, execution())
    expect(result).toMatchObject({ ok: true, recommendation: 'confirm_browser_target', targetStability: { competition: 'unknown' }, notices: [{ code: 'browser_competition_unverified' }] })
  })

  it('rejects an incomplete browser status contract', async () => {
    const request = vi.fn(async () => ({ connected: true, browser: '', browserId: '', profile: '' }))
    const health = vi.fn(async () => ({ ok: true, protocol: 1, extensionConnected: true, browserId: 'edge:test' }))
    const tools = setup({ request, health })
    const result = await tools.get('browser_doctor')?.execute({}, execution())
    expect(result).toMatchObject({ ok: false, recommendation: 'refresh_browser_status', issues: [{ code: 'status_missing_browser_target' }] })
  })

  it('blocks browser operations when the active browser target changes until explicitly acknowledged', async () => {
    let browser = 'edge'
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => method === 'status'
      ? { connected: true, browser, browserId: `${browser}:test`, profile: 'current', extensionVersion: '0.2.4' }
      : { method, params })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: `${browser}:test` }))
    const tools = setup({ request, health })
    await tools.get('browser_status')?.execute({}, execution())
    browser = 'chrome'
    await expect(tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution())).rejects.toThrow(/changed from edge.*chrome/)
    expect(request.mock.calls.filter(([method]) => method === 'interaction')).toHaveLength(0)
    const unacknowledged = await tools.get('browser_status')?.execute({}, execution())
    expect(unacknowledged).toMatchObject({ targetStability: { stable: false, changed: true, acknowledged: false, requiresAcknowledgement: true } })
    await expect(tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution())).rejects.toThrow(/acknowledgeBrowserId/)
    const status = await tools.get('browser_status')?.execute({ acknowledgeBrowserId: 'chrome:test' }, execution())
    expect(status).toMatchObject({ targetStability: { stable: false, changed: true, acknowledged: true, browser: 'chrome' } })
    await tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution())
    expect(request.mock.calls.filter(([method]) => method === 'interaction')).toHaveLength(1)
  })

  it('keeps browser target acknowledgements isolated per session', async () => {
    let browser = 'edge'
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => method === 'status'
      ? { connected: true, browser, browserId: `${browser}:test`, profile: 'current', extensionVersion: '0.2.4' }
      : { method, params })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: `${browser}:test` }))
    const tools = setup({ request, health })
    await tools.get('browser_status')?.execute({}, execution('session-a'))
    browser = 'chrome'
    await tools.get('browser_status')?.execute({}, execution('session-b'))
    await expect(tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution('session-a'))).rejects.toThrow(/changed from edge.*chrome/)
    await tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution('session-b'))
    expect(request.mock.calls.filter(([method]) => method === 'interaction')).toHaveLength(1)
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ expectedBrowserId: 'chrome:test', sessionId: 'session-b' })
  })

  it('reports and blocks an old Bridge without atomic target routing', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }
      : { method })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true }))
    const tools = setup({ request, health })
    const diagnosis = await tools.get('browser_doctor')?.execute({}, execution())
    expect(diagnosis).toMatchObject({ ok: false, recommendation: 'restart_bridge', issues: [{ code: 'bridge_target_routing_unavailable' }] })
    await expect(tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution())).rejects.toThrow(/atomic target routing/)
    expect(request.mock.calls.filter(([method]) => method === 'interaction')).toHaveLength(0)
  })
  it('reports cooperative recovery availability for a compatible local-user Bridge', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.5' }
      : { method })
    const health = vi.fn(async () => ({
      ok: true,
      extensionConnected: true,
      browserId: 'edge:test',
      startedBy: 'pi',
      controlDomain: 'local_user',
       capabilities: { cooperativeRestart: true, localUserRestart: true },
      restart: { available: true, controlDomain: 'local_user' },
    }))
    const tools = setup({ request, health })
    const diagnosis = await tools.get('browser_doctor')?.execute({}, execution())
    expect(diagnosis).toMatchObject({
      ok: true,
      recovery: { available: true, authority: 'local_user', controlDomain: 'local_user', method: 'cooperative_restart', requiresUserConfirmation: false },
    })
  })

  it('projects accessibility and network specializations', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }
      : method === 'snapshot'
        ? { snapshot: { accessibility: { role: 'main' } } }
        : { method })
    const health = vi.fn(async () => ({ ok: true, browserId: 'edge:test' }))
    const tools = setup({ request, health })
    const accessibility = await tools.get('browser_accessibility_snapshot')?.execute({}, execution())
    expect(accessibility).toEqual({ role: 'main' })
    await tools.get('browser_network')?.execute({ action: 'enable' }, execution())
    expect(request).toHaveBeenLastCalledWith('devtools_enable', expect.objectContaining({ domains: ['Network', 'Page'] }), expect.any(AbortSignal))
  })

  it('stores screenshots as attachment references and renders an image block', async () => {
    const ref = { attachmentId: 'attachment-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } as unknown as ImageAttachmentRef
    const saveImage = vi.fn(async () => ref)
    const attachments = { saveImage } as unknown as AttachmentStore
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }
      : { tabId: 7, data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' })
    const health = vi.fn(async () => ({ ok: true, browserId: 'edge:test' }))
    const tools = setup({ request, health }, attachments)
    const tool = tools.get('browser_screenshot')
    const value = await tool?.execute({ tabId: 7 }, execution())
    expect(value).toEqual({ tabId: 7, mimeType: 'image/png', attachment: ref })
    expect(saveImage).toHaveBeenCalledOnce()
    const content = tool?.output.render({}, value as never)
    expect(content?.[1]).toEqual({ type: 'image', attachment: ref })
  })
})
