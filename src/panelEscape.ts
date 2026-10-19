// Pure decisions behind Esc-to-close for docked panels and popovers
// (BUG-006, QA 20261003): the right-docked Review and relationship-graph
// panels, the changes panel, the status-bar popovers (over-limit list, export
// report; KI-35) and the Criteria, Personal library and Citations panels
// (review follow-up, QA 20261003). The wiring is usePanelEscape.ts, guarded by
// panelEscapeContract.test.ts.
//
// Invariants kept here (tested in panelEscape.test.ts):
// - Only a bare Escape qualifies; a modified one (⌘/Ctrl/⌥/⇧) is some other
//   chord. An IME key (isComposing, or WebKit's keyCode 229) never acts, nor
//   does an Esc within 80 ms after compositionend (WebKit can deliver the Esc
//   that cancels a conversion AFTER compositionend; isImeKeyEventSince).
// - One Esc, one effect: an Escape another handler already claimed
//   (defaultPrevented — find bar, toolbar dropdowns, ChunkView ghost text,
//   DraftBlock, LinkPopover, the TeX popover, CodeMirror's simplifySelection
//   when it has a selection to simplify) is never acted on. This holds only
//   for handlers that run before the panel's window bubble-phase listener:
//   React handlers and document listeners do; another WINDOW listener runs in
//   registration order, so it must not rely on this rule.
// - Never while a modal is open (the modal layer owns Esc) or while the
//   presentation overlay is up (Esc exits the presentation).
// - Never from a text field INSIDE a panel (any editable target kind): a
//   panel's unsent text (a Review comment) lives in local state that closing
//   would drop.
// - Outside the panels, only an allow-list of targets may close one: a
//   non-editable target and a document-history field (paragraph textarea,
//   preview block, slide field) — Esc has no unclaimed use there, and that is
//   where focus sits after ⌘K or the native Analyze menu opens a panel
//   (review follow-up, QA 20261003). The Markdown source keeps Esc: CodeMirror
//   uses an unclaimed Esc to turn on its Tab-focus mode (Esc, then Tab leaves
//   the editor — the only keyboard way out, since Tab indents). The find bar
//   and every other field (title input, dialog fields, any target kind added
//   later) keep Esc too.
// - A panel holding unsent text (a Review comment) stays open on Esc; focus
//   moves to that text only when the Esc came from the panel itself or a
//   non-editable target — an Esc typed in the document never pulls the caret
//   out of the paragraph (unsentFocusAllowed).
// - Exactly one panel closes: the one holding focus, else the most recently
//   opened. Focus inside a tagged surface missing from the open stack →
//   nothing (defensive: the contract scanner keeps every tagged surface
//   registered).
// - Focus is handed back only when closing would otherwise lose it (it was in
//   the closing panel, or nowhere), to the first usable candidate: the opener
//   captured when the panel opened, then the panel's toolbar toggle.
//
// Known limit: this decides, it does not observe the DOM — behaviour in the
// real webview (WebKit focus on click, IME) is verified by the manual QA run.

import { isImeKeyEventSince, topmostModal, type ImeKeyLike } from "./modalBehavior";
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
  /** Date.now() of the last compositionend anywhere in the document (0 = none). */
  lastCompositionEnd: number;
  /** Date.now() when the key arrived (same clock as lastCompositionEnd). */
  now: number;
}

/** Target kinds outside every panel from which an unclaimed Esc may close one. */
const CLOSES_FROM_OUTSIDE: ReadonlySet<TargetKind> = new Set<TargetKind>(["none", "doc-history"]);

/** The docked panel this Escape should close, or null to leave it alone. */
export function panelEscapeTarget(e: PanelKeyLike, ctx: PanelEscapeContext): string | null {
  if (e.key !== "Escape") return null;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (isImeKeyEventSince(e, ctx.lastCompositionEnd, ctx.now)) return null;
  if (e.defaultPrevented) return null;
  if (ctx.modalOpen || ctx.presenting) return null;
  if (ctx.targetPanel !== null) {
    if (ctx.targetKind !== "none") return null;
    return ctx.panels.includes(ctx.targetPanel) ? ctx.targetPanel : null;
  }
  if (!CLOSES_FROM_OUTSIDE.has(ctx.targetKind)) return null;
  return topmostModal(ctx.panels);
}

/** Whether an Esc that `name` refuses (it holds unsent text) may move focus
 *  to that text: only from inside the panel or from a non-editable target. */
export function unsentFocusAllowed(
  name: string,
  ctx: Pick<PanelEscapeContext, "targetPanel" | "targetKind">
): boolean {
  return ctx.targetPanel === name || (ctx.targetPanel === null && ctx.targetKind === "none");
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
