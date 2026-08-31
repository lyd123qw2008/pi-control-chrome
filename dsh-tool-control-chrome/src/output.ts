/** Pure model-facing projections for bounded browser tool results. */

import type { JsonValue } from '@deepseek-ai/dsh-tools'

const SNAPSHOT_MAX_CHARS = 20_000
const SNAPSHOT_TEXT_MAX_CHARS = 8_000
const DOM_MAX_CHARS = 20_000
const EXTRACT_MAX_CHARS = 12_000
const OUTPUT_HARD_MAX_CHARS = 100_000
const OUTPUT_HARD_MAX_NODES = 1_000
const DEFAULT_OUTPUT_NODES = 200
const FIELD_MAX_CHARS = 240
const RESULT_IDENTITY_KEYS = ['browserId', 'profile', 'connectionId', 'connectionGeneration'] as const

function outputChars(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? Math.min(value, OUTPUT_HARD_MAX_CHARS)
    : fallback
}

function outputNodes(value: unknown, fallback = DEFAULT_OUTPUT_NODES): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? Math.min(value, OUTPUT_HARD_MAX_NODES)
    : fallback
}

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function bounded(value: unknown, limit: number): string {
  const source = text(value)
  if (limit <= 0) return ''
  if (source.length <= limit) return source
  if (limit <= 3) return source.slice(0, limit)
  return `${source.slice(0, limit - 3)}...`
}

function compactTab(value: unknown, currentSessionId?: string): unknown {
  if (!isRecord(value)) return value
  const keys = [
    'id', 'browserId', 'windowId', 'index', 'active', 'pinned', 'title', 'url', 'status', 'groupId',
    'tabFence', 'incarnation', 'owner', 'ownership', 'sessionId', 'lifecycle', 'stale', 'handle',
  ] as const
  const result: RecordValue = {}
  for (const key of keys) {
    if (value[key] !== undefined) result[key] = value[key]
  }
  if (currentSessionId !== undefined && currentSessionId.length > 0) {
    const tabSessionId = typeof result.sessionId === 'string' && result.sessionId.length > 0 ? result.sessionId : undefined
    result.sessionScope = tabSessionId === undefined ? 'user' : tabSessionId === currentSessionId ? 'current-agent' : 'other-agent'
  }
  if (typeof result.handle === 'object' && result.handle !== null && !Array.isArray(result.handle)) {
    const handle = result.handle as RecordValue
    const handleKeys = ['tabId', 'browserId', 'windowId', 'title', 'url', 'groupId', 'sessionId', 'tabFence', 'incarnation'] as const
    result.handle = Object.fromEntries(handleKeys.filter(key => handle[key] !== undefined).map(key => [key, handle[key]]))
  }
  if (typeof result.title === 'string') result.title = bounded(result.title, FIELD_MAX_CHARS)
  if (typeof result.url === 'string') result.url = bounded(result.url, 4_096)
  if (isRecord(result.handle) && typeof result.handle.title === 'string') result.handle.title = bounded(result.handle.title, FIELD_MAX_CHARS)
  if (isRecord(result.handle) && typeof result.handle.url === 'string') result.handle.url = bounded(result.handle.url, 4_096)
  if (typeof result.favicon === 'string' && !/^https?:\/\//i.test(result.favicon)) delete result.favicon
  return result
}

function compactResultEnvelope(value: RecordValue, currentSessionId?: string): RecordValue {
  const result: RecordValue = {}
  for (const key of RESULT_IDENTITY_KEYS) {
    if (value[key] === undefined) continue
    result[key] = key === 'profile' ? bounded(value[key], FIELD_MAX_CHARS) : value[key]
  }
  if (value.tabId !== undefined) result.tabId = value.tabId
  if (value.tab !== undefined) result.tab = compactTab(value.tab, currentSessionId)
  return result
}

function compactStateSnapshot(snapshot: RecordValue, maxChars: number, maxNodes: number): { state: string; nodeCount: number; charCount: number; truncated: boolean } | undefined {
  if (typeof snapshot.state !== 'string' || Array.isArray(snapshot.elements) || isRecord(snapshot.accessibility)) return undefined
  const sourceState = text(snapshot.state)
  const state = bounded(sourceState, maxChars)
  const sourceNodeCount = typeof snapshot.nodeCount === 'number' && Number.isFinite(snapshot.nodeCount) ? Math.max(0, snapshot.nodeCount) : 0
  return {
    state,
    nodeCount: Math.min(sourceNodeCount, maxNodes),
    charCount: state.length,
    truncated: snapshot.truncated === true || sourceNodeCount > maxNodes || sourceState.length > maxChars,
  }
}

function compactAccessibilityState(value: RecordValue, maxChars: number, maxNodes: number): { state: string; nodeCount: number; charCount: number; truncated: boolean } | undefined {
  if (typeof value.state !== 'string' || Array.isArray(value.children)) return undefined
  const sourceState = text(value.state)
  const state = bounded(sourceState, maxChars)
  const sourceNodeCount = typeof value.nodeCount === 'number' && Number.isFinite(value.nodeCount) ? Math.max(0, value.nodeCount) : 0
  return {
    state,
    nodeCount: Math.min(sourceNodeCount, maxNodes),
    charCount: state.length,
    truncated: value.truncated === true || sourceNodeCount > maxNodes || sourceState.length > maxChars,
  }
}

function compactDomState(dom: RecordValue, maxChars: number, maxNodes: number): { state: string; nodeCount: number; charCount: number; truncated: boolean } | undefined {
  if (typeof dom.state !== 'string' || Array.isArray(dom.nodes)) return undefined
  const sourceState = text(dom.state)
  const state = bounded(sourceState, maxChars)
  const sourceNodeCount = typeof dom.nodeCount === 'number' && Number.isFinite(dom.nodeCount) ? Math.max(0, dom.nodeCount) : 0
  return {
    state,
    nodeCount: Math.min(sourceNodeCount, maxNodes),
    charCount: state.length,
    truncated: dom.truncated === true || sourceNodeCount > maxNodes || sourceState.length > maxChars,
  }
}

function quote(value: unknown): string {
  return JSON.stringify(bounded(value, FIELD_MAX_CHARS))
}

function elementLine(element: RecordValue): string {
  const role = bounded(text(element.role || element.tag || 'generic'), 64)
  const name = text(element.name)
  const value = element.value === undefined || text(element.value).length === 0 ? '' : ` value=${quote(element.value)}`
  const disabled = element.disabled === true ? ' disabled' : ''
  const checked = element.checked === undefined ? '' : ` checked=${element.checked === true}`
  const href = typeof element.href === 'string' ? ` href=${quote(element.href)}` : ''
  const ref = typeof element.ref === 'string' ? ` [ref=${element.ref}]` : ''
  return `- ${role}${name ? ` ${quote(name)}` : ''}${value}${disabled}${checked}${href}${ref}`
}

function accessibilityLine(node: RecordValue, prefix = '- '): string {
  const role = bounded(text(node.role || 'generic'), 64)
  const name = text(node.name)
  const value = node.value === undefined || text(node.value).length === 0 ? '' : ` value=${quote(node.value)}`
  const disabled = node.disabled === true ? ' disabled' : ''
  const checked = node.checked === undefined ? '' : ` checked=${node.checked === true}`
  return `${prefix}${role}${name ? ` ${quote(name)}` : ''}${value}${disabled}${checked}`
}

function snapshotState(snapshot: RecordValue, maxChars: number, maxNodes: number): { state: string; nodeCount: number; charCount: number; truncated: boolean } {
  const lines: string[] = []
  const allElements = Array.isArray(snapshot.elements) ? snapshot.elements.filter(isRecord) : []
  const allChildren = isRecord(snapshot.accessibility) && Array.isArray(snapshot.accessibility.children) ? snapshot.accessibility.children.filter(isRecord) : []
  const elements = allElements.slice(0, maxNodes)
  if (elements.length > 0) {
    lines.push(`Interactive elements:\n${elements.map(elementLine).join('\n')}`)
  } else {
    const children = allChildren.slice(0, maxNodes)
    if (children.length > 0) lines.push(`Accessibility:\n${children.map(node => accessibilityLine(node)).join('\n')}`)
  }
  const pageTextLimit = Math.min(SNAPSHOT_TEXT_MAX_CHARS, maxChars)
  const pageText = bounded(snapshot.text, pageTextLimit)
  if (elements.length === 0 && allChildren.length === 0 && pageText) lines.push(`Page text:\n${pageText}`)
  const stateSource = lines.join('\n\n')
  const state = bounded(stateSource, maxChars)
  const rawText = text(snapshot.text)
  const semanticState = elements.length > 0 || allChildren.length > 0
  const pageTextIncluded = !semanticState && pageText.length > 0
  const semanticTruncated = allElements.length > maxNodes
    || allChildren.length > maxNodes
    || stateSource.length > maxChars
    || (snapshot.truncated === true && (!semanticState || (typeof snapshot.elementCharCount === 'number' && snapshot.elementCharCount >= maxChars)))
  const pageTextTruncated = pageTextIncluded && (snapshot.textTruncated === true || rawText.length > pageTextLimit)
  return {
    state,
    nodeCount: elements.length > 0 ? elements.length : Math.min(allChildren.length, maxNodes),
    charCount: state.length,
    truncated: semanticTruncated || pageTextTruncated,
  }
}

/**
 * Project a raw snapshot to one bounded semantic state while retaining ref text.
 * @param value Raw Bridge result.
 * @param maxChars Character budget for the projected state.
 * @param maxNodes Node budget for the projected state.
 * @returns Model-facing JSON result.
 */
export function compactSnapshotResult(value: unknown, maxChars = SNAPSHOT_MAX_CHARS, maxNodes = DEFAULT_OUTPUT_NODES): JsonValue {
  if (!isRecord(value)) return value as JsonValue
  if (!isRecord(value.snapshot)) return compactResultEnvelope(value) as JsonValue
  const snapshot = value.snapshot
  const projected = compactStateSnapshot(snapshot, maxChars, maxNodes) ?? snapshotState(snapshot, maxChars, maxNodes)
  return {
    ...compactResultEnvelope(value),
    snapshot: {
      snapshotId: snapshot.snapshotId,
      ...(value.tab === undefined && snapshot.title !== undefined ? { title: bounded(snapshot.title, FIELD_MAX_CHARS) } : {}),
      ...(value.tab === undefined && snapshot.url !== undefined ? { url: bounded(snapshot.url, 4_096) } : {}),
      state: projected.state,
      nodeCount: projected.nodeCount,
      charCount: projected.charCount ?? projected.state.length,
      truncated: projected.truncated,
      ...(snapshot.viewport === undefined ? {} : { viewport: snapshot.viewport }),
    },
  } as JsonValue
}

/**
 * Project an accessibility response to full, diff, or unchanged semantic text.
 * @param value Raw Bridge result.
 * @param maxChars Character budget for the projected state.
 * @param maxNodes Node budget for the projected state.
 * @returns Model-facing JSON result.
 */
export function compactAccessibilityResult(value: unknown, maxChars = SNAPSHOT_MAX_CHARS, maxNodes = DEFAULT_OUTPUT_NODES): JsonValue {
  if (!isRecord(value)) return value as JsonValue
  const precompact = compactAccessibilityState(value, maxChars, maxNodes)
  if (precompact) {
    return {
      ...compactResultEnvelope(value),
      snapshotId: value.snapshotId,
      ...(typeof value.baseSnapshotId === 'string' ? { baseSnapshotId: value.baseSnapshotId } : {}),
      mode: typeof value.mode === 'string' ? value.mode : 'full',
      state: precompact.state,
      nodeCount: precompact.nodeCount,
      ...(typeof value.changedNodeCount === 'number' ? { changedNodeCount: value.changedNodeCount } : {}),
      charCount: precompact.charCount,
      truncated: precompact.truncated,
    } as JsonValue
  }
  const snapshot = isRecord(value.snapshot) ? value.snapshot : undefined
  const accessibility = isRecord(snapshot?.accessibility) ? snapshot.accessibility : value
  const allChildren = Array.isArray(accessibility.children) ? accessibility.children.filter(isRecord) : []
  const children = allChildren.slice(0, maxNodes)
  const mode = typeof accessibility.mode === 'string' ? accessibility.mode : 'full'
  const sourceState = mode === 'full' && children.length > 0
    ? children.map(node => accessibilityLine(node)).join('\n')
    : typeof accessibility.state === 'string'
      ? accessibility.state
      : children.map(node => accessibilityLine(node)).join('\n')
  const state = bounded(sourceState, maxChars)
  return {
    ...compactResultEnvelope(value),
    snapshotId: typeof snapshot?.snapshotId === 'string' ? snapshot.snapshotId : accessibility.snapshotId,
    ...(value.tab === undefined && typeof snapshot?.title === 'string' ? { title: bounded(snapshot.title, FIELD_MAX_CHARS) } : {}),
    ...(value.tab === undefined && typeof snapshot?.url === 'string' ? { url: bounded(snapshot.url, 4_096) } : {}),
    ...(typeof accessibility.baseSnapshotId === 'string' ? { baseSnapshotId: accessibility.baseSnapshotId } : {}),
    mode,
    state,
    nodeCount: typeof accessibility.nodeCount === 'number' ? Math.min(accessibility.nodeCount, maxNodes) : children.length,
    ...(typeof accessibility.changedNodeCount === 'number' ? { changedNodeCount: accessibility.changedNodeCount } : {}),
    charCount: state.length,
    truncated: accessibility.truncated === true || allChildren.length > maxNodes || sourceState.length > maxChars,
  } as JsonValue
}

/**
 * Project the visible DOM tree to bounded line-oriented text with node ids.
 * @param value Raw Bridge result.
 * @param maxChars Character budget for the projected state.
 * @param maxNodes Node budget for the projected state.
 * @returns Model-facing JSON result.
 */
export function compactDomCuaResult(value: unknown, maxChars = DOM_MAX_CHARS, maxNodes = DEFAULT_OUTPUT_NODES): JsonValue {
  if (!isRecord(value)) return value as JsonValue
  if (!isRecord(value.dom)) return compactResultEnvelope(value) as JsonValue
  const dom = value.dom
  const precompact = compactDomState(dom, maxChars, maxNodes)
  if (precompact) {
    return {
      ...compactResultEnvelope(value),
      dom: {
        snapshotId: dom.snapshotId,
        ...(dom.viewport === undefined ? {} : { viewport: dom.viewport }),
        state: precompact.state,
        nodeCount: precompact.nodeCount,
        charCount: precompact.charCount,
        truncated: precompact.truncated,
      },
    } as JsonValue
  }
  const allNodes = Array.isArray(dom.nodes) ? dom.nodes.filter(isRecord) : []
  const nodes = allNodes.slice(0, maxNodes)
  const stateSource = nodes.map(node => {
    const id = text(node.node_id)
    const tag = text(node.tag || 'element')
    const role = node.role === undefined ? '' : ` role=${quote(bounded(node.role, 64))}`
    const parent = node.parent_id === undefined ? '' : ` parent=${text(node.parent_id)}`
    const content = text(node.text)
    return `<${tag} node_id=${id}${parent}${role}>${bounded(content, 160)}</${tag}>`
  }).join('\n')
  const state = bounded(stateSource, maxChars)
  return {
    ...compactResultEnvelope(value),
    dom: {
      snapshotId: dom.snapshotId,
      viewport: dom.viewport,
      state,
      nodeCount: typeof dom.nodeCount === 'number' ? Math.min(dom.nodeCount, maxNodes) : nodes.length,
      charCount: state.length,
      truncated: dom.truncated === true || allNodes.length > maxNodes || stateSource.length > maxChars,
    },
  } as JsonValue
}

/**
 * Project extracted page content with one shared text budget.
 * @param value Raw Bridge result.
 * @param maxChars Character budget shared by text and Markdown.
 * @returns Model-facing JSON result.
 */
export function compactExtractResult(value: unknown, maxChars = EXTRACT_MAX_CHARS): JsonValue {
  if (!isRecord(value)) return value as JsonValue
  const content = isRecord(value.content) ? value.content : undefined
  if (content === undefined) return compactResultEnvelope(value) as JsonValue
  const contentText = bounded(content.text, maxChars)
  const remainingChars = Math.max(0, maxChars - contentText.length)
  const contentMarkdown = remainingChars > 0 ? bounded(content.markdown, remainingChars) : ''
  return {
    ...compactResultEnvelope(value),
    content: {
       ...(value.tab === undefined && content.title !== undefined ? { title: bounded(content.title, FIELD_MAX_CHARS) } : {}),
       ...(value.tab === undefined && content.url !== undefined ? { url: bounded(content.url, 4_096) } : {}),
      text: contentText,
      markdown: contentMarkdown,
      ...(content.truncated === true || text(content.text).length > maxChars || text(content.markdown).length > remainingChars ? { truncated: true } : {}),
    },
  } as JsonValue
}

/**
 * Project tab inventory fields and remove data URL favicon payloads.
 * @param value Raw Bridge result.
 * @returns Model-facing JSON result.
 */
export function compactTabsResult(value: unknown, currentSessionId?: string): JsonValue {
  if (!isRecord(value)) return value as JsonValue
  const tabs = Array.isArray(value.tabs) ? value.tabs.map(tab => compactTab(tab, currentSessionId)) : []
  return {
    ...compactResultEnvelope(value),
    ...(currentSessionId === undefined || currentSessionId.length === 0 ? {} : { currentAgentSessionId: currentSessionId }),
    tabs,
    ...(Array.isArray(value.groups) ? { groups: value.groups } : {}),
  } as JsonValue
}

/**
 * Project a created tab result while retaining the handle needed for the next call.
 * @param value Raw Bridge result.
 * @param currentSessionId Current Agent session id.
 * @returns Model-facing JSON result.
 */
export function compactNewTabResult(value: unknown, currentSessionId?: string): JsonValue {
  if (!isRecord(value)) return value as JsonValue
  return {
    ...compactResultEnvelope(value, currentSessionId),
    ...(currentSessionId === undefined || currentSessionId.length === 0 ? {} : { currentAgentSessionId: currentSessionId }),
    ...(value.groupId === undefined ? {} : { groupId: value.groupId }),
    ...(value.tabFence === undefined ? {} : { tabFence: value.tabFence }),
  } as JsonValue
}

/**
 * Apply the result projection selected by a model-facing browser tool.
 * @param toolName Public browser tool name.
 * @param params Tool parameters that may contain output budgets.
 * @param value Raw Bridge result.
 * @returns Model-facing JSON result.
 */
export function compactBrowserResult(toolName: string, params: Record<string, unknown>, value: unknown): JsonValue {
  const maxChars = outputChars(params.maxChars, toolName === 'browser_extract' ? EXTRACT_MAX_CHARS : toolName === 'browser_dom_cua' ? DOM_MAX_CHARS : SNAPSHOT_MAX_CHARS)
  const maxNodes = outputNodes(params.maxNodes)
  if (toolName === 'browser_snapshot') return compactSnapshotResult(value, maxChars, maxNodes)
  if (toolName === 'browser_accessibility_snapshot') return compactAccessibilityResult(value, maxChars, maxNodes)
  if (toolName === 'browser_extract') return compactExtractResult(value, maxChars)
  if (toolName === 'browser_new_tab') return compactNewTabResult(value, typeof params.sessionId === 'string' ? params.sessionId : undefined)
  if (toolName === 'browser_tabs') return compactTabsResult(value, typeof params.sessionId === 'string' ? params.sessionId : undefined)
  if (toolName === 'browser_selected') return isRecord(value) ? compactResultEnvelope(value, typeof params.sessionId === 'string' ? params.sessionId : undefined) as JsonValue : value as JsonValue
  if (toolName === 'browser_dom_cua' && params.action === 'get_visible_dom') return compactDomCuaResult(value, maxChars, maxNodes)
  return value as JsonValue
}
