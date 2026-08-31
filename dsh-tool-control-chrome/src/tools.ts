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
  type ToolExecution,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import type { BrowserBridgeClient } from './bridge.js'
import { bridgeRecovery, unavailableBridgeRecovery } from './diagnostics.js'
import { BROWSER_SKILL_NAME } from './skill.js'
import { compactBrowserResult } from './output.js'
import type { BrowserTarget, BrowserTargetRoute, ResolvedConfig, ScreenshotResult } from './types.js'

const TAB_ID: ParameterPropertySpec = { type: 'number', description: 'Browser tab id. Omit to use the selected tab.' }
const JSON_VALUE: ParameterPropertySpec = { type: 'json' }
const OPTIONAL_STRING: ParameterPropertySpec = { type: 'string' }
const OPTIONAL_NUMBER: ParameterPropertySpec = { type: 'number' }
const NETWORK_REQUEST_ID: ParameterPropertySpec = { type: 'string', description: 'Required for response_body; copy from the current Network listing.' }
const NETWORK_LOADER_ID: ParameterPropertySpec = { type: 'string', description: 'Required for response_body; copy the matching loaderId from the current Network listing.' }
const TIMEOUT_MS: ParameterPropertySpec = { type: 'number', description: 'Optional positive timeout in milliseconds.' }
const INDEX: ParameterPropertySpec = { type: 'integer', description: 'Optional zero-based non-negative element index. Omit it when not selecting a specific match; never use -1 as a sentinel.' }
const OPTIONAL_BOOLEAN: ParameterPropertySpec = { type: 'boolean' }
const WAIT_EXACT: ParameterPropertySpec = { type: 'boolean', description: 'For text/text_gone waits only. For visible/hidden/enabled waits, put exact inside target.' }
const SELECTOR: ParameterPropertySpec = { type: 'string', description: 'Optional CSS selector. Prefer a semantic target or a ref from browser_snapshot.' }
const OUTPUT_MAX_CHARS: ParameterPropertySpec = { type: 'integer', description: 'Optional output character budget. The extension caps this at 100000; the default is 20000 for snapshots and DOM CUA.' }
const OUTPUT_MAX_NODES: ParameterPropertySpec = { type: 'integer', description: 'Optional output node budget. The extension caps this at 1000; the default is 200.' }
const TAB_HANDLE_PROPERTIES: ParameterSchemaSpec = {
  tabId: { type: 'number', required: true },
  browserId: OPTIONAL_STRING,
  windowId: OPTIONAL_NUMBER,
  title: OPTIONAL_STRING,
  url: OPTIONAL_STRING,
  tabFence: OPTIONAL_STRING,
  incarnation: OPTIONAL_STRING,
  sessionId: OPTIONAL_STRING,
  groupId: OPTIONAL_NUMBER,
}
const TAB_HANDLE: ParameterPropertySpec = {
  type: 'object',
  description: 'Complete tab identity returned by browser_tabs; keep locators in target or the documented top-level fields, never inside handle.',
  properties: TAB_HANDLE_PROPERTIES,
  additionalProperties: false,
}
const WAIT_STATE: ParameterPropertySpec = {
  type: 'string',
  enum: ['load', 'url', 'text', 'text_gone', 'visible', 'hidden', 'enabled'],
  description: 'Wait condition. Defaults to load when omitted.',
}
const CLIPBOARD_ACTION: ParameterPropertySpec = { type: 'string', required: true, enum: ['read', 'write'], description: 'Clipboard operation.' }
const DOM_CUA_ACTION: ParameterPropertySpec = {
  type: 'string',
  required: true,
  enum: ['get_visible_dom', 'click', 'double_click', 'type', 'keypress', 'scroll'],
  description: 'Visible DOM operation.',
}
const ELEMENT_TARGET: ParameterPropertySpec = {
  type: 'object',
  description: 'Use exactly one primary locator: role (optionally with name), label, placeholder, text, testId, ref, or selector. Do not put target fields inside handle.',
  properties: {
    ref: OPTIONAL_STRING,
    selector: SELECTOR,
    role: OPTIONAL_STRING,
    name: OPTIONAL_STRING,
    label: OPTIONAL_STRING,
    placeholder: OPTIONAL_STRING,
    text: OPTIONAL_STRING,
    testId: OPTIONAL_STRING,
    exact: OPTIONAL_BOOLEAN,
    index: INDEX,
    scopeSelector: OPTIONAL_STRING,
    hasText: OPTIONAL_STRING,
    hasSelector: OPTIONAL_STRING,
  },
  additionalProperties: false,
}
const LEGACY_LOCATOR_PARAMETERS: ParameterSchemaSpec = {
  strategy: { type: 'string', description: 'Legacy compatibility only. Prefer one nested target and do not combine legacy fields with it.' },
  selector: { type: 'string', description: 'Legacy CSS selector compatibility only. Prefer target.selector.' },
  value: JSON_VALUE,
  exact: { type: 'boolean', description: 'Legacy compatibility only. Prefer target.exact when target is present.' },
  name: { type: 'string', description: 'Legacy role-name compatibility only. Prefer target.name with target.role.' },
  index: INDEX,
  hasText: { type: 'string', description: 'Legacy filter compatibility only. Prefer target.hasText.' },
  hasSelector: { type: 'string', description: 'Legacy filter compatibility only. Prefer target.hasSelector.' },
}
const LOCATOR_TAB_HANDLE: ParameterPropertySpec = {
  type: 'object',
  description: 'Complete tab identity returned by browser_tabs. Locator fields belong in target, not handle; misplaced legacy fields are accepted for recovery.',
  properties: {
    ...TAB_HANDLE_PROPERTIES,
    target: ELEMENT_TARGET,
    snapshotId: OPTIONAL_STRING,
    ...LEGACY_LOCATOR_PARAMETERS,
  },
  additionalProperties: false,
}
const EMPTY_PARAMETERS: ParameterSchemaSpec = {}
const TAB_INCARNATION_METHODS = new Set([
  'list_tabs', 'selected_tab', 'select_tab', 'new_tab', 'navigate', 'snapshot', 'extract', 'wait', 'back', 'forward', 'reload',
  'close_tab', 'locator', 'interaction', 'dom_cua', 'cua', 'screenshot', 'evaluate', 'cdp', 'devtools_enable',
  'devtools_disable', 'console_logs', 'network_requests', 'network_response_body', 'dialog', 'upload', 'clipboard',
  'keypress', 'scroll', 'claim_tab', 'release', 'mark_handoff', 'mark_deliverable', 'download', 'cleanup',
])
const TURN_CLEANUP_CAPABILITIES = ['turnCleanup', 'turnScopedMarks', 'retainedCleanup', 'debuggerLeaseRecovery', 'tabIncarnationFence']
const TAB_HANDLE_METHODS = new Set([
  'selected_tab', 'select_tab', 'navigate', 'snapshot', 'extract', 'wait', 'back', 'forward', 'reload', 'close_tab', 'locator',
  'interaction', 'dom_cua', 'cua', 'screenshot', 'evaluate', 'cdp', 'devtools_enable', 'devtools_disable',
  'console_logs', 'network_requests', 'network_response_body', 'dialog', 'upload', 'clipboard', 'keypress', 'scroll',
  'claim_tab', 'release', 'mark_handoff', 'mark_deliverable',
])
type TargetStability = {
  readonly stable: boolean
  readonly changed: boolean
  readonly acknowledged: boolean
  readonly requiresAcknowledgement: boolean
  readonly connectionChanged: boolean
  readonly competition: 'unknown' | 'stable_observed' | 'changed' | 'reconnected'
  readonly browser?: string
  readonly browserId?: string
  readonly profile?: string
  readonly connectionId?: string
  readonly connectionGeneration?: number
  readonly previousBrowser?: string
  readonly previousBrowserId?: string
  readonly previousConnectionId?: string
  readonly previousConnectionGeneration?: number
  readonly observedBrowserIds: readonly string[]
  readonly issue?: string
}

function readBrowserTarget(value: unknown): BrowserTarget | undefined {
  if (!isRecord(value)) return undefined
  const browser = value.browser
  const browserId = value.browserId
  const profile = value.profile
  if (typeof browser !== 'string' || browser.length === 0 || typeof browserId !== 'string' || browserId.length === 0 || typeof profile !== 'string' || profile.length === 0) return undefined
  const state = typeof value.state === 'string' && value.state.length > 0 ? value.state : undefined
  const connectionId = typeof value.connectionId === 'string' && value.connectionId.length > 0 ? value.connectionId : undefined
  const connectionGeneration = typeof value.connectionGeneration === 'number' && Number.isInteger(value.connectionGeneration) && value.connectionGeneration > 0 ? value.connectionGeneration : undefined
  return { browser, browserId, profile, ...(state === undefined ? {} : { state }), ...(connectionId === undefined ? {} : { connectionId }), ...(connectionGeneration === undefined ? {} : { connectionGeneration }) }
}

function optionalBrowserId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const browserId = value.trim()
  return browserId.length === 0 ? undefined : browserId
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
        connectionChanged: false,
        competition: 'unknown',
        observedBrowserIds: [...this.observed.keys()],
        issue: 'status_missing_browser_target',
      }
    }
    const previous = this.acknowledged
    const changed = previous !== undefined && !sameBrowserTarget(previous, target)
    const connectionChanged = previous !== undefined
      && previous.browserId === target.browserId
      && (previous.connectionId !== target.connectionId || previous.connectionGeneration !== target.connectionGeneration)
    const acknowledged = previous === undefined || (!changed && !connectionChanged) || acknowledgeBrowserId === target.browserId
    this.observed.add(target.browserId)
    if (acknowledged) this.acknowledged = target
    return {
      stable: !changed && !connectionChanged,
      changed,
      acknowledged,
      requiresAcknowledgement: (changed || connectionChanged) && !acknowledged,
      connectionChanged,
      competition: previous === undefined ? 'unknown' : changed ? 'changed' : connectionChanged ? 'reconnected' : 'stable_observed',
      browser: target.browser,
      browserId: target.browserId,
      profile: target.profile,
      ...(target.connectionId === undefined ? {} : { connectionId: target.connectionId }),
      ...(target.connectionGeneration === undefined ? {} : { connectionGeneration: target.connectionGeneration }),
      observedBrowserIds: [...this.observed.keys()],
      ...(previous === undefined ? {} : {
        previousBrowser: previous.browser,
        previousBrowserId: previous.browserId,
        ...(previous.connectionId === undefined ? {} : { previousConnectionId: previous.connectionId }),
        ...(previous.connectionGeneration === undefined ? {} : { previousConnectionGeneration: previous.connectionGeneration }),
      }),
    }
  }

  expectedBrowserId(): string | undefined {
    return this.acknowledged?.browserId
  }

  route(): BrowserTargetRoute | undefined {
    const target = this.acknowledged
    if (target === undefined) return undefined
    return { browserId: target.browserId }
  }

  fencedRoute(): BrowserTargetRoute | undefined {
    const target = this.acknowledged
    if (target === undefined) return undefined
    return {
      browserId: target.browserId,
      ...(target.connectionId === undefined ? {} : { connectionId: target.connectionId }),
      ...(target.connectionGeneration === undefined ? {} : { connectionGeneration: target.connectionGeneration }),
    }
  }

  assertStable(value: unknown): BrowserTarget {
    const observation = this.observe(value)
    if (observation.issue !== undefined) throw new Error('Browser status did not identify an active browser target; run browser_doctor')
    if (!observation.stable || !observation.acknowledged) {
      if (observation.connectionChanged) throw new Error('Browser connection changed for the selected target; run browser_status to inspect it and acknowledge the current connection before retrying')
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
      browserId: { type: 'string', description: 'Select a connected browser target by browserId. Omit or leave blank for automatic discovery; choose one explicitly when multiple targets are connected.' },
      acknowledgeBrowserId: { type: 'string', description: 'Explicitly acknowledge this browserId after the user confirms a browser switch.' },
    },
    method: 'status',
  },
  {
    name: 'browser_tabs',
    description: 'List Chrome/Edge windows, tabs, tab groups, ownership and lifecycle state. The Pi group may be shared by sessions; use owner, sessionId and sessionScope, never groupId alone, to choose a tab.',
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
    description: 'Claim an existing user tab using its tab id and optional title, URL, or windowId snapshot checks. Fails if any supplied snapshot value changed.',
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
    description: 'Create an Agent-owned tab and place it in the Pi tab group. Use windowId to target a specific window; otherwise use the current browser window. With wait=true, return a refreshed post-load handle; `active: false` avoids selecting it at creation time but cannot prevent later browser or user focus changes.',
    parameters: {
      url: { type: 'string', description: 'Initial URL. Defaults to about:blank.' },
      active: { type: 'boolean', description: 'Whether to activate the new tab at creation time; false is best effort if the browser or user later changes focus.' },
      windowId: { type: 'number', description: 'Optional target browser window id. If omitted, use the current browser window.' },
      wait: { type: 'boolean', description: 'Wait for the created tab to finish loading before returning.' },
      timeoutMs: { ...TIMEOUT_MS, description: 'Optional positive timeout for the load wait.' },
      allowRedirects: { type: 'boolean', description: 'Allow the final URL to differ from the requested URL while waiting; browser URL canonicalization is accepted even when false.' },
    },
    method: 'new_tab',
  },
  {
    name: 'browser_snapshot',
    description: 'Read the active page title and one bounded semantic page state with snapshot-scoped eN refs; ref actions require the returned snapshotId. Read-only observation may retry once if the tab document changes.',
    parameters: { tabId: TAB_ID, selector: SELECTOR, maxChars: OUTPUT_MAX_CHARS, maxNodes: OUTPUT_MAX_NODES },
    method: 'snapshot',
  },
  {
    name: 'browser_extract',
    description: 'Extract the current page as bounded plain text and simple Markdown without using a separate web scraper. Read-only observation may retry once if the tab document changes.',
    parameters: { tabId: TAB_ID, selector: SELECTOR, maxChars: OUTPUT_MAX_CHARS },
    method: 'extract',
  },
  {
    name: 'browser_accessibility_snapshot',
    description: 'Return the accessibility-oriented semantic tree as bounded full or incremental text; the first read is full and later reads may be diff or unchanged.',
    parameters: { tabId: TAB_ID, selector: SELECTOR, maxChars: OUTPUT_MAX_CHARS, maxNodes: OUTPUT_MAX_NODES, disableDiffing: OPTIONAL_BOOLEAN },
    method: 'snapshot',
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a selected or specified browser tab to a URL and optionally wait for loading to complete.',
    parameters: {
      tabId: TAB_ID,
      url: requiredString('Destination URL.'),
      wait: OPTIONAL_BOOLEAN,
      timeoutMs: TIMEOUT_MS,
      allowRedirects: OPTIONAL_BOOLEAN,
    },
    method: 'navigate',
  },
  {
    name: 'browser_wait',
    description: 'Wait for a selected browser tab to load, reach a URL, show or hide text, or reach an element state. For text states use text; for element states use target. Keep tab identity in handle and locator fields in target.',
    parameters: {
      tabId: TAB_ID,
      state: WAIT_STATE,
      url: OPTIONAL_STRING,
      urlIncludes: OPTIONAL_STRING,
      text: OPTIONAL_STRING,
      target: ELEMENT_TARGET,
      snapshotId: OPTIONAL_STRING,
      exact: WAIT_EXACT,
      timeoutMs: TIMEOUT_MS,
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
    description: 'Click one visible element by semantic target, a snapshot-scoped eN ref with snapshotId, or CSS selector.',
    parameters: { tabId: TAB_ID, snapshotId: OPTIONAL_STRING, ref: OPTIONAL_STRING, selector: SELECTOR, target: ELEMENT_TARGET, timeoutMs: TIMEOUT_MS },
    method: 'interaction',
    prepare: args => ({ ...args, operation: 'click' }),
  },
  {
    name: 'browser_double_click',
    description: 'Double-click one visible element by semantic target, a snapshot-scoped eN ref with snapshotId, or CSS selector.',
    parameters: { tabId: TAB_ID, snapshotId: OPTIONAL_STRING, ref: OPTIONAL_STRING, selector: SELECTOR, target: ELEMENT_TARGET, timeoutMs: TIMEOUT_MS },
    method: 'interaction',
    prepare: args => ({ ...args, operation: 'double_click' }),
  },
  {
    name: 'browser_fill',
    description: 'Fill one input, textarea, or contenteditable element by semantic target, a snapshot-scoped eN ref with snapshotId, or CSS selector.',
    parameters: {
      tabId: TAB_ID,
      snapshotId: OPTIONAL_STRING,
      ref: OPTIONAL_STRING,
      selector: SELECTOR,
      target: ELEMENT_TARGET,
      value: requiredString('Replacement text.'),
      timeoutMs: TIMEOUT_MS,
    },
    method: 'interaction',
    prepare: args => ({ ...args, operation: 'fill' }),
  },
  {
    name: 'browser_type',
    description: 'Type or append text into one focused field selected by semantic target, a snapshot-scoped eN ref with snapshotId, or CSS selector.',
    parameters: {
      tabId: TAB_ID,
      snapshotId: OPTIONAL_STRING,
      ref: OPTIONAL_STRING,
      selector: SELECTOR,
      target: ELEMENT_TARGET,
      value: requiredString('Text to type.'),
      timeoutMs: TIMEOUT_MS,
    },
    method: 'interaction',
    prepare: args => ({ ...args, operation: 'type' }),
  },
  {
    name: 'browser_press_key',
    description: 'Dispatch a keyboard key to one element selected by semantic target, a snapshot-scoped eN ref with snapshotId, or CSS selector.',
    parameters: {
      tabId: TAB_ID,
      snapshotId: OPTIONAL_STRING,
      ref: OPTIONAL_STRING,
      selector: SELECTOR,
      target: ELEMENT_TARGET,
      key: requiredString('Key name or character.'),
      timeoutMs: TIMEOUT_MS,
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
    description: 'Mark an Agent-owned tab to survive the current turn cleanup for manual user handoff; repeat the mark in a later turn.',
    parameters: { tabId: requiredNumber() },
    method: 'mark_handoff',
  },
  {
    name: 'browser_mark_deliverable',
    description: 'Mark an Agent-owned tab to survive the current turn cleanup as a user-facing deliverable; repeat the mark in a later turn.',
    parameters: { tabId: requiredNumber() },
    method: 'mark_deliverable',
  },
  {
    name: 'browser_cleanup',
    description: 'Only after the user explicitly asks for browser cleanup: close allowed Agent tabs, release claims, and optionally forget stale-runtime ownership without closing unknown tabs while keeping browser tools and the Bridge active.',
    parameters: { recoverStale: OPTIONAL_BOOLEAN },
    method: 'cleanup',
  },
  {
    name: 'browser_context_reset',
    description: 'Only after the user explicitly asks to reset or clear browser context: finalize resources and deactivate lazy browser tools without stopping the shared Bridge.',
    parameters: EMPTY_PARAMETERS,
    method: 'context_reset',
  },
]

const ADVANCED_TOOLS: readonly BrowserToolSpec[] = [
  {
    name: 'browser_locator',
    description: 'Use locator operations with one target object (role/name, label, placeholder, text, testId, ref, or CSS selector); keep tab identity in handle and never put locator fields there. Legacy top-level locator fields remain accepted.',
    parameters: {
      tabId: TAB_ID,
      action: requiredString('Locator action such as count, click, fill, text or attribute.'),
      target: ELEMENT_TARGET,
      snapshotId: OPTIONAL_STRING,
      ...LEGACY_LOCATOR_PARAMETERS,
      other: JSON_VALUE,
      attribute: OPTIONAL_STRING,
      key: OPTIONAL_STRING,
      timeoutMs: TIMEOUT_MS,
    },
    method: 'locator',
    prepare: args => ({
      ...args,
      locator: args.target ?? {
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
    description: 'Use visible DOM node ids from the latest browser_dom_cua snapshot; any supplied nodeId requires its matching snapshotId for click, double-click, type, keypress and scroll operations.',
    parameters: {
      tabId: TAB_ID,
      action: DOM_CUA_ACTION,
      snapshotId: OPTIONAL_STRING,
      nodeId: OPTIONAL_STRING,
      selector: SELECTOR,
      maxChars: OUTPUT_MAX_CHARS,
      maxNodes: OUTPUT_MAX_NODES,
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
      requestId: NETWORK_REQUEST_ID,
      loaderId: NETWORK_LOADER_ID,
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
    parameters: { tabId: TAB_ID, selector: SELECTOR, nodeId: OPTIONAL_NUMBER, incarnation: OPTIONAL_STRING, files: requiredFiles() },
    method: 'upload',
  },
  {
    name: 'browser_clipboard',
    description: 'Read or write plain text through the selected tab browser clipboard.',
    parameters: { tabId: TAB_ID, action: CLIPBOARD_ACTION, text: OPTIONAL_STRING },
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
      timeoutMs: TIMEOUT_MS,
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

const TAB_HANDLE_KEYS = new Set([
  'tabId', 'browserId', 'windowId', 'title', 'url', 'tabFence', 'incarnation', 'sessionId', 'groupId',
])
const TAB_HANDLE_OPTIONAL_STRING_KEYS = new Set(['browserId', 'title', 'url', 'tabFence', 'incarnation', 'sessionId'])
const ELEMENT_TARGET_OPTIONAL_STRING_KEYS = new Set([
  'ref', 'selector', 'role', 'name', 'label', 'placeholder', 'text', 'testId', 'scopeSelector', 'hasText', 'hasSelector',
])
const ELEMENT_TARGET_PRIMARY_KEYS = ['ref', 'selector', 'role', 'label', 'placeholder', 'text', 'testId'] as const
const LOCATOR_LEGACY_KEYS = ['strategy', 'selector', 'exact', 'name', 'index', 'hasText', 'hasSelector', 'value'] as const
const SEMANTIC_INTERACTION_TOOLS = new Set(['browser_click', 'browser_double_click', 'browser_fill', 'browser_type', 'browser_press_key'])

function isBlankString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length === 0
}

function normalizeTabHandle(value: unknown): unknown {
  if (!isRecord(value)) return value
  const normalized: Record<string, JsonValue> = {}
  for (const key of TAB_HANDLE_KEYS) {
    if (!Object.hasOwn(value, key)) continue
    const entry = value[key]
    if (TAB_HANDLE_OPTIONAL_STRING_KEYS.has(key) && isBlankString(entry)) continue
    normalized[key] = entry as JsonValue
  }
  return normalized
}

function normalizeElementTarget(value: unknown, dropEmpty = false): unknown {
  if (!isRecord(value)) return value
  const normalized: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (ELEMENT_TARGET_OPTIONAL_STRING_KEYS.has(key) && isBlankString(entry)) continue
    if (key === 'index' && entry === -1) continue
    normalized[key] = entry as JsonValue
  }
  if (dropEmpty && ELEMENT_TARGET_PRIMARY_KEYS.every(key => normalized[key] === undefined)) {
    const hasMeaningfulNarrowing = Object.keys(normalized).some(key => !['exact', 'index'].includes(key))
    const hasExplicitMatchOption = normalized.exact === true || (normalized.index !== undefined && normalized.index !== 0)
    if (!hasMeaningfulNarrowing && !hasExplicitMatchOption) return undefined
  }
  return normalized
}

function deleteBlankFields(params: Record<string, JsonValue>, keys: readonly string[]): void {
  for (const key of keys) if (isBlankString(params[key])) delete params[key]
}

function primaryTargetKey(target: Record<string, unknown>): string | undefined {
  return ELEMENT_TARGET_PRIMARY_KEYS.find(key => target[key] !== undefined)
}

function mergeLegacyLocatorFields(target: Record<string, JsonValue>, params: Record<string, JsonValue>): void {
  const primary = primaryTargetKey(target)
  const strategy = typeof params.strategy === 'string' && !isBlankString(params.strategy) ? params.strategy.toLowerCase() : undefined
  const strategyKey = strategy === 'css' ? 'selector'
    : strategy === 'role' ? 'role'
      : strategy === 'text' ? 'text'
        : strategy === 'label' ? 'label'
          : strategy === 'placeholder' ? 'placeholder'
            : strategy === 'testid' ? 'testId'
              : undefined
  if (strategyKey !== undefined && primary !== undefined && primary !== strategyKey) throw new Error('locator target conflicts with legacy locator strategy')
  if (strategyKey !== undefined && target[strategyKey] === undefined && params.value !== undefined) target[strategyKey] = params.value
  if (strategyKey === 'role' && params.name !== undefined && target.name === undefined) target.name = params.name
  for (const key of ['exact', 'index', 'hasText', 'hasSelector'] as const) {
    if (params[key] === undefined) continue
    if (target[key] !== undefined && target[key] !== params[key]) throw new Error(`locator target conflicts with legacy ${key}`)
    if (target[key] === undefined) target[key] = params[key]
  }
  if (params.selector !== undefined) {
    if (target.selector !== undefined && target.selector !== params.selector) throw new Error('locator target conflicts with legacy selector')
    if (primary !== undefined && primary !== 'selector') throw new Error('locator target conflicts with legacy selector')
    if (target.selector === undefined) target.selector = params.selector
  }
  if (params.name !== undefined) {
    if (target.name !== undefined && target.name !== params.name) throw new Error('locator target conflicts with legacy name')
    if (primary !== undefined && primary !== 'role') throw new Error('locator target name narrowing requires role')
    if (target.name === undefined) target.name = params.name
  }
}

function absorbLocatorHandle(params: Record<string, JsonValue>): void {
  const handle = isRecord(params.handle) ? params.handle : undefined
  if (handle === undefined) return
  for (const key of ['snapshotId', ...LOCATOR_LEGACY_KEYS] as const) {
    const entry = handle[key]
    if (entry === undefined) continue
    if (params[key] === undefined || isBlankString(params[key])) params[key] = entry as JsonValue
  }
  const handleTarget = normalizeElementTarget(handle.target)
  if (params.target === undefined && handleTarget !== undefined) params.target = handleTarget as JsonValue
  params.handle = normalizeTabHandle(handle) as JsonValue
}

function normalizeLocatorParams(params: Record<string, JsonValue>): void {
  absorbLocatorHandle(params)
  if (params.index === -1) delete params.index
  deleteBlankFields(params, ['snapshotId', 'strategy', 'selector', 'name', 'hasText', 'hasSelector'])
  if (params.target !== undefined) {
    const target = normalizeElementTarget(params.target)
    if (target !== undefined && isRecord(target)) {
      mergeLegacyLocatorFields(target as Record<string, JsonValue>, params)
      params.target = target as JsonValue
      for (const key of LOCATOR_LEGACY_KEYS) {
        if (key === 'value' && params.strategy === undefined) continue
        delete params[key]
      }
    } else {
      delete params.target
    }
  }
}

function normalizeWaitParams(params: Record<string, JsonValue>): void {
  deleteBlankFields(params, ['snapshotId', 'url', 'urlIncludes', 'text'])
  if (params.target !== undefined) {
    const target = normalizeElementTarget(params.target, true)
    if (target === undefined) delete params.target
    else params.target = target as JsonValue
  }
  const state = params.state === undefined ? 'load' : String(params.state)
  if (['visible', 'hidden', 'enabled'].includes(state) && params.target !== undefined && params.exact !== undefined) {
    const target = params.target
    if (isRecord(target)) {
      if (target.exact === undefined) target.exact = params.exact
      delete params.exact
    }
  }
}

function normalizeBrowserToolArgs(name: string, raw: Record<string, JsonValue>): Record<string, JsonValue> {
  const params = { ...raw }
  deleteBlankFields(params, ['snapshotId', 'incarnation', 'selector'])
  if (name === 'browser_screenshot') deleteBlankFields(params, ['path'])
  if (SEMANTIC_INTERACTION_TOOLS.has(name)) {
    deleteBlankFields(params, ['ref', 'selector'])
    if (params.target !== undefined) {
      const target = normalizeElementTarget(params.target, true)
      if (target === undefined) delete params.target
      else params.target = target as JsonValue
    }
  }
  if (params.handle !== undefined && name !== 'browser_locator') params.handle = normalizeTabHandle(params.handle) as JsonValue
  if (name === 'browser_locator') normalizeLocatorParams(params)
  if (name === 'browser_wait') normalizeWaitParams(params)
  return params
}

function validateElementIndex(value: unknown): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) throw new Error('Element target index must be a non-negative integer')
}

function validateElementTargetNumbers(value: unknown): void {
  if (!isRecord(value)) return
  validateElementIndex(value.index)
}

function validateOutputLimit(value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1)) throw new Error(`${name} must be a positive integer`)
}

function validateRequestNumbers(params: Record<string, JsonValue>): void {
  const timeoutMs = params.timeoutMs
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 1)) throw new Error('timeoutMs must be a positive finite number')
  validateElementIndex(params.index)
  validateElementTargetNumbers(params.target)
  validateOutputLimit(params.maxChars, 'maxChars')
  validateOutputLimit(params.maxNodes, 'maxNodes')
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue
}

function resultText(value: JsonValue): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? String(value)
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
    const { data: _discarded, ...metadata } = result
    return asJsonValue({ ...metadata, ...(savedPath === undefined ? {} : { path: savedPath }), attachmentUnavailable: true })
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

function prepareAccessibility(value: unknown, params: Record<string, JsonValue> = {}): JsonValue {
  return compactBrowserResult('browser_accessibility_snapshot', params, value)
}

function prepareNetwork(args: Record<string, JsonValue>): { method: string; params: Record<string, JsonValue> } {
  if (args.action === 'enable') return { method: 'devtools_enable', params: args }
  if (args.action === 'response_body') {
    if (typeof args.requestId !== 'string' || args.requestId.length === 0) throw new Error('browser_network response_body requires requestId from the current Network listing')
    if (typeof args.loaderId !== 'string' || args.loaderId.length === 0) throw new Error('browser_network response_body requires loaderId from the current Network listing')
    return { method: 'network_response_body', params: args }
  }
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

function targetRecords(value: unknown): BrowserTarget[] {
  if (!isRecord(value) || !Array.isArray(value.targets)) return []
  return value.targets
    .map(readBrowserTarget)
    .filter((target): target is BrowserTarget => target !== undefined)
}

function readyTargetRecords(value: unknown): BrowserTarget[] {
  return targetRecords(value).filter(target => target.state === undefined || target.state === 'ready')
}

function compactBridgeHealth(value: Record<string, unknown>): JsonValue {
  const fields = [
    'ok', 'protocol', 'service', 'bridgeVersion', 'instanceId', 'startedBy', 'controlDomain', 'port',
    'extensionConnected', 'targetCount', 'readyTargetCount', 'targetAmbiguous', 'browser', 'browserId',
    'profile', 'extensionVersion', 'connectionId', 'connectionGeneration', 'state',
  ] as const
  const result: Record<string, unknown> = {}
  for (const field of fields) if (value[field] !== undefined) result[field] = value[field]
  if (isRecord(value.capabilities) && value.capabilities.compactResponses === true) result.capabilities = { compactResponses: true }
  if (Array.isArray(value.targets)) {
    result.targets = value.targets.filter(isRecord).map(target => {
      const compact: Record<string, unknown> = {}
      for (const field of ['browser', 'browserId', 'profile', 'extensionVersion', 'connectionId', 'connectionGeneration', 'state'] as const) {
        if (target[field] !== undefined) compact[field] = target[field]
      }
      return compact
    })
  }
  if (isRecord(value.observability)) {
    const observability: Record<string, unknown> = {}
    for (const field of ['pendingRequests', 'drainingRequests'] as const) {
      if (value.observability[field] !== undefined) observability[field] = value.observability[field]
    }
    if (isRecord(value.observability.metrics)) observability.metrics = value.observability.metrics
    if (Object.keys(observability).length > 0) result.observability = observability
  }
  return asJsonValue(result)
}

function requestWithTarget(
  bridge: BrowserBridgeClient,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  target?: BrowserTargetRoute,
): Promise<unknown> {
  if (target !== undefined) return bridge.request(method, params, signal, target)
  return signal === undefined ? bridge.request(method, params) : bridge.request(method, params, signal)
}

const EXTENSION_READY_INTERVAL_MS = 150

async function waitForExtension(
  bridge: BrowserBridgeClient,
  initialHealth: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let health = initialHealth
  const attempts = Math.ceil(timeoutMs / EXTENSION_READY_INTERVAL_MS)
  for (let attempt = 0; health.extensionConnected !== true && attempt < attempts; attempt += 1) {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error('Waiting for the browser extension was cancelled.'))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, EXTENSION_READY_INTERVAL_MS)
      signal.addEventListener('abort', onAbort, { once: true })
      timer.unref?.()
    })
    health = await bridge.health()
  }
  return health
}

type BrowserConnection =
  | { readonly state: 'connected'; readonly status: unknown; readonly bridgeHealth: Record<string, unknown> }
  | { readonly state: 'target_required'; readonly bridgeHealth: Record<string, unknown>; readonly targets: readonly BrowserTarget[] }
  | { readonly state: 'target_unavailable'; readonly bridgeHealth: Record<string, unknown>; readonly targets: readonly BrowserTarget[]; readonly target?: BrowserTargetRoute }
  | { readonly state: 'bridge_only'; readonly bridgeHealth: Record<string, unknown>; readonly error?: unknown }
  | { readonly state: 'bridge_offline'; readonly error: unknown }

async function readBrowserConnection(
  bridge: BrowserBridgeClient,
  sessionId: string,
  signal: AbortSignal,
  extensionReadyTimeoutMs: number,
  target?: BrowserTargetRoute,
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
  try {
    bridgeHealth = await waitForExtension(bridge, bridgeHealth, signal, extensionReadyTimeoutMs)
  } catch (error) {
    if (signal.aborted) throw error
    return { state: 'bridge_offline', error }
  }
  if (bridgeHealth.extensionConnected !== true) return { state: 'bridge_only', bridgeHealth }
  try {
    return {
      state: 'connected',
      status: await requestWithTarget(bridge, 'status', { sessionId }, signal, target),
      bridgeHealth,
    }
  } catch (error) {
    if (bridgeErrorCode(error) === 'TARGET_REQUIRED') {
      return { state: 'target_required', bridgeHealth, targets: readyTargetRecords(bridgeHealth) }
    }
    if (bridgeErrorCode(error) === 'TARGET_UNAVAILABLE') return { state: 'target_unavailable', bridgeHealth, targets: targetRecords(bridgeHealth), ...(target === undefined ? {} : { target }) }
    if (bridgeErrorCode(error) === 'EXTENSION_OFFLINE') return { state: 'bridge_only', bridgeHealth, error }
    throw error
  }
}

function connectionResult(connection: Exclude<BrowserConnection, { readonly state: 'connected' }>): JsonValue {
  if (connection.state === 'target_unavailable') {
    return asJsonValue({
      ok: false,
      connected: false,
      state: connection.state,
      targetRequired: false,
      completed: false,
      retryable: true,
      nextAction: 'browser_status',
      recommendation: 'refresh_browser_targets',
      error: {
        code: 'TARGET_UNAVAILABLE',
        message: 'The selected browser target is disconnected or being replaced; refresh browser_status before retrying.',
      },
      ...(connection.target === undefined ? {} : { target: connection.target }),
      targets: connection.targets,
      bridgeHealth: compactBridgeHealth(connection.bridgeHealth),
      recovery: bridgeRecovery(connection.bridgeHealth),
    })
  }
  if (connection.state === 'target_required') {
    return asJsonValue({
      ok: false,
      connected: false,
      state: connection.state,
      targetRequired: true,
      completed: false,
      retryable: true,
      nextAction: 'browser_status',
      recommendation: 'select_browser_target',
      error: {
        code: 'TARGET_REQUIRED',
        message: 'Multiple browser targets are connected; call browser_status with browserId to select one.',
      },
      targets: connection.targets,
      bridgeHealth: compactBridgeHealth(connection.bridgeHealth),
      recovery: bridgeRecovery(connection.bridgeHealth),
    })
  }
  if (connection.state === 'bridge_only') {
    return asJsonValue({
      ok: false,
      connected: false,
      state: connection.state,
      completed: false,
      retryable: true,
      userActionRequired: false,
      nextAction: 'browser_status',
      recommendation: 'retry_browser_status',
      error: {
        code: 'extension_not_connected',
        message: 'The browser extension is still reconnecting after the automatic wait. No browser action was sent; retry browser_status before asking the user to connect it.',
      },
      bridgeHealth: compactBridgeHealth(connection.bridgeHealth),
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

async function operationDisconnectedResult(
  bridge: BrowserBridgeClient,
  code: 'EXTENSION_OFFLINE' | 'TARGET_UNAVAILABLE' | 'TARGET_CONNECTION_CHANGED' | 'BROWSER_OPERATION_UNCERTAIN' | 'BROWSER_TARGET_MISMATCH' | 'BROWSER_PAGE_UNAVAILABLE' | 'BROWSER_PAGE_CHANGING' | 'BROWSER_WAIT_TIMEOUT' | 'BROWSER_SELECTOR_NOT_FOUND' | 'BROWSER_SELECTOR_INVALID' | 'BROWSER_SCRIPT_ERROR' = 'EXTENSION_OFFLINE',
  details?: JsonValue,
): Promise<JsonValue> {
  if (code === 'BROWSER_SELECTOR_NOT_FOUND' || code === 'BROWSER_SELECTOR_INVALID' || code === 'BROWSER_SCRIPT_ERROR') return asJsonValue({
    ok: false,
    completed: false,
    actionState: 'not_completed',
    retryable: false,
    inspectFirst: false,
    nextAction: 'browser_snapshot',
    recommendation: code === 'BROWSER_SELECTOR_NOT_FOUND' ? 'refresh_selector_target' : code === 'BROWSER_SELECTOR_INVALID' ? 'fix_selector' : 'inspect_page_script_error',
    error: {
      code,
      message: code === 'BROWSER_SELECTOR_NOT_FOUND'
        ? 'The requested page selector did not match an element. Run browser_snapshot without selector or choose a selector present on the current page.'
        : code === 'BROWSER_SELECTOR_INVALID'
          ? 'The requested page selector is invalid. Use a valid CSS selector, then run browser_snapshot again.'
          : 'The page script failed before producing a result. Inspect the current page before retrying.',
      ...(details === undefined ? {} : { details }),
    },
  })
  if (code === 'BROWSER_PAGE_CHANGING') return asJsonValue({
    ok: false,
    completed: false,
    actionState: 'not_completed',
    retryable: true,
    inspectFirst: false,
    nextAction: 'browser_tabs',
    recommendation: 'retry_read_on_current_tab',
    error: {
      code,
      message: 'The tab document changed during a read. Refresh browser_tabs and retry the read; no page side effect was sent.',
      ...(details === undefined ? {} : { details }),
    },
  })
  if (code === 'BROWSER_WAIT_TIMEOUT') return asJsonValue({
    ok: false,
    completed: false,
    actionState: 'not_completed',
    retryable: true,
    inspectFirst: true,
    nextAction: 'browser_snapshot',
    recommendation: 'inspect_wait_target',
    error: {
      code,
      message: 'The wait condition did not become true before the timeout. Inspect the current page or narrow the target before retrying.',
      ...(details === undefined ? {} : { details }),
    },
  })
  let bridgeHealth: Record<string, unknown> | undefined
  try {
    bridgeHealth = await bridge.health()
  } catch {
    // Preserve the operation uncertainty even if the Bridge also went offline.
  }
  const targetLoss = code === 'TARGET_UNAVAILABLE' || code === 'TARGET_CONNECTION_CHANGED'
  const targetMismatch = code === 'BROWSER_TARGET_MISMATCH'
  const pageUnavailable = code === 'BROWSER_PAGE_UNAVAILABLE'
  const uncertain = code === 'BROWSER_OPERATION_UNCERTAIN'
  return asJsonValue({
    ok: false,
    completed: false,
    actionState: 'unknown',
    retryable: false,
    inspectFirst: true,
    ...(targetLoss || targetMismatch ? { nextAction: 'browser_status', recommendation: targetMismatch ? 'refresh_browser_target_handle' : 'refresh_browser_targets' } : pageUnavailable ? { nextAction: 'browser_tabs', recommendation: 'navigate_to_scriptable_page' } : uncertain ? { nextAction: 'browser_snapshot', recommendation: 'inspect_before_retry' } : {}),
    error: {
      code: uncertain || targetLoss || targetMismatch || pageUnavailable ? code : 'extension_disconnected_during_operation',
      message: uncertain
        ? 'The browser operation may have taken effect before the Bridge request ended. Inspect the current browser state before retrying; do not replay side effects automatically.'
        : targetLoss
          ? 'The selected browser target is unavailable or its connection changed during the browser operation. Run browser_status, then refresh the tab state before retrying.'
          : targetMismatch
            ? 'The tab handle belongs to a different browser target. Run browser_status, then browser_tabs and use a handle from the selected target; the request was not sent to that tab.'
            : pageUnavailable
              ? 'The selected tab is a browser error page or restricted page and cannot be scripted. Navigate it to a scriptable page, then run browser_tabs before retrying.'
              : 'The browser extension disconnected during the browser operation. Inspect the current page before retrying.',
      ...(details === undefined ? {} : { details }),
    },
    ...(bridgeHealth === undefined ? {} : { bridgeHealth: compactBridgeHealth(bridgeHealth), recovery: bridgeRecovery(bridgeHealth) }),
  })
}

type BrowserOperationResponse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: 'EXTENSION_OFFLINE' | 'TARGET_UNAVAILABLE' | 'TARGET_CONNECTION_CHANGED' | 'BROWSER_OPERATION_UNCERTAIN' | 'BROWSER_TARGET_MISMATCH' | 'BROWSER_PAGE_UNAVAILABLE' | 'BROWSER_PAGE_CHANGING' | 'BROWSER_WAIT_TIMEOUT' | 'BROWSER_SELECTOR_NOT_FOUND' | 'BROWSER_SELECTOR_INVALID' | 'BROWSER_SCRIPT_ERROR'; readonly details?: JsonValue }

function isTargetLocator(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.combine === 'and' || value.combine === 'or') return isTargetLocator(value.left) || isTargetLocator(value.right)
  if (value.strategy !== undefined) return false
  return ['ref', 'selector', 'role', 'label', 'placeholder', 'text', 'testId'].some(key => value[key] !== undefined)
}

function validateWaitRequest(params: Record<string, JsonValue>): void {
  const state = params.state === undefined ? 'load' : String(params.state)
  if (!['load', 'url', 'text', 'text_gone', 'visible', 'hidden', 'enabled'].includes(state)) throw new Error(`Unsupported browser wait state: ${state}`)
  const hasText = params.text !== undefined
  const hasTarget = params.target !== undefined
  if (state === 'text' || state === 'text_gone') {
    if (hasTarget) throw new Error(`${state} wait cannot combine text with target`)
    if (typeof params.text !== 'string' || !params.text.trim()) throw new Error(`${state} wait requires text`)
  } else if (['visible', 'hidden', 'enabled'].includes(state)) {
    if (params.exact !== undefined) throw new Error(`${state} wait exact matching belongs inside target`)
    if (hasText) throw new Error(`${state} wait cannot combine target with text`)
    if (!hasTarget) throw new Error(`${state} wait requires target`)
  } else if (state === 'url') {
    if (hasText || hasTarget) throw new Error('url wait cannot combine URL matching with text or target')
    if ((typeof params.url !== 'string' || !params.url) && (typeof params.urlIncludes !== 'string' || !params.urlIncludes)) throw new Error('url wait requires url or urlIncludes')
  } else if (hasText || hasTarget) {
    throw new Error('load wait cannot combine load matching with text or target')
  }
}

function validateLocatorRequest(params: Record<string, JsonValue>): void {
  if (params.target === undefined) return
  if (['strategy', 'selector', 'exact', 'name', 'index', 'hasText', 'hasSelector'].some(key => params[key] !== undefined)) throw new Error('locator target cannot be combined with legacy locator fields')
}

function compactResponseParams(toolName: string, params: Record<string, JsonValue>, health: Record<string, unknown>): Record<string, JsonValue> {
  const supported = ['browser_snapshot', 'browser_accessibility_snapshot', 'browser_extract', 'browser_tabs', 'browser_selected'].includes(toolName)
    || (toolName === 'browser_dom_cua' && params.action === 'get_visible_dom')
  if (!supported || params.responseMode !== undefined) return params
  if (!isRecord(health.capabilities) || health.capabilities.compactResponses !== true) return params
  return { ...params, responseMode: 'compact' }
}

function assertBridgeRequestCapabilities(method: string, params: Record<string, JsonValue>, health: Record<string, unknown>, status?: unknown): void {
  const bridgeCapabilities = isRecord(health.capabilities) ? health.capabilities : {}
  const extensionCapabilities = isRecord(status) && isRecord(status.capabilities) ? status.capabilities : {}
  const requiredBridge: string[] = []
  const requiredExtension: string[] = []
  if (params.responseMode === 'compact') requiredBridge.push('compactResponses')
  const requireTargetSupport = () => {
    requiredBridge.push('semanticTargetRequests')
    requiredExtension.push('semanticTargets')
  }
  if (method === 'interaction' && params.target !== undefined) requireTargetSupport()
  if (method === 'locator' && (params.target !== undefined || isTargetLocator(params.locator))) requireTargetSupport()
  if (method === 'wait') {
    const state = String(params.state ?? 'load')
    if (params.target !== undefined) requireTargetSupport()
    if (['text', 'text_gone', 'visible', 'hidden', 'enabled'].includes(state)) {
      requiredBridge.push('pageWaitStates')
      requiredExtension.push('pageWaitStates')
    }
  }
  if (TAB_INCARNATION_METHODS.has(method)) requiredExtension.push('tabIncarnationFence')
  if (['interaction', 'locator', 'wait'].includes(method) && params.snapshotId !== undefined) requiredExtension.push('snapshotRefs')
  const missing = [
    ...requiredBridge.filter(name => bridgeCapabilities[name] !== true),
    ...requiredExtension.filter(name => extensionCapabilities[name] !== true),
  ]
  if (missing.length > 0) throw new Error(`The browser Bridge or extension does not support: ${[...new Set(missing)].join(', ')}; update pi-control-chrome before sending this request.`)
}

async function requestBrowserOperation(
  bridge: BrowserBridgeClient,
  method: string,
  params: Record<string, JsonValue>,
  signal: AbortSignal,
  target?: BrowserTargetRoute,
): Promise<BrowserOperationResponse> {
  try {
    return { ok: true, value: await requestWithTarget(bridge, method, params, signal, target) }
  } catch (error) {
    const code = bridgeErrorCode(error)
    if (code === 'EXTENSION_OFFLINE' || code === 'TARGET_UNAVAILABLE' || code === 'TARGET_CONNECTION_CHANGED' || code === 'BROWSER_OPERATION_UNCERTAIN' || code === 'BROWSER_TARGET_MISMATCH' || code === 'BROWSER_PAGE_UNAVAILABLE' || code === 'BROWSER_PAGE_CHANGING' || code === 'BROWSER_WAIT_TIMEOUT' || code === 'BROWSER_SELECTOR_NOT_FOUND' || code === 'BROWSER_SELECTOR_INVALID' || code === 'BROWSER_SCRIPT_ERROR') {
      const details = error && typeof error === 'object' && 'details' in error ? (error as { readonly details?: unknown }).details : undefined
      return { ok: false, code, ...(details === undefined ? {} : { details: asJsonValue(details) }) }
    }
    throw error
  }
}

async function bridgeTargetHealth(bridge: BrowserBridgeClient, target: BrowserTarget): Promise<Record<string, unknown>> {
  const health = await bridge.health()
  const healthBrowserId = typeof health.browserId === 'string' ? health.browserId : undefined
  const targets = readyTargetRecords(health)
  if (healthBrowserId !== target.browserId && !targets.some(candidate => candidate.browserId === target.browserId)) {
    throw new Error('Browser Bridge does not expose the selected browser identity required for atomic target routing; run browser_doctor to inspect recovery availability')
  }
  return health
}

function statusCanArmCleanup(value: JsonValue): boolean {
  return isRecord(value) && value.state === 'connected' && typeof value.browserId === 'string' && value.browserId.length > 0
}

async function browserStatus(
  bridge: BrowserBridgeClient,
  tracker: BrowserTargetTracker,
  sessionId: string,
  signal: AbortSignal,
  extensionReadyTimeoutMs: number,
  acknowledgeBrowserId?: string,
  requestedBrowserId?: string,
  requiresTargetCleanup = false,
): Promise<JsonValue> {
  const routeBrowserId = requestedBrowserId ?? acknowledgeBrowserId
  const selectionBrowserId = requestedBrowserId ?? acknowledgeBrowserId
  const route = routeBrowserId === undefined ? tracker.route() : { browserId: routeBrowserId }
  const connection = await readBrowserConnection(bridge, sessionId, signal, extensionReadyTimeoutMs, route)
  if (connection.state !== 'connected') return connectionResult(connection)
  const preview = tracker.observe(connection.status)
  const previewTarget = readBrowserTarget(connection.status)
  if (requiresTargetCleanup && preview.changed && selectionBrowserId !== undefined && previewTarget?.browserId === selectionBrowserId) {
    const base = isRecord(connection.status) ? connection.status : { result: connection.status }
    return asJsonValue({
      ...base,
      state: 'target_switch_requires_cleanup',
      ok: false,
      connected: false,
      targetStability: preview,
      recommendation: 'cleanup_browser_target',
      error: { code: 'TARGET_OWNERSHIP_REQUIRES_CLEANUP', message: 'Clean up the currently bound browser target before acknowledging a different browser target; ownership is not transferred.' },
      bridgeHealth: compactBridgeHealth(connection.bridgeHealth),
    })
  }
  const targetStability = selectionBrowserId === undefined ? preview : tracker.observe(connection.status, selectionBrowserId)
  const base = isRecord(connection.status) ? connection.status : { result: connection.status }
  try {
    return asJsonValue({ ...base, state: connection.state, targetStability, bridgeHealth: compactBridgeHealth(await bridge.health()) })
  } catch {
    return asJsonValue({ ...base, state: connection.state, targetStability, bridgeHealth: compactBridgeHealth(connection.bridgeHealth) })
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
  let bridgeDiagnosis: Record<string, unknown> | undefined
  try {
    const diagnosis = await bridge.request('doctor', {}, signal)
    if (isRecord(diagnosis) && ('bridgeHealth' in diagnosis || 'targets' in diagnosis)) bridgeDiagnosis = diagnosis
  } catch {
    // Fall back to the status-based diagnosis for older Bridge versions.
  }

  let status: unknown
  try {
    status = await requestWithTarget(bridge, 'status', { sessionId }, signal, tracker.route())
  } catch (error) {
    if (signal.aborted) throw error
    if (bridgeDiagnosis !== undefined) return asJsonValue({ ...bridgeDiagnosis, bridgeHealth })
    return asJsonValue({
      ok: false,
      recommendation: 'reconnect_extension',
      bridgeHealth,
      recovery: bridgeRecovery(bridgeHealth),
      issues: [{ code: 'browser_status_unavailable', message: errorText(error) }],
    })
  }
  const targetStability = tracker.observe(status)
  const base = { ...(bridgeDiagnosis ?? {}), ...(isRecord(status) ? status : { status }) }
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
  const bridgeReadyTargets = readyTargetRecords(bridgeHealth)
  const bridgeReportsTarget = target !== undefined && (bridgeBrowserId === target.browserId || bridgeReadyTargets.some(candidate => candidate.browserId === target.browserId))
  const issues = [] as Array<{ code: string; message: string }>
  const notices = [] as Array<{ code: string; message: string }>
  if (targetStability.issue !== undefined) {
    issues.push({ code: targetStability.issue, message: 'The browser status did not identify browser, browserId and profile. Reload the extension to update its status contract.' })
  } else if (targetStability.changed) {
    issues.push({
      code: 'browser_target_changed',
      message: `The active browser changed from ${targetStability.previousBrowser} (${targetStability.previousBrowserId}) to ${targetStability.browser} (${targetStability.browserId}).`,
    })
  } else if (targetStability.connectionChanged) {
    issues.push({
      code: 'browser_connection_changed',
      message: `The selected browser connection changed from ${targetStability.previousConnectionId ?? 'an earlier connection'} to ${targetStability.connectionId ?? 'the current connection'}; acknowledge the current connection with browser_status before retrying browser operations.`,
    })
  } else if (!bridgeReportsTarget) {
    issues.push({ code: 'bridge_target_routing_unavailable', message: 'The Bridge does not expose the active browser identity required for atomic target routing; run browser_doctor and update or restart the Bridge.' })
  } else if (bridgeBrowserId !== undefined && target !== undefined && target.browserId !== bridgeBrowserId) {
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
      : targetStability.connectionChanged
        ? 'acknowledge_browser_connection'
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
  cleanupRequired: boolean
}

type CleanupMode = 'task' | 'context' | 'turn' | 'disposal'
type CleanupOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown }

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

/**
 * Register browser tools globally or after the browser Skill loads in an Agent scope.
 * The returned idempotent disposer closes new browser operations, waits for active
 * executions and per-session cleanup, retries final recovery, and contains disposal failures.
 */
export function registerBrowserTools(
  ctx: Context,
  bridge: BrowserBridgeClient,
  attachments: AttachmentStore | undefined,
  resolveSettings: () => ResolvedConfig,
): () => Promise<void> {
  type AgentSession = Agent['session']
  type PendingCleanup = {
    readonly session: AgentSession
    readonly mode: 'task' | 'context'
    readonly activation: BrowserActivation | undefined
    readonly generation: number
    readonly clearTurnCleanup: boolean
  }
  const trackers = new Map<AgentSession, BrowserTargetTracker>()
  const turnNumbers = new Map<AgentSession, number>()
  const turnCleanupSessions = new Set<AgentSession>()
  const targetUseSessions = new Set<AgentSession>()
  const generations = new Map<AgentSession, number>()
  const activations = new Map<AgentSession, BrowserActivation>()
  const usedSessions = new Set<AgentSession>()
  const cleanupRequiredSessions = new Set<AgentSession>()
  const cleanupFailures = new Set<AgentSession>()
  const inspectionRequiredSessions = new Set<AgentSession>()
  const cleanupFlights = new Map<AgentSession, Promise<CleanupOutcome>>()
  const cleanupTails = new Map<AgentSession, Promise<void>>()
  const retirementTails = new Map<string, Promise<void>>()
  const retiredSessions = new Set<AgentSession>()
  type RecoveryRecord = {
    readonly owner: AgentSession
    readonly promise: Promise<{ readonly ok: boolean }>
    readonly sessionId: string
    readonly params?: Record<string, unknown>
    readonly route?: BrowserTargetRoute
  }
  const recoveryRecords = new Map<string, RecoveryRecord>()
  const recoveryRequiredSessions = new Set<AgentSession>()
  const operationLeases = new Set<Promise<void>>()
  const activeWaitControllers = new Map<AgentSession, Set<AbortController>>()
  const wireBarriers = new Map<string, Promise<void>>()
  const pendingCleanups = new WeakMap<Readonly<ToolExecution>, PendingCleanup>()
  const lazyTools = resolveSettings().lazyTools
  let closed = false
  let disposePromise: Promise<void> | undefined
  let globalDisposers: (() => void)[] = []
  const abortActiveWaits = (session: AgentSession): void => {
    const controllers = activeWaitControllers.get(session)
    if (controllers === undefined) return
    activeWaitControllers.delete(session)
    for (const controller of controllers) controller.abort(new Error('Browser wait aborted by lifecycle cleanup'))
  }
  const trackWaitController = (session: AgentSession, controller: AbortController): void => {
    const controllers = activeWaitControllers.get(session) ?? new Set<AbortController>()
    controllers.add(controller)
    activeWaitControllers.set(session, controllers)
  }
  const untrackWaitController = (session: AgentSession, controller: AbortController): void => {
    const controllers = activeWaitControllers.get(session)
    if (controllers === undefined) return
    controllers.delete(controller)
    if (controllers.size === 0) activeWaitControllers.delete(session)
  }
  const sessionId = (session: AgentSession): string => String(session.id)
  const turnNumberFor = (session: AgentSession): number => turnNumbers.get(session) ?? 0
  const trackerFor = (session: AgentSession): BrowserTargetTracker => {
    const existing = trackers.get(session)
    if (existing !== undefined) return existing
    const created = new BrowserTargetTracker()
    trackers.set(session, created)
    return created
  }
  const hasUsage = (session: AgentSession): boolean => {
    const activation = activations.get(session)
    return activation?.usedBrowser === true || usedSessions.has(session) || cleanupFailures.has(session)
  }
  const hasBrowserUsage = (session: AgentSession): boolean => {
    const activation = activations.get(session)
    return hasUsage(session)
      || activation?.cleanupRequired === true
      || cleanupRequiredSessions.has(session)
      || turnCleanupSessions.has(session)
  }
  const hasTargetUsage = (session: AgentSession): boolean => targetUseSessions.has(session)
  const generationFor = (session: AgentSession): number => generations.get(session) ?? 0
  const bumpGeneration = (session: AgentSession): number => {
    const generation = generationFor(session) + 1
    generations.set(session, generation)
    return generation
  }
  const markBrowserUsed = (session: AgentSession, targetUse = true): void => {
    bumpGeneration(session)
    if (targetUse) targetUseSessions.add(session)
    turnCleanupSessions.add(session)
    const activation = activations.get(session)
    if (activation !== undefined) {
      activation.usedBrowser = true
      activation.cleanupRequired = true
    } else {
      usedSessions.add(session)
      cleanupRequiredSessions.add(session)
    }
  }

  const cleanupRetainsTabs = (value: unknown): boolean => {
    if (!isRecord(value) || !Array.isArray(value.retained)) return true
    return value.retained.length > 0
  }
  const cleanupFailure = (value: unknown): Error | undefined => {
    if (!isRecord(value) || !Array.isArray(value.failed) || value.failed.length === 0) return undefined
    const uncertain = value.failed.some(entry => isRecord(entry) && (entry.code === 'BROWSER_OPERATION_UNCERTAIN' || (isRecord(entry.details) && entry.details.code === 'BROWSER_OPERATION_UNCERTAIN')))
    const error = new Error(`Browser cleanup failed for ${value.failed.length} tab(s): ${JSON.stringify(value.failed)}`) as Error & { code?: string; details?: unknown }
    if (uncertain) {
      error.code = 'BROWSER_OPERATION_UNCERTAIN'
      error.details = { actionState: 'unknown', retryable: false, inspectFirst: true }
    }
    return error
  }
  const clearRecovery = (session: AgentSession, force = false): void => {
    const id = sessionId(session)
    const record = recoveryRecords.get(id)
    if (force || record?.owner === session) recoveryRecords.delete(id)
    recoveryRequiredSessions.delete(session)
  }
  const retainRecoveryFailure = (
    session: AgentSession,
    requiresRecovery = false,
    params?: Record<string, unknown>,
    route?: BrowserTargetRoute,
  ): void => {
    const id = sessionId(session)
    const existing = recoveryRecords.get(id)
    if (existing?.owner === session && params === undefined && route === undefined) {
      if (requiresRecovery) recoveryRequiredSessions.add(session)
      return
    }
    if (requiresRecovery) recoveryRequiredSessions.add(session)
    recoveryRecords.set(id, {
      owner: existing?.owner ?? session,
      promise: existing?.promise ?? Promise.resolve({ ok: false }),
      sessionId: existing?.sessionId ?? id,
      ...(params === undefined ? {} : { params }),
      ...(route === undefined ? {} : { route }),
    })
  }
  const resetSessionUsage = (session: AgentSession, clearTurnCleanup = false): void => {
    const activation = activations.get(session)
    if (activation !== undefined) {
      activation.usedBrowser = false
      activation.cleanupRequired = false
    }
    usedSessions.delete(session)
    cleanupRequiredSessions.delete(session)
    cleanupFailures.delete(session)
    inspectionRequiredSessions.delete(session)
    if (clearTurnCleanup) targetUseSessions.delete(session)
    if (clearTurnCleanup) turnCleanupSessions.delete(session)
  }
  const deactivate = (session: AgentSession): void => {
    abortActiveWaits(session)
    bumpGeneration(session)
    const activation = activations.get(session)
    activations.delete(session)
    usedSessions.delete(session)
    targetUseSessions.delete(session)
    turnCleanupSessions.delete(session)
    turnNumbers.delete(session)
    trackers.delete(session)
    if (activation === undefined) return
    for (const dispose of [...activation.disposers].reverse()) {
      try {
        dispose()
      } catch {
        // A registry disposer cannot prevent browser cleanup or Bridge shutdown.
      }
    }
  }
  const raceAbort = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (signal === undefined) return promise
    if (signal.aborted) throw signal.reason ?? new Error('Browser cleanup wait aborted')
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('Browser cleanup wait aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([promise, aborted])
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }
  const waitForRecovery = async (session: AgentSession, signal?: AbortSignal): Promise<void> => {
    const record = recoveryRecords.get(sessionId(session))
    if (record === undefined || record.owner === session) return
    const outcome = await raceAbort(record.promise, signal)
    if (!outcome.ok) throw new Error(`Browser session ${sessionId(session)} is unavailable until prior cleanup succeeds`)
  }
  const waitForRetirement = async (session: AgentSession, signal?: AbortSignal): Promise<void> => {
    const retirement = retirementTails.get(sessionId(session))
    if (retirement !== undefined) await raceAbort(retirement, signal)
    await waitForRecovery(session, signal)
  }
  const operationTails = new Map<AgentSession, Promise<void>>()
  const reserveOperation = (session: AgentSession): { readonly previous: Promise<void>; readonly release: () => void } => {
    const previous = operationTails.get(session) ?? Promise.resolve()
    let resolveGate!: () => void
    const gate = new Promise<void>(resolve => { resolveGate = resolve })
    const tail = previous.then(() => gate)
    operationTails.set(session, tail)
    operationLeases.add(tail)
    let released = false
    const release = () => {
      if (released) return
      released = true
      resolveGate()
      if (operationTails.get(session) === tail) operationTails.delete(session)
      operationLeases.delete(tail)
    }
    return { previous, release }
  }
  const acquireOperation = async (session: AgentSession, signal?: AbortSignal): Promise<() => void> => {
    const lease = reserveOperation(session)
    try {
      await raceAbort(lease.previous, signal)
    } catch (error) {
      lease.release()
      throw error
    }
    return lease.release
  }
  const waitForWireBarrier = async (session: AgentSession, signal?: AbortSignal): Promise<void> => {
    const barrier = wireBarriers.get(sessionId(session))
    if (barrier !== undefined) await raceAbort(barrier, signal)
  }
  const requestCleanup = async (
    session: AgentSession,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    targetRoute?: BrowserTargetRoute,
  ): Promise<unknown> => {
    const id = sessionId(session)
    const previous = wireBarriers.get(id)
    const request = (previous ?? Promise.resolve()).then(async () => {
      if (signal?.aborted) throw signal.reason ?? new Error('Browser cleanup request aborted')
      let cleanupParams = params
      let selectedRoute = targetRoute
      if (params.mode !== 'turn') {
        const expectedBrowserId = typeof params.expectedBrowserId === 'string' ? params.expectedBrowserId : targetRoute?.browserId
        const statusRoute = expectedBrowserId === undefined ? undefined : { browserId: expectedBrowserId }
        const status = await requestWithTarget(bridge, 'status', { sessionId: id, ...(expectedBrowserId === undefined ? {} : { expectedBrowserId }) }, signal, statusRoute)
        const target = readBrowserTarget(status)
        if (target === undefined) throw new Error('Browser status did not identify an active browser target; cleanup was not attempted')
        if (expectedBrowserId !== undefined && target.browserId !== expectedBrowserId) {
          throw new Error(`Browser target changed during cleanup; expected ${expectedBrowserId} but the active target is ${target.browserId}`)
        }
        if (params.recoverStale === true) {
          const capabilities = isRecord(status) && isRecord(status.capabilities) ? status.capabilities : undefined
          const missing = ['tabIncarnationFence', 'debuggerLeaseRecovery'].filter(name => capabilities?.[name] !== true)
          if (missing.length > 0) throw new Error(`The connected extension does not support stale-runtime ownership recovery (${missing.join(', ')}); reload pi-control-chrome`)
        }
        cleanupParams = { ...params, expectedBrowserId: target.browserId }
        selectedRoute = {
          browserId: target.browserId,
          ...(target.connectionId === undefined ? {} : { connectionId: target.connectionId }),
          ...(target.connectionGeneration === undefined ? {} : { connectionGeneration: target.connectionGeneration }),
        }
      }
      if (params.mode === 'turn') {
        const expectedBrowserId = typeof params.expectedBrowserId === 'string' ? params.expectedBrowserId : targetRoute?.browserId
        const statusRoute = expectedBrowserId === undefined ? undefined : { browserId: expectedBrowserId }
        const status = await requestWithTarget(bridge, 'status', { sessionId: id, ...(expectedBrowserId === undefined ? {} : { expectedBrowserId }) }, signal, statusRoute)
        const target = readBrowserTarget(status)
        if (target === undefined) throw new Error('Browser status did not identify an active browser target; turn cleanup was not attempted')
        if (expectedBrowserId !== undefined && target.browserId !== expectedBrowserId) {
          throw new Error(`Browser target changed during turn cleanup; expected ${expectedBrowserId} but the active target is ${target.browserId}`)
        }
        const capabilities = isRecord(status) && isRecord(status.capabilities) ? status.capabilities : undefined
        const missing = TURN_CLEANUP_CAPABILITIES.filter(name => capabilities?.[name] !== true)
        if (missing.length > 0) throw new Error(`The connected extension does not support turn cleanup (${missing.join(', ')}); reload pi-control-chrome`)
        cleanupParams = { ...params, expectedBrowserId: target.browserId }
        selectedRoute = {
          browserId: target.browserId,
          ...(target.connectionId === undefined ? {} : { connectionId: target.connectionId }),
          ...(target.connectionGeneration === undefined ? {} : { connectionGeneration: target.connectionGeneration }),
        }
      }
      return requestWithTarget(bridge, 'cleanup', cleanupParams, signal, selectedRoute)
    })
    const barrier = request.then(() => undefined, () => undefined)
    wireBarriers.set(id, barrier)
    void request.then(() => {
      if (wireBarriers.get(id) === barrier) wireBarriers.delete(id)
    }, () => {
      if (wireBarriers.get(id) === barrier) wireBarriers.delete(id)
    })
    return raceAbort(request, signal)
  }
  const cleanupSession = (session: AgentSession, mode: CleanupMode, signal?: AbortSignal, turnIdOverride?: number, reservedFlight = false, options: { readonly recoverStale?: boolean } = {}): Promise<CleanupOutcome> => {
    const previous = cleanupTails.get(session)
    let attemptedParams: Record<string, unknown> | undefined
    let attemptedRoute: BrowserTargetRoute | undefined
    const run = (async (): Promise<CleanupOutcome> => {
      let recoveryRequested = options.recoverStale === true || recoveryRequiredSessions.has(session)
      try {
        abortActiveWaits(session)
        if (previous !== undefined) await raceAbort(previous, signal)
        if (inspectionRequiredSessions.has(session) && mode !== 'task' && options.recoverStale !== true) {
          const error = new Error('Browser cleanup outcome is uncertain; inspect the current browser state before automatic cleanup retry') as Error & { code?: string; details?: unknown }
          error.code = 'BROWSER_OPERATION_UNCERTAIN'
          error.details = { actionState: 'unknown', retryable: false, inspectFirst: true }
          throw error
        }
        recoveryRequested = options.recoverStale === true || recoveryRequiredSessions.has(session)
        const needsCleanup = hasBrowserUsage(session) || recoveryRequested
        if (!needsCleanup) {
          if (mode === 'turn') {
            resetSessionUsage(session)
            clearRecovery(session, recoveryRequested)
          } else if (mode === 'context' || mode === 'disposal') {
            resetSessionUsage(session, true)
            clearRecovery(session, recoveryRequested)
            deactivate(session)
          }
          return { ok: true, value: { removed: [], released: [], retained: [], failed: [], recovered: [] } }
        }
        const tracker = trackerFor(session)
        const recovery = recoveryRecords.get(sessionId(session))
        const expectedBrowserId = tracker.expectedBrowserId()
        const cleanupParams = recoveryRequested && recovery?.params !== undefined
          ? { ...recovery.params, recoverStale: true }
          : {
            sessionId: sessionId(session),
            mode,
            ...(mode === 'turn' ? { turnId: turnIdOverride ?? turnNumberFor(session) } : {}),
            ...(expectedBrowserId === undefined ? {} : { expectedBrowserId }),
            ...(recoveryRequested ? { recoverStale: true } : {}),
          }
        const cleanupRoute = recoveryRequested && recovery?.route !== undefined ? recovery.route : tracker.fencedRoute()
        attemptedParams = cleanupParams
        attemptedRoute = cleanupRoute
        const value = await requestCleanup(session, cleanupParams, signal, cleanupRoute)
        const failure = cleanupFailure(value)
        if (failure !== undefined) throw failure
        if (mode === 'turn') {
          resetSessionUsage(session, !cleanupRetainsTabs(value))
          clearRecovery(session, recoveryRequested)
        } else if (mode === 'context' || mode === 'disposal') {
          resetSessionUsage(session, true)
          clearRecovery(session, recoveryRequested)
          deactivate(session)
        }
        return { ok: true, value }
      } catch (error) {
        cleanupFailures.add(session)
        if (isRecord(error) && error.code === 'BROWSER_OPERATION_UNCERTAIN') inspectionRequiredSessions.add(session)
        retainRecoveryFailure(session, recoveryRequested, attemptedParams, attemptedRoute)
        return { ok: false, error }
      }
    })()
    const tail = run.then(() => undefined, () => undefined)
    cleanupTails.set(session, tail)
    if (!reservedFlight) cleanupFlights.set(session, run)
    if (mode === 'disposal') {
      const recovery = run.then(result => ({ ok: result.ok }), () => ({ ok: false }))
      const previousRecovery = recoveryRecords.get(sessionId(session))
      const record: RecoveryRecord = {
        owner: session,
        promise: recovery,
        sessionId: previousRecovery?.sessionId ?? sessionId(session),
        ...(attemptedParams === undefined ? (previousRecovery?.params === undefined ? {} : { params: previousRecovery.params }) : { params: attemptedParams }),
        ...(attemptedRoute === undefined ? (previousRecovery?.route === undefined ? {} : { route: previousRecovery.route }) : { route: attemptedRoute }),
      }
      recoveryRecords.set(sessionId(session), record)
      void recovery.then(outcome => {
        if (outcome.ok && recoveryRecords.get(sessionId(session)) === record) recoveryRecords.delete(sessionId(session))
      })
    }
    void run.then(() => {
      if (cleanupFlights.get(session) === run) cleanupFlights.delete(session)
      if (cleanupTails.get(session) === tail) cleanupTails.delete(session)
    }, () => {
      if (cleanupFlights.get(session) === run) cleanupFlights.delete(session)
      if (cleanupTails.get(session) === tail) cleanupTails.delete(session)
    })
    return run
  }
  const disposeAgent = async (session: AgentSession, reserved?: ReturnType<typeof reserveOperation>): Promise<boolean> => {
    const lease = reserved ?? reserveOperation(session)
    try {
      await lease.previous
      const result = await cleanupSession(session, 'disposal')
      if (!result.ok) {
        deactivate(session)
        return false
      }
      return true
    } catch {
      retainRecoveryFailure(session)
      deactivate(session)
      return false
    } finally {
      lease.release()
    }
  }
  const retireAgent = (session: AgentSession): void => {
    if (retiredSessions.has(session)) return
    retiredSessions.add(session)
    const id = sessionId(session)
    const lease = reserveOperation(session)
    const previous = retirementTails.get(id)
    const run = (previous ?? Promise.resolve()).then(() => disposeAgent(session, lease))
    const tail = run.then(() => undefined, () => undefined)
    retirementTails.set(id, tail)
    void run.then(succeeded => {
      if (retirementTails.get(id) !== tail) return
      retirementTails.delete(id)
      if (succeeded) retiredSessions.delete(session)
    }, () => undefined)
  }
  const disposeAll = (): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise
    closed = true
    for (const session of [...activeWaitControllers.keys()]) abortActiveWaits(session)
    disposePromise = (async () => {
      await Promise.all([...operationLeases])
      await Promise.allSettled([...retirementTails.values(), ...cleanupFlights.values(), ...wireBarriers.values()])
      const sessions = new Set([
        ...trackers.keys(),
        ...activations.keys(),
        ...usedSessions,
        ...turnCleanupSessions,
        ...cleanupRequiredSessions,
        ...cleanupFailures,
        ...cleanupFlights.keys(),
        ...cleanupTails.keys(),
        ...retiredSessions,
        ...[...recoveryRecords.values()].map(record => record.owner),
      ])
      await Promise.allSettled([...sessions].map(async session => {
        const result = await cleanupSession(session, 'disposal')
        if (!result.ok) deactivate(session)
      }))
      await Promise.allSettled([...retirementTails.values()])
      await Promise.allSettled([...wireBarriers.values()])
      for (const session of sessions) {
        deactivate(session)
        if (!recoveryRecords.has(sessionId(session))) retiredSessions.delete(session)
      }
      const disposers = globalDisposers
      globalDisposers = []
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // A global registry disposer cannot prevent Bridge shutdown.
        }
      }
    })()
    return disposePromise
  }
  const toolFor = (spec: BrowserToolSpec): ReturnType<typeof defineTool> => defineTool({
    name: spec.name,
    description: spec.description,
    parameters: TAB_HANDLE_METHODS.has(spec.method)
      ? { ...spec.parameters, handle: spec.name === 'browser_locator' ? LOCATOR_TAB_HANDLE : TAB_HANDLE }
      : spec.parameters,
    output: {
      schema: { type: 'json' },
      render: renderResult,
    },
    timeoutMs: resolveSettings().requestTimeoutMs,
    async execute(args: Record<string, JsonValue>, exec: ToolRunContext): Promise<JsonValue> {
      const sessionId = requireAgentSession(exec)
      const session = requireAgent(exec).session
      if (closed) throw inactiveBrowserError()
      const isWaitTool = spec.name === 'browser_wait'
        || (spec.name === 'browser_navigate' && args.wait !== false)
        || (spec.name === 'browser_download' && (args.action === 'wait' || (args.action === 'start' && args.wait !== false)))
        || (spec.name === 'browser_locator' && args.action === 'waitFor')
      const isRecoveryCleanup = spec.name === 'browser_cleanup' && args.recoverStale === true
      const waitController = isWaitTool ? new AbortController() : undefined
      const operationSignal = waitController?.signal ?? exec.signal
      let removeExecutionAbort = (): void => {}
      if (waitController !== undefined) {
        trackWaitController(session, waitController)
        const onAbort = (): void => { waitController.abort(exec.signal.reason) }
        if (exec.signal.aborted) onAbort()
        else {
          exec.signal.addEventListener('abort', onAbort, { once: true })
          removeExecutionAbort = () => exec.signal.removeEventListener('abort', onAbort)
        }
      }
      let releaseOperation: (() => void) | undefined
      try {
        if (!isWaitTool) releaseOperation = await acquireOperation(session, operationSignal)
        if (!isRecoveryCleanup) await waitForRetirement(session, operationSignal)
        if (retiredSessions.has(session)) throw inactiveBrowserError()
        const activation = lazyTools ? activations.get(session) : undefined
        if (lazyTools && activation === undefined) throw inactiveBrowserError()
        await waitForWireBarrier(session, operationSignal)
        let params = normalizeBrowserToolArgs(spec.name, { ...args, sessionId })
        if (spec.name === 'browser_mark_handoff' || spec.name === 'browser_mark_deliverable') params.turnId = turnNumberFor(session)
        validateRequestNumbers(params)
        if (spec.name === 'browser_wait') validateWaitRequest(params)
        if (spec.name === 'browser_locator') validateLocatorRequest(params)
        if (spec.prepare !== undefined) params = spec.prepare(params)
        if (spec.name === 'browser_cleanup' || spec.name === 'browser_context_reset') {
          const mode = spec.name === 'browser_context_reset' ? 'context' : 'task'
          const result = await cleanupSession(session, mode, exec.signal, undefined, false, { recoverStale: spec.name === 'browser_cleanup' && args.recoverStale === true })
          if (!result.ok) throw result.error
          pendingCleanups.set(exec, { session, mode, activation, generation: generationFor(session), clearTurnCleanup: mode === 'context' || !cleanupRetainsTabs(result.value) })
          return compactBrowserResult(spec.name, params, result.value)
        }
        const tracker = trackerFor(session)
        if (spec.name === 'browser_doctor') return await browserDoctor(bridge, tracker, sessionId, operationSignal)
        if (spec.name === 'browser_status') {
          const acknowledgeBrowserId = optionalBrowserId(args.acknowledgeBrowserId)
          const requestedBrowserId = optionalBrowserId(args.browserId)
          const status = await browserStatus(bridge, tracker, sessionId, operationSignal, resolveSettings().extensionReadyTimeoutMs, acknowledgeBrowserId, requestedBrowserId, hasTargetUsage(session))
          if (statusCanArmCleanup(status)) markBrowserUsed(session, false)
          return status
        }
        const connection = await readBrowserConnection(bridge, sessionId, operationSignal, resolveSettings().extensionReadyTimeoutMs, tracker.route())
        if (connection.state !== 'connected') return connectionResult(connection)
        const target = await assertStableBrowserTarget(bridge, tracker, connection)
        const targetRoute = tracker.fencedRoute()
        markBrowserUsed(session)
        params = { ...params, expectedBrowserId: target.browserId }
        let method = spec.method
        if (spec.name === 'browser_accessibility_snapshot') {
          const wireParams = compactResponseParams(spec.name, params, connection.bridgeHealth)
          assertBridgeRequestCapabilities('snapshot', wireParams, connection.bridgeHealth, connection.status)
          const result = await requestBrowserOperation(bridge, 'snapshot', { ...wireParams, accessibilityOnly: true }, operationSignal, targetRoute)
          if (!result.ok) return await operationDisconnectedResult(bridge, result.code, result.details)
          return prepareAccessibility(result.value, params)
        }
        if (spec.name === 'browser_console') {
          method = params.action === 'enable' ? 'devtools_enable' : 'console_logs'
        }
        if (spec.name === 'browser_network') {
          const network = prepareNetwork(params)
          method = network.method
          params = network.params
        }
        const wireParams = compactResponseParams(spec.name, params, connection.bridgeHealth)
        assertBridgeRequestCapabilities(method, wireParams, connection.bridgeHealth, connection.status)
        if (spec.name === 'browser_screenshot') {
          const result = await requestBrowserOperation(bridge, method, wireParams, operationSignal, targetRoute)
          if (!result.ok) return await operationDisconnectedResult(bridge, result.code, result.details)
          return prepareScreenshot(result.value, params, attachments)
        }
        const result = await requestBrowserOperation(bridge, method, wireParams, operationSignal, targetRoute)
        if (!result.ok) return await operationDisconnectedResult(bridge, result.code, result.details)
        return compactBrowserResult(spec.name, params, result.value)
      } finally {
        releaseOperation?.()
        if (waitController !== undefined) {
          removeExecutionAbort()
          untrackWaitController(session, waitController)
        }
      }
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
    const session = agent.session
    const recovery = recoveryRecords.get(sessionId(session))
    if (closed || !lazyTools || activations.has(session) || retiredSessions.has(session) || retirementTails.has(sessionId(session)) || (recovery !== undefined && recovery.owner !== session)) return
    const disposers = registerFor(agent.ctx)
    bumpGeneration(session)
    activations.set(session, { agent, disposers, usedBrowser: false, cleanupRequired: false })
  }
  if (!lazyTools) {
    ctx.effect(() => {
      globalDisposers = registerFor(ctx)
      return () => {
        const disposers = globalDisposers
        globalDisposers = []
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch {
            // A global registry disposer cannot prevent the remaining teardown.
          }
        }
      }
    }, 'control-chrome: register browser tools')
  }
  ctx.on('tools/result', (exec, result) => {
    const pending = pendingCleanups.get(exec)
    if (pending !== undefined) {
      pendingCleanups.delete(exec)
      if (!result.isError) queueMicrotask(() => {
        if (generationFor(pending.session) !== pending.generation) return
        if (lazyTools && activations.get(pending.session) !== pending.activation) return
        resetSessionUsage(pending.session, pending.clearTurnCleanup)
        clearRecovery(pending.session)
        if (pending.mode === 'context' && lazyTools && activations.get(pending.session) === pending.activation && !hasBrowserUsage(pending.session)) {
          deactivate(pending.session)
        }
      })
    }
    if (!lazyTools || result.isError || exec.name !== 'skill' || exec.agent === undefined) return
    if (isBrowserSkillArguments(exec.arguments)) activate(exec.agent)
  })

  const eventTurn = (event: unknown): number | undefined => {
    if (!isRecord(event) || !isRecord(event.data)) return undefined
    return typeof event.data.turn === 'number' ? event.data.turn : undefined
  }
  const runTurnCleanup = (session: AgentSession, turnOverride?: number): Promise<void> => {
    const turn = turnOverride ?? turnNumberFor(session)
    const previousCleanup = cleanupFlights.get(session)
    const lease = reserveOperation(session)
    const run = (async (): Promise<CleanupOutcome> => {
      try {
        if (previousCleanup !== undefined) await previousCleanup
        await lease.previous
        const result = await cleanupSession(session, 'turn', undefined, turn, true)
        if (!result.ok) cleanupFailures.add(session)
        if (turnNumberFor(session) === turn) turnNumbers.set(session, turn + 1)
        return result
      } catch (error) {
        cleanupFailures.add(session)
        if (turnNumberFor(session) === turn) turnNumbers.set(session, turn + 1)
        return { ok: false, error }
      } finally {
        lease.release()
      }
    })()
    cleanupFlights.set(session, run)
    void run.then(() => {
      if (cleanupFlights.get(session) === run) cleanupFlights.delete(session)
    }, () => {
      if (cleanupFlights.get(session) === run) cleanupFlights.delete(session)
    })
    return run.then(() => undefined)
  }
  ctx.on('session/event', (session, event) => {
    if (closed || retiredSessions.has(session)) return
    if (event.type === 'turn/start') {
      turnNumbers.set(session, eventTurn(event) ?? turnNumberFor(session) + 1)
      return
    }
    if (event.type === 'turn/end') return runTurnCleanup(session, eventTurn(event))
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (retiredSessions.has(agent.session)) throw inactiveBrowserError()
    const pending = cleanupFlights.get(agent.session)
    if (pending !== undefined) await raceAbort(pending, signal)
    await waitForRetirement(agent.session, signal)
    await waitForWireBarrier(agent.session, signal)
    const decision = await next()
    if (lazyTools && decision.kind === 'enter' && hasBrowserSkillInvocation(decision.messages)) activate(agent)
    return decision
  }, { prepend: true })
  ctx.on('agent/disposed', ({ agent }) => {
    if (closed) return
    const session = agent.session
    if (retiredSessions.has(session)) return
    if (!hasBrowserUsage(session)) {
      retiredSessions.add(session)
      deactivate(session)
      return
    }
    retireAgent(session)
  })
  return disposeAll
}

/** Expose the tool catalogs for tests and package consumers. */
export const browserToolCatalog = { core: CORE_TOOLS, advanced: ADVANCED_TOOLS } as const
