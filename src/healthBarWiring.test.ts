// Raw-source wiring guards for the w3-healthbar batch: the pure helpers in
// diff.ts / healthLabels.ts / exportWarnings.ts are only useful if the
// components call them, and the Analyze entry points must be disabled with a
// stated reason while the document has nothing to analyze (BUG-015a).

import { describe, expect, it } from "vitest";
import { changesLabel } from "./healthLabels";
import { JA } from "./i18n";

const SOURCES = import.meta.glob(
  [
    "./components/HealthBar.tsx",
    "./components/Toolbar.tsx",
    "./components/DiffPanel.tsx",
    "./components/OpenRouterModelCatalog.tsx",
    "./components/NetworkPanel.tsx",
    "../tailwind.config.js",
  ],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;

function src(path: string): string {
  const s = SOURCES[path];
  expect(s, `${path} not found`).toBeTruthy();
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

const NOTHING_TO_ANALYZE = 't("Nothing to analyze yet — write some text first.")';

describe("HealthBar change label (BUG-015b / MISS-12)", () => {
  it("derives the label from changeSummary + changesLabel", () => {
    const hb = src("./components/HealthBar.tsx");
    expect(hb).toMatch(/import \{[^}]*\bchangeSummary\b[^}]*\} from "\.\.\/diff"/);
    expect(hb).toMatch(/import \{[^}]*\bchangesLabel\b[^}]*\} from "\.\.\/healthLabels"/);
    const button = buttonAround(hb, "<HistoryIcon");
    expect(button).toContain("changesLabel(changes, dirty, lang)");
  });

  it("DiffPanel uses the same summary and lists a title change as its own row", () => {
    const dp = src("./components/DiffPanel.tsx");
    expect(dp).toMatch(/const summary = useMemo\(\(\) => changeSummary\(savedDoc, doc\)/);
    expect(dp).toMatch(/summary\.titleChanged && \(\s*<DiffSection title=\{t\("Title"\)\}/);
    expect(dp).toContain("changesLabel(summary, dirty, lang)");
  });
});

// QA 20261003 (BUG-005): a change only the Markdown source carries
// (frontmatter, blank lines, line endings) is dirty, so the label must name
// it instead of reading "Unsaved (matches last save)".
describe("source-only change label (QA 20261003)", () => {
  const SOURCE_ONLY = { paragraphs: 0, titleChanged: false, otherChanged: false, sourceChanged: true };

  it("changesLabel names a source-only change, in both languages", () => {
    // Fails if changesLabel ignores sourceChanged (falls through to "matches last save").
    expect(changesLabel(SOURCE_ONLY, true, "en")).toBe("Markdown source changed");
    expect(changesLabel(SOURCE_ONLY, true, "ja")).toBe("Markdownソースを変更");
  });

  it("HealthBar colours the change label from hasChanges (which counts sourceChanged)", () => {
    const hb = src("./components/HealthBar.tsx");
    expect(hb).toMatch(/import \{[^}]*\bhasChanges\b[^}]*\} from "\.\.\/diff"/);
    expect(hb).toMatch(/const anyChange = hasChanges\(changes\);/);
    const button = buttonAround(hb, "<HistoryIcon");
    expect(button).toContain('${anyChange ? "text-warn" : ""}');
  });

  it("DiffPanel explains a source-only change under its label", () => {
    const dp = src("./components/DiffPanel.tsx");
    const at = dp.indexOf("{summary.sourceChanged && (");
    expect(at).toBeGreaterThan(-1);
    const block = dp.slice(at, dp.indexOf("</p>", at));
    // Review follow-up C20 (QA 20261003): the causes are EXAMPLES ("for
    // example" / 「など」) — trailing spaces, indentation and fence markers
    // also produce a source-only change (diff.test.ts backs spacing and
    // fences). Fails if the note goes back to a closed list.
    const key =
      "Only the Markdown text differs (for example front matter, blank lines, spacing, line endings, heading or fence markers, or the title line); the paragraphs in the editor are unchanged.";
    expect(block).toContain(`t("${key}")`);
    expect(JA[key]).toBe(
      "Markdownのテキストだけが異なります(フロントマター・空行・空白・改行コード・見出しやコードフェンスの記号・タイトル行など)。エディタの段落は変わっていません。"
    );
  });
});

describe("Analyze entry points while there is nothing to analyze (BUG-015a)", () => {
  it("HealthBar's AI entry is disabled with a stated reason", () => {
    const hb = src("./components/HealthBar.tsx");
    expect(hb).toMatch(/const analyzable = useStore\(\(s\) => hasAnalyzableContent\(s\.doc\)\)/);
    const button = buttonAround(hb, "onClick={() => void analyzeDocument()}");
    expect(button).toMatch(/disabled=\{!analyzable\}/);
    expect(button).toContain(NOTHING_TO_ANALYZE);
  });

  it("the toolbar Analyze button is disabled with a stated reason, but Hide graph stays enabled", () => {
    const tb = src("./components/Toolbar.tsx");
    expect(tb).toMatch(/const analyzable = useStore\(\(s\) => hasAnalyzableContent\(s\.doc\)\)/);
    const button = buttonAround(tb, "else void analyzeDocument();");
    expect(button).toMatch(/disabled=\{!networkOpen && \(!!globalBusy \|\| !analyzable\)\}/);
    expect(button).toContain(NOTHING_TO_ANALYZE);
  });
});

describe("HealthBar model-unavailable chip (BUG-013c)", () => {
  it("names the model and opens Settings in one click", () => {
    const hb = src("./components/HealthBar.tsx");
    expect(hb).toMatch(/const aiModelIssue = useStore\(\(s\) => s\.aiModelIssue\)/);
    const at = hb.indexOf("{aiModelIssue && (");
    expect(at).toBeGreaterThan(-1);
    const chip = hb.slice(at, hb.indexOf(")}", hb.indexOf("</button>", at)));
    expect(chip).toContain('translateWith("Model unavailable: {model}", lang, { model: aiModelIssue.model })');
    const button = buttonAround(chip, 't("Open Settings")');
    expect(button).toContain("onClick={openSettings}");
  });
});

describe("HealthBar last-report label and warnings", () => {
  it("labels draft reports via reportLabels and localizes each warning", () => {
    const hb = src("./components/HealthBar.tsx");
    expect(hb).toContain("reportLabels(lastExportReport.format, lang)");
    expect(hb).toMatch(/<li key=\{i\}>\{localizeExportWarning\(w, lang\)\}<\/li>/);
  });
});

describe("HealthBar network tooltip (counted vs. not counted)", () => {
  it("names the model list and the known uncounted traffic, in both languages", () => {
    const hb = src("./components/HealthBar.tsx");
    const at = hb.indexOf("netStats.aiCalls");
    const titleAt = hb.lastIndexOf('title={t("', at);
    expect(titleAt).toBeGreaterThan(-1);
    const key = hb.slice(titleAt + 'title={t("'.length, hb.indexOf('")}', titleAt));
    expect(key).toBe(
      "Network calls this session, counted separately: LLM requests (ai.rs), and fetches through net.rs's guarded safe_fetch — reference pages, images, citation lookups and the OpenRouter model list. Not counted, for example: images shown straight from a web address, and the one-time download of the personal library's embedding model."
    );
    expect(JA[key]).toContain("OpenRouterのモデル一覧");
    expect(JA[key]).toContain("埋め込みモデル");
  });
});

describe("OpenRouterModelCatalog error localization", () => {
  it("localizes the backend error at its single catch site", () => {
    const cat = src("./components/OpenRouterModelCatalog.tsx");
    expect(cat).toMatch(/catalogFailed\(s, localizeCatalogError\(message, lang\)\)/);
  });
});

describe("semantic color tokens (ui.md rule 9)", () => {
  it("HealthBar, OpenRouterModelCatalog and NetworkPanel use no raw red/amber/gray scale classes", () => {
    for (const f of ["HealthBar", "OpenRouterModelCatalog", "NetworkPanel"]) {
      const s = src(`./components/${f}.tsx`);
      const raw = s.match(/\b(?:red|amber|gray)-\d+/g) ?? [];
      expect(raw, f).toEqual([]);
    }
  });

  it("tailwind.config.js defines the warn, danger, ok and chrome tokens", () => {
    const tw = src("../tailwind.config.js");
    for (const token of ["warn", "danger", "ok", "chrome"]) {
      expect(tw, token).toMatch(new RegExp(`\\b${token}: \\{`));
    }
  });
});
