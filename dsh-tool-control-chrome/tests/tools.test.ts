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
  readonly complete: (agent: Agent, name: string, isError?: boolean, exec?: ToolRunContext) => void
  readonly invokeUserSkill: (agent: Agent, signal?: AbortSignal) => Promise<void>
  readonly emitTurnStart: (agent: Agent, turn?: number) => void
  readonly emitTurnEnd: (agent: Agent, turn?: number) => Promise<void>
  readonly dispose: (agent: Agent) => Promise<void>
  readonly disposePlugin: () => Promise<void>
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
  bridge: Pick<BrowserBridgeClient, 'request' | 'health'> & Partial<Pick<BrowserBridgeClient, 'start'>>,
  attachments?: AttachmentStore,
  options: { lazyTools?: boolean; activate?: boolean; extensionReadyTimeoutMs?: number } = {},
): Harness {
  const globalTools = new Map<string, ToolDefinition>()
  const perAgentTools = new Map<Agent['session'], Map<string, ToolDefinition>>()
  const events = new Map<string, EventHandler>()
  const lazyTools = options.lazyTools ?? true
  const toolsFor = (agent: Agent): Map<string, ToolDefinition> => {
    const session = agent.session
    const existing = perAgentTools.get(session)
    if (existing !== undefined) return existing
    const created = new Map<string, ToolDefinition>()
    perAgentTools.set(session, created)
    return created
  }
  const createAgent = (sessionId: string): Agent => {
    const session = { id: sessionId }
    const agent = { session } as unknown as Agent
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
    extensionReadyTimeoutMs: options.extensionReadyTimeoutMs ?? 0,
    lazyTools,
  })
  const bridgeClient = { start: vi.fn(async () => {}), ...bridge } as unknown as BrowserBridgeClient
  const disposePlugin = registerBrowserTools(rootContext, bridgeClient, attachments, resolveSettings)
  const agent = createAgent('session-test')
  const activate = (target: Agent, name = BROWSER_SKILL_NAME, isError = false): void => {
    const handler = events.get('tools/result')
    if (handler === undefined) throw new Error('tools/result handler was not registered')
    handler({ name: 'skill', arguments: { name }, agent: target }, { isError })
  }
  const invokeUserSkill = async (target: Agent, signal?: AbortSignal): Promise<void> => {
    const handler = events.get('agent/pre-step')
    if (handler === undefined) throw new Error('agent/pre-step handler was not registered')
    await handler(
      { agent: target, messages: [], signal },
      async () => ({
        kind: 'enter',
        messages: [{ source: { kind: 'skill-invocation', name: BROWSER_SKILL_NAME } }],
      }),
    )
  }
  const complete = (target: Agent, name: string, isError = false, exec = execution(target)): void => {
    const handler = events.get('tools/result')
    if (handler === undefined) throw new Error('tools/result handler was not registered')
    const eventExec = exec as ToolRunContext & { name: string; arguments: unknown }
    eventExec.name = name
    eventExec.arguments = {}
    handler(eventExec, { isError })
  }
  const emitTurnStart = (target: Agent, turn = 1): void => {
    events.get('session/event')?.(target.session, { type: 'turn/start', data: { turn } })
  }
  const emitTurnEnd = async (target: Agent, turn = 1): Promise<void> => {
    const handler = events.get('session/event')
    if (handler !== undefined) await handler(
      target.session,
      { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    )
  }
  const dispose = async (target: Agent): Promise<void> => {
    events.get('agent/disposed')?.({ agent: target })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  if (options.activate ?? true) activate(agent)
  return {
    globalTools,
    tools: lazyTools ? toolsFor(agent) : globalTools,
    agent,
    createAgent,
    toolsFor,
    activate,
    complete,
    invokeUserSkill,
    emitTurnStart,
    emitTurnEnd,
    dispose,
    disposePlugin,
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
    expect(BROWSER_TOOL_NAMES).toHaveLength(39)
    expect(new Set(BROWSER_TOOL_NAMES).size).toBe(BROWSER_TOOL_NAMES.length)
    expect(browserToolCatalog.core.map(tool => tool.name)).toContain('browser_doctor')
    expect(browserToolCatalog.core.map(tool => tool.name)).toContain('browser_screenshot')
    expect(browserToolCatalog.core.map(tool => tool.name)).toContain('browser_context_reset')
    const cleanup = browserToolCatalog.core.find(tool => tool.name === 'browser_cleanup')
    const contextReset = browserToolCatalog.core.find(tool => tool.name === 'browser_context_reset')
    expect(cleanup?.description).toContain('explicitly asks')
    expect(contextReset?.description).toContain('explicitly asks')
    expect(browserToolCatalog.advanced.map(tool => tool.name)).toContain('browser_cdp')
    const wait = browserToolCatalog.core.find(tool => tool.name === 'browser_wait')
    const click = browserToolCatalog.core.find(tool => tool.name === 'browser_click')
    expect(wait?.parameters).toHaveProperty('target')
    expect(wait?.parameters.state).toMatchObject({ enum: ['load', 'url', 'text', 'text_gone', 'visible', 'hidden', 'enabled'] })
    expect(click?.parameters).toHaveProperty('target')
    expect(click?.parameters).toHaveProperty('timeoutMs')
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

  it('keeps eager tools registered and resets usage after cleanup', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      : { removed: [7], released: [8], retained: [] })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health }, undefined, { lazyTools: false })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    const cleanupExec = execution(harness.agent)
    await harness.tools.get('browser_cleanup')?.execute({}, cleanupExec)
    harness.complete(harness.agent, 'browser_cleanup', false, cleanupExec)
    await Promise.resolve()
    expect(harness.globalTools.size).toBe(BROWSER_TOOL_NAMES.length)
    await harness.dispose(harness.agent)
    expect(request.mock.calls.filter(([method]) => method === 'cleanup')).toHaveLength(1)
  })

  it('treats blank browserId values as omitted during single-target status lookup', async () => {
    let statusCalls = 0
    const request = vi.fn(async (method: string, _params: Record<string, unknown>, _signal?: AbortSignal, target?: { browserId: string }) => {
      if (method === 'status') {
        statusCalls += 1
        expect(target).toEqual(statusCalls === 1 ? undefined : { browserId: 'edge:test' })
        return { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      }
      return { method }
    })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    for (const browserId of ['', '   ']) {
      const result = await harness.tools.get('browser_status')?.execute({ browserId }, execution(harness.agent))
      expect(result).toMatchObject({ state: 'connected', browserId: 'edge:test' })
    }
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('cleans a used eager session on Agent disposal', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }
      : { method })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health }, undefined, { lazyTools: false })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    await harness.dispose(harness.agent)
    expect(request).toHaveBeenLastCalledWith('cleanup', { sessionId: 'session-test', mode: 'disposal', expectedBrowserId: 'edge:test' }, undefined, { browserId: 'edge:test' })
  })

  it('routes session identity and operation parameters to the Bridge after target validation', async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4', capabilities: { tabIncarnationFence: true } }
      : { method, params })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    const result = await harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))
    expect(result).toEqual({ method: 'interaction', params: { tabId: 7, ref: 'e4', sessionId: 'session-test', operation: 'click', expectedBrowserId: 'edge:test' } })
    expect(request).toHaveBeenLastCalledWith('interaction', { tabId: 7, ref: 'e4', sessionId: 'session-test', operation: 'click', expectedBrowserId: 'edge:test' }, expect.any(AbortSignal), { browserId: 'edge:test' })
  })

  it('routes semantic wait and locator targets with the selected browser fence', async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.17', capabilities: { semanticTargets: true, pageWaitStates: true, tabIncarnationFence: true } }
      : { method, params })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test', capabilities: { semanticTargetRequests: true, pageWaitStates: true, tabIncarnationFence: true } }))
    const harness = setup({ request, health })
    const target = { role: 'button', name: '提交', exact: true }
    const waitResult = await harness.tools.get('browser_wait')?.execute({ state: 'visible', target, timeoutMs: 8000 }, execution(harness.agent))
    expect(waitResult).toEqual({ method: 'wait', params: { state: 'visible', target, timeoutMs: 8000, sessionId: 'session-test', expectedBrowserId: 'edge:test' } })
    const locatorResult = await harness.tools.get('browser_locator')?.execute({ action: 'count', target }, execution(harness.agent))
    expect(locatorResult).toEqual({ method: 'locator', params: { action: 'count', target, sessionId: 'session-test', expectedBrowserId: 'edge:test', locator: target } })
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

  it('returns a structured Bridge-only state without sending a browser request', async () => {
    const request = vi.fn(async () => ({ connected: false }))
    const health = vi.fn(async () => ({ ok: true, protocol: 1, extensionConnected: false }))
    const harness = setup({ request, health })
    const result = await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    expect(result).toMatchObject({
      ok: false,
      connected: false,
      state: 'bridge_only',
      completed: false,
      retryable: true,
      userActionRequired: false,
      nextAction: 'browser_status',
      recommendation: 'retry_browser_status',
      error: { code: 'extension_not_connected' },
      bridgeHealth: { extensionConnected: false },
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('converts a status-handshake extension disconnect into Bridge-only state', async () => {
    const request = vi.fn(async () => {
      const error = new Error('Chrome/Edge extension is not connected.') as Error & { code?: string }
      error.code = 'EXTENSION_OFFLINE'
      throw error
    })
    const health = vi.fn(async () => ({ ok: true, protocol: 1, extensionConnected: true }))
    const harness = setup({ request, health })
    const result = await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    expect(result).toMatchObject({
      ok: false,
      state: 'bridge_only',
      error: { code: 'extension_not_connected' },
    })
  })

  it('waits for the extension background reconnect before reporting status', async () => {
    let healthReads = 0
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      : { method })
    const health = vi.fn(async () => {
      healthReads += 1
      return healthReads === 1
        ? { ok: true, protocol: 1, extensionConnected: false }
        : { ok: true, protocol: 1, extensionConnected: true, browserId: 'edge:test' }
    })
    const harness = setup({ request, health }, undefined, { extensionReadyTimeoutMs: 300 })
    const result = await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    expect(result).toMatchObject({ state: 'connected', connected: true })
    expect(health).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenCalledWith('status', { sessionId: 'session-test' }, expect.any(AbortSignal))
  })

  it('returns a structured Bridge-offline state when the local Bridge cannot start', async () => {
    const start = vi.fn(async () => { throw new Error('Browser Bridge is offline') })
    const request = vi.fn(async () => ({ connected: false }))
    const health = vi.fn(async () => ({ ok: false }))
    const harness = setup({ start, request, health })
    const result = await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    expect(result).toMatchObject({
      ok: false,
      connected: false,
      state: 'bridge_offline',
      completed: false,
      nextAction: '/chrome connect',
      recommendation: 'check_bridge',
      error: { code: 'bridge_unavailable' },
    })
    expect(request).not.toHaveBeenCalled()
    expect(health).not.toHaveBeenCalled()
  })

  it('waits for reconnect before dispatching a browser operation', async () => {
    let healthReads = 0
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      : { method, params })
    const health = vi.fn(async () => {
      healthReads += 1
      return healthReads === 1
        ? { ok: true, protocol: 1, extensionConnected: false }
        : { ok: true, protocol: 1, extensionConnected: true, browserId: 'edge:test' }
    })
    const harness = setup({ request, health }, undefined, { extensionReadyTimeoutMs: 300 })
    const result = await harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))
    expect(result).toEqual({ method: 'interaction', params: { tabId: 7, ref: 'e4', sessionId: 'session-test', operation: 'click', expectedBrowserId: 'edge:test' } })
    expect(request.mock.calls.filter(([method]) => method === 'interaction')).toHaveLength(1)
  })

  it('does not dispatch a browser operation while the extension is disconnected', async () => {
    const request = vi.fn(async () => ({ connected: false }))
    const health = vi.fn(async () => ({ ok: true, protocol: 1, extensionConnected: false }))
    const harness = setup({ request, health })
    const result = await harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))
    expect(result).toMatchObject({
      ok: false,
      completed: false,
      retryable: true,
      userActionRequired: false,
      nextAction: 'browser_status',
      recommendation: 'retry_browser_status',
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

  it('reports a reconnect and asks for connection acknowledgement', async () => {
    let statusCalls = 0
    const request = vi.fn(async (method: string) => {
      if (method === 'status') {
        statusCalls += 1
        return statusCalls === 1
          ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', connectionId: 'edge-a', connectionGeneration: 1 }
          : { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', connectionId: 'edge-b', connectionGeneration: 2 }
      }
      return { method }
    })
    const health = vi.fn(async () => ({ ok: true, protocol: 1, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    const result = await harness.tools.get('browser_doctor')?.execute({}, execution(harness.agent))
    expect(result).toMatchObject({
      ok: false,
      recommendation: 'acknowledge_browser_connection',
      issues: [{ code: 'browser_connection_changed' }],
      targetStability: { connectionChanged: true, requiresAcknowledgement: true },
    })
  })

  it('augments Bridge doctor results with selected connection stability', async () => {
    let statusCalls = 0
    const request = vi.fn(async (method: string) => {
      if (method === 'status') {
        statusCalls += 1
        return statusCalls === 1
          ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', connectionId: 'edge-a', connectionGeneration: 1 }
          : { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', connectionId: 'edge-b', connectionGeneration: 2 }
      }
      if (method === 'doctor') return { ok: true, state: 'connected', bridgeHealth: { ok: true, extensionConnected: true }, targets: [], issues: [], notices: [], recommendation: 'ready' }
      return { method }
    })
    const health = vi.fn(async () => ({ ok: true, protocol: 1, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    const result = await harness.tools.get('browser_doctor')?.execute({}, execution(harness.agent))
    expect(result).toMatchObject({ ok: false, recommendation: 'acknowledge_browser_connection', issues: [{ code: 'browser_connection_changed' }] })
  })

  it('requires explicit browser selection when multiple targets are connected and fences operations after selection', async () => {
    const targetHealth = {
      ok: true,
      protocol: 1,
      extensionConnected: true,
      targetAmbiguous: true,
      targets: [
        { browser: 'edge', browserId: 'edge:profile-a', profile: 'profile-a', state: 'ready', connectionId: 'edge-connection', connectionGeneration: 3 },
        { browser: 'chrome', browserId: 'chrome:profile-b', profile: 'profile-b', state: 'ready', connectionId: 'chrome-connection', connectionGeneration: 2 },
      ],
    }
    const request = vi.fn(async (method: string, params: Record<string, unknown>, _signal?: AbortSignal, target?: { browserId: string; connectionId?: string; connectionGeneration?: number }) => {
      if (method === 'status' && target?.browserId === undefined) {
        const error = new Error('multiple browser targets') as Error & { code?: string }
        error.code = 'TARGET_REQUIRED'
        throw error
      }
      if (method === 'status') return { connected: true, browser: 'chrome', browserId: 'chrome:profile-b', profile: 'profile-b', connectionId: 'chrome-connection', connectionGeneration: 2, capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      return { method, params }
    })
    const health = vi.fn(async () => targetHealth)
    const harness = setup({ request, health })
    const ambiguous = await harness.tools.get('browser_status')?.execute({ browserId: '' }, execution(harness.agent))
    expect(ambiguous).toMatchObject({ state: 'target_required', recommendation: 'select_browser_target', targets: [{ browserId: 'edge:profile-a' }, { browserId: 'chrome:profile-b' }] })
    const selected = await harness.tools.get('browser_status')?.execute({ browserId: 'chrome:profile-b' }, execution(harness.agent))
    expect(selected).toMatchObject({ browserId: 'chrome:profile-b', targetStability: { connectionGeneration: 2 } })
    await harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))
    expect(request).toHaveBeenLastCalledWith('interaction', expect.objectContaining({ expectedBrowserId: 'chrome:profile-b' }), expect.any(AbortSignal), {
      browserId: 'chrome:profile-b',
      connectionId: 'chrome-connection',
      connectionGeneration: 2,
    })
  })
  it('routes an acknowledged target by browserId when legacy status omits connection fences', async () => {
    const status = { connected: true, browser: 'edge', browserId: 'edge:legacy', profile: 'profile', capabilities: { tabIncarnationFence: true } }
    const targetHealth = {
      ok: true,
      protocol: 1,
      extensionConnected: true,
      browserId: 'edge:legacy',
      targets: [{ browser: 'edge', browserId: 'edge:legacy', profile: 'profile', state: 'ready' }],
      capabilities: { atomicTargetRouting: true, tabIncarnationFence: true },
    }
    const request = vi.fn(async (method: string) => method === 'status' ? status : { method })
    const health = vi.fn(async () => targetHealth)
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({ browserId: 'edge:legacy' }, execution(harness.agent))
    await harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))
    expect(request).toHaveBeenLastCalledWith('interaction', expect.anything(), expect.any(AbortSignal), { browserId: 'edge:legacy' })
  })

  it('accepts a selected target reported by Bridge health even when multiple targets are ready', async () => {
    const targetHealth = {
      ok: true,
      protocol: 1,
      extensionConnected: true,
      targetAmbiguous: true,
      targets: [
        { browser: 'edge', browserId: 'edge:profile-a', profile: 'profile-a', state: 'ready', connectionId: 'edge-connection', connectionGeneration: 3 },
        { browser: 'chrome', browserId: 'chrome:profile-b', profile: 'profile-b', state: 'ready', connectionId: 'chrome-connection', connectionGeneration: 2 },
      ],
    }
    const status = { connected: true, browser: 'chrome', browserId: 'chrome:profile-b', profile: 'profile-b', connectionId: 'chrome-connection', connectionGeneration: 2, capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
    const request = vi.fn(async (method: string) => {
      if (method === 'status') return status
      if (method === 'doctor') return { ok: true, state: 'connected', bridgeHealth: targetHealth, targets: targetHealth.targets, issues: [], notices: [], recommendation: 'ready' }
      return { method }
    })
    const health = vi.fn(async () => targetHealth)
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({ browserId: 'chrome:profile-b' }, execution(harness.agent))
    const result = await harness.tools.get('browser_doctor')?.execute({}, execution(harness.agent))
    expect(result).toMatchObject({ ok: true, state: 'connected', recommendation: 'ready', browserId: 'chrome:profile-b', bridgeHealth: { targetAmbiguous: true } })
    expect(result).not.toMatchObject({ issues: [{ code: 'bridge_target_routing_unavailable' }] })
  })

  it('returns structured recovery guidance when the selected target is unavailable', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'status') {
        const error = new Error('target disconnected') as Error & { code?: string }
        error.code = 'TARGET_UNAVAILABLE'
        throw error
      }
      return { targets: [] }
    })
    const health = vi.fn(async () => ({
      ok: true,
      extensionConnected: true,
      targets: [{ browser: 'edge', browserId: 'edge:profile-a', profile: 'profile-a', state: 'disconnected', connectionId: 'edge-connection', connectionGeneration: 4 }],
    }))
    const harness = setup({ request, health })
    const result = await harness.tools.get('browser_status')?.execute({ browserId: 'edge:profile-a' }, execution(harness.agent))
    expect(result).toMatchObject({ state: 'target_unavailable', recommendation: 'refresh_browser_targets', error: { code: 'TARGET_UNAVAILABLE' }, target: { browserId: 'edge:profile-a' } })
  })
  it('blocks browser operations when the active browser target changes until explicitly acknowledged', async () => {
    let browser = 'edge'
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => method === 'status'
      ? { connected: true, browser, browserId: `${browser}:test`, profile: 'current', extensionVersion: '0.2.4', capabilities: { tabIncarnationFence: true } }
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
      ? { connected: true, browser, browserId: `${browser}:test`, profile: 'current', extensionVersion: '0.2.4', capabilities: { tabIncarnationFence: true } }
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

  it('reports an uncertain operation when the extension disconnects after target validation', async () => {
    const request = vi.fn(async (method: string, _params: Record<string, unknown>) => {
      if (method === 'status') return { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      const error = new Error('Chrome/Edge extension disconnected before the request was sent.') as Error & { code?: string }
      error.code = 'EXTENSION_OFFLINE'
      throw error
    })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    const result = await harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))
    expect(result).toMatchObject({
      ok: false,
      completed: false,
      actionState: 'unknown',
      retryable: false,
      error: { code: 'extension_disconnected_during_operation' },
    })
    expect(request.mock.calls.filter(([method]) => method === 'interaction')).toHaveLength(1)
  })


  it('reports target-qualified recovery when the operation connection changes', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'status') return { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      const error = new Error('Browser target edge:test connection changed.') as Error & { code?: string }
      error.code = 'TARGET_CONNECTION_CHANGED'
      throw error
    })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    const result = await harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))
    expect(result).toMatchObject({
      ok: false,
      completed: false,
      actionState: 'unknown',
      retryable: false,
      nextAction: 'browser_status',
      recommendation: 'refresh_browser_targets',
      error: { code: 'TARGET_CONNECTION_CHANGED' },
    })
    expect(request.mock.calls.filter(([method]) => method === 'interaction')).toHaveLength(1)
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
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4', capabilities: { tabIncarnationFence: true } }
      : method === 'snapshot'
        ? { snapshot: { accessibility: { role: 'main' }, snapshotId: 'snapshot-1' } }
        : { method })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test', capabilities: { tabIncarnationFence: true } }))
    const harness = setup({ request, health })
    const accessibility = await harness.tools.get('browser_accessibility_snapshot')?.execute({}, execution(harness.agent))
    expect(accessibility).toEqual({ role: 'main', snapshotId: 'snapshot-1' })
    await harness.tools.get('browser_network')?.execute({ action: 'enable' }, execution(harness.agent))
    expect(request).toHaveBeenLastCalledWith('devtools_enable', expect.objectContaining({ domains: ['Network', 'Page'] }), expect.any(AbortSignal), { browserId: 'edge:test' })
  })

  it('keeps lazy tools active after task finalize even without a Bridge request', async () => {
    const request = vi.fn(async () => ({ connected: true }))
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    const cleanupExec = execution(harness.agent)
    await harness.tools.get('browser_cleanup')?.execute({}, cleanupExec)
    harness.complete(harness.agent, 'browser_cleanup', false, cleanupExec)
    await Promise.resolve()
    expect(request).not.toHaveBeenCalled()
    expect(harness.tools.size).toBe(BROWSER_TOOL_NAMES.length)
  })

  it('cleans unmarked resources at ordinary turn end', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      : { removed: [], released: [], retained: [] })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    harness.emitTurnStart(harness.agent, 1)
    await harness.emitTurnEnd(harness.agent, 1)
    expect(request.mock.calls.filter(([method]) => method === 'cleanup')).toHaveLength(1)
    expect(request).toHaveBeenLastCalledWith('cleanup', { sessionId: 'session-test', mode: 'turn', turnId: 1, expectedBrowserId: 'edge:test' }, undefined, { browserId: 'edge:test' })
    expect(harness.tools.size).toBe(BROWSER_TOOL_NAMES.length)
  })

  it('tags retention marks with the current turn before automatic cleanup', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      : { removed: [], released: [] })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    harness.emitTurnStart(harness.agent, 4)
    await harness.tools.get('browser_mark_deliverable')?.execute({ tabId: 7 }, execution(harness.agent))
    expect(request).toHaveBeenLastCalledWith('mark_deliverable', { tabId: 7, sessionId: 'session-test', turnId: 4, expectedBrowserId: 'edge:test' }, expect.any(AbortSignal), { browserId: 'edge:test' })
    await harness.emitTurnEnd(harness.agent, 4)
    harness.emitTurnStart(harness.agent, 5)
    await harness.emitTurnEnd(harness.agent, 5)
    expect(request.mock.calls.filter(([method]) => method === 'cleanup')).toHaveLength(2)
    expect(request).toHaveBeenLastCalledWith('cleanup', { sessionId: 'session-test', mode: 'turn', turnId: 5, expectedBrowserId: 'edge:test' }, undefined, { browserId: 'edge:test' })
  })

  it('refreshes non-turn cleanup routes after the selected browser reconnects', async () => {
    let connectionId = 'edge-connection-a'
    const status = (): Record<string, unknown> => ({
      connected: true,
      browser: 'edge',
      browserId: 'edge:test',
      profile: 'current',
      connectionId,
      connectionGeneration: 2,
      extensionVersion: '0.3.7',
      capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true },
    })
    const request = vi.fn(async (method: string) => method === 'status'
      ? status()
      : { removed: [7], released: [8], retained: [], failed: [] })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    connectionId = 'edge-connection-b'
    const cleanupExec = execution(harness.agent)
    await harness.tools.get('browser_cleanup')?.execute({}, cleanupExec)
    const statusCalls = request.mock.calls.filter(([method]) => method === 'status')
    expect(statusCalls).toHaveLength(2)
    expect(statusCalls[1][1]).toEqual({ sessionId: 'session-test', expectedBrowserId: 'edge:test' })
    expect(statusCalls[1][3]).toEqual({ browserId: 'edge:test' })
    const cleanupCall = request.mock.calls.find(([method]) => method === 'cleanup')
    expect(cleanupCall?.[1]).toEqual({ sessionId: 'session-test', mode: 'task', expectedBrowserId: 'edge:test' })
    expect(cleanupCall?.[3]).toEqual({ browserId: 'edge:test', connectionId: 'edge-connection-b', connectionGeneration: 2 })
  })
  it('does not send turn cleanup after the browser target changes during preflight', async () => {
    let browserId = 'edge:test'
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId, profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      : { removed: [], released: [], retained: [] })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    harness.emitTurnStart(harness.agent, 1)
    browserId = 'edge:other'
    await harness.emitTurnEnd(harness.agent, 1)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    expect(request.mock.calls.filter(([method]) => method === 'cleanup')).toHaveLength(0)
  })
  it('keeps tools active after task finalize and deactivates only on context reset', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      : { removed: [7], released: [8], retained: [] })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    const cleanupExec = execution(harness.agent)
    await harness.tools.get('browser_cleanup')?.execute({}, cleanupExec)
    harness.complete(harness.agent, 'browser_cleanup', false, cleanupExec)
    await Promise.resolve()
    expect(harness.tools.size).toBe(BROWSER_TOOL_NAMES.length)
    const resetExec = execution(harness.agent)
    await harness.tools.get('browser_context_reset')?.execute({}, resetExec)
    harness.complete(harness.agent, 'browser_context_reset', false, resetExec)
    await Promise.resolve()
    expect(harness.tools.size).toBe(0)
    expect(request.mock.calls.filter(([method]) => method === 'cleanup')).toHaveLength(1)
  })

  it('keeps automatic turn cleanup retryable when the extension reports failed tabs', async () => {
    let cleanupCalls = 0
    const request = vi.fn(async (method: string) => {
      if (method === 'status') return { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      cleanupCalls += 1
      if (cleanupCalls === 1) return { removed: [], released: [], retained: [7], failed: [{ tabId: 7, error: 'cannot close' }] }
      return { removed: [7], released: [], retained: [], failed: [] }
    })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    harness.emitTurnStart(harness.agent, 1)
    await harness.emitTurnEnd(harness.agent, 1)
    expect(cleanupCalls).toBe(1)
    expect(harness.tools.size).toBe(BROWSER_TOOL_NAMES.length)
    await harness.dispose(harness.agent)
    expect(cleanupCalls).toBe(2)
    expect(harness.tools.size).toBe(0)
  })

  it('rejects explicit cleanup when the extension reports failed tabs', async () => {
    let cleanupCalls = 0
    const request = vi.fn(async (method: string) => {
      if (method === 'status') return { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      cleanupCalls += 1
      if (cleanupCalls === 1) return { removed: [], released: [], retained: [7], failed: [{ tabId: 7, error: 'cannot close' }] }
      return { removed: [7], released: [], retained: [], failed: [] }
    })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    const cleanupExec = execution(harness.agent)
    await expect(harness.tools.get('browser_cleanup')?.execute({}, cleanupExec)).rejects.toThrow('Browser cleanup failed for 1 tab(s)')
    harness.complete(harness.agent, 'browser_cleanup', true, cleanupExec)
    expect(cleanupCalls).toBe(1)
    expect(harness.tools.size).toBe(BROWSER_TOOL_NAMES.length)
    await harness.dispose(harness.agent)
    expect(cleanupCalls).toBe(2)
    expect(harness.tools.size).toBe(0)
  })

  it('forwards explicit stale-runtime cleanup recovery without changing task mode', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      : { removed: [], released: [], retained: [], failed: [], recovered: [7] })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    const result = await harness.tools.get('browser_cleanup')?.execute({ recoverStale: true }, execution(harness.agent))
    expect(result).toMatchObject({ recovered: [7] })
    expect(request).toHaveBeenLastCalledWith('cleanup', { sessionId: 'session-test', mode: 'task', expectedBrowserId: 'edge:test', recoverStale: true }, expect.any(AbortSignal), { browserId: 'edge:test' })
  })

  it('rejects stale-runtime recovery when the extension capability is missing', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true } }
      : { removed: [], released: [], retained: [], failed: [], recovered: [] })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await expect(harness.tools.get('browser_cleanup')?.execute({ recoverStale: true }, execution(harness.agent))).rejects.toThrow('stale-runtime ownership recovery')
    expect(request.mock.calls.filter(([method]) => method === 'cleanup')).toHaveLength(0)
  })
  it('propagates cleanup transport errors and preserves recovery for disposal retry', async () => {
    const error = Object.assign(new Error('extension disconnected'), { code: 'EXTENSION_OFFLINE' })
    let cleanupCalls = 0
    const request = vi.fn(async (method: string) => {
      if (method === 'status') return { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      cleanupCalls += 1
      if (cleanupCalls === 1) throw error
      return { removed: [], released: [], retained: [] }
    })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    const cleanupExec = execution(harness.agent)
    await expect(harness.tools.get('browser_cleanup')?.execute({}, cleanupExec)).rejects.toThrow('extension disconnected')
    harness.complete(harness.agent, 'browser_cleanup', true, cleanupExec)
    expect(harness.tools.size).toBe(BROWSER_TOOL_NAMES.length)
    await harness.dispose(harness.agent)
    expect(cleanupCalls).toBe(2)
    expect(harness.tools.size).toBe(0)
  })

  it('reserves turn cleanup before operations accepted while a prior cleanup waits', async () => {
    let cleanupCalls = 0
    let releaseFirstCleanup!: () => void
    const firstCleanup = new Promise<void>(resolve => { releaseFirstCleanup = resolve })
    let interactionStarted!: () => void
    const interactionReady = new Promise<void>(resolve => { interactionStarted = resolve })
    let releaseInteraction!: () => void
    const interaction = new Promise<void>(resolve => { releaseInteraction = resolve })
    const order: string[] = []
    const request = vi.fn(async (method: string) => {
      if (method === 'status') return { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      if (method === 'cleanup') {
        cleanupCalls += 1
        order.push('cleanup-' + cleanupCalls)
        if (cleanupCalls === 1) await firstCleanup
        return { removed: [], released: [], retained: [], failed: [] }
      }
      if (method === 'interaction') {
        order.push('interaction')
        interactionStarted()
        await interaction
        return { clicked: true }
      }
      return { method }
    })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    harness.emitTurnStart(harness.agent, 1)
    const firstEnd = harness.emitTurnEnd(harness.agent, 1)
    await Promise.resolve()
    const click = harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))
    harness.emitTurnStart(harness.agent, 2)
    const secondEnd = harness.emitTurnEnd(harness.agent, 2)
    releaseFirstCleanup()
    await interactionReady
    expect(cleanupCalls).toBe(1)
    expect(order).toEqual(['cleanup-1', 'interaction'])
    releaseInteraction()
    await click
    await firstEnd
    await secondEnd
    expect(cleanupCalls).toBe(2)
    expect(order).toEqual(['cleanup-1', 'interaction', 'cleanup-2'])
  })

  it('keeps lazy tools registered when an Agent is disposed after task finalize', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      : { removed: [], released: [], retained: [] })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    const cleanupExec = execution(harness.agent)
    await harness.tools.get('browser_cleanup')?.execute({}, cleanupExec)
    harness.complete(harness.agent, 'browser_cleanup', false, cleanupExec)
    await Promise.resolve()
    expect(harness.tools.size).toBe(BROWSER_TOOL_NAMES.length)
    await harness.dispose(harness.agent)
    expect(harness.tools.size).toBe(0)
    expect(request.mock.calls.filter(([method]) => method === 'cleanup')).toHaveLength(1)
  })
  it('disposes lazy browser tools when the Agent is disposed', () => {
    const request = vi.fn(async () => ({ connected: true }))
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    expect(harness.tools.size).toBe(BROWSER_TOOL_NAMES.length)
    harness.dispose(harness.agent)
    expect(harness.tools.size).toBe(0)
  })

  it('cleans up a used session on Agent disposal', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }
      : { method })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    await harness.dispose(harness.agent)
    expect(request).toHaveBeenLastCalledWith('cleanup', { sessionId: 'session-test', mode: 'disposal', expectedBrowserId: 'edge:test' }, undefined, { browserId: 'edge:test' })
  })

  it('blocks same-ID replacement Agents after failed final cleanup', async () => {
    const error = Object.assign(new Error('extension disconnected'), { code: 'EXTENSION_OFFLINE' })
    const request = vi.fn(async (method: string) => {
      if (method === 'status') return { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      throw error
    })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    await harness.dispose(harness.agent)
    const replacement = harness.createAgent('session-test')
    harness.activate(replacement)
    expect(harness.toolsFor(replacement).size).toBe(0)
    await expect(harness.invokeUserSkill(replacement)).rejects.toThrow('prior cleanup succeeds')
  })

  it('cancels a locator wait during plugin disposal without waiting on its operation lease', async () => {
    let locatorStarted!: () => void
    let cleanupStarted!: () => void
    const locatorReady = new Promise<void>(resolve => { locatorStarted = resolve })
    const cleanupReady = new Promise<void>(resolve => { cleanupStarted = resolve })
    const request = vi.fn(async (method: string, _params: unknown, signal?: AbortSignal) => {
      if (method === 'status') return { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      if (method === 'locator') {
        locatorStarted()
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('locator wait aborted')), { once: true })
        })
      }
      if (method === 'cleanup') {
        cleanupStarted()
        return { removed: [], released: [], retained: [], failed: [] }
      }
      return { method }
    })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    const waiting = harness.tools.get('browser_locator')?.execute({ action: 'waitFor', strategy: 'css', selector: '.never', timeoutMs: 30_000 }, execution(harness.agent))
    await locatorReady
    const disposing = harness.disposePlugin()
    await cleanupReady
    await expect(waiting).rejects.toThrow()
    await disposing
    expect(request.mock.calls.filter(([method]) => method === 'cleanup')).toHaveLength(1)
  })
  it('disposes an in-flight browser operation before closing the plugin', async () => {
    let releaseStatus: ((value: unknown) => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const status = new Promise(resolve => { releaseStatus = resolve })
    const request = vi.fn(async (method: string) => method === 'status'
      ? (markStarted?.(), status)
      : { removed: [], released: [], retained: [] })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health }, undefined, { extensionReadyTimeoutMs: 120_000 })
    const operation = harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    let operationDone = false
    void operation?.then(() => { operationDone = true })
    await started
    await Promise.resolve()
    expect(operationDone).toBe(false)
    const disposing = harness.disposePlugin()
    let disposed = false
    void disposing.then(() => { disposed = true })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(disposed).toBe(false)
    releaseStatus?.({ connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } })
    await operation
    await disposing
    expect(harness.tools.size).toBe(0)
    expect(request.mock.calls.filter(([method]) => method === 'cleanup')).toHaveLength(1)
  })

  it('waits for a pre-lease browser operation before plugin disposal', async () => {
    let releaseFirstCleanup!: () => void
    const firstCleanup = new Promise<void>(resolve => { releaseFirstCleanup = resolve })
    let interactionStarted!: () => void
    const interactionReady = new Promise<void>(resolve => { interactionStarted = resolve })
    let releaseInteraction!: () => void
    const interaction = new Promise<void>(resolve => { releaseInteraction = resolve })
    let cleanupCalls = 0
    const request = vi.fn(async (method: string) => {
      if (method === 'status') return { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      if (method === 'cleanup') {
        cleanupCalls += 1
        if (cleanupCalls === 1) await firstCleanup
        return { removed: [], released: [], retained: [], failed: [] }
      }
      if (method === 'interaction') {
        interactionStarted()
        await interaction
        return { clicked: true }
      }
      return { method }
    })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    harness.emitTurnStart(harness.agent, 1)
    const turnEnd = harness.emitTurnEnd(harness.agent, 1)
    await Promise.resolve()
    const click = harness.tools.get('browser_click')?.execute({ tabId: 7, ref: 'e4' }, execution(harness.agent))
    let disposed = false
    const disposing = harness.disposePlugin().then(() => { disposed = true })
    releaseFirstCleanup()
    await interactionReady
    expect(disposed).toBe(false)
    expect(cleanupCalls).toBe(1)
    releaseInteraction()
    await click
    await turnEnd
    await disposing
    expect(cleanupCalls).toBe(2)
    expect(disposed).toBe(true)
  })

  it('serializes concurrent failed cleanup callers', async () => {
    const error = Object.assign(new Error('extension disconnected'), { code: 'EXTENSION_OFFLINE' })
    let active = 0
    let maximum = 0
    const request = vi.fn(async (method: string) => {
      if (method === 'status') return { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.3.7', capabilities: { turnCleanup: true, turnScopedMarks: true, retainedCleanup: true, debuggerLeaseRecovery: true, tabIncarnationFence: true } }
      active += 1
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active -= 1
      throw error
    })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    const first = harness.tools.get('browser_cleanup')?.execute({}, execution(harness.agent))
    const second = harness.tools.get('browser_cleanup')?.execute({}, execution(harness.agent))
    const results = await Promise.allSettled([first, second])
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(maximum).toBe(1)
    expect(request.mock.calls.filter(([method]) => method === 'cleanup')).toHaveLength(2)
    expect(harness.tools.size).toBe(BROWSER_TOOL_NAMES.length)
  })

  it('cleans active browser resources before plugin disposal', async () => {
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4' }
      : { method })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test' }))
    const harness = setup({ request, health })
    await harness.tools.get('browser_status')?.execute({}, execution(harness.agent))
    await harness.disposePlugin()
    expect(harness.tools.size).toBe(0)
    expect(request).toHaveBeenLastCalledWith('cleanup', { sessionId: 'session-test', mode: 'disposal', expectedBrowserId: 'edge:test' }, undefined, { browserId: 'edge:test' })
  })

  it('stores screenshots as attachment references and renders an image block', async () => {
    const ref = { attachmentId: 'attachment-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } as unknown as ImageAttachmentRef
    const saveImage = vi.fn(async () => ref)
    const attachments = { saveImage } as unknown as AttachmentStore
    const request = vi.fn(async (method: string) => method === 'status'
      ? { connected: true, browser: 'edge', browserId: 'edge:test', profile: 'current', extensionVersion: '0.2.4', capabilities: { tabIncarnationFence: true } }
      : { tabId: 7, data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' })
    const health = vi.fn(async () => ({ ok: true, extensionConnected: true, browserId: 'edge:test', capabilities: { tabIncarnationFence: true } }))
    const harness = setup({ request, health }, attachments)
    const tool = harness.tools.get('browser_screenshot')
    const value = await tool?.execute({ tabId: 7 }, execution(harness.agent))
    expect(value).toEqual({ tabId: 7, mimeType: 'image/png', attachment: ref })
    expect(saveImage).toHaveBeenCalledOnce()
    const content = tool?.output.render({}, value as never)
    expect(content?.[1]).toEqual({ type: 'image', attachment: ref })
  })
})
