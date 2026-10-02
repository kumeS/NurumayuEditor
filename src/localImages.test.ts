import { describe, expect, it } from "vitest";
import { resolveImageSource } from "./localImages";

const DOC = "/Users/me/研究/01_可視化/note.md";

describe("resolveImageSource — where a Markdown image actually lives", () => {
  it("passes remote and inline images through untouched", () => {
    expect(resolveImageSource("https://example.com/a.png", DOC)).toEqual({ kind: "direct", src: "https://example.com/a.png" });
    expect(resolveImageSource("http://example.com/a.png", null)).toEqual({ kind: "direct", src: "http://example.com/a.png" });
    const data = "data:image/png;base64,AAAA";
    expect(resolveImageSource(data, DOC)).toEqual({ kind: "direct", src: data });
  });

  it("resolves a bare relative path against the document's folder (the reported bug)", () => {
    expect(resolveImageSource("figures/fig1_ja.png", DOC)).toEqual({
      kind: "local",
      path: "/Users/me/研究/01_可視化/figures/fig1_ja.png",
    });
  });

  it("handles ./ and ../ segments, clamping at the filesystem root", () => {
    expect(resolveImageSource("./figures/a.png", DOC)).toEqual({ kind: "local", path: "/Users/me/研究/01_可視化/figures/a.png" });
    expect(resolveImageSource("../shared/a.png", DOC)).toEqual({ kind: "local", path: "/Users/me/研究/shared/a.png" });
    expect(resolveImageSource("../../../../../../a.png", DOC)).toEqual({ kind: "local", path: "/a.png" });
  });

  it("keeps an absolute path and accepts a file:// URL", () => {
    expect(resolveImageSource("/Volumes/data/fig.png", DOC)).toEqual({ kind: "local", path: "/Volumes/data/fig.png" });
    expect(resolveImageSource("file:///Volumes/data/fig.png", DOC)).toEqual({ kind: "local", path: "/Volumes/data/fig.png" });
  });

  it("decodes percent-encoding (the renderer encodes CJK and spaces)", () => {
    expect(resolveImageSource("figures/%E5%9B%B3%201.png", DOC)).toEqual({ kind: "local", path: "/Users/me/研究/01_可視化/figures/図 1.png" });
    expect(resolveImageSource("file:///Users/me/%E5%9B%B3.png", null)).toEqual({ kind: "local", path: "/Users/me/図.png" });
  });

  it("keeps a malformed % sequence verbatim instead of throwing", () => {
    expect(resolveImageSource("figures/100%.png", DOC)).toEqual({ kind: "local", path: "/Users/me/研究/01_可視化/figures/100%.png" });
  });

  it("drops a ?query or #fragment (e.g. GitHub-style ?raw=true)", () => {
    expect(resolveImageSource("figures/a.png?raw=true#top", DOC)).toEqual({ kind: "local", path: "/Users/me/研究/01_可視化/figures/a.png" });
  });

  it("reports that a relative path needs a saved document to resolve against", () => {
    expect(resolveImageSource("figures/a.png", null)).toEqual({ kind: "needs-document-folder" });
    // An absolute path needs no base folder.
    expect(resolveImageSource("/abs/a.png", null)).toEqual({ kind: "local", path: "/abs/a.png" });
  });

  it("treats an empty or scheme-rejected source as missing", () => {
    expect(resolveImageSource("", DOC)).toEqual({ kind: "missing" });
    expect(resolveImageSource("   ", DOC)).toEqual({ kind: "missing" });
    expect(resolveImageSource(undefined, DOC)).toEqual({ kind: "missing" });
    expect(resolveImageSource("javascript:alert(1)", DOC)).toEqual({ kind: "missing" });
  });
});
