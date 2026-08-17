const BRIDGE_ORIGIN = "http://127.0.0.1:17318";
const BRIDGE_WS = "ws://127.0.0.1:17318/ws";
const OWNED_TABS_KEY = "piControlChromeOwnedTabs";
const GROUP_TITLE = "Pi";
const GROUP_COLOR = "blue";
const MAX_EVENTS = 500;

let socket;
let reconnectTimer;
let connectedAt;
let cachedToken;

const persistentDebuggers = new Map();
const devtoolsState = new Map();
const downloadState = new Map();

function log(...args) {
  if (globalThis.PI_CONTROL_CHROME_DEBUG) console.debug("[pi-control-chrome]", ...args);
}

function boundedPush(list, value) {
  list.push(value);
  if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
}

function stateForTab(tabId) {
  const id = Number(tabId);
  let state = devtoolsState.get(id);
  if (!state) {
    state = {
      console: [],
      network: [],
      lifecycle: [],
      dialog: undefined,
      fileChooser: undefined,
    };
    devtoolsState.set(id, state);
  }
  return state;
}

function remoteValue(value) {
  if (!value) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, "value")) return value.value;
  return value.unserializableValue ?? value.description ?? value.type;
}

function formatConsoleEvent(method, params) {
  if (method === "Runtime.consoleAPICalled") {
    return {
      type: "console",
      level: params.type,
      text: (params.args || []).map(remoteValue).map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(" "),
      args: (params.args || []).map(remoteValue),
      url: params.stackTrace?.callFrames?.[0]?.url,
      line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      timestamp: params.timestamp,
    };
  }
  if (method === "Log.entryAdded") {
    const entry = params.entry || {};
    return {
      type: "log",
      level: entry.level,
      text: entry.text,
      url: entry.url,
      line: entry.lineNumber,
      source: entry.source,
      timestamp: entry.timestamp,
    };
  }
  return undefined;
}

function formatNetworkEvent(method, params) {
  if (method === "Network.requestWillBeSent") {
    return {
      event: "request",
      requestId: params.requestId,
      loaderId: params.loaderId,
      url: params.request?.url,
      method: params.request?.method,
      headers: params.request?.headers,
      postData: params.request?.postData,
      type: params.type,
      timestamp: params.timestamp,
      wallTime: params.wallTime,
    };
  }
  if (method === "Network.responseReceived") {
    return {
      event: "response",
      requestId: params.requestId,
      url: params.response?.url,
      status: params.response?.status,
      statusText: params.response?.statusText,
      mimeType: params.response?.mimeType,
      headers: params.response?.headers,
      type: params.type,
      timestamp: params.timestamp,
    };
  }
  if (method === "Network.loadingFinished") {
    return { event: "finished", requestId: params.requestId, encodedDataLength: params.encodedDataLength, timestamp: Date.now() };
  }
  if (method === "Network.loadingFailed") {
    return { event: "failed", requestId: params.requestId, errorText: params.errorText, canceled: params.canceled, timestamp: Date.now() };
  }
  return undefined;
}

chrome.debugger?.onEvent?.addListener((source, method, params = {}) => {
  const tabId = source?.tabId;
  if (tabId === undefined) return;
  const state = stateForTab(tabId);
  const consoleEvent = formatConsoleEvent(method, params);
  if (consoleEvent) boundedPush(state.console, consoleEvent);
  const networkEvent = formatNetworkEvent(method, params);
  if (networkEvent) boundedPush(state.network, networkEvent);
  if (method === "Page.lifecycleEvent") boundedPush(state.lifecycle, params);
  if (method === "Page.javascriptDialogOpening") {
    state.dialog = {
      type: params.type,
      message: params.message,
      defaultPrompt: params.defaultPrompt,
      url: params.url,
      hasBrowserHandler: params.hasBrowserHandler,
    };
  }
  if (method === "Page.fileChooserOpened") {
    state.fileChooser = {
      mode: params.mode,
      backendNodeId: params.backendNodeId,
      timestamp: Date.now(),
    };
  }
});

chrome.debugger?.onDetach?.addListener((source, reason) => {
  if (source?.tabId !== undefined) {
    persistentDebuggers.delete(Number(source.tabId));
    const state = stateForTab(source.tabId);
    if (reason !== "canceled_by_user") state.debuggerDetachReason = reason;
  }
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  devtoolsState.delete(Number(tabId));
  persistentDebuggers.delete(Number(tabId));
});

chrome.downloads?.onCreated?.addListener((item) => {
  downloadState.set(item.id, {
    id: item.id,
    url: item.url,
    filename: item.filename,
    state: item.state,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    danger: item.danger,
    mime: item.mime,
    startTime: item.startTime,
    endTime: item.endTime,
  });
});

chrome.downloads?.onChanged?.addListener(async (delta) => {
  const item = await chrome.downloads.search({ id: delta.id });
  if (item[0]) {
    const current = downloadState.get(delta.id) || { id: delta.id };
    downloadState.set(delta.id, {
      ...current,
      filename: item[0].filename,
      url: item[0].url,
      state: item[0].state,
      bytesReceived: item[0].bytesReceived,
      totalBytes: item[0].totalBytes,
      danger: item[0].danger,
      mime: item[0].mime,
      startTime: item[0].startTime,
      endTime: item[0].endTime,
    });
  }
});

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
    connect().catch((error) => {
      console.error("[pi-control-chrome] reconnect failed", error);
      scheduleReconnect();
    });
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
    let id;
    try {
      const message = JSON.parse(event.data);
      id = message.id;
      if (message.type !== "request") return;
      const result = await handleRequest(message.method, message.params || {});
      send({ type: "response", id, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ type: "response", id, error: { code: "BROWSER_ERROR", message } });
    }
  });
  next.addEventListener("close", () => {
    connectedAt = undefined;
    if (socket === next) socket = undefined;
    scheduleReconnect();
  });
  next.addEventListener("error", (error) => log("bridge websocket error", error));
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
    title: tab.title || "",
    url: tab.url || "",
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

async function getTab(tabId, handle = {}) {
  const tab = tabId !== undefined && tabId !== null
    ? await chrome.tabs.get(Number(tabId))
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab) throw new Error("No active browser tab is available");
  if (handle.expectedTitle !== undefined && String(handle.expectedTitle) !== String(tab.title || "")) {
    throw new Error("Tab handle is stale: title changed; take a new browser_tabs snapshot");
  }
  if (handle.expectedUrl !== undefined && String(handle.expectedUrl) !== String(tab.url || "")) {
    throw new Error("Tab handle is stale: URL changed; take a new browser_tabs snapshot");
  }
  return tab;
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
  const userAgent = navigator.userAgent;
  const browser = /Edg\//i.test(userAgent) ? "edge" : /Chrome\//i.test(userAgent) ? "chrome" : "chromium";
  const browserId = `${browser}:${chrome.runtime.id}`;
  return {
    browserId,
    profile: "current",
    tabs: tabs.map((tab) => ({
      id: tab.id,
      browserId,
      favicon: tab.favIconUrl || "",
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
      handle: { tabId: tab.id, windowId: tab.windowId, title: tab.title || "", url: tab.url || "", groupId: tab.groupId, sessionId: owned[String(tab.id)]?.sessionId },
      stale: owned[String(tab.id)] ? ((owned[String(tab.id)].url !== (tab.url || "") || owned[String(tab.id)].title !== (tab.title || "")) && owned[String(tab.id)].owner === "claimed") : false,
    })),
    groups: await listGroups(),
  };
}

async function findOrCreatePiGroup(windowId) {
  if (!chrome.tabGroups?.query) return undefined;
  const groups = await chrome.tabGroups.query({ windowId });
  return groups.find((group) => group.title === GROUP_TITLE)?.id;
}

async function putInPiGroup(tab) {
  if (!chrome.tabs.group || !chrome.tabGroups?.update || tab.id === undefined) return undefined;
  const existingGroupId = await findOrCreatePiGroup(tab.windowId);
  const groupId = existingGroupId ?? await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false });
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

function collectAccessibilitySnapshot() {
  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase();
    if (element.getAttribute("role")) return element.getAttribute("role");
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "img") return "img";
    if (tag === "li") return "listitem";
    if (tag === "ul" || tag === "ol") return "list";
    return undefined;
  };
  const nodes = [];
  for (const element of Array.from(document.querySelectorAll("body *"))) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") continue;
    const role = implicitRole(element);
    const name = element.getAttribute("aria-label") || element.innerText?.trim().replace(/\s+/g, " ").slice(0, 240) || "";
    if (!role && !name) continue;
    nodes.push({
      role: role || "generic",
      name,
      value: "value" in element ? String(element.value || "").slice(0, 240) : undefined,
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      checked: "checked" in element ? Boolean(element.checked) : element.getAttribute("aria-checked") === "true" ? true : undefined,
      level: /^h[1-6]$/i.test(element.tagName) ? Number(element.tagName[1]) : undefined,
    });
    if (nodes.length >= 300) break;
  }
  return { role: "document", name: document.title, children: nodes };
}

function collectSnapshot() {
  const snapshotId = crypto.randomUUID();
  document.documentElement.setAttribute("data-pi-snapshot-id", snapshotId);
  const candidates = Array.from(document.querySelectorAll("a,button,input,textarea,select,summary,[role],[contenteditable=\"true\"]"));
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
      name: (
        element.getAttribute("aria-label") || element.getAttribute("name") || element.getAttribute("placeholder") ||
        element.innerText?.trim() || element.value || element.getAttribute("title") || ""
      ).replace(/\s+/g, " ").trim().slice(0, 240),
      value: "value" in element ? String(element.value || "").slice(0, 240) : undefined,
      disabled: Boolean(element.disabled),
      checked: "checked" in element ? Boolean(element.checked) : undefined,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    });
    if (elements.length >= 300) break;
  }
  return {
    snapshotId,
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 20000),
    selectedText: window.getSelection?.()?.toString() || "",
    viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
    elements,
    accessibility: undefined,
  };
}

function extractPage() {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const markdown = [];
  for (const element of Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,a"))) {
    const text = clean(element.innerText || element.textContent);
    if (!text) continue;
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) markdown.push(`${"#".repeat(Number(tag[1]))} ${text}`);
    else if (tag === "li") markdown.push(`- ${text}`);
    else if (tag === "blockquote") markdown.push(`> ${text}`);
    else if (tag === "pre") markdown.push("```\n" + (element.textContent || "") + "\n```");
    else if (tag === "a" && element.getAttribute("href")) markdown.push(`[${text}](<${element.href}>)`);
    else markdown.push(text);
  }
  return { title: document.title, url: location.href, text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 50000), markdown: [...new Set(markdown)].join("\n\n") };
}

function runInteraction({ operation, ref, selector, value, key, deltaX, deltaY, snapshotId }) {
  if (snapshotId && document.documentElement.getAttribute("data-pi-snapshot-id") !== String(snapshotId)) {
    throw new Error("Snapshot is stale; take a new browser_snapshot before using this ref");
  }
  const resolveElement = (elementRef, elementSelector) => {
    if (elementSelector) return document.querySelector(elementSelector);
    if (!/^e\d+$/.test(String(elementRef || ""))) return null;
    return document.querySelector(`[data-pi-ref="${elementRef}"]`);
  };
  const element = resolveElement(ref, selector);
  if (!element && operation !== "scroll") throw new Error(`Element not found: ${ref || selector || "unknown"}`);
  if (operation === "click") element.click();
  else if (operation === "double_click") element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
  else if (operation === "focus") element.focus();
  else if (operation === "hover") element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
  else if (operation === "fill") {
    element.focus();
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, String(value ?? "")); else element.value = String(value ?? "");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (operation === "type") {
    element.focus();
    const text = String(value ?? "");
    if ("value" in element) {
      const current = String(element.value || "");
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, current + text); else element.value = current + text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else document.execCommand("insertText", false, text);
  } else if (operation === "press") {
    element.focus();
    const event = new KeyboardEvent("keydown", { key: String(key || "Enter"), code: String(key || "Enter"), bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    element.dispatchEvent(new KeyboardEvent("keyup", { key: String(key || "Enter"), code: String(key || "Enter"), bubbles: true }));
    if (String(key || "Enter") === "Enter" && element.form) element.form.requestSubmit?.();
  } else if (operation === "select") {
    const values = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
    if (element.tagName.toLowerCase() !== "select") throw new Error("select requires a <select> element");
    for (const option of Array.from(element.options)) option.selected = values.includes(option.value) || values.includes(option.label);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (operation === "check" || operation === "uncheck" || operation === "set_checked") {
    const checked = operation === "check" ? true : operation === "uncheck" ? false : Boolean(value);
    if (!("checked" in element)) throw new Error("check/uncheck requires a checkbox or radio element");
    if (Boolean(element.checked) !== checked) element.click();
  } else if (operation === "scroll") window.scrollBy(Number(deltaX || 0), Number(deltaY || 0));
  return { ok: true, operation, ref: ref || selector };
}

async function locatorAction({ locator, action, value, key, index, attribute, hasSelector, other, timeoutMs = 5000 }) {
  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const matches = (text, matcher, exact) => exact ? normalize(text) === normalize(matcher) : normalize(text).toLowerCase().includes(normalize(matcher).toLowerCase());
  const roleOf = (element) => {
    if (element.getAttribute("role")) return element.getAttribute("role");
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "option") return "option";
    if (tag === "img") return "img";
    return undefined;
  };
  const nameOf = (element) => (
    element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("placeholder") ||
    element.innerText || element.value || element.getAttribute("title") || ""
  );
  const elementsFor = (spec) => {
    if (spec?.combine === "and" || spec?.combine === "or") {
      const left = elementsFor(spec.left);
      const right = new Set(elementsFor(spec.right));
      return spec.combine === "and" ? left.filter((element) => right.has(element)) : [...new Set([...left, ...right])];
    }
    const root = spec?.scopeSelector ? document.querySelector(spec.scopeSelector) : document;
    if (!root) return [];
    let elements = [];
    const strategy = spec?.strategy || "css";
    const valueText = spec?.value;
    if (strategy === "css") elements = Array.from(root.querySelectorAll(String(valueText || "*")));
    else if (strategy === "role") elements = Array.from(root.querySelectorAll("*"))
      .filter((element) => roleOf(element) === String(valueText) && (spec.name === undefined || matches(nameOf(element), spec.name, spec.exact)));
    else if (strategy === "text") elements = Array.from(root.querySelectorAll("*"))
      .filter((element) => matches(element.innerText || element.textContent, valueText, spec.exact))
      .filter((element) => !Array.from(element.children).some((child) => matches(child.innerText || child.textContent, valueText, spec.exact)));
    else if (strategy === "label") {
      for (const label of Array.from(root.querySelectorAll("label"))) {
        if (!matches(label.innerText, valueText, spec.exact)) continue;
        const forId = label.htmlFor;
        const control = forId ? document.getElementById(forId) : label.querySelector("input,textarea,select,button,[contenteditable=true]");
        if (control) elements.push(control);
      }
      elements.push(...Array.from(root.querySelectorAll("input,textarea,select,button,[contenteditable=true]"))
        .filter((element) => matches(element.getAttribute("aria-label"), valueText, spec.exact)));
    } else if (strategy === "placeholder") elements = Array.from(root.querySelectorAll("[placeholder]"))
      .filter((element) => matches(element.getAttribute("placeholder"), valueText, spec.exact));
    else if (strategy === "testid") elements = Array.from(root.querySelectorAll(`[data-testid="${CSS.escape(String(valueText))}"]`));
    if (spec?.hasText !== undefined) elements = elements.filter((element) => matches(element.innerText || element.textContent, spec.hasText, spec.exact));
    if (spec?.hasSelector !== undefined) elements = elements.filter((element) => element.querySelector(spec.hasSelector));
    const unique = [...new Set(elements)];
    if (spec?.index !== undefined) return unique[Number(spec.index)] ? [unique[Number(spec.index)]] : [];
    return unique;
  };
  const resolve = () => elementsFor(locator || { strategy: "css", value: "*" });
  const strict = () => {
    const elements = resolve();
    if (elements.length !== 1) throw new Error(`Locator resolved to ${elements.length} elements; add index/first/last/nth or narrow the locator`);
    return elements[0];
  };
  const describe = (element) => {
    const rect = element.getBoundingClientRect();
    return { tag: element.tagName.toLowerCase(), role: roleOf(element), name: normalize(nameOf(element)), text: normalize(element.innerText || element.textContent), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  };
  if (action === "filter") return { ...locator, hasText: value !== undefined ? String(value) : locator.hasText, hasSelector: params.hasSelector || locator.hasSelector };
  if (action === "and" || action === "or") return { combine: action, left: locator, right: other };
  if (action === "count") return resolve().length;
  if (action === "all") return resolve().map(describe);
  if (action === "allTextContents") return resolve().map((element) => element.textContent);
  if (action === "first" || action === "last" || action === "nth") return { ...locator, index: action === "first" ? 0 : action === "last" ? Math.max(0, resolve().length - 1) : Number(index) };
  if (action === "textContent") return strict().textContent;
  if (action === "innerText") return strict().innerText;
  if (action === "getAttribute") return strict().getAttribute(String(attribute));
  if (action === "isVisible") { const element = strict(); const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"; }
  if (action === "isEnabled") { const element = strict(); return !element.disabled && element.getAttribute("aria-disabled") !== "true"; }
  if (action === "focus") { strict().focus(); return { ok: true }; }
  if (["click", "dblclick", "fill", "type", "press", "select", "check", "uncheck", "set_checked", "hover"].includes(action)) {
    const element = strict();
    const rect = element.getBoundingClientRect();
    if (action === "click") element.click();
    else if (action === "dblclick") element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
    else if (action === "hover") element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    else if (action === "fill" || action === "type") {
      element.focus();
      const text = String(value ?? "");
      if ("value" in element) {
        const current = action === "type" ? String(element.value || "") : "";
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(element, current + text); else element.value = current + text;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      } else document.execCommand("insertText", false, text);
    } else if (action === "press") {
      element.focus();
      element.dispatchEvent(new KeyboardEvent("keydown", { key: String(key || "Enter"), code: String(key || "Enter"), bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { key: String(key || "Enter"), code: String(key || "Enter"), bubbles: true }));
    } else if (action === "select") {
      if (element.tagName.toLowerCase() !== "select") throw new Error("select requires a <select>");
      const values = (Array.isArray(value) ? value : [value]).map(String);
      for (const option of Array.from(element.options)) option.selected = values.includes(option.value) || values.includes(option.label);
      element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (["check", "uncheck", "set_checked"].includes(action)) {
      const checked = action === "check" ? true : action === "uncheck" ? false : Boolean(value);
      if (!("checked" in element)) throw new Error("setChecked requires a checkbox or radio");
      if (Boolean(element.checked) !== checked) element.click();
    }
    return { ok: true, element: describe(element), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }
  if (action === "waitFor") {
    const deadline = Date.now() + Math.min(Number(timeoutMs) || 5000, 30000);
    while (Date.now() < deadline) {
      const found = resolve();
      if (found.length > 0) return { ok: true, count: found.length };
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new Error("Timed out waiting for locator");
  }
  throw new Error(`Unsupported locator action: ${action}`);
}

function collectVisibleDom() {
  let counter = 0;
  const nodes = [];
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const walk = (element, parentId = undefined) => {
    if (!visible(element)) return undefined;
    const id = `d${++counter}`;
    element.setAttribute("data-pi-dom-id", id);
    const rect = element.getBoundingClientRect();
    const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const node = { node_id: id, parent_id: parentId, tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), text, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, children: [] };
    nodes.push(node);
    for (const child of Array.from(element.children)) {
      const childId = walk(child, id);
      if (childId) node.children.push(childId);
    }
    return id;
  };
  if (document.body) walk(document.body);
  return { viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, nodes: nodes.slice(0, 1000) };
}

function runDomCua({ action, nodeId, value, key, deltaX, deltaY }) {
  const element = nodeId ? document.querySelector(`[data-pi-dom-id="${CSS.escape(String(nodeId))}"]`) : undefined;
  if (!element && action !== "get_visible_dom" && action !== "scroll") throw new Error(`DOM node not found: ${nodeId}`);
  if (action === "click") element.click();
  else if (action === "double_click") element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
  else if (action === "type") {
    element.focus();
    if ("value" in element) {
      const text = String(value ?? ""); const current = String(element.value || "");
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, current + text); else element.value = current + text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else document.execCommand("insertText", false, String(value ?? ""));
  } else if (action === "keypress") {
    element.focus(); element.dispatchEvent(new KeyboardEvent("keydown", { key: String(key), code: String(key), bubbles: true, cancelable: true })); element.dispatchEvent(new KeyboardEvent("keyup", { key: String(key), code: String(key), bubbles: true }));
  } else if (action === "scroll") {
    if (element) element.scrollBy(Number(deltaX || 0), Number(deltaY || 0)); else window.scrollBy(Number(deltaX || 0), Number(deltaY || 0));
  }
  return { ok: true, action, nodeId };
}

async function executeInTab(tabId, func, args = []) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result?.[0]?.result;
}

async function attachDebugger(tabId) {
  const id = Number(tabId);
  if (persistentDebuggers.has(id)) return;
  await chrome.debugger.attach({ tabId: id }, "1.3");
  persistentDebuggers.set(id, { attachedAt: Date.now() });
}

async function detachDebugger(tabId) {
  const id = Number(tabId);
  if (!persistentDebuggers.has(id)) return;
  try { await chrome.debugger.detach({ tabId: id }); } catch {}
  persistentDebuggers.delete(id);
}

async function debuggerCommand(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, params);
}

async function withDebugger(tabId, callback) {
  const id = Number(tabId);
  const persistent = persistentDebuggers.has(id);
  if (!persistent) await attachDebugger(id);
  try { return await callback((method, params) => debuggerCommand(id, method, params)); }
  finally { if (!persistent) await detachDebugger(id); }
}

async function enableDevtools(tabId, domains = ["Runtime", "Log", "Network", "Page"]) {
  const id = Number(tabId);
  await attachDebugger(id);
  for (const domain of domains) {
    try { await debuggerCommand(id, `${domain}.enable`); } catch (error) { log(`could not enable ${domain}`, error); }
  }
  return { tabId: id, enabled: domains, attached: true };
}

async function disableDevtools(tabId) {
  await detachDebugger(tabId);
  return { tabId: Number(tabId), attached: false };
}

async function waitForTabState(tabId, params = {}) {
  const timeoutMs = Math.min(Number(params.timeoutMs || 30000), 120000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(Number(tabId));
    const urlMatches = params.url === undefined || String(tab.url || "") === String(params.url) || (params.urlIncludes && String(tab.url || "").includes(String(params.urlIncludes)));
    if ((params.state === "url" && urlMatches) || (params.state !== "url" && tab.status === "complete" && urlMatches)) return tab;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for tab ${tabId}`);
}

async function createTab(params) {
  const tab = await chrome.tabs.create({ url: params.url || "about:blank", active: params.active === true });
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
  const released = [];
  const kept = { ...owned };
  for (const [key, record] of Object.entries(owned)) {
    if (record.sessionId !== sessionId) continue;
    if (record.owner === "claimed") {
      released.push(Number(key));
      delete kept[key];
      continue;
    }
    if (record.owner !== "agent" || !["temporary", "created"].includes(record.lifecycle)) continue;
    try { await chrome.tabs.remove(Number(key)); removed.push(Number(key)); } catch {}
    delete kept[key];
  }
  await saveOwnedTabs(kept);
  if (params.detachDevtools !== false) {
    for (const tabId of [...persistentDebuggers.keys()]) await detachDebugger(tabId);
  }
  return { removed, released };
}

async function listDownloads(params = {}) {
  if (!chrome.downloads?.search) return [...downloadState.values()];
  const items = await chrome.downloads.search({ limit: Number(params.limit || 100), orderBy: ["-startTime"] });
  return items.map((item) => ({ id: item.id, url: item.url, filename: item.filename, state: item.state, bytesReceived: item.bytesReceived, totalBytes: item.totalBytes, danger: item.danger, mime: item.mime, startTime: item.startTime, endTime: item.endTime }));
}

async function waitForDownload(id, timeoutMs = 30000) {
  const deadline = Date.now() + Math.min(Number(timeoutMs) || 30000, 120000);
  while (Date.now() < deadline) {
    const items = await chrome.downloads.search({ id: Number(id) });
    const item = items[0];
    if (item && (item.state === "complete" || item.state === "interrupted")) return item;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for download ${id}`);
}

async function uploadFiles(tabId, params) {
  const files = (Array.isArray(params.files) ? params.files : [params.files]).filter(Boolean).map(String);
  if (!files.length) throw new Error("upload requires at least one file path");
  return withDebugger(tabId, async (sendCommand) => {
    await sendCommand("DOM.enable");
    let nodeId = params.nodeId ? Number(params.nodeId) : undefined;
    if (!nodeId && params.selector) {
      const document = await sendCommand("DOM.getDocument", { depth: -1, pierce: true });
      const found = await sendCommand("DOM.querySelector", { nodeId: document.root.nodeId, selector: String(params.selector) });
      nodeId = found.nodeId;
    }
    const chooser = stateForTab(tabId).fileChooser;
    if (!nodeId && chooser?.backendNodeId) {
      await sendCommand("DOM.setFileInputFiles", { backendNodeId: chooser.backendNodeId, files });
    } else if (nodeId) {
      await sendCommand("DOM.setFileInputFiles", { nodeId, files });
    } else throw new Error("No file input matched and no intercepted file chooser is available");
    return { tabId: Number(tabId), files, nodeId };
  });
}

async function clipboardText(tabId, action, text) {
  if (action === "read") {
    return executeInTab(tabId, async () => navigator.clipboard.readText());
  }
  return executeInTab(tabId, async (value) => {
    await navigator.clipboard.writeText(String(value ?? ""));
    return { ok: true };
  }, [text]);
}

function keyParts(key) {
  const value = String(key || "");
  const named = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    Delete: { key: "Delete", code: "Delete", keyCode: 46 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    Space: { key: " ", code: "Space", keyCode: 32 },
  };
  return named[value] || { key: value.length === 1 ? value : value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, keyCode: value.length === 1 ? value.toUpperCase().charCodeAt(0) : 0 };
}

async function coordinateAction(tabId, params) {
  return withDebugger(tabId, async (sendCommand) => {
    const action = params.action;
    const x = Number(params.x || 0);
    const y = Number(params.y || 0);
    if (action === "click" || action === "double_click") {
      const count = action === "double_click" ? 2 : 1;
      await sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      for (let i = 0; i < count; i += 1) {
        await sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: params.button || "left", clickCount: i + 1 });
        await sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: params.button || "left", clickCount: i + 1 });
      }
      return { ok: true, action, x, y };
    }
    if (action === "move") return sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    if (action === "scroll") return sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: Number(params.deltaX || 0), deltaY: Number(params.deltaY || 0) });
    if (action === "drag") {
      const path = Array.isArray(params.path) && params.path.length ? params.path : [{ x, y }, { x: Number(params.toX), y: Number(params.toY) }];
      const first = path[0];
      await sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: Number(first.x), y: Number(first.y) });
      await sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: Number(first.x), y: Number(first.y), button: params.button || "left", clickCount: 1 });
      for (const point of path.slice(1)) await sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: Number(point.x), y: Number(point.y), button: params.button || "left" });
      const last = path[path.length - 1];
      await sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: Number(last.x), y: Number(last.y), button: params.button || "left", clickCount: 1 });
      return { ok: true, action, path };
    }
    if (action === "type") {
      await sendCommand("Input.insertText", { text: String(params.text ?? "") });
      return { ok: true, action };
    }
    if (action === "keypress") {
      const part = keyParts(params.key);
      await sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: part.key, code: part.code, windowsVirtualKeyCode: part.keyCode, nativeVirtualKeyCode: part.keyCode });
      await sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: part.key, code: part.code, windowsVirtualKeyCode: part.keyCode, nativeVirtualKeyCode: part.keyCode });
      return { ok: true, action, key: params.key };
    }
    throw new Error(`Unsupported coordinate action: ${action}`);
  });
}

async function handleRequest(method, params) {
  if (method === "status") {
    const manifest = chrome.runtime.getManifest();
    const userAgent = navigator.userAgent;
    const browser = /Edg\//i.test(userAgent) ? "edge" : /Chrome\//i.test(userAgent) ? "chrome" : "chromium";
    return { connected: true, browser, browserId: `${browser}:${chrome.runtime.id}`, profile: "current", userAgent, extensionVersion: manifest.version, bridge: BRIDGE_ORIGIN, connectedAt };
  }
  if (method === "list_tabs") return listTabs();
  if (method === "selected_tab") {
    const tab = await getTab();
    return { tab: (await listTabs()).tabs.find((entry) => entry.id === tab.id) };
  }
  if (method === "select_tab") {
    const tab = await getTab(params.tabId, params);
    await chrome.tabs.update(tab.id, { active: true });
    if (params.focusWindow === true) await chrome.windows.update(tab.windowId, { focused: true });
    return { tab: (await listTabs()).tabs.find((entry) => entry.id === tab.id) };
  }
  if (method === "new_tab") {
    const created = await createTab(params);
    if (params.wait === true && created.tab?.id !== undefined) await waitForTabState(created.tab.id, { state: "load", timeoutMs: params.timeoutMs });
    return created;
  }
  if (method === "wait") {
    const tab = await getTab(params.tabId, params);
    const ready = await waitForTabState(tab.id, { state: params.state === "url" ? "url" : "load", url: params.url, urlIncludes: params.urlIncludes, timeoutMs: params.timeoutMs });
    return { tab: (await listTabs()).tabs.find((entry) => entry.id === ready.id) };
  }
  if (method === "navigate") {
    const tab = await getTab(params.tabId, params);
    const updated = await chrome.tabs.update(tab.id, { url: String(params.url) });
    const ready = params.wait === false ? updated : await waitForTabState(updated.id, { state: "load", timeoutMs: params.timeoutMs });
    return { tab: (await listTabs()).tabs.find((entry) => entry.id === ready.id) };
  }
  if (method === "back" || method === "forward" || method === "reload") {
    const tab = await getTab(params.tabId, params);
    if (method === "back") await chrome.tabs.goBack(tab.id);
    if (method === "forward") await chrome.tabs.goForward(tab.id);
    if (method === "reload") await chrome.tabs.reload(tab.id, { bypassCache: params.bypassCache === true });
    return { tab: (await listTabs()).tabs.find((entry) => entry.id === tab.id) };
  }
  if (method === "close_tab") {
    const tab = await getTab(params.tabId, params);
    await chrome.tabs.remove(tab.id);
    await forgetOwnedTab(tab.id);
    return { closed: tab.id };
  }
  if (method === "extract") {
    const tab = await getTab(params.tabId, params);
    return { tabId: tab.id, content: await executeInTab(tab.id, extractPage) };
  }
  if (method === "snapshot") {
    const tab = await getTab(params.tabId, params);
    const snapshot = await executeInTab(tab.id, collectSnapshot);
    if (snapshot) snapshot.accessibility = await executeInTab(tab.id, collectAccessibilitySnapshot);
    let frameTree;
    try { frameTree = await withDebugger(tab.id, (sendCommand) => sendCommand("Page.getFrameTree")); } catch {}
    return { tabId: tab.id, snapshot, frameTree };
  }
  if (method === "locator") {
    const tab = await getTab(params.tabId, params);
    return { tabId: tab.id, result: await executeInTab(tab.id, locatorAction, [params]) };
  }
  if (method === "interaction") {
    const tab = await getTab(params.tabId, params);
    return { tabId: tab.id, result: await executeInTab(tab.id, runInteraction, [params]) };
  }
  if (method === "dom_cua") {
    const tab = await getTab(params.tabId, params);
    if (params.action === "get_visible_dom") return { tabId: tab.id, dom: await executeInTab(tab.id, collectVisibleDom) };
    return { tabId: tab.id, result: await executeInTab(tab.id, runDomCua, [params]) };
  }
  if (method === "cua") {
    const tab = await getTab(params.tabId, params);
    return { tabId: tab.id, result: await coordinateAction(tab.id, params) };
  }
  if (method === "screenshot") {
    const tab = await getTab(params.tabId, params);
    const result = await withDebugger(tab.id, (sendCommand) => sendCommand("Page.captureScreenshot", { format: params.format || "png", captureBeyondViewport: params.fullPage === true }));
    return { tabId: tab.id, data: result.data, mimeType: `image/${params.format || "png"}` };
  }
  if (method === "evaluate") {
    const tab = await getTab(params.tabId, params);
    const result = await withDebugger(tab.id, (sendCommand) => sendCommand("Runtime.evaluate", { expression: String(params.expression || "undefined"), awaitPromise: params.awaitPromise !== false, returnByValue: true }));
    return { tabId: tab.id, result };
  }
  if (method === "cdp") {
    const tab = await getTab(params.tabId, params);
    const result = await withDebugger(tab.id, (sendCommand) => sendCommand(String(params.method), params.params || {}));
    return { tabId: tab.id, result };
  }
  if (method === "devtools_enable") {
    const tab = await getTab(params.tabId, params);
    return enableDevtools(tab.id, params.domains || ["Runtime", "Log", "Network", "Page"]);
  }
  if (method === "devtools_disable") return disableDevtools(params.tabId);
  if (method === "console_logs") {
    const tab = await getTab(params.tabId, params);
    await enableDevtools(tab.id, ["Runtime", "Log"]);
    const state = stateForTab(tab.id);
    const logs = [...state.console];
    if (params.clear === true) state.console.length = 0;
    return { tabId: tab.id, logs };
  }
  if (method === "network_requests") {
    const tab = await getTab(params.tabId, params);
    await enableDevtools(tab.id, ["Network", "Page"]);
    const state = stateForTab(tab.id);
    const requests = [...state.network];
    if (params.clear === true) state.network.length = 0;
    return { tabId: tab.id, requests };
  }
  if (method === "network_response_body") {
    const tab = await getTab(params.tabId, params);
    await enableDevtools(tab.id, ["Network"]);
    return { tabId: tab.id, result: await debuggerCommand(tab.id, "Network.getResponseBody", { requestId: String(params.requestId) }) };
  }
  if (method === "dialog") {
    const tab = await getTab(params.tabId, params);
    const state = stateForTab(tab.id);
    if (params.action === "get") return { tabId: tab.id, dialog: state.dialog };
    if (!["accept", "dismiss"].includes(params.action)) throw new Error("dialog action must be get, accept or dismiss");
    if (!persistentDebuggers.has(Number(tab.id))) await enableDevtools(tab.id, ["Page"]);
    await debuggerCommand(tab.id, "Page.handleJavaScriptDialog", { accept: params.action === "accept", promptText: params.promptText });
    const dialog = state.dialog;
    state.dialog = undefined;
    return { tabId: tab.id, handled: params.action, dialog };
  }
  if (method === "upload") {
    const tab = await getTab(params.tabId, params);
    await enableDevtools(tab.id, ["Page"]);
    return uploadFiles(tab.id, params);
  }
  if (method === "clipboard") {
    const tab = await getTab(params.tabId, params);
    const action = params.action === "write" ? "write" : "read";
    return { tabId: tab.id, action, text: action === "read" ? await clipboardText(tab.id, "read") : undefined, result: action === "write" ? await clipboardText(tab.id, "write", params.text) : undefined };
  }
  if (method === "download") {
    if (params.action === "list") return { downloads: await listDownloads(params) };
    if (params.action === "start") {
      if (!params.url) throw new Error("download start requires url");
      const id = await chrome.downloads.download({ url: String(params.url), filename: params.filename ? String(params.filename) : undefined, saveAs: params.saveAs === true });
      const item = params.wait === false ? (await chrome.downloads.search({ id }))[0] : await waitForDownload(id, params.timeoutMs);
      return { download: item || { id } };
    }
    if (params.action === "wait") return { download: await waitForDownload(Number(params.downloadId), params.timeoutMs) };
    if (params.action === "cancel") { await chrome.downloads.cancel(Number(params.downloadId)); return { canceled: Number(params.downloadId) }; }
    if (params.action === "erase") { const erased = await chrome.downloads.erase({ id: Number(params.downloadId) }); return { erased }; }
    throw new Error("download action must be list, start, wait, cancel or erase");
  }
  if (method === "claim_tab") {
    const tab = await getTab(params.tabId);
    if (params.windowId !== undefined && Number(params.windowId) !== Number(tab.windowId)) throw new Error("Tab window changed since the claim snapshot");
    if (params.title !== undefined && String(params.title) !== String(tab.title || "")) throw new Error("Tab title changed since the claim snapshot");
    if (params.url !== undefined && String(params.url) !== String(tab.url || "")) throw new Error("Tab URL changed since the claim snapshot");
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
