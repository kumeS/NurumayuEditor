import { describe, expect, it } from "vitest";
import { translate } from "./i18n";

// Source-contract guards for SlideEditor (BUG-007 speaker-notes host, MISS-04
// tokens/helper line, MISS-09 slide-scoped Edit/Preview toggle, BUG-002 undo
// boundaries on the detached-slide title). There is no DOM in this suite: the
// pure decisions live in slides.test.ts / undoBoundary.test.ts, and these
// prove the component actually uses them. Each assertion is scoped to the
// slice of source it guards.

const raw = import.meta.glob("./components/SlideEditor.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const slideEditor = raw["./components/SlideEditor.tsx"];

/** A top-level `function Name(` body, up to the next top-level declaration. */
function fnBody(name: string): string {
  const start = slideEditor.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThan(-1);
  const rest = slideEditor.slice(start);
  const next = rest.slice(1).search(/\n(?:export |function |const |interface |\/\*\*)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("BUG-007 / MISS-04 — SpeakerNotes", () => {
  const notes = () => fnBody("SpeakerNotes");

  it("is hosted on the slide's lead chunk (heading, or first chunk of a leading slide)", () => {
    const s = notes();
    expect(s).toMatch(/const host = slideLead\(slide\);/);
    expect(s).toMatch(/key=\{host\.id\}/);
    expect(s).toMatch(/setChunkNotes\(host\.id, e\.target\.value\)/);
    expect(s).not.toMatch(/headingOf\(/);
  });

  it("uses semantic tokens only and never dims its reason into a placeholder", () => {
    const s = notes();
    expect(s).not.toMatch(/\bgray-\d/);
    expect(s).not.toMatch(/\bbg-white\b/);
    expect(s).not.toMatch(/disabled:opacity-60/);
    // The no-host reason is a readable helper line, not a placeholder.
    expect(s).not.toMatch(/placeholder=\{[^}]*no title yet/);
    expect(s).toMatch(
      /<p[^>]*className="[^"]*text-ink-soft[^"]*"[^>]*>\s*\{t\("This slide has no title yet — add one to attach speaker notes\."\)\}/
    );
  });
});

describe("MISS-09 — the slide's own Edit/Preview toggle names its scope", () => {
  /** The JSX block that renders the edit/preview switch. */
  function toggle(): string {
    const at = slideEditor.indexOf('(["edit", "preview"] as const).map(');
    expect(at, "edit/preview toggle not found").toBeGreaterThan(-1);
    const start = slideEditor.lastIndexOf("<div", at);
    return slideEditor.slice(start, slideEditor.indexOf("))}", at));
  }

  it("is labelled 'Edit slide' / 'Preview slide', not the bare mode words", () => {
    const s = toggle();
    expect(s).toMatch(/t\("Edit slide"\)/);
    expect(s).toMatch(/t\("Preview slide"\)/);
    expect(s).not.toMatch(/t\("Edit"\)|t\("Preview"\)/);
  });

  it("is an underline tab control, not a filled segment like the global mode switch", () => {
    const s = toggle();
    expect(s).toMatch(/role="tablist"/);
    expect(s).toMatch(/role="tab"/);
    expect(s).toMatch(/aria-selected=\{view === m\}/);
    expect(s).toMatch(/aria-controls="slide-canvas-panel"/);
    expect(slideEditor).toMatch(/id="slide-canvas-panel"\s*role="tabpanel"/);
    expect(s).toMatch(/border-b-2 border-accent text-accent/);
    expect(s).not.toMatch(/bg-accent text-white/);
    expect(s).not.toMatch(/\bgray-\d|\bbg-white\b/);
  });

  it("has Japanese labels", () => {
    expect(translate("Edit slide", "ja")).toBe("スライドを編集");
    expect(translate("Preview slide", "ja")).toBe("スライドをプレビュー");
  });
});

describe("BUG-002 — detached-slide title input records undo boundaries", () => {
  it("imports the boundary predicate", () => {
    expect(slideEditor).toMatch(
      /import \{ createCompositionTracker, startsNewUndoStep \} from "\.\.\/undoBoundary";/
    );
  });

  it("installs native beforeinput + compositionstart listeners that call startsNewUndoStep", () => {
    const s = fnBody("DetachedSlideBody");
    expect(s).toMatch(/addEventListener\("beforeinput", onBeforeInput\)/);
    expect(s).toMatch(/addEventListener\("compositionstart", onCompositionStart\)/);
    expect(s).toMatch(/removeEventListener\("beforeinput", onBeforeInput\)/);
    expect(s).toMatch(/removeEventListener\("compositionstart", onCompositionStart\)/);
    expect(s.match(/pendingNewStep\.current \|\|= startsNewUndoStep\(/g)).toHaveLength(2);
    expect(s).toMatch(/compositionJustStarted: true/);
  });

  it("the title input uses that ref and passes the boundary to updateChunkContent", () => {
    const s = fnBody("DetachedSlideBody");
    const at = s.indexOf("onChange={(e) => updateChunkContent(heading.id");
    expect(at).toBeGreaterThan(-1);
    const tag = s.slice(s.lastIndexOf("<input", at), s.indexOf("/>", at));
    expect(tag).toMatch(/ref=\{bindTitleInput\}/);
    expect(tag).toMatch(
      /onChange=\{\(e\) => updateChunkContent\(heading\.id, e\.target\.value, takeUndoBoundary\(\)\)\}/
    );
    expect(tag).toMatch(/data-doc-history="true"/);
  });

  it("a recorded boundary is consumed once and reset when the slide changes", () => {
    const s = fnBody("DetachedSlideBody");
    expect(s).toMatch(
      /const takeUndoBoundary = \(\) => \{\s*const newUndoStep = pendingNewStep\.current;\s*pendingNewStep\.current = false;\s*return \{ newUndoStep, composing: composition\.current\.take\(\) \};/
    );
    expect(s).toMatch(/pendingNewStep\.current = false;\s*composition\.current\.reset\(\);\s*\}, \[heading\?\.id\]\)/);
  });

  it("state-async-1: the title input feeds the composition tracker (idle rule skipped mid-composition)", () => {
    const s = fnBody("DetachedSlideBody");
    expect(s).toMatch(/composition\.current\.input\(ie\)/);
    expect(s).toMatch(/composition\.current\.start\(\)/);
    expect(s).toMatch(/addEventListener\("compositionend", onCompositionEnd\)/);
    expect(s).toMatch(/removeEventListener\("compositionend", onCompositionEnd\)/);
    expect(s).toMatch(/const onCompositionEnd = \(\) => composition\.current\.end\(\)/);
  });
});
