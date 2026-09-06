import { describe, expect, it } from "vitest";
import { folderDisplayName } from "./folderTree";

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
