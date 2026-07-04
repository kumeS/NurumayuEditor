// Editor font selection (提案5 accessibility / "フォント選択"). The family
// stacks mirror tailwind.config.js (serif/sans) plus a monospace option; the
// chosen family+size apply to the writing surface (ChunkView) as inline style
// so they follow Settings without a Tailwind rebuild.

import type { CSSProperties } from "react";
import type { Settings } from "./types";

export type EditorFontFamily = "serif" | "sans" | "mono";

export const FONT_STACKS: Record<EditorFontFamily, string> = {
  serif: 'Georgia, Charter, Cambria, "Times New Roman", serif',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Hiragino Kaku Gothic ProN", monospace',
};

export const DEFAULT_FONT_FAMILY: EditorFontFamily = "serif";
export const DEFAULT_FONT_SIZE = 17;

function familyOf(settings: Settings | null | undefined): EditorFontFamily {
  const f = settings?.editorFontFamily;
  return f === "sans" || f === "mono" ? f : DEFAULT_FONT_FAMILY;
}

function sizeOf(settings: Settings | null | undefined): number {
  const n = settings?.editorFontSize;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_FONT_SIZE;
  return Math.min(28, Math.max(12, Math.round(n)));
}

/** Inline style for body-paragraph textareas (family + size + line height). */
export function editorBodyFontStyle(
  settings: Settings | null | undefined
): CSSProperties {
  return {
    fontFamily: FONT_STACKS[familyOf(settings)],
    fontSize: `${sizeOf(settings)}px`,
    // ~1.85 reproduces the previous fixed leading-8 (32px) at the default 17px
    // and scales sensibly for larger accessibility sizes.
    lineHeight: 1.85,
  };
}

/** Inline style for headings: family follows the setting, size stays per-level. */
export function editorHeadingFontStyle(
  settings: Settings | null | undefined
): CSSProperties {
  return { fontFamily: FONT_STACKS[familyOf(settings)] };
}
