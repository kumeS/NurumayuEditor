import { describe, expect, it } from "vitest";
import {
  dockedPanelOf,
  panelEscapeTarget,
  panelFocusReturnIndex,
  shouldReturnPanelFocus,
  unsentFocusAllowed,
  type PanelEscapeContext,
  type PanelFocusCandidate,
} from "./panelEscape";
import type { TargetKind } from "./shortcuts";

// Pure half of Esc-to-close for the docked panels and popovers (BUG-006, QA
// 20261003; review follow-up for the editor-focus path and the
// post-composition Esc). The wiring guards proving usePanelEscape and each
// panel actually call these live in panelEscapeContract.test.ts.

/** Review panel open alone, Esc pressed with nothing focused (the QA repro),
 *  long after the last IME composition ended. */
const base: PanelEscapeContext = {
  panels: ["review"],
  targetPanel: null,
  targetKind: "none",
  modalOpen: false,
  presenting: false,
  lastCompositionEnd: 0,
  now: 1_000_000,
};
const esc = { key: "Escape" };

describe("panelEscapeTarget — which panel a bare Escape closes", () => {
  it("closes the open panel from a non-editable target outside it (toolbar button / body)", () => {
    expect(panelEscapeTarget(esc, base)).toBe("review");
  });

  it("closes the panel the focus is in (its own buttons)", () => {
    expect(panelEscapeTarget(esc, { ...base, targetPanel: "review" })).toBe("review");
  });

  it("closes exactly one panel: the most recently opened when focus is outside both", () => {
    expect(panelEscapeTarget(esc, { ...base, panels: ["network", "review"] })).toBe("review");
    expect(panelEscapeTarget(esc, { ...base, panels: ["review", "network"] })).toBe("network");
  });

  it("the panel holding focus beats the most recently opened one", () => {
    expect(
      panelEscapeTarget(esc, { ...base, panels: ["network", "review"], targetPanel: "network" })
    ).toBe("network");
  });
});

describe("panelEscapeTarget — every guard returns null", () => {
  it("ignores keys other than Escape", () => {
    for (const key of ["Enter", "Tab", "a", "Esc ", "escape"]) {
      expect(panelEscapeTarget({ key }, base), key).toBeNull();
    }
  });

  it("ignores a modified Escape (⌘/Ctrl/⌥/⇧ — some other chord)", () => {
    for (const mod of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      expect(panelEscapeTarget({ ...esc, [mod]: true }, base), mod).toBeNull();
    }
  });

  it("never acts on an IME key (Esc cancelling a kana→kanji conversion)", () => {
    expect(panelEscapeTarget({ ...esc, isComposing: true }, base)).toBeNull();
    // WebKit: the committing keydown has keyCode 229 with isComposing false.
    expect(panelEscapeTarget({ ...esc, isComposing: false, keyCode: 229 }, base)).toBeNull();
    // …and keyCode 27 (a real Esc) is not mistaken for IME.
    expect(panelEscapeTarget({ ...esc, keyCode: 27 }, base)).toBe("review");
  });

  it("never acts on an Escape another handler already claimed (find bar, toolbar dropdown, ghost text)", () => {
    expect(panelEscapeTarget({ ...esc, defaultPrevented: true }, base)).toBeNull();
    expect(panelEscapeTarget({ ...esc, defaultPrevented: false }, base)).toBe("review");
  });

  it("never acts while a modal is open (the modal layer owns Esc)", () => {
    expect(panelEscapeTarget(esc, { ...base, modalOpen: true })).toBeNull();
  });

  it("never acts while the presentation overlay is up (Esc exits the presentation)", () => {
    expect(panelEscapeTarget(esc, { ...base, presenting: true })).toBeNull();
  });

  // Review follow-up (QA 20261003): unsent text lives in a panel's own fields.
  // Fails if the in-panel editable check is dropped.
  it("never acts from a text field inside a panel (unsent comment text lives there)", () => {
    const editable: TargetKind[] = ["doc-history", "codemirror", "find-bar", "other-editable"];
    for (const targetKind of editable) {
      expect(panelEscapeTarget(esc, { ...base, targetKind, targetPanel: "review" }), `${targetKind} in panel`).toBeNull();
    }
  });

  // Fails if the out-of-panel rule allows every editable kind (title input,
  // dialog fields, the find bar's own Esc).
  it("never acts from the find bar or another text field outside the panels (title, dialog fields)", () => {
    for (const targetKind of ["find-bar", "other-editable"] as TargetKind[]) {
      expect(panelEscapeTarget(esc, { ...base, targetKind }), targetKind).toBeNull();
    }
    // Allow-list, not deny-list: a target kind added later refuses by default.
    expect(panelEscapeTarget(esc, { ...base, targetKind: "some-new-kind" as TargetKind })).toBeNull();
  });

  // Fails if the decision checks only isImeKeyEvent (no post-composition
  // window) or ignores ctx.lastCompositionEnd.
  it("never acts on WebKit's late Esc that ends a composition (within 80 ms of compositionend)", () => {
    for (const targetKind of ["none", "doc-history"] as TargetKind[]) {
      const just = { ...base, targetKind, lastCompositionEnd: base.now - 10 };
      expect(panelEscapeTarget(esc, just), `${targetKind} 10 ms after`).toBeNull();
      expect(panelEscapeTarget(esc, { ...just, lastCompositionEnd: base.now - 79 }), `${targetKind} 79 ms after`).toBeNull();
      expect(panelEscapeTarget(esc, { ...just, lastCompositionEnd: base.now - 80 }), `${targetKind} 80 ms after`).toBe("review");
    }
  });

  // The out-of-panel rule is safe only because local Esc users claim the key:
  // ghost text / DraftBlock (doc-history), CodeMirror's simplifySelection.
  it("never acts on an Esc the editor already claimed (ghost text, DraftBlock, CodeMirror selection)", () => {
    for (const targetKind of ["doc-history", "codemirror"] as TargetKind[]) {
      expect(panelEscapeTarget({ ...esc, defaultPrevented: true }, { ...base, targetKind }), targetKind).toBeNull();
    }
  });

  it("does nothing when no panel is open", () => {
    expect(panelEscapeTarget(esc, { ...base, panels: [] })).toBeNull();
    expect(panelEscapeTarget(esc, { ...base, panels: [], targetKind: "doc-history" })).toBeNull();
  });

  // Defensive: panelEscapeContract.test.ts keeps every tagged surface
  // registered, so this covers only a surface missing from the open stack
  // (e.g. between its unmount and the next key).
  it("leaves focus inside a tagged surface that is not on the open stack alone", () => {
    expect(panelEscapeTarget(esc, { ...base, targetPanel: "not-on-the-stack" })).toBeNull();
  });
});

// Review follow-up (QA 20261003, BUG-006 keyboard path): after ⌘K → "Show
// review comments" the palette puts focus back in the paragraph, and the
// native Analyze menu leaves it in the editor. Esc there must close the panel.
describe("panelEscapeTarget — Esc from the editor outside any panel", () => {
  // Fails on the old rule `if (ctx.targetKind !== "none") return null;`.
  it("closes the most recently opened panel from a paragraph (document-history field)", () => {
    for (const targetKind of ["doc-history"] as TargetKind[]) {
      expect(panelEscapeTarget(esc, { ...base, targetKind }), targetKind).toBe("review");
      expect(panelEscapeTarget(esc, { ...base, targetKind, panels: ["review", "network"] }), targetKind).toBe("network");
      expect(panelEscapeTarget(esc, { ...base, targetKind, panels: ["network", "review"] }), targetKind).toBe("review");
    }
  });

  // Review follow-up: CodeMirror uses an unclaimed Esc itself — it turns on
  // its Tab-focus mode for two seconds (Esc, then Tab leaves the source, the
  // only keyboard way out since Tab indents). Fails if "codemirror" is put
  // back on the allow-list.
  it("leaves an Esc in the Markdown source to CodeMirror (its Esc-then-Tab way out)", () => {
    expect(panelEscapeTarget(esc, { ...base, targetKind: "codemirror" })).toBeNull();
    expect(panelEscapeTarget(esc, { ...base, targetKind: "codemirror", panels: ["review", "network"] })).toBeNull();
  });

  it("still ignores IME keys and modified Esc there", () => {
    for (const targetKind of ["doc-history", "codemirror"] as TargetKind[]) {
      expect(panelEscapeTarget({ ...esc, isComposing: true }, { ...base, targetKind }), targetKind).toBeNull();
      expect(panelEscapeTarget({ ...esc, keyCode: 229 }, { ...base, targetKind }), targetKind).toBeNull();
      expect(panelEscapeTarget({ ...esc, shiftKey: true }, { ...base, targetKind }), targetKind).toBeNull();
    }
  });
});

describe("dockedPanelOf — the docked panel an event target sits in", () => {
  const inside = (name: string | null) => ({
    closest: (sel: string) =>
      sel === "[data-docked-panel]" && name !== null ? { getAttribute: (a: string) => (a === "data-docked-panel" ? name : null) } : null,
  });

  it("reads data-docked-panel from the nearest panel root", () => {
    expect(dockedPanelOf(inside("review"))).toBe("review");
    expect(dockedPanelOf(inside("network"))).toBe("network");
  });

  it("is null outside any panel and for targets that are not elements (window, document)", () => {
    expect(dockedPanelOf(inside(null))).toBeNull();
    expect(dockedPanelOf({})).toBeNull();
    expect(dockedPanelOf(null)).toBeNull();
    expect(dockedPanelOf(undefined)).toBeNull();
  });
});

describe("shouldReturnPanelFocus — only when closing would otherwise lose focus", () => {
  it("returns focus when it was inside the closing panel, or nowhere (body)", () => {
    expect(shouldReturnPanelFocus({ focusInPanel: true, focusOnBody: false })).toBe(true);
    expect(shouldReturnPanelFocus({ focusInPanel: false, focusOnBody: true })).toBe(true);
  });

  it("leaves focus alone when it is already on something else (a toolbar button the user Tabbed to)", () => {
    expect(shouldReturnPanelFocus({ focusInPanel: false, focusOnBody: false })).toBe(false);
  });
});

describe("panelFocusReturnIndex — opener first, then the panel's toolbar toggle", () => {
  const ok: PanelFocusCandidate = {
    connected: true,
    isBody: false,
    inClosingPanel: false,
    inert: false,
    disabled: false,
  };

  it("prefers the element that had focus when the panel opened", () => {
    expect(panelFocusReturnIndex([ok, ok])).toBe(0);
  });

  it("falls back to the toolbar toggle when the opener is unusable", () => {
    expect(panelFocusReturnIndex([null, ok])).toBe(1);
    expect(panelFocusReturnIndex([{ ...ok, connected: false }, ok])).toBe(1);
    // WebKit does not focus a clicked button, so the captured opener is often <body>.
    expect(panelFocusReturnIndex([{ ...ok, isBody: true }, ok])).toBe(1);
    expect(panelFocusReturnIndex([{ ...ok, inClosingPanel: true }, ok])).toBe(1);
    expect(panelFocusReturnIndex([{ ...ok, inert: true }, ok])).toBe(1);
    expect(panelFocusReturnIndex([{ ...ok, disabled: true }, ok])).toBe(1);
  });

  it("is -1 when nothing can take focus (e.g. the Analyze toggle is disabled)", () => {
    expect(panelFocusReturnIndex([{ ...ok, isBody: true }, { ...ok, disabled: true }])).toBe(-1);
    expect(panelFocusReturnIndex([null, null])).toBe(-1);
    expect(panelFocusReturnIndex([])).toBe(-1);
  });
});

// Review follow-up (QA 20261003): with an unsent Review comment, Esc keeps the
// panel open and shows the comment — but an Esc typed in the document must not
// pull the caret out of the paragraph into the composer.
describe("unsentFocusAllowed — where an Esc may move focus to unsent text", () => {
  it("from inside the closing panel or a non-editable target only", () => {
    expect(unsentFocusAllowed("review", { targetPanel: "review", targetKind: "none" })).toBe(true);
    expect(unsentFocusAllowed("review", { targetPanel: null, targetKind: "none" })).toBe(true);
    // Fails if the rule ignores where the Esc came from.
    expect(unsentFocusAllowed("review", { targetPanel: null, targetKind: "doc-history" })).toBe(false);
    expect(unsentFocusAllowed("review", { targetPanel: "network", targetKind: "none" })).toBe(false);
  });
});
