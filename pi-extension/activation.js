/** Browser tool names and the session-local active-tool gate used by Pi. */

export const BROWSER_TOOL_NAMES = Object.freeze([
  'browser_doctor', 'browser_status', 'browser_tabs', 'browser_selected', 'browser_claim_tab', 'browser_select_tab', 'browser_new_tab',
  'browser_snapshot', 'browser_extract', 'browser_accessibility_snapshot', 'browser_navigate', 'browser_wait', 'browser_back',
  'browser_forward', 'browser_reload', 'browser_click', 'browser_double_click', 'browser_fill', 'browser_type', 'browser_press_key',
  'browser_scroll', 'browser_screenshot', 'browser_close_tab', 'browser_release', 'browser_mark_handoff', 'browser_mark_deliverable',
  'browser_cleanup', 'browser_locator', 'browser_dom_cua', 'browser_cua', 'browser_console', 'browser_network', 'browser_dialog',
  'browser_upload', 'browser_clipboard', 'browser_download', 'browser_evaluate', 'browser_cdp',
]);

export function applyBrowserToolMask(api, active) {
  const names = new Set(BROWSER_TOOL_NAMES);
  const current = api.getActiveTools();
  api.setActiveTools(active
    ? [...new Set([...current, ...BROWSER_TOOL_NAMES])]
    : current.filter(name => !names.has(name)));
}

/**
 * Create the session-scoped state used to gate Pi's statically registered tools.
 *
 * @param options - whether the browser names start hidden.
 * @returns the mutable gate for one Pi session.
 */
export function createBrowserActivation(options = {}) {
  const lazyTools = options.lazyTools !== false;
  let active = !lazyTools;
  let used = false;
  return {
    get active() { return active; },
    get used() { return used; },
    setActive(value) {
      active = value;
      return active;
    },
    markUsed() {
      used = true;
    },
    clearUsed() {
      used = false;
    },
    reset() {
      active = !lazyTools;
      used = false;
    },
  };
}
