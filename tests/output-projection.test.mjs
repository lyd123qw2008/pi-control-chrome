import test from "node:test";
import assert from "node:assert/strict";
import { capabilityRuntime, compactAccessibilityResult, compactBridgeHealth, compactBrowserResult, compactDoctorResult, compactDomCuaResult, compactExtractResult, compactNewTabResult, compactSnapshotResult, compactStatusResult, compactTabsResult, runtimeDiagnosis } from "../pi-extension/output.js";

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

test("Pi snapshot projection retains an unsettled observation signal", () => {
  const result = compactSnapshotResult({
    tab: { id: 1, title: "Loading", url: "https://example.test/loading" },
    snapshot: { snapshotId: "snapshot-loading", unsettled: true, settleSamples: 8, elements: [{ ref: "e1", role: "button", name: "Save" }] },
  });
  assert.equal(result.snapshot.unsettled, true);
  assert.equal(result.snapshot.settleSamples, 8);
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


test("Pi snapshot projection renders the neutral document-order page digest", () => {
  const result = compactSnapshotResult({
    tab: { id: 1, title: "Jenkins", url: "https://ci.example/job/demo/build" },
    snapshot: {
      snapshotId: "snapshot-page-map",
      text: "Prose that must not be used as a ranking signal.",
      elements: [
        { ref: "e1", role: "link", name: "#702" },
        { ref: "e2", role: "link", name: "#701" },
      ],
      pageMap: {
        version: 2,
        order: "document",
        title: "FXYF2_docker_5g-os-console #706",
        url: "https://ci.example/job/demo/706/",
        status: ["Build is running"],
        metadata: [{ key: "revision", value: "abc123" }],
        regions: [
          {
            kind: "form",
            role: "search",
            name: "search",
            counts: { controls: 2 },
            address: { role: "search", name: "search" },
            ref: "e30",
            controls: [
              { role: "searchbox", name: "search", ref: "e31" },
              { role: "button", name: "Search", ref: "e32" },
            ],
          },
          {
            kind: "content",
            role: "content",
            name: "Build #706",
            counts: { controls: 4, items: 33, values: 2 },
            address: { selector: "#main-panel" },
            ref: "e40",
            controls: [{ role: "link", name: "Console Output", href: "https://ci.example/job/demo/706/console", ref: "e41" }],
            values: [{ key: "revision", value: "abc123" }],
            text: "Took 2 min 8 sec on 192.169.2.81",
          },
        ],
        omitted: { regions: 2, controls: 41 },
        truncated: true,
      },
    },
  });
  const state = result.snapshot.state;
  // Neutral: no ranking vocabulary, no invented "primary object", no key-action ranking.
  assert.doesNotMatch(state, /Primary/);
  assert.doesNotMatch(state, /Key actions/);
  assert.match(state, /Regions \(document order\):/);
  assert.match(state, /URL: https:\/\/ci\.example\/job\/demo\/706\//);
  assert.match(state, /- form "search"/);
  assert.match(state, /- content "Build #706"/);
  // Document order: the search region is listed before the content region.
  assert.ok(state.indexOf('form "search"') < state.indexOf('content "Build #706"'));
  // Addressability: each region can be reached again.
  assert.match(state, /\{search "search"\}/);
  assert.match(state, /\{selector=#main-panel\}/);
  assert.match(state, /\(controls=4, items=33, values=2\)/);
  assert.match(state, /Console Output.*\[ref=e41\]/);
  assert.match(state, /values: revision=abc123/);
  assert.match(state, /Status:/);
  // Retrieval contract: omission is reported with counts and a next step.
  assert.deepEqual(result.snapshot.omitted, { regions: 2, controls: 41 });
  assert.equal(result.snapshot.nextAction, "browser_snapshot");
  assert.equal(result.snapshot.recommendation, "narrow_read");
  assert.match(result.snapshot.recovery, /browser_extract/);
  assert.equal(result.snapshot.truncated, true);
});

test("Pi Page Map projection keeps a listed region addressable when nothing is omitted", () => {
  const result = compactSnapshotResult({
    snapshot: {
      snapshotId: "snapshot-plain",
      pageMap: {
        version: 2,
        order: "document",
        title: "Order A-1001",
        url: "https://shop.example/orders/A-1001",
        metadata: [
          { key: "order id", value: "A-1001" },
          { key: "total", value: "128.00" },
        ],
        regions: [
          { kind: "main", role: "main", name: "Order A-1001", counts: { controls: 1 }, address: { role: "main", name: "Order A-1001" }, ref: "e1", controls: [{ role: "button", name: "Pay", ref: "e2" }] },
        ],
      },
    },
  });
  assert.match(result.snapshot.state, /Page: Order A-1001/);
  assert.match(result.snapshot.state, /order id: A-1001/);
  assert.match(result.snapshot.state, /total: 128\.00/);
  assert.match(result.snapshot.state, /- main "Order A-1001"/);
  assert.equal(result.snapshot.omitted, undefined);
  assert.equal(result.snapshot.nextAction, undefined);
  // Absent, not false: every other bounded read uses `truncated` to mean "this answer is
  // incomplete", so its presence is the signal and a complete read does not carry the field.
  assert.equal(result.snapshot.truncated, undefined);
});

test("Pi Page Map projection reports state truncation with a next step", () => {
  const result = compactSnapshotResult({
    snapshot: {
      snapshotId: "snapshot-truncated",
      pageMap: {
        version: 2,
        order: "document",
        title: "Build",
        url: "https://ci.example/job/demo/1/",
        regions: [{ kind: "form", role: "form", name: "Build", counts: { controls: 3 }, controls: [{ role: "textbox", name: "Branch", ref: "e1" }] }],
      },
    },
  }, 30, 10);
  assert.equal(result.snapshot.stateTruncated, true);
  assert.equal(result.snapshot.truncated, true);
  assert.equal(result.snapshot.nextAction, "browser_snapshot");
  assert.equal(result.snapshot.recommendation, "narrow_read");
});
test("Pi extract projection preserves bounded log-match metadata", () => {
  const result = compactExtractResult({
    content: {
      scope: "log",
      logMatch: "Finished:",
      matchedLineCount: 3,
      matchedLineNumbers: [4, 8, 12],
      matchTruncated: true,
      text: "Finished: SUCCESS",
      markdown: "Finished: SUCCESS",
    },
  });
  assert.equal(result.content.scope, "log");
  assert.equal(result.content.logMatch, "Finished:");
  assert.equal(result.content.matchedLineCount, 3);
  assert.deepEqual(result.content.matchedLineNumbers, [4, 8, 12]);
  assert.equal(result.content.matchTruncated, true);
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
  assert.equal(result.snapshot.truncated, undefined);
  assert.equal(result.snapshot.omitted, undefined);
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
  const withDurableRef = compactDomCuaResult({ dom: { snapshotId: "dom-1", nodes: [{ node_id: "d1", tag: "button", text: "Submit", ref: "e4" }] } });
  assert.match(withDurableRef.dom.state, /node_id=d1 ref=e4/, "a DOM-CUA node names its document-scoped ref when one exists");
  assert.equal(result.dom.nodes, undefined);
});


test("Pi raw response mode preserves the bounded diagnostic envelope", () => {
  const raw = {
    tabId: 1,
    frameTree: { debug: "kept only on explicit raw request" },
    snapshot: { snapshotId: "raw-snapshot", text: "Raw diagnostic page", elements: [{ ref: "e1", role: "button", name: "Build" }] },
  };
  assert.equal(compactBrowserResult("browser_snapshot", { responseMode: "raw" }, raw), raw);
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

test("Pi snapshot projection includes bounded embedded-frame context", () => {
  const result = compactBrowserResult("browser_snapshot", {}, {
    snapshot: {
      snapshotId: "snapshot-frame",
      state: "Interactive elements:\n- link \\\"Pages\\\" [ref=e1]",
      nodeCount: 1,
      frameSummaries: [{ framePath: "mainFrame", name: "mainFrame", readable: true, title: "Business page", text: "Customer chatbot" }],
      frameCount: 1,
    },
  });
  assert.match(result.snapshot.state, /Embedded frames:/);
  assert.match(result.snapshot.state, /Customer chatbot/);
  assert.equal(result.snapshot.frames[0].name, "mainFrame");
  assert.equal(result.snapshot.frames[0].text, undefined);
  assert.equal(result.snapshot.frameCount, 1);
});

test("Pi extract projection preserves frame diagnostics without raw frame payloads", () => {
  const result = compactBrowserResult("browser_extract", {}, {
    content: {
      title: "Prototype shell",
      text: "Pages\\nCustomer chatbot",
      markdown: "Pages",
      frameSummaries: [{ framePath: "mainFrame", readable: false, reason: "cross_origin", url: "https://private.example/frame", text: "must not leak" }],
      frameFailures: 1,
    },
  });
  assert.equal(result.content.frames[0].reason, "cross_origin");
  assert.equal(result.content.frames[0].text, undefined);
  assert.equal(result.content.frameFailures, 1);
  assert.doesNotMatch(JSON.stringify(result), /must not leak/);
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

test("Pi status projection prints identity and the capability revision once", () => {
  const status = compactStatusResult({
    connected: true,
    state: "connected",
    browser: "edge",
    browserId: "edge:profile",
    profile: "profile",
    userAgent: "Mozilla/5.0 ...",
    extensionVersion: "0.6.0",
    capabilityRevision: 8,
    capabilities: { tabIncarnationFence: true, waitTerminalStates: true },
    bridge: "http://127.0.0.1:17318",
    connectedAt: 1,
    connectionId: "connection-1",
    connectionGeneration: 2,
    targetStability: {
      stable: true,
      changed: false,
      acknowledged: true,
      requiresAcknowledgement: false,
      competition: "verified",
      browser: "edge",
      browserId: "edge:profile",
      profile: "profile",
      connectionId: "connection-1",
      connectionGeneration: 2,
      observedBrowserIds: ["edge:profile"],
    },
    bridgeHealth: {
      ok: true,
      bridgeVersion: "0.6.0",
      port: 17318,
      extensionConnected: true,
      readyTargetCount: 1,
      targets: [{ browser: "edge", browserId: "edge:profile" }],
      observability: { metrics: { requests: 9 }, recentEvents: [{ event: "internal" }] },
    },
    recommendation: "ready",
    issues: [],
    notices: [],
    recovery: "restart the Bridge",
  });
  assert.deepEqual(status, {
    connected: true,
    state: "connected",
    browser: "edge",
    extensionVersion: "0.6.0",
    browserId: "edge:profile",
    profile: "profile",
    connectionId: "connection-1",
    connectionGeneration: 2,
    connectedAt: 1,
    capabilityRevision: 8,
    bridge: { ok: true, version: "0.6.0", port: 17318, extensionConnected: true, readyTargets: 1 },
    targetStability: { stable: true, changed: false, acknowledged: true, requiresAcknowledgement: false, competition: "verified" },
    recommendation: "ready",
  });
  const serialized = JSON.stringify(status);
  for (const diagnostic of ["capabilities", "bridgeHealth", "observability", "recentEvents", "userAgent", "targets", "internal"]) {
    assert.doesNotMatch(serialized, new RegExp(diagnostic));
  }
});

test("Pi status projection keeps selection and recovery detail actionable", () => {
  const selection = compactStatusResult({
    connected: false,
    state: "target_required",
    targetRequired: true,
    completed: false,
    retryable: true,
    nextAction: "browser_status",
    recommendation: "select_browser_target",
    error: { code: "TARGET_REQUIRED", message: "Multiple browser targets are connected; provide browserId to select one." },
    targets: [{ browser: "edge", browserId: "edge:a", profile: "a", state: "ready", connectionId: "c1", connectionGeneration: 3 }],
    bridgeHealth: { ok: true, extensionConnected: true },
  });
  assert.deepEqual(selection.targets, [{ browser: "edge", browserId: "edge:a", profile: "a", state: "ready" }]);
  assert.equal(selection.error.code, "TARGET_REQUIRED");
  assert.equal(selection.completed, false);
  assert.equal(selection.retryable, true);
  assert.equal(selection.nextAction, "browser_status");

  const lost = compactStatusResult({
    connected: false,
    state: "target_unavailable",
    recommendation: "refresh_browser_targets",
    error: { code: "TARGET_UNAVAILABLE", message: "The selected target disconnected." },
    target: { browser: "edge", browserId: "edge:a", connectionId: "c1", connectionGeneration: 3 },
    targetStability: { stable: false, changed: true, previousBrowser: "edge", previousBrowserId: "edge:a", browser: "edge", browserId: "edge:a" },
    recovery: "restart the Bridge",
    issues: [{ code: "TARGET_UNAVAILABLE", message: "The selected target disconnected." }],
  });
  assert.deepEqual(lost.target, { browser: "edge", browserId: "edge:a" });
  assert.equal(lost.targetStability.previousBrowserId, "edge:a");
  assert.equal(lost.targetStability.connectionGeneration, undefined);
  assert.equal(lost.recovery, "restart the Bridge");
});

test("Pi page digest publishes each label:value pair once across nested regions", () => {
  const region = (name, extra) => ({
    kind: "content",
    role: "content",
    name,
    ref: `e${name.length}`,
    counts: { controls: 1, items: 2, values: 1 },
    controls: [{ role: "button", name: `${name} action`, ref: `e${name.length}0` }],
    values: [{ key: "revision", value: "abc123" }],
    text: name,
    ...extra,
  });
  const result = compactSnapshotResult({
    snapshot: {
      snapshotId: "snapshot-values",
      url: "https://example.test",
      title: "Nested values",
      pageMap: {
        version: 2,
        order: "document",
        title: "Nested values",
        url: "https://example.test",
        regions: [region("outer"), region("inner"), region("sibling", { values: [{ key: "revision", value: "abc123" }, { key: "branch", value: "dev" }] })],
        metadata: [],
        omitted: {},
        truncated: false,
      },
    },
  });
  const lines = result.snapshot.state.split("\n").filter((line) => /^\s*values:/.test(line));
  // The pair appears once (first region in document order) but the distinct sibling pair stays.
  assert.equal((result.snapshot.state.match(/revision=abc123/g) ?? []).length, 1);
  assert.equal((result.snapshot.state.match(/branch=dev/g) ?? []).length, 1);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /revision=abc123/);
  assert.match(lines[1], /branch=dev/);
});

test("Pi tab projection reports a bounded listing as retrievable", () => {  const result = compactTabsResult({
    browserId: "edge:test",
    profile: "profile",
    totalTabs: 40,
    matchedTabs: 12,
    omittedTabs: 4,
    filters: { query: "orders" },
    tabs: [{ id: 1, title: "orders 1", url: "https://example.test" }],
  });
  assert.equal(result.totalTabs, 40);
  assert.equal(result.matchedTabs, 12);
  assert.equal(result.omittedTabs, 4);
  assert.deepEqual(result.filters, { query: "orders" });
  assert.equal(result.nextAction, "browser_tabs");
  assert.equal(result.recommendation, "narrow_tab_query");

  const complete = compactTabsResult({ totalTabs: 3, matchedTabs: 3, tabs: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  assert.equal(complete.omittedTabs, undefined);
  assert.equal(complete.recommendation, undefined);
});

test("Pi bounded reads report what a budget dropped and how to retrieve it", () => {
  // Extract: over-budget prose is retrieved by reading a known subtree, not by widening the read.
  const extract = compactExtractResult({ content: { text: "x".repeat(200), sourceCharacters: 1200, scope: "body" } }, 200);
  assert.equal(extract.truncated, true);
  assert.equal(extract.omitted.characters, 1000);
  assert.equal(extract.nextAction, "browser_extract");
  assert.equal(extract.recommendation, "narrow_read");
  assert.match(extract.recovery, /selector/);

  const whole = compactExtractResult({ content: { text: "short", sourceCharacters: 5 } }, 200);
  assert.equal(whole.truncated, undefined);
  assert.equal(whole.omitted, undefined);
  assert.equal(whole.nextAction, undefined);

  // A selective read answers with matching lines or the document tail, so a longer source drops
  // nothing from the answer: no misleading truncation flag and no misleading omission count.
  const logMatchRead = compactBrowserResult("browser_extract", { logMatch: "ERROR", tail: true }, {
    content: { scope: "log", logMatch: "ERROR", matchedLineCount: 0, text: "", sourceCharacters: 4_901 },
  }, 300);
  assert.equal(logMatchRead.truncated, undefined);
  assert.equal(logMatchRead.omitted, undefined);

  const cutMatches = compactBrowserResult("browser_extract", { logMatch: "finished", tail: true }, {
    content: { scope: "log", logMatch: "finished", matchedLineCount: 80, matchTruncated: true, truncated: true, text: "line", sourceCharacters: 9_000 },
  }, 300);
  assert.equal(cutMatches.truncated, true);
  assert.equal(cutMatches.omitted, undefined);
  assert.match(cutMatches.recovery, /logMaxMatches/);

  const tailRead = compactBrowserResult("browser_extract", { tail: true }, {
    content: { scope: "log", text: "end of the log", sourceCharacters: 4_901 },
  }, 200);
  assert.equal(tailRead.truncated, undefined);

  // Console and network listings are retrieved by their cursor instead of by re-reading.
  const console12 = compactBrowserResult("browser_console", {}, { tabId: 1, logs: [{ text: "a" }], logCount: 1, logTotalCount: 250, logTruncated: true, nextSince: "cursor-2", only: "all" });
  assert.equal(console12.truncated, true);
  assert.equal(console12.omitted.events, 249);
  assert.equal(console12.nextAction, "browser_console");
  assert.match(console12.recovery, /since/);
  assert.equal(console12.nextSince, "cursor-2");
  assert.equal(console12.logs.length, 1);

  const consoleComplete = compactBrowserResult("browser_console", {}, { tabId: 1, logs: [{ text: "a" }], logCount: 1, logTotalCount: 1, logTruncated: false });
  assert.equal(consoleComplete.truncated, undefined);
  assert.equal(consoleComplete.omitted, undefined);

  const network = compactBrowserResult("browser_network", {}, { tabId: 1, requests: [{ url: "https://example.test" }], requestCount: 1, requestTotalCount: 40, requestTruncated: true });
  assert.equal(network.truncated, true);
  assert.equal(network.omitted.requests, 39);
  assert.equal(network.nextAction, "browser_network");
});

test("Pi accessibility and evaluate reads report their dropped detail", () => {
  // Chromium AX: the captured total is exact, so the omission count is exact. The precompact path
  // reads a flat observation (state at the top level).
  const accessibility = compactAccessibilityResult({
    tabId: 1,
    mode: "full",
    state: "- button \"One\"\n- button \"Two\"",
    nodeCount: 2,
    sourceNodeCount: 900,
    truncated: true,
    maxNodes: 2,
    maxChars: 8_000,
  }, 8_000, 2);
  assert.equal(accessibility.truncated, true);
  assert.equal(accessibility.omitted.nodes, 898);
  assert.equal(accessibility.sourceNodeCount, 900);
  assert.equal(accessibility.nextAction, "browser_accessibility_snapshot");
  assert.match(accessibility.recovery, /selector/);

  // Evaluate: the extension counts what each depth/array/field/string budget dropped.
  const evaluate = compactBrowserResult("browser_evaluate", {}, {
    tabId: 1,
    result: { result: { type: "object", value: { items: [1, 2] } }, outputTruncated: true, outputOmitted: { items: 5, fields: 2, characters: 7 } },
  });
  assert.equal(evaluate.truncated, true);
  assert.deepEqual(evaluate.omitted, { items: 5, fields: 2, characters: 7 });
  assert.equal(evaluate.nextAction, "browser_evaluate");
  assert.match(evaluate.recovery, /browser_extract/);
  assert.deepEqual(evaluate.result.result.value, { items: [1, 2] });

  const complete = compactBrowserResult("browser_evaluate", {}, { tabId: 1, result: { result: { type: "number", value: 3 } } });
  assert.equal(complete.truncated, undefined);
  assert.equal(complete.omitted, undefined);
});

test("Pi keeps what a first projection reported when the payload is projected again", () => {
  // Real path: the Bridge projects a compact snapshot, then a host (or the bundled CLI) projects
  // that already compacted payload again. The second hop used to recompute its own omission set, so
  // a bounded digest came back as `truncated: true` with `omitted: {}` — incomplete, and silent
  // about what was missing. The upstream counts and guidance must survive the second hop.
  const bridge = compactSnapshotResult({
    snapshot: {
      snapshotId: "snapshot-hop-1",
      pageMap: {
        version: 2,
        order: "document",
        title: "Build #701",
        url: "https://ci.example/job/demo/701/",
        regions: [{ kind: "main", role: "main", name: "Build #701", counts: { controls: 2 }, controls: [{ role: "link", name: "Console", ref: "e1" }] }],
        omitted: { regions: 3, controls: 41, characters: 900 },
        truncated: true,
      },
    },
  });
  assert.equal(bridge.snapshot.truncated, true);
  assert.deepEqual(bridge.snapshot.omitted, { regions: 3, controls: 41, characters: 900 });

  const host = compactSnapshotResult({ ...bridge });
  assert.equal(host.snapshot.truncated, true);
  assert.deepEqual(host.snapshot.omitted, { regions: 3, controls: 41, characters: 900 });
  assert.equal(host.snapshot.nextAction, "browser_snapshot");
  assert.equal(host.snapshot.recommendation, "narrow_read");
  assert.match(host.snapshot.recovery, /browser_snapshot/);
  assert.equal(host.snapshot.state, bridge.snapshot.state);

  // A tighter budget on the second hop adds its own cut to the total instead of replacing it.
  const narrowed = compactSnapshotResult({ ...bridge }, 40);
  assert.equal(narrowed.snapshot.truncated, true);
  assert.ok(narrowed.snapshot.omitted.characters > 900, `expected the second cut to add up, got ${narrowed.snapshot.omitted.characters}`);
  assert.equal(narrowed.snapshot.omitted.regions, 3);
  assert.equal(narrowed.snapshot.omitted.controls, 41);

  // Truncated without an omission count must never surface as an empty object.
  const silent = compactSnapshotResult({ snapshot: { snapshotId: "snapshot-silent", state: "- button \"Save\"", nodeCount: 1, truncated: true } });
  assert.equal(silent.snapshot.truncated, true);
  assert.equal(silent.snapshot.omitted, undefined);
  assert.equal(silent.snapshot.nextAction, "browser_snapshot");
});

test("Pi visible-DOM and AX reads name what they dropped", () => {
  // A truncated visible-DOM read used to return a bare `truncated: true`.
  const dom = compactBrowserResult("browser_dom_cua", { action: "get_visible_dom", maxNodes: 2 }, {
    tabId: 1,
    dom: {
      snapshotId: "dom-1",
      viewport: { width: 800, height: 600 },
      nodes: [{ node_id: "n1", tag: "div", text: "one" }, { node_id: "n2", tag: "div", text: "two" }, { node_id: "n3", tag: "div", text: "three" }],
      nodeCount: 3,
    },
  });
  assert.equal(dom.dom.truncated, true);
  assert.equal(dom.dom.omitted.nodes, 1);
  assert.equal(dom.dom.nextAction, "browser_dom_cua");
  assert.match(dom.dom.recovery, /browser_dom_cua/);

  // The same read projected twice keeps the count.
  const again = compactBrowserResult("browser_dom_cua", { action: "get_visible_dom", maxNodes: 2 }, { ...dom });
  assert.equal(again.dom.truncated, true);
  assert.equal(again.dom.omitted.nodes, 1);

  // The children path of an AX read reports its own cut too.
  const ax = compactAccessibilityResult({ snapshot: { snapshotId: "ax-1", accessibility: {
    mode: "full",
    nodeCount: 3,
    children: [{ role: "button", name: "One" }, { role: "button", name: "Two" }, { role: "button", name: "Three" }],
  } } }, 8_000, 2);
  assert.equal(ax.truncated, true);
  assert.equal(ax.omitted.nodes, 1);
  assert.equal(ax.nextAction, "browser_accessibility_snapshot");
});

test("Pi reports a shadow-root boundary instead of an empty-looking page", () => {
  const digest = compactSnapshotResult({
    snapshot: {
      title: "Shadow host",
      url: "https://example.test/shadow",
      pageMap: {
        version: 2,
        order: "document",
        title: "Shadow host",
        url: "https://example.test/shadow",
        regions: [{ kind: "content", role: "content", name: "host", ref: "e1", counts: { controls: 0 }, text: "host" }],
        metadata: [],
        omitted: {},
        truncated: false,
        shadowRoots: 3,
      },
    },
  });
  assert.match(digest.snapshot.state, /3 shadow root\(s\) are outside this digest/);
  assert.match(digest.snapshot.state, /shadowRoot/);

  const clean = compactSnapshotResult({
    snapshot: { pageMap: { version: 2, order: "document", title: "Plain", url: "https://example.test", regions: [], metadata: [], omitted: {}, truncated: false } },
  });
  assert.doesNotMatch(clean.snapshot.state, /shadow root/);
});

test("Pi extract reports which automatic scope root it chose", () => {
  const automatic = compactExtractResult({ content: { scope: "log", text: "line", resolvedScope: "log", resolvedRoot: "#build-log", shadowRoots: 2 } }, 200);
  assert.equal(automatic.content.resolvedScope, "log");
  assert.equal(automatic.content.resolvedRoot, "#build-log");
  assert.equal(automatic.content.shadowRoots, 2);

  const explicit = compactExtractResult({ content: { scope: "selector", text: "line" } }, 200);
  assert.equal(explicit.content.resolvedScope, undefined);
  assert.equal(explicit.content.resolvedRoot, undefined);
});

const extensionCapabilities = { turnCleanup: true, tabIncarnationFence: true, waitTerminalStates: true, extractLogMatch: true };
const bridgeHealthFixture = () => ({
  ok: true,
  protocol: 1,
  service: "pi-control-chrome",
  bridgeVersion: "0.6.0",
  instanceId: "bridge-1",
  startedBy: "dsh",
  controlDomain: "local_user",
  port: 17318,
  extensionConnected: true,
  targetCount: 1,
  readyTargetCount: 1,
  targetAmbiguous: false,
  capabilities: { compactResponses: true, localUserRestart: true },
  restart: { available: true, method: "cooperative_restart" },
  browser: "edge",
  browserId: "edge:test",
  profile: "profile",
  extensionVersion: "0.6.0",
  extensionCapabilityRevision: 8,
  extensionCapabilities,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Edg/152",
  connectionId: "connection-1",
  connectionGeneration: 1,
  targets: [{ browser: "edge", browserId: "edge:test", profile: "profile", extensionVersion: "0.6.0", capabilityRevision: 8, capabilities: extensionCapabilities, userAgent: "Mozilla/5.0 ...", connectionId: "connection-1", connectionGeneration: 1, state: "ready" }],
  observability: {
    startedAt: 1,
    pendingRequests: 0,
    drainingRequests: 0,
    metrics: { requests: 4 },
    targetRecovery: { trackedTargets: 1, readyTargets: 1, disconnectedTargets: 0 },
    targetLeases: { activeCount: 0, heldTargets: [] },
    recentEvents: [
      { event: "internal" },
      { event: "target_connected", at: 2, browserId: "edge:test", connectionId: "connection-1", connectionGeneration: 1 },
    ],
  },
});

test("Pi bridge-health projection keeps one capability map and one target inventory", () => {
  const health = compactBridgeHealth(bridgeHealthFixture());
  assert.deepEqual(health.capabilities, { compactResponses: true });
  assert.equal(health.extensionCapabilities, undefined);
  assert.equal(health.userAgent, undefined);
  assert.equal(health.extensionCapabilityRevision, 8);
  assert.deepEqual(health.targets, [{ browser: "edge", browserId: "edge:test", profile: "profile", extensionVersion: "0.6.0", capabilityRevision: 8, connectionId: "connection-1", connectionGeneration: 1, state: "ready" }]);
  assert.deepEqual(health.observability.recentEvents.map((event) => event.event), ["target_connected"]);
  const serialized = JSON.stringify(health);
  assert.doesNotMatch(serialized, /userAgent/);
  assert.doesNotMatch(serialized, /extensionCapabilities/);
});

test("Pi doctor projection prints every fact once and stays diagnostic", () => {
  const result = compactDoctorResult({
    bridgeHealth: bridgeHealthFixture(),
    ok: true,
    state: "connected",
    connected: true,
    browser: "edge",
    browserId: "edge:test",
    profile: "profile",
    extensionVersion: "0.6.0",
    targetStability: { stable: true, changed: false, browser: "edge", browserId: "edge:test", connectionId: "connection-1", connectionGeneration: 1 },
    runtime: { extensionVersion: "0.6.0", capabilityRevision: 8, requiredCapabilityRevision: 8, fresh: true, capabilities: extensionCapabilities },
    targets: [{ browser: "edge", browserId: "edge:test", profile: "profile", state: "ready", connectionId: "connection-1" }],
    recommendation: "ready",
    issues: [],
    notices: [],
    recovery: { available: true, method: "cooperative_restart" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, "connected");
  assert.equal(result.browserId, "edge:test");
  assert.deepEqual(result.runtime.capabilities, extensionCapabilities);
  assert.equal(result.runtime.fresh, true);
  assert.equal(result.runtime.requiredCapabilityRevision, 8);
  // Diagnostics stay available...
  assert.deepEqual(result.bridgeHealth.observability.metrics, { requests: 4 });
  assert.equal(result.bridgeHealth.targetAmbiguous, false);
  assert.deepEqual(result.targets, [{ browser: "edge", browserId: "edge:test", profile: "profile", state: "ready" }]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.notices, []);
  assert.equal(result.recovery.method, "cooperative_restart");
  // ...but the capability map is printed exactly once, in `runtime`.
  assert.equal(result.capabilities, undefined);
  const serialized = JSON.stringify(result);
  assert.equal((serialized.match(/tabIncarnationFence/g) ?? []).length, 1);
  assert.equal((serialized.match(/userAgent/g) ?? []).length, 0);
  assert.equal((serialized.match(/extensionCapabilities/g) ?? []).length, 0);
});

test("Pi runtime diagnosis names a stale or unversioned extension runtime", () => {
  // The Bridge doctor payload reports the map as extensionCapabilities/extensionCapabilityRevision.
  const fromBridgeDoctor = capabilityRuntime(bridgeHealthFixture());
  assert.deepEqual(fromBridgeDoctor, { extensionVersion: "0.6.0", capabilityRevision: 8, requiredCapabilityRevision: 8, fresh: true, capabilities: extensionCapabilities });

  const stale = runtimeDiagnosis({ ...bridgeHealthFixture(), extensionCapabilityRevision: 7 });
  assert.equal(stale.runtime.fresh, false);
  assert.equal(stale.stale.code, "extension_runtime_stale");
  assert.equal(stale.unversioned, undefined);

  const unversioned = runtimeDiagnosis({ extensionVersion: "0.5.9", extensionCapabilities });
  assert.equal(unversioned.runtime.capabilityRevision, undefined);
  assert.equal(unversioned.stale, undefined);
  assert.equal(unversioned.unversioned.code, "extension_runtime_unversioned");

  // An extension status payload reports the same facts as capabilities/capabilityRevision.
  const fromStatus = capabilityRuntime({ extensionVersion: "0.6.0", capabilityRevision: 8, capabilities: extensionCapabilities });
  assert.deepEqual(fromStatus, fromBridgeDoctor);
});
