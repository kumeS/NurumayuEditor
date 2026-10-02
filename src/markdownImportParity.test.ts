import { describe, expect, it } from "vitest";
import { markdownToDocument } from "./markdown";
import type { Document } from "./types";

// Invariant 3 contract test: Markdown IMPORT has two implementations — TS
// markdownToDocument / parseMarkdownBlocks (the GUI) and Rust
// fileio.rs markdown_text_to_document (CLI/MCP import). Both read the same
// golden fixture; fileio.rs::tests::md_import_golden_parity asserts the Rust
// side. The fixture's _comment lists the cases deliberately left out
// (frontmatter, image lines, indented H1, empty ATX headings, lone CR).
const goldenRaw = Object.values(
  import.meta.glob("../src-tauri/tests/fixtures/md_import.golden.json", {
    eager: true,
    query: "?raw",
    import: "default",
  })
)[0] as string;

interface GoldenChunk {
  type: string;
  level: number | null;
  content: string;
}

const golden = JSON.parse(goldenRaw) as {
  fallbackTitle: string;
  cases: { name: string; md: string; title: string; chunks: GoldenChunk[] }[];
};

describe("Markdown import — golden parity with Rust markdown_text_to_document", () => {
  it("the fixture is loaded and non-trivial", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(15);
  });

  for (const c of golden.cases) {
    it(c.name, () => {
      const previous: Document = { id: "g", title: golden.fallbackTitle, mode: "editor", chunks: [] };
      const doc = markdownToDocument(previous, c.md);
      expect(doc.title).toBe(c.title);
      expect(
        doc.chunks.map((ch) => ({
          type: ch.metadata.chunkType,
          level: ch.metadata.level ?? null,
          content: ch.content,
        }))
      ).toEqual(c.chunks);
    });
  }
});
