import { describe, expect, it } from "vitest";
import { JA } from "./i18n";
import { groupSlides } from "./slides";
import { currentSlideIndex, presentationExitFocus, slideCommandTarget } from "./slideCommands";
import type { Chunk, ChunkType } from "./types";

// D3 (ui.md #3): the Slides commands are reachable from the palette. The pure
// target rules live in slideCommands.ts; the rail (SlideEditor) and the palette
// both use currentSlideIndex, so "the current slide" can't drift between them.

const c = (id: string, type: ChunkType, content = id): Chunk => ({
  id,
  order: 0,
  content,
  metadata: { chunkType: type, linkedChunks: [], ...(type === "heading" ? { level: 1 } : {}) },
});
const deck = () => [c("intro", "text"), c("h1", "heading"), c("a", "text"), c("b", "text"), c("h2", "heading"), c("img", "image")];

describe("currentSlideIndex — the rail's selection rule (UI4)", () => {
  it("focused chunk's slide first, else the anchor's slide, else 0", () => {
    const slides = groupSlides(deck());
    expect(currentSlideIndex(slides, "b", null)).toBe(1);
    expect(currentSlideIndex(slides, null, "h2")).toBe(2);
    expect(currentSlideIndex(slides, "missing", "missing")).toBe(0);
    expect(currentSlideIndex([], null, null)).toBe(0);
  });
});

// BUG-009 (QA 20261003): Esc on slide 2 left the Slides editor on slide 1
// and the next Present started on slide 1 again. Both follow the focused chunk
// (currentSlideIndex), so exiting focuses the lead chunk of the slide on screen.
describe("BUG-009 (QA 20261003) — presentationExitFocus: the chunk focused when the presentation exits", () => {
  // Fails if exiting keeps the old focus (the bug: null here) or focuses the
  // slide's first BODY chunk instead of its lead.
  it("moved to slide 2: its heading — and the rail and the next Present then pick slide 2", () => {
    const slides = groupSlides(deck());
    const id = presentationExitFocus(slides, 2, "a");
    expect(id).toBe("h2");
    // SlideEditor's rule (focus beats the rail's last-clicked anchor) and
    // PresentationMode's start rule (no anchor) both land on the exit slide.
    expect(currentSlideIndex(slides, id, "h1")).toBe(2);
    expect(currentSlideIndex(slides, id, null)).toBe(2);
  });

  // Fails if the exit always focuses the lead: the focus would jump from the
  // paragraph being edited to the heading although the slide did not change.
  // (The DOM caret itself is restored by PresentationMode's exit — review
  // follow-up C16, guarded in slidePresentPolish.test.ts.)
  it("exit on the slide that holds the focus (e.g. the first): null — the focused chunk already selects that slide", () => {
    const slides = groupSlides(deck());
    expect(presentationExitFocus(slides, 1, "b")).toBeNull();
    expect(presentationExitFocus(slides, 0, "intro")).toBeNull();
  });

  // Fails if `at` is used unclamped: slides[5] is undefined, so the exit
  // would lose the slide that was on screen (the last one after the shrink).
  it("the deck shrank while presenting: the index is clamped to the last slide (and to 0 below)", () => {
    const slides = groupSlides(deck()); // 3 slides
    expect(presentationExitFocus(slides, 5, "a")).toBe("h2");
    expect(presentationExitFocus(slides, -1, "a")).toBe("intro");
  });

  // Fails if the lead is taken as the slide's heading only: the title slide
  // built from the document title has none, so its first chunk hosts it.
  it("the heading-less title slide (titled by the document title): its first chunk", () => {
    const slides = groupSlides([c("p0", "text", "概要 overview"), c("p1", "text", "背景"), c("h1", "heading", "結果")]);
    expect(presentationExitFocus(slides, 0, "h1")).toBe("p0");
    expect(currentSlideIndex(slides, "p0", null)).toBe(0);
  });

  it("no focus yet: the exit slide's lead; an empty deck: nothing to focus", () => {
    expect(presentationExitFocus(groupSlides(deck()), 0, null)).toBe("intro");
    expect(presentationExitFocus([], 0, "a")).toBeNull();
  });
});

describe("slideCommandTarget — what each palette command acts on", () => {
  it("a headed slide: duplicate/merge allowed, layout host = heading, text ids for Summarize", () => {
    const t = slideCommandTarget(deck(), "a");
    expect(t.current?.items.map((x) => x.id)).toEqual(["h1", "a", "b"]);
    expect(t.canDuplicate).toBe(true);
    expect(t.mergeHeadingId).toBe("h1");
    expect(t.layoutHostId).toBe("h1");
    expect(t.textIds).toEqual(["a", "b"]);
    expect(t.splitAt).toBe("a"); // focused body chunk, not the slide's first item
  });

  it("the leading heading-less slide: no duplicate, no merge", () => {
    const t = slideCommandTarget(deck(), "intro");
    expect(t.canDuplicate).toBe(false);
    expect(t.mergeHeadingId).toBeNull();
    expect(t.splitAt).toBeNull(); // the slide's first item cannot split it
    expect(t.layoutHostId).toBe("intro");
  });

  it("no focused chunk (or a dead one): no target — the rail may be showing its anchor slide, which the palette cannot see", () => {
    for (const focus of [null, "deleted-id"]) {
      const t = slideCommandTarget(deck(), focus);
      expect(t.current, String(focus)).toBeUndefined();
      expect(t.canDuplicate).toBe(false);
      expect(t.mergeHeadingId).toBeNull();
      expect(t.layoutHostId).toBeUndefined();
      expect(t.textIds).toEqual([]);
    }
  });

  it("with a focused chunk the palette targets exactly the slide the rail selects (any anchor)", () => {
    const slides = groupSlides(deck());
    for (const focus of ["intro", "a", "h2", "img"]) {
      for (const anchor of [null, "h1", "h2"]) {
        expect(slideCommandTarget(deck(), focus).index).toBe(currentSlideIndex(slides, focus, anchor));
      }
    }
  });

  it("focus on a heading never offers Split here; an empty deck has no target", () => {
    expect(slideCommandTarget(deck(), "h2").splitAt).toBeNull();
    const empty = slideCommandTarget([], null);
    expect(empty.current).toBeUndefined();
    expect(empty.layoutHostId).toBeUndefined();
  });

  it("the palette labels reuse the Slides editor's own keys (same Japanese)", () => {
    for (const key of [
      "Add slide",
      "Duplicate slide",
      "Delete slide",
      "Merge into previous",
      "Split slide here",
      "AI layout",
      "Summarize → slide",
    ]) {
      expect(JA[key], key).toBeTruthy();
    }
  });
});

const raw = import.meta.glob(["./components/CommandPalette.tsx", "./components/SlideEditor.tsx"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

describe("wiring", () => {
  const palette = raw["./components/CommandPalette.tsx"];
  const entry = (id: string) => {
    const at = palette.indexOf(`id: "${id}"`);
    expect(at, id).toBeGreaterThan(-1);
    return palette.slice(at, palette.indexOf("\n      },", at));
  };

  it.each([
    ["slide-add", 't("Add slide")', /s\.addChunkAfter\(/],
    ["slide-duplicate", 't("Duplicate slide")', /s\.duplicateChunksAfter\(/],
    ["slide-delete", 't("Delete slide")', /s\.deleteChunks\(/],
    ["slide-merge-previous", 't("Merge into previous")', /s\.mergeSlideIntoPrevious\(/],
    ["slide-split-here", 't("Split slide here")', /s\.splitSlideBefore\(/],
    ["slide-ai-layout", 't("AI layout")', /suggestSlideLayout\(/],
    ["slide-summarize", 't("Summarize → slide")', /summarizeSlide\(/],
  ])("%s: label, slide-mode visibility and the existing action", (id, label, call) => {
    const e = entry(id);
    expect(e).toContain(`label: ${label}`);
    expect(e).toMatch(/visible: slideMode\b/);
    expect(e).toMatch(call);
    expect(e).toMatch(/keywords: "[^"]*[぀-ヿ一-龯]/); // Japanese search keywords too
  });

  it("SlideEditor picks its current slide with the same currentSlideIndex", () => {
    expect(raw["./components/SlideEditor.tsx"]).toMatch(
      /const selected = currentSlideIndex\(slides, focusedChunkId, anchor\);/
    );
  });
});
