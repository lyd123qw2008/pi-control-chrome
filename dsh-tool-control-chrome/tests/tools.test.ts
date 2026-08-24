import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { BrowserBridgeClient } from '../src/bridge.js'
import { BROWSER_SKILL_NAME } from '../src/skill.js'
import { BROWSER_TOOL_NAMES, browserToolCatalog, registerBrowserTools } from '../src/tools.js'

type EventHandler = (...args: unknown[]) => unknown

type Harness = {
  readonly globalTools: Map<string, ToolDefinition>
  readonly tools: Map<string, ToolDefinition>
  readonly agent: Agent
  readonly createAgent: (sessionId: string) => Agent
  readonly toolsFor: (agent: Agent) => Map<string, ToolDefinition>
  readonly activate: (agent: Agent, name?: string, isError?: boolean) => void
  readonly invokeUserSkill: (agent: Agent) => Promise<void>
  readonly complete: (agent: Agent, name: string, isError?: boolean) => void
  readonly dispose: (agent: Agent) => void
}

function agentContext(tools: Map<string, ToolDefinition>): Context {
  return {
    tools: {
      register(definition: ToolDefinition) {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
    },
  } as unknown as Context
}

function setup(
  bridge: Pick<BrowserBridgeClient, 'request' | 'health'>,
  attachments?: AttachmentStore,
  options: { lazyTools?: boolean; activate?: boolean } = {},
): Harness {
  const globalTools = new Map<string, ToolDefinition>()
  const perAgentTools = new Map<string, Map<string, ToolDefinition>>()
  const events = new Map<string, EventHandler>()
  const lazyTools = options.lazyTools ?? true
  const toolsFor = (agent: Agent): Map<string, ToolDefinition> => {
    const sessionId = String(agent.session.id)
    const existing = perAgentTools.get(sessionId)
    if (existing !== undefined) return existing
    const created = new Map<string, ToolDefinition>()
    perAgentTools.set(sessionId, created)
    return created
  }
  const createAgent = (sessionId: string): Agent => {
    const agent = { session: { id: sessionId } } as unknown as Agent
    Object.assign(agent, { ctx: agentContext(toolsFor(agent)) })
    return agent
  }
  const rootContext = {
    tools: {
      register(definition: ToolDefinition) {
        globalTools.set(definition.name, definition)
        return () => { globalTools.delete(definition.name) }
      },
    },
    effect(effect: () => unknown) {
      return effect()
    },
    get(name: string) {
      return name === 'attachments' ? attachments : undefined
    },
    on(name: string, handler: EventHandler) {
      events.set(name, handler)
    },
  } as unknown as Context
  const resolveSettings = () => ({
    bridgeHost: '127.0.0.1',
    bridgePort: 17318,
    tokenFile: 'C:/test/token',
    autoStartBridge: false,
    requestTimeoutMs: 120_000,
    lazyTools,
  })
  registerBrowserTools(rootContext, bridge as BrowserBridgeClient, attachments, resolveSettings)
  const agent = createAgent('session-test')
  const activate = (target: Agent, name = BROWSER_SKILL_NAME, isError = false): void => {
    const handler = events.get('tools/result')
    if (handler === undefined) throw new Error('tools/result handler was not registered')
    handler({ name: 'skill', arguments: { name }, agent: target }, { isError })
  }
  const invokeUserSkill = async (target: Agent): Promise<void> => {
    const handler = events.get('agent/pre-step')
    if (handler === undefined) throw new Error('agent/pre-step handler was not registered')
    await handler(
      { agent: target, messages: [] },
      async () => ({
        kind: 'enter',
        messages: [{ source: { kind: 'skill-invocation', name: BROWSER_SKILL_NAME } }],
      }),
    )
  }
  const complete = (target: Agent, name: string, isError = false): void => {
    const handler = events.get('tools/result')
    if (handler === undefined) throw new Error('tools/result handler was not registered')
    handler({ name, arguments: {}, agent: target }, { isError })
  }
  const dispose = (target: Agent): void => {
    events.get('agent/disposed')?.({ agent: target })
  }
  if (options.activate ?? true) activate(agent)
  return {
    globalTools,
    tools: lazyTools ? toolsFor(agent) : globalTools,
    agent,
    createAgent,
    toolsFor,
    activate,
    invokeUserSkill,
    complete,
    dispose,
  }
}

function execution(agent: Agent): ToolRunContext {
  return {
    agent,
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
    const accessibility = browserToolCatalog.core.find(tool => tool.name === 'browser_accessibility_snapshot')
    const network = browserToolCatalog.advanced.find(tool => tool.name === 'browser_network')
    const download = browserToolCatalog.advanced.find(tool => tool.name === 'browser_download')
    expect(accessibility?.prepare).toBeUndefined()
    expect(network?.parameters).not.toHaveProperty('timeoutMs')
    expect(download?.parameters).not.toHaveProperty('tabId')
  })

  it('hides the full browser catalog until the named Skill succeeds, then scopes it to one Agent', () => {
    const request = vi.fn(async () => ({ connected: true }))
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health }, undefined, { activate: false })
    expect(harness.globalTools.size).toBe(0)
    expect(harness.tools.size).toBe(0)
    const agent = harness.createAgent('session-a')
    harness.activate(agent)
    expect([...harness.toolsFor(agent).keys()]).toEqual(BROWSER_TOOL_NAMES)
    expect(harness.toolsFor(harness.createAgent('session-b')).size).toBe(0)
  })

  it('does not activate for a failed or differently named Skill result', () => {
    const request = vi.fn(async () => ({ connected: true }))
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health }, undefined, { activate: false })
    harness.activate(harness.agent, 'other-skill')
    expect(harness.tools.size).toBe(0)
    harness.activate(harness.agent, BROWSER_SKILL_NAME, true)
    expect(harness.tools.size).toBe(0)
  })

  it('activates from a direct user Skill invocation and remains idempotent', async () => {
    const request = vi.fn(async () => ({ connected: true }))
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health }, undefined, { activate: false })
    await harness.invokeUserSkill(harness.agent)
    expect(harness.tools.size).toBe(BROWSER_TOOL_NAMES.length)
    harness.activate(harness.agent)
    expect(harness.tools.size).toBe(BROWSER_TOOL_NAMES.length)
  })
  it('keeps an eager compatibility mode with the complete global catalog', () => {
    const request = vi.fn(async () => ({ connected: true }))
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health }, undefined, { lazyTools: false })
    expect([...harness.globalTools.keys()]).toEqual(BROWSER_TOOL_NAMES)
  })

  it('cleans a used eager session on Agent disposal', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }
      : { method })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health }, undefined, { lazyTools: false })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    harness.dispose(harness.agent)
    await Promise.resolve()
    expect(request).toHaveBeenLastCalledWith('cleanup', { sessionId: 'session-test' })
  })

  it('routes session identity and operation parameters to the Bridge after target validation', async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }
      : { method, params })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    const result = await harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))
    expect(result).toEqual({ method: 'interaction', params: { tabId: 7, ref: 'e4', sessionId: 'session-test', operation: 'click', expectedBrowserId: 'edge:test' } })
    expect(request).toHaveBeenLastCalledWith('interaction', { tabId: 7, ref: 'e4', sessionId: 'session-test', operation: 'click', expectedBrowserId: 'edge:test' }, expect.any(AbortSignal))
  })

  it('reports an actionable diagnosis when the Bridge has no extension', async () => {
    const request = vi.fn(async () => ({ connected: false }))
    const health = vi.fn(async () => ({ ok: true, protocol: 1, extensionConnected: false }))
    const harness = setup({ request, health })
    const result = await harness.tools.get('browser_doctor')?.execute({}, execution(harness.agent))
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
    const harness = setup({ request, health })
    const result = await harness.tools.get('browser_doctor')?.execute({}, execution(harness.agent))
    expect(result).toMatchObject({ ok: true, recommendation: 'confirm_browser_target', targetStability: { competition: 'unknown' }, notices: [{ code: 'browser_competition_unverified' }] })
  })

  it('rejects an incomplete browser status contract', async () => {
    const request = vi.fn(async () => ({ connected: true, browser: '', browserId: '', profile: '' }))
    const health = vi.fn(async () => ({ ok: true, protocol: 1, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    const result = await harness.tools.get('browser_doctor')?.execute({}, execution(harness.agent))
    expect(result).toMatchObject({ ok: false, recommendation: 'refresh_browser_status', issues: [{ code: 'status_missing_browser_target' }] })
  })

  it('blocks browser operations when the active browser target changes until explicitly acknowledged', async () => {
    let browser = 'edge'
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => method === 'status'
      ? { connected: true, browser, browserId: `${browser}:test`, profile: 'current', extensionVersion: '0.2.4' }
      : { method, params })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: `${browser}:test` }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    browser = 'chrome'
    await expect(harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))).rejects.toThrow(/changed from edge.*chrome/)
    expect(request.mock.calls.filter(([method]) => method === 'interaction')).toHaveLength(0)
    const unacknowledged = await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    expect(unacknowledged).toMatchObject({ targetStability: { stable: false, changed: true, acknowledged: false, requiresAcknowledgement: true } })
    await expect(harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))).rejects.toThrow(/acknowledgeBrowserId/)
    const status = await harness.tools.get('browser_status')?.execute({ acknowledgeBrowserId: 'chrome:test' }, execution(harness.agent))
    expect(status).toMatchObject({ targetStability: { stable: false, changed: true, acknowledged: true, browser: 'chrome' } })
    await harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))
    expect(request.mock.calls.filter(([method]) => method === 'interaction')).toHaveLength(1)
  })

  it('keeps browser target acknowledgements isolated per session', async () => {
    let browser = 'edge'
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => method === 'status'
      ? { connected: true, browser, browserId: `${browser}:test`, profile: 'current', extensionVersion: '0.2.4' }
      : { method, params })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: `${browser}:test` }))
    const harness = setup({ request, health })
    const sessionA = harness.createAgent('session-a')
    const sessionB = harness.createAgent('session-b')
    harness.activate(sessionA)
    harness.activate(sessionB)
    await harness.toolsFor(sessionA).get('browser_status')?.execute({}, execution(sessionA))
    browser = 'chrome'
    await harness.toolsFor(sessionB).get('browser_status')?.execute({}, execution(sessionB))
    await expect(harness.toolsFor(sessionA).get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(sessionA))).rejects.toThrow(/changed from edge.*chrome/)
    await harness.toolsFor(sessionB).get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(sessionB))
    expect(request.mock.calls.filter(([method]) => method === 'interaction')).toHaveLength(1)
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ expectedBrowserId: 'chrome:test', sessionId: 'session-b' })
  })

  it('reports and blocks an old Bridge without atomic target routing', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }
      : { method })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true }))
    const harness = setup({ request, health })
    const diagnosis = await harness.tools.get('browser_doctor')?.execute({}, execution(harness.agent))
    expect(diagnosis).toMatchObject({ ok: false, recommendation: 'restart_bridge', issues: [{ code: 'bridge_target_routing_unavailable' }] })
    await expect(harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))).rejects.toThrow(/atomic target routing/)
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
    const harness = setup({ request, health })
    const diagnosis = await harness.tools.get('browser_doctor')?.execute({}, execution(harness.agent))
    expect(diagnosis).toMatchObject({
      ok: true,
      recovery: { available: true, authority: 'local_user', controlDomain: 'local_user', method: 'cooperative_restart', requiresUserConfirmation: false },
    })
  })

  it('does not advertise recovery for the old launcher-owner protocol', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.6' }
      : { method })
    const health = vi.fn(async () => ({
      ok: true,
      extensionConnected: true,
      browserId: 'edge:test',
      managedBy: 'dsh',
      capabilities: { cooperativeRestart: true },
      restart: { available: true, managedBy: 'dsh' },
    }))
    const harness = setup({ request, health })
    const diagnosis = await harness.tools.get('browser_doctor')?.execute({}, execution(harness.agent))
    expect(diagnosis).toMatchObject({
      recovery: { available: false, authority: 'unknown', method: 'unavailable', requiresUserConfirmation: true },
    })
  })

  it('projects accessibility and network specializations', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }
      : method === 'snapshot'
        ? { snapshot: { accessibility: { role: 'main' } } }
        : { method })
    const health = vi.fn(async () => ({ ok: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    const accessibility = await harness.tools.get('browser_accessibility_snapshot')?.execute({}, execution(harness.agent))
    expect(accessibility).toEqual({ role: 'main' })
    await harness.tools.get('browser_network')?.execute({ action: 'enable' }, execution(harness.agent))
    expect(request).toHaveBeenLastCalledWith('devtools_enable', expect.objectContaining({ domains: ['Network', 'Page'] }), expect.any(AbortSignal))
  })

  it('cleans up without connecting when Skill activation has not used the Bridge', async () => {
    const request = vi.fn(async () => ({ connected: true }))
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_cleanup')?.execute({}, execution(harness.agent))
    harness.complete(harness.agent, 'browser_cleanup')
    expect(request).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(harness.tools.size).toBe(0)
  })

  it('cleans up a used session on Agent disposal', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }
      : { method })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    harness.dispose(harness.agent)
    await Promise.resolve()
    expect(request).toHaveBeenLastCalledWith('cleanup', { sessionId: 'session-test' })
  })

  it('stores screenshots as attachment references and renders an image block', async () => {
    const ref = { attachmentId: 'attachment-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } as unknown as ImageAttachmentRef
    const saveImage = vi.fn(async () => ref)
    const attachments = { saveImage } as unknown as AttachmentStore
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }
      : { tabId: 7, data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' })
    const health = vi.fn(async () => ({ ok: true, browserId: 'edge:test' }))
    const harness = setup({ request, health }, attachments)
    const tool = harness.tools.get('browser_screenshot')
    const value = await tool?.execute({ tabId: 7 }, execution(harness.agent))
    expect(value).toEqual({ tabId: 7, mimeType: 'image/png', attachment: ref })
    expect(saveImage).toHaveBeenCalledOnce()
    const content = tool?.output.render({}, value as never)
    expect(content?.[1]).toEqual({ type: 'image', attachment: ref })
  })
})
