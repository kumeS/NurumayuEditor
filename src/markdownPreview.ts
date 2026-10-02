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
  // A local file as an image source: resolved against the document's folder
  // and read by Rust (see localImages.ts) — never followed as a link.
  if (key === "src" && /^file:\/\//i.test(value)) return value;
  if (/^(?:https?:|mailto:)/i.test(value)) return value;
  if (/^(?:#|\/|\.\/|\.\.\/)/.test(value)) return value;
  // A bare relative file name/path is safe; anything with another explicit
  // scheme (javascript:, data:text/html, file:, …) is not.
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  return "";
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

/** Block-level tags that carry their source lines (for keeping the scroll position across views). */
export const SOURCE_LINE_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "blockquote",
  "pre", "table", "tr", "hr", "dl", "dt", "dd",
]);

interface LineNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start?: { line?: number }; end?: { line?: number } };
  children?: LineNode[];
}

/** `data-source-line` / `data-source-end-line` attributes for a block from its source position. */
export function sourceLineAttrs(node: LineNode | undefined): Record<string, number> {
  const start = node?.position?.start?.line;
  const end = node?.position?.end?.line;
  if (typeof start !== "number") return {};
  return { "data-source-line": start, "data-source-end-line": typeof end === "number" ? end : start };
}

/**
 * Rehype plugin: stamp each block element with the source lines it came from,
 * so the preview can report which line is at the top of the viewport (and
 * scroll to one). Custom components that don't forward properties add the
 * same attributes themselves via `sourceLineAttrs`.
 */
export function rehypeSourceLines() {
  return (tree: LineNode) => {
    const walk = (node: LineNode) => {
      if (node.type === "element" && node.tagName && SOURCE_LINE_TAGS.has(node.tagName)) {
        const start = node.position?.start?.line;
        if (typeof start === "number") {
          node.properties = {
            ...node.properties,
            dataSourceLine: start,
            dataSourceEndLine: node.position?.end?.line ?? start,
          };
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

/**
 * Rehype plugin: drop the position-less "\n" text that mdast-util-to-hast emits
 * after every `<br>`. The preview shows source line breaks as line breaks
 * (`white-space: pre-line`), so that duplicate would render every hard break
 * as a blank line. The `<br>` itself maps to the whole `  \n` in the source.
 */
export function rehypeTrimBreakNewlines() {
  return (tree: LineNode & { value?: string }) => {
    const walk = (node: LineNode & { value?: string }) => {
      const kids = node.children as (LineNode & { value?: string })[] | undefined;
      if (!kids) return;
      for (let i = kids.length - 1; i > 0; i--) {
        const prev = kids[i - 1];
        const cur = kids[i];
        if (prev.type === "element" && prev.tagName === "br" && cur.type === "text" && !cur.position && cur.value?.startsWith("\n")) {
          const rest = cur.value.slice(1);
          if (rest) cur.value = rest;
          else kids.splice(i, 1);
        }
      }
      kids.forEach(walk);
    };
    walk(tree);
  };
}

/** The rehype plugins of the Markdown preview — shared with the editing-core tests so both see the same tree. */
export const PREVIEW_REHYPE_PLUGINS = [rehypeSourceLines, rehypeTrimBreakNewlines];
