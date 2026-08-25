/** DSH model-facing tools that map to pi-control-chrome Bridge methods. */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  defineTool,
  type JsonValue,
  type ParameterPropertySpec,
  type ParameterSchemaSpec,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import type { BrowserBridgeClient } from './bridge.js'
import { bridgeRecovery, unavailableBridgeRecovery } from './diagnostics.js'
import { BROWSER_SKILL_NAME } from './skill.js'
import type { ResolvedConfig, ScreenshotResult } from './types.js'

const TAB_ID: ParameterPropertySpec = { type: 'number', description: 'Browser tab id. Omit to use the selected tab.' }
const SELECTOR: ParameterPropertySpec = { type: 'string', description: 'Optional CSS selector. Prefer a ref from browser_snapshot.' }
const JSON_VALUE: ParameterPropertySpec = { type: 'json' }
const OPTIONAL_STRING: ParameterPropertySpec = { type: 'string' }
const OPTIONAL_NUMBER: ParameterPropertySpec = { type: 'number' }
const OPTIONAL_BOOLEAN: ParameterPropertySpec = { type: 'boolean' }
const EMPTY_PARAMETERS: ParameterSchemaSpec = {}

type BrowserTarget = {
  readonly browser: string
  readonly browserId: string
  readonly profile: string
}

type TargetStability = {
  readonly stable: boolean
  readonly changed: boolean
  readonly acknowledged: boolean
  readonly requiresAcknowledgement: boolean
  readonly competition: 'unknown' | 'stable_observed' | 'changed'
  readonly browser?: string
  readonly browserId?: string
  readonly profile?: string
  readonly previousBrowser?: string
  readonly previousBrowserId?: string
  readonly observedBrowserIds: readonly string[]
  readonly issue?: string
}

function readBrowserTarget(value: unknown): BrowserTarget | undefined {
  if (!isRecord(value)) return undefined
  const browser = value.browser
  const browserId = value.browserId
  const profile = value.profile
  if (typeof browser !== 'string' || browser.length === 0 || typeof browserId !== 'string' || browserId.length === 0 || typeof profile !== 'string' || profile.length === 0) return undefined
  return { browser, browserId, profile }
}

function sameBrowserTarget(left: BrowserTarget, right: BrowserTarget): boolean {
  return left.browser === right.browser && left.browserId === right.browserId && left.profile === right.profile
}

class BrowserTargetTracker {
  private acknowledged?: BrowserTarget
  private readonly observed = new Set<string>()

  observe(value: unknown, acknowledgeBrowserId?: string): TargetStability {
    const target = readBrowserTarget(value)
    if (target === undefined) {
      return {
        stable: false,
        changed: false,
        acknowledged: false,
        requiresAcknowledgement: false,
        competition: 'unknown',
        observedBrowserIds: [...this.observed.keys()],
        issue: 'status_missing_browser_target',
      }
    }
    const previous = this.acknowledged
    const changed = previous !== undefined && !sameBrowserTarget(previous, target)
    const acknowledged = previous === undefined || !changed || acknowledgeBrowserId === target.browserId
    this.observed.add(target.browserId)
    if (acknowledged) this.acknowledged = target
    return {
      stable: !changed,
      changed,
      acknowledged,
      requiresAcknowledgement: changed && !acknowledged,
      competition: previous === undefined ? 'unknown' : changed ? 'changed' : 'stable_observed',
      browser: target.browser,
      browserId: target.browserId,
      profile: target.profile,
      observedBrowserIds: [...this.observed.keys()],
      ...(!changed || previous === undefined ? {} : { previousBrowser: previous.browser, previousBrowserId: previous.browserId }),
    }
  }

  assertStable(value: unknown): BrowserTarget {
    const observation = this.observe(value)
    if (observation.issue !== undefined) throw new Error('Browser status did not identify an active browser target; run browser_doctor')
    if (!observation.stable || !observation.acknowledged) {
      throw new Error(`Browser target changed from ${observation.previousBrowser} (${observation.previousBrowserId}) to ${observation.browser} (${observation.browserId}); run browser_status with acknowledgeBrowserId after disabling the other browser extension`)
    }
    const target = readBrowserTarget(value)
    if (target === undefined) throw new Error('Browser status did not identify an active browser target; run browser_doctor')
    return target
  }
}

interface BrowserToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: ParameterSchemaSpec
  readonly method: string
  readonly prepare?: (args: Record<string, JsonValue>) => Record<string, JsonValue>
}

function requiredString(description?: string): ParameterPropertySpec {
  return { type: 'string', required: true, ...(description === undefined ? {} : { description }) }
}

function requiredNumber(description?: string): ParameterPropertySpec {
  return { type: 'number', required: true, ...(description === undefined ? {} : { description }) }
}

function requiredFiles(): ParameterPropertySpec {
  return {
    oneOf: [
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
    ],
    required: true,
  }
}

function coordinates(): ParameterPropertySpec {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        x: { type: 'number', required: true },
        y: { type: 'number', required: true },
      },
      additionalProperties: false,
    },
  }
}

const CORE_TOOLS: readonly BrowserToolSpec[] = [
  {
    name: 'browser_doctor',
    description: 'Diagnose the local Bridge, extension connection, active browser target and Chrome/Edge competition without changing tabs.',
    parameters: EMPTY_PARAMETERS,
    method: 'doctor',
  },
  {
    name: 'browser_status',
    description: 'Return the connected Chrome/Edge browser, active browser target stability and local Bridge status.',
    parameters: {
      acknowledgeBrowserId: { type: 'string', description: 'Explicitly acknowledge this browserId after the user confirms a browser switch.' },
    },
    method: 'status',
  },
  {
    name: 'browser_tabs',
    description: 'List Chrome/Edge windows, tabs, tab groups, ownership and lifecycle state.',
    parameters: EMPTY_PARAMETERS,
    method: 'list_tabs',
  },
  {
    name: 'browser_selected',
    description: 'Return the currently selected Chrome/Edge tab.',
    parameters: EMPTY_PARAMETERS,
    method: 'selected_tab',
  },
  {
    name: 'browser_claim_tab',
    description: 'Claim an existing user tab using its current id and optional title/URL snapshot. Fails if the snapshot changed.',
    parameters: {
      tabId: requiredNumber('Current browser tab id.'),
      windowId: OPTIONAL_NUMBER,
      title: OPTIONAL_STRING,
      url: OPTIONAL_STRING,
    },
    method: 'claim_tab',
  },
  {
    name: 'browser_select_tab',
    description: 'Select an existing browser tab by id, optionally focusing its window.',
    parameters: { tabId: requiredNumber(), focusWindow: OPTIONAL_BOOLEAN },
    method: 'select_tab',
  },
  {
    name: 'browser_new_tab',
    description: 'Create an Agent-owned tab and place it in the Pi tab group.',
    parameters: {
      url: { type: 'string', description: 'Initial URL. Defaults to about:blank.' },
      active: { type: 'boolean', description: 'Whether to activate the new tab.' },
    },
    method: 'new_tab',
  },
  {
    name: 'browser_snapshot',
    description: 'Read the active page title, URL, visible text and interactive elements with stable eN refs.',
    parameters: { tabId: TAB_ID },
    method: 'snapshot',
  },
  {
    name: 'browser_extract',
    description: 'Extract the current page as bounded plain text and simple Markdown without using a separate web scraper.',
    parameters: { tabId: TAB_ID },
    method: 'extract',
  },
  {
    name: 'browser_accessibility_snapshot',
    description: 'Return the accessibility-oriented semantic tree included in the current page snapshot.',
    parameters: { tabId: TAB_ID },
    method: 'snapshot',
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a selected or specified browser tab to a URL and optionally wait for loading to complete.',
    parameters: {
      tabId: TAB_ID,
      url: requiredString('Destination URL.'),
      wait: OPTIONAL_BOOLEAN,
      timeoutMs: OPTIONAL_NUMBER,
    },
    method: 'navigate',
  },
  {
    name: 'browser_wait',
    description: 'Wait for a selected browser tab to finish loading or reach a URL or URL fragment.',
    parameters: {
      tabId: TAB_ID,
      state: OPTIONAL_STRING,
      url: OPTIONAL_STRING,
      urlIncludes: OPTIONAL_STRING,
      timeoutMs: OPTIONAL_NUMBER,
    },
    method: 'wait',
  },
  {
    name: 'browser_back',
    description: 'Navigate the selected browser tab back in history.',
    parameters: { tabId: TAB_ID, bypassCache: OPTIONAL_BOOLEAN },
    method: 'back',
  },
  {
    name: 'browser_forward',
    description: 'Navigate the selected browser tab forward in history.',
    parameters: { tabId: TAB_ID, bypassCache: OPTIONAL_BOOLEAN },
    method: 'forward',
  },
  {
    name: 'browser_reload',
    description: 'Reload the selected browser tab.',
    parameters: { tabId: TAB_ID, bypassCache: OPTIONAL_BOOLEAN },
    method: 'reload',
  },
  {
    name: 'browser_click',
    description: 'Click an element by an eN ref from browser_snapshot or by CSS selector.',
    parameters: { tabId: TAB_ID, snapshotId: OPTIONAL_STRING, ref: OPTIONAL_STRING, selector: SELECTOR },
    method: 'interaction',
    prepare: args => ({ ...args, operation: 'click' }),
  },
  {
    name: 'browser_double_click',
    description: 'Double-click an element by an eN ref or CSS selector.',
    parameters: { tabId: TAB_ID, snapshotId: OPTIONAL_STRING, ref: OPTIONAL_STRING, selector: SELECTOR },
    method: 'interaction',
    prepare: args => ({ ...args, operation: 'double_click' }),
  },
  {
    name: 'browser_fill',
    description: 'Fill an input, textarea or contenteditable element by eN ref or CSS selector.',
    parameters: {
      tabId: TAB_ID,
      snapshotId: OPTIONAL_STRING,
      ref: OPTIONAL_STRING,
      selector: SELECTOR,
      value: requiredString('Replacement text.'),
    },
    method: 'interaction',
    prepare: args => ({ ...args, operation: 'fill' }),
  },
  {
    name: 'browser_type',
    description: 'Type or append text into a focused browser field.',
    parameters: {
      tabId: TAB_ID,
      snapshotId: OPTIONAL_STRING,
      ref: OPTIONAL_STRING,
      selector: SELECTOR,
      value: requiredString('Text to type.'),
    },
    method: 'interaction',
    prepare: args => ({ ...args, operation: 'type' }),
  },
  {
    name: 'browser_press_key',
    description: 'Dispatch a keyboard key to an eN ref or CSS selector.',
    parameters: {
      tabId: TAB_ID,
      snapshotId: OPTIONAL_STRING,
      ref: OPTIONAL_STRING,
      selector: SELECTOR,
      key: requiredString('Key name or character.'),
    },
    method: 'interaction',
    prepare: args => ({ ...args, operation: 'press' }),
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the selected page by a viewport delta.',
    parameters: { tabId: TAB_ID, deltaX: OPTIONAL_NUMBER, deltaY: OPTIONAL_NUMBER },
    method: 'interaction',
    prepare: args => ({ ...args, operation: 'scroll' }),
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the selected browser tab and return it as an image attachment.',
    parameters: {
      tabId: TAB_ID,
      fullPage: OPTIONAL_BOOLEAN,
      format: OPTIONAL_STRING,
      path: { type: 'string', description: 'Optional local path where the image should also be saved.' },
    },
    method: 'screenshot',
  },
  {
    name: 'browser_close_tab',
    description: 'Close a specified browser tab. Agent-owned tabs must belong to the current session; unowned user tabs require userRequested: true.',
    parameters: { tabId: requiredNumber(), userRequested: OPTIONAL_BOOLEAN },
    method: 'close_tab',
  },
  {
    name: 'browser_release',
    description: 'Release a claimed or Agent tab from the current session without closing the page.',
    parameters: { tabId: requiredNumber() },
    method: 'release',
  },
  {
    name: 'browser_mark_handoff',
    description: 'Mark an Agent-owned tab to survive cleanup for manual user handoff.',
    parameters: { tabId: requiredNumber() },
    method: 'mark_handoff',
  },
  {
    name: 'browser_mark_deliverable',
    description: 'Mark an Agent-owned tab to survive cleanup as a user-facing deliverable.',
    parameters: { tabId: requiredNumber() },
    method: 'mark_deliverable',
  },
  {
    name: 'browser_cleanup',
    description: 'Close temporary Agent-owned tabs for the current session and preserve handoff and deliverable tabs.',
    parameters: EMPTY_PARAMETERS,
    method: 'cleanup',
  },
]

const ADVANCED_TOOLS: readonly BrowserToolSpec[] = [
  {
    name: 'browser_locator',
    description: 'Use Playwright-style locator operations with css, role, text, label, placeholder and testid strategies.',
    parameters: {
      tabId: TAB_ID,
      action: requiredString('Locator action such as count, click, fill, text or attribute.'),
      strategy: OPTIONAL_STRING,
      selector: SELECTOR,
      value: JSON_VALUE,
      exact: OPTIONAL_BOOLEAN,
      name: OPTIONAL_STRING,
      index: OPTIONAL_NUMBER,
      hasText: OPTIONAL_STRING,
      hasSelector: OPTIONAL_STRING,
      other: JSON_VALUE,
      attribute: OPTIONAL_STRING,
      key: OPTIONAL_STRING,
      timeoutMs: OPTIONAL_NUMBER,
    },
    method: 'locator',
    prepare: args => ({
      ...args,
      locator: {
        strategy: args.strategy ?? 'css',
        value: args.value ?? args.selector ?? '*',
        ...(args.exact === undefined ? {} : { exact: args.exact }),
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.index === undefined ? {} : { index: args.index }),
        ...(args.hasText === undefined ? {} : { hasText: args.hasText }),
        ...(args.hasSelector === undefined ? {} : { hasSelector: args.hasSelector }),
      },
    }),
  },
  {
    name: 'browser_dom_cua',
    description: 'Use visible DOM node ids for click, double-click, type, keypress and scroll operations.',
    parameters: {
      tabId: TAB_ID,
      action: requiredString(),
      nodeId: OPTIONAL_STRING,
      value: OPTIONAL_STRING,
      key: OPTIONAL_STRING,
      deltaX: OPTIONAL_NUMBER,
      deltaY: OPTIONAL_NUMBER,
    },
    method: 'dom_cua',
  },
  {
    name: 'browser_cua',
    description: 'Use native CDP mouse and keyboard input at viewport coordinates, including click, move, scroll, drag, type and keypress.',
    parameters: {
      tabId: TAB_ID,
      action: requiredString(),
      x: OPTIONAL_NUMBER,
      y: OPTIONAL_NUMBER,
      toX: OPTIONAL_NUMBER,
      toY: OPTIONAL_NUMBER,
      path: coordinates(),
      deltaX: OPTIONAL_NUMBER,
      deltaY: OPTIONAL_NUMBER,
      text: OPTIONAL_STRING,
      key: OPTIONAL_STRING,
      button: OPTIONAL_STRING,
    },
    method: 'cua',
  },
  {
    name: 'browser_console',
    description: 'Enable and read Runtime console and Log entries captured from a browser tab.',
    parameters: { tabId: TAB_ID, action: OPTIONAL_STRING, clear: OPTIONAL_BOOLEAN },
    method: 'console_logs',
    prepare: args => args.action === 'enable'
      ? { ...args, domains: ['Runtime', 'Log'] }
      : args,
  },
  {
    name: 'browser_network',
    description: 'Enable and read Network request/response events and response bodies from a browser tab.',
    parameters: {
      tabId: TAB_ID,
      action: OPTIONAL_STRING,
      requestId: OPTIONAL_STRING,
      clear: OPTIONAL_BOOLEAN,
    },
    method: 'network_requests',
    prepare: args => args.action === 'enable'
      ? { ...args, domains: ['Network', 'Page'] }
      : args,
  },
  {
    name: 'browser_dialog',
    description: 'Inspect and accept or dismiss alert, confirm and prompt dialogs using native CDP.',
    parameters: { tabId: TAB_ID, action: requiredString(), promptText: OPTIONAL_STRING },
    method: 'dialog',
  },
  {
    name: 'browser_upload',
    description: 'Set local files on a page file input using native CDP DOM.setFileInputFiles in trusted local mode.',
    parameters: { tabId: TAB_ID, selector: SELECTOR, nodeId: OPTIONAL_NUMBER, files: requiredFiles() },
    method: 'upload',
  },
  {
    name: 'browser_clipboard',
    description: 'Read or write plain text through the selected tab browser clipboard.',
    parameters: { tabId: TAB_ID, action: requiredString(), text: OPTIONAL_STRING },
    method: 'clipboard',
  },
  {
    name: 'browser_download',
    description: 'Start, wait for, list, cancel or erase browser downloads and return paths and status.',
    parameters: {
      action: requiredString(),
      url: OPTIONAL_STRING,
      filename: OPTIONAL_STRING,
      saveAs: OPTIONAL_BOOLEAN,
      wait: OPTIONAL_BOOLEAN,
      downloadId: OPTIONAL_NUMBER,
      limit: OPTIONAL_NUMBER,
      timeoutMs: OPTIONAL_NUMBER,
    },
    method: 'download',
  },
  {
    name: 'browser_evaluate',
    description: 'Evaluate JavaScript in the selected page using the native CDP Runtime.evaluate path.',
    parameters: { tabId: TAB_ID, expression: requiredString(), awaitPromise: OPTIONAL_BOOLEAN },
    method: 'evaluate',
  },
  {
    name: 'browser_cdp',
    description: 'Send a native Chrome DevTools Protocol command to the selected browser tab.',
    parameters: { tabId: TAB_ID, method: requiredString(), params: JSON_VALUE },
    method: 'cdp',
  },
]

/** All browser tools exposed by the package. */
export const BROWSER_TOOL_NAMES = [...CORE_TOOLS, ...ADVANCED_TOOLS].map(tool => tool.name)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue
}

function resultText(value: JsonValue): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

function renderResult(_args: unknown, value: JsonValue): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: resultText(value) }]
  if (isRecord(value) && isRecord(value.attachment)) {
    blocks.push({ type: 'image', attachment: value.attachment as unknown as ImageAttachmentRef })
  }
  return blocks
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new Error('Browser control requires an Agent-backed DSH session')
  return exec.agent
}

function requireAgentSession(exec: ToolRunContext): string {
  return String(requireAgent(exec).session.id)
}

function screenshotMediaType(value: unknown): ImageMediaType {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif') return value
  if (value === 'image/jpg') return 'image/jpeg'
  throw new Error(`Unsupported screenshot media type: ${String(value)}`)
}

async function prepareScreenshot(
  value: unknown,
  args: Record<string, JsonValue>,
  attachments: AttachmentStore | undefined,
): Promise<JsonValue> {
  if (!isRecord(value)) throw new Error('Browser screenshot returned an invalid result')
  const result = value as ScreenshotResult
  const data = result.data
  if (typeof data !== 'string' || data.length === 0) throw new Error('Browser screenshot did not return image data')
  let savedPath: string | undefined
  const path = args.path
  if (typeof path === 'string') {
    savedPath = resolvePath(path)
    await mkdir(dirname(savedPath), { recursive: true })
    await writeFile(savedPath, Buffer.from(data, 'base64'))
  }
  if (attachments === undefined) {
    return asJsonValue({ ...result, ...(savedPath === undefined ? {} : { path: savedPath }) })
  }
  const mediaType = screenshotMediaType(result.mimeType ?? 'image/png')
  const ref = await attachments.saveImage({
    data: Buffer.from(data, 'base64'),
    mediaType,
    name: `browser-screenshot.${mediaType.slice('image/'.length)}`,
  })
  const { data: _discarded, ...metadata } = result
  return asJsonValue({ ...metadata, ...(savedPath === undefined ? {} : { path: savedPath }), attachment: ref })
}

function prepareAccessibility(value: unknown): JsonValue {
  if (!isRecord(value)) return asJsonValue(value)
  return asJsonValue(value.snapshot && isRecord(value.snapshot) ? value.snapshot.accessibility ?? value : value)
}

function prepareNetwork(args: Record<string, JsonValue>): { method: string; params: Record<string, JsonValue> } {
  if (args.action === 'enable') return { method: 'devtools_enable', params: args }
  if (args.action === 'response_body') return { method: 'network_response_body', params: args }
  return { method: 'network_requests', params: args }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function bridgeErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const code = (error as Error & { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

type BrowserConnection =
  | { readonly state: 'connected'; readonly status: unknown; readonly bridgeHealth: Record<string, unknown> }
  | { readonly state: 'bridge_only'; readonly bridgeHealth: Record<string, unknown>; readonly error?: unknown }
  | { readonly state: 'bridge_offline'; readonly error: unknown }

async function readBrowserConnection(
  bridge: BrowserBridgeClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<BrowserConnection> {
  try {
    await bridge.start()
  } catch (error) {
    return { state: 'bridge_offline', error }
  }
  let bridgeHealth: Record<string, unknown>
  try {
    bridgeHealth = await bridge.health()
  } catch (error) {
    return { state: 'bridge_offline', error }
  }
  if (bridgeHealth.extensionConnected !== true) return { state: 'bridge_only', bridgeHealth }
  try {
    return {
      state: 'connected',
      status: await bridge.request('status', { sessionId }, signal),
      bridgeHealth,
    }
  } catch (error) {
    if (bridgeErrorCode(error) === 'EXTENSION_OFFLINE') return { state: 'bridge_only', bridgeHealth, error }
    throw error
  }
}

function connectionResult(connection: Exclude<BrowserConnection, { readonly state: 'connected' }>): JsonValue {
  if (connection.state === 'bridge_only') {
    return asJsonValue({
      ok: false,
      connected: false,
      state: connection.state,
      completed: false,
      nextAction: '/chrome connect',
      recommendation: 'run_chrome_connect',
      error: {
        code: 'extension_not_connected',
        message: 'Chrome/Edge extension is not connected. No browser action was sent.',
      },
      bridgeHealth: connection.bridgeHealth,
      recovery: bridgeRecovery(connection.bridgeHealth),
    })
  }
  return asJsonValue({
    ok: false,
    connected: false,
    state: connection.state,
    completed: false,
    nextAction: '/chrome connect',
    recommendation: 'check_bridge',
    error: {
      code: 'bridge_unavailable',
      message: `The local browser Bridge is unavailable. ${errorText(connection.error)} No browser action was sent.`,
    },
    recovery: unavailableBridgeRecovery(),
  })
}

async function operationDisconnectedResult(bridge: BrowserBridgeClient): Promise<JsonValue> {
  let bridgeHealth: Record<string, unknown> | undefined
  try {
    bridgeHealth = await bridge.health()
  } catch {
    // Preserve the operation uncertainty even if the Bridge also went offline.
  }
  return asJsonValue({
    ok: false,
    completed: false,
    actionState: 'unknown',
    retryable: false,
    error: {
      code: 'extension_disconnected_during_operation',
      message: 'The browser extension disconnected during the browser operation. Inspect the current page before retrying.',
    },
    ...(bridgeHealth === undefined ? {} : { bridgeHealth }),
  })
}

type BrowserOperationResponse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false }

async function requestBrowserOperation(
  bridge: BrowserBridgeClient,
  method: string,
  params: Record<string, JsonValue>,
  signal: AbortSignal,
): Promise<BrowserOperationResponse> {
  try {
    return { ok: true, value: await bridge.request(method, params, signal) }
  } catch (error) {
    if (bridgeErrorCode(error) === 'EXTENSION_OFFLINE') return { ok: false }
    throw error
  }
}

async function bridgeTargetHealth(bridge: BrowserBridgeClient, target: BrowserTarget): Promise<Record<string, unknown>> {
  const health = await bridge.health()
  if (health.browserId !== target.browserId) {
    throw new Error('Browser Bridge does not expose the active browser identity required for atomic target routing; run browser_doctor to inspect recovery availability')
  }
  return health
}

async function browserStatus(
  bridge: BrowserBridgeClient,
  tracker: BrowserTargetTracker,
  sessionId: string,
  signal: AbortSignal,
  acknowledgeBrowserId?: string,
): Promise<JsonValue> {
  const connection = await readBrowserConnection(bridge, sessionId, signal)
  if (connection.state !== 'connected') return connectionResult(connection)
  const targetStability = tracker.observe(connection.status, acknowledgeBrowserId)
  const base = isRecord(connection.status) ? connection.status : { result: connection.status }
  try {
    return asJsonValue({ ...base, state: connection.state, targetStability, bridgeHealth: await bridge.health() })
  } catch {
    return asJsonValue({ ...base, state: connection.state, targetStability, bridgeHealth: connection.bridgeHealth })
  }
}

async function browserDoctor(
  bridge: BrowserBridgeClient,
  tracker: BrowserTargetTracker,
  sessionId: string,
  signal: AbortSignal,
): Promise<JsonValue> {
  let bridgeHealth: Record<string, unknown>
  try {
    bridgeHealth = await bridge.health()
  } catch (error) {
    return asJsonValue({
      ok: false,
      state: 'bridge_offline',
      recommendation: 'check_bridge',
      issues: [{ code: 'bridge_unreachable', message: errorText(error) }],
      recovery: unavailableBridgeRecovery(),
    })
  }
  if (bridgeHealth.extensionConnected !== true) {
    return asJsonValue({
      ok: false,
      state: 'bridge_only',
      recommendation: 'enable_or_reload_extension',
      bridgeHealth,
      recovery: bridgeRecovery(bridgeHealth),
      issues: [{ code: 'extension_not_connected', message: 'The local Bridge is healthy but no browser extension is connected.' }],
    })
  }

  let status: unknown
  try {
    status = await bridge.request('status', { sessionId }, signal)
  } catch (error) {
    return asJsonValue({
      ok: false,
      recommendation: 'reconnect_extension',
      bridgeHealth,
      recovery: bridgeRecovery(bridgeHealth),
      issues: [{ code: 'browser_status_unavailable', message: errorText(error) }],
    })
  }
  const targetStability = tracker.observe(status)
  const base = isRecord(status) ? status : { status }
  const target = readBrowserTarget(status)
  let currentBridgeHealth: Record<string, unknown>
  try {
    currentBridgeHealth = await bridge.health()
  } catch (error) {
    return asJsonValue({
      ...base,
      ok: false,
      recommendation: 'check_bridge',
      bridgeHealth,
      targetStability,
      issues: [{ code: 'bridge_unreachable', message: errorText(error) }],
      recovery: unavailableBridgeRecovery(),
      notices: [],
    })
  }
  bridgeHealth = currentBridgeHealth
  const bridgeBrowserId = typeof bridgeHealth.browserId === 'string' && bridgeHealth.browserId.length > 0 ? bridgeHealth.browserId : undefined
  const issues = [] as Array<{ code: string; message: string }>
  const notices = [] as Array<{ code: string; message: string }>
  if (targetStability.issue !== undefined) {
    issues.push({ code: targetStability.issue, message: 'The browser status did not identify browser, browserId and profile. Reload the extension to update its status contract.' })
  } else if (targetStability.changed) {
    issues.push({
      code: 'browser_target_changed',
      message: `The active browser changed from ${targetStability.previousBrowser} (${targetStability.previousBrowserId}) to ${targetStability.browser} (${targetStability.browserId}).`,
    })
  } else if (bridgeBrowserId === undefined) {
    issues.push({ code: 'bridge_target_routing_unavailable', message: 'The Bridge does not expose the active browser identity required for atomic target routing; run browser_doctor and update or restart the Bridge.' })
  } else if (target !== undefined && target.browserId !== bridgeBrowserId) {
    issues.push({
      code: 'bridge_browser_target_changed',
      message: `Bridge health reports ${bridgeBrowserId}, but the status response came from ${target.browserId}.`,
    })
  }
  if (targetStability.competition === 'unknown' && issues.length === 0) {
    notices.push({ code: 'browser_competition_unverified', message: 'The active browser is healthy, but this session has not observed it twice yet.' })
  }
  const recommendation = issues.length > 0
    ? issues.some(issue => issue.code === 'bridge_target_routing_unavailable')
      ? 'restart_bridge'
      : targetStability.changed || (target !== undefined && bridgeBrowserId !== undefined && target.browserId !== bridgeBrowserId)
        ? 'disable_other_browser_extension'
        : 'refresh_browser_status'
    : notices.length > 0
      ? 'confirm_browser_target'
      : 'ready'
  return asJsonValue({
    ...base,
    state: 'connected',
    ok: issues.length === 0,
    recommendation,
    bridgeHealth,
    targetStability,
    recovery: bridgeRecovery(bridgeHealth),
    issues,
    notices,
  })
}

async function assertStableBrowserTarget(
  bridge: BrowserBridgeClient,
  tracker: BrowserTargetTracker,
  connection: Extract<BrowserConnection, { readonly state: 'connected' }>,
): Promise<BrowserTarget> {
  const target = tracker.assertStable(connection.status)
  await bridgeTargetHealth(bridge, target)
  return target
}

type BrowserActivation = {
  readonly agent: Agent
  readonly disposers: (() => void)[]
  usedBrowser: boolean
}

function inactiveBrowserError(): Error {
  return new Error(`Browser tools are inactive; load the ${BROWSER_SKILL_NAME} Skill before using browser_* tools`)
}

function isBrowserSkillArguments(value: unknown): boolean {
  return isRecord(value) && value.name === BROWSER_SKILL_NAME
}

function hasBrowserSkillInvocation(messages: readonly unknown[]): boolean {
  return messages.some(message => {
    if (!isRecord(message) || !isRecord(message.source)) return false
    return message.source.kind === 'skill-invocation' && message.source.name === BROWSER_SKILL_NAME
  })
}

/** Register browser tools globally or after the browser Skill loads in an Agent scope. */
export function registerBrowserTools(
  ctx: Context,
  bridge: BrowserBridgeClient,
  attachments: AttachmentStore | undefined,
  resolveSettings: () => ResolvedConfig,
): void {
  const trackers = new Map<string, BrowserTargetTracker>()
  const activations = new Map<string, BrowserActivation>()
  const usedSessions = new Set<string>()
  const lazyTools = resolveSettings().lazyTools
  const trackerFor = (sessionId: string): BrowserTargetTracker => {
    const existing = trackers.get(sessionId)
    if (existing !== undefined) return existing
    const created = new BrowserTargetTracker()
    trackers.set(sessionId, created)
    return created
  }
  const deactivate = (sessionId: string): void => {
    const activation = activations.get(sessionId)
    if (activation === undefined) return
    activations.delete(sessionId)
    usedSessions.delete(sessionId)
    trackers.delete(sessionId)
    for (const dispose of [...activation.disposers].reverse()) dispose()
  }
  const toolFor = (spec: BrowserToolSpec): ReturnType<typeof defineTool> => defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'json' },
      render: renderResult,
    },
    timeoutMs: resolveSettings().requestTimeoutMs,
    async execute(args: Record<string, JsonValue>, exec: ToolRunContext): Promise<JsonValue> {
      const sessionId = requireAgentSession(exec)
      const activation = lazyTools ? activations.get(sessionId) : undefined
      if (lazyTools && activation === undefined) throw inactiveBrowserError()
      let params = { ...args, sessionId } as Record<string, JsonValue>
      if (spec.prepare !== undefined) params = spec.prepare(params)
      if (spec.name === 'browser_cleanup') {
        const used = activation?.usedBrowser === true || usedSessions.has(sessionId)
        if (!used) return asJsonValue({ removed: [], released: [] })
        const result = await requestBrowserOperation(bridge, 'cleanup', params, exec.signal)
        if (!result.ok) return operationDisconnectedResult(bridge)
        return asJsonValue(result.value)
      }
      if (activation !== undefined) activation.usedBrowser = true
      else usedSessions.add(sessionId)
      const tracker = trackerFor(sessionId)
      if (spec.name === 'browser_doctor') return browserDoctor(bridge, tracker, sessionId, exec.signal)
      if (spec.name === 'browser_status') {
        const acknowledgeBrowserId = typeof args.acknowledgeBrowserId === 'string' ? args.acknowledgeBrowserId : undefined
        return browserStatus(bridge, tracker, sessionId, exec.signal, acknowledgeBrowserId)
      }
      const connection = await readBrowserConnection(bridge, sessionId, exec.signal)
      if (connection.state !== 'connected') return connectionResult(connection)
      const target = await assertStableBrowserTarget(bridge, tracker, connection)
      params = { ...params, expectedBrowserId: target.browserId }
      let method = spec.method
      if (spec.name === 'browser_accessibility_snapshot') {
        const result = await requestBrowserOperation(bridge, 'snapshot', params, exec.signal)
        if (!result.ok) return operationDisconnectedResult(bridge)
        return prepareAccessibility(result.value)
      }
      if (spec.name === 'browser_console') {
        method = params.action === 'enable' ? 'devtools_enable' : 'console_logs'
      }
      if (spec.name === 'browser_network') {
        const network = prepareNetwork(params)
        method = network.method
        params = network.params
      }
      if (spec.name === 'browser_screenshot') {
        const result = await requestBrowserOperation(bridge, method, params, exec.signal)
        if (!result.ok) return operationDisconnectedResult(bridge)
        return prepareScreenshot(result.value, params, attachments)
      }
      const result = await requestBrowserOperation(bridge, method, params, exec.signal)
      if (!result.ok) return operationDisconnectedResult(bridge)
      return asJsonValue(result.value)
    },
  })
  const registerFor = (scope: Context): (() => void)[] => {
    const disposers: (() => void)[] = []
    try {
      for (const spec of [...CORE_TOOLS, ...ADVANCED_TOOLS]) disposers.push(scope.tools.register(toolFor(spec)))
      return disposers
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
  }
  const activate = (agent: Agent): void => {
    if (!lazyTools || activations.has(String(agent.session.id))) return
    const sessionId = String(agent.session.id)
    const disposers = registerFor(agent.ctx)
    activations.set(sessionId, { agent, disposers, usedBrowser: false })
  }
  if (!lazyTools) {
    ctx.effect(() => {
      const disposers = registerFor(ctx)
      return () => { for (const dispose of disposers.reverse()) dispose() }
    }, 'control-chrome: register browser tools')
  }
  ctx.on('tools/result', (exec, result) => {
    if (exec.agent !== undefined && exec.name === 'browser_cleanup' && !result.isError) {
      const agent = exec.agent
      queueMicrotask(() => {
        const sessionId = String(agent.session.id)
        usedSessions.delete(sessionId)
        deactivate(sessionId)
      })
      return
    }
    if (!lazyTools || result.isError || exec.name !== 'skill' || exec.agent === undefined) return
    if (isBrowserSkillArguments(exec.arguments)) activate(exec.agent)
  })
  ctx.on('agent/pre-step', async (_event, next) => {
    const decision = await next()
    if (lazyTools && decision.kind === 'enter' && hasBrowserSkillInvocation(decision.messages)) {
      const agent = _event.agent
      if (agent !== undefined) activate(agent)
    }
    return decision
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = String(agent.session.id)
    const activation = activations.get(sessionId)
    const used = activation?.usedBrowser === true || usedSessions.has(sessionId)
    trackers.delete(sessionId)
    activations.delete(sessionId)
    usedSessions.delete(sessionId)
    if (used) void bridge.request('cleanup', { sessionId }).catch(() => undefined)
  })
}

/** Expose the tool catalogs for tests and package consumers. */
export const browserToolCatalog = { core: CORE_TOOLS, advanced: ADVANCED_TOOLS } as const
