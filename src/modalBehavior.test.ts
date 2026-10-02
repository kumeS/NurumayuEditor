import { describe, expect, it } from "vitest";
import {
  isImeKeyEvent,
  isImeKeyEventSince,
  modalKeyAction,
  nextFocusIndex,
  popModal,
  pushModal,
  shouldRestoreFocus,
  topmostModal,
} from "./modalBehavior";

// Pure halves of the shared modal layer (BUG-016/017, KBD-IME-ENTER). The
// wiring guards proving Modal.tsx actually calls these live in
// modalContract.test.ts.

describe("isImeKeyEvent", () => {
  it("keyCode 229 counts as IME even when isComposing is false (WebKit)", () => {
    expect(isImeKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeKeyEvent({ isComposing: false, keyCode: 13 })).toBe(false);
  });

  it("isComposing alone counts as IME", () => {
    expect(isImeKeyEvent({ isComposing: true })).toBe(true);
    expect(isImeKeyEvent({})).toBe(false);
  });
});

describe("modalKeyAction", () => {
  it("Escape closes, but not during IME composition", () => {
    expect(modalKeyAction({ key: "Escape" })).toBe("close");
    expect(modalKeyAction({ key: "Escape", isComposing: true })).toBeNull();
    expect(modalKeyAction({ key: "Escape", keyCode: 229 })).toBeNull();
  });

  it("Tab moves forward, Shift+Tab backward", () => {
    expect(modalKeyAction({ key: "Tab" })).toBe("focus-next");
    expect(modalKeyAction({ key: "Tab", shiftKey: true })).toBe("focus-prev");
  });

  it("leaves modified Tab (e.g. Ctrl+Tab) and ordinary keys alone", () => {
    expect(modalKeyAction({ key: "Tab", ctrlKey: true })).toBeNull();
    expect(modalKeyAction({ key: "Tab", metaKey: true })).toBeNull();
    expect(modalKeyAction({ key: "Tab", altKey: true })).toBeNull();
    expect(modalKeyAction({ key: "Tab", keyCode: 229 })).toBeNull();
    expect(modalKeyAction({ key: "Enter" })).toBeNull();
    expect(modalKeyAction({ key: "a" })).toBeNull();
  });
});

describe("nextFocusIndex", () => {
  it("Tab wraps inside the dialog in both directions", () => {
    expect(nextFocusIndex(3, 0, true)).toBe(2);
    expect(nextFocusIndex(3, 2, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
  });

  it("steps normally in the middle and enters at the first element", () => {
    expect(nextFocusIndex(3, 0, false)).toBe(1);
    expect(nextFocusIndex(3, 2, true)).toBe(1);
    expect(nextFocusIndex(3, -1, false)).toBe(0);
  });

  it("returns -1 when there is nothing focusable", () => {
    expect(nextFocusIndex(0, -1, false)).toBe(-1);
  });
});

describe("modal stack", () => {
  it("only the topmost modal handles keys", () => {
    expect(topmostModal(pushModal(pushModal([], "draft"), "palette"))).toBe("palette");
    expect(topmostModal(popModal(["draft", "palette"], "palette"))).toBe("draft");
    expect(topmostModal([])).toBeNull();
  });

  it("push is idempotent per id (StrictMode double-mount) and moves it to the top", () => {
    expect(pushModal(["draft"], "draft")).toEqual(["draft"]);
    expect(pushModal(["a", "b"], "a")).toEqual(["b", "a"]);
  });

  it("pop removes only that id, wherever it sits", () => {
    expect(popModal(["a", "b", "c"], "b")).toEqual(["a", "c"]);
    expect(popModal(["a"], "zzz")).toEqual(["a"]);
  });
});

describe("shouldRestoreFocus", () => {
  it("focus is restored only when the last modal closes", () => {
    expect(shouldRestoreFocus(["settings"])).toBe(false);
    expect(shouldRestoreFocus([])).toBe(true);
  });

  it("…or when the opener lives in the modal that is topmost again (palette over Draft)", () => {
    expect(shouldRestoreFocus(["draft"], "draft")).toBe(true);
    expect(shouldRestoreFocus(["draft", "settings"], "draft")).toBe(false);
  });
});

describe("isImeKeyEventSince (ux-a11y-i18n-2)", () => {
  it("is IME while composing, for keyCode 229, and within 80 ms of compositionend (Safari order)", () => {
    expect(isImeKeyEventSince({ isComposing: true }, 0, 10_000)).toBe(true);
    expect(isImeKeyEventSince({ keyCode: 229 }, 0, 10_000)).toBe(true);
    expect(isImeKeyEventSince({}, 9_950, 10_000)).toBe(true);
    expect(isImeKeyEventSince({}, 9_900, 10_000)).toBe(false);
    expect(isImeKeyEventSince({ keyCode: 27 }, 0, 10_000)).toBe(false);
  });
});
