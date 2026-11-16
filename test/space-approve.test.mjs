/**
 * Offline harness for dsh-space-approve.
 *
 * Loads the REAL client.js in a vm sandbox with a mini-DOM that models what the
 * original harness lacked and what the mutation audit proved was untested:
 *
 *   - event propagation: capture down (window → document → … → target), target,
 *     bubble up, with `stopPropagation()`/`stopImmediatePropagation()` honored and
 *     the registration capture flag recorded;
 *   - the host's fixed-input path: a fake `shortcuts` service listens on `window`
 *     BUBBLE (like the real `dsh-client-shortcuts`) and normalizes the event, so
 *     "the DOM path stops propagation" is observable as "the fixed path never saw it";
 *   - a controllable clock (the P0 cooldown) and a MutationObserver that reports
 *     DOM insertions (the card-appearance timestamp);
 *   - `ctx.inject`, including a deferred activation that models the startup race.
 *
 * Run:  node test/space-approve.test.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLIENT = join(ROOT, "client.js");

/* -------------------------------- events -------------------------------- */
class Event {
  constructor(type) {
    this.type = type;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.immediateStopped = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
  stopImmediatePropagation() {
    this.propagationStopped = true;
    this.immediateStopped = true;
  }
}

/* ------------------------------- mini DOM ------------------------------- */
class Element {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.attrs = new Map();
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.isConnected = true;
    this.disabled = false;
    this.textContent = "";
    this.isContentEditable = false;
    this.style = {};
    this.dataset = {};
    this.__clicks = 0;
    this.__visible = true;
    this.__rects = true;
    this.__computed = null;
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    return this;
  }
  removeAttribute(name) {
    this.attrs.delete(name);
  }
  appendChild(child) {
    // A real DOM moves the node; the old harness kept it in two parents, which made
    // the [inert] case silently take the multi-panel branch.
    if (child.parent && child.parent !== this) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    this.ownerDocument.notifyMutation({ type: "childList", target: this, addedNodes: [child], removedNodes: [] });
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
    this.ownerDocument.notifyMutation({ type: "childList", target: this, addedNodes: [], removedNodes: [child] });
    return child;
  }
  remove() {
    if (this.parent) this.parent.removeChild(this);
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
  addEventListener(type, fn, options) {
    const capture = options === true || Boolean(options && options.capture);
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ fn, capture });
  }
  removeEventListener(type, fn, options) {
    const capture = options === true || Boolean(options && options.capture);
    const list = this.listeners.get(type) || [];
    const index = list.findIndex((entry) => entry.fn === fn && entry.capture === capture);
    if (index >= 0) list.splice(index, 1);
  }
  checkVisibility() {
    return this.__visible !== false;
  }
  getClientRects() {
    return this.__rects === false ? [] : [{ width: 100, height: 20 }];
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
    this.window = null;
    this.defaultView = null;
    this.observers = new Set();
    this.body = new Element("body", this);
    this.documentElement = new Element("html", this);
    this.documentElement.appendChild(this.body);
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
  addEventListener(type, fn, options) {
    const capture = options === true || Boolean(options && options.capture);
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ fn, capture });
  }
  removeEventListener(type, fn, options) {
    const capture = options === true || Boolean(options && options.capture);
    const list = this.listeners.get(type) || [];
    const index = list.findIndex((entry) => entry.fn === fn && entry.capture === capture);
    if (index >= 0) list.splice(index, 1);
  }
  notifyMutation(record) {
    if (this.observers.size === 0) return;
    for (const callback of [...this.observers]) {
      try {
        callback([record]);
      } catch {
        /* observer failures are the implementation's problem, not the harness's */
      }
    }
  }
}

class Window {
  constructor(doc) {
    this.document = doc;
    this.listeners = new Map();
    this.localStorage = null;
    this.__ModuleLoader__ = null;
  }
  addEventListener(type, fn, options) {
    const capture = options === true || Boolean(options && options.capture);
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ fn, capture });
  }
  removeEventListener(type, fn, options) {
    const capture = options === true || Boolean(options && options.capture);
    const list = this.listeners.get(type) || [];
    const index = list.findIndex((entry) => entry.fn === fn && entry.capture === capture);
    if (index >= 0) list.splice(index, 1);
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

/* ------------------------------ propagation ------------------------------ */
function propagationPath(target) {
  const doc = target.ownerDocument || target;
  const chain = [];
  let node = target;
  while (node && node !== doc) {
    chain.unshift(node);
    node = node.parent;
  }
  return [doc.window, doc, ...chain];
}

function invoke(node, event, capture) {
  const list = node.listeners && node.listeners.get(event.type);
  if (!list || list.length === 0) return;
  event.currentTarget = node;
  for (const entry of [...list]) {
    if (entry.capture !== capture) continue;
    entry.fn.call(node, event);
    if (event.immediateStopped) break;
  }
}

function dispatchEvent(target, event) {
  const path = propagationPath(target);
  event.target = target;
  for (const node of path) {
    if (event.propagationStopped) return event;
    invoke(node, event, true);
  }
  const reversed = [...path].reverse();
  for (const node of reversed) {
    if (event.propagationStopped) return event;
    invoke(node, event, false);
  }
  return event;
}

/* -------------------------------- fixtures ------------------------------- */
function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

function makeMutationObserver(doc) {
  return class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.records = [];
    }
    observe() {
      doc.observers.add(this.callback);
    }
    disconnect() {
      doc.observers.delete(this.callback);
    }
    takeRecords() {
      return [];
    }
  };
}

function makeWorld({ storageThrows = false } = {}) {
  const doc = new Document();
  const window = new Window(doc);
  window.localStorage = storageThrows
    ? {
        getItem() {
          throw new Error("storage blocked");
        },
        setItem() {},
        removeItem() {},
      }
    : makeStorage();
  doc.window = window;
  doc.defaultView = {
    getComputedStyle(element) {
      if (element.__computed) return element.__computed;
      return { display: element.style.display || "block", visibility: element.style.visibility || "visible" };
    },
  };
  const clock = { t: 0 };
  const logs = [];
  return {
    doc,
    window,
    clock,
    logs,
    Date: { now: () => clock.t },
    MutationObserver: makeMutationObserver(doc),
    advance(ms) {
      clock.t += ms;
    },
    warnings: () => logs.filter((entry) => entry.level === "warn"),
    infos: () => logs.filter((entry) => entry.level === "info"),
  };
}

/** Host-side visibility rule, used by the fake fixed-input service to derive `context.modal`. */
function looksVisible(element) {
  if (!element || element.isConnected === false) return false;
  let node = element;
  while (node) {
    if (node.getAttribute && node.getAttribute("inert") !== null) return false;
    if (node.style && node.style.display === "none") return false;
    node = node.parent;
  }
  if (element.checkVisibility() === false) return false;
  if (element.getClientRects().length === 0) return false;
  return true;
}

function topModalElement(doc) {
  let nodes;
  try {
    nodes = Array.from(doc.querySelectorAll('[role="dialog"][aria-modal="true"], [role="menu"]'));
  } catch {
    return null;
  }
  const visible = nodes.filter(looksVisible);
  return visible.length === 0 ? null : visible[visible.length - 1];
}

/**
 * Fake of the official shortcuts service. It installs the host's own window
 * BUBBLE keydown listener (dsh-client-shortcuts uses `window.addEventListener`),
 * derives `gesture`/`context` from the DOM event, and only then calls the
 * subscribed fixed-input listeners — so answering with `stopPropagation()` on
 * document capture genuinely prevents the second path from running.
 */
function makeShortcuts(world) {
  const listeners = new Set();
  let delivered = 0;
  const normalize = (event) => {
    const element = event.target;
    const region =
      element && element.closest && element.closest(".xterm")
        ? "terminal"
        : element && element.closest && element.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
          ? "editable"
          : "page";
    const modal = topModalElement(world.doc);
    return {
      type: "keydown",
      gesture: {
        code: event.code,
        control: Boolean(event.ctrlKey),
        alt: Boolean(event.altKey),
        shift: Boolean(event.shiftKey),
        meta: Boolean(event.metaKey),
        repeat: Boolean(event.repeat),
        composing: Boolean(event.isComposing) || event.keyCode === 229,
        defaultPrevented: Boolean(event.defaultPrevented),
      },
      context: { region, modal: modal ? (modal.dataset.shortcutModal ?? "other") : null, target: element },
    };
  };
  world.window.addEventListener("keydown", (event) => {
    const input = normalize(event);
    let consumed = false;
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      delivered += 1;
      listener({
        ...input,
        gesture: { ...input.gesture, defaultPrevented: input.gesture.defaultPrevented || consumed },
        consume: () => {
          consumed = true;
          event.preventDefault();
        },
      });
    }
    if (consumed) event.preventDefault();
  });
  return {
    listeners,
    get delivered() {
      return delivered;
    },
    observeFixedInput(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Direct replay, as if the host had emitted this input (no DOM event involved). */
    emit(input) {
      let consumed = false;
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        delivered += 1;
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

function buildPanel(world, { key = "approval:1", labels = ["拒绝", "允许一次"], visible = true, parent } = {}) {
  const doc = world.doc;
  const root = doc.createElement("div");
  root.setAttribute("data-approval-key", key);
  root.__visible = visible;
  const detail = doc.createElement("div");
  detail.setAttribute("data-approval-scroll", "");
  detail.setAttribute("tabindex", "0");
  root.appendChild(detail);
  const row = doc.createElement("div");
  const buttons = labels.map((label) => {
    const button = doc.createElement("button");
    button.setAttribute("type", "button");
    button.textContent = label;
    row.appendChild(button);
    return button;
  });
  root.appendChild(row);
  (parent || doc.body).appendChild(root);
  return { root, detail, row, buttons };
}

function makePending(key, { kind = "approval", answerable = true, answer } = {}) {
  const outcomes = [];
  const pending = {
    kind,
    key,
    answerable,
    toolName: "pwsh",
    outcomes,
    answer(outcome) {
      if (answer) return answer.call(this, outcome, outcomes);
      outcomes.push(outcome);
      this.answerable = false;
      return Promise.resolve();
    },
  };
  return pending;
}

function makeUiSession(pendings, hooks = {}) {
  const snapshot = new Map();
  pendings.forEach((pending, index) => snapshot.set("session-" + index, { running: true, pendingInteraction: pending }));
  return {
    sessionStatus: {
      getSnapshot: hooks.getSnapshot || (() => snapshot),
      subscribe: () => () => {},
    },
  };
}

function fixedInput({ code = "Space", region = "page", modal = null, target = null, ...rest } = {}) {
  return {
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
}

function loadPlugin(world, options = {}) {
  const { uiSession, shortcuts, config, noInject = false, uiSessionViaProperty = false, deferShortcuts = false, noEffect = false } = options;
  const doc = world.doc;
  const disposers = [];
  const scope = {
    shortcuts,
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
  };
  const ctx = {
    uiSession,
    get(name) {
      if (name === "uiSession") return uiSessionViaProperty ? undefined : uiSession;
      if (name === "shortcuts") return shortcuts;
      return undefined;
    },
  };
  if (!noEffect) {
    ctx.effect = (fn) => {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    };
  }
  if (!noInject) {
    ctx.inject = (deps, callback) => {
      if (deferShortcuts) ctx.__activateShortcuts = () => callback(scope);
      else callback(scope);
      return () => {};
    };
  }
  const out = {
    world,
    doc,
    exports: null,
    error: null,
    ctx,
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* disposal failures are covered by their own cases */
        }
      }
    },
  };
  world.window.__ModuleLoader__ = {
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
    window: world.window,
    document: doc,
    Element,
    MutationObserver: world.MutationObserver,
    localStorage: world.window.localStorage,
    console: {
      info: (...args) => world.logs.push({ level: "info", args }),
      warn: (...args) => world.logs.push({ level: "warn", args }),
      error: (...args) => world.logs.push({ level: "error", args }),
    },
    Promise,
    setTimeout,
    clearTimeout,
    Date: world.Date,
  };
  sandbox.globalThis = sandbox;
  try {
    vm.runInContext(readFileSync(CLIENT, "utf8"), vm.createContext(sandbox), { filename: CLIENT });
  } catch (error) {
    out.error = error;
  }
  if (out.exports && typeof out.exports.apply === "function") {
    try {
      out.exports.apply(ctx, config);
    } catch (error) {
      out.error = error;
    }
  }
  return out;
}

/**
 * One isolated world plus panel/pending/fixture wiring.
 * `settle` advances the clock past the default cooldown, so ordinary cases model
 * "the card has been on screen for a while".
 */
function scenario(options = {}) {
  const world = makeWorld({ storageThrows: options.storageThrows });
  if (options.storage) {
    for (const [key, value] of Object.entries(options.storage)) world.window.localStorage.setItem(key, value);
  }
  const shortcuts = options.shortcuts === false ? null : makeShortcuts(world);
  const pendings = options.pendings || [];
  const uiSession = "uiSession" in options ? options.uiSession : makeUiSession(pendings, options.sessionHooks);
  const panels = (options.panels || []).map((spec) => buildPanel(world, spec));
  const loaded = loadPlugin(world, {
    uiSession,
    shortcuts,
    config: options.config,
    noInject: options.noInject ?? options.shortcuts === false,
    uiSessionViaProperty: options.uiSessionViaProperty,
    deferShortcuts: options.deferShortcuts,
    noEffect: options.noEffect,
  });
  if (options.settle !== false) world.advance(typeof options.settle === "number" ? options.settle : 1000);
  const doc = world.doc;
  const s = {
    world,
    doc,
    shortcuts,
    pendings,
    panels,
    loaded,
    uiSession,
    fixed(opts = {}) {
      return fixedInput({ ...opts, target: "target" in opts ? opts.target : doc.body });
    },
    emit(opts = {}) {
      return shortcuts ? shortcuts.emit(s.fixed(opts)) : false;
    },
    key(opts = {}) {
      return fireKey(s, opts);
    },
    event(type, init = {}) {
      const event = new Event(type);
      Object.assign(event, init);
      return dispatchEvent(doc.body, event);
    },
    lastDecision() {
      const diag = world.window.__dshSpaceApprove;
      return diag && Array.isArray(diag.decisions) ? diag.decisions[diag.decisions.length - 1] : undefined;
    },
    lastInput() {
      const diag = world.window.__dshSpaceApprove;
      return diag && Array.isArray(diag.inputs) ? diag.inputs[diag.inputs.length - 1] : undefined;
    },
    diag() {
      return world.window.__dshSpaceApprove;
    },
  };
  return s;
}

function fireKey(s, { key = " ", code = "Space", target, ...rest } = {}) {
  const event = new Event("keydown");
  Object.assign(event, {
    key,
    code,
    keyCode: rest.keyCode || 0,
    repeat: Boolean(rest.repeat),
    isComposing: Boolean(rest.isComposing),
    defaultPrevented: Boolean(rest.defaultPrevented),
    ctrlKey: Boolean(rest.ctrlKey),
    altKey: Boolean(rest.altKey),
    shiftKey: Boolean(rest.shiftKey),
    metaKey: Boolean(rest.metaKey),
  });
  const node = target || s.doc.activeElement || s.doc.body;
  return dispatchEvent(node, event);
}

/* -------------------------------- reporting ------------------------------ */
const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? "   [" + detail + "]" : ""}`);
}

const outcomesOf = (pending) => pending.outcomes;

/* ============================== A. fixed input ============================ */
console.log("=".repeat(78));
console.log("A. official shortcuts path (observeFixedInput)");
console.log("=".repeat(78));

{
  const s = scenario({ panels: [{}], pendings: [makePending("approval:1")] });
  check("A1 bundle applies without error", s.loaded.exports && !s.loaded.error, s.loaded.error ? String(s.loaded.error) : "");
  check("A1 subscribes exactly one fixed-input listener", s.shortcuts.listeners.size === 1, `size=${s.shortcuts.listeners.size}`);
  check("A1 boot mode is dom+shortcuts", s.diag() && s.diag().boot && s.diag().boot.mode === "dom+shortcuts", s.diag() && JSON.stringify(s.diag().boot));
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const consumed = s.emit();
  check("A2 Space answers allowed-once exactly once", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("A2 Space is consumed", consumed === true);
  check("A2 no button clicked", s.panels[0].buttons.every((button) => button.__clicks === 0));
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const consumed = s.emit({ region: "editable" });
  check("A3 editable region passes through", consumed === false && outcomesOf(pending).length === 0);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const consumed = s.emit({ composing: true });
  check("A4 composing Space never approves", consumed === false && outcomesOf(pending).length === 0);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const consumed = s.emit({ repeat: true });
  check("A5 held Space never re-fires", consumed === false && outcomesOf(pending).length === 0);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const consumed = s.emit({ control: true });
  check("A6 Ctrl+Space is left alone", consumed === false && outcomesOf(pending).length === 0);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const consumed = s.emit({ code: "Escape" });
  check("A7 Escape answers rejected", JSON.stringify(outcomesOf(pending)) === '["rejected"]', JSON.stringify(outcomesOf(pending)));
  check("A7 Escape is consumed", consumed === true);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending], config: { escape: false } });
  const consumed = s.emit({ code: "Escape" });
  check("A8 config { escape: false } disables Escape", consumed === false && outcomesOf(pending).length === 0);
  const spaceConsumed = s.emit();
  check("A8 Space still works when Escape is disabled", spaceConsumed === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]');
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const consumed = s.emit({ modal: "other" });
  check("A9 an unrelated modal suppresses approval", consumed === false && outcomesOf(pending).length === 0);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const textarea = s.doc.createElement("textarea");
  s.doc.body.appendChild(textarea);
  textarea.focus();
  const consumed = s.emit();
  check("A10 focus in a textarea blocks approval", consumed === false && outcomesOf(pending).length === 0);
}

/* A11 / A12 — hidden and inert panels */
{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{ visible: false }], pendings: [pending] });
  check("A11 hidden panel is not answerable", s.emit() === false && outcomesOf(pending).length === 0);
}
{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const inert = s.doc.createElement("div");
  inert.setAttribute("inert", "");
  s.doc.body.appendChild(inert);
  inert.appendChild(s.panels[0].root);
  const consumed = s.emit();
  check("A12 panel inside [inert] is not answerable", consumed === false && outcomesOf(pending).length === 0);
  check("A12 inert panel reports no-panel:hidden, not multi-panel", s.lastDecision() && s.lastDecision().reason === "no-panel:hidden", s.lastDecision() && s.lastDecision().reason);
}

{
  const first = makePending("approval:1");
  const second = makePending("approval:2");
  const s = scenario({ panels: [{ key: "approval:1" }, { key: "approval:2" }], pendings: [first, second] });
  check("A13 multiple visible panels are ignored", s.emit() === false && outcomesOf(first).length === 0 && outcomesOf(second).length === 0);
  check("A13 reason is multi-panel:2", s.lastDecision() && s.lastDecision().reason === "multi-panel:2", s.lastDecision() && s.lastDecision().reason);
}

{
  const pending = makePending("approval:9");
  const s = scenario({ panels: [{ key: "approval:1" }], pendings: [pending] });
  check("A14 key mismatch is ignored", s.emit() === false && outcomesOf(pending).length === 0);
  check("A14 reason names the panel key", s.lastDecision() && s.lastDecision().reason === "no-pending:approval:1", s.lastDecision() && s.lastDecision().reason);
}

{
  const pending = makePending("approval:1", { answerable: false });
  const s = scenario({ panels: [{}], pendings: [pending] });
  check("A15 settled request is not answered again", s.emit() === false && outcomesOf(pending).length === 0);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{ labels: ["拒绝", "允许一次", "始终允许"] }], pendings: [pending] });
  s.emit();
  check("A16 Always-allow card answers allowed-once only", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("A16 no button clicked (cannot hit Always allow)", s.panels[0].buttons.every((button) => button.__clicks === 0));
}

{
  const s = scenario({ panels: [{}], pendings: [] });
  check("A17 stale panel with no pending request is ignored", s.emit() === false);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const sidebar = s.doc.createElement("button");
  s.doc.body.appendChild(sidebar);
  sidebar.focus();
  const consumed = s.emit({ target: sidebar });
  check("A18 Space approves although focus sits on a sidebar button", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("A18 the key is consumed so the sidebar button is not activated", consumed === true);
  check("A18 card buttons untouched", s.panels[0].buttons.every((button) => button.__clicks === 0));
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  s.panels[0].buttons[0].focus();
  const consumed = s.emit({ target: s.panels[0].buttons[0] });
  check("A19 focused Reject keeps its native Space rejection", consumed === false && outcomesOf(pending).length === 0);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  s.panels[0].detail.focus();
  const consumed = s.emit({ target: s.panels[0].detail });
  check("A20 Space on the detail region approves once", consumed === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]');
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const first = s.emit();
  const second = s.emit();
  check("A21 second Space does not answer again", first === true && second === false && outcomesOf(pending).length === 1, JSON.stringify(outcomesOf(pending)));
}

{
  const s = scenario({ shortcuts: true, panels: [{}], uiSession: null });
  check("A22 missing uiSession disables the plugin", s.shortcuts.listeners.size === 0);
  check("A22 no DOM keydown listener is installed", (s.doc.listeners.get("keydown") || []).length === 0);
  check("A22 boot explains the missing service", s.diag() && s.diag().boot === "no-uiSession", s.diag() && JSON.stringify(s.diag().boot));
}

{
  const s = scenario({ panels: [{}], pendings: [makePending("approval:1", { answer: () => { throw new Error("already settled"); } })] });
  const consumed = s.emit();
  check("A23 failed semantic answer does not click a button", consumed === false && s.panels[0].buttons.every((button) => button.__clicks === 0));
  check("A23 failed answer reports answer-failed", s.lastDecision() && s.lastDecision().reason === "answer-failed", s.lastDecision() && s.lastDecision().reason);
}

{
  const s = scenario({ panels: [{}], pendings: [makePending("approval:1", { answer: () => Promise.reject(new Error("host refused")) })] });
  const consumed = s.emit();
  check("A24 rejected answer is contained and consumed", consumed === true && s.panels[0].buttons.every((button) => button.__clicks === 0));
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  s.loaded.dispose();
  check("A25 unload removes the fixed-input listener", s.shortcuts.listeners.size === 0 && s.emit() === false);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const consumed = s.emit({ target: null });
  check("A26 a fixed input with context.target === null is ignored", consumed === false && outcomesOf(pending).length === 0);
}

/* A27 — legacy host: no ctx.inject, service read through ctx.get */
{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending], noInject: true, uiSessionViaProperty: true });
  check("A27 legacy ctx without inject still attaches shortcuts and uiSession", s.shortcuts.listeners.size === 1 && s.diag().boot.mode === "dom+shortcuts");
  check("A27 legacy ctx answers Space", s.emit() === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]');
}

/* A28 — the startup race: inject delivers shortcuts after apply */
{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending], deferShortcuts: true, settle: true });
  check("A28 shortcuts are not attached before the service arrives", s.shortcuts.listeners.size === 0 && s.diag().boot.mode === "dom");
  check("A28 no fixed input is answered before the service arrives", s.emit() === false && outcomesOf(pending).length === 0);
  s.loaded.ctx.__activateShortcuts();
  check("A28 inject activates the secondary path later", s.shortcuts.listeners.size === 1 && s.diag().boot.mode === "dom+shortcuts");
  check("A28 the late service still answers Space", s.emit() === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]');
}

/* A29 — no shortcuts service: one warning, DOM path keeps working */
{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending], shortcuts: false, noInject: true });
  const warned = s.world.warnings().filter((entry) => String(entry.args[1]).includes("using the DOM path only"));
  check("A29 a missing shortcuts service warns exactly once", warned.length === 1, `warnings=${warned.length}`);
  check("A29 mode stays dom", s.diag().boot.mode === "dom");
  check("A29 the DOM path still answers Space", s.key().defaultPrevented === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]');
}

{
  const pending = makePending("approval:1", { kind: "tool-request" });
  const s = scenario({ panels: [{}], pendings: [pending] });
  check("A30 a non-approval pending with the same key is ignored", s.emit() === false && outcomesOf(pending).length === 0);
}

{
  const s = scenario({
    panels: [{}],
    pendings: [],
    sessionHooks: {
      getSnapshot() {
        throw new Error("host snapshot broke");
      },
    },
  });
  check("A31 a throwing sessionStatus does not crash and does not answer", s.emit() === false && Boolean(s.diag()));
  check("A31 snapshot drift is reported as no-pending", s.lastDecision() && String(s.lastDecision().reason).startsWith("no-pending:"), s.lastDecision() && s.lastDecision().reason);
}

{
  const s = scenario({ panels: [{}], pendings: [{ kind: "approval", key: "approval:1", answerable: true }] });
  const consumed = s.emit();
  check("A32 a host without answer() is refused, never clicked", consumed === false && s.panels[0].buttons.every((button) => button.__clicks === 0));
  check("A32 the refusal reason is answer-failed", s.lastDecision() && s.lastDecision().reason === "answer-failed", s.lastDecision() && s.lastDecision().reason);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const firstDiag = s.diag();
  loadPlugin(s.world, { uiSession: s.uiSession, shortcuts: s.shortcuts });
  check("A33 a second apply reuses the diagnostics object", s.diag() === firstDiag && Array.isArray(firstDiag.inputs));
}

/* ============================== B. DOM path ============================== */
console.log("\n" + "=".repeat(78));
console.log("B. document keydown primary path (capture phase)");
console.log("=".repeat(78));

{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  check("B1 bundle applies without the shortcuts service", s.loaded.exports && !s.loaded.error, s.loaded.error ? String(s.loaded.error) : "");
  const event = s.key();
  check("B1 Space answers allowed-once", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("B1 Space is prevented (no page scroll)", event.defaultPrevented === true);
  check("B1 Space stops propagation", event.propagationStopped === true);
  check("B1 no button clicked", s.panels[0].buttons.every((button) => button.__clicks === 0));
}

{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const textarea = s.doc.createElement("textarea");
  s.doc.body.appendChild(textarea);
  textarea.focus();
  const event = s.key({ target: textarea });
  check("B2 Space typed in a textarea is not intercepted", event.defaultPrevented === false && outcomesOf(pending).length === 0);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const event = s.key({ key: "Escape", code: "Escape" });
  check("B3 Escape answers rejected", JSON.stringify(outcomesOf(pending)) === '["rejected"]', JSON.stringify(outcomesOf(pending)));
  check("B3 Escape is prevented", event.defaultPrevented === true);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const sidebar = s.doc.createElement("button");
  s.doc.body.appendChild(sidebar);
  sidebar.focus();
  const event = s.key({ target: sidebar });
  check("B4 Space approves although focus is on a sidebar button", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("B4 the key is prevented", event.defaultPrevented === true);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const handled = s.key({ defaultPrevented: true });
  check("B5 an already handled key is not answered", handled.defaultPrevented === true && outcomesOf(pending).length === 0);
  const event = s.key();
  check("B5 a later clean press still answers", event.defaultPrevented === true && outcomesOf(pending).length === 1);
}

{
  const s = scenario({ shortcuts: false, panels: [{ labels: ["拒绝", "允许一次", "始终允许"] }], pendings: [{ kind: "approval", key: "approval:1", answerable: true }] });
  const event = s.key();
  check("B6 a host without answer() is never clicked in the DOM path", s.panels[0].buttons.every((button) => button.__clicks === 0));
  check("B6 the DOM path refuses with answer-failed", s.lastDecision() && s.lastDecision().reason === "answer-failed", s.lastDecision() && s.lastDecision().reason);
  check("B6 a refused key is not prevented", event.defaultPrevented === false);
}

{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  s.loaded.dispose();
  const event = s.key();
  check("B7 unload removes the DOM keydown listener", event.defaultPrevented === false && outcomesOf(pending).length === 0);
  check("B7 unload removes composition and keyup listeners", ["keydown", "keyup", "compositionstart", "compositionend"].every((type) => (s.doc.listeners.get(type) || []).length === 0));
}

/* B8 — the capture flag itself is the regression the audit proved untested */
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const keydown = s.doc.listeners.get("keydown") || [];
  check("B8 the keydown listener is registered on document capture", keydown.length === 1 && keydown[0].capture === true, JSON.stringify(keydown.map((entry) => entry.capture)));
  const composition = ["compositionstart", "compositionend", "keyup"].every((type) => (s.doc.listeners.get(type) || []).every((entry) => entry.capture === true));
  check("B8 composition and keyup guards are capture listeners too", composition);
}

/* B9 — capture priority over a control that swallows Space */
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const sidebar = s.doc.createElement("button");
  s.doc.body.appendChild(sidebar);
  sidebar.focus();
  let swallowed = 0;
  sidebar.addEventListener("keydown", (event) => {
    swallowed += 1;
    event.preventDefault();
  });
  const event = s.key({ target: sidebar });
  check("B9 capture answers before the focused control can preventDefault", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("B9 the swallowing handler never runs", swallowed === 0, `swallowed=${swallowed}`);
  check("B9 the answered key is prevented and stopped", event.defaultPrevented === true && event.propagationStopped === true);
}

/* B10 — no card: Space must stay a normal Space */
{
  const s = scenario({ shortcuts: false, panels: [] });
  const event = s.key();
  check("B10 with no approval card Space is not consumed", event.defaultPrevented === false && event.propagationStopped === false);
  check("B10 the reason code is no-panel", s.lastDecision() && s.lastDecision().reason === "no-panel", s.lastDecision() && s.lastDecision().reason);
  check("B10 nothing was answered", s.lastDecision() && s.lastDecision().acted === false);
}

/* B11 — a stale card (pending gone) must not swallow Space */
{
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [] });
  const event = s.key();
  check("B11 a stale card does not consume Space", event.defaultPrevented === false);
  check("B11 the stale reason is no-pending:<key>", s.lastDecision() && s.lastDecision().reason === "no-pending:approval:1", s.lastDecision() && s.lastDecision().reason);
}

/* B12-B14 — key facts the DOM path must guard by itself */
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const event = s.key({ repeat: true });
  check("B12 a repeated Space is ignored", event.defaultPrevented === false && outcomesOf(pending).length === 0);
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const event = s.key({ keyCode: 229 });
  check("B13 keyCode 229 (IME) is ignored", event.defaultPrevented === false && outcomesOf(pending).length === 0);
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const event = s.key({ isComposing: true });
  check("B14 isComposing Space is ignored", event.defaultPrevented === false && outcomesOf(pending).length === 0);
}

/* B15/B16 — target and activeElement can disagree (composer takeover) */
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const textarea = s.doc.createElement("textarea");
  s.doc.body.appendChild(textarea);
  textarea.focus();
  const event = s.key({ target: s.doc.body });
  check("B15 focus still in an editor blocks approval even when target is <body>", event.defaultPrevented === false && outcomesOf(pending).length === 0);
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const textarea = s.doc.createElement("textarea");
  s.doc.body.appendChild(textarea);
  const event = s.key({ target: textarea });
  check("B16 an editable target blocks approval even when focus sits on <body>", event.defaultPrevented === false && outcomesOf(pending).length === 0);
}

/* B17-B22 — modal layers, aligned with the host modalSelector */
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const menu = s.doc.createElement("div");
  menu.setAttribute("role", "menu");
  s.doc.body.appendChild(menu);
  const event = s.key();
  check("B17 an open [role=menu] suppresses approval", event.defaultPrevented === false && outcomesOf(pending).length === 0);
  check("B17 the reason code is other-modal", s.lastDecision() && s.lastDecision().reason === "other-modal", s.lastDecision() && s.lastDecision().reason);
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const dialog = s.doc.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  s.doc.body.appendChild(dialog);
  const event = s.key();
  check("B18 an unrelated aria-modal dialog suppresses approval", event.defaultPrevented === false && outcomesOf(pending).length === 0);
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, pendings: [pending] });
  const dialog = s.doc.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  s.doc.body.appendChild(dialog);
  const panel = buildPanel(s.world, { parent: dialog });
  s.panels.push(panel);
  s.world.advance(1000);
  const event = s.key();
  check("B19 a modal that contains the card still answers", event.defaultPrevented === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const dialog = s.doc.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.__visible = false;
  s.doc.body.appendChild(dialog);
  const event = s.key();
  check("B20 a hidden mount-only dialog does not suppress approval", event.defaultPrevented === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, pendings: [pending] });
  const owner = s.doc.createElement("div");
  owner.setAttribute("role", "dialog");
  owner.setAttribute("aria-modal", "true");
  s.doc.body.appendChild(owner);
  s.panels.push(buildPanel(s.world, { parent: owner }));
  const laterMenu = s.doc.createElement("div");
  laterMenu.setAttribute("role", "menu");
  s.doc.body.appendChild(laterMenu);
  s.world.advance(1000);
  const event = s.key();
  check("B21 the topmost layer wins over an earlier dialog", event.defaultPrevented === false && outcomesOf(pending).length === 0);
  check("B21 the reason is other-modal for the top menu", s.lastDecision() && s.lastDecision().reason === "other-modal", s.lastDecision() && s.lastDecision().reason);
  laterMenu.remove();
  const second = s.key();
  check("B21 closing the top menu restores approval", second.defaultPrevented === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
}

/* B22-B24 — invisibility, three ways */
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, pendings: [pending] });
  const inert = s.doc.createElement("div");
  inert.setAttribute("inert", "");
  s.doc.body.appendChild(inert);
  s.panels.push(buildPanel(s.world, { parent: inert }));
  s.world.advance(1000);
  const event = s.key();
  check("B22 an inert ancestor hides the card", event.defaultPrevented === false && outcomesOf(pending).length === 0);
  check("B22 the reason is no-panel:hidden", s.lastDecision() && s.lastDecision().reason === "no-panel:hidden", s.lastDecision() && s.lastDecision().reason);
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, pendings: [pending] });
  const panel = buildPanel(s.world);
  s.panels.push(panel);
  panel.root.__computed = { display: "none", visibility: "visible" };
  s.world.advance(1000);
  const event = s.key();
  check("B23 a display:none card is ignored (computed style)", event.defaultPrevented === false && outcomesOf(pending).length === 0);
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, pendings: [pending] });
  const panel = buildPanel(s.world);
  s.panels.push(panel);
  panel.root.__rects = false;
  s.world.advance(1000);
  const event = s.key();
  check("B24 a zero-rect card is ignored", event.defaultPrevented === false && outcomesOf(pending).length === 0);
}

/* B25-B26 — composition state machine (WebKit isComposing is unreliable) */
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  s.event("compositionend");
  const first = s.key();
  check("B25 the keydown right after compositionend is ignored", first.defaultPrevented === false && outcomesOf(pending).length === 0);
  s.event("keyup");
  const second = s.key();
  check("B25 keyup clears the composition-ended guard", second.defaultPrevented === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  s.event("compositionstart");
  const first = s.key();
  check("B26 Space during compositionstart is ignored even without isComposing", first.defaultPrevented === false && outcomesOf(pending).length === 0);
  s.event("compositionend");
  s.event("keyup");
  const second = s.key();
  check("B26 Space works again once composition really ended", second.defaultPrevented === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
}

/* B27-B29 — the P0 cooling-off window */
{
  const pending = makePending("approval:9");
  const s = scenario({ shortcuts: false, pendings: [pending], settle: false });
  buildPanel(s.world, { key: "approval:9" }); // appears at t=0
  s.world.advance(100);
  const early = s.key();
  check("B27 Space within the cooldown is not answered", early.defaultPrevented === false && outcomesOf(pending).length === 0);
  check("B27 the reason code is warming:<key>", s.lastDecision() && s.lastDecision().reason === "warming:approval:9", s.lastDecision() && s.lastDecision().reason);
  s.world.advance(250); // t=350
  const late = s.key();
  check("B27 Space after the cooldown is answered", late.defaultPrevented === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, pendings: [pending], settle: false });
  buildPanel(s.world); // appears at t=0
  s.world.advance(1000); // the user waited, then typed once
  const event = s.key();
  check("B28 the first Space after a long wait is answered (no lazy warming)", event.defaultPrevented === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, pendings: [pending], settle: false, storage: { "dsh-space-approve:cooldownMs": "0" } });
  check("B29 cooldownMs 0 is read from localStorage", s.diag().boot.cooldownMs === 0, s.diag() && JSON.stringify(s.diag().boot));
  buildPanel(s.world);
  const event = s.key();
  check("B29 cooldownMs 0 disables the cooling window", event.defaultPrevented === true && outcomesOf(pending).length === 1);
}

/* B30-B31 — the Escape switch, through the channel that actually reaches the client */
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending], storage: { "dsh-space-approve:escape": "false" } });
  check("B30 localStorage escape:false is reported in boot", s.diag().boot.escape === false);
  const reject = s.key({ key: "Escape", code: "Escape" });
  check("B30 localStorage escape:false disables Escape", reject.defaultPrevented === false && outcomesOf(pending).length === 0);
  const allow = s.key();
  check("B30 Space still works with Escape disabled", allow.defaultPrevented === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]');
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending], config: { escape: false } });
  const reject = s.key({ key: "Escape", code: "Escape" });
  check("B31 config escape:false reaches the DOM path too", reject.defaultPrevented === false && outcomesOf(pending).length === 0);
}

/* B32-B33 — split view: match by pending, still refuse true ambiguity */
{
  const stale = makePending("approval:1");
  const pending = makePending("approval:2");
  const s = scenario({ shortcuts: false, panels: [{ key: "approval:1" }, { key: "approval:2" }], pendings: [stale, pending] });
  // approval:1 is settled: its card is fading out, only approval:2 is still pending.
  stale.answerable = false;
  const event = s.key();
  check("B32 a stale second card does not block the live one", event.defaultPrevented === true && JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("B32 the stale card was not answered", outcomesOf(stale).length === 0);
}
{
  const first = makePending("approval:1");
  const second = makePending("approval:2");
  const s = scenario({ shortcuts: false, panels: [{ key: "approval:1" }, { key: "approval:2" }], pendings: [first, second] });
  const event = s.key();
  check("B33 two live cards stay ambiguous and are ignored", event.defaultPrevented === false && outcomesOf(first).length === 0 && outcomesOf(second).length === 0);
}

/* B34 — dual path: the fixed input never sees an answered press */
{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  const event = s.key();
  check("B34 the DOM path answers the press", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]', JSON.stringify(outcomesOf(pending)));
  check("B34 stopPropagation keeps the fixed path from delivering it", s.shortcuts.delivered === 0, `delivered=${s.shortcuts.delivered}`);
  check("B34 exactly one outcome is recorded", outcomesOf(pending).length === 1);
  check("B34 the key is prevented once", event.defaultPrevented === true);
}

/* B35 — diagnostics hygiene */
{
  const s = scenario({ shortcuts: false, panels: [], pendings: [] });
  for (let i = 0; i < 35; i += 1) s.key();
  check("B35 diagnostics keep the last 30 decisions", s.diag().decisions.length === 30, `decisions=${s.diag().decisions.length}`);
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const textarea = s.doc.createElement("textarea");
  s.doc.body.appendChild(textarea);
  textarea.focus();
  for (let i = 0; i < 5; i += 1) s.key({ target: textarea });
  check("B35 typing in an editor is not recorded in inputs", s.diag().inputs.length === 0, `inputs=${s.diag().inputs.length}`);
}

/* B36-B39 — lifecycle and hostile host shapes */
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  s.loaded.dispose();
  check("B36 unload removes window.__dshSpaceApprove", s.world.window.__dshSpaceApprove === undefined, String(s.world.window.__dshSpaceApprove));
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending], storageThrows: true });
  check("B37 a throwing localStorage does not break the plugin", s.loaded.error === null && s.key().defaultPrevented === true);
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  s.doc.querySelectorAll = () => {
    throw new Error("querySelectorAll blocked");
  };
  const event = s.key();
  check("B38 a throwing panel query is reported, not thrown", event.defaultPrevented === false && s.lastDecision() && s.lastDecision().reason === "query-failed", s.lastDecision() && s.lastDecision().reason);
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending], noEffect: true });
  check("B39 a host without ctx.effect still works", s.loaded.error === null && s.key().defaultPrevented === true && outcomesOf(pending).length === 1);
}

/* B40 — logging: quiet by default, loud for answers, verbose under debug */
{
  const s = scenario({ shortcuts: false, panels: [], pendings: [] });
  s.key();
  const decisionWarns = s.world.warnings().filter((entry) => entry.args[1] === "Space");
  check("B40 a non-answer does not log a warning", decisionWarns.length === 0, `warns=${decisionWarns.length}`);
  check("B40 a non-answer stays silent without debug", s.world.infos().length === 0, `infos=${s.world.infos().length}`);
}
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  s.key();
  const answered = s.world.warnings().filter((entry) => entry.args[1] === "Space" && String(entry.args[3]) === "answered");
  check("B40 an answer is logged at warn level", answered.length === 1, `warns=${answered.length}`);
}
{
  const s = scenario({ shortcuts: false, panels: [], pendings: [], storage: { "dsh-space-approve:debug": "1" } });
  s.key();
  const debugInfos = s.world.infos().filter((entry) => entry.args[1] === "dom" && entry.args[2] === "Space" && entry.args[4] === "no-panel");
  check("B40 the debug switch turns on decision logs", debugInfos.length === 1, `infos=${debugInfos.length}`);
}

/* ============================== C. contracts ============================= */
console.log("\n" + "=".repeat(78));
console.log("C. propagation, manifest and version contracts");
console.log("=".repeat(78));

/* C1 — a keydown swallower registered BEFORE the plugin still loses */
{
  const pending = makePending("approval:1");
  const s = scenario({ shortcuts: false, panels: [{}], pendings: [pending] });
  const sidebar = s.doc.createElement("button");
  s.doc.body.appendChild(sidebar);
  sidebar.focus();
  let before = 0;
  sidebar.addEventListener("keydown", (event) => {
    before += 1;
    event.preventDefault();
  });
  const event = s.key({ target: sidebar });
  check("C1 document capture acts before the focused control's handler", JSON.stringify(outcomesOf(pending)) === '["allowed-once"]' && before === 0, JSON.stringify(outcomesOf(pending)));
  check("C1 the event is stopped before reaching the target", event.propagationStopped === true);
}

/* C2 — both paths installed: exactly one answer, and the second path never runs */
{
  const pending = makePending("approval:1");
  const s = scenario({ panels: [{}], pendings: [pending] });
  check("C2 both paths are installed", s.shortcuts.listeners.size === 1 && (s.doc.listeners.get("keydown") || []).length === 1);
  s.key();
  check("C2 one physical press answers once", outcomesOf(pending).length === 1, JSON.stringify(outcomesOf(pending)));
  check("C2 the fixed path delivered nothing", s.shortcuts.delivered === 0, `delivered=${s.shortcuts.delivered}`);
}

/* C3 — manifest hygiene and version consistency */
{
  const raw = readFileSync(join(ROOT, "package.json"));
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  check("C3 package.json has no UTF-8 BOM", hasBom === false);
  let manifest = null;
  try {
    manifest = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    check("C3 package.json parses as JSON", false, String(error));
  }
  if (manifest) {
    check("C3 package.json parses as JSON", true);
    check("C3 declares a dsh bundle patch", Boolean(manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch));
    check("C3 declares a web client half", Boolean(manifest.dsh && manifest.dsh.client) && manifest.dsh.client.platform === "web");
    check("C3 batch patch file exists", existsSync(join(ROOT, "cordis.patch.yml")));
    check("C3 the bundle id matches the package name", Boolean(manifest.dsh && manifest.dsh.client));
    check("C3 engines still cover DSH 0.2.x", Boolean(manifest.dsh && manifest.dsh.engines && manifest.dsh.engines.dsh === ">=0.2.0-rc.2 <0.3.0-0"), manifest.dsh && manifest.dsh.engines && manifest.dsh.engines.dsh);
    const patch = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
    check("C3 the patch inserts the same id", patch.includes("id: " + manifest.name), patch.trim());
    const boot = scenario({ shortcuts: true, panels: [{}] }).diag().boot;
    check("C3 boot.version matches package.json", boot.version === manifest.version, `boot=${boot.version} package=${manifest.version}`);
  }
  for (const file of ["client.js", "index.js", "cordis.patch.yml"]) {
    const bytes = readFileSync(join(ROOT, file));
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    check(`C3 ${file} has no UTF-8 BOM`, bom === false);
  }
}

/* C4 — README states the real number of assertions */
{
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const match = /共\s*\*\*(\d+)\s*项断言\*\*/.exec(readme);
  const total = results.length + 1;
  check("C4 README states the real assertion count", Boolean(match) && Number(match[1]) === total, match ? `README=${match[1]} actual=${total}` : "no count found");
}

/* -------------------------------- summary -------------------------------- */
const passed = results.filter((result) => result.pass).length;
console.log("\n" + "=".repeat(78));
console.log(`RESULT: ${passed}/${results.length} checks passed`);
console.log("=".repeat(78));
if (passed !== results.length) process.exitCode = 1;
