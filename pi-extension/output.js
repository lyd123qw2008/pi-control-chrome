/** Pure model-facing projections for bounded Pi browser tool results. */

const SNAPSHOT_MAX_CHARS = 20_000;
const SNAPSHOT_TEXT_MAX_CHARS = 8_000;
const DOM_MAX_CHARS = 20_000;
const EXTRACT_MAX_CHARS = 12_000;
const OUTPUT_HARD_MAX_CHARS = 100_000;
const OUTPUT_HARD_MAX_NODES = 1_000;
const DEFAULT_OUTPUT_NODES = 200;
const FIELD_MAX_CHARS = 240;
const RESULT_IDENTITY_KEYS = ["browserId", "profile", "connectionId", "connectionGeneration"];

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

function compactFrameSummaries(value) {
  if (!Array.isArray(value)) return undefined;
  const frames = value.filter(isRecord).slice(0, 32).map((frame) => {
    const result = {};
    for (const key of ["framePath", "name", "id", "tag", "url", "title", "readable", "loading", "reason", "truncated"]) {
      if (frame[key] === undefined) continue;
      result[key] = typeof frame[key] === "string" ? bounded(frame[key], key === "url" ? 4_096 : FIELD_MAX_CHARS) : frame[key];
    }
    return result;
  });
  return frames.length > 0 ? frames : undefined;
}

function frameTextState(value, limit) {
  if (!Array.isArray(value)) return "";
  const source = value
    .filter((frame) => isRecord(frame) && frame.readable === true && typeof frame.text === "string" && frame.text.length > 0)
    .map((frame) => {
      const label = frame.title || frame.name || frame.framePath || "frame";
      return `[${label}]\n${frame.text}`;
    })
    .join("\n\n");
  return bounded(source, limit);
}

function frameProjectionFields(value) {
  if (!isRecord(value)) return {};
  const frames = compactFrameSummaries(value.frameSummaries);
  return {
    ...(frames === undefined ? {} : { frames }),
    ...(typeof value.frameCount === "number" ? { frameCount: value.frameCount } : {}),
    ...(typeof value.frameFailures === "number" && value.frameFailures > 0 ? { frameFailures: value.frameFailures } : {}),
    ...(typeof value.frameLoading === "number" && value.frameLoading > 0 ? { frameLoading: value.frameLoading } : {}),
  };
}

function compactTab(value, currentSessionId) {
  if (!isRecord(value)) return value;
  const keys = [
    "id", "browserId", "windowId", "index", "active", "pinned", "title", "url", "status", "groupId",
    "tabFence", "incarnation", "owner", "ownership", "sessionId", "lifecycle", "stale", "transitionPending", "handle",
  ];
  const result = {};
  for (const key of keys) if (value[key] !== undefined) result[key] = value[key];
  if (typeof currentSessionId === "string" && currentSessionId.length > 0) {
    const tabSessionId = typeof result.sessionId === "string" && result.sessionId.length > 0 ? result.sessionId : undefined;
    result.sessionScope = tabSessionId === undefined ? "user" : tabSessionId === currentSessionId ? "current-agent" : "other-agent";
  }
  if (isRecord(result.handle)) {
    const handle = result.handle;
    const handleKeys = ["tabId", "browserId", "windowId", "title", "url", "groupId", "sessionId", "tabFence", "incarnation"];
    result.handle = Object.fromEntries(handleKeys.filter(key => handle[key] !== undefined).map(key => [key, handle[key]]));
  }
  if (typeof result.title === "string") result.title = bounded(result.title, FIELD_MAX_CHARS);
  if (typeof result.url === "string") result.url = bounded(result.url, 4_096);
  if (isRecord(result.handle) && typeof result.handle.title === "string") result.handle.title = bounded(result.handle.title, FIELD_MAX_CHARS);
  if (isRecord(result.handle) && typeof result.handle.url === "string") result.handle.url = bounded(result.handle.url, 4_096);
  return result;
}

function compactResultEnvelope(value, currentSessionId) {
  const result = {};
  for (const key of RESULT_IDENTITY_KEYS) {
    if (value[key] === undefined) continue;
    result[key] = key === "profile" ? bounded(value[key], FIELD_MAX_CHARS) : value[key];
  }
  if (value.tabId !== undefined) result.tabId = value.tabId;
  if (value.tab !== undefined) result.tab = compactTab(value.tab, currentSessionId);
  return result;
}

function compactStateSnapshot(snapshot, maxChars, maxNodes) {
  if (typeof snapshot.state !== "string" || Array.isArray(snapshot.elements) || isRecord(snapshot.accessibility)) return undefined;
  const sourceState = text(snapshot.state);
  const state = bounded(sourceState, maxChars);
  const sourceNodeCount = typeof snapshot.nodeCount === "number" && Number.isFinite(snapshot.nodeCount) ? Math.max(0, snapshot.nodeCount) : 0;
  return {
    state,
    nodeCount: Math.min(sourceNodeCount, maxNodes),
    charCount: state.length,
    truncated: snapshot.truncated === true || sourceNodeCount > maxNodes || sourceState.length > maxChars,
  };
}

function compactAccessibilityState(value, maxChars, maxNodes) {
  if (!isRecord(value) || typeof value.state !== "string" || Array.isArray(value.children)) return undefined;
  const sourceState = text(value.state);
  const state = bounded(sourceState, maxChars);
  const sourceNodeCount = typeof value.nodeCount === "number" && Number.isFinite(value.nodeCount) ? Math.max(0, value.nodeCount) : 0;
  return {
    state,
    nodeCount: Math.min(sourceNodeCount, maxNodes),
    charCount: state.length,
    truncated: value.truncated === true || sourceNodeCount > maxNodes || sourceState.length > maxChars,
  };
}

function compactDomState(dom, maxChars, maxNodes) {
  if (!isRecord(dom) || typeof dom.state !== "string" || Array.isArray(dom.nodes)) return undefined;
  const sourceState = text(dom.state);
  const state = bounded(sourceState, maxChars);
  const sourceNodeCount = typeof dom.nodeCount === "number" && Number.isFinite(dom.nodeCount) ? Math.max(0, dom.nodeCount) : 0;
  return {
    state,
    nodeCount: Math.min(sourceNodeCount, maxNodes),
    charCount: state.length,
    truncated: dom.truncated === true || sourceNodeCount > maxNodes || sourceState.length > maxChars,
  };
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
  const checked = node.checked === undefined ? "" : ` checked=${node.checked === "mixed" ? "mixed" : node.checked === true}`;
  const states = ["expanded", "selected", "pressed", "required", "readonly", "editable"]
    .filter(key => node[key] !== undefined)
    .map(key => ` ${key}=${node[key] === true}`)
    .join("");
  const level = node.level === undefined ? "" : ` level=${node.level}`;
  const ref = typeof node.ref === "string" ? ` [ref=${node.ref}]` : "";
  return `${prefix}${role}${name ? ` ${quote(name)}` : ""}${value}${disabled}${checked}${states}${level}${ref}`;
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
  const embeddedFrameText = frameTextState(snapshot.frameSummaries, Math.min(SNAPSHOT_TEXT_MAX_CHARS, maxChars));
  if (elements.length === 0 && allChildren.length === 0 && pageText) sections.push(`Page text:\n${pageText}`);
  if ((elements.length > 0 || allChildren.length > 0) && embeddedFrameText) sections.push(`Embedded frames:\n${embeddedFrameText}`);
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
  if (!isRecord(value)) return value;
  if (!isRecord(value.snapshot)) return compactResultEnvelope(value);
  const snapshot = value.snapshot;
  const projected = compactStateSnapshot(snapshot, maxChars, maxNodes) ?? snapshotState(snapshot, maxChars, maxNodes);
  const embeddedFrameText = frameTextState(snapshot.frameSummaries, maxChars);
  const combinedState = [projected.state, embeddedFrameText ? `Embedded frames:\n${embeddedFrameText}` : ""].filter(Boolean).join("\n\n");
  const state = bounded(combinedState, maxChars);
  return {
    ...compactResultEnvelope(value),
    snapshot: {
      snapshotId: snapshot.snapshotId,
      ...(value.tab === undefined && snapshot.title !== undefined ? { title: bounded(snapshot.title, FIELD_MAX_CHARS) } : {}),
      ...(value.tab === undefined && snapshot.url !== undefined ? { url: bounded(snapshot.url, 4_096) } : {}),
      state,
      nodeCount: projected.nodeCount,
      charCount: state.length,
      truncated: projected.truncated || combinedState.length > maxChars,
      ...(snapshot.viewport === undefined ? {} : { viewport: snapshot.viewport }),
      ...frameProjectionFields(snapshot),
    },
  };
}

/** Project a raw accessibility response to bounded full/diff text. */
export function compactAccessibilityResult(value, maxChars = SNAPSHOT_MAX_CHARS, maxNodes = DEFAULT_OUTPUT_NODES) {
  if (!isRecord(value)) return value;
  const precompact = compactAccessibilityState(value, maxChars, maxNodes);
  if (precompact) {
    const embeddedFrameText = frameTextState(value.frameSummaries, maxChars);
    const combinedState = [precompact.state, embeddedFrameText ? `Embedded frames:\n${embeddedFrameText}` : ""].filter(Boolean).join("\n\n");
    const state = bounded(combinedState, maxChars);
    return {
      ...compactResultEnvelope(value),
      snapshotId: value.snapshotId,
      ...(typeof value.baseSnapshotId === "string" ? { baseSnapshotId: value.baseSnapshotId } : {}),
      mode: typeof value.mode === "string" ? value.mode : "full",
      state,
      nodeCount: precompact.nodeCount,
      ...(typeof value.changedNodeCount === "number" ? { changedNodeCount: value.changedNodeCount } : {}),
      charCount: state.length,
      truncated: precompact.truncated || combinedState.length > maxChars,
      ...frameProjectionFields(value),
    };
  }
  const snapshot = isRecord(value.snapshot) ? value.snapshot : undefined;
  const accessibility = isRecord(snapshot?.accessibility) ? snapshot.accessibility : value;
  const allChildren = Array.isArray(accessibility.children) ? accessibility.children.filter(isRecord) : [];
  const children = allChildren.slice(0, maxNodes);
  const mode = typeof accessibility.mode === "string" ? accessibility.mode : "full";
  const sourceState = mode === "full" && children.length > 0
    ? children.map(node => accessibilityLine(node)).join("\n")
    : typeof accessibility.state === "string" ? accessibility.state : children.map(node => accessibilityLine(node)).join("\n");
  const embeddedFrameText = frameTextState(accessibility.frameSummaries || snapshot?.frameSummaries, maxChars);
  const combinedState = [sourceState, embeddedFrameText ? `Embedded frames:\n${embeddedFrameText}` : ""].filter(Boolean).join("\n\n");
  const state = bounded(combinedState, maxChars);
  return {
    ...compactResultEnvelope(value),
    snapshotId: typeof snapshot?.snapshotId === "string" ? snapshot.snapshotId : accessibility.snapshotId,
    ...(value.tab === undefined && typeof snapshot?.title === "string" ? { title: bounded(snapshot.title, FIELD_MAX_CHARS) } : {}),
    ...(value.tab === undefined && typeof snapshot?.url === "string" ? { url: bounded(snapshot.url, 4_096) } : {}),
    ...(typeof accessibility.baseSnapshotId === "string" ? { baseSnapshotId: accessibility.baseSnapshotId } : {}),
    mode,
    state,
    nodeCount: typeof accessibility.nodeCount === "number" ? Math.min(accessibility.nodeCount, maxNodes) : children.length,
    ...(typeof accessibility.changedNodeCount === "number" ? { changedNodeCount: accessibility.changedNodeCount } : {}),
    charCount: state.length,
    truncated: accessibility.truncated === true || allChildren.length > maxNodes || combinedState.length > maxChars,
    ...frameProjectionFields(accessibility.frameSummaries ? accessibility : snapshot),
  };
}

/** Project visible DOM nodes to bounded line-oriented state. */
export function compactDomCuaResult(value, maxChars = DOM_MAX_CHARS, maxNodes = DEFAULT_OUTPUT_NODES) {
  if (!isRecord(value)) return value;
  if (!isRecord(value.dom)) return compactResultEnvelope(value);
  const dom = value.dom;
  const precompact = compactDomState(dom, maxChars, maxNodes);
  if (precompact) {
    const embeddedFrameText = frameTextState(dom.frameSummaries, maxChars);
    const frameSection = embeddedFrameText ? `Embedded frames:\n${embeddedFrameText}` : "";
    const combinedState = precompact.state.includes("Embedded frames:\n") ? precompact.state : [precompact.state, frameSection].filter(Boolean).join("\n\n");
    const state = bounded(combinedState, maxChars);
    return {
      ...compactResultEnvelope(value),
      dom: {
        snapshotId: dom.snapshotId,
        ...(dom.viewport === undefined ? {} : { viewport: dom.viewport }),
        state,
        nodeCount: precompact.nodeCount,
        charCount: state.length,
        truncated: precompact.truncated || combinedState.length > maxChars,
        ...frameProjectionFields(dom),
      },
    };
  }
  const allNodes = Array.isArray(dom.nodes) ? dom.nodes.filter(isRecord) : [];
  const nodes = allNodes.slice(0, maxNodes);
  const stateSource = nodes.map(node => {
    const id = text(node.node_id);
    const tag = text(node.tag || "element");
    const role = node.role === undefined ? "" : ` role=${quote(bounded(node.role, 64))}`;
    const parent = node.parent_id === undefined ? "" : ` parent=${text(node.parent_id)}`;
    return `<${tag} node_id=${id}${parent}${role}>${bounded(node.text, 160)}</${tag}>`;
  }).join("\n");
  const embeddedFrameText = frameTextState(dom.frameSummaries, maxChars);
  const combinedState = [stateSource, embeddedFrameText ? `Embedded frames:\n${embeddedFrameText}` : ""].filter(Boolean).join("\n\n");
  const state = bounded(combinedState, maxChars);
  return {
    ...compactResultEnvelope(value),
    dom: {
      snapshotId: dom.snapshotId,
      viewport: dom.viewport,
      state,
      nodeCount: typeof dom.nodeCount === "number" ? Math.min(dom.nodeCount, maxNodes) : nodes.length,
      charCount: state.length,
      truncated: dom.truncated === true || allNodes.length > maxNodes || combinedState.length > maxChars,
      ...frameProjectionFields(dom),
    },
  };
}

/** Project extracted page content with one shared text budget. */
export function compactExtractResult(value, maxChars = EXTRACT_MAX_CHARS) {
  if (!isRecord(value)) return value;
  if (!isRecord(value.content)) return compactResultEnvelope(value);
  const content = value.content;
  const contentText = bounded(content.text, maxChars);
  const remainingChars = Math.max(0, maxChars - contentText.length);
  const contentMarkdown = remainingChars > 0 ? bounded(content.markdown, remainingChars) : "";
  return {
    ...compactResultEnvelope(value),
    content: {
       ...(value.tab === undefined && content.title !== undefined ? { title: bounded(content.title, FIELD_MAX_CHARS) } : {}),
       ...(value.tab === undefined && content.url !== undefined ? { url: bounded(content.url, 4_096) } : {}),
      text: contentText,
      markdown: contentMarkdown,
      ...(content.truncated === true || text(content.text).length > maxChars || text(content.markdown).length > remainingChars ? { truncated: true } : {}),
      ...frameProjectionFields(content),
    },
  };
}

/** Project tab descriptors without favicon payloads. */
export function compactTabsResult(value, currentSessionId) {
  if (!isRecord(value)) return value;
  const hasSession = typeof currentSessionId === "string" && currentSessionId.length > 0;
  return {
    ...compactResultEnvelope(value),
    ...(hasSession ? { currentAgentSessionId: currentSessionId } : {}),
    tabs: Array.isArray(value.tabs) ? value.tabs.map(tab => compactTab(tab, currentSessionId)) : [],
    ...(Array.isArray(value.groups) ? { groups: value.groups } : {}),
  };
}

/** Project a created tab result while retaining the handle needed for the next call. */
export function compactNewTabResult(value, currentSessionId) {
  if (!isRecord(value)) return value;
  const hasSession = typeof currentSessionId === "string" && currentSessionId.length > 0;
  return {
    ...compactResultEnvelope(value, currentSessionId),
    ...(hasSession ? { currentAgentSessionId: currentSessionId } : {}),
    ...(value.groupId === undefined ? {} : { groupId: value.groupId }),
    ...(value.tabFence === undefined ? {} : { tabFence: value.tabFence }),
  };
}

/** Apply the model-facing projection selected by a browser tool. */
export function compactBrowserResult(toolName, params, value) {
  const maxChars = outputChars(params.maxChars, toolName === "browser_extract" ? EXTRACT_MAX_CHARS : toolName === "browser_dom_cua" ? DOM_MAX_CHARS : SNAPSHOT_MAX_CHARS);
  const maxNodes = outputNodes(params.maxNodes);
  if (toolName === "browser_snapshot") return compactSnapshotResult(value, maxChars, maxNodes);
  if (toolName === "browser_accessibility_snapshot") return compactAccessibilityResult(value, maxChars, maxNodes);
  if (toolName === "browser_extract") return compactExtractResult(value, maxChars);
  const currentSessionId = typeof params.sessionId === "string" && params.sessionId.length > 0 ? params.sessionId : undefined;
  if (toolName === "browser_new_tab") return compactNewTabResult(value, currentSessionId);
  if (toolName === "browser_tabs") return compactTabsResult(value, currentSessionId);
  if (toolName === "browser_selected" && isRecord(value)) return compactResultEnvelope(value, currentSessionId);
  if (toolName === "browser_dom_cua" && params.action === "get_visible_dom") return compactDomCuaResult(value, maxChars, maxNodes);
  return value;
}
