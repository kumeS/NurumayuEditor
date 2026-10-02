import { describe, expect, it } from "vitest";
import { JA } from "./i18n";
import {
  NETWORK_LABEL_KEYS,
  RELATION_COLORS,
  analyzedLabel,
  relationLabel,
  relativeTime,
} from "./networkLabels";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const ago = (ms: number) => NOW - ms;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime — the NetworkPanel 'analyzed …' timestamp", () => {
  it("English: seconds, minutes, hours, days", () => {
    expect(relativeTime(ago(5 * SEC), "en", NOW)).toBe("5s ago");
    expect(relativeTime(ago(3 * MIN), "en", NOW)).toBe("3 min ago");
    expect(relativeTime(ago(2 * HOUR), "en", NOW)).toBe("2h ago");
    expect(relativeTime(ago(3 * DAY), "en", NOW)).toBe("3d ago");
  });

  it("Japanese: 秒前 / 分前 / 時間前 / 日前", () => {
    expect(relativeTime(ago(5 * SEC), "ja", NOW)).toBe("5秒前");
    expect(relativeTime(ago(3 * MIN), "ja", NOW)).toBe("3分前");
    expect(relativeTime(ago(2 * HOUR), "ja", NOW)).toBe("2時間前");
    expect(relativeTime(ago(3 * DAY), "ja", NOW)).toBe("3日前");
  });

  it("a timestamp in the future (clock skew) reads as 0 s, never negative", () => {
    expect(relativeTime(NOW + 10 * SEC, "en", NOW)).toBe("0s ago");
    expect(relativeTime(NOW + 10 * SEC, "ja", NOW)).toBe("0秒前");
  });

  it("past a week it falls back to a locale date (ja-JP in Japanese)", () => {
    const ts = ago(30 * DAY);
    expect(relativeTime(ts, "ja", NOW)).toBe(new Date(ts).toLocaleDateString("ja-JP"));
    expect(relativeTime(ts, "en", NOW)).toBe(new Date(ts).toLocaleDateString());
  });
});

describe("analyzedLabel — word order follows the language", () => {
  it("English puts the time after 'analyzed'", () => {
    expect(analyzedLabel(ago(3 * MIN), "en", NOW)).toBe("analyzed 3 min ago");
  });
  it("Japanese puts the time first", () => {
    expect(analyzedLabel(ago(3 * MIN), "ja", NOW)).toBe("3分前に分析");
  });
});

describe("relationLabel — legend and edge labels", () => {
  it("English shows the canonical relation name unchanged", () => {
    for (const r of Object.keys(RELATION_COLORS)) expect(relationLabel(r, "en")).toBe(r);
  });

  it("every canonical relation has a Japanese label", () => {
    const cjk = /[぀-ヿ一-龯]/;
    for (const r of Object.keys(RELATION_COLORS)) {
      expect(relationLabel(r, "ja"), r).toMatch(cjk);
    }
    expect(relationLabel("cause", "ja")).toBe("原因");
    expect(relationLabel("evidence", "ja")).toBe("根拠");
  });

  it("an unknown/legacy relation is shown as-is in both languages", () => {
    expect(relationLabel("supports", "ja")).toBe("supports");
    expect(relationLabel("", "en")).toBe("");
  });
});

describe("NetworkPanel copy keys have Japanese entries with matching placeholders", () => {
  it("covers every key the helper and the panel use", () => {
    const cjk = /[぀-ヿ一-龯]/;
    const holders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of NETWORK_LABEL_KEYS) {
      expect(JA[k], `missing JA for "${k}"`).toMatch(cjk);
      expect(holders(JA[k]), k).toEqual(holders(k));
    }
  });
});

// Raw-source wiring guard: NetworkPanel pulls in cytoscape/React, so it is
// read as text rather than imported in this Node test.
const SOURCES = import.meta.glob(["./components/NetworkPanel.tsx"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function panel(): string {
  const s = SOURCES["./components/NetworkPanel.tsx"];
  expect(s, "NetworkPanel.tsx not found").toBeTruthy();
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

describe("NetworkPanel wiring", () => {
  it("Refresh is disabled with a stated reason while there is nothing to analyze (BUG-015a)", () => {
    const s = panel();
    expect(s).toMatch(/const analyzable = useStore\(\(s\) => hasAnalyzableContent\(s\.doc\)\)/);
    const refresh = buttonAround(s, '{t("Refresh")}');
    expect(refresh).toContain("disabled={!!globalBusy || !analyzable}");
    expect(refresh).toMatch(
      /title=\{\s*analyzable\s*\?\s*t\("Re-analyze document"\)\s*:\s*t\("Nothing to analyze yet — write some text first\."\)\s*\}/
    );
  });

  it("uses the shared pure helpers instead of a local English-only clock and colour map", () => {
    const s = panel();
    expect(s).toMatch(/import \{[^}]*\bRELATION_COLORS\b[^}]*\} from "\.\.\/networkLabels"/);
    expect(s).not.toMatch(/const RELATION_COLORS\b/);
    expect(s).not.toMatch(/function relativeTime\b/);
    expect(s).toContain("analyzedLabel(analysis.analyzedAt, lang)");
    expect(s).toContain("relationLabel(r, lang)");
    expect(s).toContain("relationLabel(e.relation || \"\", lang)");
  });

  it("header, stale pill and empty state are translated", () => {
    const s = panel();
    expect(s).toContain('<NetworkIcon /> {t("Relationships")}');
    expect(s).toContain('{t("out of date")}');
    expect(s).toContain(
      't("No relationships yet. Click “Refresh” to extract the logical structure of your document.")'
    );
  });
});

describe("D2 — the empty graph names the control that is actually on screen", () => {
  const KEY = "No relationships yet. Click “Refresh” to extract the logical structure of your document.";

  it("the copy says Refresh (EN) / 更新 (JA), matching the button label", () => {
    expect(KEY).toContain(`“Refresh”`);
    expect(JA[KEY]).toContain(`「${JA["Refresh"]}」`);
    expect(NETWORK_LABEL_KEYS).toContain(KEY);
  });

  it("the empty state shows the hint only when there is text, else the nothing-to-analyze notice", () => {
    const s = panel();
    const at = s.indexOf("{isEmpty && !globalBusy && (");
    expect(at).toBeGreaterThan(-1);
    const block = s.slice(at, s.indexOf("</div>\n        )}", at));
    expect(block).toMatch(
      /analyzable\s*\?\s*t\("No relationships yet\. Click “Refresh” to extract the logical structure of your document\."\)\s*:\s*t\("Nothing to analyze yet — write some text first\."\)/
    );
    expect(s).not.toContain("Click “Analyze”");
  });
});
