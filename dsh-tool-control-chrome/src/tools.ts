/** DSH model-facing tools that map to pi-control-chrome Bridge methods. */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
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
import type { ResolvedConfig, ScreenshotResult } from './types.js'

const TAB_ID: ParameterPropertySpec = { type: 'number', description: 'Browser tab id. Omit to use the selected tab.' }
const SELECTOR: ParameterPropertySpec = { type: 'string', description: 'Optional CSS selector. Prefer a ref from browser_snapshot.' }
const JSON_VALUE: ParameterPropertySpec = { type: 'json' }
const OPTIONAL_STRING: ParameterPropertySpec = { type: 'string' }
const OPTIONAL_NUMBER: ParameterPropertySpec = { type: 'number' }
const OPTIONAL_BOOLEAN: ParameterPropertySpec = { type: 'boolean' }
const EMPTY_PARAMETERS: ParameterSchemaSpec = {}

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
    name: 'browser_status',
    description: 'Return the connected Chrome/Edge browser and local Bridge status.',
    parameters: EMPTY_PARAMETERS,
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
    prepare: args => ({ ...args, __accessibilityOnly: true }),
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
    description: 'Close a specified browser tab. Use only for Agent-owned or explicitly requested tabs.',
    parameters: { tabId: requiredNumber() },
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
      timeoutMs: OPTIONAL_NUMBER,
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
      tabId: TAB_ID,
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

function requireAgentSession(exec: ToolRunContext): string {
  if (exec.agent === undefined) throw new Error('Browser control requires an Agent-backed DSH session')
  return String(exec.agent.session.id)
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

/** Register the full browser-control tool surface and return its disposers. */
export function registerBrowserTools(
  ctx: Context,
  bridge: BrowserBridgeClient,
  attachments: AttachmentStore | undefined,
  resolveSettings: () => ResolvedConfig,
): void {
  const specs = [...CORE_TOOLS, ...ADVANCED_TOOLS]
  for (const spec of specs) {
    const tool = defineTool({
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
        let params = { ...args, sessionId } as Record<string, JsonValue>
        if (spec.prepare !== undefined) params = spec.prepare(params)
        let method = spec.method
        if (spec.name === 'browser_accessibility_snapshot') {
          const result = await bridge.request('snapshot', params, exec.signal)
          return prepareAccessibility(result)
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
          const result = await bridge.request(method, params, exec.signal)
          return prepareScreenshot(result, params, attachments)
        }
        const result = await bridge.request(method, params, exec.signal)
        if (spec.name === 'browser_status') {
          try {
            return asJsonValue({ ...(isRecord(result) ? result : { result }), bridgeHealth: await bridge.health() })
          } catch {
            return asJsonValue(result)
          }
        }
        return asJsonValue(result)
      },
    })
    ctx.effect(() => ctx.tools.register(tool), `control-chrome: register ${spec.name}`)
  }
}

/** Expose the tool catalogs for tests and package consumers. */
export const browserToolCatalog = { core: CORE_TOOLS, advanced: ADVANCED_TOOLS } as const
