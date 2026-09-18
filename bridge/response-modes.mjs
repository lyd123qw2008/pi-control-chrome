/**
 * The one definition of the Bridge's response-mode vocabulary.
 *
 * The Bridge is the only component that validates `responseMode`, so the list lives next to
 * its validation and every other component derives it from here. Consumers fall into two
 * classes, and the difference matters:
 *
 * - A **relaying** consumer forwards a caller's own mode to the Bridge. It has to accept
 *   every mode the Bridge accepts, so it imports `isResponseMode`/`RESPONSE_MODES` rather
 *   than restating them. A restated list is a silent filter: a mode the Bridge supports but
 *   the copy has never heard of is dropped before it reaches the wire, and the read comes
 *   back unprojected with nothing to explain why. That is how `structured` was lost.
 *
 * - A **policy** consumer decides on its caller's behalf and deliberately offers a subset
 *   (`compact` for a model reading the result, `raw` for diagnosis). It may name only the
 *   modes it offers, but it must not name a mode that does not exist, and it must not
 *   restate the whole vocabulary as if it owned it.
 *
 * `tests/response-mode-vocabulary.test.mjs` holds both halves of that rule.
 */
export const RESPONSE_MODES = Object.freeze(["compact", "structured", "raw"]);

/**
 * The vocabulary as prose, for the error text a rejected mode produces. Derived so the
 * message cannot drift from the list it describes.
 */
export const RESPONSE_MODES_SENTENCE = RESPONSE_MODES.length > 1
  ? `${RESPONSE_MODES.slice(0, -1).join(", ")} or ${RESPONSE_MODES.at(-1)}`
  : String(RESPONSE_MODES[0]);

export function isResponseMode(value) {
  return typeof value === "string" && RESPONSE_MODES.includes(value);
}
