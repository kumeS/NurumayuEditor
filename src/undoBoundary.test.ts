import { describe, expect, it } from "vitest";
import { createCompositionTracker, isCompositionInput, startsNewUndoStep } from "./undoBoundary";

describe("BUG-002 — startsNewUndoStep", () => {
  it("typing over a non-collapsed selection starts a step", () => {
    // "STATE_A" selected (0..7), then a plain keystroke replaces it.
    expect(
      startsNewUndoStep({ inputType: "insertText", isComposing: false, selectionStart: 0, selectionEnd: 7 })
    ).toBe(true);
  });

  it("ordinary typing at a collapsed caret continues the current step", () => {
    expect(
      startsNewUndoStep({ inputType: "insertText", isComposing: false, selectionStart: 7, selectionEnd: 7 })
    ).toBe(false);
    expect(
      startsNewUndoStep({ inputType: "deleteContentBackward", isComposing: false, selectionStart: 3, selectionEnd: 3 })
    ).toBe(false);
  });

  it("deleting a non-collapsed selection (Backspace over a range) starts a step", () => {
    expect(
      startsNewUndoStep({ inputType: "deleteContentBackward", isComposing: false, selectionStart: 0, selectionEnd: 7 })
    ).toBe(true);
  });

  it("paste / drop / cut / spellcheck replacement are discrete steps, even at a collapsed caret", () => {
    for (const inputType of ["insertFromPaste", "insertFromDrop", "deleteByCut", "insertReplacementText"]) {
      expect(
        startsNewUndoStep({ inputType, isComposing: false, selectionStart: 4, selectionEnd: 4 })
      ).toBe(true);
    }
  });

  it("Japanese IME composition never splits mid-word (にほん → 日本)", () => {
    // Composition updates: the marked text にほん is selected (0..3) while
    // composing — that selection is the IME's own, not the user's.
    expect(
      startsNewUndoStep({ inputType: "insertCompositionText", isComposing: true, selectionStart: 0, selectionEnd: 3 })
    ).toBe(false);
    // WebKit can fire the committing input AFTER compositionend, so
    // isComposing is already false — the inputType alone must still hold.
    expect(
      startsNewUndoStep({ inputType: "insertCompositionText", isComposing: false, selectionStart: 0, selectionEnd: 3 })
    ).toBe(false);
    // Chromium-style: a plain insertText with isComposing still true.
    expect(
      startsNewUndoStep({ inputType: "insertText", isComposing: true, selectionStart: 0, selectionEnd: 3 })
    ).toBe(false);
  });

  it("IME input over a user selection splits exactly once, at composition start", () => {
    // '選択された文字' (7 chars) selected, then the user starts composing.
    expect(
      startsNewUndoStep({
        inputType: "insertCompositionText",
        isComposing: true,
        compositionJustStarted: true,
        selectionStart: 0,
        selectionEnd: 7,
      })
    ).toBe(true);
    // compositionstart at a collapsed caret: nothing replaced, no split.
    expect(
      startsNewUndoStep({
        inputType: "insertCompositionText",
        isComposing: true,
        compositionJustStarted: true,
        selectionStart: 7,
        selectionEnd: 7,
      })
    ).toBe(false);
  });
});

describe("state-async-1 — IME composition never splits on idle", () => {
  it("isCompositionInput: isComposing or a Composition inputType", () => {
    expect(isCompositionInput({ inputType: "insertCompositionText", isComposing: true })).toBe(true);
    // WebKit commits with insertFromComposition after compositionend (isComposing false).
    expect(isCompositionInput({ inputType: "insertFromComposition", isComposing: false })).toBe(true);
    expect(isCompositionInput({ inputType: "deleteCompositionText", isComposing: false })).toBe(true);
    expect(isCompositionInput({ inputType: "insertText", isComposing: true })).toBe(true);
    expect(isCompositionInput({ inputType: "insertText", isComposing: false })).toBe(false);
    expect(isCompositionInput({ inputType: "insertFromPaste", isComposing: false })).toBe(false);
  });

  const update = { inputType: "insertCompositionText", isComposing: true };

  it("Chromium order: the first marked text is not a continuation; later updates and the commit are", () => {
    const t = createCompositionTracker();
    t.start();
    t.input(update);
    expect(t.take()).toBe(false); // first input of the composition: idle may split before it
    t.input(update);
    expect(t.take()).toBe(true);
    t.input(update); // the commit input still reports isComposing
    t.end();
    expect(t.take()).toBe(true);
    t.input({ inputType: "insertText", isComposing: false });
    expect(t.take()).toBe(false); // typing after the composition is ordinary again
  });

  it("WebKit order: compositionend before the final insertFromComposition input", () => {
    const t = createCompositionTracker();
    t.start();
    t.input(update);
    t.take();
    t.input(update);
    expect(t.take()).toBe(true);
    t.end();
    t.input({ inputType: "insertFromComposition", isComposing: false });
    expect(t.take()).toBe(true);
    expect(t.take()).toBe(false); // the per-input flag is consumed
  });

  it("an update with no beforeinput (flag only from compositionstart) still counts while active", () => {
    const t = createCompositionTracker();
    t.start();
    t.take();
    expect(t.take()).toBe(true);
    t.reset();
    expect(t.take()).toBe(false);
  });
});
