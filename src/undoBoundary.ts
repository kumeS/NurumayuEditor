// Undo-step boundaries for live paragraph typing (BUG-002).
//
// The app history (store.ts) is the only undo stack for paragraph editing —
// ⌘Z is intercepted before WebKit's native textarea undo. `updateChunkContent`
// coalesces consecutive edits of one chunk into one step; this predicate says
// when an input event must START a new step instead:
//   - discrete inputs: paste, drop, cut, spellcheck/autocorrect replacement;
//   - any input that replaces a non-collapsed USER selection (select-and-type,
//     Backspace over a range);
//   - IME composition that starts over a user selection — exactly once, at
//     compositionstart.
// Composition updates never split: both `isComposing` and a `Composition`
// inputType are checked, because WebKit and Chromium order compositionend and
// the final input event differently. During composition the selection is the
// IME's marked text, not the user's, so it is ignored.
//
// Pure: no DOM. The caller reads selectionStart/End BEFORE the mutation (a
// native `beforeinput` / `compositionstart` listener).
// Wiring: all three ChunkView textareas (heading, body, diagram) call this
// from native beforeinput/compositionstart listeners and pass the result as
// `newUndoStep` (guarded by chunkViewWiring.test.ts), and so does the
// SlideEditor detached-slide title input (guarded by
// slideEditorWiring.test.ts).
//
// The store's idle rule (a pause > UNDO_IDLE_MS starts a step) is the second
// boundary source; it must not fire inside a composition either (a pause while
// choosing a candidate would snapshot raw kana as an undo state). The same
// call sites feed a `createCompositionTracker()` and pass `composing` to
// updateChunkContent, which then skips ONLY the idle term. The first input of
// a composition is not a continuation, so an idle gap before it still splits.
// Real-IME behaviour is checked manually (Node-only suite); the event orders
// are simulated in undoBoundary.test.ts.

export interface UndoBoundaryInput {
  inputType: string;
  isComposing: boolean;
  selectionStart: number;
  selectionEnd: number;
  /** True for the event fired at compositionstart (before any marked text). */
  compositionJustStarted?: boolean;
}

const DISCRETE_INPUT_TYPES = new Set([
  "insertFromPaste",
  "insertFromDrop",
  "deleteByCut",
  "insertReplacementText",
]);

/** True when this input must begin a new undo step. */
export function startsNewUndoStep(e: UndoBoundaryInput): boolean {
  const hasSelection = e.selectionStart !== e.selectionEnd;
  if (e.compositionJustStarted) return hasSelection;
  if (e.isComposing || e.inputType.includes("Composition")) return false;
  if (DISCRETE_INPUT_TYPES.has(e.inputType)) return true;
  return hasSelection;
}

/** True for an input event that belongs to an IME composition. */
export function isCompositionInput(e: { inputType: string; isComposing: boolean }): boolean {
  return e.isComposing || e.inputType.includes("Composition");
}

/** Per-field composition state for the idle rule (see header). Pure: the
 *  caller forwards compositionstart / compositionend / beforeinput and calls
 *  `take()` once per change. */
export function createCompositionTracker() {
  let active = false; // between compositionstart and compositionend
  let fresh = false; // no change consumed since compositionstart
  let inputComposing = false; // the pending input event was a composition input
  return {
    start() {
      active = true;
      fresh = true;
    },
    end() {
      active = false;
    },
    input(e: { inputType: string; isComposing: boolean }) {
      inputComposing = isCompositionInput(e);
    },
    /** Whether the change being applied continues a composition. */
    take(): boolean {
      const composing = (active || inputComposing) && !fresh;
      fresh = false;
      inputComposing = false;
      return composing;
    },
    reset() {
      active = false;
      fresh = false;
      inputComposing = false;
    },
  };
}
