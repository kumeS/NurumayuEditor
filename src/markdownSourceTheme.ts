// Styling for the Markdown source editor (CodeMirror): the syntax highlight
// style and the editor theme spec, as data so they are unit-testable in Node.
// MarkdownEditor.tsx wraps them with `syntaxHighlighting(...)` and
// `EditorView.theme(...)`.
//
// Constraints this module keeps (BUG-008):
// - Colours are CSS custom properties from index.css :root only — no hex
//   literals (ui.md #9). Tokens are recorded in docs/ai/04_design_tokens.md.
// - Nothing is underlined: a full-width underline under CJK glyphs, which fill
//   the em box, reads as strike-through.
// - The active line is a barely-there fill (--color-active-line); the gutter
//   number carries the cue in ink.
// - Selection is the accent tint only while focused; a blurred editor shows a
//   neutral, lighter tint (--color-selection-inactive).
// - No `!important`: selection rules copy the selector shape of CodeMirror's
//   base theme, so this theme wins on equal specificity because CodeMirror
//   mounts editor themes after its base theme.
// Known limit: light values only — the app declares `color-scheme: light`.

import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const markdownSourceHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600", color: "var(--color-ink)" },
  { tag: tags.link, color: "var(--color-accent)" },
  { tag: tags.url, color: "var(--color-ink-faint)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  // Markdown syntax marks: # heading marks, * _ emphasis marks, [] () link
  // marks, ``` fences, > quote marks, list bullets, --- rules.
  {
    tag: [tags.processingInstruction, tags.meta, tags.contentSeparator],
    color: "var(--color-ink-faint)",
  },
]);

/** A CodeMirror theme spec (selector → style), passed to `EditorView.theme`. */
export const markdownSourceThemeSpec: Record<string, Record<string, string>> = {
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--color-ink)",
    fontSize: "var(--editor-font-size, 17px)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-content-mono)",
    lineHeight: "1.75",
    padding: "28px 0 56px",
  },
  ".cm-content": { maxWidth: "52rem", margin: "0 auto", padding: "0 32px" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--color-ink-faint)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "var(--color-active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-ink)" },
  ".cm-selectionBackground": { backgroundColor: "var(--color-selection-inactive)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--color-selection)",
  },
  "&.cm-focused": { outline: "none" },
};
