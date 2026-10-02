// Shared modal layer (BUG-016/017): every dialog (Draft, Help, Settings,
// Prompt, Command palette) renders through <Modal>, which owns the backdrop,
// Escape, the focus trap and focus restoration. Decisions are the pure helpers
// in ../modalBehavior.ts; this file only wires them to the DOM.
//
// Constraints:
// - Mount = open. A dialog renders <Modal> only while it is open; mounting
//   pushes the instance onto `useModalStack`, unmounting pops it.
// - ONE capture-phase document keydown listener per instance, acting only when
//   this instance is topmost: Escape closes (never during IME composition; a
//   non-dismissible modal swallows it), Tab / Shift+Tab wrap inside the panel.
// - Stack order decides stacking (z-index = base + depth), independent of DOM
//   order. The layer stays below Toasts (z-50) so notifications remain visible.
// - Focus: the opener is captured during the first render (before children's
//   autoFocus runs); focus goes to `initialFocusRef`, else whatever autoFocus
//   chose inside the panel, else the first focusable, else the panel. On close,
//   focus returns to the opener (or, when a modal handed off to another, to the
//   previous modal's opener) only if shouldRestoreFocus allows it and the
//   element is connected and no longer inert.
// - `useModalStack` is UI-only state, deliberately NOT part of the document
//   store: it is never persisted and never enters undo history.
//
// Known limit: no DOM test environment — behaviour is closed by the manual QA
// re-run; modalContract.test.ts guards the wiring only.

import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { create } from "zustand";
import {
  FOCUSABLE_SELECTOR,
  modalKeyAction,
  nextFocusIndex,
  popModal,
  pushModal,
  shouldRestoreFocus,
  topmostModal,
} from "../modalBehavior";

interface ModalStackState {
  /** Open modal instance ids, oldest first. */
  stack: string[];
  push: (id: string) => void;
  pop: (id: string) => void;
}

/** Which modals are open, in stacking order (App reads it for `inert`). */
export const useModalStack = create<ModalStackState>((set) => ({
  stack: [],
  push: (id) => set((s) => ({ stack: pushModal(s.stack, id) })),
  pop: (id) => set((s) => ({ stack: popModal(s.stack, id) })),
}));

/** Toasts sit at z-50; the modal layer stacks just below it. */
const Z_BASE = 45;
const Z_MAX = 49;

interface Opener {
  el: HTMLElement | null;
  /** Modal instance the opener lives in, or null for the app chrome. */
  owner: string | null;
  /** When the opener sat in another modal: that modal's own opener. */
  fallback: Opener | null;
}

// Openers of the currently open instances, so a handoff (Help → Settings) can
// fall back to the first modal's opener once the button it came from is gone.
const openers = new Map<string, Opener>();

function captureOpener(): Opener {
  if (typeof document === "undefined") return { el: null, owner: null, fallback: null };
  const el = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const owner = el?.closest<HTMLElement>("[data-modal-id]")?.dataset.modalId ?? null;
  return { el, owner, fallback: owner ? openers.get(owner) ?? null : null };
}

function restoreFocus(opener: Opener, retry = true) {
  const candidate = [opener, opener.fallback].find((o) => o?.el?.isConnected) ?? null;
  const el = candidate?.el;
  if (!candidate || !el) return;
  if (!shouldRestoreFocus(useModalStack.getState().stack, candidate.owner)) return;
  if (el.closest("[inert]")) {
    // App has not re-rendered without `inert` yet — try once more next frame.
    if (retry) requestAnimationFrame(() => restoreFocus(opener, false));
    return;
  }
  el.focus();
}

function focusables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0 && !el.closest("[inert]")
  );
}

export interface ModalProps {
  /** Short stable name ("draft", "palette" …); the instance id adds a suffix. */
  name: string;
  /** Called on Escape, backdrop mousedown, and nothing else. */
  onClose: () => void;
  /** id of the visible heading that names the dialog. */
  labelledBy?: string;
  /** Accessible name when the dialog has no visible heading. */
  label?: string;
  /** Element to focus on open (defaults: autoFocus child → first focusable). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** False while busy: Escape and backdrop clicks do nothing. Default true. */
  dismissible?: boolean;
  /** "center" (default) or "top" (command palette). */
  placement?: "center" | "top";
  /** Size / layout classes of the panel. */
  panelClassName: string;
  children: ReactNode;
}

export default function Modal({
  name,
  onClose,
  labelledBy,
  label,
  initialFocusRef,
  dismissible = true,
  placement = "center",
  panelClassName,
  children,
}: ModalProps) {
  const id = `${name}:${useId()}`;
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  // Captured during the first render, i.e. before any child's autoFocus.
  const [opener] = useState(captureOpener);
  const depth = useModalStack((s) => s.stack.indexOf(id));

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });

  // Register on the stack (layout effect: before paint, so App turns the
  // background inert in the same frame the dialog appears).
  useLayoutEffect(() => {
    openers.set(id, opener);
    useModalStack.getState().push(id);
    return () => {
      useModalStack.getState().pop(id);
      openers.delete(id);
      // Deferred: App removes `inert` on its next render, and a handoff
      // (Help → Settings) pushes the next modal in the same commit.
      setTimeout(() => restoreFocus(opener), 0);
    };
  }, [id, opener]);

  // Initial focus. Runs after children's autoFocus, which wins if it landed
  // inside the panel.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const wanted = initialFocusRef?.current;
    if (wanted) {
      wanted.focus();
      return;
    }
    if (panel.contains(document.activeElement)) return;
    (focusables(panel)[0] ?? panel).focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (topmostModal(useModalStack.getState().stack) !== id) return;
      const action = modalKeyAction(e);
      if (action === "close") {
        // Swallow it either way, so background Escape handlers never see it.
        e.preventDefault();
        e.stopPropagation();
        if (dismissibleRef.current) onCloseRef.current();
        return;
      }
      if (action === "focus-next" || action === "focus-prev") {
        const panel = panelRef.current;
        if (!panel) return;
        e.preventDefault();
        const items = focusables(panel);
        const current = items.indexOf(document.activeElement as HTMLElement);
        const next = nextFocusIndex(items.length, current, action === "focus-prev");
        (next >= 0 ? items[next] : panel).focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [id]);

  const zIndex = Math.min(Z_BASE + Math.max(depth, 0), Z_MAX);

  return (
    <div
      className={`fixed inset-0 flex justify-center bg-black/30 p-4 ${
        placement === "top" ? "items-start pt-[12vh]" : "items-center"
      }`}
      style={{ zIndex }}
      onMouseDown={() => {
        if (dismissibleRef.current) onCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        tabIndex={-1}
        data-modal-id={id}
        className={`${panelClassName} outline-none`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
