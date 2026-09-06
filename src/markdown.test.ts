import { describe, expect, it } from "vitest";
import { documentToMarkdown, markdownToDocument } from "./markdown";
import type { Document } from "./types";

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

  // A document that once passed through the Markdown workspace keeps a
  // markdownSource even after switching away (chunk edits don't clear it —
  // see the Document.markdownSource doc comment). Once mode has moved on,
  // that source is stale: documentToMarkdown must derive fresh text from
  // chunks, or a Save-As-.md from Editor/Slide mode could write old content.
  it("ignores a stale markdownSource once mode has left markdown", () => {
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
