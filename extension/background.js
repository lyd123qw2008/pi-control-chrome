const BRIDGE_ORIGIN = "http://127.0.0.1:17318";
const BRIDGE_WS = "ws://127.0.0.1:17318/ws";
const OWNED_TABS_KEY = "piControlChromeOwnedTabs";
const GROUP_TITLE = "Pi";
const GROUP_COLOR = "blue";

let socket;
let reconnectTimer;
let connectedAt;
let cachedToken;

function log(...args) {
  if (globalThis.PI_CONTROL_CHROME_DEBUG) console.debug("[pi-control-chrome]", ...args);
}

async function getPairingToken() {
  if (cachedToken) return cachedToken;
  const response = await fetch(`${BRIDGE_ORIGIN}/pair`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Bridge pairing failed: HTTP ${response.status}`);
  const data = await response.json();
  if (!data.token) throw new Error("Bridge pairing response did not contain a token");
  cachedToken = data.token;
  return cachedToken;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect().catch(() => scheduleReconnect());
  }, 1500);
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const token = await getPairingToken();
  const next = new WebSocket(`${BRIDGE_WS}?role=extension&token=${encodeURIComponent(token)}`);
  socket = next;

  next.addEventListener("open", () => {
    connectedAt = Date.now();
    log("connected to Pi bridge");
  });
  next.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type !== "request") return;
      const result = await handleRequest(message.method, message.params || {});
      send({ type: "response", id: message.id, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const id = (() => {
        try { return JSON.parse(event.data).id; } catch { return undefined; }
      })();
      send({ type: "response", id, error: { code: "BROWSER_ERROR", message } });
    }
  });
  next.addEventListener("close", () => {
    connectedAt = undefined;
    if (socket === next) socket = undefined;
    scheduleReconnect();
  });
  next.addEventListener("error", () => {
    // The close event performs the reconnect scheduling.
  });
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

async function ownedTabs() {
  const data = await chrome.storage.local.get({ [OWNED_TABS_KEY]: {} });
  return data[OWNED_TABS_KEY] || {};
}

async function saveOwnedTabs(value) {
  await chrome.storage.local.set({ [OWNED_TABS_KEY]: value });
}

async function recordOwnedTab(tab, sessionId, owner = "agent", lifecycle = "temporary") {
  const owned = await ownedTabs();
  owned[String(tab.id)] = {
    tabId: tab.id,
    windowId: tab.windowId,
    sessionId: sessionId || "default",
    createdAt: Date.now(),
    groupId: tab.groupId,
    owner,
    lifecycle,
  };
  await saveOwnedTabs(owned);
}

async function updateOwnedTab(tabId, patch) {
  const owned = await ownedTabs();
  const key = String(tabId);
  if (!owned[key]) throw new Error(`Agent-owned tab not found: ${tabId}`);
  owned[key] = { ...owned[key], ...patch };
  await saveOwnedTabs(owned);
  return owned[key];
}

async function forgetOwnedTab(tabId) {
  const owned = await ownedTabs();
  delete owned[String(tabId)];
  await saveOwnedTabs(owned);
}

async function getTab(tabId) {
  if (tabId !== undefined && tabId !== null) return chrome.tabs.get(Number(tabId));
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active[0]) throw new Error("No active browser tab is available");
  return active[0];
}

async function listGroups() {
  if (!chrome.tabGroups?.query) return [];
  const groups = await chrome.tabGroups.query({});
  return groups.map((group) => ({
    id: group.id,
    windowId: group.windowId,
    title: group.title || "",
    color: group.color,
    collapsed: Boolean(group.collapsed),
  }));
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  const owned = await ownedTabs();
  return {
    tabs: tabs.map((tab) => ({
      id: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      title: tab.title || "",
      url: tab.url || "",
      status: tab.status,
      groupId: tab.groupId,
      owner: owned[String(tab.id)]?.owner === "agent" ? "agent" : "user",
      ownership: owned[String(tab.id)]?.owner,
      sessionId: owned[String(tab.id)]?.sessionId,
      lifecycle: owned[String(tab.id)]?.lifecycle,
    })),
    groups: await listGroups(),
  };
}

async function findOrCreatePiGroup(windowId) {
  if (!chrome.tabGroups?.query) return undefined;
  const groups = await chrome.tabGroups.query({ windowId });
  const existing = groups.find((group) => group.title === GROUP_TITLE);
  return existing?.id;
}

async function putInPiGroup(tab) {
  if (!chrome.tabs.group || !chrome.tabGroups?.update || tab.id === undefined) return undefined;
  const existingGroupId = await findOrCreatePiGroup(tab.windowId);
  const groupId = existingGroupId ?? await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, {
    title: GROUP_TITLE,
    color: GROUP_COLOR,
    collapsed: false,
  });
  return groupId;
}

function visibleName(element) {
  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("name") ||
    element.getAttribute("placeholder") ||
    element.innerText?.trim() ||
    element.value ||
    element.getAttribute("title") ||
    ""
  ).replace(/\s+/g, " ").trim().slice(0, 240);
}

function collectSnapshot() {
  const getName = (element) => (
    element.getAttribute("aria-label") ||
    element.getAttribute("name") ||
    element.getAttribute("placeholder") ||
    element.innerText?.trim() ||
    element.value ||
    element.getAttribute("title") ||
    ""
  ).replace(/\s+/g, " ").trim().slice(0, 240);
  const candidates = Array.from(document.querySelectorAll(
    "a,button,input,textarea,select,summary,[role],[contenteditable=\"true\"]",
  ));
  const elements = [];
  let counter = 0;
  for (const element of candidates) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") continue;
    const ref = `e${++counter}`;
    element.setAttribute("data-pi-ref", ref);
    elements.push({
      ref,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || element.tagName.toLowerCase(),
      name: getName(element),
      value: "value" in element ? String(element.value || "").slice(0, 240) : undefined,
      disabled: Boolean(element.disabled),
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    });
    if (elements.length >= 200) break;
  }
  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 16000),
    elements,
  };
}

function findElement(ref, selector) {
  if (selector) return document.querySelector(selector);
  if (!/^e\d+$/.test(String(ref || ""))) return null;
  return document.querySelector(`[data-pi-ref="${ref}"]`);
}

function runInteraction({ operation, ref, selector, value, key, deltaX, deltaY }) {
  const resolveElement = (elementRef, elementSelector) => {
    if (elementSelector) return document.querySelector(elementSelector);
    if (!/^e\d+$/.test(String(elementRef || ""))) return null;
    return document.querySelector(`[data-pi-ref="${elementRef}"]`);
  };
  const element = resolveElement(ref, selector);
  if (!element && operation !== "scroll") throw new Error(`Element not found: ${ref || selector || "unknown"}`);
  if (operation === "click") {
    element.click();
  } else if (operation === "double_click") {
    element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
  } else if (operation === "fill") {
    element.focus();
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, String(value ?? ""));
    else element.value = String(value ?? "");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (operation === "type") {
    element.focus();
    const text = String(value ?? "");
    if ("value" in element) {
      const current = String(element.value || "");
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, current + text);
      else element.value = current + text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("insertText", false, text);
    }
  } else if (operation === "press") {
    element.focus();
    const event = new KeyboardEvent("keydown", { key: String(key || "Enter"), code: String(key || "Enter"), bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    if (String(key || "Enter") === "Enter" && element.form) element.form.requestSubmit?.();
  } else if (operation === "scroll") {
    window.scrollBy(Number(deltaX || 0), Number(deltaY || 0));
  }
  return { ok: true, operation, ref: ref || selector };
}

async function executeInTab(tabId, func, args = []) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result?.[0]?.result;
}

async function withDebugger(tabId, callback) {
  const target = { tabId: Number(tabId) };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    return await callback((method, params) => chrome.debugger.sendCommand(target, method, params));
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch {}
    }
  }
}

async function createTab(params) {
  const tab = await chrome.tabs.create({
    url: params.url || "about:blank",
    active: params.active === true,
  });
  const groupId = await putInPiGroup(tab);
  if (groupId !== undefined) {
    try { await chrome.tabs.update(tab.id, { groupId }); } catch {}
  }
  await recordOwnedTab({ ...tab, groupId }, params.sessionId, "agent", "temporary");
  return { tab: (await listTabs()).tabs.find((entry) => entry.id === tab.id), groupId };
}

async function cleanup(params) {
  const owned = await ownedTabs();
  const sessionId = params.sessionId || "default";
  const removed = [];
  const kept = { ...owned };
  const released = [];
  for (const [key, record] of Object.entries(owned)) {
    if (record.sessionId !== sessionId) continue;
    if (record.owner === "claimed") {
      released.push(Number(key));
      delete kept[key];
      continue;
    }
    if (record.owner !== "agent" || record.lifecycle !== "temporary") continue;
    try {
      await chrome.tabs.remove(Number(key));
      removed.push(Number(key));
    } catch {}
    delete kept[key];
  }
  await saveOwnedTabs(kept);
  return { removed, released };
}

async function handleRequest(method, params) {
  if (method === "status") {
    const browser = /Edg\//i.test(navigator.userAgent) ? "edge" : "chrome";
    return { connected: true, browser, bridge: BRIDGE_ORIGIN, connectedAt };
  }
  if (method === "list_tabs") return listTabs();
  if (method === "selected_tab") {
    const tab = await getTab();
    return { tab: (await listTabs()).tabs.find((entry) => entry.id === tab.id) };
  }
  if (method === "select_tab") {
    const tab = await getTab(params.tabId);
    await chrome.tabs.update(tab.id, { active: true });
    if (params.focusWindow === true) await chrome.windows.update(tab.windowId, { focused: true });
    return { tab: (await listTabs()).tabs.find((entry) => entry.id === tab.id) };
  }
  if (method === "new_tab") return createTab(params);
  if (method === "navigate") {
    const tab = await getTab(params.tabId);
    const updated = await chrome.tabs.update(tab.id, { url: String(params.url) });
    return { tab: (await listTabs()).tabs.find((entry) => entry.id === updated.id) };
  }
  if (method === "back" || method === "forward" || method === "reload") {
    const tab = await getTab(params.tabId);
    if (method === "back") await chrome.tabs.goBack(tab.id);
    if (method === "forward") await chrome.tabs.goForward(tab.id);
    if (method === "reload") await chrome.tabs.reload(tab.id, { bypassCache: params.bypassCache === true });
    return { tab: (await listTabs()).tabs.find((entry) => entry.id === tab.id) };
  }
  if (method === "close_tab") {
    const tab = await getTab(params.tabId);
    await chrome.tabs.remove(tab.id);
    await forgetOwnedTab(tab.id);
    return { closed: tab.id };
  }
  if (method === "snapshot") {
    const tab = await getTab(params.tabId);
    return { tabId: tab.id, snapshot: await executeInTab(tab.id, collectSnapshot) };
  }
  if (method === "interaction") {
    const tab = await getTab(params.tabId);
    return { tabId: tab.id, result: await executeInTab(tab.id, runInteraction, [params]) };
  }
  if (method === "screenshot") {
    const tab = await getTab(params.tabId);
    const result = await withDebugger(tab.id, (sendCommand) => sendCommand("Page.captureScreenshot", {
      format: params.format || "png",
      captureBeyondViewport: params.fullPage === true,
    }));
    return { tabId: tab.id, data: result.data, mimeType: "image/png" };
  }
  if (method === "evaluate") {
    const tab = await getTab(params.tabId);
    const result = await withDebugger(tab.id, (sendCommand) => sendCommand("Runtime.evaluate", {
      expression: String(params.expression || "undefined"),
      awaitPromise: params.awaitPromise !== false,
      returnByValue: true,
    }));
    return { tabId: tab.id, result };
  }
  if (method === "cdp") {
    const tab = await getTab(params.tabId);
    const result = await withDebugger(tab.id, (sendCommand) => sendCommand(String(params.method), params.params || {}));
    return { tabId: tab.id, result };
  }
  if (method === "claim_tab") {
    const tab = await getTab(params.tabId);
    if (params.title !== undefined && String(params.title) !== String(tab.title || "")) {
      throw new Error("Tab title changed since the claim snapshot");
    }
    if (params.url !== undefined && String(params.url) !== String(tab.url || "")) {
      throw new Error("Tab URL changed since the claim snapshot");
    }
    await recordOwnedTab(tab, params.sessionId, "claimed", "claimed");
    return { claimed: (await listTabs()).tabs.find((entry) => entry.id === tab.id) };
  }
  if (method === "release") {
    if (params.tabId !== undefined) await forgetOwnedTab(params.tabId);
    return { released: params.tabId === undefined ? [] : [Number(params.tabId)] };
  }
  if (method === "mark_handoff" || method === "mark_deliverable") {
    if (params.tabId === undefined) throw new Error("tabId is required");
    const lifecycle = method === "mark_handoff" ? "handoff" : "deliverable";
    return { tab: await updateOwnedTab(params.tabId, { lifecycle }) };
  }
  if (method === "cleanup") return cleanup(params);
  throw new Error(`Unsupported browser method: ${method}`);
}

chrome.runtime.onStartup.addListener(() => connect().catch((error) => {
  console.error("[pi-control-chrome] startup bridge connection failed", error);
  scheduleReconnect();
}));
chrome.runtime.onInstalled.addListener(() => connect().catch((error) => {
  console.error("[pi-control-chrome] install bridge connection failed", error);
  scheduleReconnect();
}));
chrome.alarms?.create("pi-control-chrome-reconnect", { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "pi-control-chrome-reconnect") connect().catch((error) => {
    console.error("[pi-control-chrome] alarm bridge connection failed", error);
    scheduleReconnect();
  });
});
connect().catch((error) => {
  console.error("[pi-control-chrome] initial bridge connection failed", error);
  scheduleReconnect();
});
