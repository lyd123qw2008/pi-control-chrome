/** Stable, host-neutral projections for model-facing browser tool results. */

export function compactSnapshotResult(value: unknown, maxChars?: number, maxNodes?: number): unknown;
export function compactAccessibilityResult(value: unknown, maxChars?: number, maxNodes?: number): unknown;
export function compactDomCuaResult(value: unknown, maxChars?: number, maxNodes?: number): unknown;
export function compactExtractResult(value: unknown, maxChars?: number): unknown;
export function compactTabsResult(value: unknown, currentSessionId?: string): unknown;
export function compactNewTabResult(value: unknown, currentSessionId?: string): unknown;
export function compactBrowserResult(toolName: string, params: Record<string, unknown>, value: unknown): unknown;
