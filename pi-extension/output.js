/** Pure model-facing projections for bounded Pi browser tool results. */

const SNAPSHOT_MAX_CHARS = 20_000;
const SNAPSHOT_TEXT_MAX_CHARS = 8_000;
const DOM_MAX_CHARS = 20_000;
const EXTRACT_MAX_CHARS = 12_000;
const OUTPUT_HARD_MAX_CHARS = 100_000;
const OUTPUT_HARD_MAX_NODES = 1_000;
const DEFAULT_OUTPUT_NODES = 200;
const FIELD_MAX_CHARS = 240;

function outputChars(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? Math.min(value, OUTPUT_HARD_MAX_CHARS) : fallback;
}
function outputNodes(value, fallback = DEFAULT_OUTPUT_NODES) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? Math.min(value, OUTPUT_HARD_MAX_NODES) : fallback;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value : String(value ?? "");
}

function bounded(value, limit) {
  const source = text(value);
  if (limit <= 0) return "";
  if (source.length <= limit) return source;
  if (limit <= 3) return source.slice(0, limit);
  return `${source.slice(0, limit - 3)}...`;
}

function compactTab(value) {
  if (!isRecord(value)) return value;
  const keys = [
    "id", "browserId", "windowId", "index", "active", "pinned", "title", "url", "status", "groupId",
    "tabFence", "incarnation", "owner", "ownership", "sessionId", "lifecycle", "stale", "handle",
  ];
  const result = {};
  for (const key of keys) if (value[key] !== undefined) result[key] = value[key];
  if (isRecord(result.handle)) {
    const handle = result.handle;
    const handleKeys = ["tabId", "browserId", "windowId", "title", "url", "groupId", "sessionId", "tabFence", "incarnation"];
    result.handle = Object.fromEntries(handleKeys.filter(key => handle[key] !== undefined).map(key => [key, handle[key]]));
  }
  if (typeof result.title === "string") result.title = bounded(result.title, FIELD_MAX_CHARS);
  if (typeof result.url === "string") result.url = bounded(result.url, 4_096);
  if (isRecord(result.handle) && typeof result.handle.title === "string") result.handle.title = bounded(result.handle.title, FIELD_MAX_CHARS);
  if (isRecord(result.handle) && typeof result.handle.url === "string") result.handle.url = bounded(result.handle.url, 4_096);
  if (typeof result.favicon === "string" && !/^https?:\/\//i.test(result.favicon)) delete result.favicon;
  return result;
}

function quote(value) {
  return JSON.stringify(bounded(value, FIELD_MAX_CHARS));
}

function elementLine(element) {
  const role = bounded(text(element.role || element.tag || "generic"), 64);
  const name = text(element.name);
  const value = element.value === undefined || text(element.value).length === 0 ? "" : ` value=${quote(element.value)}`;
  const disabled = element.disabled === true ? " disabled" : "";
  const checked = element.checked === undefined ? "" : ` checked=${element.checked === true}`;
  const href = typeof element.href === "string" ? ` href=${quote(element.href)}` : "";
  const ref = typeof element.ref === "string" ? ` [ref=${element.ref}]` : "";
  return `- ${role}${name ? ` ${quote(name)}` : ""}${value}${disabled}${checked}${href}${ref}`;
}

function accessibilityLine(node, prefix = "- ") {
  const role = bounded(text(node.role || "generic"), 64);
  const name = text(node.name);
  const value = node.value === undefined || text(node.value).length === 0 ? "" : ` value=${quote(node.value)}`;
  const disabled = node.disabled === true ? " disabled" : "";
  const checked = node.checked === undefined ? "" : ` checked=${node.checked === true}`;
  return `${prefix}${role}${name ? ` ${quote(name)}` : ""}${value}${disabled}${checked}`;
}

function snapshotState(snapshot, maxChars, maxNodes) {
  const sections = [];
  const allElements = Array.isArray(snapshot.elements) ? snapshot.elements.filter(isRecord) : [];
  const allChildren = isRecord(snapshot.accessibility) && Array.isArray(snapshot.accessibility.children) ? snapshot.accessibility.children.filter(isRecord) : [];
  const elements = allElements.slice(0, maxNodes);
  if (elements.length > 0) {
    sections.push(`Interactive elements:\n${elements.map(elementLine).join("\n")}`);
  } else {
    const children = allChildren.slice(0, maxNodes);
    if (children.length > 0) sections.push(`Accessibility:\n${children.map(node => accessibilityLine(node)).join("\n")}`);
  }
  const pageTextLimit = Math.min(SNAPSHOT_TEXT_MAX_CHARS, maxChars);
  const pageText = bounded(snapshot.text, pageTextLimit);
  if (elements.length === 0 && allChildren.length === 0 && pageText) sections.push(`Page text:\n${pageText}`);
  const stateSource = sections.join("\n\n");
  const state = bounded(stateSource, maxChars);
  const rawText = text(snapshot.text);
  const semanticState = elements.length > 0 || allChildren.length > 0;
  const pageTextIncluded = !semanticState && pageText.length > 0;
  const semanticTruncated = allElements.length > maxNodes
    || allChildren.length > maxNodes
    || stateSource.length > maxChars
    || (snapshot.truncated === true && (!semanticState || typeof snapshot.elementCharCount === "number" && snapshot.elementCharCount >= maxChars));
  const pageTextTruncated = pageTextIncluded && (snapshot.textTruncated === true || rawText.length > pageTextLimit);
  return {
    state,
    nodeCount: elements.length > 0 ? elements.length : Math.min(allChildren.length, maxNodes),
    truncated: semanticTruncated || pageTextTruncated,
  };
}

/** Project a raw snapshot to one bounded semantic state while retaining refs. */
export function compactSnapshotResult(value, maxChars = SNAPSHOT_MAX_CHARS, maxNodes = DEFAULT_OUTPUT_NODES) {
  if (!isRecord(value) || !isRecord(value.snapshot)) return value;
  const snapshot = value.snapshot;
  const projected = snapshotState(snapshot, maxChars, maxNodes);
  return {
    ...(value.tabId === undefined ? {} : { tabId: value.tabId }),
    ...(value.tab === undefined ? {} : { tab: compactTab(value.tab) }),
    snapshot: {
      snapshotId: snapshot.snapshotId,
       ...(value.tab === undefined && snapshot.title !== undefined ? { title: bounded(snapshot.title, FIELD_MAX_CHARS) } : {}),
       ...(value.tab === undefined && snapshot.url !== undefined ? { url: bounded(snapshot.url, 4_096) } : {}),
      state: projected.state,
      nodeCount: projected.nodeCount,
      charCount: projected.state.length,
      truncated: projected.truncated,
      ...(snapshot.viewport === undefined ? {} : { viewport: snapshot.viewport }),
    },
  };
}

/** Project a raw accessibility response to bounded full/diff text. */
export function compactAccessibilityResult(value, maxChars = SNAPSHOT_MAX_CHARS, maxNodes = DEFAULT_OUTPUT_NODES) {
  if (!isRecord(value)) return value;
  const snapshot = isRecord(value.snapshot) ? value.snapshot : undefined;
  const accessibility = isRecord(snapshot?.accessibility) ? snapshot.accessibility : value;
  const allChildren = Array.isArray(accessibility.children) ? accessibility.children.filter(isRecord) : [];
  const children = allChildren.slice(0, maxNodes);
  const mode = typeof accessibility.mode === "string" ? accessibility.mode : "full";
  const sourceState = mode === "full" && children.length > 0
    ? children.map(node => accessibilityLine(node)).join("\n")
    : typeof accessibility.state === "string" ? accessibility.state : children.map(node => accessibilityLine(node)).join("\n");
  const state = bounded(sourceState, maxChars);
  return {
    ...(value.tabId === undefined ? {} : { tabId: value.tabId }),
    ...(value.tab === undefined ? {} : { tab: compactTab(value.tab) }),
    snapshotId: typeof snapshot?.snapshotId === "string" ? snapshot.snapshotId : accessibility.snapshotId,
     ...(value.tab === undefined && typeof snapshot?.title === "string" ? { title: bounded(snapshot.title, FIELD_MAX_CHARS) } : {}),
     ...(value.tab === undefined && typeof snapshot?.url === "string" ? { url: bounded(snapshot.url, 4_096) } : {}),
    ...(typeof accessibility.baseSnapshotId === "string" ? { baseSnapshotId: accessibility.baseSnapshotId } : {}),
    mode,
    state,
    nodeCount: typeof accessibility.nodeCount === "number" ? Math.min(accessibility.nodeCount, maxNodes) : children.length,
    ...(typeof accessibility.changedNodeCount === "number" ? { changedNodeCount: accessibility.changedNodeCount } : {}),
    charCount: state.length,
    truncated: accessibility.truncated === true || allChildren.length > maxNodes || sourceState.length > maxChars,
  };
}

/** Project visible DOM nodes to bounded line-oriented state. */
export function compactDomCuaResult(value, maxChars = DOM_MAX_CHARS, maxNodes = DEFAULT_OUTPUT_NODES) {
  if (!isRecord(value) || !isRecord(value.dom)) return value;
  const dom = value.dom;
  const allNodes = Array.isArray(dom.nodes) ? dom.nodes.filter(isRecord) : [];
  const nodes = allNodes.slice(0, maxNodes);
  const stateSource = nodes.map(node => {
    const id = text(node.node_id);
    const tag = text(node.tag || "element");
    const role = node.role === undefined ? "" : ` role=${quote(bounded(node.role, 64))}`;
    const parent = node.parent_id === undefined ? "" : ` parent=${text(node.parent_id)}`;
    return `<${tag} node_id=${id}${parent}${role}>${bounded(node.text, 160)}</${tag}>`;
  }).join("\n");
  const state = bounded(stateSource, maxChars);
  return {
    ...(value.tabId === undefined ? {} : { tabId: value.tabId }),
    ...(value.tab === undefined ? {} : { tab: compactTab(value.tab) }),
    dom: {
      snapshotId: dom.snapshotId,
      viewport: dom.viewport,
      state,
      nodeCount: typeof dom.nodeCount === "number" ? Math.min(dom.nodeCount, maxNodes) : nodes.length,
      charCount: state.length,
      truncated: dom.truncated === true || allNodes.length > maxNodes || stateSource.length > maxChars,
    },
  };
}

/** Project extracted page content with one shared text budget. */
export function compactExtractResult(value, maxChars = EXTRACT_MAX_CHARS) {
  if (!isRecord(value) || !isRecord(value.content)) return value;
  const content = value.content;
  const contentText = bounded(content.text, maxChars);
  const remainingChars = Math.max(0, maxChars - contentText.length);
  const contentMarkdown = remainingChars > 0 ? bounded(content.markdown, remainingChars) : "";
  return {
    ...(value.tabId === undefined ? {} : { tabId: value.tabId }),
    ...(value.tab === undefined ? {} : { tab: compactTab(value.tab) }),
    content: {
       ...(value.tab === undefined && content.title !== undefined ? { title: bounded(content.title, FIELD_MAX_CHARS) } : {}),
       ...(value.tab === undefined && content.url !== undefined ? { url: bounded(content.url, 4_096) } : {}),
      text: contentText,
      markdown: contentMarkdown,
      ...(content.truncated === true || text(content.text).length > maxChars || text(content.markdown).length > remainingChars ? { truncated: true } : {}),
    },
  };
}

/** Project tab descriptors and remove favicon data payloads. */
export function compactTabsResult(value) {
  if (!isRecord(value)) return value;
  return {
    ...(value.browserId === undefined ? {} : { browserId: value.browserId }),
    ...(value.profile === undefined ? {} : { profile: bounded(value.profile, FIELD_MAX_CHARS) }),
    tabs: Array.isArray(value.tabs) ? value.tabs.map(compactTab) : [],
    ...(Array.isArray(value.groups) ? { groups: value.groups } : {}),
  };
}

/** Apply the model-facing projection selected by a browser tool. */
export function compactBrowserResult(toolName, params, value) {
  const maxChars = outputChars(params.maxChars, toolName === "browser_extract" ? EXTRACT_MAX_CHARS : toolName === "browser_dom_cua" ? DOM_MAX_CHARS : SNAPSHOT_MAX_CHARS);
  const maxNodes = outputNodes(params.maxNodes);
  if (toolName === "browser_snapshot") return compactSnapshotResult(value, maxChars, maxNodes);
  if (toolName === "browser_accessibility_snapshot") return compactAccessibilityResult(value, maxChars, maxNodes);
  if (toolName === "browser_extract") return compactExtractResult(value, maxChars);
  if (toolName === "browser_tabs") return compactTabsResult(value);
  if (toolName === "browser_selected" && isRecord(value)) return { ...value, ...(value.tab === undefined ? {} : { tab: compactTab(value.tab) }) };
  if (toolName === "browser_dom_cua" && params.action === "get_visible_dom") return compactDomCuaResult(value, maxChars, maxNodes);
  return value;
}
