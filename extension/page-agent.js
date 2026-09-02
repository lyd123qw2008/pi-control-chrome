(() => {
  "use strict";

  const RUNTIME_KEY = "__piControlChromePageAgent";
  const DEFAULT_OBSERVATION_LIMIT = 16;
  const DEFAULT_OBSERVATION_TTL_MS = 30 * 60_000;
  const existing = globalThis[RUNTIME_KEY];
  const isMapLike = (value) => Boolean(value
    && typeof value.get === "function"
    && typeof value.set === "function"
    && typeof value.values === "function");

  if (existing
    && existing.version === 2
    && isMapLike(existing.observations)
    && isMapLike(existing.domObservations)
    && typeof existing.remember === "function"
    && typeof existing.lookup === "function") return;

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
    prune(bucket);
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

  const runtime = {
    version: 2,
    limit,
    ttlMs,
    observations,
    domObservations,
    remember,
    lookup,
    clear() {
      observations.clear();
      domObservations.clear();
    },
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
