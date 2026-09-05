(() => {
  "use strict";

  const RUNTIME_KEY = "__piControlChromePageAgent";
  const DOCUMENT_TOKEN_KEY = "__piControlChromeDocumentToken";
  const DEFAULT_OBSERVATION_LIMIT = 16;
  const DEFAULT_OBSERVATION_TTL_MS = 30 * 60_000;
  const DEFAULT_FRAME_MAX_DEPTH = 3;
  const DEFAULT_FRAME_MAX_COUNT = 32;
  const DEFAULT_FRAME_TEXT_LIMIT = 12_000;
  const isMapLike = (value) => Boolean(value
    && Number.isFinite(value.size)
    && ["get", "set", "delete", "keys", "values"].every((method) => typeof value[method] === "function"));
  const documentIdentity = () => {
    let token = globalThis[DOCUMENT_TOKEN_KEY];
    if (typeof token !== "string" || token.length === 0) {
      token = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      try { Object.defineProperty(globalThis, DOCUMENT_TOKEN_KEY, { configurable: false, enumerable: false, value: token }); } catch { globalThis[DOCUMENT_TOKEN_KEY] = token; }
    }
    return {
      url: location.href,
      timeOrigin: typeof performance?.timeOrigin === "number" ? performance.timeOrigin : undefined,
      token,
    };
  };
  const sameDocument = (left, right) => Boolean(left && right
    && left.url === right.url
    && left.timeOrigin === right.timeOrigin
    && typeof left.token === "string"
    && typeof right.token === "string"
    && left.token === right.token);
  const matchesDocument = (expected, current) => (expected.url === undefined || expected.url === current.url)
    && (expected.timeOrigin === undefined || expected.timeOrigin === current.timeOrigin)
    && (expected.token === undefined || expected.token === current.token);
  const retain = (element) => typeof WeakRef === "function" ? new WeakRef(element) : element;
  const dereference = (reference) => typeof reference?.deref === "function" ? reference.deref() : reference;
  const normalizeFrameText = (value) => String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const frameOptionNumber = (value, fallback, maximum) => {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
  };
  const frameIsVisible = (element) => {
    try {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const ownerWindow = element.ownerDocument?.defaultView || globalThis;
      let current = element;
      while (current && current.nodeType === 1) {
        const style = ownerWindow.getComputedStyle(current);
        if (current.hidden
          || String(current.getAttribute("aria-hidden") || "").toLowerCase() === "true"
          || style.display === "none"
          || style.visibility === "hidden"
          || style.visibility === "collapse"
          || style.contentVisibility === "hidden"
          || Number.parseFloat(style.opacity || "1") <= 0) return false;
        current = current.parentElement;
      }
      return true;
    } catch {
      return false;
    }
  };
  const safeFrameUrl = (frameElement) => {
    try {
      const value = frameElement.contentWindow?.location?.href;
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const collectFrames = (options = {}) => {
    if (options.includeFrames === false) return { frames: [], frameCount: 0, frameFailures: 0, frameLoading: 0, truncated: false };
    const maxDepth = frameOptionNumber(options.maxDepth, DEFAULT_FRAME_MAX_DEPTH, 6);
    const maxCount = frameOptionNumber(options.maxCount, DEFAULT_FRAME_MAX_COUNT, 128);
    const textLimit = frameOptionNumber(options.textLimit, DEFAULT_FRAME_TEXT_LIMIT, 100_000);
    const root = options.root && options.root.nodeType === 1 ? options.root : document.body || document.documentElement;
    const frames = [];
    const visitedDocuments = new WeakSet();
    let frameFailures = 0;
    let frameLoading = 0;
    let truncated = false;
    const visit = (scope, depth, parentPath) => {
      if (!scope || depth > maxDepth || frames.length >= maxCount) {
        if (scope && frames.length >= maxCount) truncated = true;
        return;
      }
      const frameElements = Array.from(scope.querySelectorAll("iframe,frame"));
      for (let index = 0; index < frameElements.length; index += 1) {
        if (frames.length >= maxCount) {
          truncated = true;
          break;
        }
        const frameElement = frameElements[index];
        if (!frameIsVisible(frameElement)) continue;
        const name = String(frameElement.getAttribute("name") || "").trim();
        const id = String(frameElement.id || "").trim();
        const label = name || id || `frame-${index}`;
        const framePath = parentPath ? `${parentPath}/${label}` : label;
        const summary = {
          framePath,
          ...(name ? { name } : {}),
          ...(id ? { id } : {}),
          tag: frameElement.tagName.toLowerCase(),
        };
        let childDocument;
        try {
          childDocument = frameElement.contentDocument;
        } catch {
          frameFailures += 1;
          frames.push({ ...summary, readable: false, reason: "cross_origin" });
          continue;
        }
        if (!childDocument?.documentElement || !childDocument.body) {
          frameFailures += 1;
          const frameUrl = safeFrameUrl(frameElement);
          const crossOrigin = frameUrl === undefined;
          if (!crossOrigin) frameLoading += 1;
          frames.push({ ...summary, readable: false, ...(crossOrigin ? { reason: "cross_origin" } : { loading: true, reason: "loading" }) });
          continue;
        }
        if (visitedDocuments.has(childDocument)) continue;
        visitedDocuments.add(childDocument);
        const rawText = normalizeFrameText(childDocument.body.innerText || childDocument.body.textContent || "");
        const url = safeFrameUrl(frameElement);
        const child = {
          ...summary,
          readable: true,
          ...(url ? { url } : {}),
          ...(childDocument.title ? { title: String(childDocument.title).slice(0, 240) } : {}),
          text: rawText.slice(0, textLimit),
          ...(rawText.length > textLimit ? { truncated: true } : {}),
        };
        frames.push(child);
        if (depth < maxDepth) visit(childDocument.body, depth + 1, framePath);
      }
    };
    visit(root, 1, "");
    return { frames, frameCount: frames.length, frameFailures, frameLoading, truncated };
  };
  const existing = globalThis[RUNTIME_KEY];

  if (existing
    && existing.version === 4
    && isMapLike(existing.observations)
    && isMapLike(existing.domObservations)
    && typeof existing.remember === "function"
    && typeof existing.lookup === "function"
    && typeof existing.documentIdentity === "function"
    && typeof existing.sameDocument === "function"
    && typeof existing.matchesDocument === "function"
    && typeof existing.retain === "function"
    && typeof existing.dereference === "function"
    && typeof existing.collectFrames === "function"
    && typeof existing.resolveObservedElement === "function") return;

  const observations = isMapLike(existing?.observations) ? existing.observations : new Map();
  const domObservations = isMapLike(existing?.domObservations) ? existing.domObservations : new Map();
  const limit = Number.isInteger(existing?.limit) && existing.limit > 0 ? existing.limit : DEFAULT_OBSERVATION_LIMIT;
  const ttlMs = Number.isFinite(existing?.ttlMs) && existing.ttlMs > 0 ? existing.ttlMs : DEFAULT_OBSERVATION_TTL_MS;

  const bucketFor = (kind) => kind === "dom" ? domObservations : observations;
  const prune = (bucket) => {
    const expiresBefore = Date.now() - ttlMs;
    for (const [observationId, record] of bucket) {
      if (Number(record?.createdAt) < expiresBefore) bucket.delete(observationId);
    }
    while (bucket.size > limit) bucket.delete(bucket.keys().next().value);
  };
  const remember = (kind, observationId, record) => {
    if (typeof observationId !== "string" || observationId.length === 0) return undefined;
    const bucket = bucketFor(kind);
    bucket.set(observationId, { ...record, createdAt: Number(record?.createdAt || Date.now()) });
    prune(bucket);
    return bucket.get(observationId);
  };
  const lookup = (kind, observationId) => {
    if (typeof observationId !== "string" || observationId.length === 0) return undefined;
    const bucket = bucketFor(kind);
    prune(bucket);
    return bucket.get(observationId);
  };
  // Both snapshot refs and DOM-CUA nodes have the same provenance lifecycle.
  // Callers provide their own descriptor policy and translate these states into
  // their domain-specific error messages.
  const resolveObservedElement = ({
    kind,
    observationId,
    recordId,
    observationInvalidated = false,
    expectedDocument,
    currentDocument,
    matchesDescriptor,
    canSemanticRebind,
    findCandidates,
  } = {}) => {
    if (observationInvalidated === true) return { state: "document_changed" };
    const current = currentDocument || documentIdentity();
    if (expectedDocument && !matchesDocument(expectedDocument, current)) return { state: "document_changed" };
    const observation = lookup(kind, observationId);
    const records = kind === "dom" ? observation?.nodes : observation?.refs;
    if (!observation || typeof records?.get !== "function") return { state: "observation_unavailable" };
    if (!sameDocument(observation.documentIdentity, current)) return { state: "document_changed" };
    const record = records.get(recordId);
    if (!record) return { state: "record_unavailable" };
    const original = dereference(record.element);
    const rebound = record.rebound === true;
    if (original?.isConnected && original.ownerDocument === document) {
      if (typeof matchesDescriptor === "function" && matchesDescriptor(original, record.descriptor)) {
        return { state: "resolved", element: original, rebound };
      }
      return { state: "changed", rebound };
    }
    if (rebound) return { state: "detached", reason: "rebind_already_used", rebound: true };
    if (typeof canSemanticRebind !== "function" || !canSemanticRebind(record.descriptor)) {
      return { state: "detached", reason: "descriptor_not_strong_enough", rebound: false };
    }
    const candidates = typeof findCandidates === "function" ? findCandidates(record.descriptor) : [];
    if (candidates.length === 1) {
      record.element = retain(candidates[0]);
      record.rebound = true;
      return { state: "resolved", element: candidates[0], rebound: true };
    }
    if (candidates.length > 1) return { state: "ambiguous", count: candidates.length, rebound: true };
    return { state: "detached", reason: "no_equivalent_target", rebound: false };
  };

  const runtime = {
    version: 4,
    limit,
    ttlMs,
    observations,
    domObservations,
    remember,
    lookup,
    documentIdentity,
    sameDocument,
    matchesDocument,
    retain,
    dereference,
    collectFrames,
    resolveObservedElement,
  };

  try {
    Object.defineProperty(globalThis, RUNTIME_KEY, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: runtime,
    });
  } catch {
    globalThis[RUNTIME_KEY] = runtime;
  }
})();
