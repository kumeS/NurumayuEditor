import { describe, expect, it } from "vitest";
import { tags } from "@lezer/highlight";
import { markdownSourceHighlightStyle, markdownSourceThemeSpec } from "./markdownSourceTheme";

// BUG-008: the Markdown source editor (CodeMirror) must not underline
// headings, paint a heavy active-line wash, or keep a strong selection tint
// after blur — together they made dense CJK look painted over. Colours come
// from CSS tokens only (ui.md #9). WebKit glyph rendering itself is verified
// manually; these tests pin the style data and its wiring.

function rawFile(glob: Record<string, unknown>, label: string): string {
  const values = Object.values(glob);
  expect(values, `expected exactly one match for ${label}`).toHaveLength(1);
  expect(typeof values[0]).toBe("string");
  return values[0] as string;
}

const css = rawFile(
  import.meta.glob("./index.css", { eager: true, query: "?raw", import: "default" }),
  "index.css"
);
const rootBlock = (() => {
  const m = css.match(/:root\s*\{([^}]*)\}/);
  expect(m, ":root block in index.css").not.toBeNull();
  return m![1];
})();
const editorSource = rawFile(
  import.meta.glob("./components/MarkdownEditor.tsx", { eager: true, query: "?raw", import: "default" }),
  "components/MarkdownEditor.tsx"
);
const tailwindConfig = rawFile(
  import.meta.glob("../tailwind.config.js", { eager: true, query: "?raw", import: "default" }),
  "tailwind.config.js"
);

type Spec = (typeof markdownSourceHighlightStyle.specs)[number];
function specsFor(tag: unknown): Spec[] {
  return markdownSourceHighlightStyle.specs.filter((s) => [s.tag].flat().includes(tag as never));
}
function rootToken(name: string): string {
  const m = rootBlock.match(new RegExp(`--${name}:\\s*([^;]+);`));
  expect(m, `--${name} is defined in :root`).not.toBeNull();
  return m![1].trim();
}
function rgba(value: string): { rgb: number[]; alpha: number } {
  const m = value.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/);
  expect(m, `${value} is an rgba() literal`).not.toBeNull();
  return { rgb: [Number(m![1]), Number(m![2]), Number(m![3])], alpha: Number(m![4]) };
}
function styleValues(spec: Record<string, unknown>): string[] {
  return Object.values(spec).flatMap((v) =>
    typeof v === "object" && v !== null ? styleValues(v as Record<string, unknown>) : [String(v)]
  );
}
const highlightValues = markdownSourceHighlightStyle.specs.flatMap(({ tag: _tag, ...rest }) => styleValues(rest));
const themeValues = styleValues(markdownSourceThemeSpec);

describe("markdownSourceHighlightStyle", () => {
  it("does not underline headings; they are semibold ink", () => {
    const heading = specsFor(tags.heading);
    expect(heading).toHaveLength(1);
    expect(String(heading[0].textDecoration ?? "none")).not.toMatch(/underline/);
    expect(heading[0].fontWeight).toBe("600");
    expect(heading[0].color).toBe("var(--color-ink)");
  });

  it("does not underline links; they use the accent token", () => {
    const link = specsFor(tags.link);
    expect(link).toHaveLength(1);
    expect(String(link[0].textDecoration ?? "none")).not.toMatch(/underline/);
    expect(link[0].color).toBe("var(--color-accent)");
  });

  it("underlines nothing at all (module promise)", () => {
    for (const value of highlightValues) expect(value).not.toMatch(/underline/);
  });

  it("fades Markdown markers (#, *, [], ```) to the faint ink token", () => {
    const marker = specsFor(tags.processingInstruction);
    expect(marker).toHaveLength(1);
    expect(marker[0].color).toBe("var(--color-ink-faint)");
  });
});

describe("colours come from CSS tokens only (ui.md #9)", () => {
  it("has no hex or rgb() literals in the highlight style or the theme", () => {
    for (const value of [...highlightValues, ...themeValues]) {
      expect(value).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });

  it("every var(--color-…) it references is defined in index.css :root", () => {
    const used = new Set(
      [...highlightValues, ...themeValues].flatMap((v) => [...v.matchAll(/var\(--(color-[\w-]+)\)/g)].map((m) => m[1]))
    );
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) rootToken(name);
  });

  it("derives --color-accent from tailwind's accent instead of a second hex", () => {
    expect(rootToken("color-accent")).toBe('theme("colors.accent.DEFAULT")');
  });

  it("accent-tinted rgba tokens use tailwind's accent channels", () => {
    const accentBlock = tailwindConfig.match(/accent:\s*\{([^}]*)\}/);
    expect(accentBlock).not.toBeNull();
    const hex = accentBlock![1].match(/DEFAULT:\s*"#([0-9a-f]{6})"/i);
    expect(hex).not.toBeNull();
    const accent = [0, 2, 4].map((i) => parseInt(hex![1].slice(i, i + 2), 16));
    for (const name of ["color-accent-wash", "color-selection", "color-active-line"]) {
      expect(rgba(rootToken(name)).rgb, name).toEqual(accent);
    }
  });
});

describe("markdownSourceThemeSpec — active line and selection", () => {
  it("paints the active line with a faint dedicated token, fainter than the accent wash", () => {
    expect(markdownSourceThemeSpec[".cm-activeLine"]).toEqual({ backgroundColor: "var(--color-active-line)" });
    const activeLine = rgba(rootToken("color-active-line")).alpha;
    expect(activeLine).toBeLessThanOrEqual(0.04);
    expect(activeLine).toBeLessThan(rgba(rootToken("color-accent-wash")).alpha);
  });

  it("marks the active line in the gutter by ink, not a fill", () => {
    expect(markdownSourceThemeSpec[".cm-activeLineGutter"]).toEqual({
      backgroundColor: "transparent",
      color: "var(--color-ink)",
    });
  });

  it("uses the full selection tint only while focused", () => {
    // Same selector shape as CodeMirror's base theme
    // ("&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground"),
    // so this theme wins on equal specificity + later mount order, without !important.
    expect(
      markdownSourceThemeSpec["&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground"]
    ).toEqual({ backgroundColor: "var(--color-selection)" });
  });

  it("shows a neutral, lighter selection when the editor is blurred", () => {
    expect(markdownSourceThemeSpec[".cm-selectionBackground"]).toEqual({
      backgroundColor: "var(--color-selection-inactive)",
    });
    const inactive = rgba(rootToken("color-selection-inactive"));
    const focused = rgba(rootToken("color-selection"));
    expect(inactive.rgb).not.toEqual(focused.rgb);
    expect(inactive.alpha).toBeLessThan(focused.alpha);
  });

  it("never forces a style with !important", () => {
    for (const value of themeValues) expect(value).not.toMatch(/!important/);
  });
});

describe("MarkdownEditor wiring (raw-source guard)", () => {
  it("no longer uses CodeMirror's defaultHighlightStyle", () => {
    expect(editorSource).not.toMatch(/defaultHighlightStyle/);
  });

  it("highlights with markdownSourceHighlightStyle and themes with the one shared spec", () => {
    expect(editorSource).toMatch(
      /import\s*\{\s*markdownSourceHighlightStyle,\s*markdownSourceThemeSpec\s*\}\s*from\s*"\.\.\/markdownSourceTheme";/
    );
    expect(editorSource).toMatch(/syntaxHighlighting\(markdownSourceHighlightStyle\)/);
    expect(editorSource.match(/EditorView\.theme\(/g)).toHaveLength(1);
    expect(editorSource).toMatch(/EditorView\.theme\(markdownSourceThemeSpec\)/);
  });
});
