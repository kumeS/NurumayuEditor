// Esc-to-close for docked panels and popovers (BUG-006, QA 20261003): the
// right-docked Review and graph panels, the changes panel, the status-bar
// popovers (KI-35) and the Criteria, Personal library and Citations panels
// (review follow-up, QA 20261003).
// Decisions are the pure helpers in ./panelEscape.ts; this hook only wires
// them to the DOM (guarded by panelEscapeContract.test.ts).
//
// Constraints:
// - Mount = open. A panel calls the hook while it is rendered; mounting pushes
//   its name onto `openPanels` (open order), unmounting pops it. UI-only
//   state: never persisted, never in the document store or undo history.
// - ONE window bubble-phase keydown listener per panel. It runs after React's
//   root handlers (find bar, ChunkView) and every document listener (toolbar
//   dropdowns); the modal layer's capture listener stops the key before it
//   gets here. It acts — preventDefault + close — only when
//   panelEscapeTarget names this panel.
// - Every compositionend (document, capture phase) is timestamped, so the
//   decision can ignore WebKit's late Esc that cancels a conversion after the
//   composition ended (review follow-up, QA 20261003).
// - The returned closer is THE close path: the panel's ✕ button and Esc both
//   call it. It reads where focus is before closing (the panel unmounts) and
//   hands focus back to the opener, else the toolbar toggle
//   ([data-panel-opener]), only when it would otherwise be lost.
//
// Known limit: no DOM test environment — behaviour in WKWebView is closed by
// the manual QA re-run; panelEscapeContract.test.ts guards the wiring only.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { popModal, pushModal } from "./modalBehavior";
import {
  dockedPanelOf,
  panelEscapeTarget,
  panelFocusReturnIndex,
  shouldReturnPanelFocus,
  unsentFocusAllowed,
  type PanelFocusCandidate,
} from "./panelEscape";
import { shortcutTargetKind } from "./shortcuts";
import { useStore } from "./store";
import { useModalStack } from "./components/Modal";

/** Open docked panels, oldest first (the modal stack helpers are generic). */
let openPanels: string[] = [];
/** Date.now() of the last compositionend in the document (isImeKeyEventSince). */
let lastCompositionEnd = 0;

function captureOpener(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function candidateOf(el: HTMLElement | null, name: string): PanelFocusCandidate | null {
  if (!el) return null;
  return {
    connected: el.isConnected,
    isBody: el === document.body,
    inClosingPanel: !!el.closest(`[data-docked-panel="${name}"]`),
    inert: !!el.closest("[inert]"),
    disabled: el.matches(":disabled"),
  };
}

function returnFocus(opener: HTMLElement | null, name: string) {
  // Something placed focus since the close (e.g. a caret restore): keep it.
  const active = document.activeElement;
  if (active && active !== document.body) return;
  const toggle = document.querySelector<HTMLElement>(`[data-panel-opener="${name}"]`);
  const candidates = [opener, toggle];
  const at = panelFocusReturnIndex(candidates.map((el) => candidateOf(el, name)));
  if (at >= 0) candidates[at]?.focus();
}

/**
 * Register a docked panel for Esc-to-close. Returns the panel's one closer —
 * use it for the ✕ button too, so both paths behave the same.
 *
 * `unsentInput` (optional) returns a field holding text that closing would
 * drop (e.g. an unsent Review comment). While it returns one, Esc still
 * claims the key but keeps the panel open and focuses that field instead —
 * Esc never discards typed text (review follow-up, QA 20261003).
 */
export function usePanelEscape(
  name: string,
  onClose: () => void,
  options?: { unsentInput?: () => HTMLElement | null }
): () => void {
  const onCloseRef = useRef(onClose);
  const optionsRef = useRef(options);
  // Captured during the first render, i.e. before any child's autoFocus.
  const [opener] = useState(captureOpener);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    optionsRef.current = options;
  });

  useLayoutEffect(() => {
    openPanels = pushModal(openPanels, name);
    return () => {
      openPanels = popModal(openPanels, name);
    };
  }, [name]);

  const close = useCallback(() => {
    const active = document.activeElement;
    const restore = shouldReturnPanelFocus({
      focusInPanel: !!active?.closest(`[data-docked-panel="${name}"]`),
      focusOnBody: !active || active === document.body,
    });
    onCloseRef.current();
    // Deferred: the panel (and the focus inside it) unmounts on the next render.
    if (restore) setTimeout(() => returnFocus(opener, name), 0);
  }, [name, opener]);

  useEffect(() => {
    const onCompositionEnd = () => {
      lastCompositionEnd = Date.now();
    };
    const onKey = (e: KeyboardEvent) => {
      const ctx = {
        panels: openPanels,
        targetPanel: dockedPanelOf(e.target),
        targetKind: shortcutTargetKind(e.target),
        modalOpen: useModalStack.getState().stack.length > 0,
        presenting: useStore.getState().presentationOpen,
        lastCompositionEnd,
        now: Date.now(),
      };
      const target = panelEscapeTarget(e, ctx);
      if (target !== name) return;
      e.preventDefault();
      const unsent = optionsRef.current?.unsentInput?.();
      if (unsent) {
        if (unsentFocusAllowed(name, ctx)) unsent.focus();
        return;
      }
      close();
    };
    // Capture phase: a stopPropagation on the way (a portal's isolation)
    // must not hide the end of a composition.
    document.addEventListener("compositionend", onCompositionEnd, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("compositionend", onCompositionEnd, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [name, close]);

  return close;
}
