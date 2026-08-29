import test from "node:test";
import assert from "node:assert/strict";
import { compactAccessibilityResult, compactBrowserResult, compactDomCuaResult, compactSnapshotResult, compactTabsResult } from "../pi-extension/output.js";

test("Pi snapshot projection keeps refs and drops duplicate raw fields", () => {
  const result = compactSnapshotResult({
    tabId: 1,
    tab: { id: 1, title: "Orders", url: "https://example.test", favicon: `data:image/png;base64,${"A".repeat(1000)}` },
    frameTree: { debug: true },
    snapshot: { snapshotId: "snapshot-1", title: "Orders", url: "https://example.test", text: "body", elements: [{ ref: "e1", role: "button", name: "Submit" }] },
  });
  assert.match(JSON.stringify(result), /\[ref=e1\]/);
  assert.equal(result.snapshot.elements, undefined);
  assert.equal(result.frameTree, undefined);
  assert.equal(result.tab.favicon, undefined);
});

test("Pi snapshot projection avoids repeating page text for interactive pages", () => {
  const result = compactSnapshotResult({
    tab: { id: 1, title: "Orders", url: "https://example.test/orders" },
    snapshot: {
      snapshotId: "snapshot-compact",
      title: "Orders",
      url: "https://example.test/orders",
      text: "This long text is available through browser_extract.",
      elements: [{ ref: "e1", role: "button", name: "Submit", value: "" }],
    },
  });
  assert.match(result.snapshot.state, /\[ref=e1\]/);
  assert.doesNotMatch(result.snapshot.state, /Page text:/);
  assert.doesNotMatch(result.snapshot.state, /available through browser_extract/);
  assert.equal(result.snapshot.title, undefined);
  assert.equal(result.snapshot.url, undefined);
});


test("Pi snapshot projection does not mark semantic state truncated for omitted page text", () => {
  const result = compactSnapshotResult({
    snapshot: {
      snapshotId: "snapshot-semantic",
      text: "x".repeat(30_000),
      textTruncated: true,
      truncated: true,
      elementCharCount: 120,
      elements: [{ ref: "e1", role: "button", name: "Submit" }],
    },
  });
  assert.equal(result.snapshot.truncated, false);
});

test("Pi accessibility projection preserves diff metadata", () => {
  const result = compactAccessibilityResult({ snapshot: { snapshotId: "snapshot-2", accessibility: { mode: "diff", baseSnapshotId: "snapshot-1", state: "+ button \\\"Save\\\"", nodeCount: 1 } } });
  assert.equal(result.mode, "diff");
  assert.equal(result.state, "+ button \\\"Save\\\"");
  assert.equal(result.children, undefined);
});

test("Pi DOM CUA projection emits bounded node lines", () => {
  const result = compactDomCuaResult({ dom: { snapshotId: "dom-1", nodes: [{ node_id: "d1", tag: "button", text: "Submit" }] } });
  assert.match(result.dom.state, /node_id=d1/);
  assert.equal(result.dom.nodes, undefined);
});


test("Pi snapshot projection honors explicit budgets and preserves refs", () => {
  const result = compactBrowserResult("browser_snapshot", { maxChars: 80, maxNodes: 1 }, {
    snapshot: { snapshotId: "snapshot-budget", title: "Orders", url: "https://example.test", text: "x".repeat(500), elements: [{ ref: "e1", role: "button", name: "Submit" }, { ref: "e2", role: "button", name: "Cancel" }] },
  });
  assert.ok(result.snapshot.state.length <= 80);
  assert.match(result.snapshot.state, /\[ref=e1\]/);
  assert.equal(result.snapshot.nodeCount, 1);
  assert.equal(result.snapshot.truncated, true);
});

test("Pi tab projection removes data URL favicon", () => {
  const result = compactTabsResult({ tabs: [{ id: 1, favicon: `data:image/png;base64,${"A".repeat(1000)}` }] });
  assert.equal(result.tabs[0].favicon, undefined);
});
