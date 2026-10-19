// What the Slides commands act on (D3, ui.md #3). Pure.
//
// Invariants:
// - "The current slide" is ONE rule (`currentSlideIndex`), used by both the
//   Slides rail (SlideEditor) and the command palette: the focused chunk's
//   slide, else the anchor's (the rail's last-clicked thumbnail; the palette
//   has none), else the first slide.
// - The palette targets a slide ONLY through the focused chunk. With no live
//   focused chunk the rail may be showing its local anchor slide, which the
//   palette cannot see, so every slide-specific command is hidden then (Add
//   slide is not slide-specific). With a focused chunk both pick its slide.
// - Each target mirrors the rail's own enablement: Duplicate and Merge need a
//   heading (a heading-less leading slide has no delimiter), Merge is never
//   offered for slide 1, and Split here needs a focused chunk that is not the
//   slide's first item.
// - Leaving the presentation selects the slide that was on screen
//   (`presentationExitFocus`, BUG-009): its lead chunk becomes the focused
//   chunk unless the focused chunk is already on it; both this rule and
//   PresentationMode's start slide follow the focused chunk.
// Known limit: the Edit/Preview slide-view switch is SlideEditor-local state,
// so it has no palette entry.

import { groupSlides, headingOf, layoutHost, isSlideDetached, slideLead, type SlideGroup } from "./slides";
import type { Chunk } from "./types";

/** Index of the current slide (see header). */
export function currentSlideIndex(
  slides: SlideGroup[],
  focusedChunkId: string | null,
  anchor: string | null
): number {
  let i = slides.findIndex((s) => s.items.some((c) => c.id === focusedChunkId));
  if (i < 0) i = slides.findIndex((s) => s.items[0]?.id === anchor);
  return i < 0 ? 0 : i;
}

/**
 * The chunk to focus when the presentation exits on slide `at` (BUG-009, QA
 * 20261003): that slide's lead chunk (`slideLead` — its heading, or the first
 * chunk of the heading-less title slide the document title heads), so the
 * Slides rail shows the slide that was on screen and the next Present starts
 * there. `at` is clamped to the deck (it may have shrunk while presenting).
 * null when the focused chunk is already on that slide (it already selects
 * the slide, so the focused chunk stays as it is) or the deck is empty. This
 * decides the store's selection only; putting the DOM caret back is
 * PresentationMode's `exit` (review follow-up C16, QA 20261003).
 */
export function presentationExitFocus(
  slides: SlideGroup[],
  at: number,
  focusedChunkId: string | null
): string | null {
  if (slides.length === 0) return null;
  const slide = slides[Math.min(Math.max(at, 0), slides.length - 1)];
  if (slide.items.some((c) => c.id === focusedChunkId)) return null;
  return slideLead(slide)?.id ?? null;
}

export interface SlideCommandTarget {
  slides: SlideGroup[];
  index: number;
  current: SlideGroup | undefined;
  canDuplicate: boolean;
  /** The heading to demote for "Merge into previous", or null when not allowed. */
  mergeHeadingId: string | null;
  /** The focused body chunk "Split slide here" splits before, or null. */
  splitAt: string | null;
  layoutHostId: string | undefined;
  /** Text chunk ids "Summarize → slide" reads. */
  textIds: string[];
  detached: boolean;
}

/** The palette's target: the slide holding `focusedChunkId`, or none. */
export function slideCommandTarget(chunks: Chunk[], focusedChunkId: string | null): SlideCommandTarget {
  const slides = groupSlides(chunks);
  const index = currentSlideIndex(slides, focusedChunkId, null);
  const hasFocus = slides.some((s) => s.items.some((c) => c.id === focusedChunkId));
  const current = hasFocus ? slides[index] : undefined;
  const heading = current ? headingOf(current) : undefined;
  const focusedAt = current ? current.items.findIndex((c) => c.id === focusedChunkId) : -1;
  return {
    slides,
    index,
    current,
    canDuplicate: !!heading,
    mergeHeadingId: index > 0 && heading ? heading.id : null,
    splitAt:
      current && focusedAt > 0 && current.items[focusedAt].metadata.chunkType !== "heading"
        ? current.items[focusedAt].id
        : null,
    layoutHostId: current ? layoutHost(current)?.id : undefined,
    textIds: current ? current.items.filter((c) => c.metadata.chunkType === "text").map((c) => c.id) : [],
    detached: current ? isSlideDetached(current) : false,
  };
}
