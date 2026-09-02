import test from "node:test";
import assert from "node:assert/strict";
import { compactAccessibilityResult, compactBrowserResult, compactDomCuaResult, compactNewTabResult, compactSnapshotResult, compactTabsResult } from "../pi-extension/output.js";

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

test("Pi accessibility projection preserves AX refs and states", () => {
  const result = compactAccessibilityResult({ snapshot: {
    snapshotId: "snapshot-ax",
    accessibility: {
      mode: "full",
      children: [{ ref: "a1", role: "checkbox", name: "Agree", checked: "mixed", expanded: false, required: true }],
      state: "- checkbox \\\"Agree\\\" checked=mixed expanded=false required=true [ref=a1]",
      nodeCount: 1,
    },
  } });
  assert.match(result.state, /checked=mixed/);
  assert.match(result.state, /expanded=false/);
  assert.match(result.state, /required=true/);
  assert.ok(result.state.includes("[ref=a1]"));
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

test("Pi snapshot projection accepts an already compact Bridge response", () => {
  const result = compactSnapshotResult({
    browserId: "edge:test",
    connectionId: "connection-1",
    snapshot: { snapshotId: "snapshot-wire", state: "- button \\\"Save\\\" [ref=e1]", nodeCount: 1, charCount: 29, truncated: false },
  });
  assert.equal(result.browserId, "edge:test");
  assert.equal(result.connectionId, "connection-1");
  assert.equal(result.snapshot.state, "- button \\\"Save\\\" [ref=e1]");
  assert.equal(result.snapshot.elements, undefined);
});

test("Pi compact projections fail closed for malformed page envelopes", () => {
  const snapshot = compactBrowserResult("browser_snapshot", {}, { browserId: "edge:test", frameTree: { secret: "debug" }, raw: "payload" });
  const extract = compactBrowserResult("browser_extract", {}, { browserId: "edge:test", frameTree: { secret: "debug" }, raw: "payload" });
  const dom = compactBrowserResult("browser_dom_cua", { action: "get_visible_dom" }, { browserId: "edge:test", frameTree: { secret: "debug" }, raw: "payload" });
  assert.equal(snapshot.frameTree, undefined);
  assert.equal(snapshot.raw, undefined);
  assert.equal(extract.frameTree, undefined);
  assert.equal(extract.raw, undefined);
  assert.equal(dom.frameTree, undefined);
  assert.equal(dom.raw, undefined);
});


test("Pi new-tab projection keeps the complete fresh handle and session context", () => {
  const result = compactNewTabResult({
    browserId: "edge:test",
    groupId: 9,
    tabFence: "tab:1",
    tab: {
      id: 1,
      owner: "agent",
      lifecycle: "temporary",
      sessionId: "session-current",
      groupId: 9,
      handle: { tabId: 1, browserId: "edge:test", url: "https://example.test/", tabFence: "tab:1", incarnation: "doc-1" },
    },
  }, "session-current");
  assert.equal(result.currentAgentSessionId, "session-current");
  assert.equal(result.groupId, 9);
  assert.equal(result.tabFence, "tab:1");
  assert.equal(result.tab.handle.incarnation, "doc-1");
  assert.equal(result.tab.sessionId, "session-current");
});


test("Pi tab projection preserves a transition-pending handle without an invented document identity", () => {
  const result = compactTabsResult({
    tabs: [{
      id: 7,
      url: "https://example.test/destination",
      transitionPending: true,
      handle: { tabId: 7, browserId: "edge:test", tabFence: "tab:7" },
    }],
  });
  assert.equal(result.tabs[0].transitionPending, true);
  assert.equal(result.tabs[0].handle.incarnation, undefined);
  assert.equal(result.tabs[0].handle.url, undefined);
  assert.equal(result.tabs[0].handle.tabFence, "tab:7");
});

test("Pi tab projection annotates the current Agent session when a shared group is used", () => {
  const result = compactTabsResult({
    tabs: [
      { id: 1, owner: "user" },
      { id: 2, owner: "agent", ownership: "agent", sessionId: "session-current" },
      { id: 3, owner: "agent", ownership: "agent", sessionId: "session-other" },
      { id: 4, owner: "user", ownership: "claimed", sessionId: "session-current" },
    ],
    groups: [{ id: 9, title: "Pi", color: "blue" }],
  }, "session-current");
  assert.equal(result.currentAgentSessionId, "session-current");
  assert.equal(result.tabs[0].sessionScope, "user");
  assert.equal(result.tabs[1].sessionScope, "current-agent");
  assert.equal(result.tabs[2].sessionScope, "other-agent");
  assert.equal(result.tabs[3].sessionScope, "current-agent");
});


test("Pi tab projection removes data URL favicon", () => {
  const result = compactTabsResult({ tabs: [{ id: 1, favicon: `data:image/png;base64,${"A".repeat(1000)}` }] });
  assert.equal(result.tabs[0].favicon, undefined);
});
