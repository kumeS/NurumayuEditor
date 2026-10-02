import { describe, expect, it } from "vitest";

// Wiring guards for BUG-011 / BUG-018. The behaviour lives in fileActions
// (requestCloseTab / resolveDirtyTabsForQuit, tested in fileActions.test.ts);
// these assert every UI entry point actually goes through it. Each guard is
// scoped to the code under test, not the whole file.

const raw = import.meta.glob(
  ["./components/TabBar.tsx", "./useShortcuts.ts", "./components/CommandPalette.tsx", "./App.tsx"],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;
const all = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.ts"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const tabBar = raw["./components/TabBar.tsx"];
const shortcuts = raw["./useShortcuts.ts"];
const palette = raw["./components/CommandPalette.tsx"];
const app = raw["./App.tsx"];

/** Slice from `start` up to the first `end` after it (throws if absent). */
function slice(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `missing ${end} after ${start}`).toBeGreaterThan(i);
  return src.slice(i, j);
}

/** The palette command object literal whose id is `id`. */
function paletteEntry(id: string): string {
  const i = palette.indexOf(`id: "${id}"`);
  expect(i, `palette entry ${id}`).toBeGreaterThanOrEqual(0);
  const open = palette.lastIndexOf("{", i);
  let depth = 0;
  for (let k = open; k < palette.length; k++) {
    if (palette[k] === "{") depth++;
    else if (palette[k] === "}" && --depth === 0) return palette.slice(open, k + 1);
  }
  throw new Error(`unterminated palette entry ${id}`);
}

describe("every close path goes through requestCloseTab", () => {
  it("TabBar's onClose calls requestCloseTab, not the store's closeTab", () => {
    const onClose = slice(tabBar, "const onClose", "};");
    expect(onClose).toMatch(/requestCloseTab\(id\)/);
    expect(tabBar).not.toMatch(/useStore\(\(s\) => s\.closeTab\)/);
  });

  it("TabBar always renders the close button (no tabOrder.length gate)", () => {
    expect(tabBar).not.toMatch(/tabOrder\.length\s*>/);
    const button = slice(tabBar, "onClick={() => void onClose(id)}", "</button>");
    expect(button).toMatch(/aria-label=\{t\("Close tab"\)\}/);
    expect(button).toMatch(/title=\{t\("Close tab"\)\}/);
  });

  it("⌘W closes the active tab via requestCloseTab, with no length guard", () => {
    const block = slice(shortcuts, 'case "close-tab":', "break;");
    expect(block).toMatch(/requestCloseTab\(useStore\.getState\(\)\.activeTabId\)/);
    expect(block).not.toMatch(/tabOrder\.length/);
  });

  it("the palette's Close tab is always visible and runs requestCloseTab", () => {
    const entry = paletteEntry("close-tab");
    expect(entry).toMatch(/requestCloseTab\(useStore\.getState\(\)\.activeTabId\)/);
    expect(entry).not.toMatch(/visible:/);
  });

  it("⌘Q reviews dirty tabs through resolveDirtyTabsForQuit", () => {
    const okToClose = slice(app, "async function okToClose", "\n}");
    expect(okToClose).toMatch(/resolveDirtyTabsForQuit\(\)/);
  });

  it("the two-button discard dialog is gone from every caller", () => {
    const offenders = Object.entries(all)
      .filter(([, src]) => /\bconfirmDiscard\b/.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

describe("palette reaches the OpenRouter model catalog (ui.md #3)", () => {
  it("has a Browse OpenRouter models… entry that opens Settings on the model catalog (ux-a11y-i18n-5)", () => {
    const entry = paletteEntry("browse-openrouter-models");
    expect(entry).toMatch(/t\("Browse OpenRouter models…"\)/);
    expect(entry).toMatch(/openSettings\("model-catalog"\)/);
  });
});
