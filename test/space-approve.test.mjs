/**
 * Offline test harness for dsh-space-approve.
 *
 * Loads the REAL client.js in a vm sandbox with a purpose-built mini-DOM
 * (jsdom is not installed), publishes fake pending interactions through a fake
 * `uiSession`, and dispatches real keydown objects. No DSH instance required.
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

function loadPlugin(window, uiSession) {
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
      out.exports.apply({
        get: (name) => (name === "uiSession" ? uiSession : undefined),
        effect: (fn) => {
          out.dispose = fn();
          return out.dispose;
        },
      });
    } catch (error) {
      out.error = error;
    }
  }
  return out;
}

function press(loaded, options = {}) {
  const doc = loaded.doc;
  const target = options.target || doc.activeElement || doc.body;
  const event = {
    key: options.key ?? " ",
    code: options.code ?? "Space",
    target,
    defaultPrevented: false,
    repeat: Boolean(options.repeat),
    isComposing: Boolean(options.isComposing),
    keyCode: options.keyCode || 0,
    ctrlKey: Boolean(options.ctrlKey),
    metaKey: Boolean(options.metaKey),
    altKey: Boolean(options.altKey),
    shiftKey: Boolean(options.shiftKey),
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

console.log("=".repeat(78));
console.log("dsh-space-approve — safety and behaviour checks");
console.log("=".repeat(78));

/* 1. Happy path: visible panel + matching pending request. */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  check("1 bundle loads and applies without error", loaded.exports && !loaded.error, loaded.error ? String(loaded.error) : "");
  const event = press(loaded);
  check("1 Space answers the pending request exactly once", JSON.stringify(outcomes) === '["allowed-once"]', JSON.stringify(outcomes));
  check("1 Space is consumed (no page scroll)", event.defaultPrevented === true);
  check("1 no button is clicked (semantic answer, not a positional click)", panel.buttons.every((button) => button.__clicks === 0));
}

/* 2. No pending request: a stale panel must not be answerable. */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  const loaded = loadPlugin(window, makeUiSession([]));
  const event = press(loaded);
  check("2 stale panel with no pending request is ignored", event.defaultPrevented === false && panel.buttons.every((b) => b.__clicks === 0));
}

/* 3. Typing in a textarea keeps Space native. */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  const textarea = new Element("textarea", window.document);
  window.document.body.appendChild(textarea);
  textarea.focus();
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded, { target: textarea });
  check("3 Space typed in a textarea is not intercepted", event.defaultPrevented === false && outcomes.length === 0);
  check("3 all decision buttons untouched", panel.buttons.every((b) => b.__clicks === 0));
}

/* 4. Focus in an editor while the event targets <body>. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const textarea = new Element("textarea", window.document);
  window.document.body.appendChild(textarea);
  textarea.focus();
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded, { target: window.document.body });
  check("4 Space with focus still in an editor is not intercepted", event.defaultPrevented === false && outcomes.length === 0);
}

/* 5. Focus on a button outside the panel keeps native activation. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const sidebarButton = new Element("button", window.document);
  window.document.body.appendChild(sidebarButton);
  sidebarButton.focus();
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded, { target: sidebarButton });
  check("5 Space on a focused unrelated button is left to the browser", event.defaultPrevented === false && outcomes.length === 0);
}

/* 6. Focus on the Reject button must reject, never approve. */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  panel.buttons[0].focus();
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded, { target: panel.buttons[0] });
  check("6 focused Reject keeps its native Space rejection", event.defaultPrevented === false && outcomes.length === 0);
}

/* 7. IME composition. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded, { isComposing: true, keyCode: 229 });
  check("7 composing Space (IME) never approves", event.defaultPrevented === false && outcomes.length === 0);
}

/* 8. Auto-repeat. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded, { repeat: true });
  check("8 held Space never re-fires", event.defaultPrevented === false && outcomes.length === 0);
}

/* 9. Chorded Space. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded, { key: " ", ctrlKey: true });
  check("9 Ctrl+Space is left alone", event.defaultPrevented === false && outcomes.length === 0);
}

/* 10. Hidden panel. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document, { visible: false });
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded);
  check("10 hidden panel is not answerable", event.defaultPrevented === false && outcomes.length === 0);
}

/* 11. Inert ancestor. */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  const inert = new Element("div", window.document);
  inert.setAttribute("inert", "");
  window.document.body.appendChild(inert);
  inert.appendChild(panel.root);
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded);
  check("11 panel inside [inert] is not answerable", event.defaultPrevented === false && outcomes.length === 0);
}

/* 12. Ambiguous split view with two visible panels. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document, { key: "approval:1" });
  buildApprovalPanel(window.document, { key: "approval:2" });
  const outcomes = [];
  const first = makePending("approval:1", { outcomeLog: outcomes });
  const second = makePending("approval:2", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([first, second]));
  const event = press(loaded);
  check("12 multiple visible panels are ambiguous and ignored", event.defaultPrevented === false && outcomes.length === 0);
}

/* 13. Three-button card: never the persistent grant. */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document, { labels: ["拒绝", "允许一次", "始终允许"] });
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded);
  check("13 Always-allow card answers allowed-once only", JSON.stringify(outcomes) === '["allowed-once"]', JSON.stringify(outcomes));
  check("13 no button clicked (cannot hit Always allow)", panel.buttons.every((b) => b.__clicks === 0));
}

/* 14. Key mismatch between panel and pending request. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document, { key: "approval:1" });
  const outcomes = [];
  const pending = makePending("approval:9", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded);
  check("14 panel/pending key mismatch is ignored", event.defaultPrevented === false && outcomes.length === 0);
}

/* 15. Already settled request. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const outcomes = [];
  const pending = makePending("approval:1", { answerable: false, outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded);
  check("15 settled request is not answered twice", event.defaultPrevented === false && outcomes.length === 0);
}

/* 16. Fallback: a future host without answer() clicks Allow once, never Always allow. */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document, { labels: ["拒绝", "允许一次", "始终允许"] });
  const pending = { kind: "approval", key: "approval:1", answerable: true };
  const loaded = loadPlugin(window, makeUiSession([pending]));
  press(loaded);
  check(
    "16 fallback clicks Allow once (index 1), not Always allow (index 2)",
    panel.buttons[1].__clicks === 1 && panel.buttons[2].__clicks === 0 && panel.buttons[0].__clicks === 0,
    `clicks=[${panel.buttons.map((b) => b.__clicks)}]`,
  );
}

/* 17. Detail-region button does not shift the fallback index. */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document, { labels: ["拒绝", "允许一次", "始终允许"] });
  const detailButton = new Element("button", window.document);
  detailButton.textContent = "展开 diff";
  panel.detail.appendChild(detailButton);
  const pending = { kind: "approval", key: "approval:1", answerable: true };
  const loaded = loadPlugin(window, makeUiSession([pending]));
  press(loaded);
  check(
    "17 detail-region buttons are excluded from the fallback decision",
    panel.buttons[1].__clicks === 1 && detailButton.__clicks === 0,
    `clicks=${panel.buttons[1].__clicks}/${detailButton.__clicks}`,
  );
}

/* 18. Space on the detail region (not a button) does approve. */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  panel.detail.focus();
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded, { target: panel.detail });
  check("18 Space while reading the approval detail approves once", JSON.stringify(outcomes) === '["allowed-once"]' && event.defaultPrevented, JSON.stringify(outcomes));
}

/* 19. Open modal unrelated to the approval card blocks the shortcut. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const dialog = new Element("div", window.document);
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  window.document.body.appendChild(dialog);
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded);
  check("19 an unrelated open modal suppresses Space approval", event.defaultPrevented === false && outcomes.length === 0);
}

/* 20. Unmount removes the listener. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  loaded.dispose();
  const event = press(loaded);
  check("20 unload removes the keydown listener", event.defaultPrevented === false && outcomes.length === 0);
}

/* 21. Shift+Space (a common IME full-width toggle) is untouched. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded, { shiftKey: true });
  check("21 Shift+Space is left to the system/IME", event.defaultPrevented === false && outcomes.length === 0);
}

/* 22. Second Space after the request was answered is a no-op. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const first = press(loaded);
  const second = press(loaded);
  check(
    "22 second Space does not answer again",
    JSON.stringify(outcomes) === '["allowed-once"]' && second.defaultPrevented === false,
    `outcomes=${JSON.stringify(outcomes)} prevented2=${second.defaultPrevented}`,
  );
}

/* 23. Two pending sessions, one visible panel: only the matching key is answered. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document, { key: "approval:2" });
  const outcomesA = [];
  const outcomesB = [];
  const first = makePending("approval:1", { outcomeLog: outcomesA });
  const second = makePending("approval:2", { outcomeLog: outcomesB });
  const loaded = loadPlugin(window, makeUiSession([first, second]));
  press(loaded);
  check(
    "23 only the visible panel's request is answered",
    outcomesA.length === 0 && JSON.stringify(outcomesB) === '["allowed-once"]',
    `A=${JSON.stringify(outcomesA)} B=${JSON.stringify(outcomesB)}`,
  );
}

/* 24. contenteditable target/focus is typing, not approval. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const editor = new Element("div", window.document);
  editor.setAttribute("contenteditable", "true");
  editor.isContentEditable = true;
  window.document.body.appendChild(editor);
  editor.focus();
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded, { target: editor });
  check("24 contenteditable Space is not intercepted", event.defaultPrevented === false && outcomes.length === 0);
}

/* 25. A throwing answer must not fall back to clicking a button. */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  const pending = {
    kind: "approval",
    key: "approval:1",
    answerable: true,
    answer() {
      throw new Error("already settled");
    },
  };
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded);
  check(
    "25 failed semantic answer does not click a fallback button",
    event.defaultPrevented === false && panel.buttons.every((b) => b.__clicks === 0),
    `clicks=[${panel.buttons.map((b) => b.__clicks)}]`,
  );
}

/* 26. A rejected answer promise is contained (no unhandled rejection, no click). */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  const pending = {
    kind: "approval",
    key: "approval:1",
    answerable: true,
    answer() {
      return Promise.reject(new Error("host refused"));
    },
  };
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded);
  check(
    "26 rejected answer is contained and does not click a button",
    event.defaultPrevented === true && panel.buttons.every((b) => b.__clicks === 0),
    `clicks=[${panel.buttons.map((b) => b.__clicks)}]`,
  );
}

/* 27. No uiSession service: plugin disables itself instead of guessing. */
{
  const window = makeWindow();
  const panel = buildApprovalPanel(window.document);
  const loaded = loadPlugin(window);
  const event = press(loaded);
  check(
    "27 missing uiSession service disables Space approval",
    event.defaultPrevented === false && panel.buttons.every((b) => b.__clicks === 0),
  );
}

/* 28. Focused link keeps native Space activation. */
{
  const window = makeWindow();
  buildApprovalPanel(window.document);
  const link = new Element("a", window.document);
  link.setAttribute("href", "#somewhere");
  window.document.body.appendChild(link);
  link.focus();
  const outcomes = [];
  const pending = makePending("approval:1", { outcomeLog: outcomes });
  const loaded = loadPlugin(window, makeUiSession([pending]));
  const event = press(loaded, { target: link });
  check("28 focused link keeps native Space", event.defaultPrevented === false && outcomes.length === 0);
}

/* -------------------------------- summary -------------------------------- */
const passed = results.filter((result) => result.pass).length;
console.log("\n" + "=".repeat(78));
console.log(`RESULT: ${passed}/${results.length} checks passed`);
console.log("=".repeat(78));
if (passed !== results.length) process.exitCode = 1;
