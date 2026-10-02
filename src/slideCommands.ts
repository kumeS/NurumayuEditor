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
// Known limit: the Edit/Preview slide-view switch is SlideEditor-local state,
// so it has no palette entry.

import { groupSlides, headingOf, layoutHost, isSlideDetached, type SlideGroup } from "./slides";
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
