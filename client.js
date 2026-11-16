window.__ModuleLoader__.load({
  id: "dsh-space-approve",
  factory() {
    /**
     * Space approves / Escape rejects the pending approval request, without
     * requiring the user to click the approval card first.
     *
     * Input path: a capture-phase document listener runs before handlers on the
     * focused control can swallow Space, and the host's normalized
     * `shortcuts.observeFixedInput()` input acts as a secondary source. Answering
     * stops propagation, so the two paths never answer twice: the host dispatches
     * fixed input from a window *bubble* listener, which a capture-phase
     * `stopPropagation()` never reaches.
     *
     * Safety model, in order of importance:
     * 1. Semantic answer: the pending interaction published by
     *    `uiSession.sessionStatus` answers `"allowed-once"` / `"rejected"` — the
     *    same outcomes the official Enter/Escape handlers produce. We never
     *    click a card button, so an optional "Always allow" can never be
     *    triggered by Space (and a host without `answer()` is refused, not clicked).
     * 2. Only a visible, actually-pending request is answerable: a visible
     *    `[data-approval-key]` panel whose key matches a pending interaction with
     *    `kind === "approval"` and `answerable !== false`.
     * 3. Typing and focused controls keep their keys: editable region, an editor
     *    holding focus, IME composition (including the WebKit "composition just
     *    ended" keydown), key repeat, chorded keys, unrelated modals (dialogs and
     *    menus), and decision buttons *inside* the card all pass through.
     * 4. The composer takeover must not turn typing into an approval. When the
     *    official renderer hides the composer (containing the focused editor),
     *    focus falls back to <body>; the editor that last held focus is still in
     *    the document but no longer visible, and nothing has re-engaged the UI
     *    since. Space is then refused with `editor-hidden`: it never answers, it
     *    keeps the key from scrolling, and it stays on the propagation path so the
     *    fallback path cannot answer either. The test is re-evaluated at every
     *    keydown and never expires on a timer, so a click or a focus change
     *    re-enables Space immediately.
     * 5. The optional cooling-off window (`cooldownMs`, 0 by default) is a second,
     *    strictly weaker layer, only active when explicitly enabled through
     *    `localStorage`; it is not the defence against typing inertia.
     */

    /** Single source of truth for the diagnostic boot line; the test suite keeps it in sync with package.json. */
    const VERSION = "1.1.6";

    const PANEL = "[data-approval-key]";
    const EDITABLE =
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]';
    const ACTIVATABLE =
      'button, a[href], [role="button"], [role="switch"], input[type="checkbox"], input[type="radio"], summary';
    /** Aligned with the host's `modalSelector` (dsh-client-ui-primitives), menus included. */
    const MODAL = '[role="dialog"][aria-modal="true"], [role="menu"]';

    /** Client-visible settings: `localStorage["dsh-space-approve:<name>"]` (`debug`, `escape`, `cooldownMs`). */
    const STORAGE_PREFIX = "dsh-space-approve:";
    /**
     * The cooling-off window used to be the P0 defence and defaulted to 300ms; it only
     * delayed the misfire by one Space (measured: +300ms still approved) and swallowed
     * the first intentional press. The focus-loss guard replaced it, so the window is
     * off by default and exists only as an opt-in second layer.
     */
    const DEFAULT_COOLDOWN_MS = 0;
    const MAX_DIAG = 30;
    /** Bound for the appearance-time map; older keys are pruned first. */
    const MAX_SEEN_KEYS = 64;
    /** Bound for the "press ignored" warnings; one per key, not per keystroke. */
    const MAX_WARNED = 32;

    const readSetting = (name) => {
      try {
        return window.localStorage.getItem(STORAGE_PREFIX + name);
      } catch {
        return null;
      }
    };
    const debugEnabled = () => readSetting("debug") === "1";
    const log = (...args) => {
      if (debugEnabled()) console.info("[space-approve]", ...args);
    };
    const warn = (...args) => console.warn("[space-approve]", ...args);

    const isElement = (value) => typeof Element !== "undefined" && value instanceof Element;
    const closestOf = (node, selector) =>
      isElement(node) && typeof node.closest === "function" ? node.closest(selector) : null;
    const isEditable = (node) =>
      isElement(node) && (node.isContentEditable === true || closestOf(node, EDITABLE) !== null);

    const panelKey = (panel) => (panel && typeof panel.getAttribute === "function" ? panel.getAttribute("data-approval-key") : null);

    /**
     * "Visible enough to interact with", not "fully opaque": a card fading in
     * (`opacity: 0` transition) or hosted under a `content-visibility` wrapper is
     * still the card the user is being asked about. Hidden ancestors do exclude it.
     */
    const isVisible = (panel) => {
      if (!panel || panel.isConnected === false) return false;
      if (closestOf(panel, "[inert]") !== null) return false;
      if (typeof panel.checkVisibility === "function") {
        try {
          // No options: checks `display: none` (and hidden ancestors), not opacity.
          if (panel.checkVisibility() === false) return false;
        } catch {
          /* older engines: fall through to the manual checks */
        }
      }
      const view = panel.ownerDocument && panel.ownerDocument.defaultView;
      if (view && typeof view.getComputedStyle === "function") {
        try {
          const style = view.getComputedStyle(panel);
          if (style && (style.visibility === "hidden" || style.display === "none")) return false;
        } catch {
          /* ignore */
        }
      }
      if (typeof panel.getClientRects === "function") {
        try {
          if (panel.getClientRects().length === 0) return false;
        } catch {
          /* ignore */
        }
      }
      return true;
    };

    const pendingFor = (uiSession, key) => {
      if (key === null || key === undefined) return null;
      try {
        const snapshot = uiSession.sessionStatus.getSnapshot();
        if (!snapshot || typeof snapshot.values !== "function") {
          warn("sessionStatus snapshot is not a Map; approval hotkeys degraded");
          return null;
        }
        for (const status of snapshot.values()) {
          const pending = status && status.pendingInteraction;
          if (
            pending &&
            pending.kind === "approval" &&
            pending.key === key &&
            pending.answerable !== false
          ) {
            return pending;
          }
        }
      } catch (error) {
        warn("pending lookup failed", error);
      }
      return null;
    };

    /** Whichever topmost visible unrelated layer the host would report; menus count. */
    const topModal = () => {
      let modals;
      try {
        modals = Array.from(document.querySelectorAll(MODAL));
      } catch (error) {
        warn("modal query failed", error);
        return null;
      }
      const visible = modals.filter(isVisible);
      return visible.length === 0 ? null : visible[visible.length - 1];
    };

    /** The one semantic answer; a host that hides `answer()` gets a refusal, never a click. */
    const decide = (pending, action) => {
      if (typeof pending.answer !== "function") return false;
      const outcome = action === "reject" ? "rejected" : "allowed-once";
      try {
        const result = pending.answer(outcome);
        if (result && typeof result.catch === "function") result.catch((error) => warn("answer rejected", error));
        return true;
      } catch (error) {
        // Never fall back to clicking when a semantic answer exists but failed.
        warn("answer threw", error);
        return false;
      }
    };

    const viaLabel = (action) => (action === "reject" ? "Escape" : "Space");

    function actionOf(gesture) {
      if (!gesture) return null;
      if (gesture.code === "Space" || gesture.code === "Spacebar") return "allow";
      if (gesture.code === "Escape" || gesture.code === "Esc") return "reject";
      return null;
    }

    function actionOfDom(event) {
      if (!event) return null;
      const key = event.key;
      const code = event.code;
      if (key === " " || key === "Spacebar" || code === "Space") return "allow";
      if (key === "Escape" || key === "Esc" || code === "Escape") return "reject";
      return null;
    }

    function createHandler({ uiSession, escapeEnabled, cooldownMs, diag }) {
      const push = (bucket, entry) => {
        try {
          bucket.push({ t: Date.now(), ...entry });
          if (bucket.length > MAX_DIAG) bucket.splice(0, bucket.length - MAX_DIAG);
        } catch {
          /* diagnostics must never break the handler */
        }
      };

      /**
       * Record a key the guards swallowed, so "why did nothing happen" is answerable
       * from `window.__dshSpaceApprove.inputs`. One physical key gets exactly one
       * record: the primary path records after it decides, and the fallback path stays
       * silent when the primary path already prevented the default.
       */
      const skipInput = (via, source, skip) => {
        push(diag.inputs, { via, code: source && source.code, key: source && source.key, skip });
      };

      /** When each approval key first became visible; the P0 cooling-off window reads this. */
      const seenAt = new Map();
      const stamp = (root) => {
        if (!root) return;
        const panels = [];
        try {
          if (isElement(root) && typeof root.matches === "function" && root.matches(PANEL)) panels.push(root);
          if (typeof root.querySelectorAll === "function") panels.push(...root.querySelectorAll(PANEL));
        } catch {
          return;
        }
        if (panels.length === 0) return;
        const now = Date.now();
        for (const panel of panels) {
          const key = panelKey(panel);
          if (key !== null && key !== undefined && !seenAt.has(key)) seenAt.set(key, now);
        }
        while (seenAt.size > MAX_SEEN_KEYS) {
          const oldest = seenAt.keys().next();
          if (oldest.done) break;
          seenAt.delete(oldest.value);
        }
      };
      /**
       * Re-mounting a card for the same pending key must keep its original timestamp:
       * only a pending request that is really gone resets the appearance clock.
       */
      const dropSeen = (panel) => {
        const key = panelKey(panel);
        if (key === null || key === undefined) return;
        if (pendingFor(uiSession, key) !== null) return;
        seenAt.delete(key);
      };
      const forget = (root) => {
        if (!root) return;
        try {
          if (isElement(root) && typeof root.matches === "function" && root.matches(PANEL)) {
            dropSeen(root);
            return;
          }
          if (typeof root.querySelectorAll !== "function") return;
          for (const panel of root.querySelectorAll(PANEL)) dropSeen(panel);
        } catch {
          /* ignore */
        }
      };

      /** Record appearance as it happens; a lazily recorded time would swallow the first intentional Space. */
      const watchPanels = () => {
        if (typeof MutationObserver !== "function") return null;
        try {
          const observer = new MutationObserver((records) => {
            for (const record of records) {
              if (record.type === "attributes") {
                // React can set `data-approval-key` after the node is inserted; without
                // this the first press is eaten by the (optional) cooling-off window.
                stamp(record.target);
                continue;
              }
              for (const node of record.addedNodes || []) stamp(node);
              for (const node of record.removedNodes || []) forget(node);
            }
          });
          const root = document.documentElement || document;
          observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["data-approval-key"],
          });
          return observer;
        } catch (error) {
          warn("panel observer unavailable", error);
          return null;
        }
      };

      const resolveTarget = () => {
        let panels;
        try {
          panels = Array.from(document.querySelectorAll(PANEL));
        } catch (error) {
          warn("panel query failed", error);
          return { reason: "query-failed" };
        }
        const visible = panels.filter(isVisible);
        if (visible.length === 0) return { reason: panels.length === 0 ? "no-panel" : "no-panel:hidden" };
        const keys = [];
        const matches = [];
        for (const panel of visible) {
          const key = panelKey(panel);
          keys.push(key);
          const pending = pendingFor(uiSession, key);
          if (pending) matches.push({ panel, pending });
        }
        if (matches.length === 0) return { reason: "no-pending:" + keys.join(",") };
        if (matches.length > 1) return { reason: "multi-panel:" + matches.length };
        const target = matches[0];
        const modal = topModal();
        if (modal && typeof modal.contains === "function" && !modal.contains(target.panel)) {
          return { reason: "other-modal" };
        }
        return target;
      };

      const editingSomewhere = () => {
        const active = document.activeElement;
        return Boolean(active) && active !== document.body && isEditable(active);
      };

      /** A control inside the card keeps its own key. */
      const activatableInsideCard = (panel) => {
        const active = document.activeElement;
        return (
          Boolean(active) &&
          active !== document.body &&
          panel.contains(active) &&
          closestOf(active, ACTIVATABLE) !== null
        );
      };

      /** @returns {{acted: boolean, reason: string, key?: string}} */
      const run = (action) => {
        const target = resolveTarget();
        if (target.reason !== undefined) {
          // The pending request is really gone: the guard has nothing left to protect.
          if (String(target.reason).startsWith("no-pending:")) {
            lastEditable = null;
            engaged = false;
          }
          return { acted: false, reason: target.reason };
        }
        if (activatableInsideCard(target.panel)) return { acted: false, reason: "focus-in-card-control" };
        if (floatingLayerOfCard(target.panel)) return { acted: false, reason: "focus-in-card-control" };
        if (action === "allow" && hiddenEditorLost()) {
          return { acted: false, reason: "editor-hidden", key: target.pending.key };
        }
        if (action === "allow" && cooldownMs > 0) {
          const key = target.pending.key;
          const appearedAt = seenAt.get(key);
          if (typeof appearedAt !== "number") {
            // The observer missed the insertion (or it predates the plugin): start the
            // clock now and refuse this press, which is the safe direction. This only
            // applies while the optional cooling-off window is enabled.
            seenAt.set(key, Date.now());
            return { acted: false, reason: "warming:" + key, key };
          }
          if (Date.now() - appearedAt < cooldownMs) return { acted: false, reason: "warming:" + key, key };
        }
        if (!decide(target.pending, action)) return { acted: false, reason: "answer-failed" };
        log(action === "reject" ? "rejected with Escape" : "approved once with Space", target.pending.key);
        return { acted: true, reason: "answered" };
      };

      /**
       * Only answered keys are noisy by default. A refusal the user can perceive as
       * "nothing happened" (`editor-hidden`, `warming:<key>`) gets exactly one warning
       * per approval key, so the plugin never looks dead without a console trace.
       */
      const warned = new Set();
      const report = (via, action, result) => {
        if (result.acted) {
          warn(viaLabel(action), "→", result.reason);
          return;
        }
        const reason = String(result.reason || "");
        const visible = reason === "editor-hidden" || reason.startsWith("warming:");
        if (visible) {
          const once = reason + "|" + String(result.key);
          if (!warned.has(once) && warned.size < MAX_WARNED) {
            warned.add(once);
            warn(
              viaLabel(action),
              "ignored —",
              reason === "editor-hidden"
                ? "the composer hid the editor you were typing in; click anywhere (or press Escape) to answer"
                : "the approval card just appeared; press again",
            );
            return;
          }
        }
        log(via, viaLabel(action), "→", result.reason);
      };

      /**
       * rc.3's `ApprovalWarning` popover is a portalled, non-modal dialog opened from a
       * button inside the card. It does not match `MODAL` (no `aria-modal`), so a Space
       * or Escape pressed while reading it would answer the approval; treat a floating
       * layer anchored on an in-card `aria-controls` trigger as an in-card control.
       */
      const floatingLayerOfCard = (panel) => {
        const active = document.activeElement;
        if (!isElement(active) || active === document.body) return false;
        const layer = closestOf(active, '[role="dialog"]');
        if (!layer || layer.getAttribute("aria-modal") === "true") return false;
        if (panel.contains(layer)) return false;
        const id = layer.getAttribute("id");
        if (!id) return false;
        for (const trigger of panel.querySelectorAll("[aria-controls]")) {
          if (trigger.getAttribute("aria-controls") === id) return true;
        }
        return false;
      };

      /**
       * P0 guard. The composer takeover hides the focused editor (the slot fallback
       * becomes `display:none`) and the browser drops focus to <body>, so a Space typed
       * out of habit would approve a privileged call. The test is dynamic and time-free:
       * the editor that last held focus is still in the document but is no longer
       * visible, and nothing has re-engaged the UI since. It is re-evaluated on every
       * keydown, so a click or a focus change re-enables Space immediately.
       */
      let lastEditable = null;
      let engaged = false;
      /** contenteditable keydowns arrive from inner nodes: normalize to the editable root. */
      const normalizeEditable = (node) => closestOf(node, EDITABLE) || node;
      const rememberEditor = (node) => {
        lastEditable = normalizeEditable(node);
        engaged = false;
      };
      const hiddenEditorLost = () =>
        !engaged &&
        Boolean(lastEditable) &&
        document.activeElement !== lastEditable &&
        !isVisible(lastEditable);
      const onFocusIn = (event) => {
        const target = event && event.target;
        if (!isElement(target)) return;
        if (isEditable(target)) {
          rememberEditor(target);
          return;
        }
        // Focus settling on <body>/<html> is the symptom, not a re-engagement.
        if (target === document.body || target === document.documentElement) return;
        // Autofocus inside the approval card must not unlock the guard.
        if (closestOf(target, PANEL) !== null) return;
        engaged = true;
      };
      const onPointerDown = (event) => {
        const target = event && event.target;
        // Clicking inside the editor (caret move, selection) is still typing.
        if (isEditable(target)) {
          rememberEditor(target);
          return;
        }
        engaged = true;
      };

      /** Composition state mirrors the official card (WebKit reports isComposing late). */
      let composing = false;
      let compositionEnded = false;
      const resetComposition = () => {
        composing = false;
        compositionEnded = false;
      };
      /**
       * The host's own composition tracker also resets on window blur; without the same
       * reset one dangling `compositionstart` (for example when the composer was hidden
       * mid-composition) would silence Space and Escape forever.
       */
      const onWindowBlur = () => resetComposition();
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") resetComposition();
      };

      /** Primary path: capture phase, before control-level handlers. */
      const onDomKeyDown = (event) => {
        try {
          // Any keydown that lands in an editor means the user is still typing: reset the
          // "engaged the UI" flag silently, without writing a record per keystroke.
          if (isEditable(event.target)) rememberEditor(event.target);
          const action = actionOfDom(event);
          if (action === null) return;
          // Our own preventDefault (editor-hidden below) must not be recorded twice.
          if (event.defaultPrevented) return;
          if (event.repeat) {
            skipInput("dom", event, "repeat");
            return;
          }
          if (event.isComposing || event.keyCode === 229) {
            skipInput("dom", event, "ime");
            return;
          }
          if (isEditable(event.target)) {
            skipInput("dom", event, "editable-target");
            return;
          }
          if (composing) {
            skipInput("dom", event, "composing");
            return;
          }
          if (compositionEnded) {
            skipInput("dom", event, "composition-ended");
            return;
          }
          if (!escapeEnabled && action === "reject") return;
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
            skipInput("dom", event, "modifier");
            return;
          }
          if (!isElement(event.target)) return;
          if (editingSomewhere()) {
            rememberEditor(document.activeElement);
            skipInput("dom", event, "editor-focused");
            return;
          }
          const result = run(action);
          // One record per physical key; `skip` marks the press the P0 guard refused.
          push(diag.inputs, {
            via: "dom",
            code: event.code,
            key: event.key,
            mods: [event.ctrlKey, event.altKey, event.shiftKey, event.metaKey].filter(Boolean).join("+") || "-",
            ...(result.reason === "editor-hidden" ? { skip: "editor-hidden" } : {}),
          });
          push(diag.decisions, { via: "dom", action, ...result });
          report("dom", action, result);
          if (!result.acted) {
            // Focus is on <body> here, so Space would scroll the page; swallow that while
            // still letting the event propagate (the fallback path checks the flag).
            if (result.reason === "editor-hidden") event.preventDefault();
            return;
          }
          event.preventDefault();
          if (typeof event.stopPropagation === "function") event.stopPropagation();
        } catch (error) {
          warn("dom handler failed", error);
        }
      };

      const onCompositionStart = () => {
        composing = true;
      };
      const onCompositionEnd = () => {
        composing = false;
        compositionEnded = true;
      };
      /** The next key-up clears "composition just ended"; the blocked keydown arrives before it. */
      const onKeyUp = () => {
        compositionEnded = false;
      };

      /** Secondary path: host-normalized input. */
      const onFixedInput = (input) => {
        try {
          if (!input || input.type !== "keydown") return;
          const gesture = input.gesture;
          const context = input.context;
          const action = actionOf(gesture);
          if (action === null) return;
          // Silent: the primary path already answered or refused and called preventDefault.
          if (!gesture || gesture.defaultPrevented) return;
          if (!escapeEnabled && action === "reject") return;
          if (gesture.composing) {
            skipInput("shortcuts", gesture, "ime");
            return;
          }
          if (gesture.repeat) {
            skipInput("shortcuts", gesture, "repeat");
            return;
          }
          if (gesture.control || gesture.alt || gesture.shift || gesture.meta) {
            skipInput("shortcuts", gesture, "modifier");
            return;
          }
          if (!context || context.region !== "page") {
            skipInput("shortcuts", gesture, "not-page");
            return;
          }
          if (context.modal !== null && context.modal !== undefined) {
            skipInput("shortcuts", gesture, "modal");
            return;
          }
          // The host reports a null target when no element took the key; there is no
          // typing context to judge, and the DOM path already had its chance.
          if (context.target === null || context.target === undefined) {
            skipInput("shortcuts", gesture, "no-target");
            return;
          }
          if (editingSomewhere()) {
            rememberEditor(document.activeElement);
            skipInput("shortcuts", gesture, "editor-focused");
            return;
          }
          const result = run(action);
          push(diag.inputs, {
            via: "shortcuts",
            code: gesture && gesture.code,
            region: context.region,
            modal: context.modal,
            ...(result.reason === "editor-hidden" ? { skip: "editor-hidden" } : {}),
          });
          push(diag.decisions, { via: "shortcuts", action, ...result });
          report("shortcuts", action, result);
          if (!result.acted) return;
          if (typeof input.consume === "function") input.consume();
        } catch (error) {
          warn("fixed input handler failed", error);
        }
      };

      return {
        onDomKeyDown,
        onCompositionStart,
        onCompositionEnd,
        onKeyUp,
        onFixedInput,
        onFocusIn,
        onPointerDown,
        onWindowBlur,
        onVisibilityChange,
        watchPanels,
        stamp,
        diag,
      };
    }

    const resolveUiSession = (ctx) => {
      const service = typeof ctx.get === "function" ? ctx.get("uiSession") : undefined;
      return service || ctx.uiSession;
    };

    const numberSetting = (raw) => {
      if (raw === null || raw === undefined || raw === "") return null;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : null;
    };

    /**
     * `localStorage` is the channel the client half can actually read: the host
     * builds bundle entries with `{ name }` only, so `apply(ctx, config)` receives
     * `undefined` for bundles installed from a profile patch.
     */
    const resolveOptions = (config) => {
      const flag = readSetting("escape");
      let escapeEnabled = !config || config.escape !== false;
      if (flag === "false" || flag === "0") escapeEnabled = false;
      if (flag === "true" || flag === "1") escapeEnabled = true;
      const stored = numberSetting(readSetting("cooldownMs"));
      const fromConfig = config && Number.isFinite(config.cooldownMs) && config.cooldownMs >= 0 ? config.cooldownMs : null;
      const cooldownMs = stored !== null ? stored : fromConfig !== null ? fromConfig : DEFAULT_COOLDOWN_MS;
      return { escapeEnabled, cooldownMs };
    };

    return {
      inject: ["uiSession"],
      apply(ctx, config) {
        // One live instance per page: a duplicate apply (HMR, double mount) replaces the
        // previous one instead of stacking listeners and stealing its diagnostics.
        const previous = window.__dshSpaceApproveTeardown;
        if (typeof previous === "function") {
          try {
            previous();
          } catch (error) {
            log("previous teardown failed", error);
          }
        }
        const diag = { boot: null, inputs: [], decisions: [] };
        window.__dshSpaceApprove = diag;
        const service = resolveUiSession(ctx);
        if (!service || !service.sessionStatus) {
          warn("uiSession service unavailable; approval hotkeys disabled");
          diag.boot = "no-uiSession";
          return;
        }
        const { escapeEnabled, cooldownMs } = resolveOptions(config);
        const handler = createHandler({ uiSession: service, escapeEnabled, cooldownMs, diag });
        const disposers = [];
        let disposed = false;
        const disposeAll = () => {
          disposed = true;
          for (const dispose of disposers.splice(0)) {
            try {
              dispose();
            } catch (error) {
              log("dispose failed", error);
            }
          }
          if (window.__dshSpaceApprove === diag) delete window.__dshSpaceApprove;
          if (window.__dshSpaceApproveTeardown === disposeAll) window.__dshSpaceApproveTeardown = undefined;
        };
        window.__dshSpaceApproveTeardown = disposeAll;

        document.addEventListener("keydown", handler.onDomKeyDown, true);
        disposers.push(() => document.removeEventListener("keydown", handler.onDomKeyDown, true));
        document.addEventListener("compositionstart", handler.onCompositionStart, true);
        disposers.push(() => document.removeEventListener("compositionstart", handler.onCompositionStart, true));
        document.addEventListener("compositionend", handler.onCompositionEnd, true);
        disposers.push(() => document.removeEventListener("compositionend", handler.onCompositionEnd, true));
        document.addEventListener("keyup", handler.onKeyUp, true);
        disposers.push(() => document.removeEventListener("keyup", handler.onKeyUp, true));
        document.addEventListener("focusin", handler.onFocusIn, true);
        disposers.push(() => document.removeEventListener("focusin", handler.onFocusIn, true));
        document.addEventListener("pointerdown", handler.onPointerDown, true);
        disposers.push(() => document.removeEventListener("pointerdown", handler.onPointerDown, true));
        document.addEventListener("visibilitychange", handler.onVisibilityChange, true);
        disposers.push(() => document.removeEventListener("visibilitychange", handler.onVisibilityChange, true));
        window.addEventListener("blur", handler.onWindowBlur);
        disposers.push(() => window.removeEventListener("blur", handler.onWindowBlur));

        handler.stamp(document);
        const observer = handler.watchPanels();
        if (observer) disposers.push(() => observer.disconnect());

        const boot = { version: VERSION, mode: "dom", escape: escapeEnabled, cooldownMs, at: Date.now() };
        diag.boot = boot;

        const registerFixedInput = (shortcuts) => {
          if (!shortcuts || typeof shortcuts.observeFixedInput !== "function") return null;
          try {
            const off = shortcuts.observeFixedInput(handler.onFixedInput);
            boot.mode = "dom+shortcuts";
            log("fixed-input path attached");
            return typeof off === "function" ? off : null;
          } catch (error) {
            warn("observeFixedInput unavailable", error);
            return null;
          }
        };

        if (typeof ctx.inject === "function") {
          // Official pattern: wait for the service instead of racing it with `ctx.get`.
          try {
            ctx.inject(["shortcuts"], (scope) => {
              const attach = () => {
                // The instance was disposed while the service was still coming up.
                if (disposed) return () => {};
                const off = registerFixedInput(scope && scope.shortcuts);
                return () => {
                  if (typeof off === "function") off();
                };
              };
              if (scope && typeof scope.effect === "function") {
                try {
                  // Keep the disposer: a duplicate apply must be able to detach this
                  // instance's fixed-input listener too, not only its DOM listeners.
                  const dispose = scope.effect(attach, "dsh-space-approve: fixed input");
                  if (typeof dispose === "function") disposers.push(dispose);
                  return;
                } catch (error) {
                  warn("shortcuts effect failed", error);
                }
              }
              const dispose = attach();
              if (typeof dispose === "function") disposers.push(dispose);
            });
          } catch (error) {
            warn("ctx.inject failed; using the DOM path only", error);
          }
        } else {
          const shortcuts = typeof ctx.get === "function" ? ctx.get("shortcuts") : undefined;
          const dispose = registerFixedInput(shortcuts);
          if (typeof dispose === "function") disposers.push(dispose);
          if (boot.mode === "dom") warn("shortcuts service unavailable; using the DOM path only (mode=dom)");
        }

        if (typeof ctx.effect === "function") {
          ctx.effect(() => disposeAll, "dsh-space-approve: Space approves once, Escape rejects");
        }
        warn("[space-approve] ready", boot);
      },
    };
  },
});
