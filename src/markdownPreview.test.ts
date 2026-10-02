import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import {
  findMarkdownLinkAt,
  markdownUrlTransform,
  PREVIEW_REHYPE_PLUGINS,
  rehypeSourceLines,
  rehypeTrimBreakNewlines,
  sourceLineAttrs,
} from "./markdownPreview";

describe("Markdown preview helpers", () => {
  it("allows the URL-encoded SVG data image used by Markdown previews", () => {
    const value =
      "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E";
    expect(markdownUrlTransform(value, "src")).toBe(value);
  });

  it("does not allow data images in links or active URL schemes", () => {
    expect(markdownUrlTransform("data:image/svg+xml,%3Csvg%2F%3E", "href")).toBe("");
    expect(markdownUrlTransform("javascript:alert(1)", "href")).toBe("");
    expect(markdownUrlTransform("data:text/html,boom", "src")).toBe("");
  });

  it("lets a file:// URL through as an image source (resolved and read by Rust), never as a link", () => {
    expect(markdownUrlTransform("file:///Users/me/fig.png", "src")).toBe("file:///Users/me/fig.png");
    expect(markdownUrlTransform("file:///Users/me/secret.txt", "href")).toBe("");
  });

  it("finds source links but not Markdown images", () => {
    const source = "![plot](plot.png) and [資料](https://example.com/path)";
    expect(findMarkdownLinkAt(source, source.indexOf("資料"))).toMatchObject({
      href: "https://example.com/path",
      label: "資料",
    });
    expect(findMarkdownLinkAt(source, source.indexOf("plot"))).toBeNull();
  });
});

describe("rehypeSourceLines — blocks know which source lines they show", () => {
  type N = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: N[] };
  const run = (md: string) => {
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSourceLines);
    return processor.runSync(processor.parse(md)) as N;
  };
  const find = (n: N, tag: string, out: N[] = []): N[] => {
    if (n.tagName === tag) out.push(n);
    n.children?.forEach((c) => find(c, tag, out));
    return out;
  };

  it("stamps paragraphs, list items and table rows with their start/end lines", () => {
    const tree = run("# T\n\nline a\nline b\n\n- one\n- two\n\n| h |\n|---|\n| c |\n");
    expect(find(tree, "p")[0].properties).toMatchObject({ dataSourceLine: 3, dataSourceEndLine: 4 });
    expect(find(tree, "li").map((li) => li.properties?.dataSourceLine)).toEqual([6, 7]);
    expect(find(tree, "tr").map((tr) => tr.properties?.dataSourceLine)).toEqual([9, 11]);
  });

  it("leaves inline elements alone (only blocks anchor the scroll position)", () => {
    const tree = run("a **b** `c`\n");
    expect(find(tree, "strong")[0].properties?.dataSourceLine).toBeUndefined();
    expect(find(tree, "code")[0].properties?.dataSourceLine).toBeUndefined();
  });

  it("gives custom components the same attributes from a node's position", () => {
    expect(sourceLineAttrs({ type: "element", position: { start: { line: 4 }, end: { line: 6 } } })).toEqual({
      "data-source-line": 4,
      "data-source-end-line": 6,
    });
    expect(sourceLineAttrs(undefined)).toEqual({});
  });
});

describe("source line breaks are shown as line breaks in the preview", () => {
  type N = { type: string; tagName?: string; value?: string; children?: N[] };
  const paragraph = (md: string) => {
    const processor = unified().use(remarkParse).use(remarkRehype).use(rehypeTrimBreakNewlines);
    const tree = processor.runSync(processor.parse(md)) as N;
    return tree.children!.find((c) => c.tagName === "p")!;
  };

  it("keeps a single newline in the text (the preview renders it with white-space: pre-line)", () => {
    // The reported case: "[追記]" and the next line must not join into one line.
    const p = paragraph("[追記]\nR3を直すべきです。\n");
    expect(p.children!.map((c) => c.value)).toEqual(["[追記]\nR3を直すべきです。"]);
  });

  it("drops the duplicate newline after a hard break so it isn't shown as a blank line", () => {
    const p = paragraph("a  \nb\n");
    expect(p.children!.map((c) => c.tagName ?? c.value)).toEqual(["a", "br", "b"]);
  });

  it("is part of the preview's plugin list", () => {
    expect(PREVIEW_REHYPE_PLUGINS).toContain(rehypeTrimBreakNewlines);
    expect(PREVIEW_REHYPE_PLUGINS).toContain(rehypeSourceLines);
  });

  it("the preview stylesheet shows newlines in paragraphs, headings and list-item text", () => {
    const css = Object.values(
      import.meta.glob("./index.css", { eager: true, query: "?raw", import: "default" })
    )[0] as string;
    const rule = css.match(/([^{}]*)\{\s*white-space:\s*pre-line;?\s*\}/);
    expect(rule, "no white-space: pre-line rule").not.toBeNull();
    const selectors = rule![1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((sel) => sel.trim());
    for (const sel of [".markdown-preview p", ".markdown-preview h1", ".markdown-preview h2", ".markdown-preview .md-li-text"]) {
      expect(selectors).toContain(sel);
    }
  });
});
