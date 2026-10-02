// Raw-source guards for the wave-5 UI-polish pass over the status surfaces:
// FindBar, HealthBar (+ its popovers), NetworkPanel and DiffPanel. There is no
// DOM in this suite, so each guard extracts the one element under test and
// asserts on it (testing.md #2), never on the whole file.

import { describe, expect, it } from "vitest";
import { JA } from "./i18n";

const SOURCES = import.meta.glob(
  [
    "./components/FindBar.tsx",
    "./components/HealthBar.tsx",
    "./components/NetworkPanel.tsx",
    "./components/DiffPanel.tsx",
  ],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;

function src(name: string): string {
  const s = SOURCES[`./components/${name}.tsx`];
  expect(s, `${name} not found`).toBeTruthy();
  return s;
}

/** The whole `<button …>…</button>` element that contains `marker`. */
function buttonAround(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const start = source.lastIndexOf("<button", at);
  const end = source.indexOf("</button>", at);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(at);
  return source.slice(start, end);
}

/** Every `<button …>…</button>` element in a source, with the text just before it. */
function buttons(source: string): { before: string; el: string }[] {
  const out: { before: string; el: string }[] = [];
  let at = source.indexOf("<button");
  while (at >= 0) {
    const end = source.indexOf("</button>", at);
    out.push({ before: source.slice(Math.max(0, at - 120), at), el: source.slice(at, end) });
    at = source.indexOf("<button", end);
  }
  return out;
}

describe("ui.md #1: an icon-only button has a tooltip as well as an accessible name", () => {
  it("the scanner sees a button with aria-label and no tooltip", () => {
    const bad = '<button aria-label={t("Close")}>×</button>';
    const good = '<Tooltip label={t("Close")}>\n<button aria-label={t("Close")}>×</button>';
    const missing = (s: string) =>
      buttons(s).filter((b) => b.el.includes("aria-label=") && !b.el.includes("title=") && !b.before.includes("<Tooltip"));
    expect(missing(bad)).toHaveLength(1);
    expect(missing(good)).toHaveLength(0);
  });

  for (const name of ["FindBar", "HealthBar", "NetworkPanel", "DiffPanel"]) {
    it(`${name}: every aria-labelled button also has title= or a <Tooltip>`, () => {
      const missing = buttons(src(name))
        .filter((b) => b.el.includes("aria-label=") && !b.el.includes("title=") && !b.before.includes("<Tooltip"))
        .map((b) => b.el.slice(0, 120));
      expect(missing, name).toEqual([]);
    });
  }
});

describe("FindBar replace disclosure", () => {
  it("names the action it will take: Hide replace while expanded, Show replace while collapsed", () => {
    const button = buttonAround(src("FindBar"), "aria-expanded={find.mode === \"replace\"}");
    expect(button).toMatch(
      /aria-label=\{find\.mode === "replace" \? t\("Hide replace"\) : t\("Show replace \(⌥⌘F\)"\)\}/
    );
    const bar = src("FindBar");
    const tip = bar.slice(bar.lastIndexOf("<Tooltip", bar.indexOf("aria-expanded={find.mode")), bar.indexOf("aria-expanded={find.mode"));
    expect(tip).toMatch(/label=\{find\.mode === "replace" \? t\("Hide replace"\) : t\("Show replace \(⌥⌘F\)"\)\}/);
    expect(JA["Hide replace"]).toBe("置換を隠す");
  });
});

describe("HealthBar popovers", () => {
  it("the changes panel and the export report share an anchor, so opening one closes the other", () => {
    const hb = src("HealthBar");
    // Any entry point (bar, toolbar, palette) that opens the changes panel closes the report.
    expect(hb).toMatch(/useEffect\(\(\) => \{\s*if \(diffPanelOpen\) setShowWarnings\(false\);\s*\}, \[diffPanelOpen\]\);/);
    const report = buttonAround(hb, 't("Details of the most recent export")');
    expect(report).toMatch(/onClick=\{\(\) => \{\s*toggleDiffPanel\(false\);\s*setShowWarnings\(\(v\) => !v\);\s*\}\}/);
  });

  it("each popover toggle states whether its popover is open", () => {
    const hb = src("HealthBar");
    expect(buttonAround(hb, "<HistoryIcon")).toContain("aria-expanded={diffPanelOpen}");
    expect(buttonAround(hb, 't("Details of the most recent export")')).toContain("aria-expanded={showWarnings}");
    expect(buttonAround(hb, "setShowCharLimit((v) => !v)")).toContain("aria-expanded={showCharLimit}");
  });
});

describe("HealthBar labels never wrap inside the 28px strip (CJK breaks per character)", () => {
  it("every status item is nowrap; the informational ones shrink with an ellipsis instead", () => {
    const hb = src("HealthBar");
    const item = hb.match(/const item = "([^"]+)";/);
    expect(item).not.toBeNull();
    expect(item![1].split(" ")).toEqual(expect.arrayContaining(["whitespace-nowrap", "shrink-0"]));
    const shrink = hb.match(/const shrinkItem = "([^"]+)";/);
    expect(shrink).not.toBeNull();
    expect(shrink![1].split(" ")).toEqual(expect.arrayContaining(["whitespace-nowrap", "min-w-0"]));
    // The length label and the network counters are the ones that give way.
    const lengthAt = hb.indexOf("{formatLengthLabel(textStats, chunks.length, lang)}");
    expect(hb.slice(hb.lastIndexOf("<span", lengthAt), lengthAt)).toContain('className="truncate"');
    expect(hb.slice(hb.lastIndexOf("<span\n", lengthAt), lengthAt)).toContain("className={shrinkItem}");
    const netAt = hb.indexOf("`外部通信: AI");
    expect(hb.slice(hb.lastIndexOf("<span", netAt), netAt)).toContain('className="truncate"');
    expect(hb.slice(hb.lastIndexOf("<span\n", netAt), netAt)).toContain("className={shrinkItem}");
  });
});

describe("NetworkPanel controls and op log", () => {
  it("Re-layout looks disabled when it is disabled", () => {
    const button = buttonAround(src("NetworkPanel"), 't("Re-layout")}');
    expect(button).toContain("disabled={isEmpty}");
    expect(button).toMatch(/className="[^"]*\bdisabled:opacity-40\b[^"]*"/);
    expect(button).toMatch(/className="[^"]*\bdisabled:hover:bg-transparent\b[^"]*"/);
  });

  it("op-log times follow the UI language (no AM/PM in the Japanese UI)", () => {
    const np = src("NetworkPanel");
    const at = np.indexOf("toLocaleTimeString(");
    expect(at).toBeGreaterThan(-1);
    expect(np.slice(at, np.indexOf(")}", at))).toBe('toLocaleTimeString(lang === "ja" ? "ja-JP" : undefined');
  });

  it("op-log borders use the chrome line/edge tokens, not the ink text tier", () => {
    const np = src("NetworkPanel");
    const log = np.slice(np.indexOf("function AiOpLogSection("), np.indexOf("export default function NetworkPanel"));
    expect(log).not.toMatch(/border-ink-faint/);
    expect(log).toMatch(/<details className="border-t border-chrome-line/);
  });
});
