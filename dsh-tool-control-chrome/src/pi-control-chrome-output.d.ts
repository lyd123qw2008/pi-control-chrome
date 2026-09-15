/** Compatibility declarations for pi-control-chrome's public projection subpath. */
declare module 'pi-control-chrome/pi-extension/output.js' {
  export const REQUIRED_CAPABILITY_REVISION: number
  export function compactSnapshotResult(value: unknown, maxChars?: number, maxNodes?: number): unknown
  export function compactAccessibilityResult(value: unknown, maxChars?: number, maxNodes?: number): unknown
  export function compactDomCuaResult(value: unknown, maxChars?: number, maxNodes?: number): unknown
  export function compactExtractResult(value: unknown, maxChars?: number): unknown
  export function compactTabsResult(value: unknown, currentSessionId?: string): unknown
  export function compactNewTabResult(value: unknown, currentSessionId?: string): unknown
  export function compactStatusResult(value: unknown): unknown
  export function compactDoctorResult(value: unknown): unknown
  export function compactBridgeHealth(value: unknown): unknown
  export function capabilityRuntime(value: unknown): unknown
  export function runtimeDiagnosis(value: unknown): unknown
  export function compactBrowserResult(toolName: string, params: Record<string, unknown>, value: unknown): unknown
}
