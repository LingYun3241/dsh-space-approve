/**
 * Mutation check for the safety-critical parts of client.js.
 *
 * For every mutation below the project is copied into `test/.mutants/<id>/`, one
 * exact source fragment is replaced, and the full suite is executed there.
 * A mutation is "killed" when the suite fails (exit code != 0) — i.e. at least one
 * assertion protects that behavior. A survivor means the suite is still green
 * with that safety mechanism broken.
 *
 * Run:  node test/mutation.mjs            (score must be >= 80%)
 *       node test/mutation.mjs --keep     (keep the mutant directories)
 */
import { spawnSync } from "node:child_process";
import { closeSync, cpSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const WORK = join(HERE, ".mutants");
const KEEP = process.argv.includes("--keep");
const MIN_SCORE = 0.8;

const FILES = ["client.js", "index.js", "cordis.patch.yml", "package.json", "README.md", "CHANGELOG.md"];

const mutations = [
  {
    id: "capture-to-bubble",
    why: "primary listener drops out of the capture phase",
    find: 'document.addEventListener("keydown", handler.onDomKeyDown, true);',
    replace: 'document.addEventListener("keydown", handler.onDomKeyDown, false);',
  },
  {
    id: "no-repeat-guard",
    why: "DOM path answers a held Space",
    find: "if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;",
    replace: "if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;",
  },
  {
    id: "no-ime-keycode",
    why: "DOM path answers keyCode 229",
    find: "if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;",
    replace: "if (event.defaultPrevented || event.repeat || event.isComposing) return;",
  },
  {
    id: "no-iscomposing",
    why: "DOM path answers mid-composition",
    find: "if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;",
    replace: "if (event.defaultPrevented || event.repeat || event.keyCode === 229) return;",
  },
  {
    id: "no-composition-ended",
    why: "WebKit composition-end keydown approves (P1-2)",
    find: "if (composing || compositionEnded) return;",
    replace: "if (composing) return;",
  },
  {
    id: "no-composing-flag",
    why: "compositionstart state is not tracked",
    find: "if (composing || compositionEnded) return;",
    replace: "if (compositionEnded) return;",
  },
  {
    id: "no-editing-somewhere",
    why: "focus in an editor no longer blocks when target is body (P0 guard)",
    find: "if (!isElement(event.target) || isEditable(event.target) || editingSomewhere()) return;",
    replace: "if (!isElement(event.target) || isEditable(event.target)) return;",
  },
  {
    id: "no-editable-target",
    why: "an editable event target no longer blocks",
    find: "if (!isElement(event.target) || isEditable(event.target) || editingSomewhere()) return;",
    replace: "if (!isElement(event.target) || editingSomewhere()) return;",
  },
  {
    id: "no-dom-modal-guard",
    why: "an unrelated modal no longer suppresses the DOM path (P1-1)",
    find: 'if (modal && typeof modal.contains === "function" && !modal.contains(target.panel)) {',
    replace: 'if (modal && false && typeof modal.contains === "function" && !modal.contains(target.panel)) {',
  },
  {
    id: "modal-selector-without-menu",
    why: "menus stop counting as modal layers (P1-1)",
    find: `const MODAL = '[role="dialog"][aria-modal="true"], [role="menu"]';`,
    replace: `const MODAL = '[role="dialog"][aria-modal="true"]';`,
  },
  {
    id: "modal-first-not-topmost",
    why: "the bottom-most layer decides instead of the topmost",
    find: "return visible.length === 0 ? null : visible[visible.length - 1];",
    replace: "return visible.length === 0 ? null : visible[0];",
  },
  {
    id: "modal-unfiltered",
    why: "a hidden mount-only dialog blocks approval forever",
    find: "const visible = modals.filter(isVisible);",
    replace: "const visible = modals;",
  },
  {
    id: "panels-unfiltered",
    why: "an invisible card is treated as answerable",
    find: "const visible = panels.filter(isVisible);",
    replace: "const visible = panels;",
  },
  {
    id: "no-checkvisibility",
    why: "checkVisibility is not consulted",
    find: "if (panel.checkVisibility() === false) return false;",
    replace: "/* checkVisibility disabled by mutant */",
  },
  {
    id: "no-computed-style",
    why: "computed display/visibility are not consulted",
    find: 'if (style && (style.visibility === "hidden" || style.display === "none")) return false;',
    replace: "/* computed-style check disabled by mutant */",
  },
  {
    id: "no-client-rects",
    why: "zero-rect cards are treated as visible",
    find: "if (panel.getClientRects().length === 0) return false;",
    replace: "/* getClientRects check disabled by mutant */",
  },
  {
    id: "no-inert-guard",
    why: "[inert] cards are answerable",
    find: 'if (closestOf(panel, "[inert]") !== null) return false;',
    replace: "/* inert check disabled by mutant */",
  },
  {
    id: "no-kind-filter",
    why: "a non-approval pending with the same key is answered",
    find: 'pending.kind === "approval" &&',
    replace: "",
  },
  {
    id: "no-key-match",
    why: "any pending answers for any card",
    find: "pending.key === key &&",
    replace: "",
  },
  {
    id: "no-answerable",
    why: "an already settled pending is answered again",
    find: "pending.answerable !== false",
    replace: "true",
  },
  {
    id: "no-multi-panel",
    why: "ambiguous split view silently answers one card",
    find: 'if (matches.length > 1) return { reason: "multi-panel:" + matches.length };',
    replace: "/* ambiguity check disabled by mutant */",
  },
  {
    id: "dom-consumes-nothing",
    why: "a non-answer still preventDefaults Space",
    find: 'report("dom", action, result);\n          if (!result.acted) return;',
    replace: 'report("dom", action, result);',
  },
  {
    id: "no-stop-propagation",
    why: "the fixed path receives an already answered key",
    find: 'if (typeof event.stopPropagation === "function") event.stopPropagation();',
    replace: "/* stopPropagation disabled by mutant */",
  },
  {
    id: "no-consume",
    why: "an answered fixed input is not consumed",
    find: 'if (typeof input.consume === "function") input.consume();',
    replace: "/* consume disabled by mutant */",
  },
  {
    id: "no-dom-escape-switch",
    why: "config/localStorage cannot disable Escape on the DOM path",
    find: 'if (composing || compositionEnded) return;\n          if (!escapeEnabled && action === "reject") return;',
    replace: "if (composing || compositionEnded) return;",
  },
  {
    id: "no-fixed-escape-switch",
    why: "config/localStorage cannot disable Escape on the fixed path",
    find: 'if (!escapeEnabled && action === "reject") return;\n          if (!gesture || gesture.defaultPrevented || gesture.composing || gesture.repeat) return;',
    replace: "if (!gesture || gesture.defaultPrevented || gesture.composing || gesture.repeat) return;",
  },
  {
    id: "no-fixed-editing-guard",
    why: "the fixed path answers while an editor holds focus",
    find: "          if (context.target === null || context.target === undefined) return;\n          if (editingSomewhere()) return;",
    replace: "          if (context.target === null || context.target === undefined) return;",
  },
  {
    id: "no-cooldown",
    why: "the P0 cooling-off window disappears",
    find: 'if (Date.now() - appearedAt < cooldownMs) return { acted: false, reason: "warming:" + key };',
    replace: "/* cooldown disabled by mutant */",
  },
  {
    id: "no-appearance-stamp",
    why: "appearance time is only recorded lazily on the first keypress",
    find: "for (const node of record.addedNodes || []) stamp(node);",
    replace: "for (const node of record.addedNodes || []) void node;",
  },
  {
    id: "no-initial-stamp",
    why: "a card that predates the plugin is warmed on its first press",
    find: "handler.stamp(document);",
    replace: "/* initial stamp disabled by mutant */",
  },
  {
    id: "no-fixed-region-guard",
    why: "the fixed path answers while a text field has the region",
    find: 'if (!context || context.region !== "page") return;',
    replace: "if (!context) return;",
  },
  {
    id: "no-fixed-modal-guard",
    why: "the fixed path answers under an unrelated modal",
    find: "if (context.modal !== null && context.modal !== undefined) return;",
    replace: "/* fixed modal guard disabled by mutant */",
  },
  {
    id: "no-null-target-guard",
    why: "a fixed input without a target is answered",
    find: "if (context.target === null || context.target === undefined) return;",
    replace: "/* null-target guard disabled by mutant */",
  },
  {
    id: "no-shortcuts-attach",
    why: "observeFixedInput is never subscribed",
    find: "const off = shortcuts.observeFixedInput(handler.onFixedInput);",
    replace: "const off = null;",
  },
  {
    id: "no-diag-cleanup",
    why: "window.__dshSpaceApprove survives unload",
    find: "delete window.__dshSpaceApprove;",
    replace: "/* diagnostics cleanup disabled by mutant */",
  },
  {
    id: "no-query-failed-reason",
    why: "a throwing panel query is not contained",
    find: 'return { reason: "query-failed" };',
    replace: "throw error;",
  },
  {
    id: "no-escape-setting",
    why: "localStorage cannot disable Escape",
    find: 'if (flag === "false" || flag === "0") escapeEnabled = false;',
    replace: "/* escape setting disabled by mutant */",
  },
];

function copyProject(destination, clientSource) {
  mkdirSync(join(destination, "test"), { recursive: true });
  for (const file of FILES) cpSync(join(ROOT, file), join(destination, file));
  cpSync(join(ROOT, "test", "space-approve.test.mjs"), join(destination, "test", "space-approve.test.mjs"));
  writeFileSync(join(destination, "client.js"), clientSource);
}

function runSuite(directory) {
  // Stdio must go to a file, not a pipe: capturing a child's piped output is
  // blocked under the DSH sandbox (EPERM on named pipes), and a file redirect is
  // also what the project's own runbook uses.
  const logPath = join(directory, "run.log");
  const fd = openSync(logPath, "w");
  let result;
  try {
    result = spawnSync(process.execPath, [join(directory, "test", "space-approve.test.mjs")], {
      cwd: directory,
      stdio: ["ignore", fd, fd],
      timeout: 120_000,
    });
  } finally {
    closeSync(fd);
  }
  const stdout = readFileSync(logPath, "utf8");
  const match = /RESULT: (\d+)\/(\d+) checks passed/.exec(stdout);
  const failed = stdout.split("\n").filter((line) => line.startsWith("FAIL")).length;
  return {
    status: result.status,
    failed,
    total: match ? Number(match[2]) : 0,
    passed: match ? Number(match[1]) : 0,
    output: stdout,
  };
}

const baseline = readFileSync(join(ROOT, "client.js"), "utf8");
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// A green baseline is the precondition: otherwise "every mutant is killed" could
// simply mean the copied suite never runs.
const baselineDir = join(WORK, "_baseline");
mkdirSync(baselineDir, { recursive: true });
copyProject(baselineDir, baseline);
const baselineResult = runSuite(baselineDir);
if (baselineResult.status !== 0 || baselineResult.total === 0) {
  console.log(`BASELINE FAILED (status=${baselineResult.status}, checks=${baselineResult.total}) — fix the suite before mutating:`);
  console.log(
    baselineResult.output
      .split("\n")
      .filter((line) => line.startsWith("FAIL"))
      .join("\n"),
  );
  process.exit(2);
}

console.log("=".repeat(78));
console.log(`mutation check: ${mutations.length} mutations, min score ${(MIN_SCORE * 100).toFixed(0)}%`);
console.log("=".repeat(78));

let killed = 0;
const survivors = [];
for (const mutation of mutations) {
  if (!baseline.includes(mutation.find)) {
    throw new Error(`mutation "${mutation.id}" does not match the current client.js — update the script`);
  }
  const directory = join(WORK, mutation.id);
  mkdirSync(directory, { recursive: true });
  copyProject(directory, baseline.replace(mutation.find, mutation.replace));
  const result = runSuite(directory);
  const isKilled = result.status !== 0;
  if (isKilled) killed += 1;
  else survivors.push(mutation);
  console.log(
    `${isKilled ? "KILLED  " : "SURVIVED"} ${mutation.id.padEnd(26)} failed=${String(result.failed).padStart(3)}/${result.total}  (${mutation.why})`,
  );
}

const score = killed / mutations.length;
console.log("\n" + "=".repeat(78));
console.log(`MUTATION SCORE: ${killed}/${mutations.length} = ${(score * 100).toFixed(1)}%`);
if (survivors.length > 0) {
  console.log(`survivors: ${survivors.map((mutation) => mutation.id).join(", ")}`);
}
console.log("=".repeat(78));

if (!KEEP) rmSync(WORK, { recursive: true, force: true });
if (score < MIN_SCORE) process.exitCode = 1;
