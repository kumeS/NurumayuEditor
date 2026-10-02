import { describe, expect, it } from "vitest";

// ui.md rule 9: components use semantic colour tokens (ink / accent / chrome /
// warn / danger / ok / additive / removed), never raw Tailwind scales, so the
// palette changes in tailwind.config.js alone. src/healthBarWiring.test.ts
// guards HealthBar, OpenRouterModelCatalog and NetworkPanel; this file guards
// the next four surfaces migrated in w4-polish.
//
// Allow-list: intentionally empty. The slide canvas's export-parity palette
// (SlideEditor's SLIDE_CODE_BG, the ink/soft/accent consts in the slide stage,
// the missing-image placeholder's inline border/colour) is written as inline
// hex in style objects so it matches the PPTX exporter byte for byte; the
// class regex below never matches it, and this migration did not touch it.
const SOURCES = import.meta.glob(
  [
    "./components/TabBar.tsx",
    "./components/Toolbar.tsx",
    "./components/DiffPanel.tsx",
    "./components/SlideEditor.tsx",
    "../tailwind.config.js",
  ],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;

function src(path: string): string {
  const s = SOURCES[path];
  expect(s, `${path} not found`).toBeTruthy();
  return s;
}

const RAW_SCALE = /\b(?:gray|slate|zinc|neutral|red|amber|emerald|green|blue|yellow)-\d+/g;
const ALLOWED_RAW: ReadonlySet<string> = new Set();

describe("semantic colour tokens in TabBar / Toolbar / DiffPanel / SlideEditor (ui.md rule 9)", () => {
  it("the regex sees a raw scale class and ignores token classes", () => {
    const sample = 'className="border-gray-200 hover:bg-emerald-50/70 text-warn-strong bg-chrome-line"';
    expect(sample.match(RAW_SCALE)).toEqual(["gray-200", "emerald-50"]);
  });

  for (const f of ["TabBar", "Toolbar", "DiffPanel", "SlideEditor"]) {
    it(`${f}.tsx uses no raw gray/red/amber/emerald/… scale class`, () => {
      const raw = (src(`./components/${f}.tsx`).match(RAW_SCALE) ?? []).filter(
        (c) => !ALLOWED_RAW.has(c)
      );
      expect(raw, f).toEqual([]);
    });
  }

  it("tailwind.config.js defines the chrome edge and the diff additive/removed tokens", () => {
    const tw = src("../tailwind.config.js");
    for (const token of ["additive", "removed"]) {
      const block = tw.match(new RegExp(`\\b${token}: \\{([^}]*)\\}`));
      expect(block, token).not.toBeNull();
      for (const shade of ["DEFAULT", "mark", "wash"]) {
        expect(block![1], `${token}.${shade}`).toMatch(new RegExp(`\\b${shade}: "#[0-9a-f]{6}"`));
      }
    }
    const chrome = tw.match(/\bchrome: \{([^}]*)\}/);
    expect(chrome).not.toBeNull();
    expect(chrome![1]).toMatch(/\bedge: "#[0-9a-f]{6}"/);
  });

  it("DiffPanel colours added/removed/changed rows with the diff tokens, not the error token", () => {
    const dp = src("./components/DiffPanel.tsx");
    expect(dp).toContain("bg-additive-mark");
    expect(dp).toContain("bg-removed-mark");
    expect(dp).toContain("text-additive");
    expect(dp).toContain("text-removed");
  });
});
