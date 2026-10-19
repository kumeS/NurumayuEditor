// Store → view sync for the Markdown source editor (QA 20261003 follow-up).
//
// The Markdown source has two undo histories, as before: CodeMirror's own
// (history() + historyKeymap: ⌘Z / ⇧⌘Z while the source has focus) and the
// app's store history (Edit → Undo / 元に戻す, the toolbar, ⌘Z in the find
// bar right after a replace). This module keeps the store's moves from
// leaking into CodeMirror's history.
//
// Invariant (sourceHistory.test.ts): when the store's source changes from
// outside the editor — a store undo/redo, a preview edit, a load —
// MarkdownEditor's [source] effect shows it with ONE transaction that
//   - changes only the differing span (common prefix/suffix kept, never
//     splitting a surrogate pair), so the caret and the rest of the text stay;
//   - is not recorded (Transaction.addToHistory false); and
//   - empties CodeMirror's history, undo AND redo, in that same transaction:
//     its older events describe a text the store has moved away from.
// So a CodeMirror undo can never re-apply what the store just undid (the
// defect: Replace All → ⌘Z in the find bar → ⌘Z in the source brought the
// replacement back, as a new step). The sync is a no-op when the
// LF-normalised texts already agree: CodeMirror's own edits (typing, its
// undo/redo, a find-bar replace) come back from the store unchanged and keep
// their history, and a CRLF source is not a change. The sync is never written
// back to the store (onlyStoreSync), so it adds no store step either.
//
// Known limit: right after such an external change CodeMirror's history is
// empty, so ⌘Z / ⇧⌘Z in the source do nothing until the user types there;
// Edit → Undo (元に戻す) still undoes the document. The keys are still claimed
// by CodeMirror and never reach WebKit's native contentEditable undo:
// historyKeymap's Mod-z / Mod-Shift-z bindings carry `preventDefault: true`
// (guarded in sourceHistory.test.ts). That @codemirror/view then
// preventDefaults the key even when the command returns false (runHandlers /
// InputState.runHandlers, read in @codemirror/view 6.43.7), and that
// history()'s own beforeinput handler cancels native historyUndo /
// historyRedo input (read in @codemirror/commands 6.10.4), need a DOM: NOT
// guarded by this suite — manual QA in the installed app.
//
// Pure over EditorState: no store, no DOM.

import { history, historyField } from "@codemirror/commands";
import { Annotation, Compartment, EditorState, type Extension, type StateEffect, Transaction } from "@codemirror/state";
import type { TextChange } from "./findReplace";
import { normalizeEol } from "./markdown";

const EMPTY_HISTORY = EditorState.create({ extensions: history() }).field(historyField);

/** A history field that starts empty even when it replaces a live one.
 *  (Reconfiguring to history() would keep the old events: same field.) */
function freshHistory(): Extension {
  return historyField.init(() => EMPTY_HISTORY);
}

/** A slot mounted NEXT TO history() (same field, deduplicated): `reset()` is
 *  the effect that empties CodeMirror's history inside a transaction. */
export interface HistoryReset {
  extension: Extension;
  reset: () => StateEffect<unknown>;
}

export function createHistoryReset(): HistoryReset {
  const compartment = new Compartment();
  return {
    extension: compartment.of(freshHistory()),
    reset: () => compartment.reconfigure(freshHistory()),
  };
}

/** What syncFromStore needs of an EditorView (tests pass a plain object). */
export interface SourceViewLike {
  readonly state: EditorState;
  dispatch(tr: Transaction): void;
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The one change turning `a` into `b` (common prefix/suffix kept, so the
 *  caret stays put), never splitting a surrogate pair; null when equal. */
export function minimalChange(a: string, b: string): TextChange | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(a.charCodeAt(start - 1))) start--;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  if (endA < a.length && isLowSurrogate(a.charCodeAt(endA))) {
    endA++;
    endB++;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

/** Marks the store → view sync. It already IS the store's text, so
 *  MarkdownEditor's update listener never writes it back: for a source with
 *  mixed line endings restoreEol(LF text) would differ from the store's text
 *  and record a spurious store step that drops the redo. */
const storeSync = Annotation.define<true>();

/** Whether an update consists only of store → view syncs (nothing to write back). */
export function onlyStoreSync(transactions: readonly Transaction[]): boolean {
  return transactions.length > 0 && transactions.every((tr) => tr.annotation(storeSync) === true);
}

/** Store → view: show the store's source as one unrecorded minimal change
 *  that also empties CodeMirror's history. False (no transaction) when the
 *  LF-normalised texts already agree. */
export function syncFromStore(view: SourceViewLike, historyReset: HistoryReset, storeSource: string): boolean {
  const change = minimalChange(view.state.doc.toString(), normalizeEol(storeSource));
  if (!change) return false;
  view.dispatch(
    view.state.update({
      changes: change,
      effects: historyReset.reset(),
      annotations: [Transaction.addToHistory.of(false), storeSync.of(true)],
    })
  );
  return true;
}
