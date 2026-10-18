// Pure decisions behind Esc-to-close for the right-docked side panels
// (BUG-006, QA 20261003): Review and the relationship graph. The wiring is
// usePanelEscape.ts, guarded by panelEscapeContract.test.ts.
//
// Invariants kept here (tested in panelEscape.test.ts):
// - Only a bare Escape qualifies; a modified one (⌘/Ctrl/⌥/⇧) is some other
//   chord, and an IME key (isComposing, or WebKit's keyCode 229) never acts.
// - One Esc, one effect: an Escape another handler already claimed
//   (defaultPrevented — find bar, toolbar dropdowns, ChunkView ghost text) is
//   never acted on. This holds only for handlers that run before the panel's
//   window bubble-phase listener: React handlers and document listeners do;
//   another WINDOW listener runs in registration order, so it must not rely
//   on this rule.
// - Never while a modal is open (the modal layer owns Esc) or while the
//   presentation overlay is up (Esc exits the presentation).
// - Never from an editable target (textarea, input, contentEditable,
//   CodeMirror, find-bar field) — inside a panel or not. Esc there belongs to
//   the field (IME, ghost text, the inline editors), and a panel's unsent
//   comment lives in local state that closing would drop.
// - Exactly one panel closes: the one holding focus, else the most recently
//   opened. Focus inside a docked surface that is not registered → nothing.
// - Focus is handed back only when closing would otherwise lose it (it was in
//   the closing panel, or nowhere), to the first usable candidate: the opener
//   captured when the panel opened, then the panel's toolbar toggle.
//
// Known limit: this decides, it does not observe the DOM — behaviour in the
// real webview (WebKit focus on click, IME) is verified by the manual QA run.

import { isImeKeyEvent, topmostModal, type ImeKeyLike } from "./modalBehavior";
import type { TargetKind } from "./shortcuts";

export interface PanelKeyLike extends ImeKeyLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
}

export interface PanelEscapeContext {
  /** Open docked panels, oldest first (the open-order stack). */
  panels: readonly string[];
  /** The docked panel the keydown target sits in (dockedPanelOf), or null. */
  targetPanel: string | null;
  /** shortcutTargetKind(e.target): "none" means a non-editable target. */
  targetKind: TargetKind;
  modalOpen: boolean;
  presenting: boolean;
}

/** The docked panel this Escape should close, or null to leave it alone. */
export function panelEscapeTarget(e: PanelKeyLike, ctx: PanelEscapeContext): string | null {
  if (e.key !== "Escape") return null;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (isImeKeyEvent(e)) return null;
  if (e.defaultPrevented) return null;
  if (ctx.modalOpen || ctx.presenting) return null;
  if (ctx.targetKind !== "none") return null;
  if (ctx.targetPanel !== null) {
    return ctx.panels.includes(ctx.targetPanel) ? ctx.targetPanel : null;
  }
  return topmostModal(ctx.panels);
}

interface ClosestLike {
  closest?: (selector: string) => { getAttribute: (name: string) => string | null } | null;
}

/** Name of the docked panel (`data-docked-panel`) containing `t`, or null. */
export function dockedPanelOf(t: unknown): string | null {
  if (!t || typeof t !== "object") return null;
  const el = t as ClosestLike;
  if (typeof el.closest !== "function") return null;
  return el.closest("[data-docked-panel]")?.getAttribute("data-docked-panel") ?? null;
}

/** Whether closing should move focus: only when it would otherwise be lost. */
export function shouldReturnPanelFocus(where: { focusInPanel: boolean; focusOnBody: boolean }): boolean {
  return where.focusInPanel || where.focusOnBody;
}

/** What the caller observed about one element that could take focus back. */
export interface PanelFocusCandidate {
  connected: boolean;
  isBody: boolean;
  inClosingPanel: boolean;
  inert: boolean;
  disabled: boolean;
}

/** Index of the first candidate that can take focus (opener, then toggle), or -1. */
export function panelFocusReturnIndex(candidates: readonly (PanelFocusCandidate | null)[]): number {
  return candidates.findIndex(
    (c) => c !== null && c.connected && !c.isBody && !c.inClosingPanel && !c.inert && !c.disabled
  );
}
