import { describe, expect, it } from "vitest";
import {
  findMarkdownLinkAt,
  markdownUrlTransform,
  replaceMarkdownRange,
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

  it("updates a rendered CJK block without changing surrounding Markdown", () => {
    const source = "# 題名\n\n編集前の本文。\n\n[資料](https://example.com)\n";
    const from = source.indexOf("編集前");
    const to = from + "編集前の本文。".length;
    expect(replaceMarkdownRange(source, from, to, "編集後の本文。"))
      .toBe("# 題名\n\n編集後の本文。\n\n[資料](https://example.com)\n");
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
