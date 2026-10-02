import { describe, expect, it } from "vitest";
import { changesLabel, HEALTH_LABEL_KEYS, reportLabels } from "./healthLabels";
import { JA } from "./i18n";

const NONE = { paragraphs: 0, titleChanged: false, otherChanged: false };

describe("changesLabel (BUG-015b / MISS-12)", () => {
  it("counts changed paragraphs", () => {
    expect(changesLabel({ ...NONE, paragraphs: 3 }, true, "en")).toBe("3 changed since last save");
    expect(changesLabel({ ...NONE, paragraphs: 3 }, true, "ja")).toBe("前回保存から3件変更");
  });

  it("names a title-only change", () => {
    expect(changesLabel({ ...NONE, titleChanged: true }, true, "en")).toBe("Title changed");
    expect(changesLabel({ ...NONE, titleChanged: true }, true, "ja")).toBe("タイトルを変更");
  });

  it("names an order/analysis/metadata-only change", () => {
    expect(changesLabel({ ...NONE, otherChanged: true }, true, "en")).toBe("Order, analysis or metadata changed");
    expect(changesLabel({ ...NONE, otherChanged: true }, true, "ja")).toBe("順序・分析・メタデータを変更");
  });

  it("dirty with nothing different (undo back to the saved state) says so", () => {
    expect(changesLabel(NONE, true, "en")).toBe("Unsaved (matches last save)");
    expect(changesLabel(NONE, true, "ja")).toBe("未保存(保存時と同じ内容)");
  });

  it("clean with nothing different is the only 'no changes' case", () => {
    expect(changesLabel(NONE, false, "en")).toBe("No changes since last save");
    expect(changesLabel(NONE, false, "ja")).toBe("前回保存から変更なし");
  });
});

describe("reportLabels (draft reports are not exports)", () => {
  it("labels a draft report as a draft", () => {
    expect(reportLabels("draft", "en")).toEqual({ button: "Draft report", heading: "Last draft" });
    expect(reportLabels("draft", "ja")).toEqual({ button: "下書きのレポート", heading: "直近の下書き" });
  });

  it("labels an export with its format", () => {
    expect(reportLabels("pdf", "en")).toEqual({ button: "Export (PDF)", heading: "Last export — PDF" });
    expect(reportLabels("pptx", "ja")).toEqual({ button: "書き出し (PPTX)", heading: "直近の書き出し — PPTX" });
  });
});

describe("health-label keys have Japanese entries", () => {
  it("every key is translated and keeps its placeholders", () => {
    const cjk = /[぀-ヿ一-龯]/;
    const holders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of HEALTH_LABEL_KEYS) {
      expect(JA[k], `missing JA for "${k}"`).toMatch(cjk);
      expect(holders(JA[k]), k).toEqual(holders(k));
    }
  });
});
