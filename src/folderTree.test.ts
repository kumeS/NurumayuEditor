import { describe, expect, it } from "vitest";
import { folderDisplayName, folderToFollow, isInside, parentDirectory } from "./folderTree";

describe("folderDisplayName — the sidebar header label for a chosen root", () => {
  it("returns the last path segment for a POSIX path", () => {
    expect(folderDisplayName("/Users/me/Documents/Notes")).toBe("Notes");
  });

  it("returns the last path segment for a Windows path", () => {
    expect(folderDisplayName("C:\\Users\\me\\Documents\\Notes")).toBe("Notes");
  });

  it("ignores a trailing slash", () => {
    expect(folderDisplayName("/Users/me/Notes/")).toBe("Notes");
  });

  it("falls back to the whole path when there is no separator", () => {
    expect(folderDisplayName("Notes")).toBe("Notes");
  });

  it("preserves CJK names", () => {
    expect(folderDisplayName("/Users/me/研究ノート")).toBe("研究ノート");
  });
});

describe("parentDirectory / isInside", () => {
  it("finds the containing folder (POSIX, Windows, CJK, root)", () => {
    expect(parentDirectory("/Users/me/研究/note.md")).toBe("/Users/me/研究");
    expect(parentDirectory("C:\\notes\\a.md")).toBe("C:\\notes");
    expect(parentDirectory("C:\\a.md")).toBe("C:\\");
    expect(parentDirectory("/a.md")).toBe("/");
    expect(parentDirectory("a.md")).toBeNull();
  });
  it("matches whole path segments only", () => {
    expect(isInside("/Users/me/notes/a.md", "/Users/me/notes")).toBe(true);
    expect(isInside("/Users/me/notes/sub/a.md", "/Users/me/notes/")).toBe(true);
    expect(isInside("/Users/me/notes-old/a.md", "/Users/me/notes")).toBe(false);
    expect(isInside("/Users/me/notes", "/Users/me/notes")).toBe(false);
    expect(isInside("/anything.md", "/")).toBe(true);
  });
});

describe("folderToFollow — the sidebar shows the open file's folder", () => {
  const note = "/Users/me/proj/03_vis/note.md";
  it("with no folder chosen, shows the active file's folder (not the 'Open a folder' empty state)", () => {
    expect(folderToFollow(null, note)).toBe("/Users/me/proj/03_vis");
  });
  it("switches when the active file lives outside the current tree", () => {
    expect(folderToFollow("/Users/me/other", note)).toBe("/Users/me/proj/03_vis");
  });
  it("stays put for a file inside the tree, however deep (e.g. opened from it)", () => {
    expect(folderToFollow("/Users/me/proj", note)).toBeNull();
    expect(folderToFollow("/Users/me/proj/03_vis", note)).toBeNull();
  });
  it("leaves the tree alone for an unsaved document", () => {
    expect(folderToFollow("/Users/me/proj", null)).toBeNull();
    expect(folderToFollow(null, null)).toBeNull();
  });
});
