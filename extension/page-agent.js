(() => {
  "use strict";

  const RUNTIME_KEY = "__piControlChromePageAgent";
  const DOCUMENT_TOKEN_KEY = "__piControlChromeDocumentToken";
  const DEFAULT_OBSERVATION_LIMIT = 16;
  const DEFAULT_OBSERVATION_TTL_MS = 30 * 60_000;
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
