/**
 * P0 proof: the composer takeover hides the focused editor, then the user keeps typing.
 *
 * The official renderer wraps the composer fallback in `display:none` when the approval
 * card is elected for the `composer` slot, so the focused editor disappears and
 * `document.activeElement` falls back to <body>. A Space typed out of habit must not
 * approve a privileged call.
 *
 * The script runs the same scenario against three real sources:
 *   v1.1.4 — Space at +120ms already approves (the original bug);
 *   v1.1.5 — the 300ms cooling-off window only delays it: the press at +300ms approves;
 *   1.1.6  — every press over two seconds is refused with `editor-hidden`.
 * A control scenario (no editor was ever focused) proves the first press is still
 * answered within 100ms, i.e. the guard did not turn the plugin into a no-op.
 *
 * The "before" sources are read from the git tags — never reconstructed, because a
 * reconstruction of the current code cannot reproduce the old behaviour.
 *
 * Run:  node scripts/proof-composer-takeover.mjs
 * Exit: 0 when every expectation below holds, 1 otherwise.
 */
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLIENT = join(ROOT, "client.js");

/* ------------------------------- mini DOM ------------------------------- */
function setConnected(node, value) {
  node.isConnected = value;
  for (const child of node.children) setConnected(child, value);
}

class Element {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.attrs = new Map();
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.isConnected = false;
    this.textContent = "";
    this.isContentEditable = false;
    this.style = {};
    this.dataset = {};
    this.__clicks = 0;
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    const observer = this.ownerDocument.observer;
    if (observer && observer.options && observer.options.attributes && this.isConnected) {
      observer.callback([{ type: "attributes", target: this, attributeName: name, addedNodes: [], removedNodes: [] }]);
    }
  }
  appendChild(child) {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    setConnected(child, true);
    this.ownerDocument.notifyMutation({ type: "childList", target: this, addedNodes: [child], removedNodes: [] });
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
    setConnected(child, false);
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
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }
  checkVisibility() {
    // Real checkVisibility() accounts for ancestors: the editor inside the hidden
    // composer fallback is not visible, which is the whole premise of the guard.
    let node = this;
    while (node && node.tagName) {
      if (node.style && node.style.display === "none") return false;
      node = node.parent;
    }
    return true;
  }
  getClientRects() {
    return [{ width: 100, height: 20 }];
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
    this.observers = new Set();
    this.observer = null;
    this.visibilityState = "visible";
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
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }
  notifyMutation(record) {
    for (const callback of [...this.observers]) callback([record]);
  }
  dispatch(type, event) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
  }
}

class MutationObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe(node, options) {
    const doc = node && node.observers ? node : node.ownerDocument;
    doc.observer = { callback: this.callback, options: options || {} };
    doc.observers.add(this.callback);
  }
  disconnect() {
    /* the proof never disposes the observer */
  }
  takeRecords() {
    return [];
  }
}

class Window {
  constructor(doc) {
    this.document = doc;
    this.listeners = new Map();
    this.__ModuleLoader__ = null;
    this.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const index = list.indexOf(fn);
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

/* -------------------------------- sources -------------------------------- */
/**
 * The pre-fix sources must be the genuine bundles. `spawnSync` cannot capture piped
 * output under the DSH sandbox (EPERM on named pipes), so git writes to a file.
 */
function readTag(tag) {
  const scratch = join(HERE, `.${tag}-client.js`);
  const fd = openSync(scratch, "w");
  try {
    const result = spawnSync("git", ["-C", ROOT, "show", `${tag}:client.js`], { stdio: ["ignore", fd, fd], timeout: 20_000 });
    if (result.status !== 0) return null;
    const source = readFileSync(scratch, "utf8");
    return source.includes("__ModuleLoader__") ? source : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
    rmSync(scratch, { force: true });
  }
}

const sources = { after: { source: readFileSync(CLIENT, "utf8"), label: "working tree (1.1.6)" } };
for (const [key, tag] of [
  ["v114", "v1.1.4"],
  ["v115", "v1.1.5"],
]) {
  const source = readTag(tag);
  if (!source) {
    console.log(`RESULT: CANNOT RUN — the git tag ${tag} is unavailable, and a reconstruction of the current source cannot reproduce the old behaviour. Run this script inside the repository.`);
    process.exit(1);
  }
  sources[key] = { source, label: `git tag ${tag}` };
}

/* -------------------------------- scenario ------------------------------- */
const BURST = [120, 300, 470, 700, 950, 1300, 1700, 2100];
const TAKE_OVER_KEY = "approval:7";

function makeWorld(source) {
  const doc = new Document();
  const window = new Window(doc);
  doc.defaultView = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  const clock = { t: 0 };
  const panel = doc.createElement("div");
  panel.setAttribute("data-approval-key", TAKE_OVER_KEY);
  const detail = doc.createElement("div");
  detail.setAttribute("data-approval-scroll", "");
  detail.setAttribute("tabindex", "0");
  panel.appendChild(detail);
  const row = doc.createElement("div");
  for (const text of ["拒绝", "允许一次"]) {
    const button = doc.createElement("button");
    button.setAttribute("type", "button");
    button.textContent = text;
    row.appendChild(button);
  }
  panel.appendChild(row);

  const outcomes = [];
  const pending = {
    kind: "approval",
    key: TAKE_OVER_KEY,
    answerable: true,
    toolName: "pwsh",
    answer(outcome) {
      outcomes.push(outcome);
      this.answerable = false;
      return Promise.resolve();
    },
  };
  const snapshot = new Map([["session-1", { running: true, pendingInteraction: pending }]]);
  const uiSession = { sessionStatus: { getSnapshot: () => snapshot, subscribe: () => () => {} } };

  let exportsObject = null;
  window.__ModuleLoader__ = {
    load(definition) {
      exportsObject = definition.factory(() => {
        throw new Error("no modules");
      });
    },
  };
  const sandbox = {
    window,
    document: doc,
    Element,
    MutationObserver,
    localStorage: window.localStorage,
    // The plugin's own console output would drown out the steps printed below.
    console: { info() {}, warn() {}, error() {} },
    Promise,
    setTimeout,
    clearTimeout,
    Date: { now: () => clock.t },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(source, vm.createContext(sandbox), { filename: "client-under-test.js" });
  exportsObject.apply({ get: (name) => (name === "uiSession" ? uiSession : undefined), effect: (fn) => fn() }, undefined);

  const press = (delay) => {
    clock.t += delay;
    const event = {
      type: "keydown",
      key: " ",
      code: "Space",
      target: doc.body,
      defaultPrevented: false,
      propagationStopped: false,
      repeat: false,
      isComposing: false,
      keyCode: 0,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
    };
    doc.dispatch("keydown", event);
    const diag = window.__dshSpaceApprove;
    const last = diag && Array.isArray(diag.decisions) ? diag.decisions[diag.decisions.length - 1] : undefined;
    return { event, outcomes: [...outcomes], reason: last && last.reason };
  };

  return { doc, window, clock, panel, pending, outcomes, press };
}

function bootOf(window) {
  return window.__dshSpaceApprove && window.__dshSpaceApprove.boot;
}

/* ------------------------- scenario A: typing inertia -------------------- */
function typingInertia(source, label) {
  const world = makeWorld(source);
  const { doc, clock } = world;
  console.log(`\n${label}`);
  console.log(`  step 0  plugin applied: boot = ${JSON.stringify(bootOf(world.window))}`);

  // The user is typing in the composer.
  const bar = doc.createElement("div");
  const textarea = doc.createElement("textarea");
  textarea.setAttribute("role", "textbox");
  bar.appendChild(textarea);
  doc.body.appendChild(bar);
  textarea.focus();
  doc.dispatch("focusin", { type: "focusin", target: textarea, relatedTarget: null });
  console.log(`  step 1  typing in the composer: active = ${doc.activeElement.tagName}`);

  // The approval card is elected and the renderer hides the composer fallback.
  doc.body.appendChild(world.panel);
  bar.style.display = "none";
  doc.dispatch("focusout", { type: "focusout", target: textarea, relatedTarget: null });
  doc.activeElement = doc.body;
  console.log(`  step 2  card elected, composer hidden: active = ${doc.activeElement.tagName}, editor visible = ${textarea.checkVisibility()}`);

  const trail = [];
  let previous = 0;
  for (const at of BURST) {
    const result = world.press(at - previous);
    previous = at;
    trail.push(`+${at}ms:${result.reason}${result.event.defaultPrevented ? "/CONSUMED" : ""}`);
    if (at === BURST[0]) console.log(`  step 3  first Space at +${at}ms: prevented=${result.event.defaultPrevented} outcomes=${JSON.stringify(result.outcomes)}`);
  }
  console.log(`  step 4  all presses: ${trail.join("  ")}`);
  console.log(`  outcomes after 2s of typing: ${JSON.stringify(world.outcomes)}`);
  return { approvals: world.outcomes.length, lastReason: trail.at(-1) };
}

/* ------------------------- scenario B: normal case ----------------------- */
function firstPressWithoutEditor(source, label) {
  const world = makeWorld(source);
  world.doc.body.appendChild(world.panel);
  world.clock.t += 80;
  const result = world.press(0);
  console.log(`\n${label}`);
  console.log(`  card appears with no editor focus, Space at +80ms: prevented=${result.event.defaultPrevented} outcomes=${JSON.stringify(result.outcomes)} reason=${result.reason}`);
  return { approvals: result.outcomes.length, prevented: result.event.defaultPrevented, reason: result.reason };
}

/* --------------------------------- main ---------------------------------- */
console.log("P0 composer-takeover proof — three-way comparison");
console.log(`pre-fix sources: ${sources.v114.label}, ${sources.v115.label}`);

const before = typingInertia(sources.v114.source, "A1. v1.1.4 (before any mitigation)");
const mitigated = typingInertia(sources.v115.source, "A2. v1.1.5 (300ms cooling-off window)");
const after = typingInertia(sources.after.source, "A3. 1.1.6 (dynamic focus-loss guard)");

const control115 = firstPressWithoutEditor(sources.v115.source, "B1. v1.1.5, no editor focus, first press at +80ms");
const controlAfter = firstPressWithoutEditor(sources.after.source, "B2. 1.1.6, no editor focus, first press at +80ms");

console.log("\n" + "=".repeat(78));
console.log(`before  (1.1.4): ${before.approvals} approval(s) from typing inertia — mis-approval=${before.approvals > 0}`);
console.log(`1.1.5:           ${mitigated.approvals} approval(s) from typing inertia — still mis-approves=${mitigated.approvals > 0} (the window only delays it)`);
console.log(`1.1.6:           ${after.approvals} approval(s) from typing inertia — guard=${after.lastReason}`);
console.log(`control 1.1.5:   first press at +80ms answered=${control115.approvals > 0} (reason=${control115.reason})`);
console.log(`control 1.1.6:   first press at +80ms answered=${controlAfter.approvals > 0} (reason=${controlAfter.reason})`);
console.log("=".repeat(78));

const checks = [
  ["v1.1.4 mis-approves from typing inertia", before.approvals > 0],
  ["v1.1.5 still mis-approves (mitigation only)", mitigated.approvals > 0],
  ["1.1.6 never approves during two seconds of typing", after.approvals === 0],
  ["1.1.6 refuses with editor-hidden", String(after.lastReason).includes("editor-hidden")],
  ["1.1.5 refuses the fast first press with no editor focus", control115.approvals === 0 && String(control115.reason).startsWith("warming:")],
  ["1.1.6 answers the fast first press with no editor focus", controlAfter.approvals > 0 && controlAfter.prevented === true],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed += 1;
}
console.log(
  failed === 0
    ? "RESULT: reproduced on v1.1.4, shown to be only delayed on v1.1.5, and gone on 1.1.6 while the immediate first press still works."
    : `RESULT: UNEXPECTED — ${failed} expectation(s) failed, inspect the steps above.`,
);
if (failed > 0) process.exitCode = 1;
