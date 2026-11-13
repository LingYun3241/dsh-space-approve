window.__ModuleLoader__.load({
  id: "dsh-space-approve",
  factory(require) {
    /**
     * Space approves the pending approval request exactly once.
     *
     * Safety model, in order of importance:
     * 1. Semantic answer: the pending interaction object published by
     *    `uiSession.sessionStatus` answers `"allowed-once"` — the same outcome
     *    the official Enter handler produces. We never click "the last button",
     *    so an optional "Always allow" can never be triggered by Space.
     * 2. Only the visible, actually-pending approval request is answerable:
     *    exactly one visible `[data-approval-key]` panel, and a matching
     *    pending interaction whose key equals the panel's key.
     * 3. Typing is never hijacked: editable targets, editable focus, focused
     *    buttons/links, IME composition, key repeat and chorded Space all pass
     *    through untouched.
     */

    const PANEL = "[data-approval-key]";
    const DETAIL = "[data-approval-scroll]";
    const EDITABLE =
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]';
    const ACTIVATABLE =
      'button, a[href], [role="button"], input[type="checkbox"], input[type="radio"], summary';
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
    const isEditable = (node) => isElement(node) && (node.isContentEditable === true || closestOf(node, EDITABLE) !== null);
    const isSpace = (event) => event.key === " " || event.key === "Spacebar" || event.code === "Space";

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

    /** Fallback for a future host that stops exposing `answer()`; never the persistent grant. */
    const clickAllowOnce = (panel) => {
      const detail = panel.querySelector(DETAIL);
      const buttons = Array.from(panel.querySelectorAll("button")).filter(
        (button) => !button.disabled && (detail === null || !detail.contains(button)),
      );
      if (buttons.length === 0) return false;
      // [Reject, Allow once] or [Reject, Allow once, Always allow].
      const button = buttons.length >= 3 ? buttons[buttons.length - 2] : buttons[buttons.length - 1];
      if (!button) return false;
      button.click();
      return true;
    };

    const approveOnce = (panel, pending) => {
      if (pending && typeof pending.answer === "function") {
        try {
          const result = pending.answer("allowed-once");
          if (result && typeof result.catch === "function") result.catch((error) => log("answer rejected", error));
          return true;
        } catch (error) {
          log("answer threw", error);
        }
      }
      return clickAllowOnce(panel);
    };

    function createHandler(uiSession) {
      return (event) => {
        try {
          if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
          if (!isSpace(event)) return;
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
          if (!isElement(event.target)) return;
          if (isEditable(event.target)) return;

          const active = document.activeElement;
          if (active && active !== event.target && isEditable(active)) return;
          // A focused control owns Space (native activation); never turn that into an approval.
          if (active && active !== document.body && closestOf(active, ACTIVATABLE) !== null) return;
          if (closestOf(event.target, ACTIVATABLE) !== null) return;

          const panels = Array.from(document.querySelectorAll(PANEL)).filter(isVisible);
          if (panels.length !== 1) return; // no request, or an ambiguous split view
          const panel = panels[0];

          const modal = document.querySelector(MODAL);
          if (modal && typeof modal.contains === "function" && !modal.contains(panel)) return;

          const pending = pendingFor(uiSession, panel.getAttribute("data-approval-key"));
          if (!pending) return;
          if (!approveOnce(panel, pending)) return;

          event.preventDefault();
          if (typeof event.stopPropagation === "function") event.stopPropagation();
          log("approved once with Space", pending.key);
        } catch (error) {
          log("handler failed", error);
        }
      };
    }

    return {
      inject: ["uiSession"],
      apply(ctx) {
        const uiSession =
          typeof ctx.get === "function" ? ctx.get("uiSession") : undefined;
        const service = uiSession || ctx.uiSession;
        if (!service || !service.sessionStatus) {
          console.warn("[space-approve] uiSession service unavailable; Space approval disabled");
          return;
        }
        const handler = createHandler(service);
        document.addEventListener("keydown", handler, true);
        if (typeof ctx.effect === "function") {
          ctx.effect(
            () => () => document.removeEventListener("keydown", handler, true),
            "dsh-space-approve: Space approves once",
          );
        }
      },
    };
  },
});
