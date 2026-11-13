window.__ModuleLoader__.load({
  id: "dsh-space-approve",
  factory(require) {
    /**
     * Space approves / Escape rejects the pending approval request, without
     * requiring the user to click the approval card first.
     *
     * Input path: a capture-phase document listener runs before handlers on the
     * focused control can swallow Space, and the host's normalized
     * `shortcuts.observeFixedInput()` input acts as a secondary source. Answering
     * stops propagation, so the two paths never answer twice.
     *
     * Safety model, in order of importance:
     * 1. Semantic answer: the pending interaction published by
     *    `uiSession.sessionStatus` answers `"allowed-once"` / `"rejected"` — the
     *    same outcomes the official Enter/Escape handlers produce. We never
     *    click "the last button", so an optional "Always allow" can never be
     *    triggered by Space.
     * 2. Only the visible, actually-pending request is answerable: exactly one
     *    visible `[data-approval-key]` panel, and a pending interaction whose
     *    key matches that panel.
     * 3. Typing and focused controls keep their keys: editable region, an editor
     *    holding focus, IME composition, key repeat, chorded keys, unrelated
     *    modals, and decision buttons *inside* the card all pass through.
     */

    const PANEL = "[data-approval-key]";
    const DETAIL = "[data-approval-scroll]";
    const EDITABLE =
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]';
    const ACTIVATABLE =
      'button, a[href], [role="button"], [role="combobox"], [role="switch"], input[type="checkbox"], input[type="radio"], summary';
    const MODAL = '[role="dialog"][aria-modal="true"], dialog[open]';

    /** Debug switch: `localStorage.setItem("dsh-space-approve:debug", "1")`. */
    const debugEnabled = () => {
      try {
        return window.localStorage.getItem("dsh-space-approve:debug") === "1";
      } catch {
        return false;
      }
    };
    const log = (...args) => {
      if (debugEnabled()) console.info("[space-approve]", ...args);
    };
    const warn = (...args) => console.warn("[space-approve]", ...args);

    const isElement = (value) => typeof Element !== "undefined" && value instanceof Element;
    const closestOf = (node, selector) =>
      isElement(node) && typeof node.closest === "function" ? node.closest(selector) : null;
    const isEditable = (node) =>
      isElement(node) && (node.isContentEditable === true || closestOf(node, EDITABLE) !== null);

    const isVisible = (panel) => {
      if (!panel || panel.isConnected === false) return false;
      if (closestOf(panel, "[inert]") !== null) return false;
      if (typeof panel.checkVisibility === "function") {
        try {
          if (panel.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === false) return false;
        } catch {
          /* older engines: fall through */
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
      try {
        const snapshot = uiSession.sessionStatus.getSnapshot();
        for (const status of snapshot.values()) {
          const pending = status && status.pendingInteraction;
          if (pending && pending.kind === "approval" && pending.key === key && pending.answerable !== false) {
            return pending;
          }
        }
      } catch (error) {
        warn("pending lookup failed", error);
      }
      return null;
    };

    /** Decision buttons of the card, excluding controls inside the detail region. */
    const decisionButtons = (panel) => {
      const detail = panel.querySelector(DETAIL);
      return Array.from(panel.querySelectorAll("button")).filter(
        (button) => !button.disabled && (detail === null || !detail.contains(button)),
      );
    };

    /** Last-resort click for a host that stops exposing `answer()`; never the persistent grant. */
    const clickDecision = (panel, action) => {
      const buttons = decisionButtons(panel);
      if (buttons.length === 0) return false;
      const button = action === "reject" ? buttons[0] : buttons.length >= 3 ? buttons[buttons.length - 2] : buttons[buttons.length - 1];
      if (!button) return false;
      button.click();
      return true;
    };

    const decide = (panel, pending, action) => {
      const outcome = action === "reject" ? "rejected" : "allowed-once";
      if (typeof pending.answer === "function") {
        try {
          const result = pending.answer(outcome);
          if (result && typeof result.catch === "function") result.catch((error) => warn("answer rejected", error));
          return true;
        } catch (error) {
          // Never fall back to clicking when a semantic answer exists but failed.
          warn("answer threw", error);
          return false;
        }
      }
      return clickDecision(panel, action);
    };

    function createHandler({ uiSession, escapeEnabled }) {
      /** Diagnostics on `window.__dshSpaceApprove`; also readable from DevTools. */
      const diag = (() => {
        const existing = window.__dshSpaceApprove;
        if (existing && Array.isArray(existing.inputs)) return existing;
        const fresh = { boot: null, inputs: [], decisions: [] };
        window.__dshSpaceApprove = fresh;
        return fresh;
      })();
      const push = (bucket, entry) => {
        try {
          bucket.push({ t: Date.now(), ...entry });
          if (bucket.length > 30) bucket.splice(0, bucket.length - 30);
        } catch {
          /* diagnostics must never break the handler */
        }
      };

      /** Resolve the single pending, visible approval request, or say why not. */
      const resolveTarget = () => {
        let panels;
        try {
          panels = Array.from(document.querySelectorAll(PANEL)).filter(isVisible);
        } catch (error) {
          warn("panel query failed", error);
          return { reason: "query-failed" };
        }
        if (panels.length === 0) return { reason: "no-panel" };
        if (panels.length > 1) return { reason: "multi-panel:" + panels.length };
        const panel = panels[0];
        const modal = document.querySelector(MODAL);
        if (modal && typeof modal.contains === "function" && !modal.contains(panel)) return { reason: "other-modal" };
        const key = panel.getAttribute("data-approval-key");
        const pending = pendingFor(uiSession, key);
        if (!pending) return { reason: "no-pending:" + key };
        return { panel, pending };
      };

      const editingSomewhere = () => {
        const active = document.activeElement;
        return Boolean(active) && active !== document.body && isEditable(active);
      };

      /** A decision control inside the card keeps its own key. */
      const activatableInsideCard = (panel) => {
        const active = document.activeElement;
        return (
          Boolean(active) &&
          active !== document.body &&
          panel.contains(active) &&
          closestOf(active, ACTIVATABLE) !== null
        );
      };

      /** @returns {{acted: boolean, reason: string}} */
      const run = (action) => {
        const target = resolveTarget();
        if (target.reason !== undefined) return { acted: false, reason: target.reason };
        if (activatableInsideCard(target.panel)) return { acted: false, reason: "focus-in-card-control" };
        if (!decide(target.panel, target.pending, action)) return { acted: false, reason: "answer-failed" };
        log(action === "reject" ? "rejected with Escape" : "approved once with Space", target.pending.key);
        return { acted: true, reason: "answered" };
      };

      /** Primary path: capture phase, before control-level handlers. */
      const onDomKeyDown = (event) => {
        try {
          const action = actionOfDom(event);
          if (action === null) return;
          const facts = {
            via: "dom",
            code: event.code,
            key: event.key,
            composing: Boolean(event.isComposing),
            keyCode: event.keyCode,
            repeat: Boolean(event.repeat),
            prevented: Boolean(event.defaultPrevented),
            mods: [event.ctrlKey, event.altKey, event.shiftKey, event.metaKey].filter(Boolean).join("+") || "-",
          };
          push(diag.inputs, facts);
          if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
          if (!escapeEnabled && action === "reject") return;
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
          if (!isElement(event.target) || isEditable(event.target) || editingSomewhere()) return;
          const result = run(action);
          push(diag.decisions, { via: "dom", action, ...result });
          console.info("[space-approve]", viaLabel(action), "→", result.reason);
          if (!result.acted) return;
          event.preventDefault();
          if (typeof event.stopPropagation === "function") event.stopPropagation();
        } catch (error) {
          warn("dom handler failed", error);
        }
      };

      /** Secondary path: host-normalized input. */
      const onFixedInput = (input) => {
        try {
          if (!input || input.type !== "keydown") return;
          const gesture = input.gesture;
          const context = input.context;
          const action = actionOf(gesture);
          if (action === null) return;
          push(diag.inputs, {
            via: "shortcuts",
            code: gesture && gesture.code,
            composing: Boolean(gesture && gesture.composing),
            repeat: Boolean(gesture && gesture.repeat),
            prevented: Boolean(gesture && gesture.defaultPrevented),
            region: context && context.region,
            modal: context && context.modal,
          });
          if (!escapeEnabled && action === "reject") return;
          if (!gesture || gesture.defaultPrevented || gesture.composing || gesture.repeat) return;
          if (gesture.control || gesture.alt || gesture.shift || gesture.meta) return;
          if (context && context.region !== "page") return;
          if (context && context.modal !== null && context.modal !== undefined) return;
          if (editingSomewhere()) return;
          const result = run(action);
          push(diag.decisions, { via: "shortcuts", action, ...result });
          console.info("[space-approve] shortcuts", viaLabel(action), "→", result.reason);
          if (!result.acted) return;
          if (typeof input.consume === "function") input.consume();
        } catch (error) {
          warn("fixed input handler failed", error);
        }
      };

      return { onFixedInput, onDomKeyDown };
    }

    const viaLabel = (action) => (action === "reject" ? "Escape" : "Space");

    function actionOf(gesture) {      if (!gesture) return null;
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

    return {
      inject: ["uiSession"],
      apply(ctx, config) {
        const uiSession = typeof ctx.get === "function" ? ctx.get("uiSession") : undefined;
        const service = uiSession || ctx.uiSession;
        if (!service || !service.sessionStatus) {
          warn("uiSession service unavailable; approval hotkeys disabled");
          window.__dshSpaceApprove = { boot: "no-uiSession", inputs: [], decisions: [] };
          return;
        }
        const escapeEnabled = !config || config.escape !== false;
        const shortcuts = typeof ctx.get === "function" ? ctx.get("shortcuts") : undefined;
        const handler = createHandler({ uiSession: service, escapeEnabled });
        const disposers = [];

        document.addEventListener("keydown", handler.onDomKeyDown, true);
        disposers.push(() => document.removeEventListener("keydown", handler.onDomKeyDown, true));

        let mode = "dom";
        if (shortcuts && typeof shortcuts.observeFixedInput === "function") {
          try {
            const off = shortcuts.observeFixedInput(handler.onFixedInput);
            if (typeof off === "function") disposers.push(off);
            mode = "dom+shortcuts";
          } catch (error) {
            warn("observeFixedInput unavailable", error);
          }
        }

        if (typeof ctx.effect === "function") {
          ctx.effect(
            () => () => {
              for (const dispose of disposers) {
                try {
                  dispose();
                } catch (error) {
                  log("dispose failed", error);
                }
              }
            },
            "dsh-space-approve: Space approves once, Escape rejects",
          );
        }
        const boot = { version: "1.1.2", mode, escape: escapeEnabled, at: Date.now() };
        if (window.__dshSpaceApprove) window.__dshSpaceApprove.boot = boot;
        console.info("[space-approve] ready", boot);
      },
    };
  },
});
