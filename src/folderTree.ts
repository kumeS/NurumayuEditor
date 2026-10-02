// Pure helpers for the folder tree sidebar (FolderTree.tsx). Kept
// framework-free so they're covered by the plain node-environment unit
// suite (vitest.config.ts) rather than needing a DOM/component test.

/** The sidebar header label for a chosen root: its last path segment. */
export function folderDisplayName(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** The folder containing `path`, or null for a bare name / filesystem root. */
export function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return null;
  if (cut === 0) return trimmed[0]; // "/file.md" → "/"
  if (/^[A-Za-z]:$/.test(trimmed.slice(0, cut))) return trimmed.slice(0, cut + 1); // "C:\file.md" → "C:\"
  return trimmed.slice(0, cut);
}

/** Whether `path` lies inside the folder `root` (at any depth). */
export function isInside(path: string, root: string): boolean {
  const base = root.replace(/[/\\]+$/, "");
  if (base === "") return path.startsWith("/") || path.startsWith("\\");
  return path.length > base.length && path.startsWith(base) && /[/\\]/.test(path[base.length]);
}

/**
 * Which folder the sidebar should switch to for the active document, or null
 * to leave it alone. The tree follows the open file: with no folder chosen,
 * or when the file lives outside the current tree, it shows the file's own
 * folder. A file inside the tree (e.g. one just opened from it) never moves it.
 */
export function folderToFollow(folderRoot: string | null, activeFile: string | null): string | null {
  if (!activeFile) return null;
  if (folderRoot && isInside(activeFile, folderRoot)) return null;
  const parent = parentDirectory(activeFile);
  return parent && parent !== folderRoot ? parent : null;
}

/**
 * Whether two paths name the same file, as far as the webview can tell without
 * touching disk: trailing separators ignored, Unicode normalized (macOS pickers
 * and directory listings can disagree on NFC/NFD for kana with dakuten).
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.normalize("NFC").replace(/[/\\]+$/, "");
  return norm(a) === norm(b);
}
