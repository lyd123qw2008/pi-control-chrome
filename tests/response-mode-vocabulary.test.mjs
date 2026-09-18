/**
 * The response-mode vocabulary is owned by `bridge/response-modes.mjs`. This suite is the
 * tripwire that keeps it that way: a second copy of the list is how `structured` reached the
 * Bridge in one component and was silently dropped by another.
 *
 * Two rules, matching the two kinds of consumer:
 *
 * 1. A consumer that relays a caller's own mode must derive the vocabulary. Its source may
 *    not enumerate the modes and may not restate the rejection sentence.
 * 2. A consumer that decides on its caller's behalf may offer a subset, but every mode it
 *    names must exist, and it may not offer the whole vocabulary as a hand-written list.
 *
 * Scope and its limit: rule 1 covers an enumeration (array, `Set`, `enum`) — the shape that
 * caused the bug. A predicate that names a single mode (`mode === "raw"`) is the normal way
 * to write a policy and is deliberately not policed here; it cannot silently filter a value
 * it was never asked about, because it does not decide what is *accepted*.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RESPONSE_MODES, RESPONSE_MODES_SENTENCE, isResponseMode } from "../bridge/response-modes.mjs";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

/** A literal array listing three or more modes — a restated vocabulary, wherever it appears. */
const RESTATED_VOCABULARY = /\[(?:\s*["'](?:compact|structured|raw)["']\s*,){2,}\s*["'](?:compact|structured|raw)["']\s*\]/;

const RELAY_CONSUMERS = [
  "bridge/server.mjs",
  "codex/mcp-server.mjs",
  "skills/pi-control-chrome/scripts/browser.mjs",
];

const POLICY_CONSUMERS = [
  "pi-extension/index.ts",
  "dsh-tool-control-chrome/src/tools.ts",
];

test("the Bridge owns exactly one response-mode vocabulary", () => {
  assert.deepEqual([...RESPONSE_MODES], ["compact", "structured", "raw"]);
  assert.equal(RESPONSE_MODES_SENTENCE, "compact, structured or raw");
  assert.equal(isResponseMode("structured"), true);
  assert.equal(isResponseMode("compact"), true);
  assert.equal(isResponseMode("raw"), true);
  assert.equal(isResponseMode("verbose"), false);
  assert.equal(isResponseMode(undefined), false);
  assert.equal(isResponseMode(null), false);
  assert.equal(isResponseMode(0), false);
});

test("a consumer that relays a caller's mode derives the vocabulary", () => {
  for (const file of RELAY_CONSUMERS) {
    const source = read(file);
    assert.match(source, /response-modes\.mjs"/, `${file} must import the shared vocabulary`);
    assert.match(source, /\b(?:isResponseMode|RESPONSE_MODES)\b/, `${file} must use the shared vocabulary`);
    assert.doesNotMatch(source, RESTATED_VOCABULARY, `${file} restates the mode list instead of deriving it`);
    assert.ok(
      !source.includes("compact, structured or raw"),
      `${file} restates the rejection sentence instead of deriving RESPONSE_MODES_SENTENCE`,
    );
  }
});

test("a consumer that decides for its caller names only modes that exist", () => {
  for (const file of POLICY_CONSUMERS) {
    const modes = declaredResponseModes(read(file));
    // The floor keeps a broken extraction loud: syntax drift fails the test instead of
    // making it pass by finding nothing.
    assert.ok(modes.length >= 2, `${file}: expected to read the declared policy modes, found ${modes.length}`);
    for (const mode of modes) assert.ok(RESPONSE_MODES.includes(mode), `${file} offers unknown mode ${mode}`);
    assert.ok(
      modes.length < RESPONSE_MODES.length,
      `${file} offers every mode; it must derive the vocabulary instead of restating it`,
    );
  }
});

test("the projection dispatch is keyed by mode, not by a second list of modes", () => {
  const source = read("bridge/server.mjs");
  assert.match(source, /const RESPONSE_PROJECTIONS = new Map\(/, "the dispatch table must exist");
  for (const mode of RESPONSE_MODES) {
    if (mode === "raw") continue;
    assert.ok(source.includes(`["${mode}",`), `every non-passthrough mode needs a projection entry: ${mode}`);
  }
  // Checked inside the function body, not over the whole file: the comment above the table
  // quotes the condition it replaced, and prose about a shape is not that shape.
  const body = functionBody(source, "function responseForClient");
  for (const mode of RESPONSE_MODES) {
    assert.ok(
      !body.includes(`=== "${mode}"`) && !body.includes(`!== "${mode}"`),
      `the dispatch must ask the table about ${mode} instead of comparing it`,
    );
  }
});

/** The body of a top-level function declaration, up to its closing brace in column zero. */
function functionBody(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find ${declaration}`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}");
  return end === -1 ? rest : rest.slice(0, end);
}

/** The `const RESPONSE_MODE = ...` declaration of a policy consumer. */
function declarationBlock(source) {
  const start = source.indexOf("const RESPONSE_MODE");
  assert.notEqual(start, -1, "the response-mode declaration must exist");
  const rest = source.slice(start);
  const unionEnd = rest.indexOf("}));");
  if (unionEnd !== -1 && unionEnd < 500) return rest.slice(0, unionEnd + 4);
  const lineEnd = rest.indexOf("\n");
  return lineEnd === -1 ? rest : rest.slice(0, lineEnd);
}

/** Modes named by `Type.Literal("x")` or `enum: ['x']` inside that declaration. */
function declaredResponseModes(source) {
  const block = declarationBlock(source);
  const literals = [...block.matchAll(/Type\.Literal\("([^"]+)"\)/g)].map((match) => match[1]);
  const enums = [...block.matchAll(/enum:\s*\[([^\]]*)\]/g)]
    .flatMap((match) => [...match[1].matchAll(/['"]([a-z_]+)['"]/g)].map((literal) => literal[1]));
  return [...new Set([...literals, ...enums])];
}
