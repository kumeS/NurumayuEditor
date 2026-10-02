// Pure decisions behind the shared modal layer (components/Modal.tsx).
//
// Invariants kept here (tested in modalBehavior.test.ts; the wiring into
// Modal.tsx is guarded by modalContract.test.ts):
// - A key event that belongs to an IME composition (isComposing, or WebKit's
//   keyCode 229 on the committing keydown) never closes or moves focus.
// - Only the topmost modal of the stack acts on keys; the stack holds each
//   modal instance once, newest last.
// - Tab / Shift+Tab wrap inside the dialog; with nothing focusable the index
//   is -1 (the caller focuses the panel itself).
// - Focus goes back to the opener only when that is safe: the stack is empty,
//   or the opener lives in the modal that is topmost again (a dialog stacked
//   over another one and then closed).
//   Otherwise a handoff (Help → Settings) would pull focus onto an inert control.
//
// Known limit: this decides, it does not observe the DOM — behaviour in the
// real webview is verified by the manual QA re-run.

export interface ImeKeyLike {
  isComposing?: boolean;
  keyCode?: number;
}

export interface ModalKeyLike extends ImeKeyLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export type ModalKeyAction = "close" | "focus-next" | "focus-prev";

/** Elements a Tab press may land on inside a dialog panel. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

/** True while the key event is part of an IME composition (Japanese input). */
export function isImeKeyEvent(e: ImeKeyLike): boolean {
  return !!e.isComposing || e.keyCode === 229;
}

/**
 * isImeKeyEvent, plus the 80 ms after compositionend: WebKit can deliver the
 * key that ended a composition (Enter to confirm, Esc to cancel a conversion)
 * AFTER compositionend with isComposing false (ux-a11y-i18n-2).
 */
export function isImeKeyEventSince(e: ImeKeyLike, lastCompositionEnd: number, now: number = Date.now()): boolean {
  return isImeKeyEvent(e) || now - lastCompositionEnd < 80;
}

/** What a modal should do with this keydown, or null to leave it alone. */
export function modalKeyAction(e: ModalKeyLike): ModalKeyAction | null {
  if (isImeKeyEvent(e)) return null;
  if (e.key === "Escape") return "close";
  if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return e.shiftKey ? "focus-prev" : "focus-next";
  }
  return null;
}

/**
 * Index to focus after Tab (or Shift+Tab when `backwards`), wrapping at both
 * ends. `current` -1 (focus outside the list) enters at the first element, or
 * the last when going backwards. Returns -1 when `count` is 0.
 */
export function nextFocusIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

/** Put `id` on top of the stack (moving it if already present). */
export function pushModal(stack: readonly string[], id: string): string[] {
  return [...stack.filter((x) => x !== id), id];
}

/** Remove `id` from the stack, wherever it sits. */
export function popModal(stack: readonly string[], id: string): string[] {
  return stack.filter((x) => x !== id);
}

/** The modal that currently owns the keyboard, or null when none is open. */
export function topmostModal(stack: readonly string[]): string | null {
  return stack.length ? stack[stack.length - 1] : null;
}

/**
 * Whether a closing modal should hand focus back to its opener. `openerOwner`
 * is the id of the modal the opener lives in (null for the app chrome).
 */
export function shouldRestoreFocus(
  stackAfterClose: readonly string[],
  openerOwner: string | null = null
): boolean {
  if (stackAfterClose.length === 0) return true;
  return openerOwner !== null && topmostModal(stackAfterClose) === openerOwner;
}
