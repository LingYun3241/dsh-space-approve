/**
 * Mutation check for the safety-critical parts of client.js.
 *
 * For every mutation below the project is copied into `test/.mutants/<id>/`, one
 * exact source fragment is replaced, and the full suite is executed there.
 * A mutation is "killed" when the suite fails AND the run is trustworthy:
 * `failed > 0` and `total >= baselineTotal` (the same suite ran). A mutation whose
 * run crashed (total 0) is reported as SUSPECT, never counted as killed.
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
  /* ---------------------------- input paths ---------------------------- */
  {
    id: "capture-to-bubble",
    why: "primary listener drops out of the capture phase",
    find: 'document.addEventListener("keydown", handler.onDomKeyDown, true);',
    replace: 'document.addEventListener("keydown", handler.onDomKeyDown, false);',
  },
  {
    id: "no-repeat-guard",
    why: "DOM path answers a held Space",
    find: '          if (event.repeat) {\n            skipInput("dom", event, "repeat");\n            return;\n          }',
    replace: "          /* repeat guard disabled by mutant */",
  },
  {
    id: "no-ime-keycode",
    why: "DOM path answers keyCode 229 (IME)",
    find: "if (event.isComposing || event.keyCode === 229) {",
    replace: "if (event.isComposing) {",
  },
  {
    id: "no-iscomposing",
    why: "DOM path answers mid-composition",
    find: "if (event.isComposing || event.keyCode === 229) {",
    replace: "if (event.keyCode === 229) {",
  },
  {
    id: "no-composition-ended",
    why: "the WebKit composition-end keydown approves",
    find: '          if (compositionEnded) {\n            skipInput("dom", event, "composition-ended");\n            return;\n          }',
    replace: "          /* composition-ended guard disabled by mutant */",
  },
  {
    id: "no-composing-flag",
    why: "compositionstart state is not tracked",
    find: '          if (composing) {\n            skipInput("dom", event, "composing");\n            return;\n          }',
    replace: "          /* composing guard disabled by mutant */",
  },
  {
    id: "no-composition-skip-record",
    why: "an IME-composition key leaves no diagnostic record",
    find: '          if (composing) {\n            skipInput("dom", event, "composing");\n            return;\n          }',
    replace: "          if (composing) return;",
  },
  {
    id: "no-editing-somewhere",
    why: "focus in an editor no longer blocks when the event target is <body>",
    find: '          if (editingSomewhere()) {\n            rememberEditor(document.activeElement);\n            skipInput("dom", event, "editor-focused");\n            return;\n          }',
    replace: "          /* editor-focus guard disabled by mutant */",
  },
  {
    id: "no-editable-target",
    why: "an editable event target no longer blocks",
    find: '          if (isEditable(event.target)) {\n            skipInput("dom", event, "editable-target");\n            return;\n          }',
    replace: "          /* editable-target guard disabled by mutant */",
  },
  {
    id: "no-dom-escape-switch",
    why: "config/localStorage cannot disable Escape on the DOM path",
    find: '          if (!escapeEnabled && action === "reject") return;\n          if (event.ctrlKey',
    replace: "          if (event.ctrlKey",
  },
  {
    id: "no-fixed-escape-switch",
    why: "config/localStorage cannot disable Escape on the fixed path",
    find: '          if (!escapeEnabled && action === "reject") return;\n          if (gesture.composing) {',
    replace: "          if (gesture.composing) {",
  },
  {
    id: "no-fixed-editing-guard",
    why: "the fixed path answers while an editor holds focus",
    find: '          if (editingSomewhere()) {\n            rememberEditor(document.activeElement);\n            skipInput("shortcuts", gesture, "editor-focused");\n            return;\n          }',
    replace: "          /* fixed editor-focus guard disabled by mutant */",
  },

  /* ------------------------------ layers ------------------------------- */
  {
    id: "no-dom-modal-guard",
    why: "an unrelated modal no longer suppresses the DOM path",
    find: 'if (modal && typeof modal.contains === "function" && !modal.contains(target.panel)) {',
    replace: 'if (modal && false && typeof modal.contains === "function" && !modal.contains(target.panel)) {',
  },
  {
    id: "modal-selector-without-menu",
    why: "menus stop counting as modal layers",
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

  /* ----------------------------- matching ------------------------------ */
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

  /* ------------------------- answering semantics ----------------------- */
  {
    id: "dom-consumes-nothing",
    why: "a refusal still preventDefaults and stops the Space",
    find: "          if (!result.acted) {",
    replace: "          if (false) {",
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
    id: "no-editor-hidden-consume",
    why: "the editor-hidden refusal lets Space scroll the page",
    find: 'if (result.reason === "editor-hidden") event.preventDefault();',
    replace: "/* editor-hidden consume disabled by mutant */",
  },
  {
    id: "no-default-prevented-guard",
    why: "a key another handler already prevented is answered anyway",
    find: '          // Our own preventDefault (editor-hidden below) must not be recorded twice.\n          if (event.defaultPrevented) return;',
    replace: "          /* default-prevented guard disabled by mutant */",
  },
  {
    id: "no-default-prevented-silent",
    why: "the fallback path double-records our own preventDefault",
    find: '          // Silent: the primary path already answered or refused and called preventDefault.\n          if (!gesture || gesture.defaultPrevented) return;',
    replace: '          if (!gesture || gesture.defaultPrevented) {\n            skipInput("shortcuts", gesture, "default-prevented");\n            return;\n          }',
  },

  /* ------------------- P0 editor-hidden guard (v1.1.6) ----------------- */
  {
    id: "no-editor-hidden-guard",
    why: "Space typed into a vanished editor approves again (P0)",
    find: '        if (action === "allow" && hiddenEditorLost()) {\n          return { acted: false, reason: "editor-hidden", key: target.pending.key };\n        }',
    replace: "        /* editor-hidden guard disabled by mutant */",
  },
  {
    id: "no-last-editable",
    why: "the last focused editor is never remembered",
    find: "      const rememberEditor = (node) => {\n        lastEditable = normalizeEditable(node);\n        engaged = false;\n      };",
    replace: "      const rememberEditor = (node) => {\n        void node;\n      };",
  },
  {
    id: "no-visibility-recheck",
    why: "the guard locks on focus loss instead of on the editor being hidden",
    find: "        document.activeElement !== lastEditable &&\n        !isVisible(lastEditable);",
    replace: "        document.activeElement !== lastEditable;",
  },
  {
    id: "add-connected-exemption",
    why: "an unmounted editor (isConnected === false) escapes the guard",
    find: "        Boolean(lastEditable) &&\n        document.activeElement !== lastEditable &&",
    replace: "        Boolean(lastEditable) &&\n        lastEditable.isConnected !== false &&\n        document.activeElement !== lastEditable &&",
  },
  {
    id: "pointerdown-always-engage",
    why: "clicking inside the editor unlocks the guard (P0 via caret move)",
    find: "        // Clicking inside the editor (caret move, selection) is still typing.\n        if (isEditable(target)) {\n          rememberEditor(target);\n          return;\n        }\n        engaged = true;",
    replace: "        engaged = true;",
  },
  {
    id: "no-pointerdown-engage",
    why: "a click can no longer re-enable Space",
    find: "        engaged = true;\n      };\n\n      /** Composition state mirrors",
    replace: "        void 0;\n      };\n\n      /** Composition state mirrors",
  },
  {
    id: "no-engage-reset",
    why: "typing again after a click no longer resets the engaged flag",
    find: "          if (isEditable(event.target)) rememberEditor(event.target);\n",
    replace: "          if (isEditable(event.target)) void 0;\n",
  },
  {
    id: "focusin-ignores-panel",
    why: "autofocus inside the card unlocks the guard",
    find: "        // Autofocus inside the approval card must not unlock the guard.\n        if (closestOf(target, PANEL) !== null) return;",
    replace: "        /* panel filter disabled by mutant */",
  },
  {
    id: "no-focusin-engage",
    why: "focusing a control outside the card no longer re-enables Space",
    find: "        engaged = true;\n      };\n      const onPointerDown",
    replace: "        void 0;\n      };\n      const onPointerDown",
  },

  /* --------------------- composition watchdog resets ------------------ */
  {
    id: "no-window-blur-reset",
    why: "a dangling composition survives a window switch (Space and Escape dead)",
    find: '        window.addEventListener("blur", handler.onWindowBlur);\n        disposers.push(() => window.removeEventListener("blur", handler.onWindowBlur));',
    replace: "        /* window blur reset disabled by mutant */",
  },
  {
    id: "no-visibility-reset",
    why: "a dangling composition survives the page being hidden",
    find: '        if (document.visibilityState === "hidden") resetComposition();',
    replace: "        /* visibility reset disabled by mutant */",
  },

  /* ------------------- appearance clock (opt-in window) --------------- */
  {
    id: "no-cooldown",
    why: "the opt-in cooling-off window disappears",
    find: 'if (Date.now() - appearedAt < cooldownMs) return { acted: false, reason: "warming:" + key, key };',
    replace: "/* cooldown disabled by mutant */",
  },
  {
    id: "no-lazy-cooldown-guard",
    why: "a card without a timestamp is refused even with the window off",
    find: '        if (action === "allow" && cooldownMs > 0) {',
    replace: '        if (action === "allow") {',
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
    id: "observer-no-attributes",
    why: "a data-approval-key set after insertion is never stamped",
    find: '            attributes: true,\n            attributeFilter: ["data-approval-key"],',
    replace: "            /* attribute observation disabled by mutant */",
  },
  {
    id: "forget-always-on-remount",
    why: "re-mounting a card restarts the cooling-off clock",
    find: "        if (pendingFor(uiSession, key) !== null) return;",
    replace: "        /* remount keeps the timestamp (mutant: always forget) */",
  },

  /* ------------------------ host integration -------------------------- */
  {
    id: "no-fixed-region-guard",
    why: "the fixed path answers while a text field has the region",
    find: '          if (!context || context.region !== "page") {\n            skipInput("shortcuts", gesture, "not-page");\n            return;\n          }',
    replace: "          /* fixed region guard disabled by mutant */",
  },
  {
    id: "no-fixed-modal-guard",
    why: "the fixed path answers under an unrelated modal",
    find: '          if (context.modal !== null && context.modal !== undefined) {\n            skipInput("shortcuts", gesture, "modal");\n            return;\n          }',
    replace: "          /* fixed modal guard disabled by mutant */",
  },
  {
    id: "no-null-target-guard",
    why: "a fixed input without a target is answered",
    find: '          if (context.target === null || context.target === undefined) {\n            skipInput("shortcuts", gesture, "no-target");\n            return;\n          }',
    replace: "          /* null-target guard disabled by mutant */",
  },
  {
    id: "no-shortcuts-attach",
    why: "observeFixedInput is never subscribed",
    find: "const off = shortcuts.observeFixedInput(handler.onFixedInput);",
    replace: "const off = null;",
  },
  {
    id: "no-floating-layer-guard",
    why: "Space/Escape inside the card's warning popover answer the approval",
    find: '        if (floatingLayerOfCard(target.panel)) return { acted: false, reason: "focus-in-card-control" };',
    replace: "        /* floating-layer guard disabled by mutant */",
  },

  /* ------------------------ diagnostics / lifecycle ------------------- */
  {
    id: "no-diag-cleanup",
    why: "window.__dshSpaceApprove survives unload",
    find: "if (window.__dshSpaceApprove === diag) delete window.__dshSpaceApprove;",
    replace: "/* diagnostics cleanup disabled by mutant */",
  },
  {
    id: "unconditional-diag-delete",
    why: "a stale disposer deletes the live instance's diagnostics",
    find: "          if (window.__dshSpaceApprove === diag) delete window.__dshSpaceApprove;",
    replace: "          delete window.__dshSpaceApprove;",
  },
  {
    id: "no-apply-idempotence",
    why: "a duplicate apply stacks listeners instead of replacing the instance",
    find: '        if (typeof previous === "function") {\n          try {\n            previous();\n          } catch (error) {\n            log("previous teardown failed", error);\n          }\n        }',
    replace: "        void previous;",
  },
  {
    id: "no-inputs-record",
    why: "candidate keys are no longer recorded in diagnostics",
    find: "          // One record per physical key; `skip` marks the press the P0 guard refused.\n          push(diag.inputs, {",
    replace: "          // One record per physical key; `skip` marks the press the P0 guard refused.\n          void ({",
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
  mkdirSync(join(destination, ".github"), { recursive: true });
  for (const file of FILES) cpSync(join(ROOT, file), join(destination, file));
  cpSync(join(ROOT, "test", "space-approve.test.mjs"), join(destination, "test", "space-approve.test.mjs"));
  cpSync(join(ROOT, ".github", "RELEASE_NOTES_v1.1.6.md"), join(destination, ".github", "RELEASE_NOTES_v1.1.6.md"));
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
const baselineTotal = baselineResult.total;

console.log("=".repeat(78));
console.log(`mutation check: ${mutations.length} mutations, min score ${(MIN_SCORE * 100).toFixed(0)}%, suite ${baselineTotal} checks`);
console.log("=".repeat(78));

let killed = 0;
const survivors = [];
const suspects = [];
for (const mutation of mutations) {
  const occurrences = baseline.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(`mutation "${mutation.id}" matches ${occurrences} places in client.js (must be exactly 1) — update the script`);
  }
  const directory = join(WORK, mutation.id);
  mkdirSync(directory, { recursive: true });
  const mutated = baseline.replace(mutation.find, mutation.replace);
  if (mutated === baseline) throw new Error(`mutation "${mutation.id}" did not change client.js`);
  copyProject(directory, mutated);
  const result = runSuite(directory);
  const trustworthy = result.failed > 0 && result.total >= baselineTotal;
  const isKilled = result.status !== 0 && trustworthy;
  if (isKilled) killed += 1;
  else if (result.total === 0) suspects.push(mutation);
  else survivors.push(mutation);
  console.log(
    `${isKilled ? "KILLED  " : result.total === 0 ? "SUSPECT " : "SURVIVED"} ${mutation.id.padEnd(28)} failed=${String(result.failed).padStart(3)}/${result.total}  (${mutation.why})`,
  );
}

const score = killed / mutations.length;
console.log("\n" + "=".repeat(78));
// No percentage headline on purpose: this is a hand-picked set, not a coverage metric.
console.log(`MUTATION SCORE: ${killed}/${mutations.length} killed (hand-picked set; not a coverage metric)`);
if (survivors.length > 0) console.log(`survivors: ${survivors.map((mutation) => mutation.id).join(", ")}`);
if (suspects.length > 0) console.log(`suspects (crash-only runs, not counted as killed): ${suspects.map((mutation) => mutation.id).join(", ")}`);
console.log("=".repeat(78));

if (!KEEP) rmSync(WORK, { recursive: true, force: true });
if (score < MIN_SCORE) process.exitCode = 1;
