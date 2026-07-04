// Pure slide-derivation helpers shared by the Slide editor and its tests.
//
// IMPORTANT: these MUST mirror the Rust deck derivation in
// `src-tauri/src/deck.rs` (document_to_deck) and the PPTX writer in `pptx.rs`,
// so the on-screen preview/Present and the exported .pptx agree (the bug report's
// ROOT: "deck derivation implemented twice"). Each function notes the deck.rs
// rule it mirrors. Keep them in sync when either side changes. In particular:
// an empty-string layout override counts as NO override (deck.rs filters it);
// `slideImages`/`splitImageRegion` mirror the pptx.rs multi-image grid contract
// (same visuals ordering, cell split and gap); and `slideOverflows` ports the
// pptx.rs A7 overflow heuristic (same thresholds).

import type { Chunk, SlideLayout } from "./types";

export interface SlideGroup {
  /** The chunks on this slide, in document order (heading first when present). */
  items: Chunk[];
  /** Each item's index in the flat document chunk list (for editing). */
  indices: number[];
}

/**
 * Group the flat chunk list into slides — a new slide begins at each heading.
 * Content before the first heading forms a leading slide with NO heading chunk
 * (its title is the document title; see `slideTitle`). Mirrors deck.rs, which
 * synthesises a doc-title heading for that leading content.
 */
export function groupSlides(chunks: Chunk[]): SlideGroup[] {
  const slides: SlideGroup[] = [];
  let cur: SlideGroup | null = null;
  chunks.forEach((c, i) => {
    if (c.metadata.chunkType === "heading") {
      if (cur) slides.push(cur);
      cur = { items: [c], indices: [i] };
    } else {
      if (!cur) cur = { items: [], indices: [] };
      cur.items.push(c);
      cur.indices.push(i);
    }
  });
  if (cur) slides.push(cur);
  return slides;
}

/** The heading chunk that titles this slide, if any (always items[0] when present). */
export function headingOf(s: SlideGroup): Chunk | undefined {
  return s.items.find((c) => c.metadata.chunkType === "heading");
}

/**
 * Auto-pick a layout from a slide's content. Mirrors deck.rs exactly: an image →
 * "title-image"; no body chunks → "section"; otherwise "title-content".
 * "body" = non-heading chunks (deck.rs counts the same way). "title-image-left"
 * and "image-top" are never auto-picked — they're manual-choice only, set via
 * an explicit layout override (see `resolveLayout`/`hasLayoutOverride`).
 */
export function autoLayout(items: Chunk[]): SlideLayout {
  const hasImage = items.some((c) => c.metadata.chunkType === "image");
  const body = items.filter((c) => c.metadata.chunkType !== "heading").length;
  if (hasImage) return "title-image";
  if (body === 0) return "section";
  return "title-content";
}

/**
 * The chunk that carries this slide's layout override: its heading if it has
 * one, otherwise its first chunk — so a heading-less (leading) slide can still
 * have a layout applied. Mirrors `deck.rs`, which reads the first override found.
 */
export function layoutHost(s: SlideGroup): Chunk | undefined {
  return headingOf(s) ?? s.items[0];
}

/** An empty-string layout counts as NO override (parity with deck.rs, which filters empty). */
function isLayoutOverride(c: Chunk): boolean {
  return !!c.metadata.layout && c.metadata.layout.trim() !== "";
}

/**
 * The effective layout: an explicit override (on the heading OR, for a
 * heading-less slide, any chunk) wins; else auto-pick from content. Takes the
 * first NON-EMPTY override found so it matches `deck.rs`'s filtered `find_map`
 * (an empty string reads as auto on both sides).
 */
export function resolveLayout(s: SlideGroup): SlideLayout {
  const override = s.items.find(isLayoutOverride)?.metadata.layout;
  return override ?? autoLayout(s.items);
}

/**
 * Whether this slide has an explicit layout override set (vs. showing an
 * auto-picked layout that tracks its content). Drives the layout picker's
 * "Auto" state — without this there was no way back to auto once a layout had
 * been chosen once (the layout function's reported "fragility").
 */
export function hasLayoutOverride(s: SlideGroup): boolean {
  return s.items.some(isLayoutOverride);
}

/**
 * The slide title. Mirrors deck.rs: a heading slide uses the heading text; a
 * heading-less (leading) slide uses the DOCUMENT title — NOT its first paragraph
 * (which stays a bullet). This removes the old double-display where the first
 * paragraph appeared as both title and bullet (D2).
 */
export function slideTitle(s: SlideGroup, docTitle: string): string {
  const h = headingOf(s);
  return (h ? h.content : docTitle).trim();
}

/**
 * The lead chunk of a slide (heading, else first chunk) — where slide-level
 * overrides (layout, slideBody) live. Same host as `layoutHost`.
 */
export function slideLead(s: SlideGroup): Chunk | undefined {
  return headingOf(s) ?? s.items[0];
}

/**
 * The slide's explicit subtitle line, if a text chunk on it is flagged
 * `subtitle` (Req 3). Returns undefined when there's no explicit subtitle (the
 * section layout then falls back to the first bullet, matching AI Draft's
 * positional behaviour).
 */
export function slideSubtitle(s: SlideGroup): string | undefined {
  const sub = s.items.find(
    (c) => c.metadata.chunkType === "text" && c.metadata.subtitle
  );
  const text = sub?.content.trim();
  return text ? text : undefined;
}

/**
 * The slide's bullet lines. When the slide is "detached" (its lead chunk carries
 * a `slideBody`), those custom/summarised lines are used instead of the linked
 * editor paragraphs (Req 2). Otherwise every non-subtitle text chunk is a bullet
 * (deck.rs makes every non-heading paragraph a bullet; D2); an explicit subtitle
 * chunk (Req 3) is excluded since it renders in the subtitle box.
 */
export function slideBullets(s: SlideGroup): string[] {
  const override = slideLead(s)?.metadata.slideBody;
  if (override) return override.map((b) => b.trim()).filter(Boolean);
  return s.items
    .filter((c) => c.metadata.chunkType === "text" && !c.metadata.subtitle)
    .map((c) => c.content.trim())
    .filter(Boolean);
}

/** True if this slide is "detached" — showing custom slideBody, not the prose (Req 2). */
export function isSlideDetached(s: SlideGroup): boolean {
  return slideLead(s)?.metadata.slideBody !== undefined;
}

/** Max visuals a slide layout renders — extras are counted/warned (mirrors pptx.rs). */
export const MAX_SLIDE_IMAGES = 6;

/**
 * A slide's ordered visuals for the PREVIEW: its image chunks with non-empty
 * content, sorted by `metadata.slot` (lower renders first; slot-less last) with
 * ties broken by document order. Diagram chunks carrying a rendered PNG
 * (`metadata.renderedImage`) are EXPORT-only visuals — the export path injects
 * them and pptx.rs merges them under the same ordering rule, so they are not in
 * this list. Mirrors the pptx.rs multi-image grid contract.
 */
export function slideImages(s: SlideGroup): Chunk[] {
  const slot = (c: Chunk) => c.metadata.slot ?? Number.MAX_SAFE_INTEGER;
  return s.items
    .filter((c) => c.metadata.chunkType === "image" && c.content.trim() !== "")
    .sort((a, b) => slot(a) - slot(b)); // stable sort → ties keep document order
}

/** The slide's FIRST visual's content (compatibility first-of over `slideImages`). */
export function slideImage(s: SlideGroup): string | undefined {
  return slideImages(s)[0]?.content;
}

/** One cell of an image-region grid, as fractions (0..1) of the region. */
export interface RegionCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Subdivide a layout's image region into `n` cells (capped at
 * MAX_SLIDE_IMAGES), returned as GAPLESS fraction rects (0..1 of the region,
 * row-major). The column regions (title-image / title-image-left) stack 2 rows,
 * then a 2×2 grid, then 2 cols × 3 rows; the top band (image-top) goes
 * side-by-side at 2, 2×2 at 3–4, then 3 cols × 2 rows. Mirrors the pptx.rs
 * grid contract EXACTLY. Consumers apply the fixed cell gap (12px in the
 * 1280×720 preview frame; 114300 EMU in pptx.rs) with
 * pos = f·(size+gap), extent = f·(size+gap)−gap — which reproduces an even
 * columns×rows split with the gap between cells. Layouts without an image
 * region return no cells.
 */
export function splitImageRegion(layout: SlideLayout, n: number): RegionCell[] {
  const topBand = layout === "image-top";
  const column = layout === "title-image" || layout === "title-image-left";
  if (n <= 0 || (!topBand && !column)) return [];
  const count = Math.min(n, MAX_SLIDE_IMAGES);
  let cols: number;
  let rows: number;
  if (count === 1) [cols, rows] = [1, 1];
  else if (count === 2) [cols, rows] = topBand ? [2, 1] : [1, 2];
  else if (count <= 4) [cols, rows] = [2, 2];
  else [cols, rows] = topBand ? [3, 2] : [2, 3];
  const cells: RegionCell[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols; // row-major fill
    const row = Math.floor(i / cols);
    cells.push({ x: col / cols, y: row / rows, w: 1 / cols, h: 1 / rows });
  }
  return cells;
}

/** Diagram chunks on the slide (rendered as a placeholder; not yet in .pptx) (D3). */
export function slideDiagrams(s: SlideGroup): Chunk[] {
  return s.items.filter((c) => c.metadata.chunkType === "diagram");
}

// pptx.rs geometry (EMU) that the overflow heuristic depends on — keep these in
// sync with the constants of the same names in pptx.rs.
const PPTX_SLIDE_H = 6_858_000;
const PPTX_BODY_Y = 1_600_200;
const PPTX_MARGIN = 685_800;
const PPTX_SUBTITLE_H = 700_000;

/**
 * Estimate whether a slide's bullets overflow its body box — the char-count
 * heuristic PORTED from pptx.rs (build_slide's A7 overflow check; same
 * chars-per-line and max-line thresholds, including the subtitle-box height
 * scaling). Keep the two in sync. Drives the rail's "may overflow" badge so the
 * user can split the slide BEFORE exporting a clipped .pptx.
 */
export function slideOverflows(s: SlideGroup): boolean {
  const layout = resolveLayout(s);
  if (layout === "section") return false;
  // An image layout only uses its narrower/shorter budget when a visual really
  // shows (pptx.rs falls back to full width otherwise).
  const hasImage = slideImages(s).length > 0;
  const [cpl, baseMaxLines] =
    (layout === "title-image" || layout === "title-image-left") && hasImage
      ? [60, 14]
      : layout === "image-top" && hasImage
        ? [110, 6]
        : [110, 14];
  // A subtitle box shrinks the bullets' available height proportionally.
  const baseAvail = PPTX_SLIDE_H - PPTX_BODY_Y - PPTX_MARGIN;
  const avail = baseAvail - (slideSubtitle(s) ? PPTX_SUBTITLE_H : 0);
  const maxLines = Math.max(1, Math.floor((baseMaxLines * avail) / baseAvail));
  const lines = slideBullets(s).reduce(
    (sum, t) => sum + Math.max(1, Math.ceil([...t].length / cpl)),
    0
  );
  return lines > maxLines;
}

/**
 * Per-chunk in-slide move capability (B2). A slide is a contiguous run, so moving
 * a non-boundary BODY chunk swaps it with an in-slide neighbour; the heading is
 * pinned (reorder slides via the rail) and the body can't cross the slide edges.
 * Returns whether the chunk at slide-position `pos` can move up/down within the
 * slide.
 */
export function slideMoveBounds(
  items: Chunk[],
  pos: number
): { canUp: boolean; canDown: boolean } {
  const isHeading = items[pos]?.metadata.chunkType === "heading";
  if (isHeading) return { canUp: false, canDown: false };
  const hasHeading = items[0]?.metadata.chunkType === "heading";
  const bodyStart = hasHeading ? 1 : 0;
  return {
    canUp: pos > bodyStart,
    canDown: pos < items.length - 1,
  };
}
