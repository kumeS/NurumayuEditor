// Pure helpers for the folder tree sidebar (FolderTree.tsx). Kept
// framework-free so they're covered by the plain node-environment unit
// suite (vitest.config.ts) rather than needing a DOM/component test.

/** The sidebar header label for a chosen root: its last path segment. */
export function folderDisplayName(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}
