/** Pure helpers shared by the rendered Markdown preview and its source editor. */

export interface MarkdownLinkMatch {
  href: string;
  label: string;
  from: number;
  to: number;
}

const SAFE_DATA_IMAGE =
  /^data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml)(?:;charset=[^;,]+)?(?:;base64)?,/i;

/**
 * ReactMarkdown deliberately rejects data URLs by default. Permit only image
 * data URLs in image `src` attributes (including URL-encoded SVG), while
 * retaining a conservative scheme allowlist for every other URL.
 */
export function markdownUrlTransform(url: string, key: string): string {
  const value = url.trim();
  if (key === "src" && SAFE_DATA_IMAGE.test(value)) return value;
  if (/^(?:https?:|mailto:)/i.test(value)) return value;
  if (/^(?:#|\/|\.\/|\.\.\/)/.test(value)) return value;
  // A bare relative file name/path is safe; anything with another explicit
  // scheme (javascript:, data:text/html, file:, …) is not.
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  return "";
}

/** Replace one source span after an inline edit in the rendered preview. */
export function replaceMarkdownRange(
  source: string,
  from: number,
  to: number,
  replacement: string
): string {
  const start = Math.max(0, Math.min(source.length, from));
  const end = Math.max(start, Math.min(source.length, to));
  return `${source.slice(0, start)}${replacement.replace(/\r\n?/g, "\n")}${source.slice(end)}`;
}

/** Find a normal Markdown link under a CodeMirror source offset. */
export function findMarkdownLinkAt(source: string, offset: number): MarkdownLinkMatch | null {
  const patterns = [
    /(?<!!)\[([^\]]+)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g,
    /<(https?:\/\/[^>]+)>/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const from = match.index;
      const to = from + match[0].length;
      if (offset < from || offset > to) continue;
      const href = match[2] ?? match[1];
      return { href, label: match[1], from, to };
    }
  }
  return null;
}
