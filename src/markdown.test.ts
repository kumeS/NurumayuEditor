import { describe, expect, it } from "vitest";
import {
  documentToMarkdown,
  eolOf,
  markdownToDocument,
  normalizeEol,
  parseMarkdownBlocks,
  restoreEol,
  withMarkdownTitle,
} from "./markdown";
import type { Chunk, Document } from "./types";

function blank(): Document {
  return {
    id: "doc-1",
    title: "",
    mode: "markdown",
    chunks: [
      {
        id: "chunk-1",
        order: 0,
        content: "",
        metadata: { chunkType: "text", linkedChunks: [] },
      },
    ],
  };
}

describe("Markdown source model", () => {
  it("preserves exact GFM source while deriving usable chunks", () => {
    const source = [
      "# 日本語タイトル",
      "",
      "## 概要",
      "",
      "- [x] **完了**  ",
      "- [ ] 次の作業",
      "",
      "|項目|値|",
      "|---|---:|",
      "|速度|42|",
      "",
    ].join("\n");

    const doc = markdownToDocument(blank(), source);

    expect(doc.title).toBe("日本語タイトル");
    expect(doc.chunks[0].metadata).toMatchObject({ chunkType: "heading", level: 2 });
    expect(doc.chunks.some((chunk) => chunk.content.includes("- [x] **完了**  "))).toBe(true);
    expect(documentToMarkdown(doc)).toBe(source);
  });

  it("projects Mermaid and images without changing their source", () => {
    const source = "```mermaid\ngraph TD\n A-->B\n```\n\n![図](image.png)\n";
    const doc = markdownToDocument(blank(), source);

    expect(doc.chunks.map((chunk) => chunk.metadata.chunkType)).toEqual([
      "diagram",
      "image",
    ]);
    expect(doc.chunks[0].content).toContain("A-->B");
    expect(doc.chunks[1]).toMatchObject({ content: "image.png" });
    expect(documentToMarkdown(doc)).toBe(source);
  });

  it("serializes legacy chunk documents deterministically", () => {
    const doc = blank();
    doc.mode = "editor";
    doc.title = "Paper";
    doc.chunks = [
      {
        id: "h",
        order: 0,
        content: "Methods",
        metadata: { chunkType: "heading", level: 2, linkedChunks: [] },
      },
      {
        id: "p",
        order: 1,
        content: "日本語の本文。",
        metadata: { chunkType: "text", linkedChunks: [] },
      },
    ];

    expect(documentToMarkdown(doc)).toBe(
      "# Paper\n\n## Methods\n\n日本語の本文。\n"
    );
  });

  // A document that once passed through the Markdown workspace keeps its
  // markdownSource after switching away — it is the merge baseline (see the
  // Document.markdownSource doc comment). Outside Markdown mode the CHUNKS
  // are authoritative for content: baseline bytes survive only for blocks
  // the chunks still contain, so a Save-As-.md from Editor/Slide mode can
  // never write text the chunks no longer have.
  it("never resurrects baseline text the chunks no longer contain", () => {
    const doc = blank();
    doc.mode = "editor";
    doc.chunks = [
      {
        id: "p",
        order: 0,
        content: "Fresh paragraph.",
        metadata: { chunkType: "text", linkedChunks: [] },
      },
    ];
    doc.markdownSource = "# Stale\n\nOld text from a past Markdown session.";

    const md = documentToMarkdown(doc);
    expect(md).toContain("Fresh paragraph.");
    expect(md).not.toContain("Old text from a past Markdown session.");
  });
});

/** The Editor/Slides view of a parsed Markdown doc (mode is a view flag). */
function asEditor(doc: Document): Document {
  return { ...doc, mode: "editor" };
}
function parse(source: string, title = ""): Document {
  return markdownToDocument({ ...blank(), title }, source);
}
function editChunk(doc: Document, from: string, to: string): Chunk[] {
  const hit = doc.chunks.filter((c) => c.content === from);
  expect(hit).toHaveLength(1); // the fixture must identify exactly one chunk
  return doc.chunks.map((c) => (c.content === from ? { ...c, content: to } : c));
}

describe("BUG-019a — Markdown source is canonical across view switches", () => {
  it("unedited Editor round-trip is byte-identical (exact QA repro)", () => {
    const src = "# 見出し\n\n**太字**";
    expect(documentToMarkdown(asEditor(parse(src)))).toBe(src);
  });

  it("a source without a leading H1 does not gain one (title = file stem)", () => {
    const src = "> quote\n\nbody\n";
    expect(documentToMarkdown(asEditor(parse(src, "stem")))).toBe(src);
  });

  it("blank-line runs, trailing spaces and leading blank lines survive an unedited round trip", () => {
    const singleNewlineBlocks = "## H\ntext\n![a](b.png)\n```js\nx\n```\nafter\n";
    for (const src of ["a\n\n\n\nb\n", "\n\n# T\n\n\n\nA  \nA2   \n\n\nB", "x\n\n\n", singleNewlineBlocks]) {
      expect(documentToMarkdown(asEditor(parse(src)))).toBe(src);
    }
  });

  it("h4-h6 are kept verbatim", () => {
    const src = "#### 小見出し\n\n本文\n\n###### six ##\n";
    expect(documentToMarkdown(asEditor(parse(src)))).toBe(src);
  });

  it("CRLF sources round-trip byte-identically", () => {
    const src = "# T\r\n\r\npara one\r\nline two\r\n\r\n```js\r\nx\r\n```\r\n";
    expect(documentToMarkdown(asEditor(parse(src)))).toBe(src);
  });

  it("an unclosed fence round-trips without gaining a closing fence", () => {
    const src = "# T\n\n```py\nprint(1)\n";
    expect(documentToMarkdown(asEditor(parse(src)))).toBe(src);
  });

  it("editing one chunk only rewrites that chunk", () => {
    const src = "---\nk: v\n---\n\n# T\n\nA  \n\n\nB\n";
    const d = parse(src);
    const out = documentToMarkdown({ ...asEditor(d), chunks: editChunk(d, "B", "B2") });
    expect(out).toBe("---\nk: v\n---\n\n# T\n\nA  \n\n\nB2\n");
  });

  it("editing a middle chunk keeps every other byte, incl. h4 and blank-line runs", () => {
    const src = "# T\n\n#### deep\n\n\nalpha\n\n\n\nbeta  \n\n![図](a.png)\n";
    const d = parse(src);
    const out = documentToMarkdown({ ...asEditor(d), chunks: editChunk(d, "alpha", "ALPHA") });
    expect(out).toBe("# T\n\n#### deep\n\n\nALPHA\n\n\n\nbeta  \n\n![図](a.png)\n");
  });

  it("deleting a chunk drops exactly its block", () => {
    const src = "# T\n\none\n\n\ntwo\n\nthree\n";
    const d = parse(src);
    const out = documentToMarkdown({
      ...asEditor(d),
      chunks: d.chunks.filter((c) => c.content !== "two"),
    });
    expect(out).toBe("# T\n\none\n\nthree\n");
    expect(asEditor(parse(out)).chunks.map((c) => c.content)).toEqual(["one", "three"]);
  });

  it("a chunk inserted next to a single-newline neighbour gets a blank-line separator", () => {
    // `## H` and `text` are separated by ONE newline in the source (a heading
    // interrupts a paragraph). A new paragraph between them must not glue
    // itself onto `text` when re-parsed.
    const src = "## H\ntext\n";
    const d = parse(src);
    const inserted: Chunk = {
      id: "new",
      order: 1,
      content: "inserted",
      metadata: { chunkType: "text", linkedChunks: [] },
    };
    const chunks = [d.chunks[0], inserted, d.chunks[1]];
    const out = documentToMarkdown({ ...asEditor(d), chunks });
    expect(out).toBe("## H\n\ninserted\n\ntext\n");
    expect(parse(out).chunks.map((c) => c.content)).toEqual(["H", "inserted", "text"]);
  });

  it("metadata-only edits (notes, layout, summary) never change the Markdown", () => {
    const src = "# T\n\n## Slide\n\n\nbody  \n";
    const d = parse(src);
    const chunks = d.chunks.map((c) => ({
      ...c,
      metadata: { ...c.metadata, notes: "speaker", layout: "section" as const, summary: "s" },
    }));
    expect(documentToMarkdown({ ...d, mode: "slide", chunks })).toBe(src);
  });

  it("second cycle does not accumulate (unedited and after an edit)", () => {
    const src = "---\na: 1\n---\n# T\n\n\nx  \n\n#### y\n\n```mermaid\ngraph TD\n```\n";
    const back1 = documentToMarkdown(asEditor(parse(src)));
    const back2 = documentToMarkdown(asEditor(parse(back1)));
    expect(back1).toBe(src);
    expect(back2).toBe(back1);

    const d = parse(src);
    const edited = documentToMarkdown({ ...asEditor(d), chunks: editChunk(d, "x", "x2") });
    const again = documentToMarkdown(asEditor(parse(edited)));
    expect(again).toBe(edited);
  });

  it("an empty/whitespace baseline falls back to the deterministic serializer", () => {
    const d: Document = {
      ...blank(),
      mode: "editor",
      title: "Paper",
      markdownSource: "",
      chunks: [{ id: "p", order: 0, content: "body", metadata: { chunkType: "text", linkedChunks: [] } }],
    };
    expect(documentToMarkdown(d)).toBe("# Paper\n\nbody\n");
  });

  it("stays fast on a 300-block document (LCS alignment budget)", () => {
    const parts = Array.from({ length: 300 }, (_, i) =>
      i % 10 === 0 ? `## Section ${i}` : `段落 ${i} の本文。`
    );
    const src = `# Big\n\n${parts.join("\n\n")}\n`;
    const d = parse(src);
    expect(d.chunks).toHaveLength(300);
    const middle = { ...asEditor(d), chunks: editChunk(d, "段落 151 の本文。", "edited") };
    const reversed = { ...asEditor(d), chunks: [...d.chunks].reverse() };
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) {
      documentToMarkdown(middle);
      documentToMarkdown(reversed);
    }
    const perCall = (performance.now() - t0) / 40;
    expect(perCall).toBeLessThan(25);
    expect(documentToMarkdown(middle)).toBe(src.replace("段落 151 の本文。", "edited"));
  });
});

describe("BUG-019a — title edits touch only the title line", () => {
  it("a changed title rewrites only the H1 line (frontmatter and gaps kept)", () => {
    const src = "---\nk: v\n---\n\n# Old\n\n\nbody\n";
    const d = parse(src);
    expect(documentToMarkdown({ ...asEditor(d), title: "New" })).toBe(
      "---\nk: v\n---\n\n# New\n\n\nbody\n"
    );
  });

  it("withMarkdownTitle replaces, inserts after frontmatter, and removes", () => {
    expect(withMarkdownTitle("# Old\n\nbody\n", "New")).toBe("# New\n\nbody\n");
    expect(withMarkdownTitle("# Same\n\nbody\n", "Same")).toBe("# Same\n\nbody\n");
    expect(withMarkdownTitle("body\n", "T")).toBe("# T\n\nbody\n");
    expect(withMarkdownTitle("---\nk: v\n---\n\nbody\n", "T")).toBe("---\nk: v\n---\n\n# T\n\nbody\n");
    expect(withMarkdownTitle("---\nk: v\n---\n\n# T\n\nbody\n", "")).toBe("---\nk: v\n---\n\nbody\n");
    expect(withMarkdownTitle("# T\n\nbody\n", " ")).toBe("body\n");
    expect(withMarkdownTitle("body\n", "")).toBe("body\n");
    expect(withMarkdownTitle("", "T")).toBe("# T\n");
  });
});

describe("MODE-frontmatter — YAML frontmatter is metadata, not content", () => {
  const src = "---\ntitle: T\ntags: [a]\n---\n\n# 本題\n\n本文\n";

  it("is excluded from chunks and the H1 after it becomes the title", () => {
    const d = parse(src, "stem");
    expect(d.title).toBe("本題");
    expect(d.chunks.map((c) => [c.metadata.chunkType, c.content])).toEqual([["text", "本文"]]);
  });

  it("survives an Editor round trip at byte 0", () => {
    const out = documentToMarkdown(asEditor(parse(src, "stem")));
    expect(out.startsWith("---\ntitle: T\n")).toBe(true);
    expect(out).toBe(src);
  });

  it("is recognised only at byte 0, with a closing fence and a key: line", () => {
    // A thematic break in the middle is content.
    const mid = parse("intro\n\n---\nk: v\n---\n");
    expect(mid.chunks.map((c) => c.content).join("\n")).toContain("k: v");
    // No key: line → not frontmatter.
    const noKey = parse("---\njust text\n---\n\nbody\n");
    expect(noKey.chunks.map((c) => c.content).join("\n")).toContain("just text");
    // No closing fence → not frontmatter.
    const open = parse("---\nk: v\n\nbody\n");
    expect(open.chunks.map((c) => c.content).join("\n")).toContain("k: v");
    // Not at byte 0 → not frontmatter.
    const late = parse("\n---\nk: v\n---\n\nbody\n");
    expect(late.chunks.map((c) => c.content).join("\n")).toContain("k: v");
  });

  it("parseMarkdownBlocks exposes the frontmatter end and exact block spans", () => {
    const parsed = parseMarkdownBlocks(src);
    expect(src.slice(0, parsed.frontmatterEnd)).toBe("---\ntitle: T\ntags: [a]\n---");
    expect(parsed.title).toBe("本題");
    expect(parsed.blocks.map((b) => src.slice(b.from, b.to))).toEqual(["本文"]);
  });
});

describe("BUG-019a — merge invariant: re-parsing the output yields the chunks", () => {
  const key = (c: Chunk) => [c.metadata.chunkType, c.metadata.level ?? null, c.content];
  const sources = [
    "---\nk: v\n---\n# T\n## H\ntext\n\n\n![a](b.png)\n```mermaid\ngraph TD\n```\npara  \nline2\n",
    "\n\n#### deep\nx\n\n\n\ny\n\n```js\ncode\n```\nz",
    "# T\r\n\r\n## 見出し\r\n本文\r\n\r\n\r\n末尾\r\n",
  ];
  const fresh = (content: string, chunkType: Chunk["metadata"]["chunkType"] = "text", level?: number): Chunk => ({
    id: `n-${content}`,
    order: 0,
    content,
    metadata: { chunkType, linkedChunks: [], ...(level ? { level } : {}) },
  });
  const ops: Array<[string, (cs: Chunk[]) => Chunk[]]> = [
    ["edit first", (cs) => [{ ...cs[0], content: `${cs[0].content}!` }, ...cs.slice(1)]],
    ["edit last", (cs) => [...cs.slice(0, -1), { ...cs[cs.length - 1], content: "最後" }]],
    ["delete middle", (cs) => cs.filter((_, i) => i !== Math.floor(cs.length / 2))],
    ["insert text at 1", (cs) => [cs[0], fresh("新しい段落"), ...cs.slice(1)]],
    ["insert heading at end", (cs) => [...cs, fresh("Added", "heading", 2)]],
    ["swap first two", (cs) => [cs[1], cs[0], ...cs.slice(2)]],
    ["reverse", (cs) => [...cs].reverse()],
    // Level 1 is excluded on purpose: a level-1 heading that ends up first in
    // a source without an H1 re-opens as the title (the leading-H1 rule).
    ["toggle heading level 2<->3", (cs) => cs.map((c) => (c.metadata.chunkType === "heading" ? { ...c, metadata: { ...c.metadata, level: c.metadata.level === 2 ? 3 : 2 } } : c))],
  ];

  for (const src of sources) {
    for (const [name, op] of ops) {
      it(`${name} on ${JSON.stringify(src.slice(0, 12))}`, () => {
        const d = parse(src, "T");
        const chunks = op(d.chunks);
        const out = documentToMarkdown({ ...asEditor(d), chunks });
        const reparsed = parse(out, "T");
        expect(reparsed.chunks.map(key)).toEqual(chunks.map(key));
        // Idempotent: merging the re-parsed doc against its own source is identity.
        expect(documentToMarkdown(asEditor(reparsed))).toBe(out);
      });
    }
  }
});

// Invariant 3 contract test: the NO-baseline serializer has a twin in Rust
// (fileio.rs document_to_md, the CLI/MCP .md writer). Both read the same
// golden fixture; fileio.rs::tests::md_no_baseline_golden_parity asserts the
// Rust side.
const goldenRaw = Object.values(
  import.meta.glob("../src-tauri/tests/fixtures/md_no_baseline.golden.json", {
    eager: true,
    query: "?raw",
    import: "default",
  })
)[0] as string;
const golden = JSON.parse(goldenRaw) as {
  cases: { name: string; title: string; chunks: Chunk[]; expected: string }[];
};

describe("no-baseline Markdown serializer — golden parity with Rust document_to_md", () => {
  it("the fixture is loaded and non-trivial", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(7);
  });

  for (const c of golden.cases) {
    it(c.name, () => {
      const d: Document = { id: "g", title: c.title, mode: "editor", chunks: c.chunks };
      expect(d.markdownSource).toBeUndefined();
      expect(documentToMarkdown(d)).toBe(c.expected);
    });
  }
});

describe("md-slides-export-1 — an unclosed fence never swallows the chunks after it", () => {
  const para = (id: string, content: string): Chunk => ({
    id,
    order: 0,
    content,
    metadata: { chunkType: "text", linkedChunks: [] },
  });
  const contents = (src: string) => parse(src).chunks.map((c) => [c.metadata.chunkType, c.content]);

  it("a paragraph appended after an unclosed js fence stays its own chunk", () => {
    const src = "# T\n\nIntro\n\n```js\ncode";
    const d = parse(src);
    const out = documentToMarkdown({ ...asEditor(d), chunks: [...d.chunks, para("n", "After")] });
    expect(contents(out)).toEqual([
      ["text", "Intro"],
      ["text", "```js\ncode\n```"],
      ["text", "After"],
    ]);
    // second cycle: no accumulation
    const d2 = parse(out);
    expect(documentToMarkdown(asEditor(d2))).toBe(out);
  });

  it("an unclosed mermaid fence keeps its diagram source when a paragraph follows", () => {
    const src = "Intro\n\n```mermaid\ngraph TD";
    const d = parse(src);
    const out = documentToMarkdown({ ...asEditor(d), chunks: [...d.chunks, para("n", "After")] });
    expect(contents(out)).toEqual([
      ["text", "Intro"],
      ["diagram", "graph TD"],
      ["text", "After"],
    ]);
  });

  it("reordering the unclosed fence above Intro does not swallow Intro", () => {
    const src = "# T\n\nIntro\n\n```js\ncode";
    const d = parse(src);
    const out = documentToMarkdown({ ...asEditor(d), chunks: [d.chunks[1], d.chunks[0]] });
    expect(contents(out)).toEqual([
      ["text", "```js\ncode\n```"],
      ["text", "Intro"],
    ]);
  });

  it("CRLF: the added closing fence uses the source's line ending", () => {
    const src = "Intro\r\n\r\n```js\r\ncode";
    const d = parse(src);
    const out = documentToMarkdown({ ...asEditor(d), chunks: [d.chunks[1], d.chunks[0]] });
    expect(out.startsWith("```js\r\ncode\r\n```")).toBe(true);
  });
});

describe("md-slides-export-2 — tilde fences are fences", () => {
  const kinds = (src: string) => parseMarkdownBlocks(src).blocks.map((b) => [b.type, b.content]);

  it("a ~~~ fence with an inner '#' line and a blank line is ONE code chunk", () => {
    expect(kinds("## S\n\n~~~bash\n# install\n\nnpm i\n~~~\n")).toEqual([
      ["heading", "S"],
      ["text", "~~~bash\n# install\n\nnpm i\n~~~"],
    ]);
  });

  it("~~~mermaid is a diagram", () => {
    expect(kinds("~~~mermaid\ngraph TD\n~~~\n")).toEqual([["diagram", "graph TD"]]);
  });

  it("a ~~~ fence does not close on a backtick line (and vice versa)", () => {
    expect(kinds("~~~\n```\n~~~\nafter\n")).toEqual([
      ["text", "~~~\n```\n~~~"],
      ["text", "after"],
    ]);
    expect(kinds("```\n~~~\n```\nafter\n")).toEqual([
      ["text", "```\n~~~\n```"],
      ["text", "after"],
    ]);
  });

  it("a closing run must be at least as long as the opening run", () => {
    expect(kinds("~~~~\n~~~\n~~~~\n")).toEqual([["text", "~~~~\n~~~\n~~~~"]]);
  });

  it("a backtick info string containing a backtick is not a fence (CommonMark)", () => {
    expect(kinds("``` a`b\nx\n")).toEqual([["text", "``` a`b\nx"]]);
  });

  it("an unedited ~~~ source round-trips byte-identically", () => {
    const src = "## S\n\n~~~bash\n# install\n\nnpm i\n~~~\n";
    expect(documentToMarkdown(asEditor(parse(src)))).toBe(src);
  });
});

describe("md-slides-export-3 — CRLF survives the CodeMirror source editor", () => {
  it("eolOf / normalizeEol / restoreEol", () => {
    expect(eolOf("a\r\nb")).toBe("\r\n");
    expect(eolOf("a\nb")).toBe("\n");
    expect(normalizeEol("a\r\nb\rc\n")).toBe("a\nb\nc\n");
    expect(restoreEol("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
    expect(restoreEol("a\nb\n", "\n")).toBe("a\nb\n");
  });

  it("a CRLF source passed through the editor unedited comes back byte-identical", () => {
    const src = "# 見出し\r\n\r\n本文一行目\r\n二行目\r\n";
    expect(restoreEol(normalizeEol(src), eolOf(src))).toBe(src);
  });

  it("Editor-mode merge writes an edited chunk with the source's CRLF (no mixed EOL)", () => {
    const src = "A\r\nB\r\n\r\nC\r\n";
    const d = parse(src);
    const out = documentToMarkdown({ ...asEditor(d), chunks: editChunk(d, "A\nB", "A\nB2") });
    expect(out).toBe("A\r\nB2\r\n\r\nC\r\n");
  });
});

describe("md-slides-export-5 — an ATX closing sequence needs a space before it (CommonMark)", () => {
  it("'C#' keeps its '#', in body headings and the title", () => {
    expect(parseMarkdownBlocks("## Using C#\n").blocks.map((b) => b.content)).toEqual(["Using C#"]);
    expect(parse("# Learn C#\n\nBody\n").title).toBe("Learn C#");
    expect(parse(withMarkdownTitle("Body\n", "Learn C#")).title).toBe("Learn C#");
  });

  it("a real closing sequence is still stripped", () => {
    expect(parseMarkdownBlocks("## Title ##\n### T #\n").blocks.map((b) => b.content)).toEqual(["Title", "T"]);
    expect(parse("# Title #\n").title).toBe("Title");
  });

  it("an edited 'C#' heading writes back with its '#'", () => {
    const d = parse("## Using C#\n\nbody\n");
    const out = documentToMarkdown({ ...asEditor(d), chunks: editChunk(d, "Using C#", "Using C# today") });
    expect(out).toBe("## Using C# today\n\nbody\n");
  });
});
