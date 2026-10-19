import { describe, expect, it } from "vitest";
import { translate } from "./i18n";

// UI-polish guards (wave 5, p-slides) for the Slides editor and Presentation
// mode. No DOM in this suite: each assertion is scoped to the JSX element it
// guards, extracted from the raw component source.

const raw = import.meta.glob(["./components/SlideEditor.tsx", "./components/PresentationMode.tsx"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const slideEditor = raw["./components/SlideEditor.tsx"];
const present = raw["./components/PresentationMode.tsx"];

/** The opening tag (`<tag … >`) that contains `marker`. */
function openingTag(source: string, marker: string, tag: string): string {
  const at = source.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const start = source.lastIndexOf(`<${tag}`, at);
  const end = source.indexOf(">", at);
  return source.slice(start, end + 1);
}

describe("Slides editor — copy, names and keyboard reach", () => {
  it("the Detached pill is translated (no bare English in a Japanese UI)", () => {
    const at = slideEditor.indexOf('title={t("This slide shows its own summary');
    expect(at).toBeGreaterThan(-1);
    const pill = slideEditor.slice(at, slideEditor.indexOf("</span>", at));
    expect(pill).toMatch(/\{t\("Detached"\)\}/);
    expect(pill).not.toMatch(/>\s*✂ Detached\s*</);
    expect(translate("Detached", "ja")).toMatch(/[぀-ヿ一-龯]/);
  });

  it("the Present button does not promise full screen (it fills the window)", () => {
    const btn = openingTag(slideEditor, "onClick={startPresent}", "button");
    expect(btn).toMatch(/title=\{t\("Present in this window \(Esc to exit\)"\)\}/);
    expect(btn).not.toMatch(/full screen/i);
    expect(translate("Present in this window (Esc to exit)", "ja")).toBe("このウィンドウで発表 (Escで終了)");
  });

  it("the deck title and detached bullet fields have accessible names, not just placeholders", () => {
    const deck = openingTag(slideEditor, 'placeholder={t("Untitled Deck")}', "input");
    expect(deck).toMatch(/aria-label=\{t\("Deck title"\)\}/);
    const bullets = openingTag(slideEditor, 'placeholder={t("One bullet per line…")}', "textarea");
    expect(bullets).toMatch(/aria-label=\{t\("Slide bullets \(one per line\)"\)\}/);
    const titleInput = openingTag(slideEditor, 'placeholder={t("Slide title")}', "input");
    expect(titleInput).toMatch(/aria-label=\{t\("Slide title"\)\}/);
    expect(translate("Deck title", "ja")).not.toBe("Deck title");
    expect(translate("Slide bullets (one per line)", "ja")).not.toBe("Slide bullets (one per line)");
  });

  it("hover-revealed rail actions and 'Split slide here' also appear on keyboard focus", () => {
    const at = slideEditor.indexOf('title={t("Move up")}');
    expect(at).toBeGreaterThan(-1);
    const rail = slideEditor.slice(slideEditor.lastIndexOf("<div", at), at);
    expect(rail).toMatch(/opacity-0 group-hover\/thumb:opacity-100 focus-within:opacity-100/);
    const split = openingTag(slideEditor, 'title={t("Start a new slide here', "button");
    expect(split).toMatch(/group-hover\/row:opacity-100/);
    expect(split).toMatch(/focus-visible:opacity-100/);
  });

  it("Delete slide is set apart from the safe rail actions by a divider", () => {
    const dup = slideEditor.indexOf('t("Duplicate slide")');
    const del = slideEditor.indexOf('title={t("Delete slide")}');
    expect(dup).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(dup);
    const between = slideEditor.slice(dup, del);
    expect(between).toMatch(/<span aria-hidden="true" className="[^"]*\bborder-l\b[^"]*border-chrome-line[^"]*" \/>/);
  });
});

describe("Presentation mode — overflow and state", () => {
  it("the slide is sized by the stage's height as well as its width (no pushed-off controls)", () => {
    const stage = openingTag(present, "<SlideStage", "div");
    const area = present.slice(present.lastIndexOf("<div", present.lastIndexOf("<div", present.indexOf("<SlideStage")) - 1), present.indexOf("<SlideStage"));
    expect(area).toMatch(/className="[^"]*\bmin-h-0\b[^"]*\[container-type:size\][^"]*"/);
    expect(stage).toMatch(/w-\[min\(100%,1280px,calc\(100cqh\*16\/9\)\)\]/);
  });

  it("speaker notes keep their line breaks and scroll instead of growing without bound", () => {
    const at = present.indexOf('{t("Speaker notes")}');
    expect(at).toBeGreaterThan(-1);
    const box = present.slice(present.lastIndexOf("<div", present.lastIndexOf("<div", at) - 1), at);
    expect(box).toMatch(/whitespace-pre-wrap/);
    expect(box).toMatch(/max-h-\[30vh\] overflow-y-auto/);
  });

  it("the Notes toggle exposes its on/off state to assistive tech", () => {
    const btn = openingTag(present, 'title={t("Toggle speaker notes (N)")}', "button");
    expect(btn).toMatch(/aria-pressed=\{notesOpen\}/);
  });
});

// BUG-009 (QA 20261003): Esc on slide 2 left the Slides editor on slide 1 and
// the next Present started on slide 1. The rule (which chunk to focus) is
// tested in slideCommands.test.ts and the store side in store.test.ts; these
// prove every way out of the overlay goes through it.
describe("BUG-009 (QA 20261003) — every exit selects the slide on screen", () => {
  /** The keydown effect: from `const onKey` through its dependency list. */
  function keyEffect(): string {
    const at = present.indexOf("const onKey = (e: KeyboardEvent)");
    expect(at, "keydown handler").toBeGreaterThan(-1);
    return present.slice(at, present.indexOf("]);", at) + 3);
  }

  // Review follow-up C16 (QA 20261003): the overlay holds DOM focus while it
  // is up, so an exit on the slide that already held the focused chunk left
  // no caret (focus fell to body) while an exit on another slide put it in
  // that slide's lead. Both now hand focus back through focusChunkRange,
  // which re-runs a mounted chunk's focuser even for an unchanged id. Fails
  // if the exit drops focusChunkRange, passes only `id` (the same-slide exit
  // loses the caret again), prefers the old focus over the exit slide's
  // lead, or focuses before the store selects the exit slide.
  it("one exit path reads the deck and focus at exit time, selects the exit slide, then hands the caret back", () => {
    expect(present).toMatch(
      /const exit = useCallback\(\(\) => \{\s*const st = useStore\.getState\(\);\s*const id = presentationExitFocus\(groupSlides\(st\.doc\.chunks\), idx, st\.focusedChunkId\);\s*closePresentation\(id\);\s*const target = id \?\? st\.focusedChunkId;\s*if \(target\) focusChunkRange\(target\);\s*\}, \[idx, closePresentation\]\);/
    );
    expect(present).toMatch(/import \{[^}]*\bfocusChunkRange\b[^}]*\} from "\.\/ChunkView";/);
  });

  // Fails if Esc calls closePresentation() directly (no slide sync), or if
  // the listener's deps omit `exit` — its closure would keep the start idx,
  // so Esc would always "exit" on the slide the presentation began on.
  it("Esc exits through it, and the key listener is re-bound when it changes", () => {
    const fx = keyEffect();
    expect(fx).toMatch(/e\.key === "Escape"\) \{\s*e\.preventDefault\(\);\s*exit\(\);/);
    expect(fx).not.toMatch(/closePresentation/);
    // The overlay is opaque: a surface left open under it (a toolbar menu, a
    // popover) is invisible, so Esc always ends the presentation even when
    // that hidden surface claimed it too. Fails if Esc defers to
    // defaultPrevented — the presentation would then seem to ignore Esc.
    expect(fx).not.toMatch(/defaultPrevented/);
    expect(fx).toMatch(/\}, \[slides\.length, exit\]\);$/);
  });

  // Review follow-up (QA 20261003): started from the palette, focus went back
  // to a hidden editor field under the overlay, so typed keys edited the
  // document behind it. Two causes: the overlay mounts while the palette is
  // still on the modal stack (its ancestor is `inert`, so focus() is a no-op),
  // and the palette's deferred restore then refocused the field. The overlay
  // now takes focus in an effect once no modal is open (Modal no longer takes
  // back a focus placed since the close — modalContract.test.ts). Fails if
  // either root loses the ref or tabIndex, or the effect focuses while a modal
  // is open or does not re-run when the modal stack empties.
  it("the overlay takes keyboard focus once no modal is open", () => {
    const roots = [...present.matchAll(/<div\s+ref=\{rootRef\}\s+tabIndex=\{-1\}[^>]*className="fixed inset-0 z-\[200\]/g)];
    expect(roots).toHaveLength(2);
    expect(present).toMatch(/const modalOpen = useModalStack\(\(s\) => s\.stack\.length > 0\);/);
    expect(present).toMatch(
      /useEffect\(\(\) => \{\s*const el = rootRef\.current;\s*if \(!el \|\| modalOpen\) return;\s*if \(!el\.contains\(document\.activeElement\)\) el\.focus\(\{ preventScroll: true \}\);\s*\}, \[modalOpen, hasSlide\]\);/
    );
  });

  // Fails if a visible exit control calls closePresentation itself: as an
  // onClick handler it would receive the click event as the focus target and
  // skip the slide sync.
  it("the ×, the 'Esc to exit' button and the empty deck's button exit through it too", () => {
    expect(present).not.toMatch(/onClick=\{closePresentation\}/);
    expect(openingTag(present, 'title={t("Exit presentation (Esc)")}', "button")).toMatch(/onClick=\{exit\}/);
    const bottom = present.slice(present.lastIndexOf("<button", present.indexOf('{t("Esc to exit")}')), present.indexOf('{t("Esc to exit")}'));
    expect(bottom).toMatch(/onClick=\{exit\}/);
    const empty = present.slice(present.indexOf('{t("This deck has no slides yet")}'), present.indexOf("</button>", present.indexOf('{t("This deck has no slides yet")}')));
    expect(empty).toMatch(/onClick=\{exit\}/);
    expect(present.match(/onClick=\{exit\}/g)).toHaveLength(3);
  });

  it("Present starts on the focused chunk's slide by the shared rule (so it resumes where the last exit left off)", () => {
    expect(present).toMatch(/const initialIdx = currentSlideIndex\(slides, focusedChunkId, null\);/);
    expect(present).toMatch(/useState\(initialIdx\)/);
  });
});
