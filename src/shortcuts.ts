// Pure keyboard-shortcut resolution for the global keydown listener
// (useShortcuts) and the native-menu guard in App.tsx.
//
// Invariants (tested in shortcuts.test.ts; wiring guarded by
// modalContract.test.ts):
// - Only ⌘/Ctrl chords resolve; an IME-composition key never does.
// - ⇧⌘S is Save As and is matched BEFORE plain ⌘S.
// - ⌘K resolves to the palette only when no modal is open, or when the palette
//   itself is the top modal (to close it). It never opens the palette over
//   another dialog, where its commands would act on the hidden document.
// - While any modal is open, every other document shortcut returns null; only
//   a dialog field's own undo (field-undo/field-redo) still resolves. The
//   blocked non-undo chords (⌘W/⌘S/⌘O/⌘T/⌘,) are still preventDefault-ed via
//   `swallowedUnderModal`, so a native menu key equivalent (Window → Close =
//   ⌘W hides the window) cannot fire behind the dialog. The find chords
//   (⌘F/⌥⌘F/⌘G/⇧⌘G/⌘L) are swallowed there too.
// - Find (BUG-010): ⌘F find, ⌥⌘F find & replace (matched on the PHYSICAL key,
//   e.code "KeyF", because Option turns e.key into "ƒ" on macOS), ⌘G / ⇧⌘G
//   next / previous match, ⌘L go to line. They resolve from any target,
//   CodeMirror included (its keymap binds none of them). On macOS
//   (`ctx.mac`) they need ⌘: Ctrl+F is Cocoa/CodeMirror forward-char and
//   Ctrl+L CodeMirror's selectLine, so a Ctrl binding would act twice.
//   Known limit: the older Ctrl+S/O/T/W/K chords still resolve on macOS too.
// - ⌘Z / ⇧⌘Z / ⌘Y go to the document history ("undo"/"redo") only from
//   document-history inputs (tagged `data-doc-history`) or non-editable focus,
//   and never under a modal. In any other input/textarea/contentEditable they
//   resolve to "field-undo"/"field-redo", which useShortcuts runs explicitly on
//   the focused field (document.execCommand) because the native Edit menu has
//   no ⌘Z key equivalent. In CodeMirror they return null: its own keymap acts.
//   Known limit: that execCommand performs the field undo in WKWebView is
//   verified only by manual QA in the installed app, not by this suite.
// - Native menu ids are an allowlist under a modal: only `quit` passes. The
//   same allowlist applies while the presentation overlay is up.
// - Presentation (ux-a11y-i18n-3): while `ctx.presenting`, EVERY document
//   chord resolves to null (palette, find, settings, tabs, files, undo) — they
//   would open surfaces hidden under the overlay or act on the hidden
//   document — and `swallowedWhilePresenting` keeps them from the native menu.
// - Find bar (ux-a11y-i18n-1): a text field inside [data-find-bar] is
//   "find-bar". Right after Replace / Replace All (`ctx.findReplacePending`,
//   cleared when a find field is edited) ⌘Z / ⇧⌘Z there undo/redo the
//   DOCUMENT, so the replacement is what ⌘Z reverts; otherwise they are the
//   field's own undo, like any other field.

import { isImeKeyEvent } from "./modalBehavior";

export type ShortcutId =
  | "save"
  | "save-as"
  | "open"
  | "open-folder"
  | "new-tab"
  | "palette"
  | "close-tab"
  | "undo"
  | "redo"
  | "field-undo"
  | "field-redo"
  | "settings"
  | "find"
  | "find-replace"
  | "find-next"
  | "find-previous"
  | "go-to-line";

/** The modal-stack name CommandPalette registers (modalContract.test.ts guards it). */
export const PALETTE_MODAL = "palette";

/** Where the keydown came from, as far as undo routing is concerned. */
export type TargetKind = "doc-history" | "codemirror" | "find-bar" | "other-editable" | "none";

export interface ShortcutKeyEvent {
  key: string;
  /** Physical key ("KeyF"); used where a modifier rewrites `key` (⌥ on macOS). */
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export interface ShortcutContext {
  /** Topmost open modal (from the modal stack), or null. */
  topModal: string | null;
  /** Defaults to "none". */
  targetKind?: TargetKind;
  /** macOS: the find chords need ⌘ (Ctrl+F/Ctrl+L are text-editing keys). */
  mac?: boolean;
  /** The presentation overlay is up: no document chord acts. */
  presenting?: boolean;
  /** A find-bar replace happened and no find field was edited since. */
  findReplacePending?: boolean;
}

/** Map a keydown to a document shortcut, or null to leave the event alone. */
export function resolveShortcut(e: ShortcutKeyEvent, ctx: ShortcutContext): ShortcutId | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  if (isImeKeyEvent(e)) return null;
  if (ctx.presenting) return null;
  const key = e.key.toLowerCase();

  // Command palette (提案1): opens only over the document; ⌘K from the open
  // palette toggles it closed.
  if (key === "k") {
    return ctx.topModal === null || ctx.topModal === PALETTE_MODAL ? "palette" : null;
  }

  const target = ctx.targetKind ?? "none";
  if (key === "z" || key === "y") {
    const redo = key === "y" || e.shiftKey === true;
    if (target === "codemirror") return null;
    if (target === "find-bar" && ctx.findReplacePending && ctx.topModal === null) {
      return redo ? "redo" : "undo";
    }
    if (target === "other-editable" || target === "find-bar") return redo ? "field-redo" : "field-undo";
    if (ctx.topModal !== null) return null;
    return redo ? "redo" : "undo";
  }
  if (ctx.topModal !== null) return null;

  const findChord = ctx.mac ? e.metaKey === true : true;
  if (findChord && e.altKey && e.code === "KeyF") return "find-replace";

  switch (key) {
    case "s":
      return e.shiftKey ? "save-as" : "save";
    case "o":
      return e.shiftKey ? "open-folder" : "open";
    case "t":
      return "new-tab";
    case "w":
      return "close-tab";
    case ",":
      return "settings";
    case "f":
      return findChord ? "find" : null;
    case "g":
      return findChord ? (e.shiftKey ? "find-previous" : "find-next") : null;
    case "l":
      return findChord ? "go-to-line" : null;
    default:
      return null;
  }
}

/** Resolved ids that are never "blocked chords" under a modal. */
const NEVER_SWALLOWED = new Set<ShortcutId>(["palette", "undo", "redo", "field-undo", "field-redo"]);

/**
 * Whether a chord that resolveShortcut ignored because a modal is open must
 * still be preventDefault-ed. The native menu owns predefined key equivalents
 * (e.g. Window → Close = ⌘W, which hides the window); before the modal guard
 * the page always preventDefault-ed these chords, so letting them through now
 * would fire the native item behind the dialog. Undo/redo, clipboard and quit
 * chords are NOT swallowed.
 */
export function swallowedUnderModal(e: ShortcutKeyEvent, ctx: ShortcutContext): boolean {
  if (ctx.topModal === null) return false;
  if (resolveShortcut(e, ctx) !== null) return false;
  const without = resolveShortcut(e, { ...ctx, topModal: null });
  return without !== null && !NEVER_SWALLOWED.has(without);
}

/**
 * Whether a chord that resolveShortcut ignored because the presentation is up
 * must still be preventDefault-ed: every chord that would act without the
 * overlay (undo included — it must not edit the hidden document, and the
 * native menu must not act behind the overlay either).
 */
export function swallowedWhilePresenting(e: ShortcutKeyEvent, ctx: ShortcutContext): boolean {
  if (!ctx.presenting) return false;
  return resolveShortcut(e, { ...ctx, presenting: false, topModal: null }) !== null;
}


/** The subset of Element the classifier reads (kept structural for tests). */
export interface TargetLike {
  tagName?: string;
  /** An <input>'s type; non-text types are not editable fields. */
  type?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** <input> types with no text to undo: focus there counts as non-editable. */
const NON_TEXT_INPUT = new Set([
  "checkbox",
  "radio",
  "range",
  "color",
  "button",
  "submit",
  "reset",
  "file",
  "image",
]);

/** Classify a keydown target for undo routing. */
export function shortcutTargetKind(t: unknown): TargetKind {
  if (!t || typeof t !== "object") return "none";
  const el = t as TargetLike;
  if (typeof el.closest !== "function") return "none";
  if (el.closest("[data-doc-history]")) return "doc-history";
  if (el.closest(".cm-editor")) return "codemirror";
  if (el.tagName === "INPUT" && NON_TEXT_INPUT.has((el.type ?? "").toLowerCase())) return "none";
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) {
    return el.closest("[data-find-bar]") ? "find-bar" : "other-editable";
  }
  return "none";
}

/**
 * Whether the keydown target must be blurred before a DOCUMENT undo/redo.
 * Markdown Preview's contentEditable blocks (tagged data-doc-history) keep
 * typed text in the DOM and commit it on blur; a store undo remounts every
 * block, which would silently drop that text. Blurring first commits it as its
 * own step, so ⌘Z then reverts exactly it. Document-history textareas write
 * the store on every keystroke and keep their focus (and caret).
 */
export function flushesPendingEditBeforeHistory(t: unknown): boolean {
  return shortcutTargetKind(t) === "doc-history" && (t as TargetLike).isContentEditable === true;
}

/** Native menu ids that may still act while a modal is open. */
const MENU_ALLOWED_WITH_MODAL = new Set(["quit"]);

/** Whether a native menu command may run while a modal is open. */
export function menuAllowedWithModal(id: string): boolean {
  return MENU_ALLOWED_WITH_MODAL.has(id);
}
