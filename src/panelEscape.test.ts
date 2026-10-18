import { describe, expect, it } from "vitest";
import {
  dockedPanelOf,
  panelEscapeTarget,
  panelFocusReturnIndex,
  shouldReturnPanelFocus,
  type PanelEscapeContext,
  type PanelFocusCandidate,
} from "./panelEscape";
import type { TargetKind } from "./shortcuts";

// Pure half of Esc-to-close for the right-docked side panels (BUG-006, QA
// 20261003). The wiring guards proving usePanelEscape / ReviewPanel /
// NetworkPanel actually call these live in panelEscapeContract.test.ts.

/** Review panel open alone, Esc pressed with nothing focused (the QA repro). */
const base: PanelEscapeContext = {
  panels: ["review"],
  targetPanel: null,
  targetKind: "none",
  modalOpen: false,
  presenting: false,
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

  it("never acts from an editable target — outside the panel or inside it (unsent comment text)", () => {
    const editable: TargetKind[] = ["doc-history", "codemirror", "find-bar", "other-editable"];
    for (const targetKind of editable) {
      expect(panelEscapeTarget(esc, { ...base, targetKind }), targetKind).toBeNull();
      expect(panelEscapeTarget(esc, { ...base, targetKind, targetPanel: "review" }), `${targetKind} in panel`).toBeNull();
    }
  });

  it("does nothing when no panel is open", () => {
    expect(panelEscapeTarget(esc, { ...base, panels: [] })).toBeNull();
  });

  it("leaves focus inside a docked surface that is not registered for Esc alone", () => {
    expect(panelEscapeTarget(esc, { ...base, targetPanel: "diff" })).toBeNull();
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
