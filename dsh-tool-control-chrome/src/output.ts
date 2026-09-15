/** DSH JsonValue adapters for pi-control-chrome's shared output projections. */

import type { JsonValue } from '@deepseek-ai/dsh-tools'
import {
  REQUIRED_CAPABILITY_REVISION as requiredCapabilityRevision,
  capabilityRuntime as projectCapabilityRuntime,
  compactAccessibilityResult as projectAccessibilityResult,
  compactBridgeHealth as projectBridgeHealth,
  compactBrowserResult as projectBrowserResult,
  compactDoctorResult as projectDoctorResult,
  compactDomCuaResult as projectDomCuaResult,
  compactExtractResult as projectExtractResult,
  compactNewTabResult as projectNewTabResult,
  compactSnapshotResult as projectSnapshotResult,
  compactStatusResult as projectStatusResult,
  compactTabsResult as projectTabsResult,
  runtimeDiagnosis as projectRuntimeDiagnosis,
} from 'pi-control-chrome/pi-extension/output.js'

const json = (value: unknown): JsonValue => value as JsonValue

/** The extension capability revision this host distribution needs. */
export const REQUIRED_CAPABILITY_REVISION: number = requiredCapabilityRevision

export function compactStatusResult(value: unknown): JsonValue {
  return json(projectStatusResult(value))
}

export function compactDoctorResult(value: unknown): JsonValue {
  return json(projectDoctorResult(value))
}

export function compactBridgeHealth(value: unknown): JsonValue {
  return json(projectBridgeHealth(value))
}

export function capabilityRuntime(value: unknown): Record<string, unknown> | undefined {
  return projectCapabilityRuntime(value) as Record<string, unknown> | undefined
}

export type RuntimeDiagnosis = {
  readonly runtime?: Record<string, unknown>
  readonly stale?: { readonly code: string; readonly message: string }
  readonly unversioned?: { readonly code: string; readonly message: string }
}

export function runtimeDiagnosis(value: unknown): RuntimeDiagnosis {
  return projectRuntimeDiagnosis(value) as RuntimeDiagnosis
}

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
