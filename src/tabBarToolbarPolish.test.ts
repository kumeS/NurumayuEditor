import { describe, expect, it } from "vitest";
import { translate } from "./i18n";

// p-toolbar (ui-polish wave 5): wiring guards for the TabBar and Toolbar
// polish fixes. vitest runs without a DOM, so each guard slices the specific
// element out of the component source and asserts on that slice only.

const raw = import.meta.glob(["./components/TabBar.tsx", "./components/Toolbar.tsx"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const tabBar = raw["./components/TabBar.tsx"];
const toolbar = raw["./components/Toolbar.tsx"];

/** Slice from `start` up to the first `end` after it (fails if absent). */
function slice(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `missing ${end} after ${start}`).toBeGreaterThan(i);
  return src.slice(i, j + end.length);
}

/** The whole `<button …>…</button>` element containing `marker`. */
function buttonAround(src: string, marker: string): string {
  const at = src.indexOf(marker);
  expect(at, `missing ${marker}`).toBeGreaterThanOrEqual(0);
  const open = src.lastIndexOf("<button", at);
  return src.slice(open, src.indexOf("</button>", at) + "</button>".length);
}

describe("TabBar polish", () => {
  it("the close X is always visible, not revealed on hover (BUG-018: the X must not vanish)", () => {
    const close = buttonAround(tabBar, "onClick={() => void onClose(id)}");
    expect(close).not.toMatch(/\bopacity-0\b/);
    expect(close).not.toMatch(/group-hover:opacity/);
  });

  it("the unsaved marker sits outside the truncating title, so a long title cannot clip it", () => {
    const title = slice(tabBar, '<span className="truncate">', "</span>");
    expect(title).not.toMatch(/dirtyOf\(/);
    const switchBtn = buttonAround(tabBar, "onClick={() => switchTab(id)}");
    const dirty = slice(switchBtn, "{dirtyOf(id) && (", ")}\n");
    expect(dirty).toMatch(/shrink-0/);
    expect(dirty).toMatch(/bg-warn-dot/);
  });

  it("the unsaved marker has a translated accessible name", () => {
    const switchBtn = buttonAround(tabBar, "onClick={() => switchTab(id)}");
    const dirty = slice(switchBtn, "{dirtyOf(id) && (", ")}\n");
    expect(dirty).toMatch(/<span className="sr-only">\{t\("Unsaved changes"\)\}<\/span>/);
    expect(translate("Unsaved changes", "ja")).not.toBe("Unsaved changes");
  });

  it("the tab switch button keeps a visible keyboard focus indicator and exposes the active tab", () => {
    const open = slice(tabBar, "onClick={() => switchTab(id)}", ">\n");
    expect(open).toMatch(/focus-visible:ring-1 focus-visible:ring-accent/);
    expect(open).toMatch(/aria-current=\{isActive \? "page" : undefined\}/);
  });

  it("the MD glyph in the tab mode icon is hidden from assistive tech", () => {
    const md = slice(tabBar, 'mode === "markdown" ? (', "</span>");
    expect(md).toMatch(/aria-hidden="true"/);
  });
});

describe("Toolbar polish", () => {
  it("the mode segment exposes the active mode as pressed, not by colour alone", () => {
    const seg = buttonAround(toolbar, "onClick={() => setMode(m)}");
    expect(seg).toMatch(/aria-pressed=\{mode === m\}/);
    const md = slice(seg, '<span className="font-mono', "</span>");
    expect(md).toMatch(/aria-hidden="true"/);
  });

  it("shortcut glyphs use the macOS modifier order (⇧ before ⌘), matching ⇧⌘S", () => {
    expect(toolbar).not.toContain("⌘⇧");
    expect(buttonAround(toolbar, "onClick={onOpenFolder}")).toMatch(/<span[^>]*>⇧⌘O<\/span>/);
    const title = slice(toolbar, 'title={t("Open a file', '")}');
    const key = title.slice('title={t("'.length, -'")}'.length);
    expect(translate(key, "ja")).toContain("⇧⌘O");
  });

  it("the palette's Open Folder entry is findable by the glyph the toolbar shows (⇧⌘O)", () => {
    const palette = (
      import.meta.glob("./components/CommandPalette.tsx", { eager: true, query: "?raw", import: "default" }) as Record<
        string,
        string
      >
    )["./components/CommandPalette.tsx"];
    const entry = slice(palette, 'id: "open-folder"', "run:");
    expect(entry).toMatch(/keywords: "[^"]*⇧⌘O[^"]*"/);
  });
});
