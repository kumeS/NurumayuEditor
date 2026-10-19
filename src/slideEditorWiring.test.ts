import { describe, expect, it } from "vitest";
import { translate } from "./i18n";
import { speakerNotesFieldValue } from "./slides";

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
    expect(s).toMatch(/updateChunkNotes\(host\.id, e\.target\.value, notesBoundaries\.take\(\)\)/);
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

// BUG-007 (QA 20261003): the notes field committed only on blur (an
// uncontrolled defaultValue textarea) — typing left the tab 保存済み with Undo
// disabled, the blur commit swallowed the first tab-close click, a document
// undo left the typed text on screen, and a mode round trip then "lost" it.
describe("BUG-007 (QA 20261003) — SpeakerNotes is a live, store-bound field", () => {
  const notes = () => fnBody("SpeakerNotes");
  /** The <textarea …/> element of the field. */
  const textarea = () => {
    const s = notes();
    const at = s.indexOf("<textarea");
    expect(at, "SpeakerNotes textarea").toBeGreaterThan(-1);
    return s.slice(at, s.indexOf("/>", at));
  };

  it("renders its value from the store (controlled), never a defaultValue", () => {
    const tag = textarea();
    expect(tag).toMatch(/\bvalue=\{shown\}/);
    expect(tag).not.toMatch(/defaultValue/);
    expect(notes()).toMatch(
      /const shown = speakerNotesFieldValue\(notes, draft && draft\.hostId === host\?\.id \? draft\.text : null\);/
    );
    expect(notes()).toMatch(/const notes = slideNotes\(slide\);/);
  });

  it("writes the store on every change through updateChunkNotes, with no blur commit left", () => {
    const tag = textarea();
    expect(tag).toMatch(
      /onChange=\{\(e\) => \{\s*setDraft\(\{ hostId: host\.id, text: e\.target\.value \}\);\s*updateChunkNotes\(host\.id, e\.target\.value, notesBoundaries\.take\(\)\);\s*\}\}/
    );
    expect(tag).not.toMatch(/onBlur/);
    expect(notes()).not.toMatch(/setChunkNotes/);
  });

  it("is a document-history field: ⌘Z there is the document undo, like the menu's 元に戻す", () => {
    expect(textarea()).toMatch(/data-doc-history="true"/);
    expect(textarea()).toMatch(/ref=\{notesBoundaries\.bind\}/);
  });

  it("records undo boundaries and IME composition like the other live fields (its own useUndoBoundaries)", () => {
    const s = notes();
    // One boundary/composition instance for this field, reset per notes host
    // (a boundary recorded on one slide never leaks into another's notes).
    expect(s.match(/useUndoBoundaries\(/g)).toHaveLength(1);
    expect(s).toMatch(/const notesBoundaries = useUndoBoundaries\(host\?\.id\);/);
    // The listeners live in the shared hook (guarded below), not inline.
    expect(s).not.toMatch(/startsNewUndoStep\(/);
  });
});

describe("BUG-007 (QA 20261003) — speakerNotesFieldValue (what the notes field shows)", () => {
  it("shows the stored notes when nothing was typed here", () => {
    expect(speakerNotesFieldValue("発表者ノート", null)).toBe("発表者ノート");
  });

  it("follows a document undo at once: the stored value wins over the stale typed text", () => {
    // Fails if the field shows what was typed regardless of the store (the
    // old uncontrolled field kept "発表者ノート" on screen after 元に戻す).
    expect(speakerNotesFieldValue("", "発表者ノート")).toBe("");
    expect(speakerNotesFieldValue("古いノート", "新しいノート")).toBe("古いノート");
    // …and a redo back to it.
    expect(speakerNotesFieldValue("発表者ノート", "")).toBe("発表者ノート");
  });

  it("keeps a typed leading space / blank lines the store normalises away", () => {
    // Fails if the field always shows the stored value: the store keeps a
    // whitespace-only note as "no notes", so the space would vanish.
    expect(speakerNotesFieldValue("", " ")).toBe(" ");
    expect(speakerNotesFieldValue("", " \n")).toBe(" \n");
  });

  it("shows the typed text when it is what the store holds (mixed script)", () => {
    expect(speakerNotesFieldValue(" 概要 overview", " 概要 overview")).toBe(" 概要 overview");
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
    expect(s).toMatch(/border-b-2 border-accent text-accent/);
    expect(s).not.toMatch(/bg-accent text-white/);
    expect(s).not.toMatch(/\bgray-\d|\bbg-white\b/);
  });

  // BUG-003 (QA 20261003): WebKit reports a tab selected when a tabpanel it
  // controls holds the focus, so the unselected tab must not control the
  // shared canvas panel (behaviour: slideViewTabs.test.ts).
  it("BUG-003: only the selected tab controls the canvas panel, which is labelled by the selected tab", () => {
    const s = toggle();
    expect(s).toMatch(/id=\{slideViewTabId\(m\)\}/);
    expect(s).toMatch(/aria-controls=\{view === m \? SLIDE_CANVAS_PANEL_ID : undefined\}/);
    expect(s).not.toMatch(/aria-controls="/);
    const at = slideEditor.indexOf('role="tabpanel"');
    expect(at, "tabpanel").toBeGreaterThan(-1);
    const panel = slideEditor.slice(slideEditor.lastIndexOf("<div", at), slideEditor.indexOf(">", at) + 1);
    expect(panel).toMatch(/id=\{SLIDE_CANVAS_PANEL_ID\}/);
    // Fails if the label is pinned to one tab (e.g. slideViewTabId("edit")):
    // in Preview the panel would be named by the unselected Edit tab.
    expect(panel).toMatch(/aria-labelledby=\{slideViewTabId\(view\)\}/);
    expect(slideEditor).toMatch(/<SlideViewTabs view=\{view\} onSelect=\{setView\} \/>/);
  });

  it("has Japanese labels", () => {
    expect(translate("Edit slide", "ja")).toBe("スライドを編集");
    expect(translate("Preview slide", "ja")).toBe("スライドをプレビュー");
  });
});

// The BUG-002 boundary + state-async-1 composition wiring, shared by every
// live document field in SlideEditor (detached title, detached bullets,
// speaker notes). Each call owns its refs, so a boundary recorded in one field
// is never consumed by another.
describe("BUG-002 — useUndoBoundaries records undo boundaries for one live field", () => {
  const hook = () => fnBody("useUndoBoundaries");

  it("imports the boundary predicate", () => {
    expect(slideEditor).toMatch(
      /import \{ createCompositionTracker, startsNewUndoStep \} from "\.\.\/undoBoundary";/
    );
  });

  it("owns its refs (one instance per call)", () => {
    const s = hook();
    expect(s).toMatch(/const pendingNewStep = useRef\(false\);/);
    expect(s).toMatch(/const composition = useRef\(createCompositionTracker\(\)\);/);
  });

  it("installs native beforeinput + compositionstart listeners that call startsNewUndoStep", () => {
    const s = hook();
    expect(s).toMatch(/addEventListener\("beforeinput", onBeforeInput\)/);
    expect(s).toMatch(/addEventListener\("compositionstart", onCompositionStart\)/);
    expect(s).toMatch(/removeEventListener\("beforeinput", onBeforeInput\)/);
    expect(s).toMatch(/removeEventListener\("compositionstart", onCompositionStart\)/);
    expect(s.match(/pendingNewStep\.current \|\|= startsNewUndoStep\(/g)).toHaveLength(2);
    expect(s).toMatch(/compositionJustStarted: true/);
  });

  it("a recorded boundary is consumed once and reset when the field's host changes", () => {
    const s = hook();
    expect(s).toMatch(
      /const take = useCallback\(\(\) => \{\s*const newUndoStep = pendingNewStep\.current;\s*pendingNewStep\.current = false;\s*return \{ newUndoStep, composing: composition\.current\.take\(\) \};/
    );
    expect(s).toMatch(/pendingNewStep\.current = false;\s*composition\.current\.reset\(\);\s*\}, \[resetKey\]\)/);
  });

  it("state-async-1: feeds the composition tracker (idle rule skipped mid-composition)", () => {
    const s = hook();
    expect(s).toMatch(/composition\.current\.input\(ie\)/);
    expect(s).toMatch(/composition\.current\.start\(\)/);
    expect(s).toMatch(/addEventListener\("compositionend", onCompositionEnd\)/);
    expect(s).toMatch(/removeEventListener\("compositionend", onCompositionEnd\)/);
    expect(s).toMatch(/const onCompositionEnd = \(\) => composition\.current\.end\(\)/);
  });
});

describe("BUG-002 — detached-slide title input records undo boundaries", () => {
  /** The detached-slide title <input …/>. */
  const titleInput = () => {
    const s = fnBody("DetachedSlideBody");
    const at = s.indexOf("onChange={(e) => updateChunkContent(heading.id");
    expect(at, "title input").toBeGreaterThan(-1);
    return s.slice(s.lastIndexOf("<input", at), s.indexOf("/>", at));
  };

  it("has its own boundary instance, reset per slide lead", () => {
    expect(fnBody("DetachedSlideBody")).toMatch(/const titleBoundaries = useUndoBoundaries\(leadId\);/);
  });

  it("the title input uses that instance and passes the boundary to updateChunkContent", () => {
    const tag = titleInput();
    expect(tag).toMatch(/ref=\{titleBoundaries\.bind\}/);
    expect(tag).toMatch(
      /onChange=\{\(e\) => updateChunkContent\(heading\.id, e\.target\.value, titleBoundaries\.take\(\)\)\}/
    );
    expect(tag).toMatch(/data-doc-history="true"/);
    // Fails if the title consumed the bullets' boundary (shared state).
    expect(tag).not.toMatch(/bodyBoundaries/);
  });
});

// QA 20261003 follow-up (the BUG-007 class): the detached-slide bullet field
// was an uncontrolled `defaultValue` textarea committed on blur
// (setSlideBody) — typing left the tab 保存済み with Undo disabled, the blur
// commit swallowed the first tab-close click, and its `key={body.join("|")}`
// remount would drop focus after every live commit. Behaviour: store.test.ts
// ("detached-slide bullets are live document edits"), slides.test.ts
// (slideBodyFieldValue), speakerNotesClose.test.ts (one close click).
describe("QA 20261003 follow-up — detached-slide bullets are a live, store-bound field", () => {
  const body = () => fnBody("DetachedSlideBody");
  /** The bullet <textarea …/>. */
  const textarea = () => {
    const s = body();
    const at = s.indexOf("<textarea");
    expect(at, "bullet textarea").toBeGreaterThan(-1);
    return s.slice(at, s.indexOf("/>", at));
  };

  it("renders a draft-aware value from the store, never a defaultValue", () => {
    const tag = textarea();
    expect(tag).toMatch(/\bvalue=\{shownBody\}/);
    expect(tag).not.toMatch(/defaultValue/);
    expect(body()).toMatch(
      /const shownBody = slideBodyFieldValue\(body, bodyDraft && bodyDraft\.leadId === leadId \? bodyDraft\.text : null\);/
    );
    expect(body()).toMatch(/const body = lead\?\.metadata\.slideBody \?\? \[\];/);
  });

  it("writes the store on every change through updateSlideBody, with no blur commit left", () => {
    const tag = textarea();
    expect(tag).toMatch(
      /onChange=\{\(e\) => \{\s*setBodyDraft\(\{ leadId, text: e\.target\.value \}\);\s*updateSlideBody\(leadId, e\.target\.value, bodyBoundaries\.take\(\)\);\s*\}\}/
    );
    expect(tag).not.toMatch(/onBlur/);
    expect(body()).not.toMatch(/setSlideBody/);
  });

  it("keeps its DOM node (and caret) across live commits: keyed by the slide lead, not the body", () => {
    const tag = textarea();
    expect(tag).toMatch(/key=\{leadId\}/);
    // Fails if it is keyed by content again: every committed keystroke would
    // remount the textarea and drop focus after one character.
    expect(tag).not.toMatch(/key=\{body/);
  });

  it("is a document-history field with its own undo-boundary instance", () => {
    const tag = textarea();
    expect(tag).toMatch(/data-doc-history="true"/);
    expect(tag).toMatch(/ref=\{bodyBoundaries\.bind\}/);
    expect(tag).not.toMatch(/titleBoundaries/);
    expect(body()).toMatch(/const bodyBoundaries = useUndoBoundaries\(leadId\);/);
    expect(body().match(/useUndoBoundaries\(/g)).toHaveLength(2);
    expect(body()).not.toMatch(/startsNewUndoStep\(/);
  });

  it("switching slides never leaks a draft or a boundary into another slide's bullets", () => {
    const s = body();
    // The draft is shown only on the slide it was typed on…
    expect(s).toMatch(/setBodyDraft\(\{ leadId, text: e\.target\.value \}\)/);
    expect(s).toMatch(/bodyDraft && bodyDraft\.leadId === leadId \? bodyDraft\.text : null/);
    // …the field remounts per slide lead…
    expect(textarea()).toMatch(/key=\{leadId\}/);
    // …and both boundary instances reset per slide lead.
    expect(s.match(/useUndoBoundaries\(leadId\)/g)).toHaveLength(2);
  });

  it("declares every hook before the no-lead early return (rules of hooks)", () => {
    const s = body();
    const early = s.indexOf("if (!leadId) return null;");
    expect(early).toBeGreaterThan(-1);
    for (const hook of [
      "useUndoBoundaries(leadId);",
      "const [bodyDraft, setBodyDraft] = useState<{ leadId: string; text: string } | null>(null);",
    ]) {
      const at = s.indexOf(hook);
      expect(at, hook).toBeGreaterThan(-1);
      expect(at, `${hook} after the early return`).toBeLessThan(early);
    }
    expect(s.lastIndexOf("useUndoBoundaries(")).toBeLessThan(early);
  });
});

// QA 20261003 follow-up: the diagram notices used to say diagrams are "not yet
// exported to .pptx" — but the in-app export embeds a diagram's rendered
// snapshot when the slide's layout has an image area (fileActions
// withRenderedDiagrams + pptx.rs), and drops it (with a warning) otherwise.
// Behaviour guards: pptx.rs diagram_snapshot_reaches_pptx_only_on_an_image_layout
// and slides.test.ts "diagrams on slides".
describe("QA 20261003 follow-up — diagram notices match the export", () => {
  const BADGE = "{n} diagram(s) on this slide — not drawn in the slide preview; the .pptx export includes them only when the slide uses an image layout (Image right, left or top)";
  const NOTE = "{n} diagram(s) in the editor — not drawn on slides in the app. The .pptx export includes them only when the slide uses an image layout.";

  it("the rail badge's tooltip is the accurate notice", () => {
    const at = slideEditor.indexOf("{diagramCount > 0 && (");
    expect(at, "diagram badge").toBeGreaterThan(-1);
    const badge = slideEditor.slice(at, slideEditor.indexOf("</span>", at));
    expect(badge).toContain(`title={translateWith("${BADGE}", lang, { n: diagramCount })}`);
  });

  it("the in-canvas note is the accurate notice", () => {
    const s = fnBody("SlideContent");
    const at = s.indexOf("const diagramNote =");
    expect(at, "diagramNote").toBeGreaterThan(-1);
    const note = s.slice(at, s.indexOf(") : null;", at));
    expect(note).toContain(`translateWith("${NOTE}", lang, {`);
  });

  it("no over-claiming 'not yet exported' copy is left in SlideEditor", () => {
    expect(slideEditor).not.toMatch(/not yet exported to \.pptx|not yet shown on slides or exported/);
  });

  it("has Japanese copy with the same placeholders", () => {
    expect(translate(BADGE, "ja")).toBe(
      "このスライドの図{n}件 — スライドのプレビューには描画されません。.pptxへの書き出しには、スライドが画像レイアウト(画像を右に・左に・上に)のときだけ含まれます"
    );
    expect(translate(NOTE, "ja")).toBe(
      "エディタ内の図{n}件 — アプリ内のスライドには描画されません。.pptxへの書き出しには、スライドが画像レイアウトのときだけ含まれます。"
    );
  });
});
