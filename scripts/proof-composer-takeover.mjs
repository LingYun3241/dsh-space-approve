/**
 * P0 proof: an approval card takes over the composer while the user is typing.
 *
 * The official renderer wraps the composer fallback in `display:none` when the
 * approval card is elected for the `conversation.composer` slot, so the focused
 * editor is hidden and `document.activeElement` falls back to <body>. A Space
 * typed out of habit must not approve a privileged call.
 *
 * The script runs the very same scenario twice:
 *   before — v1.1.4 `client.js` (read from the local git tag, or reconstructed
 *            by removing the cooling-off guard from the current source);
 *   after  — the working-tree `client.js`.
 *
 * Run:  node scripts/proof-composer-takeover.mjs
 * Exit: 0 when "before mis-approves and after does not", 1 otherwise.
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
class Element {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.attrs = new Map();
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.isConnected = true;
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
    return this;
  }
  appendChild(child) {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    this.ownerDocument.notifyMutation(child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
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
    this.body = new Element("body", this);
    this.documentElement = this.body;
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
  notifyMutation(node) {
    for (const callback of [...this.observers]) {
      callback([{ type: "childList", addedNodes: [node], removedNodes: [] }]);
    }
  }
  dispatch(type, event) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
  }
}

class MutationObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe(node) {
    // `client.js` observes `document.documentElement`, an element, not the document.
    this.doc = node && node.observers ? node : node.ownerDocument;
    this.doc.observers.add(this.callback);
  }
  disconnect() {
    if (this.doc) this.doc.observers.delete(this.callback);
  }
  takeRecords() {
    return [];
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
 * The pre-fix source must be the genuine v1.1.4 bundle, not a reconstruction.
 * `spawnSync` cannot capture piped output under the DSH sandbox (EPERM on named
 * pipes), so git writes to a file and we read it back.
 */
function readBeforeSource() {
  const scratch = join(HERE, ".v1.1.4-client.js");
  const fd = openSync(scratch, "w");
  try {
    const result = spawnSync("git", ["-C", ROOT, "show", "v1.1.4:client.js"], {
      stdio: ["ignore", fd, fd],
      timeout: 20_000,
    });
    if (result.status === 0) {
      const fromTag = readFileSync(scratch, "utf8");
      if (fromTag.includes('version: "1.1.2"')) return { source: fromTag, label: "git tag v1.1.4" };
    }
  } catch {
    /* fall through to the reconstruction */
  } finally {
    closeSync(fd);
    rmSync(scratch, { force: true });
  }
  const current = readFileSync(CLIENT, "utf8");
  const stripped = current.replace(
    /if \(Date\.now\(\) - appearedAt < cooldownMs\) return \{ acted: false, reason: "warming:" \+ key \};\n/,
    "",
  );
  if (stripped === current) throw new Error("cannot reconstruct the pre-fix source (no v1.1.4 tag and no cooling-off guard)");
  return { source: stripped, label: "v1.1.4 behavior reconstructed (cooldown guard removed)" };
}

/* -------------------------------- scenario ------------------------------- */
function run(source, label) {
  const doc = new Document();
  doc.defaultView = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  const clock = { t: 0 };
  const window = {
    document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    __ModuleLoader__: null,
  };
  doc.window = window;

  // 1. The user is typing in the composer.
  const composerBar = doc.createElement("div");
  doc.body.appendChild(composerBar);
  const textarea = doc.createElement("textarea");
  textarea.setAttribute("role", "textbox");
  composerBar.appendChild(textarea);
  textarea.focus();
  const draft = "please also run the migration ";
  console.log(`${label} step 0  focus on the composer editor: active = ${doc.activeElement.tagName}, draft = ${JSON.stringify(draft)}`);

  // 2. The approval card takes over the slot: the composer fallback becomes
  //    display:none and the browser blurs the hidden editor (focus → body).
  composerBar.style.display = "none";
  doc.activeElement = doc.body;
  console.log(`${label} step 1  approval card elected, composer hidden: active = ${doc.activeElement.tagName}`);

  const panel = doc.createElement("div");
  panel.setAttribute("data-approval-key", "approval:7");
  doc.body.appendChild(panel);
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
    key: "approval:7",
    answerable: true,
    toolName: "pwsh",
    answer(outcome) {
      outcomes.push(outcome);
      this.answerable = false;
      return Promise.resolve();
    },
  };
  const uiSession = {
    sessionStatus: {
      getSnapshot: () => new Map([["session-1", { pendingInteraction: pending }]]),
      subscribe: () => () => {},
    },
  };

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
    // The plugin's own diagnostics would drown out the steps printed below.
    console: { info() {}, warn() {}, error() {} },
    Promise,
    setTimeout,
    clearTimeout,
    Date: { now: () => clock.t },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(source, vm.createContext(sandbox), { filename: label === "before" ? "client-v1.1.4.js" : "client.js" });
  exportsObject.apply(
    {
      get: (name) => (name === "uiSession" ? uiSession : undefined),
      effect: (fn) => fn(),
    },
    undefined,
  );
  const boot = window.__dshSpaceApprove && window.__dshSpaceApprove.boot;
  console.log(`${label} step 2  plugin applied: boot = ${JSON.stringify(boot)}`);

  const press = (delay) => {
    clock.t += delay;
    const event = {
      type: "keydown",
      key: " ",
      code: "Space",
      target: doc.body,
      defaultPrevented: false,
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

  const early = press(50);
  console.log(
    `${label} step 3  Space +50ms after the takeover: prevented=${early.event.defaultPrevented} outcomes=${JSON.stringify(early.outcomes)} reason=${JSON.stringify(early.reason)}`,
  );
  const late = press(400);
  console.log(
    `${label} step 4  Space at +450ms:                prevented=${late.event.defaultPrevented} outcomes=${JSON.stringify(late.outcomes)} reason=${JSON.stringify(late.reason)}`,
  );
  return { early, late, draft };
}

/* --------------------------------- main ---------------------------------- */
const preFix = readBeforeSource();
console.log(`pre-fix source: ${preFix.label}\n`);
const before = run(preFix.source, "before");
const after = run(readFileSync(CLIENT, "utf8"), "after");

console.log("\n" + "=".repeat(78));
console.log(`before (v1.1.4): early press answered ${JSON.stringify(before.early.outcomes)} — mis-approval=${before.early.outcomes.includes("allowed-once")}`);
console.log(`after  (1.1.5):  early press answered ${JSON.stringify(after.early.outcomes)} — reason=${JSON.stringify(after.early.reason)}`);
console.log(`after  (1.1.5):  late press answered  ${JSON.stringify(after.late.outcomes)}`);
console.log("=".repeat(78));

const beforeMisApproved = before.early.event.defaultPrevented === true && before.early.outcomes[0] === "allowed-once";
const afterIgnored = after.early.event.defaultPrevented === false && after.early.outcomes.length === 0 && after.early.reason === "warming:approval:7";
const afterApprovedLater = after.late.event.defaultPrevented === true && JSON.stringify(after.late.outcomes) === '["allowed-once"]';

if (beforeMisApproved && afterIgnored && afterApprovedLater) {
  console.log("RESULT: reproduced before the fix, gone after the fix — the takeover Space is ignored (warming), and a deliberate press 300ms later still approves once.");
} else {
  console.log("RESULT: UNEXPECTED — inspect the steps above.");
  process.exitCode = 1;
}
