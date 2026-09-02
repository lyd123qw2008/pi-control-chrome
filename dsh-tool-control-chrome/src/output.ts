/** DSH JsonValue adapters for pi-control-chrome's shared output projections. */

import type { JsonValue } from '@deepseek-ai/dsh-tools'
import {
  compactAccessibilityResult as projectAccessibilityResult,
  compactBrowserResult as projectBrowserResult,
  compactDomCuaResult as projectDomCuaResult,
  compactExtractResult as projectExtractResult,
  compactNewTabResult as projectNewTabResult,
  compactSnapshotResult as projectSnapshotResult,
  compactTabsResult as projectTabsResult,
} from 'pi-control-chrome/pi-extension/output.js'

const json = (value: unknown): JsonValue => value as JsonValue

export function compactSnapshotResult(value: unknown, maxChars?: number, maxNodes?: number): JsonValue {
  return json(projectSnapshotResult(value, maxChars, maxNodes))
}

export function compactAccessibilityResult(value: unknown, maxChars?: number, maxNodes?: number): JsonValue {
  return json(projectAccessibilityResult(value, maxChars, maxNodes))
}

export function compactDomCuaResult(value: unknown, maxChars?: number, maxNodes?: number): JsonValue {
  return json(projectDomCuaResult(value, maxChars, maxNodes))
}

export function compactExtractResult(value: unknown, maxChars?: number): JsonValue {
  return json(projectExtractResult(value, maxChars))
}

export function compactTabsResult(value: unknown, currentSessionId?: string): JsonValue {
  return json(projectTabsResult(value, currentSessionId))
}

export function compactNewTabResult(value: unknown, currentSessionId?: string): JsonValue {
  return json(projectNewTabResult(value, currentSessionId))
}

export function compactBrowserResult(toolName: string, params: Record<string, unknown>, value: unknown): JsonValue {
  return json(projectBrowserResult(toolName, params, value))
}
