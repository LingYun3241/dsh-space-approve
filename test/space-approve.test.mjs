/**
 * Offline test harness for dsh-space-approve.
 *
 * Loads the REAL client.js in a vm sandbox with a purpose-built mini-DOM, fakes
 * the `uiSession` and `shortcuts` services, and drives both input paths:
 *   A) the official `observeFixedInput` path (normalized gesture + context)
 *   B) the document-keydown fallback used when that service is unavailable
 *
 * Run:  node test/space-approve.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..", "client.js");

/* ------------------------------- mini DOM ------------------------------- */
class Element {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.attrs = new Map();
    this.children = [];
    this.parent = null;
    this.isConnected = true;
    this.disabled = false;
    this.textContent = "";
    this.isContentEditable = false;
    this.__clicks = 0;
    this.__visible = true;
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parent;
    }
    return false;
  }
  closest(selector) {
    let current = this;
    while (current) {
      if (matchesAny(current, selector)) return current;
      current = current.parent;
    }
    return null;
  }
  matches(selector) {
    return matchesAny(this, selector);
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesAny(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  checkVisibility() {
    return this.__visible !== false;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  click() {
    this.__clicks += 1;
  }
}

class Document {
  constructor() {
    this.listeners = new Map();
    this.body = new Element("body", this);
    this.activeElement = this.body;
  }
  createElement(tag) {
    return new Element(tag, this);
  }
  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(type, event) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
  }
}

/* ---------------------------- selector engine ---------------------------- */
function parseSimple(raw) {
  const text = raw.trim();
  const tag = /^[a-zA-Z][\w-]*/.exec(text)?.[0] || null;
  const attrs = [];
  const re = /\[([^\]=]+)(?:="([^"]*)")?\]/g;
  let match;
  while ((match = re.exec(text))) attrs.push({ name: match[1], value: match[2] ?? null });
  return { tag, attrs };
}

const SELECTOR_CACHE = new Map();
function parseSelector(selector) {
  if (SELECTOR_CACHE.has(selector)) return SELECTOR_CACHE.get(selector);
  const groups = selector
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean)
    .map((group) => group.split(/\s+/).filter(Boolean).map(parseSimple));
  SELECTOR_CACHE.set(selector, groups);
  return groups;
}

function matchesSimple(node, simple) {
  if (simple.tag && node.tagName !== simple.tag.toUpperCase()) return false;
  for (const attr of simple.attrs) {
    const value = node.getAttribute(attr.name);
    if (value === null) return false;
    if (attr.value !== null && value !== attr.value) return false;
  }
  return true;
}

function matchesAny(node, selector) {
  for (const parts of parseSelector(selector)) {
    if (!matchesSimple(node, parts[parts.length - 1])) continue;
    let current = node.parent;
    let matched = true;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (current && !matchesSimple(current, parts[i])) current = current.parent;
      if (!current) {
        matched = false;
        break;
      }
      current = current.parent;
    }
    if (matched) return true;
  }
  return false;
}

/* -------------------------------- fixtures ------------------------------- */
function makeWindow() {
  const doc = new Document();
  const storage = new Map();
  const window = {
    document: doc,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    __ModuleLoader__: null,
  };
  doc.defaultView = window;
  return window;
}

function buildApprovalPanel(doc, { key = "approval:1", labels = ["拒绝", "允许一次"], visible = true } = {}) {
  const root = new Element("div", doc);
  root.setAttribute("data-approval-key", key);
  root.__visible = visible;
  const detail = new Element("div", doc);
  detail.setAttribute("data-approval-scroll", "");
  detail.setAttribute("tabindex", "0");
  root.appendChild(detail);
  const row = new Element("div", doc);
  const buttons = labels.map((label) => {
    const button = new Element("button", doc);
    button.setAttribute("type", "button");
    button.textContent = label;
    row.appendChild(button);
    return button;
  });
  root.appendChild(row);
  doc.body.appendChild(root);
  return { root, detail, buttons };
}

function makePending(key, { answerable = true, outcomeLog = [] } = {}) {
  return {
    kind: "approval",
    key,
    answerable,
    toolName: "pwsh",
    answer(outcome) {
      outcomeLog.push(outcome);
      this.answerable = false;
      return Promise.resolve();
    },
  };
}

function makeUiSession(pendingList) {
  const snapshot = new Map();
  pendingList.forEach((pending, index) => snapshot.set("session-" + index, { pendingInteraction: pending }));
  return {
    sessionStatus: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
    },
  };
}

/** Fake of the official shortcuts service: keep listeners, replay fixed input like the host does. */
function makeShortcuts() {
  const listeners = new Set();
  return {
    listeners,
    observeFixedInput(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Mirrors `fixedInput()`: later listeners see `defaultPrevented` once someone consumes. */
    emit(input) {
      let consumed = false;
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        listener({
          ...input,
          gesture: { ...input.gesture, defaultPrevented: input.gesture.defaultPrevented || consumed },
          consume: () => {
            consumed = true;
            if (typeof input.consume === "function") input.consume();
          },
        });
      }
      return consumed;
    },
  };
}

function fixedInput({ code = "Space", region = "page", modal = null, target = null, ...rest } = {}) {
  const input = {
    type: "keydown",
    gesture: {
      code,
      control: Boolean(rest.control),
      alt: Boolean(rest.alt),
      shift: Boolean(rest.shift),
      meta: Boolean(rest.meta),
      repeat: Boolean(rest.repeat),
      composing: Boolean(rest.composing),
      defaultPrevented: Boolean(rest.defaultPrevented),
    },
    context: { region, modal, target },
    consume: () => {},
  };
  return input;
}

function loadPlugin(window, { uiSession, shortcuts, config } = {}) {
  const doc = window.document;
  const out = { window, doc, exports: null, error: null, dispose: null };
  window.__ModuleLoader__ = {
    load(definition) {
      try {
        out.exports = definition.factory(() => {
          throw new Error("no modules available");
        });
      } catch (error) {
        out.error = error;
      }
    },
  };
  const sandbox = {
    window,
    document: doc,
    Element,
    localStorage: window.localStorage,
    console,
    Promise,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  try {
    vm.runInContext(readFileSync(CLIENT, "utf8"), vm.createContext(sandbox), { filename: CLIENT });
  } catch (error) {
    out.error = error;
  }
  if (out.exports && typeof out.exports.apply === "function") {
    try {
      out.exports.apply(
        {
          get: (name) => (name === "uiSession" ? uiSession : name === "shortcuts" ? shortcuts : undefined),
          effect: (fn) => {
            out.dispose = fn();
            return out.dispose;
          },
        },
        config,
      );
    } catch (error) {
      out.error = error;
    }
  }
  return out;
}

function pressDom(loaded, { key = " ", code = "Space", target, defaultPrevented = false, ...rest } = {}) {
  const doc = loaded.doc;
  const event = {
    key,
    code,
    target: target || doc.activeElement || doc.body,
    defaultPrevented,
    repeat: Boolean(rest.repeat),
    isComposing: Boolean(rest.isComposing),
    keyCode: rest.keyCode || 0,
    ctrlKey: Boolean(rest.ctrlKey),
    metaKey: Boolean(rest.metaKey),
    altKey: Boolean(rest.altKey),
    shiftKey: Boolean(rest.shiftKey),
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
  doc.dispatch("keydown", event);
  return event;
}

/* -------------------------------- tests ---------------------------------- */
const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? "   [" + detail + "]" : ""}`);
}

function outcomesOf(pending) {
  return pending.__outcomes;
}
function trackedPending(key, options = {}) {
  const outcomes = [];
  const pending = makePending(key, { ...options, outcomeLog: outcomes });
  pending.__outcomes = outcomes;
  return pending;
}

console.log("=".repeat(78));
console.log("A. official shortcuts path (observeFixedInput)");
console.log("=".repeat(78));

/* A1 — registration */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  const loaded = loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  check("A1 bundle applies without error", loaded.exports && !loaded.error, loaded.error ? String(loaded.error) : "");
  check("A1 subscribes exactly one fixed-input listener", shortcuts.listeners.size === 1, `size=${shortcuts.listeners.size}`);
}

/* A2 — Space approves once */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const consumed = shortcuts.emit(fixedInput());
  check("A2 Space answers allowed-once exactly once", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("A2 Space is consumed", consumed === true);
  check("A2 no button clicked", panel.buttons.every((button) => button.__clicks === 0));
}

/* A3 — editable region is typing */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const consumed = shortcuts.emit(fixedInput({ region: "editable" }));
  check("A3 editable region passes through", consumed === false && outcomesOf(pending).length === 0);
}

/* A4 — IME composition */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const consumed = shortcuts.emit(fixedInput({ composing: true }));
  check("A4 composing Space never approves", consumed === false && outcomesOf(pending).length === 0);
}

/* A5 — key repeat */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const consumed = shortcuts.emit(fixedInput({ repeat: true }));
  check("A5 held Space never re-fires", consumed === false && outcomesOf(pending).length === 0);
}

/* A6 — chorded Space */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const consumed = shortcuts.emit(fixedInput({ control: true }));
  check("A6 Ctrl+Space is left alone", consumed === false && outcomesOf(pending).length === 0);
}

/* A7 — Escape rejects */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const consumed = shortcuts.emit(fixedInput({ code: "Escape" }));
  check("A7 Escape answers rejected", JSON.stringify(outcomesOf(pending)) === '["rejected"]', JSON.stringify(outcomesOf(pending)));
  check("A7 Escape is consumed", consumed === true);
}

/* A8 — Escape can be disabled by config */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts, config: { escape: false } });
  const consumed = shortcuts.emit(fixedInput({ code: "Escape" }));
  check("A8 config { escape: false } disables Escape", consumed === false && outcomesOf(pending).length === 0);
  const spaceConsumed = shortcuts.emit(fixedInput());
  check("A8 Space still works when Escape is disabled", spaceConsumed === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]');
}

/* A9 — unrelated modal */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const consumed = shortcuts.emit(fixedInput({ modal: "other" }));
  check("A9 an unrelated modal suppresses approval", consumed === false && outcomesOf(pending).length === 0);
}

/* A10 — focus still in an editor */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const textarea = new Element("textarea", window.document);
  window.document.body.appendChild(textarea);
  textarea.focus();
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const consumed = shortcuts.emit(fixedInput());
  check("A10 focus in a textarea blocks approval", consumed === false && outcomesOf(pending).length === 0);
}

/* A11 / A12 — hidden and inert panels */
{
  const window = makeWindow();
  buildApprovalPanel(window.document, { visible: false });
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  check("A11 hidden panel is not answerable", shortcuts.emit(fixedInput()) === false && outcomesOf(pending).length === 0);
}
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  const inert = new Element("div", window.document);
  inert.setAttribute("inert", "");
  window.document.body.appendChild(inert);
  inert.appendChild(panel.root);
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  check("A12 panel inside [inert] is not answerable", shortcuts.emit(fixedInput()) === false && outcomesOf(pending).length === 0);
}

/* A13 — ambiguous split view */
{
  const window = makeWindow();
  buildApprovalPanel(window.document, { key: "approval:1" });
  buildApprovalPanel(window.document, { key: "approval:2" });
  const shortcuts = makeShortcuts();
  const first = trackedPending("approval:1");
  const second = trackedPending("approval:2");
  loadPlugin(window, { uiSession: makeUiSession([first, second]), shortcuts });
  check("A13 multiple visible panels are ignored", shortcuts.emit(fixedInput()) === false && outcomesOf(first).length === 0 && outcomesOf(second).length === 0);
}

/* A14 — panel/pending key mismatch */
{
  const window = makeWindow();
  buildApprovalPanel(window.document, { key: "approval:1" });
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:9");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  check("A14 key mismatch is ignored", shortcuts.emit(fixedInput()) === false && outcomesOf(pending).length === 0);
}

/* A15 — already settled */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1", { answerable: false });
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  check("A15 settled request is not answered again", shortcuts.emit(fixedInput()) === false && outcomesOf(pending).length === 0);
}

/* A16 — Always-allow card */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document, { labels: ["拒绝", "允许一次", "始终允许"] });
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  shortcuts.emit(fixedInput());
  check("A16 Always-allow card answers allowed-once only", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("A16 no button clicked (cannot hit Always allow)", panel.buttons.every((button) => button.__clicks === 0));
}

/* A17 — stale panel without a pending request */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  loadPlugin(window, { uiSession: makeUiSession([]), shortcuts });
  check("A17 stale panel with no pending request is ignored", shortcuts.emit(fixedInput()) === false);
}

/* A18 — the reported flow: focus is on a sidebar button after switching sessions */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  const sidebar = new Element("button", window.document);
  window.document.body.appendChild(sidebar);
  sidebar.focus();
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const consumed = shortcuts.emit(fixedInput({ target: sidebar }));
  check("A18 Space approves although focus sits on a sidebar button", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("A18 the key is consumed so the sidebar button is not activated", consumed === true);
  check("A18 card buttons untouched", panel.buttons.every((button) => button.__clicks === 0));
}

/* A19 — focus on the card's Reject button keeps native activation */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  panel.buttons[0].focus();
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const consumed = shortcuts.emit(fixedInput({ target: panel.buttons[0] }));
  check("A19 focused Reject keeps its native Space rejection", consumed === false && outcomesOf(pending).length === 0);
}

/* A20 — reading the detail region still approves */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  panel.detail.focus();
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const consumed = shortcuts.emit(fixedInput({ target: panel.detail }));
  check("A20 Space on the detail region approves once", consumed === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]');
}

/* A21 — second press */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const first = shortcuts.emit(fixedInput());
  const second = shortcuts.emit(fixedInput());
  check("A21 second Space does not answer again", first === true && second === false && outcomesOf(pending).length === 1, JSON.stringify(outcomesOf(pending)));
}

/* A22 — missing uiSession */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  loadPlugin(window, { shortcuts });
  check("A22 missing uiSession disables the plugin", shortcuts.listeners.size === 0);
}

/* A23 — answer() throws: no fallback click */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = {
    kind: "approval",
    key: "approval:1",
    answerable: true,
    answer() {
      throw new Error("already settled");
    },
  };
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const consumed = shortcuts.emit(fixedInput());
  check("A23 failed semantic answer does not click a button", consumed === false && panel.buttons.every((button) => button.__clicks === 0));
}

/* A24 — answer() rejects: contained, still consumed, no click */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = {
    kind: "approval",
    key: "approval:1",
    answerable: true,
    answer() {
      return Promise.reject(new Error("host refused"));
    },
  };
  loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  const consumed = shortcuts.emit(fixedInput());
  check("A24 rejected answer is contained and consumed", consumed === true && panel.buttons.every((button) => button.__clicks === 0));
}

/* A25 — unload */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const shortcuts = makeShortcuts();
  const pending = trackedPending("approval:1");
  const loaded = loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  loaded.dispose();
  check("A25 unload removes the fixed-input listener", shortcuts.listeners.size === 0 && shortcuts.emit(fixedInput()) === false);
}

console.log("\n" + "=".repeat(78));
console.log("B. document keydown fallback (no shortcuts service)");
console.log("=".repeat(78));

/* B1 — Space approves from the page region */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  const pending = trackedPending("approval:1");
  const loaded = loadPlugin(window, { uiSession: makeUiSession([pending]) });
  check("B1 fallback bundle applies", loaded.exports && !loaded.error, loaded.error ? String(loaded.error) : "");
  const event = pressDom(loaded);
  check("B1 Space answers allowed-once", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("B1 Space is consumed (no page scroll)", event.defaultPrevented === true);
  check("B1 no button clicked", panel.buttons.every((button) => button.__clicks === 0));
}

/* B2 — typing keeps Space */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const textarea = new Element("textarea", window.document);
  window.document.body.appendChild(textarea);
  textarea.focus();
  const pending = trackedPending("approval:1");
  const loaded = loadPlugin(window, { uiSession: makeUiSession([pending]) });
  const event = pressDom(loaded, { target: textarea });
  check("B2 Space typed in a textarea is not intercepted", event.defaultPrevented === false && outcomesOf(pending).length === 0);
}

/* B3 — Escape rejects */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const pending = trackedPending("approval:1");
  const loaded = loadPlugin(window, { uiSession: makeUiSession([pending]) });
  const event = pressDom(loaded, { key: "Escape", code: "Escape" });
  check("B3 Escape answers rejected", JSON.stringify(outcomesOf(pending)) === '["rejected"]', JSON.stringify(outcomesOf(pending)));
  check("B3 Escape is consumed", event.defaultPrevented === true);
}

/* B4 — focus on a control outside the card */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const sidebar = new Element("button", window.document);
  window.document.body.appendChild(sidebar);
  sidebar.focus();
  const pending = trackedPending("approval:1");
  const loaded = loadPlugin(window, { uiSession: makeUiSession([pending]) });
  const event = pressDom(loaded, { target: sidebar });
  check("B4 Space approves although focus is on a sidebar button", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("B4 the key is consumed", event.defaultPrevented === true);
}

/* B5 — the official handler already answered */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const pending = trackedPending("approval:1");
  const loaded = loadPlugin(window, { uiSession: makeUiSession([pending]) });
  const event = pressDom(loaded, { defaultPrevented: true });
  check("B5 an already handled key is not answered twice", event.defaultPrevented === true && outcomesOf(pending).length === 0);
}

/* B6 — fallback click when the host has no answer() */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document, { labels: ["拒绝", "允许一次", "始终允许"] });
  const pending = { kind: "approval", key: "approval:1", answerable: true };
  const loaded = loadPlugin(window, { uiSession: makeUiSession([pending]) });
  pressDom(loaded);
  check(
    "B6 fallback clicks Allow once, never Always allow",
    panel.buttons[1].__clicks === 1 && panel.buttons[0].__clicks === 0 && panel.buttons[2].__clicks === 0,
    `clicks=[${panel.buttons.map((button) => button.__clicks)}]`,
  );
}

/* B7 — unload */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const pending = trackedPending("approval:1");
  const loaded = loadPlugin(window, { uiSession: makeUiSession([pending]) });
  loaded.dispose();
  const event = pressDom(loaded);
  check("B7 unload removes the DOM listener", event.defaultPrevented === false && outcomesOf(pending).length === 0);
}

console.log("\n" + "=".repeat(78));
console.log("C. capture-phase priority and dual-path safety");
console.log("=".repeat(78));

/* C1 — a control-level handler that swallows Space must not block approval */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const pending = trackedPending("approval:1");
  const shortcuts = makeShortcuts();
  const loaded = loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  // Simulates the focused sidebar row swallowing Space after us.
  window.document.addEventListener("keydown", (event) => {
    if (event.key === " ") event.preventDefault();
  });
  const event = pressDom(loaded);
  check("C1 capture handler acts before a later preventDefault", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("C1 the key is consumed", event.defaultPrevented === true);
}

/* C2 — both paths installed, DOM acts, official path never doubles */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const pending = trackedPending("approval:1");
  const shortcuts = makeShortcuts();
  const loaded = loadPlugin(window, { uiSession: makeUiSession([pending]), shortcuts });
  check("C2 both paths are installed", shortcuts.listeners.size === 1);
  pressDom(loaded);
  // The DOM path answered and stopped propagation; replaying the host's own
  // normalized input for the same press must not answer a second time.
  shortcuts.emit(fixedInput());
  check("C2 a replayed host input does not answer twice", outcomesOf(pending).length === 1, JSON.stringify(outcomesOf(pending)));
}

/* -------------------------------- summary -------------------------------- */
const passed = results.filter((result) => result.pass).length;
console.log("\n" + "=".repeat(78));
console.log(`RESULT: ${passed}/${results.length} checks passed`);
console.log("=".repeat(78));
if (passed !== results.length) process.exitCode = 1;
