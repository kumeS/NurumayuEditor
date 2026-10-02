import { describe, expect, it } from "vitest";
import { PALETTE_MODAL } from "./shortcuts";

// Source-contract guards for the shared modal layer (BUG-016/017/017b,
// KBD-IME-ENTER, MISS-03). There is no DOM in this suite, so these prove the
// WIRING — every dialog goes through <Modal>, Modal calls the pure helpers in
// modalBehavior.ts, App makes the background inert, useShortcuts delegates to
// resolveShortcut. The real Escape / focus-trap behaviour is closed by the
// manual QA re-run (fix-plan §2.3), not claimed here.

const components = import.meta.glob("./components/*.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const top = import.meta.glob(["./App.tsx", "./useShortcuts.ts"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const src = (name: string): string => {
  const s = components[`./components/${name}.tsx`];
  if (typeof s !== "string") throw new Error(`missing component source ${name}`);
  return s;
};

const DIALOGS = ["DraftModal", "HelpModal", "SettingsModal", "PromptModal", "CommandPalette"];

describe("every dialog renders through the shared Modal", () => {
  it.each(DIALOGS)("%s imports and renders <Modal> and draws no backdrop of its own", (name) => {
    const s = src(name);
    expect(s).toMatch(/from "\.\/Modal"/);
    expect(s).toMatch(/<Modal\b/);
    expect(s).not.toMatch(/fixed inset-0/);
  });

  it("only Modal.tsx draws a modal backdrop", () => {
    const offenders = Object.entries(components)
      .filter(([path]) => !/\/(Modal|PresentationMode)\.tsx$/.test(path))
      .filter(([, s]) => /fixed inset-0[^"]*bg-black\//.test(s))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it.each(DIALOGS)("%s does not handle Escape itself (Modal owns it, IME-safe)", (name) => {
    expect(src(name)).not.toMatch(/key === "Escape"/);
  });
});

describe("Modal.tsx wiring", () => {
  const modal = () => src("Modal");

  it("is an accessible dialog", () => {
    expect(modal()).toMatch(/role="dialog"/);
    expect(modal()).toMatch(/aria-modal="true"/);
    expect(modal()).toMatch(/aria-labelledby=\{/);
  });

  it("installs ONE capture-phase document keydown listener", () => {
    const adds = [...modal().matchAll(/document\.addEventListener\("keydown",\s*\w+,\s*true\)/g)];
    expect(adds).toHaveLength(1);
    expect(modal()).toMatch(/document\.removeEventListener\("keydown",\s*\w+,\s*true\)/);
  });

  it("delegates key, focus and stack decisions to the pure helpers", () => {
    for (const fn of ["modalKeyAction(", "nextFocusIndex(", "topmostModal(", "shouldRestoreFocus(", "pushModal(", "popModal("]) {
      expect(modal(), fn).toContain(fn);
    }
  });

  it("acts only when it is the topmost modal", () => {
    const handler = modal().slice(modal().indexOf("const onKey"));
    const guard = handler.indexOf("topmostModal(");
    const action = handler.indexOf("modalKeyAction(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(action);
  });
});

describe("dialog-specific wiring", () => {
  it("PromptHost resolves the awaiting caller with null when the Modal closes", () => {
    const s = src("PromptModal");
    const modalTag = s.slice(s.indexOf("<Modal"), s.indexOf("panelClassName=", s.indexOf("<Modal")));
    expect(modalTag).toMatch(/onClose=\{\(\) => finish\(null\)\}/);
  });

  it("Settings cannot be dismissed (Escape / backdrop) while it is saving", () => {
    expect(src("SettingsModal")).toMatch(/dismissible=\{!saving\}/);
  });

  it("Settings closes itself before opening the personal library panel", () => {
    expect(src("SettingsModal")).toMatch(/closeSettings\(\);\s*openPersonalLibraryPanel\(\)/);
  });
});

describe("IME-guarded Enter handlers (KBD-IME-ENTER)", () => {
  it.each(["CommandPalette", "PromptModal", "DraftModal", "SettingsModal", "FindBar"])(
    "every Enter handler in %s checks isImeKeyEvent first",
    (name) => {
      const s = src(name);
      const enters = [...s.matchAll(/e\.key === "Enter"/g)];
      expect(enters.length).toBeGreaterThan(0);
      for (const m of enters) {
        const handlerStart = s.lastIndexOf("onKeyDown", m.index);
        expect(handlerStart, `Enter at ${m.index} is not inside an onKeyDown`).toBeGreaterThan(-1);
        const handler = s.slice(handlerStart, m.index);
        expect(handler, `Enter at ${m.index} in ${name}`).toContain("isImeKeyEvent(");
      }
    }
  );
});

describe("ux-a11y-i18n-2 — the Markdown Preview new-paragraph draft is IME-safe", () => {
  it("DraftBlock's key handler returns on an IME key BEFORE handling Escape (Esc cancels a conversion)", () => {
    const s = src("MarkdownPreview");
    const start = s.indexOf("function DraftBlock(");
    expect(start).toBeGreaterThan(-1);
    const body = s.slice(start, s.indexOf("\nfunction ", start + 1));
    const handler = body.slice(body.indexOf("onKeyDown={(e) => {"));
    const guard = handler.indexOf("if (isImeKeyEventSince(e.nativeEvent, lastCompositionEnd.current)) return;");
    const escape = handler.indexOf('e.key === "Escape"');
    expect(guard).toBeGreaterThan(-1);
    expect(escape).toBeGreaterThan(guard);
  });
});

describe("FindBar is docked, not a modal (BUG-010, ui.md #8)", () => {
  it("draws no backdrop, does not use <Modal>, and is a search landmark", () => {
    const s = src("FindBar");
    expect(s).not.toMatch(/from "\.\/Modal"/);
    expect(s).not.toMatch(/<Modal\b/);
    expect(s).not.toMatch(/fixed inset-0/);
    expect(s).not.toMatch(/aria-modal/);
    expect(s).toMatch(/role="search"/);
  });

  it("every Escape handler in FindBar checks isImeKeyEvent first", () => {
    const s = src("FindBar");
    const escapes = [...s.matchAll(/e\.key === "Escape"/g)];
    expect(escapes.length).toBeGreaterThanOrEqual(3); // query, replacement, line fields
    for (const m of escapes) {
      const handler = s.slice(s.lastIndexOf("onKeyDown", m.index), m.index);
      expect(handler, `Escape at ${m.index}`).toContain("isImeKeyEvent(");
    }
  });

  it("App mounts it between the Toolbar and <main>, inside the inert wrapper", () => {
    const a = top["./App.tsx"];
    const bar = a.indexOf("<FindBar />");
    expect(bar).toBeGreaterThan(a.indexOf("<Toolbar />"));
    expect(bar).toBeLessThan(a.indexOf("<main"));
    expect(bar).toBeGreaterThan(a.indexOf("inert={modalOpen}"));
  });

  it("useShortcuts tells the resolver when it runs on macOS (find chords need ⌘ there)", () => {
    const h = top["./useShortcuts.ts"];
    expect(h).toMatch(/const IS_MAC = [^\n]*navigator\.platform/);
    const ctx = h.slice(h.indexOf("const ctx = {"), h.indexOf("};", h.indexOf("const ctx = {")));
    expect(ctx).toContain("mac: IS_MAC");
  });

  it("useShortcuts runs the find ids through the bar's own entry points", () => {
    const h = top["./useShortcuts.ts"];
    const body = (id: string) => {
      const at = h.indexOf(`case "${id}":`);
      expect(at, id).toBeGreaterThan(-1);
      return h.slice(at, h.indexOf("break;", at));
    };
    expect(body("find")).toMatch(/openFindBar\("find"\)/);
    expect(body("find-replace")).toMatch(/openFindBar\("replace"\)/);
    expect(body("find-next")).toMatch(/findStep\("next"\)/);
    expect(body("find-previous")).toMatch(/findStep\("prev"\)/);
    expect(body("go-to-line")).toMatch(/openFindBar\("line"\)/);
  });
});

describe("App makes the background inert while a modal is open (BUG-017)", () => {
  const app = () => top["./App.tsx"];

  it("wraps the non-modal chrome in inert={modalOpen}, closed before the modals", () => {
    const a = app();
    expect(a).toMatch(/const modalOpen = useModalStack\(/);
    const inertAt = a.indexOf("inert={modalOpen}");
    expect(inertAt).toBeGreaterThan(-1);
    const wrapperStart = a.lastIndexOf("<div", inertAt);
    const modalsAt = a.indexOf("<SettingsModal");
    expect(modalsAt).toBeGreaterThan(inertAt);
    const wrapped = a.slice(wrapperStart, modalsAt);
    for (const el of ["<TabBar", "<Toolbar", "<main", "<HealthBar", "<SelectionBar"]) {
      expect(wrapped, el).toContain(el);
    }
    // The wrapper closes before the modals: its <div>s balance inside the slice.
    const opens = (wrapped.match(/<div\b/g) ?? []).length;
    const closes = (wrapped.match(/<\/div>/g) ?? []).length;
    expect(closes).toBe(opens);
    expect(wrapped).toMatch(/aria-hidden=\{modalOpen \|\| undefined\}/);
  });

  it("keeps the dialogs and toasts outside the inert wrapper", () => {
    const a = app();
    const modalsAt = a.indexOf("<SettingsModal");
    for (const el of ["<DraftModal", "<HelpModal", "<CommandPalette", "<PromptHost", "<Toasts"]) {
      expect(a.indexOf(el), el).toBeGreaterThan(modalsAt);
    }
  });

  it("the native menu listener consults menuAllowedWithModal before dispatching", () => {
    const a = app();
    const listener = a.slice(a.indexOf('listen<string>("menu"'), a.indexOf("switch (e.payload)"));
    expect(listener).toMatch(/menuAllowedWithModal\(e\.payload\)/);
    expect(listener).toMatch(/useModalStack\.getState\(\)/);
  });
});

describe("useShortcuts delegates to resolveShortcut (BUG-017b, MISS-03)", () => {
  const hook = () => top["./useShortcuts.ts"];

  it("calls the pure resolver with the modal stack and the classified target", () => {
    expect(hook()).toMatch(/resolveShortcut\(/);
    expect(hook()).toMatch(/shortcutTargetKind\(e\.target\)/);
    expect(hook()).toMatch(/topModal: topmostModal\(useModalStack\.getState\(\)\.stack\)/);
    expect(hook()).not.toMatch(/key === "z"/);
    expect(hook()).not.toMatch(/key === "s"/);
  });

  it("still preventDefaults chords a modal blocks, so the native menu (⌘W) can't fire", () => {
    const h = hook();
    const guard = h.indexOf("swallowedUnderModal(e, ctx)");
    expect(guard).toBeGreaterThan(-1);
    expect(h.slice(guard, guard + 120)).toMatch(/e\.preventDefault\(\)/);
    expect(h).toMatch(/resolveShortcut\(e, ctx\)/);
  });

  it("passes the presentation and find-replace state into the context, and swallows chords while presenting", () => {
    const h = hook();
    expect(h).toMatch(/presenting: useStore\.getState\(\)\.presentationOpen/);
    expect(h).toMatch(/findReplacePending: useStore\.getState\(\)\.find\.replacePending/);
    const guard = h.indexOf("swallowedWhilePresenting(e, ctx)");
    expect(guard).toBeGreaterThan(-1);
    expect(h.slice(guard, guard + 120)).toMatch(/e\.preventDefault\(\)/);
  });

  it("the native menu listener ignores everything but quit while presenting", () => {
    const a = top["./App.tsx"];
    const listener = a.slice(a.indexOf('listen<string>("menu"'), a.indexOf("switch (e.payload)"));
    expect(listener).toMatch(/useStore\.getState\(\)\.presentationOpen && !menuAllowedWithModal\(e\.payload\)/);
  });

  it("maps save-as to saveNativeAs", () => {
    expect(hook()).toMatch(/case "save-as":[\s\S]{0,80}saveNativeAs\(\)/);
  });

  // w2-undo: the native Edit menu has no ⌘Z key equivalent, so a plain field's
  // undo must be run explicitly (the event is preventDefault-ed first).
  it("field-undo / field-redo run the focused field's own undo via execCommand", () => {
    const h = hook();
    const caseBody = (id: string) => {
      const at = h.indexOf(`case "${id}":`);
      expect(at, id).toBeGreaterThan(-1);
      return h.slice(at, h.indexOf("break;", at));
    };
    expect(caseBody("field-undo")).toMatch(/document\.execCommand\("undo"\)/);
    expect(caseBody("field-redo")).toMatch(/document\.execCommand\("redo"\)/);
    expect(caseBody("field-undo")).not.toMatch(/useStore/);
    expect(caseBody("field-redo")).not.toMatch(/useStore/);
  });

  it("store undo/redo first flush a commit-on-blur editor's pending edit", () => {
    const h = hook();
    for (const [id, call] of [["undo", "undo()"], ["redo", "redo()"]] as const) {
      const at = h.indexOf(`case "${id}":`);
      expect(at, id).toBeGreaterThan(-1);
      const body = h.slice(at, h.indexOf("break;", at));
      const flush = body.indexOf("flushPendingEdit(e.target)");
      expect(flush, id).toBeGreaterThan(-1);
      expect(body.indexOf(`useStore.getState().${call}`), id).toBeGreaterThan(flush);
    }
    expect(h).toMatch(/flushesPendingEditBeforeHistory\(target\)[\s\S]{0,80}\.blur\(\)/);
  });

  it("⌘K's palette-on-top check uses the palette's real modal name", () => {
    const p = src("CommandPalette");
    const tag = p.slice(p.indexOf("<Modal"), p.indexOf(">", p.indexOf("<Modal")));
    expect(tag).toContain(`name="${PALETTE_MODAL}"`);
  });
});

describe("document-history inputs are tagged (MISS-03)", () => {
  it("every ChunkView textarea carries data-doc-history", () => {
    const tags = src("ChunkView").split("<textarea").slice(1).map((t) => t.slice(0, t.indexOf("/>")));
    expect(tags.length).toBeGreaterThanOrEqual(3);
    for (const t of tags) expect(t).toMatch(/data-doc-history="true"/);
  });

  it("the detached slide title input (updateChunkContent) carries data-doc-history", () => {
    const s = src("SlideEditor");
    const at = s.indexOf("onChange={(e) => updateChunkContent(heading.id");
    expect(at).toBeGreaterThan(-1);
    const tag = s.slice(s.lastIndexOf("<input", at), s.indexOf("/>", at));
    expect(tag).toMatch(/data-doc-history="true"/);
  });

  // w2-undo: Preview edits commit through setMarkdownSource(…, {newUndoStep})
  // and must keep ⌘Z on the document history, not the empty native stack.
  it("Markdown Preview's editable blocks (p/h*/td/th/li) carry data-doc-history", () => {
    const s = src("MarkdownPreview");
    const at = s.indexOf("const props = {");
    expect(at).toBeGreaterThan(-1);
    const props = s.slice(at, s.indexOf("onFocus:", at));
    expect(props).toMatch(/contentEditable: canEdit,/);
    expect(props).toMatch(/"data-doc-history": canEdit \? "true" : undefined,/);
  });

  it("Markdown Preview's draft paragraph carries data-doc-history", () => {
    const s = src("MarkdownPreview");
    const fn = s.slice(s.indexOf("function DraftBlock("));
    const tag = fn.slice(fn.indexOf("<p"), fn.indexOf("onCompositionEnd", fn.indexOf("<p")));
    expect(tag).toMatch(/contentEditable/);
    expect(tag).toMatch(/data-doc-history="true"/);
  });
});
