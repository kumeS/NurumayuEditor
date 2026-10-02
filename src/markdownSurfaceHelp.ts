// Copy for the Markdown editor's toolbar.
//
// Constraints:
// - Pure: returns dictionary keys (English copy); the component translates
//   them with t(), and markdownSurfaceHelp.test.ts checks every key has JA.
// - The helper line describes the CURRENT surface (MISS-08), so Source, Split
//   and Preview never share one ambiguous sentence.
// - PREVIEW_SCOPE_NOTE is a claim: preview zoom is app-level store state and
//   the preview background is a setting, so both apply to every Markdown
//   document. The test asserts that behaviour alongside the copy.

export type MarkdownSurface = "edit" | "split" | "preview";

export const MARKDOWN_SURFACES: readonly MarkdownSurface[] = ["edit", "split", "preview"];

/** The toolbar helper sentence (a dictionary key) for one editing surface. */
export function helperFor(surface: MarkdownSurface): string {
  switch (surface) {
    case "edit":
      return "Editing Markdown source.";
    case "split":
      return "Left: source · Right: preview (click text to edit).";
    case "preview":
      return "Click text to edit it directly; switch to Edit for the full Markdown source.";
  }
}

/** Appended to the zoom and background tooltips (MISS-07). */
export const PREVIEW_SCOPE_NOTE = "Applies to all Markdown documents";
