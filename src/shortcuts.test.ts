import { describe, expect, it } from "vitest";
import {
  flushesPendingEditBeforeHistory,
  menuAllowedWithModal,
  PALETTE_MODAL,
  resolveShortcut,
  shortcutTargetKind,
  swallowedUnderModal,
  swallowedWhilePresenting,
  type TargetLike,
} from "./shortcuts";

// Pure resolver behind useShortcuts (BUG-017b, SHORTCUT-SAVE-AS, MISS-03).
// modalContract.test.ts guards that useShortcuts delegates here.

const none = { topModal: null } as const;

describe("resolveShortcut — document shortcuts", () => {
  it("maps the global chords when no modal is open", () => {
    expect(resolveShortcut({ key: "s", metaKey: true }, none)).toBe("save");
    expect(resolveShortcut({ key: "o", metaKey: true }, none)).toBe("open");
    expect(resolveShortcut({ key: "O", metaKey: true, shiftKey: true }, none)).toBe("open-folder");
    expect(resolveShortcut({ key: "t", metaKey: true }, none)).toBe("new-tab");
    expect(resolveShortcut({ key: "w", metaKey: true }, none)).toBe("close-tab");
    expect(resolveShortcut({ key: "k", metaKey: true }, none)).toBe("palette");
    expect(resolveShortcut({ key: ",", metaKey: true }, none)).toBe("settings");
    expect(resolveShortcut({ key: "z", metaKey: true }, none)).toBe("undo");
    expect(resolveShortcut({ key: "Z", metaKey: true, shiftKey: true }, none)).toBe("redo");
    expect(resolveShortcut({ key: "y", ctrlKey: true }, none)).toBe("redo");
  });

  it("ignores keys without ⌘/Ctrl and unknown chords", () => {
    expect(resolveShortcut({ key: "s" }, none)).toBeNull();
    expect(resolveShortcut({ key: "Escape" }, none)).toBeNull();
    expect(resolveShortcut({ key: "q", metaKey: true }, none)).toBeNull();
  });

  it("⇧⌘S is Save As, ⌘S is Save", () => {
    expect(resolveShortcut({ key: "S", metaKey: true, shiftKey: true }, none)).toBe("save-as");
    expect(resolveShortcut({ key: "s", metaKey: true, shiftKey: true }, none)).toBe("save-as");
    expect(resolveShortcut({ key: "s", metaKey: true }, none)).toBe("save");
  });

  it("does nothing while an IME composition owns the key", () => {
    expect(resolveShortcut({ key: "s", metaKey: true, isComposing: true }, none)).toBeNull();
    expect(resolveShortcut({ key: "z", metaKey: true, keyCode: 229 }, none)).toBeNull();
  });
});

describe("resolveShortcut — modal guard (BUG-017b)", () => {
  it("no document shortcut fires while a modal is open", () => {
    expect(resolveShortcut({ key: "z", metaKey: true }, { topModal: "draft" })).toBeNull();
    expect(resolveShortcut({ key: "w", metaKey: true }, { topModal: "draft" })).toBeNull();
    expect(resolveShortcut({ key: ",", metaKey: true }, { topModal: "draft" })).toBeNull();
    expect(resolveShortcut({ key: "t", metaKey: true }, { topModal: "draft" })).toBeNull();
    expect(resolveShortcut({ key: "o", metaKey: true }, { topModal: "draft" })).toBeNull();
    expect(resolveShortcut({ key: "s", metaKey: true }, { topModal: "draft" })).toBeNull();
    expect(resolveShortcut({ key: "S", metaKey: true, shiftKey: true }, { topModal: "help" })).toBeNull();
    expect(resolveShortcut({ key: "z", metaKey: true }, { topModal: null })).toBe("undo");
  });

  // Deliberate reversal of the wave-1 decision (w2-undo, fix-plan conflict 3):
  // ⌘K no longer OPENS the palette over another dialog, because every palette
  // command (Analyze, Undo, Close tab…) would then run against the document
  // hidden behind that dialog. It still closes the palette from itself.
  it("⌘K opens the palette only with no modal open, and toggles it closed from itself", () => {
    expect(resolveShortcut({ key: "k", metaKey: true }, { topModal: null })).toBe("palette");
    expect(resolveShortcut({ key: "k", metaKey: true }, { topModal: "draft" })).toBeNull();
    expect(resolveShortcut({ key: "k", metaKey: true }, { topModal: "settings" })).toBeNull();
    expect(resolveShortcut({ key: "k", metaKey: true }, { topModal: PALETTE_MODAL })).toBe("palette");
  });
});

describe("swallowedUnderModal — blocked chords must not reach the native menu", () => {
  const draft = { topModal: "draft" } as const;

  it("swallows the document chords a modal blocks (⌘W would otherwise hide the window)", () => {
    for (const e of [
      { key: "w", metaKey: true },
      { key: "s", metaKey: true },
      { key: "S", metaKey: true, shiftKey: true },
      { key: "o", metaKey: true },
      { key: "t", metaKey: true },
      { key: ",", metaKey: true },
    ]) {
      expect(swallowedUnderModal(e, draft), e.key).toBe(true);
    }
  });

  it("lets undo/redo, clipboard, quit and plain keys through", () => {
    for (const e of [
      { key: "z", metaKey: true },
      { key: "Z", metaKey: true, shiftKey: true },
      { key: "y", metaKey: true },
      { key: "c", metaKey: true },
      { key: "v", metaKey: true },
      { key: "x", metaKey: true },
      { key: "a", metaKey: true },
      { key: "q", metaKey: true },
      { key: "w" },
    ]) {
      expect(swallowedUnderModal(e, draft), e.key).toBe(false);
    }
  });

  it("never swallows when no modal is open (resolveShortcut handles those)", () => {
    expect(swallowedUnderModal({ key: "w", metaKey: true }, { topModal: null })).toBe(false);
  });

  it("does not swallow ⌘K over a dialog (no native menu item owns it; the field may)", () => {
    expect(swallowedUnderModal({ key: "k", metaKey: true }, draft)).toBe(false);
  });
});

describe("resolveShortcut — field undo in non-document fields (MISS-03, w2-undo)", () => {
  // Wave 1 returned null here (leave it to native undo). The native Edit menu
  // has no ⌘Z key equivalent, so WKWebView did nothing: the field-* ids make
  // useShortcuts run the field's own undo explicitly (document.execCommand).
  it("routes ⌘Z/⇧⌘Z/⌘Y in a plain field to that field's own undo", () => {
    const ctx = { topModal: null, targetKind: "other-editable" } as const;
    expect(resolveShortcut({ key: "z", metaKey: true }, ctx)).toBe("field-undo");
    expect(resolveShortcut({ key: "Z", metaKey: true, shiftKey: true }, ctx)).toBe("field-redo");
    expect(resolveShortcut({ key: "y", metaKey: true }, ctx)).toBe("field-redo");
  });

  it("dialog fields get field undo too — never the document's", () => {
    const ctx = { topModal: "draft", targetKind: "other-editable" } as const;
    expect(resolveShortcut({ key: "z", metaKey: true }, ctx)).toBe("field-undo");
    expect(resolveShortcut({ key: "Z", metaKey: true, shiftKey: true }, ctx)).toBe("field-redo");
    expect(resolveShortcut({ key: "z", metaKey: true }, { topModal: "palette", targetKind: "other-editable" })).toBe("field-undo");
  });

  it("under a modal, a non-field (or document-history) target gets no undo at all", () => {
    for (const targetKind of ["doc-history", "none"] as const) {
      expect(resolveShortcut({ key: "z", metaKey: true }, { topModal: "draft", targetKind })).toBeNull();
      expect(resolveShortcut({ key: "Z", metaKey: true, shiftKey: true }, { topModal: "draft", targetKind })).toBeNull();
    }
  });

  it("leaves CodeMirror's ⌘Z/⌘Y to its own keymap, with or without a modal", () => {
    for (const topModal of [null, "draft"]) {
      const ctx = { topModal, targetKind: "codemirror" } as const;
      expect(resolveShortcut({ key: "z", metaKey: true }, ctx)).toBeNull();
      expect(resolveShortcut({ key: "Z", metaKey: true, shiftKey: true }, ctx)).toBeNull();
      expect(resolveShortcut({ key: "y", metaKey: true }, ctx)).toBeNull();
    }
  });

  it("field undo is never swallowed as a blocked chord", () => {
    expect(swallowedUnderModal({ key: "z", metaKey: true }, { topModal: "draft", targetKind: "other-editable" })).toBe(false);
  });

  it("routes ⌘Z to the document store from document-history inputs and non-editable focus", () => {
    expect(resolveShortcut({ key: "z", metaKey: true }, { topModal: null, targetKind: "doc-history" })).toBe("undo");
    expect(resolveShortcut({ key: "z", metaKey: true }, { topModal: null, targetKind: "none" })).toBe("undo");
  });

  it("other chords still work from inside CodeMirror or a plain field", () => {
    expect(resolveShortcut({ key: "s", metaKey: true }, { topModal: null, targetKind: "codemirror" })).toBe("save");
    expect(resolveShortcut({ key: "k", metaKey: true }, { topModal: null, targetKind: "other-editable" })).toBe("palette");
  });
});

/** A minimal Element stand-in: `closest` matches the selectors listed in `matches`. */
function fakeTarget(tagName: string, matches: string[] = [], isContentEditable = false): TargetLike {
  return {
    tagName,
    isContentEditable,
    closest: (sel: string) => (matches.includes(sel) ? {} : null),
  };
}

describe("shortcutTargetKind", () => {
  it("a field tagged data-doc-history is a document-history target", () => {
    expect(shortcutTargetKind(fakeTarget("TEXTAREA", ["[data-doc-history]"]))).toBe("doc-history");
  });

  it("anything inside .cm-editor is CodeMirror", () => {
    expect(shortcutTargetKind(fakeTarget("DIV", [".cm-editor"], true))).toBe("codemirror");
  });

  it("other inputs, textareas and contentEditable are other-editable", () => {
    expect(shortcutTargetKind(fakeTarget("INPUT"))).toBe("other-editable");
    expect(shortcutTargetKind(fakeTarget("TEXTAREA"))).toBe("other-editable");
    expect(shortcutTargetKind(fakeTarget("P", [], true))).toBe("other-editable");
  });

  it("non-text inputs (checkbox, radio, range…) are not editable fields", () => {
    for (const type of ["checkbox", "radio", "range", "color", "button", "submit", "file"]) {
      expect(shortcutTargetKind({ ...fakeTarget("INPUT"), type }), type).toBe("none");
    }
    for (const type of ["text", "search", "url", "email", "number", ""]) {
      expect(shortcutTargetKind({ ...fakeTarget("INPUT"), type }), type).toBe("other-editable");
    }
  });

  it("buttons, body and non-elements are none", () => {
    expect(shortcutTargetKind(fakeTarget("BUTTON"))).toBe("none");
    expect(shortcutTargetKind(fakeTarget("BODY"))).toBe("none");
    expect(shortcutTargetKind(null)).toBe("none");
    expect(shortcutTargetKind({})).toBe("none");
  });
});

describe("flushesPendingEditBeforeHistory — commit-on-blur document editors", () => {
  // Markdown Preview blocks hold typed text in the DOM until blur; the store
  // undo remounts every block, so an unflushed edit would vanish silently.
  it("a contentEditable document-history target is flushed before store undo", () => {
    expect(flushesPendingEditBeforeHistory(fakeTarget("P", ["[data-doc-history]"], true))).toBe(true);
  });

  it("document-history textareas (write on every keystroke) keep focus", () => {
    expect(flushesPendingEditBeforeHistory(fakeTarget("TEXTAREA", ["[data-doc-history]"]))).toBe(false);
  });

  it("other editables and non-elements are never flushed", () => {
    expect(flushesPendingEditBeforeHistory(fakeTarget("P", [], true))).toBe(false);
    expect(flushesPendingEditBeforeHistory(fakeTarget("DIV", [".cm-editor"], true))).toBe(false);
    expect(flushesPendingEditBeforeHistory(null)).toBe(false);
  });
});

describe("menuAllowedWithModal", () => {
  it("menu ids that mutate the document are blocked under a modal", () => {
    expect(menuAllowedWithModal("analyze")).toBe(false);
    expect(menuAllowedWithModal("undo")).toBe(false);
    expect(menuAllowedWithModal("redo")).toBe(false);
    expect(menuAllowedWithModal("new_tab")).toBe(false);
    expect(menuAllowedWithModal("open")).toBe(false);
    expect(menuAllowedWithModal("save_as")).toBe(false);
    expect(menuAllowedWithModal("draft")).toBe(false);
    expect(menuAllowedWithModal("quit")).toBe(true);
  });

  it("is an allowlist — an unknown (future) id is blocked by default", () => {
    expect(menuAllowedWithModal("find_next")).toBe(false);
  });
});

describe("find shortcuts (BUG-010)", () => {
  it("resolve ⌘F / ⌥⌘F / ⌘G / ⇧⌘G / ⌘L", () => {
    expect(resolveShortcut({ key: "f", metaKey: true }, none)).toBe("find");
    expect(resolveShortcut({ key: "f", ctrlKey: true }, none)).toBe("find");
    // macOS reports Option+F as e.key "ƒ": the physical key decides.
    expect(resolveShortcut({ key: "ƒ", code: "KeyF", metaKey: true, altKey: true }, none)).toBe("find-replace");
    expect(resolveShortcut({ key: "f", code: "KeyF", ctrlKey: true, altKey: true }, none)).toBe("find-replace");
    expect(resolveShortcut({ key: "g", metaKey: true }, none)).toBe("find-next");
    expect(resolveShortcut({ key: "G", metaKey: true, shiftKey: true }, none)).toBe("find-previous");
    expect(resolveShortcut({ key: "l", metaKey: true }, none)).toBe("go-to-line");
  });

  it("work from CodeMirror and from the find field itself", () => {
    for (const targetKind of ["codemirror", "other-editable", "doc-history"] as const) {
      expect(resolveShortcut({ key: "f", metaKey: true }, { topModal: null, targetKind })).toBe("find");
      expect(resolveShortcut({ key: "g", metaKey: true }, { topModal: null, targetKind })).toBe("find-next");
    }
  });

  it("never fire while a modal is open, and are kept from the native menu there", () => {
    for (const e of [
      { key: "f", metaKey: true },
      { key: "ƒ", code: "KeyF", metaKey: true, altKey: true },
      { key: "g", metaKey: true },
      { key: "G", metaKey: true, shiftKey: true },
      { key: "l", metaKey: true },
    ]) {
      expect(resolveShortcut(e, { topModal: "draft" }), e.key).toBeNull();
      expect(resolveShortcut(e, { topModal: PALETTE_MODAL }), e.key).toBeNull();
      expect(swallowedUnderModal(e, { topModal: "draft" }), e.key).toBe(true);
    }
  });

  it("an IME composition key never resolves", () => {
    expect(resolveShortcut({ key: "f", metaKey: true, isComposing: true }, none)).toBeNull();
    expect(resolveShortcut({ key: "g", metaKey: true, keyCode: 229 }, none)).toBeNull();
  });

  it("the find menu ids are blocked under a modal", () => {
    for (const id of ["find", "find_replace", "find_next", "find_previous", "go_to_line", "close_tab"]) {
      expect(menuAllowedWithModal(id), id).toBe(false);
    }
  });
});

describe("find shortcuts on macOS use ⌘ only (BUG-010)", () => {
  // Ctrl+F is Cocoa/CodeMirror forward-char and Ctrl+L is CodeMirror's mac
  // selectLine: binding them too would act twice on one key press.
  const mac = { topModal: null, mac: true } as const;
  it("Ctrl chords do not resolve to find on macOS", () => {
    expect(resolveShortcut({ key: "f", ctrlKey: true }, mac)).toBeNull();
    expect(resolveShortcut({ key: "l", ctrlKey: true }, mac)).toBeNull();
    expect(resolveShortcut({ key: "g", ctrlKey: true }, mac)).toBeNull();
    expect(resolveShortcut({ key: "G", ctrlKey: true, shiftKey: true }, mac)).toBeNull();
    expect(resolveShortcut({ key: "f", code: "KeyF", ctrlKey: true, altKey: true }, mac)).toBeNull();
  });
  it("⌘ chords still do", () => {
    expect(resolveShortcut({ key: "f", metaKey: true }, mac)).toBe("find");
    expect(resolveShortcut({ key: "ƒ", code: "KeyF", metaKey: true, altKey: true }, mac)).toBe("find-replace");
    expect(resolveShortcut({ key: "g", metaKey: true }, mac)).toBe("find-next");
    expect(resolveShortcut({ key: "G", metaKey: true, shiftKey: true }, mac)).toBe("find-previous");
    expect(resolveShortcut({ key: "l", metaKey: true }, mac)).toBe("go-to-line");
  });
  it("a blocked Ctrl chord is not swallowed under a modal on macOS", () => {
    expect(swallowedUnderModal({ key: "f", ctrlKey: true }, { topModal: "draft", mac: true })).toBe(false);
  });
});

describe("ux-a11y-i18n-1 — ⌘Z in the find bar right after Replace undoes the document", () => {
  it("a text field inside [data-find-bar] is classified find-bar", () => {
    expect(shortcutTargetKind(fakeTarget("INPUT", ["[data-find-bar]"]))).toBe("find-bar");
    // a non-text control in the bar (checkbox) is still none
    expect(shortcutTargetKind({ ...fakeTarget("INPUT", ["[data-find-bar]"]), type: "checkbox" })).toBe("none");
  });

  it("with a replace pending, ⌘Z / ⇧⌘Z from the bar resolve to document undo / redo", () => {
    const ctx = { topModal: null, targetKind: "find-bar" as const, findReplacePending: true };
    expect(resolveShortcut({ key: "z", metaKey: true }, ctx)).toBe("undo");
    expect(resolveShortcut({ key: "Z", metaKey: true, shiftKey: true }, ctx)).toBe("redo");
  });

  it("without a pending replace (the field was edited), ⌘Z stays the field's own undo", () => {
    const ctx = { topModal: null, targetKind: "find-bar" as const, findReplacePending: false };
    expect(resolveShortcut({ key: "z", metaKey: true }, ctx)).toBe("field-undo");
    expect(resolveShortcut({ key: "Z", metaKey: true, shiftKey: true }, ctx)).toBe("field-redo");
  });

  it("a plain other-editable field ignores the pending flag", () => {
    const ctx = { topModal: null, targetKind: "other-editable" as const, findReplacePending: true };
    expect(resolveShortcut({ key: "z", metaKey: true }, ctx)).toBe("field-undo");
  });
});

describe("ux-a11y-i18n-3 — no document shortcut acts under the presentation overlay", () => {
  const chords = [
    { key: "k", metaKey: true },
    { key: "f", metaKey: true },
    { key: "ƒ", code: "KeyF", metaKey: true, altKey: true },
    { key: "g", metaKey: true },
    { key: "l", metaKey: true },
    { key: ",", metaKey: true },
    { key: "w", metaKey: true },
    { key: "t", metaKey: true },
    { key: "o", metaKey: true },
    { key: "s", metaKey: true },
    { key: "z", metaKey: true },
  ];

  it("every chord resolves while not presenting (so the next test is not vacuous)", () => {
    for (const e of chords) expect(resolveShortcut(e, { topModal: null, mac: true }), e.key).not.toBeNull();
  });

  it("while presenting, every chord resolves to null and is swallowed (kept from the native menu)", () => {
    const ctx = { topModal: null, mac: true, presenting: true };
    for (const e of chords) {
      expect(resolveShortcut(e, ctx), e.key).toBeNull();
      expect(swallowedWhilePresenting(e, ctx), e.key).toBe(true);
    }
  });

  it("not presenting: nothing is swallowed by the presentation rule", () => {
    expect(swallowedWhilePresenting({ key: "w", metaKey: true }, { topModal: null })).toBe(false);
    expect(swallowedWhilePresenting({ key: "c", metaKey: true }, { topModal: null, presenting: true })).toBe(false);
  });
});
