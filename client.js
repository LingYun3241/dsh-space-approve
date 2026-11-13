window.__ModuleLoader__.load({
  id: "dsh-space-approve",
  factory(require) {
    /**
     * Space approves / Escape rejects the pending approval request, without
     * requiring the user to click the approval card first.
     *
     * Input path: the official `shortcuts` service (`observeFixedInput`) hands
     * us normalized key facts (code, modifiers, repeat, IME composition, modal,
     * input region), so IME/dead-key/AltGraph handling and modal tracking stay
     * owned by the host. When that service is missing we fall back to a plain
     * document keydown listener with equivalent local guards.
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
     * 3. Typing and focused controls keep their keys: editable region,
     *    `document.activeElement` in an editor, IME composition, key repeat,
     *    chorded keys, unrelated modals, and buttons *inside* the card (native
     *    activation is the user's intent there) all pass through untouched.
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

    const isElement = (value) => typeof Element !== "undefined" && value instanceof Element;
    const closestOf = (node, selector) =>
      isElement(node) && typeof node.closest === "function" ? node.closest(selector) : null;
    const isEditable = (node) =>
      isElement(node) && (node.isContentEditable === true || closestOf(node, EDITABLE) !== null);

    /** A panel counts only when it is really on screen (not inert, hidden or display:none). */
    const isVisible = (panel) => {
      if (!panel || panel.isConnected === false) return false;
      if (closestOf(panel, "[inert]") !== null) return false;
      if (typeof panel.checkVisibility === "function") {
        try {
          if (panel.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === false) return false;
        } catch {
          /* older engines: fall through to the remaining checks */
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

    /** The runtime record of the request the user is currently looking at. */
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
        log("pending lookup failed", error);
      }
      return null;
    };

    /** Decision buttons of the card, excluding any control rendered inside the detail region. */
    const decisionButtons = (panel) => {
      const detail = panel.querySelector(DETAIL);
      return Array.from(panel.querySelectorAll("button")).filter(
        (button) => !button.disabled && (detail === null || !detail.contains(button)),
      );
    };

    /**
     * Fallback for a host that stops exposing `answer()`: click the button that
     * carries this outcome. Never the persistent grant:
     * [Reject, Allow once] or [Reject, Allow once, Always allow].
     */
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
          if (result && typeof result.catch === "function") result.catch((error) => log("answer rejected", error));
          return true;
        } catch (error) {
          // Never fall back to clicking when a semantic answer exists but failed:
          // that risks double-answering a request the host may already have settled.
          log("answer threw", error);
          return false;
        }
      }
      return clickDecision(panel, action);
    };

    function createHandler({ uiSession, escapeEnabled }) {
      /** Diagnostics kept on `window.__dshSpaceApprove` for DevTools inspection. */
      const diagnostics = (() => {
        const existing = window.__dshSpaceApprove;
        if (existing && Array.isArray(existing.inputs)) return existing;
        const fresh = { inputs: [], decisions: [] };
        window.__dshSpaceApprove = fresh;
        return fresh;
      })();
      const record = (bucket, entry) => {
        try {
          bucket.push({ t: Date.now(), ...entry });
          if (bucket.length > 20) bucket.splice(0, bucket.length - 20);
        } catch {
          /* diagnostics must never break the handler */
        }
      };
      /**
       * Resolve the single pending, visible approval request.
       * `null` means "do not act" (nothing pending, stale DOM, hidden panel, or
       * an ambiguous split view).
       */
      const resolveTarget = () => {
        const panels = Array.from(document.querySelectorAll(PANEL)).filter(isVisible);
        if (panels.length !== 1) return null;
        const panel = panels[0];
        const modal = document.querySelector(MODAL);
        if (modal && typeof modal.contains === "function" && !modal.contains(panel)) return null;
        const pending = pendingFor(uiSession, panel.getAttribute("data-approval-key"));
        if (!pending) return null;
        return { panel, pending };
      };

      /** A focused editor owns the key even when the reported region says otherwise. */
      const editingSomewhere = () => {
        const active = document.activeElement;
        return Boolean(active) && active !== document.body && isEditable(active);
      };

      /**
       * A decision control inside the card keeps its own key: Space activates it
       * natively, and Escape is already answered by the card's own handler.
       */
      const activatableInsideCard = (panel) => {
        const active = document.activeElement;
        return Boolean(active) && active !== document.body && panel.contains(active) && closestOf(active, ACTIVATABLE) !== null;
      };

      /** Any focus inside the card delegates both keys to the card's own handlers. */
      const focusedInsideCard = (panel) => {
        const active = document.activeElement;
        return Boolean(active) && active !== document.body && panel.contains(active);
      };

      const run = (action, delegate) => {
        const target = resolveTarget();
        if (target === null) return false;
        if (delegate(target.panel)) return false;
        if (!decide(target.panel, target.pending, action)) return false;
        log(action === "reject" ? "rejected with Escape" : "approved once with Space", target.pending.key);
        return true;
      };

      /** Official path: normalized input from the shortcuts service. */
      const onFixedInput = (input) => {
        try {
          if (!input || input.type !== "keydown") return;
          const gesture0 = input.gesture;
          const context0 = input.context;
          if (gesture0 && (gesture0.code === "Space" || gesture0.code === "Escape" || gesture0.code === "Enter")) {
            record(diagnostics.inputs, {
              via: "shortcuts",
              code: gesture0.code,
              composing: Boolean(gesture0.composing),
              repeat: Boolean(gesture0.repeat),
              prevented: Boolean(gesture0.defaultPrevented),
              region: context0 && context0.region,
              modal: context0 && context0.modal,
            });
          }
          if (!escapeEnabled && input.gesture && input.gesture.code === "Escape") return;
          const action = actionOf(input.gesture);
          if (action === null) return;
          const gesture = input.gesture;
          if (gesture.defaultPrevented || gesture.composing || gesture.repeat) return;
          if (gesture.control || gesture.alt || gesture.shift || gesture.meta) return;
          const context = input.context;
          if (context && context.region !== "page") return;
          if (context && context.modal !== null && context.modal !== undefined) return;
          if (editingSomewhere()) return;
          const acted = run(action, activatableInsideCard);
          record(diagnostics.decisions, { via: "shortcuts", action, acted });
          if (!acted) return;
          if (typeof input.consume === "function") input.consume();
        } catch (error) {
          log("fixed input handler failed", error);
        }
      };

      /**
       * Fallback path: raw document keydown, same business rules.
       *
       * Registered in the CAPTURE phase on purpose: it must run before handlers
       * on a focused control (for example the sidebar row the user just clicked)
       * can call `preventDefault()` on Space, which would otherwise make the key
       * silently do nothing.
       */
      const onDomKeyDown = (event) => {
        try {
          if (event && (event.code === "Space" || event.code === "Escape" || event.code === "Enter")) {
            record(diagnostics.inputs, {
              via: "dom",
              code: event.code,
              key: event.key,
              composing: Boolean(event.isComposing),
              keyCode: event.keyCode,
              repeat: Boolean(event.repeat),
              prevented: Boolean(event.defaultPrevented),
            });
          }
          if (!event || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
          const action = actionOfDom(event);
          if (action === null) return;
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
          if (!isElement(event.target)) return;
          if (isEditable(event.target) || editingSomewhere()) return;
          const acted = run(action, activatableInsideCard);
          record(diagnostics.decisions, { via: "dom", action, acted });
          if (!acted) return;
          event.preventDefault();
          if (typeof event.stopPropagation === "function") event.stopPropagation();
        } catch (error) {
          log("dom handler failed", error);
        }
      };

      return { onFixedInput, onDomKeyDown };
    }

    /** Space → allow once; Escape → reject (when enabled). */
    function actionOf(gesture) {
      if (!gesture) return null;
      if (gesture.code === "Space" || gesture.code === "Spacebar") return "allow";
      if (gesture.code === "Escape" || gesture.code === "Esc") return "reject";
      return null;
    }

    function actionOfDom(event) {
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
          console.warn("[space-approve] uiSession service unavailable; Space approval disabled");
          return;
        }
        const escapeEnabled = !config || config.escape !== false;
        const shortcuts = typeof ctx.get === "function" ? ctx.get("shortcuts") : undefined;
        const handler = createHandler({ uiSession: service, escapeEnabled });
        const disposers = [];

        // Primary: capture-phase document listener. It runs before control-level
        // handlers that may swallow Space with preventDefault(), and it stops
        // propagation when it answers, so the official path below never doubles.
        document.addEventListener("keydown", handler.onDomKeyDown, true);
        disposers.push(() => document.removeEventListener("keydown", handler.onDomKeyDown, true));

        // Secondary: the host's normalized input, for events our listener never
        // sees (native-bridge delivery, or a document that swallowed capture).
        let mode = "dom";
        if (shortcuts && typeof shortcuts.observeFixedInput === "function") {
          const off = shortcuts.observeFixedInput(handler.onFixedInput);
          if (typeof off === "function") disposers.push(off);
          mode = "dom+shortcuts";
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
        log("active via", mode, "| escape:", escapeEnabled);
      },
    };
  },
});
