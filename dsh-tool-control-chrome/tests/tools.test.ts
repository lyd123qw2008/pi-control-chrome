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

function execution(): ToolRunContext {
  return {
    agent: { session: { id: 'session-test' } },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

describe('DSH browser tool catalog', () => {
  it('exposes the complete Pi browser tool surface', () => {
    expect(BROWSER_TOOL_NAMES).toHaveLength(37)
    expect(new Set(BROWSER_TOOL_NAMES).size).toBe(BROWSER_TOOL_NAMES.length)
    expect(browserToolCatalog.core.map(tool => tool.name)).toContain('browser_screenshot')
    expect(browserToolCatalog.advanced.map(tool => tool.name)).toContain('browser_cdp')
  })

  it('routes session identity and operation parameters to the Bridge', async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => ({ method, params }))
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true }))
    const tools = setup({ request, health })
    const result = await tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution())
    expect(result).toEqual({ method: 'interaction', params: { tabId: 7, ref: 'e4', sessionId: 'session-test', operation: 'click' } })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('projects accessibility and network specializations', async () => {
    const request = vi.fn(async (method: string) => method === 'snapshot'
      ? { snapshot: { accessibility: { role: 'main' } } }
      : { method })
    const health = vi.fn(async () => ({ ok: true }))
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
    const request = vi.fn(async () => ({ tabId: 7, data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' }))
    const health = vi.fn(async () => ({ ok: true }))
    const tools = setup({ request, health }, attachments)
    const tool = tools.get('browser_screenshot')
    const value = await tool?.execute({ tabId: 7 }, execution())
    expect(value).toEqual({ tabId: 7, mimeType: 'image/png', attachment: ref })
    expect(saveImage).toHaveBeenCalledOnce()
    const content = tool?.output.render({}, value as never)
    expect(content?.[1]).toEqual({ type: 'image', attachment: ref })
  })
})
