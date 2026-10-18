// Esc-to-close for the right-docked side panels (BUG-006, QA 20261003).
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
  type PanelFocusCandidate,
} from "./panelEscape";
import { shortcutTargetKind } from "./shortcuts";
import { useStore } from "./store";
import { useModalStack } from "./components/Modal";

/** Open docked panels, oldest first (the modal stack helpers are generic). */
let openPanels: string[] = [];

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
 */
export function usePanelEscape(name: string, onClose: () => void): () => void {
  const onCloseRef = useRef(onClose);
  // Captured during the first render, i.e. before any child's autoFocus.
  const [opener] = useState(captureOpener);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
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
    const onKey = (e: KeyboardEvent) => {
      const target = panelEscapeTarget(e, {
        panels: openPanels,
        targetPanel: dockedPanelOf(e.target),
        targetKind: shortcutTargetKind(e.target),
        modalOpen: useModalStack.getState().stack.length > 0,
        presenting: useStore.getState().presentationOpen,
      });
      if (target !== name) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [name, close]);

  return close;
}
