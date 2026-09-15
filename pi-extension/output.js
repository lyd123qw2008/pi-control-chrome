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
// The extension capability revision this host distribution needs. A connected extension that
// advertises an older revision cannot serve the newest request shapes, so the host reports it
// as a runtime-freshness issue instead of silently degrading. `browser_status` prints the single
// number; `browser_doctor` prints the full boolean map for diagnosis.
export const REQUIRED_CAPABILITY_REVISION = 8;
const STATUS_IDENTITY_KEYS = ["browserId", "profile", "connectionId", "connectionGeneration", "connectedAt"];
const TARGET_STABILITY_DECISION_KEYS = ["stable", "changed", "acknowledged", "connectionChanged", "requiresAcknowledgement", "competition"];
const TARGET_STABILITY_IDENTITY_KEYS = ["browser", "browserId", "connectionId"];

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
  const truncated = snapshot.truncated === true || sourceNodeCount > maxNodes || sourceState.length > maxChars;
  return {
    state,
    nodeCount: Math.min(sourceNodeCount, maxNodes),
    charCount: state.length,
    truncated,
    // The contract wants an omission count, not just a flag: say how much text and how many nodes
    // the budget dropped, and keep the source size for the same reason.
    ...(truncated ? { omitted: { ...(sourceNodeCount > maxNodes ? { nodes: sourceNodeCount - Math.min(sourceNodeCount, maxNodes) } : {}), ...(sourceState.length > maxChars ? { characters: sourceState.length - state.length } : {}) } } : {}),
    ...(truncated ? { nextAction: "browser_snapshot", recommendation: "narrow_read" } : {}),
    ...(Number.isInteger(snapshot.sourceCharacters) ? { sourceCharacters: snapshot.sourceCharacters } : {}),
  };
}

function compactAccessibilityState(value, maxChars, maxNodes) {
  if (!isRecord(value) || typeof value.state !== "string" || Array.isArray(value.children)) return undefined;
  const sourceState = text(value.state);
  const state = bounded(sourceState, maxChars);
  const sourceNodeCount = typeof value.nodeCount === "number" && Number.isFinite(value.nodeCount) ? Math.max(0, value.nodeCount) : 0;
  const capturedNodeCount = typeof value.sourceNodeCount === "number" && Number.isFinite(value.sourceNodeCount) ? Math.max(0, value.sourceNodeCount) : undefined;
  const droppedNodes = capturedNodeCount === undefined ? undefined : capturedNodeCount - Math.min(sourceNodeCount, maxNodes);
  const droppedChars = sourceState.length > maxChars ? sourceState.length - state.length : undefined;
  const truncated = value.truncated === true || sourceNodeCount > maxNodes || sourceState.length > maxChars;
  const envelope = omissionEnvelope({
    truncated,
    omitted: { nodes: droppedNodes, characters: droppedChars },
    nextAction: "browser_accessibility_snapshot",
    recommendation: "narrow_read",
    recovery: "Narrow the same read with a selector or scopeSelector, a smaller maxNodes/maxChars, or disableDiffing: true for a full tree of the region you need.",
  });
  return {
    state,
    nodeCount: Math.min(sourceNodeCount, maxNodes),
    charCount: state.length,
    ...(capturedNodeCount === undefined ? {} : { sourceNodeCount: capturedNodeCount }),
    ...(truncated ? { truncated: true } : {}),
    ...(isRecord(value.accessibility) ? {} : {}),
    ...envelope,
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

function regionAddress(region) {
  const address = isRecord(region.address) ? region.address : {};
  const role = typeof address.role === "string" ? address.role : typeof region.role === "string" ? region.role : "";
  const name = typeof address.name === "string" ? address.name : "";
  const selector = typeof address.selector === "string" ? address.selector : "";
  if (selector) return ` {selector=${selector}}`;
  if (role && name) return ` {${role} ${quote(name)}}`;
  return "";
}

function nodeAddress(node) {
  const role = bounded(text(node.role || "control"), 64);
  const name = bounded(text(node.name || ""), FIELD_MAX_CHARS);
  const ref = typeof node.ref === "string" ? ` [ref=${node.ref}]` : "";
  const selector = isRecord(node.address) && typeof node.address.selector === "string" ? ` {selector=${node.address.selector}}` : "";
  const target = !ref && !selector && isRecord(node.address) && typeof node.address.role === "string" && typeof node.address.name === "string"
    ? ` {${node.address.role} ${quote(node.address.name)}}`
    : "";
  return `${role}${name ? ` ${quote(name)}` : ""}${ref}${selector}${target}`;
}

/**
 * Neutral page digest: regions in document order, repeated containers as counts, every
 * region addressable again, and any budget omission reported with how to retrieve it.
 * This renderer makes no judgement about which part of the page matters.
 */
function pageMapState(pageMap, maxChars, maxNodes) {
  if (!isRecord(pageMap) || !Array.isArray(pageMap.regions)) return undefined;
  const sections = [];
  sections.push(`Page: ${bounded(text(pageMap.title || ""), FIELD_MAX_CHARS)}`);
  if (typeof pageMap.url === "string" && pageMap.url.length > 0) sections.push(`URL: ${bounded(pageMap.url, 512)}`);
  const status = Array.isArray(pageMap.status) ? pageMap.status.filter(value => typeof value === "string" && value.length > 0).slice(0, 3) : [];
  if (status.length > 0) sections.push(`Status:\n${status.map(value => `- ${bounded(value, 320)}`).join("\n")}`);
  const metadata = Array.isArray(pageMap.metadata) ? pageMap.metadata.filter(isRecord).slice(0, 12) : [];
  if (metadata.length > 0) {
    sections.push(`Values:\n${metadata.map((entry) => `- ${bounded(text(entry.key || "value"), 64)}: ${bounded(text(entry.value), 320)}`).join("\n")}`);
  }
  let nodeCount = 0;
  const regions = Array.isArray(pageMap.regions) ? pageMap.regions.filter(isRecord).slice(0, 12) : [];
  if (regions.length > 0) {
    const lines = [];
    // One fact once: nested regions overlap, so the same `label: value` pair would otherwise be
    // published by an ancestor and every descendant (a real build page printed two facts eight
    // times). The first region in document order keeps the pair; a descendant still returns it when
    // the reader zooms into that region, so nothing becomes unretrievable.
    const publishedValues = new Set();
    for (const region of regions) {
      const kind = bounded(text(region.kind || region.role || "content"), 64);
      const role = bounded(text(region.role || "content"), 64);
      const name = bounded(text(region.name || ""), FIELD_MAX_CHARS);
      const counts = isRecord(region.counts)
        ? Object.entries(region.counts).filter(([, value]) => typeof value === "number").map(([key, value]) => `${key}=${value}`)
        : [];
      const address = regionAddress(region);
      const ref = typeof region.ref === "string" ? ` [ref=${region.ref}]` : "";
      lines.push(`- ${kind} ${quote(name || role)}${counts.length > 0 ? ` (${counts.join(", ")})` : ""}${ref}${address}`);
      const controls = Array.isArray(region.controls) ? region.controls.filter(isRecord) : [];
      const values = (Array.isArray(region.values) ? region.values.filter(isRecord) : [])
        .map((entry) => [entry, `${text(entry.key || "value")}=${text(entry.value)}`])
        .filter(([, key]) => !publishedValues.has(key))
        .slice(0, 6);
      for (const [, key] of values) publishedValues.add(key);
      const regionText = typeof region.text === "string" ? region.text : "";
      if (controls.length === 0 && values.length === 0 && !regionText) continue;
      const detail = [];
      if (controls.length > 0) detail.push(`controls: ${controls.map(nodeAddress).join(", ")}`);
      if (values.length > 0) detail.push(`values: ${values.map(([entry]) => `${bounded(text(entry.key || "value"), 64)}=${bounded(text(entry.value), 240)}`).join(", ")}`);
      if (regionText.length > 0) detail.push(`text: ${bounded(regionText, 480)}`);
      lines.push(`  ${detail.join("\n  ")}`);
      nodeCount += controls.length + values.length;
    }
    sections.push(`Regions (document order):\n${lines.join("\n")}`);
  }
  // A boundary the collector never crosses is reported as a boundary, not as an omission: on a
  // Web-Components page the digest can otherwise look empty with no hint that content exists.
  const shadowRoots = Number.isInteger(pageMap.shadowRoots) ? pageMap.shadowRoots : 0;
  if (shadowRoots > 0) {
    sections.push(`Note: ${shadowRoots} shadow root(s) are outside this digest (the collector does not enter shadow roots). Read that content with a bounded script on the host's shadowRoot, or address it with the page's own selector.`);
  }
  const omitted = isRecord(pageMap.omitted) ? pageMap.omitted : undefined;
  const omittedParts = omitted === undefined
    ? []
    : Object.entries(omitted).filter(([, value]) => typeof value === "number" && value > 0).map(([key, value]) => `${value} ${key}`);
  const stateSource = sections.join("\n\n");
  const state = bounded(stateSource, maxChars);
  const stateTruncated = stateSource.length > maxChars;
  const omittedTruncated = omittedParts.length > 0 || pageMap.truncated === true;
  const truncated = stateTruncated || omittedTruncated || nodeCount > maxNodes;
  const recovery = truncated
    ? "Narrow with browser_snapshot({ target }) on a listed region, browser_extract({ selector, maxChars }), or browser_locator({ target, action }); use responseMode: \"raw\" only for diagnosis."
    : undefined;
  return {
    state,
    nodeCount: Math.min(nodeCount, maxNodes),
    ...(truncated ? { truncated: true } : {}),
    ...(stateTruncated ? { stateTruncated: true } : {}),
    ...(omittedParts.length > 0 ? { omitted: Object.fromEntries(Object.entries(omitted).filter(([, value]) => typeof value === "number" && value > 0)) } : {}),
    ...(truncated ? { nextAction: "browser_snapshot", recommendation: "narrow_read" } : {}),
    ...(recovery === undefined ? {} : { recovery }),
  };
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
  const projected = pageMapState(snapshot.pageMap, maxChars, maxNodes)
    ?? compactStateSnapshot(snapshot, maxChars, maxNodes)
    ?? snapshotState(snapshot, maxChars, maxNodes);
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
       ...(projected.stateTruncated === true || combinedState.length > maxChars ? { stateTruncated: true } : {}),
       ...(isRecord(projected.omitted) ? { omitted: projected.omitted } : {}),
       ...(projected.nextAction === undefined ? {} : { nextAction: projected.nextAction }),
       ...(projected.recommendation === undefined ? {} : { recommendation: projected.recommendation }),
       ...(projected.recovery === undefined ? {} : { recovery: projected.recovery }),
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
      ...(precompact.sourceNodeCount === undefined ? {} : { sourceNodeCount: precompact.sourceNodeCount }),
      ...(precompact.omitted === undefined ? {} : { omitted: precompact.omitted }),
      ...(precompact.nextAction === undefined ? {} : { nextAction: precompact.nextAction }),
      ...(precompact.recommendation === undefined ? {} : { recommendation: precompact.recommendation }),
      ...(precompact.recovery === undefined ? {} : { recovery: precompact.recovery }),
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

/**
 * A bounded read must be retrievable (contract section 2.2): when a budget drops content, report
 * how much was dropped and name the narrower call that gets it back.
 */
function omissionEnvelope({ truncated, omitted, nextAction, recommendation, recovery }) {
  const counts = Object.fromEntries(Object.entries(omitted || {}).filter(([, value]) => typeof value === "number" && value > 0));
  const reportTruncation = truncated === true || Object.keys(counts).length > 0;
  if (!reportTruncation) return {};
  return {
    truncated: true,
    ...(Object.keys(counts).length > 0 ? { omitted: counts } : {}),
    ...(nextAction === undefined ? {} : { nextAction }),
    ...(recommendation === undefined ? {} : { recommendation }),
    ...(recovery === undefined ? {} : { recovery }),
  };
}

/** Project extracted page content with one shared text budget. */
export function compactExtractResult(value, maxChars = EXTRACT_MAX_CHARS, params = {}) {
  if (!isRecord(value)) return value;
  if (!isRecord(value.content)) return compactResultEnvelope(value);
  const content = value.content;
  const contentText = bounded(content.text, maxChars);
  const remainingChars = Math.max(0, maxChars - contentText.length);
  const contentMarkdown = remainingChars > 0 ? bounded(content.markdown, remainingChars) : "";
  const sourceCharacters = Number.isInteger(content.sourceCharacters) ? content.sourceCharacters : undefined;
  // A selective read (`logMatch`, `tail`) answers with matching lines or the end of the document, so
  // the source being longer than the budget drops nothing from the answer: reporting an omission
  // count there would be misleading, and an inexact omission count is worse than none.
  const selectiveRead = isRecord(params) && (params.logMatch !== undefined || params.tail === true);
  const matchTruncated = content.matchTruncated === true;
  const truncated = content.truncated === true || (!selectiveRead && (text(content.text).length > maxChars || text(content.markdown).length > remainingChars));
  const envelope = omissionEnvelope({
    truncated,
    omitted: { characters: selectiveRead || sourceCharacters === undefined ? undefined : sourceCharacters - contentText.length },
    nextAction: "browser_extract",
    recommendation: "narrow_read",
    recovery: matchTruncated
      ? "More matching lines exist than were returned: raise logMaxMatches, or narrow logMatch to a more specific literal."
      : "Narrow with browser_extract({ selector, maxChars }) on the region you already know, or read one log scope with scope: \"log\" and logMatch.",
  });
  return {
    ...compactResultEnvelope(value),
    content: {
       ...(value.tab === undefined && content.title !== undefined ? { title: bounded(content.title, FIELD_MAX_CHARS) } : {}),
       ...(value.tab === undefined && content.url !== undefined ? { url: bounded(content.url, 4_096) } : {}),
      ...(typeof content.scope === "string" ? { scope: bounded(content.scope, 64) } : {}),
       ...(typeof content.logMatch === "string" ? { logMatch: bounded(content.logMatch, 240) } : {}),
       ...(typeof content.matchedLineCount === "number" ? { matchedLineCount: content.matchedLineCount } : {}),
       ...(Array.isArray(content.matchedLineNumbers) ? { matchedLineNumbers: content.matchedLineNumbers.filter(Number.isInteger).slice(0, 200) } : {}),
       ...(content.matchTruncated === true ? { matchTruncated: true } : {}),
      text: contentText,
      markdown: contentMarkdown,
      ...(Number.isInteger(content.sourceCharacters) ? { sourceCharacters: content.sourceCharacters } : {}),
      // The automatic scope choice stays auditable: a caller that gets the wrong root switches to
      // scope: "selector" with the reported address instead of guessing.
      ...(typeof content.resolvedScope === "string" ? { resolvedScope: content.resolvedScope } : {}),
      ...(typeof content.resolvedRoot === "string" && content.resolvedRoot.length > 0 ? { resolvedRoot: bounded(content.resolvedRoot, FIELD_MAX_CHARS) } : {}),
      ...(Number.isInteger(content.shadowRoots) && content.shadowRoots > 0 ? { shadowRoots: content.shadowRoots } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...frameProjectionFields(content),
    },
    ...envelope,
  };
}

/**
 * Project a console or network listing. The list stays as bounded as the source made it; what is
 * added is the omission count and the cursor that retrieves the rest.
 */
function compactEventListing(toolName, value) {
  if (!isRecord(value)) return value;
  const isConsole = toolName === "browser_console";
  const entries = isConsole ? value.logs : value.requests;
  const returned = Array.isArray(entries) ? entries.length : 0;
  const total = isConsole ? value.logTotalCount : value.requestTotalCount;
  const truncated = isConsole ? value.logTruncated === true || value.truncated === true : value.requestTruncated === true || value.truncated === true;
  const omitted = Number.isInteger(total) ? total - returned : undefined;
  const envelope = omissionEnvelope({
    truncated,
    omitted: { [isConsole ? "events" : "requests"]: omitted },
    nextAction: toolName,
    recommendation: "narrow_read",
    recovery: isConsole
      ? "Continue from the cursor: browser_console({ since: <nextSince> }) reads only newer events, and only: \"errors\" narrows the read."
      : "Continue from the cursor, or narrow with the network filter, instead of re-reading the whole listing.",
  });
  return { ...compactResultEnvelope(value), ...value, ...envelope };
}

/**
 * Project a bounded evaluate result. The value is already bounded by the extension's depth/array/
 * field/string limits; what this adds is how much those limits dropped and the narrower call that
 * retrieves it.
 */
function compactEvaluateResult(value) {
  if (!isRecord(value) || !isRecord(value.result) || value.result.outputTruncated !== true) return value;
  const dropped = isRecord(value.result.outputOmitted) ? value.result.outputOmitted : {};
  const envelope = omissionEnvelope({
    truncated: true,
    omitted: { items: dropped.items, fields: dropped.fields, characters: dropped.characters },
    nextAction: "browser_evaluate",
    recommendation: "narrow_read",
    recovery: "Return one field or a page-side slice instead of the whole value; for page text prefer browser_extract({ selector, maxChars }) or browser_locator({ target, action }).",
  });
  return { ...compactResultEnvelope(value), ...value, ...envelope };
}

function compactError(value) {
  if (!isRecord(value)) return undefined;
  const error = {};
  for (const key of ["code", "message"]) {
    if (typeof value[key] === "string" && value[key].length > 0) error[key] = bounded(value[key], key === "message" ? 320 : FIELD_MAX_CHARS);
  }
  return Object.keys(error).length > 0 ? error : undefined;
}

function compactMessages(list) {
  if (!Array.isArray(list)) return undefined;
  const messages = list.filter(isRecord).slice(0, 6).map((entry) => {
    const message = {};
    for (const key of ["code", "message"]) if (typeof entry[key] === "string" && entry[key].length > 0) message[key] = bounded(entry[key], key === "message" ? 320 : FIELD_MAX_CHARS);
    return message;
  }).filter((entry) => Object.keys(entry).length > 0);
  return messages.length > 0 ? messages : undefined;
}

function compactBridgeSummary(value) {
  const health = isRecord(value.bridgeHealth) ? value.bridgeHealth : undefined;
  if (health !== undefined) {
    const summary = {};
    if (health.ok !== undefined) summary.ok = health.ok === true;
    if (typeof health.bridgeVersion === "string" && health.bridgeVersion.length > 0) summary.version = health.bridgeVersion;
    if (health.port !== undefined) summary.port = health.port;
    if (health.extensionConnected !== undefined) summary.extensionConnected = health.extensionConnected === true;
    if (health.readyTargetCount !== undefined) summary.readyTargets = health.readyTargetCount;
    return Object.keys(summary).length > 0 ? summary : undefined;
  }
  if (typeof value.bridge === "string" && value.bridge.length > 0) return { origin: bounded(value.bridge, FIELD_MAX_CHARS) };
  return undefined;
}

function compactTargetStability(value) {
  if (!isRecord(value)) return undefined;
  const result = {};
  for (const key of TARGET_STABILITY_DECISION_KEYS) if (value[key] !== undefined) result[key] = value[key];
  if (typeof value.issue === "string" && value.issue.length > 0) result.issue = value.issue;
  // Identity is printed once at the top level, so a stability record only carries the previous
  // target when it actually disagrees with the current one.
  if (value.changed === true || value.connectionChanged === true) {
    for (const key of ["previousBrowser", "previousBrowserId", "previousConnectionId"]) {
      if (value[key] !== undefined) result[key] = value[key];
    }
  }
  const observed = Array.isArray(value.observedBrowserIds) ? value.observedBrowserIds.filter((id) => typeof id === "string" && id.length > 0) : [];
  if (observed.length > 1) result.observedBrowserIds = observed.slice(0, 8);
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Project a composed browser status into the small contract a model needs: identity printed
 * once, one monotonic capability revision instead of the boolean map, and the target-stability
 * decision without duplicated identity. Diagnostics (`capabilities`, `targets`, per-request
 * metrics, recovery detail, user agent) belong to `browser_doctor`, which stays verbose.
 */
export function compactStatusResult(value) {
  if (!isRecord(value)) return value;
  const result = {};
  for (const key of ["connected", "state", "ok", "targetRequired", "completed", "retryable", "userActionRequired"]) if (value[key] !== undefined) result[key] = value[key];
  const error = compactError(value.error);
  if (error !== undefined) result.error = error;
  for (const key of ["browser", "extensionVersion"]) if (typeof value[key] === "string" && value[key].length > 0) result[key] = value[key];
  for (const key of STATUS_IDENTITY_KEYS) if (value[key] !== undefined) result[key] = key === "profile" ? bounded(value[key], FIELD_MAX_CHARS) : value[key];
  if (Number.isInteger(value.capabilityRevision)) result.capabilityRevision = value.capabilityRevision;
  // A status that refuses to pick a target must still carry the ids the caller has to choose
  // from; an ordinary status never repeats the target inventory that browser_targets owns.
  if (value.targetRequired === true && Array.isArray(value.targets)) {
    const targets = value.targets.filter(isRecord).slice(0, 8).map((target) => {
      const compact = {};
      for (const key of ["browser", "browserId", "profile", "state"]) {
        if (typeof target[key] === "string" && target[key].length > 0) compact[key] = bounded(target[key], FIELD_MAX_CHARS);
      }
      return compact;
    }).filter((target) => Object.keys(target).length > 0);
    if (targets.length > 0) result.targets = targets;
  }
  const bridge = compactBridgeSummary(value);
  if (bridge !== undefined) result.bridge = bridge;
  // The target a recovery path lost stays in the status: the caller has to know which browser
  // to re-select, and that is actionable rather than diagnostic.
  if (isRecord(value.target)) {
    const target = {};
    for (const key of ["browser", "browserId", "profile"]) {
      if (typeof value.target[key] === "string" && value.target[key].length > 0) target[key] = bounded(value.target[key], FIELD_MAX_CHARS);
    }
    if (Object.keys(target).length > 0) result.target = target;
  }
  const stability = compactTargetStability(value.targetStability);
  if (stability !== undefined) result.targetStability = stability;
  if (typeof value.recommendation === "string" && value.recommendation.length > 0) result.recommendation = value.recommendation;
  const issues = compactMessages(value.issues);
  const notices = compactMessages(value.notices);
  if (issues !== undefined) {
    result.issues = issues;
    if (value.recovery !== undefined) result.recovery = value.recovery;
  }
  if (notices !== undefined) result.notices = notices;
  if (typeof value.nextAction === "string" && value.nextAction.length > 0) result.nextAction = value.nextAction;
  return result;
}

const BRIDGE_HEALTH_KEYS = [
  "ok", "protocol", "service", "bridgeVersion", "instanceId", "startedBy", "startupMarker", "controlDomain", "port",
  "extensionConnected", "targetCount", "readyTargetCount", "targetAmbiguous", "unidentifiedExtensionConnections",
  "browser", "browserId", "profile", "extensionVersion", "extensionCapabilityRevision", "connectionId", "connectionGeneration", "state",
];
const BRIDGE_TARGET_KEYS = ["browser", "browserId", "profile", "extensionVersion", "capabilityRevision", "connectionId", "connectionGeneration", "state"];

function compactBridgeTarget(value) {
  const target = {};
  for (const key of BRIDGE_TARGET_KEYS) if (value[key] !== undefined) target[key] = value[key];
  return target;
}

/**
 * Project Bridge health for a model-facing read. The Bridge keeps its public health contract (the
 * extension capability map and user agent stay reachable there), but a host prints the map in
 * `runtime` only, so this projection drops the nested copies and keeps one target inventory plus
 * the observability a diagnosis needs.
 */
export function compactBridgeHealth(value) {
  if (!isRecord(value)) return value;
  const result = {};
  for (const key of BRIDGE_HEALTH_KEYS) if (value[key] !== undefined) result[key] = value[key];
  if (isRecord(value.capabilities) && value.capabilities.compactResponses === true) result.capabilities = { compactResponses: true };
  if (Array.isArray(value.targets)) result.targets = value.targets.filter(isRecord).map(compactBridgeTarget);
  if (isRecord(value.observability)) {
    const observability = {};
    for (const key of ["startedAt", "pendingRequests", "drainingRequests"]) if (value.observability[key] !== undefined) observability[key] = value.observability[key];
    if (isRecord(value.observability.metrics)) observability.metrics = value.observability.metrics;
    if (isRecord(value.observability.targetRecovery)) observability.targetRecovery = value.observability.targetRecovery;
    if (isRecord(value.observability.targetLeases)) observability.targetLeases = value.observability.targetLeases;
    if (Array.isArray(value.observability.recentEvents)) {
      observability.recentEvents = value.observability.recentEvents
        .filter((event) => isRecord(event) && typeof event.event === "string" && (event.event.startsWith("target_") || (event.event === "request_rejected" && typeof event.errorCode === "string" && event.errorCode.startsWith("TARGET_LEASE"))))
        .slice(-20)
        .map((event) => {
          const compact = {};
          for (const key of ["event", "at", "browserId", "connectionId", "connectionGeneration", "previousConnectionId", "previousConnectionGeneration", "reason", "method", "errorCode"]) {
            if (event[key] !== undefined) compact[key] = event[key];
          }
          return compact;
        });
    }
    if (Object.keys(observability).length > 0) result.observability = observability;
  }
  return result;
}

/** The extension capability map looks the same wherever a payload reports it. */
function extensionCapabilitySource(value) {
  const capabilities = isRecord(value.extensionCapabilities) ? value.extensionCapabilities : isRecord(value.capabilities) ? value.capabilities : undefined;
  const revision = Number.isInteger(value.extensionCapabilityRevision) ? value.extensionCapabilityRevision : Number.isInteger(value.capabilityRevision) ? value.capabilityRevision : undefined;
  return { capabilities, revision };
}

/**
 * Diagnose the extension runtime vintage so a stale worker is named instead of guessed. An explicit
 * `runtime` wins; otherwise the map and revision are read from whichever field the caller's payload
 * uses (`extensionCapabilities`/`extensionCapabilityRevision` for a Bridge doctor payload,
 * `capabilities`/`capabilityRevision` for an extension status payload).
 */
export function capabilityRuntime(value) {
  if (!isRecord(value)) return undefined;
  const explicit = isRecord(value.runtime) ? value.runtime : undefined;
  if (explicit !== undefined) {
    const runtime = {};
    if (typeof explicit.extensionVersion === "string" && explicit.extensionVersion.length > 0) runtime.extensionVersion = explicit.extensionVersion;
    if (Number.isInteger(explicit.capabilityRevision)) runtime.capabilityRevision = explicit.capabilityRevision;
    if (Number.isInteger(explicit.requiredCapabilityRevision)) runtime.requiredCapabilityRevision = explicit.requiredCapabilityRevision;
    if (explicit.fresh !== undefined) runtime.fresh = explicit.fresh === true;
    if (isRecord(explicit.capabilities)) runtime.capabilities = explicit.capabilities;
    return Object.keys(runtime).length > 0 ? runtime : undefined;
  }
  const { capabilities, revision } = extensionCapabilitySource(value);
  if (capabilities === undefined && revision === undefined) return undefined;
  const extensionVersion = typeof value.extensionVersion === "string" && value.extensionVersion.length > 0 ? value.extensionVersion : undefined;
  return {
    ...(extensionVersion === undefined ? {} : { extensionVersion }),
    ...(revision === undefined
      ? {}
      : { capabilityRevision: revision, requiredCapabilityRevision: REQUIRED_CAPABILITY_REVISION, fresh: revision >= REQUIRED_CAPABILITY_REVISION }),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function runtimeStaleIssue(runtime) {
  // Only a versioned-but-older runtime is a failure. A missing revision means "unknown vintage":
  // the per-request capability gates still fail closed with the exact missing capability, so the
  // doctor reports it as a notice instead of failing an otherwise healthy session.
  if (runtime === undefined || runtime.fresh === true) return undefined;
  if (runtime.capabilityRevision === undefined) return undefined;
  return { code: "extension_runtime_stale", message: `The connected extension advertises capability revision ${String(runtime.capabilityRevision)}, but this host needs ${REQUIRED_CAPABILITY_REVISION}; reload the extension before relying on newer request shapes.` };
}

function runtimeUnversionedNotice(runtime) {
  if (runtime === undefined || runtime.capabilityRevision !== undefined) return undefined;
  return { code: "extension_runtime_unversioned", message: `The connected extension does not advertise a capability revision; this host needs revision ${REQUIRED_CAPABILITY_REVISION}. Reload the extension to compare runtimes.` };
}

/** The runtime verdict a host reports: freshness plus the two messages that explain it. */
export function runtimeDiagnosis(value) {
  const runtime = capabilityRuntime(value);
  return { runtime, stale: runtimeStaleIssue(runtime), unversioned: runtimeUnversionedNotice(runtime) };
}

function compactTargetList(list) {
  if (!Array.isArray(list)) return undefined;
  const targets = list.filter(isRecord).slice(0, 8).map((target) => {
    const compact = {};
    for (const key of ["browser", "browserId", "profile", "state"]) {
      if (typeof target[key] === "string" && target[key].length > 0) compact[key] = bounded(target[key], FIELD_MAX_CHARS);
    }
    return compact;
  }).filter((target) => Object.keys(target).length > 0);
  return targets.length > 0 ? targets : undefined;
}

/**
 * Project a composed browser doctor into the diagnostic contract: one copy of the extension
 * capability map (inside `runtime`), one target inventory, compacted Bridge health with the
 * observability a diagnosis needs, and no identity repeated per nested block. Diagnostics stay
 * verbose, but never by printing the same fact twice.
 */
export function compactDoctorResult(value) {
  if (!isRecord(value)) return value;
  const result = {};
  for (const key of ["ok", "state", "connected", "targetRequired", "completed", "retryable", "userActionRequired"]) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  for (const key of ["browser", "extensionVersion"]) {
    if (typeof value[key] === "string" && value[key].length > 0) result[key] = value[key];
  }
  for (const key of STATUS_IDENTITY_KEYS) if (value[key] !== undefined) result[key] = key === "profile" ? bounded(value[key], FIELD_MAX_CHARS) : value[key];
  if (typeof value.recommendation === "string" && value.recommendation.length > 0) result.recommendation = value.recommendation;
  if (typeof value.nextAction === "string" && value.nextAction.length > 0) result.nextAction = value.nextAction;
  if (isRecord(value.error)) {
    const error = compactError(value.error);
    if (error !== undefined) result.error = error;
  }
  const runtime = capabilityRuntime(value);
  if (runtime !== undefined) result.runtime = runtime;
  const health = compactBridgeHealth(value.bridgeHealth);
  if (health !== undefined) result.bridgeHealth = health;
  const stability = compactTargetStability(value.targetStability);
  if (stability !== undefined) result.targetStability = stability;
  const targets = compactTargetList(value.targets);
  if (targets !== undefined) result.targets = targets;
  result.issues = compactMessages(value.issues) ?? [];
  result.notices = compactMessages(value.notices) ?? [];
  if (value.recovery !== undefined) result.recovery = value.recovery;
  return result;
}

/** Project tab descriptors without favicon payloads. */
export function compactTabsResult(value, currentSessionId) {
  if (!isRecord(value)) return value;
  const hasSession = typeof currentSessionId === "string" && currentSessionId.length > 0;
  const omitted = Number.isInteger(value.omittedTabs) && value.omittedTabs > 0 ? value.omittedTabs : 0;
  return {
    ...compactResultEnvelope(value),
    ...(hasSession ? { currentAgentSessionId: currentSessionId } : {}),
    tabs: Array.isArray(value.tabs) ? value.tabs.map(tab => compactTab(tab, currentSessionId)) : [],
    ...(Number.isInteger(value.totalTabs) ? { totalTabs: value.totalTabs } : {}),
    ...(Number.isInteger(value.matchedTabs) ? { matchedTabs: value.matchedTabs } : {}),
    // A bounded listing is still retrievable: the omitted count names how many rows the budget
    // dropped and the next call narrows instead of silently losing them.
    ...(omitted > 0 ? { omittedTabs: omitted, nextAction: "browser_tabs", recommendation: "narrow_tab_query" } : {}),
    ...(isRecord(value.filters) ? { filters: value.filters } : {}),
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
export function compactBrowserResult(toolName, params = {}, value) {
  // Raw is an explicit diagnostic escape hatch. Every ordinary model read still
  // uses the Page Map projection, but callers can inspect a bounded raw result
  // when the abstraction itself needs debugging.
  if (isRecord(params) && params.responseMode === "raw") return value;
  const maxChars = outputChars(params.maxChars, toolName === "browser_extract" ? EXTRACT_MAX_CHARS : toolName === "browser_dom_cua" ? DOM_MAX_CHARS : SNAPSHOT_MAX_CHARS);
  const maxNodes = outputNodes(params.maxNodes);
  if (toolName === "browser_snapshot") return compactSnapshotResult(value, maxChars, maxNodes);
  if (toolName === "browser_status") return compactStatusResult(value);
  if (toolName === "browser_doctor") return compactDoctorResult(value);
  if (toolName === "browser_accessibility_snapshot") return compactAccessibilityResult(value, maxChars, maxNodes);
  if (toolName === "browser_extract") return compactExtractResult(value, maxChars, params);
  const currentSessionId = typeof params.sessionId === "string" && params.sessionId.length > 0 ? params.sessionId : undefined;
  if (toolName === "browser_new_tab") return compactNewTabResult(value, currentSessionId);
  if (toolName === "browser_tabs") return compactTabsResult(value, currentSessionId);
  if (toolName === "browser_console" || toolName === "browser_network") return compactEventListing(toolName, value);
  if (toolName === "browser_evaluate") return compactEvaluateResult(value);
  if (toolName === "browser_selected" && isRecord(value)) return compactResultEnvelope(value, currentSessionId);
  if (toolName === "browser_dom_cua" && params.action === "get_visible_dom") return compactDomCuaResult(value, maxChars, maxNodes);
  return value;
}
