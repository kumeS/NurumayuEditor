import { afterEach, describe, expect, it } from "vitest";
import {
  CJK_CHARS_PER_WORD,
  documentTextStats,
  formatLengthDetail,
  formatLengthLabel,
  lengthUnitFor,
  type WordSegmenter,
} from "./textStats";
import type { Chunk, ChunkType } from "./types";

function chunk(chunkType: ChunkType, content: string): Chunk {
  return { id: `${chunkType}-${content}`, order: 0, content, metadata: { chunkType, linkedChunks: [] } };
}
const text = (content: string) => chunk("text", content);
const heading = (content: string) => chunk("heading", content);
const diagram = (content: string) => chunk("diagram", content);
const image = (content: string) => chunk("image", content);

/** Load exactly one raw file through Vite's glob; fail loudly on a bad path. */
function rawFile(glob: Record<string, unknown>, label: string): string {
  const values = Object.values(glob);
  expect(values, `expected exactly one match for ${label}`).toHaveLength(1);
  expect(typeof values[0]).toBe("string");
  return values[0] as string;
}

describe("documentTextStats — what the status bar counts", () => {
  it("counts Japanese as characters (BUG-012: 日本語 is 3 characters, 1 word)", () => {
    expect(documentTextStats([text("日本語")])).toEqual({ characters: 3, letters: 3, cjkCharacters: 3, words: 1 });
  });

  it("counts English words with the word segmenter", () => {
    expect(documentTextStats([text("hello world")])).toEqual({ characters: 10, letters: 10, cjkCharacters: 0, words: 2 });
  });

  it("counts mixed script (testing.md #7) with the real Intl.Segmenter", () => {
    // Segmenter output in Node/ICU: 日本語 / と / English / words
    expect(documentTextStats([text("日本語とEnglish words")])).toEqual({
      characters: 16,
      letters: 16,
      cjkCharacters: 4,
      words: 4,
    });
  });

  it("excludes diagram and image chunks (Mermaid source, data URLs) but keeps headings", () => {
    const stats = documentTextStats([
      heading("見出し"),
      text("hello"),
      diagram("graph TD; A-->B"),
      image("data:image/png;base64,AAAA"),
    ]);
    expect(stats).toEqual({ characters: 8, letters: 8, cjkCharacters: 3, words: 2 });
  });

  it("counts an astral-plane CJK ideograph once, not as a surrogate pair", () => {
    // 𠮷 is U+20BB7 (CJK Extension B): "𠮷野家".length === 4 in UTF-16.
    const stats = documentTextStats([text("𠮷野家")]);
    expect(stats.characters).toBe(3);
    expect(stats.cjkCharacters).toBe(3);
  });

  it("excludes ASCII and ideographic (U+3000) spaces from the character count", () => {
    expect(documentTextStats([text("hello　世界 test\n")])).toEqual({
      characters: 11,
      letters: 11,
      cjkCharacters: 2,
      words: 3,
    });
  });

  it("counts CJK punctuation as a character but not as a CJK letter", () => {
    expect(documentTextStats([text("これは日本語の文です。")])).toEqual({
      characters: 11,
      letters: 10,
      cjkCharacters: 10,
      words: 6,
    });
  });

  it("segments each paragraph separately (no word glued across chunk boundaries)", () => {
    expect(documentTextStats([text("hello"), text("world")]).words).toBe(2);
  });

  it("returns zeros for an empty document", () => {
    expect(documentTextStats([])).toEqual({ characters: 0, letters: 0, cjkCharacters: 0, words: 0 });
  });
});

describe("documentTextStats — segmenter fallback", () => {
  const RealSegmenter = (Intl as { Segmenter?: unknown }).Segmenter;
  afterEach(() => {
    (Intl as { Segmenter?: unknown }).Segmenter = RealSegmenter;
  });

  it("uses an injected segmenter's word-like segments", () => {
    const fake: WordSegmenter = {
      segment: () => [
        { segment: "a", isWordLike: true },
        { segment: " ", isWordLike: false },
        { segment: "b", isWordLike: true },
        { segment: "c", isWordLike: true },
      ],
    };
    expect(documentTextStats([text("anything")], fake).words).toBe(3);
  });

  it("falls back to whitespace words + one per CJK character when there is no segmenter", () => {
    // Documented heuristic: 日,本,語,と (4) + English, words (2).
    expect(documentTextStats([text("日本語とEnglish words")], null)).toEqual({
      characters: 16,
      letters: 16,
      cjkCharacters: 4,
      words: 6,
    });
  });

  it("falls back when Intl.Segmenter is missing", () => {
    (Intl as { Segmenter?: unknown }).Segmenter = undefined;
    expect(documentTextStats([text("hello world 日本")]).words).toBe(4);
  });

  it("falls back when the Intl.Segmenter constructor throws", () => {
    (Intl as { Segmenter?: unknown }).Segmenter = class {
      constructor() {
        throw new RangeError("no word break data");
      }
    };
    expect(documentTextStats([text("hello world 日本")]).words).toBe(4);
  });
});

describe("lengthUnitFor — one unit rule for every length label", () => {
  it("uses characters when CJK is at least half of the letters", () => {
    expect(lengthUnitFor(documentTextStats([text("ab日本")]))).toBe("characters");
    expect(lengthUnitFor(documentTextStats([text("日本語")]))).toBe("characters");
  });

  it("ignores Markdown syntax, paths, digits and punctuation when judging the script mix", () => {
    // A Japanese table row: 7 CJK of 14 letters → characters. Over all 20
    // non-space characters (pipes, backticks, the dot) CJK would be only 35%
    // and the label would flip to words — the 61 KB QA fixture did exactly that.
    const row = documentTextStats([text("| `data.csv` | 日本語の表です |")]);
    expect(row).toMatchObject({ letters: 14, cjkCharacters: 7 });
    expect(lengthUnitFor(row)).toBe("characters");
  });

  it("uses words when CJK is under half, and for an empty document", () => {
    expect(lengthUnitFor(documentTextStats([text("abc日本")]))).toBe("words");
    expect(lengthUnitFor(documentTextStats([]))).toBe("words");
  });
});

describe("formatLengthLabel / formatLengthDetail", () => {
  it("labels Japanese as 文字 / characters, not 語 (BUG-012)", () => {
    const stats = documentTextStats([text("日本語")]);
    expect(formatLengthLabel(stats, 1, "ja")).toBe("1段落 · 3文字");
    expect(formatLengthLabel(stats, 1, "en")).toBe("1 paragraph · 3 characters");
  });

  it("keeps English as approximate words", () => {
    const stats = documentTextStats([text("hello world")]);
    expect(formatLengthLabel(stats, 1, "ja")).toBe("1段落 · 約2語");
    expect(formatLengthLabel(stats, 1, "en")).toBe("1 paragraph · ~2 words");
  });

  it("pluralizes English counts", () => {
    expect(formatLengthLabel(documentTextStats([text("hi"), text("there")]), 2, "en")).toBe(
      "2 paragraphs · ~2 words"
    );
    expect(formatLengthLabel(documentTextStats([text("hi")]), 1, "en")).toBe("1 paragraph · ~1 word");
    expect(formatLengthLabel(documentTextStats([text("字")]), 1, "en")).toBe("1 paragraph · 1 character");
  });

  it("the tooltip detail always carries both numbers", () => {
    const stats = documentTextStats([text("日本語")]);
    expect(formatLengthDetail(stats, "ja")).toBe("3文字 · 約1語");
    expect(formatLengthDetail(stats, "en")).toBe("3 characters · ~1 word");
  });
});

describe("CJK_CHARS_PER_WORD — the words→characters ratio shared with Rust", () => {
  it("is the approximate 2 characters per word", () => {
    expect(CJK_CHARS_PER_WORD).toBe(2);
  });

  it("matches JA_CHARS_PER_WORD in src-tauri/src/ai.rs (contract, testing.md #3)", () => {
    const ai = rawFile(
      import.meta.glob("../src-tauri/src/ai.rs", { eager: true, query: "?raw", import: "default" }),
      "src-tauri/src/ai.rs"
    );
    const m = ai.match(/\bconst\s+JA_CHARS_PER_WORD\s*:\s*[A-Za-z0-9_]+\s*=\s*([0-9]+(?:\.[0-9]+)?)/);
    expect(m, "JA_CHARS_PER_WORD constant not found in src-tauri/src/ai.rs").not.toBeNull();
    expect(Number(m![1])).toBe(CJK_CHARS_PER_WORD);
  });
});

describe("HealthBar wiring (raw-source guard)", () => {
  const source = rawFile(
    import.meta.glob("./components/HealthBar.tsx", { eager: true, query: "?raw", import: "default" }),
    "components/HealthBar.tsx"
  );

  it("imports the shared counter and formatters from ../textStats", () => {
    const importLine = source.match(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/textStats";/);
    expect(importLine, "HealthBar must import from ../textStats").not.toBeNull();
    const names = importLine![1].split(",").map((s) => s.trim());
    expect(names).toEqual(expect.arrayContaining(["documentTextStats", "formatLengthLabel", "formatLengthDetail"]));
  });

  it("no longer carries its own countWords or the 約N語 literal", () => {
    expect(source).not.toMatch(/function countWords/);
    expect(source).not.toMatch(/約\$\{words\}語/);
  });

  it("renders the label and the two-number tooltip from the shared stats", () => {
    expect(source).toMatch(/documentTextStats\(chunks\)/);
    const span = source.slice(source.indexOf("formatLengthLabel(") - 400, source.indexOf("formatLengthLabel(") + 120);
    expect(span).toMatch(/title=\{`\$\{formatLengthDetail\(textStats, lang\)\}/);
    expect(span).toContain('t("Characters exclude spaces; diagrams and images are not counted.")');
    expect(span).toMatch(/formatLengthLabel\(textStats, chunks\.length, lang\)/);
  });
});
