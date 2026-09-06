import type { Chunk, ChunkMetadata, Document } from "./types";

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

/**
 * Return the exact Markdown source while the Markdown workspace is
 * authoritative (`mode === "markdown"`). `markdownSource` can linger after
 * `mode` moves on — ordinary chunk edits don't clear it — so it's ignored
 * outside Markdown mode and text is derived fresh from `chunks` instead.
 * Legacy chunk documents are converted deterministically the same way.
 */
export function documentToMarkdown(doc: Document): string {
  if (doc.mode === "markdown" && doc.markdownSource !== undefined) return doc.markdownSource;

  const parts: string[] = [];
  if (doc.title.trim()) parts.push(`# ${doc.title.trim()}`);
  parts.push(...doc.chunks.map(chunkAsMarkdown));
  return `${parts.join("\n\n").trimEnd()}\n`;
}

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

function parseImage(line: string): { alt: string; url: string } | null {
  const match = line.trim().match(/^!\[([^\]]*)\]\((.+)\)$/);
  return match ? { alt: match[1], url: match[2] } : null;
}

/**
 * Parse enough Markdown structure to keep the app's chunk/AI/slide projections
 * usable while preserving `source` byte-for-byte as the canonical value.
 * Inline syntax, lists, tables, HTML and unknown block forms stay untouched in
 * text chunks; the preview is handled by the full GFM renderer.
 */
export function markdownToDocument(previous: Document, source: string): Document {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  let title = previous.title;
  let i = 0;

  while (i < lines.length && !lines[i].trim()) i += 1;
  const leadingTitle = lines[i]?.match(/^#\s+(.+?)\s*#*\s*$/);
  if (leadingTitle) {
    title = leadingTitle[1];
    i += 1;
  }

  const chunks: Chunk[] = [];
  let paragraph: string[] = [];
  const push = (
    content: string,
    type: Chunk["metadata"]["chunkType"],
    extra: Partial<ChunkMetadata> = {}
  ) => {
    const order = chunks.length;
    const old = previous.chunks[order];
    chunks.push(makeChunk(old, order, content, compatibleMetadata(old, type, extra)));
  };
  const flushParagraph = () => {
    const content = paragraph.join("\n").trimEnd();
    if (content.trim()) push(content, "text");
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const fence = trimmed.match(/^(`{3,})(.*)$/);
    if (fence) {
      flushParagraph();
      const marker = fence[1];
      const language = fence[2].trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const candidate = lines[i].trim();
        const ticks = candidate.match(/^`+/)?.[0].length ?? 0;
        if (ticks >= marker.length && candidate.slice(ticks).trim() === "") break;
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      if (language.toLowerCase() === "mermaid") {
        push(body.join("\n"), "diagram", { format: "mermaid" });
      } else {
        push(`${marker}${language}\n${body.join("\n")}\n${marker}`, "text");
      }
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      push(heading[2], "heading", { level: Math.min(heading[1].length, 3) });
      i += 1;
      continue;
    }

    const image = parseImage(line);
    if (image) {
      flushParagraph();
      push(image.url, "image", { summary: image.alt || undefined, imageSource: "local" });
      i += 1;
      continue;
    }

    if (!line.trim()) flushParagraph();
    else paragraph.push(line);
    i += 1;
  }
  flushParagraph();

  if (chunks.length === 0) {
    const old = previous.chunks[0];
    chunks.push(makeChunk(old, 0, "", compatibleMetadata(old, "text")));
  }

  return {
    ...previous,
    title,
    mode: "markdown",
    chunks,
    markdownSource: source,
    // Structural Markdown edits invalidate the saved relationship projection.
    analysis: undefined,
  };
}
