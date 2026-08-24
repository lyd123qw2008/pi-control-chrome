export declare const BROWSER_TOOL_NAMES: readonly string[];
export declare function applyBrowserToolMask(api: {
  getActiveTools(): readonly string[];
  setActiveTools(names: string[]): void;
}, active: boolean): void;
export declare function createBrowserActivation(options?: { lazyTools?: boolean }): {
  readonly active: boolean;
  readonly used: boolean;
  setActive(value: boolean): boolean;
  markUsed(): void;
  clearUsed(): void;
  reset(): void;
};
