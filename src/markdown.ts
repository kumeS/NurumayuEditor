/**
 * Markdown <-> chunk projection (TS is the single owner of it in the GUI).
 *
 * Invariants:
 * - `markdownSource` is the canonical text of a Markdown-backed document.
 *   In Markdown mode it is returned verbatim. In Editor/Slide mode it is the
 *   merge baseline: `documentToMarkdown` keeps the original bytes of every
 *   block the chunks still contain unchanged (by type/level/content), and
 *   re-serializes only edited, inserted or moved-out-of-order chunks. An
 *   unedited round trip is byte-identical (separators, trailing spaces,
 *   h4-h6 markers, CRLF, the trailing-newline state).
 * - Code fences are backtick or tilde runs (>= 3); a fence closes only on a
 *   run of the same character at least as long. An unclosed fence (runs to
 *   EOF) is reused verbatim only while it is the last thing emitted; when a
 *   chunk follows it, the merge appends the closing marker.
 * - Metadata (notes, layout, summary of non-image chunks, ...) never reaches
 *   the Markdown: alignment ignores it.
 * - YAML frontmatter (byte 0, a closing `---`/`...` fence, at least one
 *   `key:` line) and a leading `# H1` form the title prefix. Frontmatter is
 *   never a chunk. The prefix is kept verbatim unless the title changes, and
 *   then only the H1 line changes. A source without an H1 never gains one
 *   in the merge; `withMarkdownTitle` (called from setTitle) is the only
 *   place a title line is inserted.
 *
 * Known limits:
 * - Headings #### to ###### are projected as level-3 heading chunks (the
 *   model's levels are 1-3); their original markers survive only while the
 *   chunk is unedited.
 * - A re-serialized chunk next to a neighbour that was separated by a single
 *   newline gets a blank-line separator instead (safe re-parse over byte
 *   identity for the separator next to an edit).
 * - A level-1 heading chunk that ends up as the first content of a source
 *   without an H1 re-opens as the title (the leading-H1 rule).
 * - Documents without a baseline (or with a whitespace-only one) use the
 *   deterministic serializer, the twin of Rust `document_to_md`.
 */
import type { Chunk, ChunkMetadata, ChunkType, Document } from "./types";

function localId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `md-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function headingPrefix(chunk: Chunk): string {
  const level = Math.min(Math.max(chunk.metadata.level ?? 1, 1), 6);
  return "#".repeat(level);
}

function chunkAsMarkdown(chunk: Chunk): string {
  switch (chunk.metadata.chunkType) {
    case "heading":
      return `${headingPrefix(chunk)} ${chunk.content.trim()}`;
    case "image":
      return `![${chunk.metadata.summary ?? ""}](${chunk.content.trim()})`;
    case "diagram":
      return `\`\`\`${chunk.metadata.format ?? "mermaid"}\n${chunk.content.trimEnd()}\n\`\`\``;
    default:
      return chunk.content;
  }
}

/** Deterministic chunk serializer used when there is no baseline source. */
function serializeChunks(doc: Document): string {
  const parts: string[] = [];
  if (doc.title.trim()) parts.push(`# ${doc.title.trim()}`);
  parts.push(...doc.chunks.map(chunkAsMarkdown));
  return `${parts.join("\n\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Parsing with source spans

interface SourceLine {
  text: string;
  /** Offset of the first character of the line in the original source. */
  start: number;
  /** Offset just past the last character, excluding the line ending. */
  end: number;
}

function splitLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const eol = /\r\n|\r|\n/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = eol.exec(source))) {
    lines.push({ text: source.slice(start, m.index), start, end: m.index });
    start = m.index + m[0].length;
  }
  lines.push({ text: source.slice(start), start, end: source.length });
  return lines;
}

/** One block of the chunk projection, with its exact span in the source. */
export interface MarkdownBlock {
  /** Source offset of the block's first character. */
  from: number;
  /** Source offset just past its last character (line ending excluded). */
  to: number;
  type: ChunkType;
  content: string;
  /** Metadata the block contributes to its chunk (level, format, alt, ...). */
  meta: Partial<ChunkMetadata>;
  /** Set to the opening marker when a fence ran to EOF without closing. Its
   *  span then lacks the closing line, so a merge that emits anything after
   *  it must close it (md-slides-export-1). */
  unclosedMarker?: string;
}

export interface ParsedMarkdown {
  /** Text of the leading `# H1`, or null when the source has none. */
  title: string | null;
  /** End of the frontmatter's closing fence line (0 when there is none). */
  frontmatterEnd: number;
  /** Span of the leading H1 line, when present. */
  heading: { from: number; to: number } | null;
  /** End of the title prefix: the H1 line, else the frontmatter, else 0. */
  prefixEnd: number;
  blocks: MarkdownBlock[];
}

/** How far down the closing frontmatter fence may be. */
const FRONTMATTER_MAX_LINES = 200;
// The optional closing `#` run only counts after a space/tab (CommonMark), so
// "# Learn C#" keeps its '#' (md-slides-export-5).
const LEADING_H1 = /^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;

/** Index of the closing frontmatter fence line, or -1 when there is no frontmatter. */
function frontmatterClose(lines: SourceLine[]): number {
  if (!/^﻿?---[ \t]*$/.test(lines[0]?.text ?? "")) return -1;
  let hasKey = false;
  const limit = Math.min(lines.length, FRONTMATTER_MAX_LINES + 1);
  for (let k = 1; k < limit; k += 1) {
    const text = lines[k].text;
    if (/^(---|\.\.\.)[ \t]*$/.test(text)) return hasKey ? k : -1;
    if (/^[^\s#:-][^:]*:(\s|$)/.test(text)) hasKey = true;
  }
  return -1;
}

interface Prefix {
  title: string | null;
  frontmatterEnd: number;
  heading: { from: number; to: number } | null;
  prefixEnd: number;
  /** First line index after the prefix. */
  bodyLine: number;
}

function parsePrefix(lines: SourceLine[]): Prefix {
  const close = frontmatterClose(lines);
  const frontmatterEnd = close >= 0 ? lines[close].end : 0;
  let i = close + 1;
  while (i < lines.length && !lines[i].text.trim()) i += 1;
  const h1 = lines[i]?.text.match(LEADING_H1);
  if (h1) {
    const line = lines[i];
    return {
      title: h1[1],
      frontmatterEnd,
      heading: { from: line.start, to: line.end },
      prefixEnd: line.end,
      bodyLine: i + 1,
    };
  }
  return { title: null, frontmatterEnd, heading: null, prefixEnd: frontmatterEnd, bodyLine: close + 1 };
}

function parseImage(line: string): { alt: string; url: string } | null {
  const match = line.trim().match(/^!\[([^\]]*)\]\((.+)\)$/);
  return match ? { alt: match[1], url: match[2] } : null;
}

/**
 * Parse `source` into its title prefix and chunk blocks, recording each
 * block's exact span so a merge can reuse the original bytes. Pure.
 */
export function parseMarkdownBlocks(source: string): ParsedMarkdown {
  const lines = splitLines(source);
  const prefix = parsePrefix(lines);
  const blocks: MarkdownBlock[] = [];
  let paragraph: SourceLine[] = [];
  const flushParagraph = () => {
    const content = paragraph.map((l) => l.text).join("\n").trimEnd();
    if (content.trim()) {
      blocks.push({
        from: paragraph[0].start,
        to: paragraph[paragraph.length - 1].end,
        type: "text",
        content,
        meta: {},
      });
    }
    paragraph = [];
  };

  let i = prefix.bodyLine;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.text.trimStart();
    // Backtick or tilde fence (CommonMark): a backtick info string may not
    // contain a backtick; the close is a run of the SAME character at least
    // as long as the opening run (md-slides-export-2, matches slideText.ts).
    const fence = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      flushParagraph();
      const marker = fence[1];
      const ch = marker[0];
      const language = fence[2].trim();
      const body: string[] = [];
      let last = line;
      i += 1;
      while (i < lines.length) {
        const candidate = lines[i].text.trim();
        let run = 0;
        while (candidate[run] === ch) run += 1;
        if (run >= marker.length && candidate.slice(run).trim() === "") break;
        body.push(lines[i].text);
        last = lines[i];
        i += 1;
      }
      const closed = i < lines.length;
      if (closed) {
        last = lines[i];
        i += 1;
      }
      const span = { from: line.start, to: last.end, ...(closed ? {} : { unclosedMarker: marker }) };
      if (language.toLowerCase() === "mermaid") {
        blocks.push({ ...span, type: "diagram", content: body.join("\n"), meta: { format: "mermaid" } });
      } else {
        blocks.push({
          ...span,
          type: "text",
          content: `${marker}${language}\n${body.join("\n")}\n${marker}`,
          meta: {},
        });
      }
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
    if (heading) {
      flushParagraph();
      blocks.push({
        from: line.start,
        to: line.end,
        type: "heading",
        content: heading[2],
        meta: { level: Math.min(heading[1].length, 3) },
      });
      i += 1;
      continue;
    }

    const image = parseImage(line.text);
    if (image) {
      flushParagraph();
      blocks.push({
        from: line.start,
        to: line.end,
        type: "image",
        content: image.url,
        meta: { summary: image.alt || undefined, imageSource: "local" },
      });
      i += 1;
      continue;
    }

    if (!line.text.trim()) flushParagraph();
    else paragraph.push(line);
    i += 1;
  }
  flushParagraph();

  return {
    title: prefix.title,
    frontmatterEnd: prefix.frontmatterEnd,
    heading: prefix.heading,
    prefixEnd: prefix.prefixEnd,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Title line

/** The line ending a source uses ("\r\n" when it has any CRLF). */
export function eolOf(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

/** LF-only text (CodeMirror's internal form). Pure. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Convert LF text back to `eol` — the inverse of normalizeEol for a source
 *  with one line-ending style (md-slides-export-3). Pure. */
export function restoreEol(text: string, eol: string): string {
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}

/**
 * Return `source` with its title line set to `title`: the H1 line is
 * replaced, inserted (after any frontmatter) or, for a blank title, removed
 * together with the blank lines after it. Nothing else changes. Pure.
 */
export function withMarkdownTitle(source: string, title: string): string {
  const lines = splitLines(source);
  const prefix = parsePrefix(lines);
  const t = title.trim();
  const eol = eolOf(source);
  let next = prefix.bodyLine;
  while (next < lines.length && !lines[next].text.trim()) next += 1;
  const bodyStart = next < lines.length ? lines[next].start : source.length;

  if (prefix.heading) {
    if ((prefix.title ?? "").trim() === t) return source;
    if (t) return `${source.slice(0, prefix.heading.from)}# ${t}${source.slice(prefix.heading.to)}`;
    return source.slice(0, prefix.heading.from) + source.slice(bodyStart);
  }
  if (!t) return source;
  if (prefix.frontmatterEnd > 0) {
    const fm = prefix.frontmatterEnd;
    return `${source.slice(0, fm)}${eol}${eol}# ${t}${source.slice(fm)}`;
  }
  const rest = source.slice(bodyStart);
  return rest ? `# ${t}${eol}${eol}${rest}` : `# ${t}\n`;
}

// ---------------------------------------------------------------------------
// Merge serializer

function alignmentKey(type: ChunkType, content: string, meta: Partial<ChunkMetadata>): string {
  switch (type) {
    case "heading":
      return `h\u0000${meta.level ?? 1}\u0000${content}`;
    case "image":
      return `i\u0000${meta.summary ?? ""}\u0000${content}`;
    case "diagram":
      return `d\u0000${meta.format ?? "mermaid"}\u0000${content}`;
    default:
      return `${type}\u0000${content}`;
  }
}

/** Above this many DP cells the aligner falls back to a greedy in-order match. */
const LCS_CELL_LIMIT = 4_000_000;

/**
 * Longest common subsequence of two key lists. Returns, for each index of
 * `b`, the matched index of `a` (or -1). Common prefix/suffix are trimmed
 * first, so a single edit costs O(n).
 */
function alignKeys(a: string[], b: string[]): Int32Array {
  const match = new Int32Array(b.length).fill(-1);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) {
    match[s] = s;
    s += 1;
  }
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea -= 1;
    eb -= 1;
    match[eb] = ea;
  }
  const n = ea - s;
  const m = eb - s;
  if (n === 0 || m === 0) return match;

  if (n * m > LCS_CELL_LIMIT) {
    // Greedy: each chunk takes the next unused block with its key.
    const positions = new Map<string, number[]>();
    for (let i = s; i < ea; i += 1) {
      const list = positions.get(a[i]);
      if (list) list.push(i);
      else positions.set(a[i], [i]);
    }
    const cursor = new Map<string, number>();
    let last = s - 1;
    for (let j = s; j < eb; j += 1) {
      const list = positions.get(b[j]);
      if (!list) continue;
      let c = cursor.get(b[j]) ?? 0;
      while (c < list.length && list[c] <= last) c += 1;
      cursor.set(b[j], c);
      if (c < list.length) {
        match[j] = list[c];
        last = list[c];
      }
    }
    return match;
  }

  // suffix-LCS table: len[i][j] = LCS of a[s+i..ea) and b[s+j..eb)
  const w = m + 1;
  const len = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      len[i * w + j] =
        a[s + i] === b[s + j]
          ? len[(i + 1) * w + j + 1] + 1
          : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[s + i] === b[s + j]) {
      match[s + j] = s + i;
      i += 1;
      j += 1;
    } else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return match;
}

function countEols(s: string): number {
  return s.match(/\r\n|\r|\n/g)?.length ?? 0;
}

function mergeIntoSource(doc: Document, baseline: string): string {
  let source = baseline;
  let parsed = parseMarkdownBlocks(source);
  // A changed title rewrites only the H1 line. A baseline without an H1
  // never gains one here (see withMarkdownTitle / setTitle).
  if (parsed.heading && (parsed.title ?? "").trim() !== doc.title.trim()) {
    source = withMarkdownTitle(source, doc.title);
    parsed = parseMarkdownBlocks(source);
  }
  const { blocks } = parsed;
  const paragraphBreak = eolOf(source).repeat(2);
  const lead = (i: number) => source.slice(i === 0 ? parsed.prefixEnd : blocks[i - 1].to, blocks[i].from);

  const chunks = doc.chunks.filter((c) => chunkAsMarkdown(c).trim() !== "");
  const match = alignKeys(
    blocks.map((b) => alignmentKey(b.type, b.content, b.meta)),
    chunks.map((c) => alignmentKey(c.metadata.chunkType, c.content, c.metadata))
  );

  // For each chunk: the baseline index of the next matched chunk at or after it.
  const nextMatched = new Int32Array(chunks.length + 1);
  nextMatched[chunks.length] = blocks.length;
  for (let j = chunks.length - 1; j >= 0; j -= 1) {
    nextMatched[j] = match[j] >= 0 ? match[j] : nextMatched[j + 1];
  }

  let out = source.slice(0, parsed.prefixEnd);
  // Baseline index of the last emitted item when it was an unchanged block
  // (-1 = the prefix itself), or null after a re-serialized chunk.
  let lastVerbatim: number | null = -1;
  let nextBlock = 0; // first baseline block not consumed yet
  for (let j = 0; j < chunks.length; j += 1) {
    const matched = match[j];
    // An unmatched chunk takes over the slot (and separator) of the next
    // unconsumed baseline block before the next match — an edited block.
    const anchor = matched >= 0 ? matched : nextBlock < nextMatched[j] ? nextBlock : null;
    // Re-serialized chunks (LF content) take the source's line ending, so a
    // CRLF file never gains mixed EOLs (md-slides-export-3).
    let text =
      matched >= 0
        ? source.slice(blocks[matched].from, blocks[matched].to)
        : restoreEol(chunkAsMarkdown(chunks[j]), eolOf(source));
    // A reused unclosed fence keeps its bytes only while nothing follows it;
    // otherwise everything emitted after it would land inside the code block.
    const unclosed = matched >= 0 ? blocks[matched].unclosedMarker : undefined;
    if (unclosed && j < chunks.length - 1) text += eolOf(source) + unclosed;
    const candidate = anchor === null ? null : lead(anchor);

    let sep: string;
    if (out === "") {
      sep = anchor === 0 && parsed.prefixEnd === 0 && candidate !== null ? candidate : "";
    } else if (matched >= 0 && lastVerbatim !== null && matched === lastVerbatim + 1) {
      sep = candidate ?? paragraphBreak; // original adjacency: keep it verbatim
    } else if (candidate !== null && countEols(candidate) >= 2) {
      sep = candidate;
    } else {
      sep = paragraphBreak;
    }
    out += sep + text;

    if (anchor !== null) nextBlock = anchor + 1;
    lastVerbatim = matched >= 0 ? matched : null;
  }

  const tail = blocks.length ? source.slice(blocks[blocks.length - 1].to) : source.slice(parsed.prefixEnd);
  return out + tail;
}

/**
 * The Markdown text of `doc`.
 * - Markdown mode: `markdownSource` verbatim (it is kept current there).
 * - Editor/Slide mode with a non-blank `markdownSource`: the chunks merged
 *   into that baseline (unchanged blocks keep their original bytes).
 * - Otherwise: the deterministic chunk serializer (`# title` + blocks).
 */
export function documentToMarkdown(doc: Document): string {
  if (doc.mode === "markdown" && doc.markdownSource !== undefined) return doc.markdownSource;
  if (doc.markdownSource !== undefined && doc.markdownSource.trim()) {
    return mergeIntoSource(doc, doc.markdownSource);
  }
  return serializeChunks(doc);
}

// ---------------------------------------------------------------------------
// Markdown -> Document

function compatibleMetadata(
  previous: Chunk | undefined,
  type: Chunk["metadata"]["chunkType"],
  extra: Partial<ChunkMetadata> = {}
): ChunkMetadata {
  const base = previous?.metadata.chunkType === type ? previous.metadata : undefined;
  return {
    ...(base ?? {}),
    ...extra,
    chunkType: type,
    linkedChunks: base?.linkedChunks ?? [],
  };
}

function makeChunk(
  previous: Chunk | undefined,
  order: number,
  content: string,
  metadata: ChunkMetadata
): Chunk {
  return {
    id: previous?.metadata.chunkType === metadata.chunkType ? previous.id : localId(),
    order,
    content,
    metadata,
  };
}

/**
 * Parse enough Markdown structure to keep the app's chunk/AI/slide projections
 * usable while preserving `source` byte-for-byte as the canonical value.
 * Inline syntax, lists, tables, HTML and unknown block forms stay untouched in
 * text chunks; the preview is handled by the full GFM renderer. Frontmatter
 * is excluded from the chunks; the leading H1 (after it) becomes the title,
 * otherwise the previous title is kept. Metadata carries over positionally
 * from `previous` when the chunk type matches.
 */
export function markdownToDocument(previous: Document, source: string): Document {
  const parsed = parseMarkdownBlocks(source);
  const chunks: Chunk[] = parsed.blocks.map((block, order) => {
    const old = previous.chunks[order];
    return makeChunk(old, order, block.content, compatibleMetadata(old, block.type, block.meta));
  });

  if (chunks.length === 0) {
    const old = previous.chunks[0];
    chunks.push(makeChunk(old, 0, "", compatibleMetadata(old, "text")));
  }

  return {
    ...previous,
    title: parsed.title ?? previous.title,
    mode: "markdown",
    chunks,
    markdownSource: source,
    // Structural Markdown edits invalidate the saved relationship projection.
    analysis: undefined,
  };
}
