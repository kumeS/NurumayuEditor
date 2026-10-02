// Editing the rendered Markdown preview without rewriting the source.
//
// The Markdown workspace promises the opened source is kept verbatim. The
// earlier preview editor re-serialized a whole block from the DOM on blur, which
// silently rewrote untouched syntax (hard breaks became soft ones — the "lines
// get joined" bug — and escapes, link titles etc. could change meaning).
//
// Instead, each editable block's rendered text is mapped character-by-character
// to source offsets (from the hast positions the renderer already carries). An
// edit is a diff between the text before and after; only the changed characters
// are spliced into the source, so everything else stays byte-identical.
//
// Invariants:
// - An edit whose removed text crosses formatting (e.g. deletes through a `**`)
//   is refused rather than applied — it would leave unbalanced markers.
// - Images, math and other embeds are atomic (one U+FFFC each) and can only be
//   deleted whole, never partially edited as text.
// - Text the user types is escaped so it stays literal (`*`, `[`, `$`, …).
// - Shift+Enter = Markdown hard break; Enter = new paragraph / new list item.
//   Table cells refuse both (a newline would break the table).
//
// Pure and framework-free (node unit suite).

/** Minimal hast node shape used here (a subset of `hast` types). */
export interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
  position?: { start?: { offset?: number; line?: number }; end?: { offset?: number; line?: number } };
}

/** One embed (image, math) in the rendered text. */
export const ATOM = "\uFFFC";
/** Inserted at the caret by the Enter key: "split here". */
export const PARAGRAPH_BREAK = "\u2029";

export type Segment =
  /** Text whose characters map to source offsets: `map[i]` = offset of char i; `map[len]` = end. */
  | { kind: "text"; text: string; map: number[]; styled: boolean }
  | { kind: "atom"; text: string; from: number; to: number }
  | { kind: "break"; text: string; from: number; to: number };

const start = (n: HNode) => n.position?.start?.offset;
const end = (n: HNode) => n.position?.end?.offset;

function classes(n: HNode): string[] {
  const c = n.properties?.className;
  return Array.isArray(c) ? c.map(String) : typeof c === "string" ? c.split(/\s+/) : [];
}

const isMath = (n: HNode) => n.tagName === "code" && classes(n).some((c) => c === "math-inline" || c === "math-display");
const isBlockChild = (n: HNode) => n.type === "element" && ["ul", "ol", "p", "pre", "blockquote", "table", "div"].includes(n.tagName ?? "");
const isCheckbox = (n: HNode) => n.type === "element" && n.tagName === "input";
const isBlank = (n: HNode) => n.type === "text" && !(n.value ?? "").trim();

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": "\u00a0" };

function decodeEntity(raw: string): string | null {
  if (ENTITIES[raw]) return ENTITIES[raw];
  const num = raw.match(/^&#(x[0-9a-f]+|\d+);$/i);
  if (num) {
    const code = num[1][0].toLowerCase() === "x" ? parseInt(num[1].slice(1), 16) : parseInt(num[1], 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : null;
  }
  return null;
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

/**
 * Align a text node's value with its source slice. Returns source offsets for
 * each value character (plus the end), or null if they can't be aligned —
 * such a block is simply not editable in the preview.
 */
function align(value: string, slice: string, base: number): number[] | null {
  const map: number[] = [];
  let i = 0;
  let j = 0;
  while (i < value.length) {
    if (j >= slice.length) return null;
    const v = value[i];
    const s = slice[j];
    // An entity (`&amp;`) must be tried before a literal match of its `&`.
    if (s === "&") {
      const semi = slice.indexOf(";", j);
      if (semi > j && semi - j <= 10 && decodeEntity(slice.slice(j, semi + 1)) === v) {
        map[i++] = base + j;
        j = semi + 1;
        continue;
      }
    }
    if (s === v) {
      map[i++] = base + j++;
      // After a soft line break, skip the continuation prefix (indent, "> ").
      if (v === "\n") while (j < slice.length && /[ \t>]/.test(slice[j]) && slice[j] !== value[i]) j++;
      continue;
    }
    if (s === "\\" && slice[j + 1] === v && ASCII_PUNCT.test(v)) {
      map[i++] = base + j;
      j += 2;
      continue;
    }
    // Trailing spaces before a soft break are dropped from the value.
    if (s === " " && v === "\n") {
      j++;
      continue;
    }
    return null;
  }
  map[i] = base + j;
  return /^\s*$/.test(slice.slice(j)) ? map : null;
}

/** The inline children of an editable block (a list item's nested lists and checkbox excluded). */
function inlineChildren(block: HNode): HNode[] {
  const kids = block.children ?? [];
  if (block.tagName !== "li") return kids;
  // A loose item holds <p>s, which are edited as paragraphs themselves.
  if (kids.some((k) => k.type === "element" && k.tagName === "p")) return [];
  const out: HNode[] = [];
  for (const k of kids) {
    if (isBlockChild(k)) break; // nested list: stop — it's not this item's text
    if (isCheckbox(k)) continue;
    out.push(k);
  }
  while (out.length && isBlank(out[0])) out.shift();
  while (out.length && isBlank(out[out.length - 1])) out.pop();
  return out;
}

/**
 * Where typing goes in a block with no inline content yet: right after a list
 * item's marker (`- `, `1. `, `- [ ] `) or a heading's `## `. Null for anything
 * else (e.g. an empty table cell) — those stay read-only rather than guessing.
 */
function emptyAnchor(block: HNode, source: string): number | null {
  const s = start(block);
  if (typeof s !== "number") return null;
  const lineEnd = source.indexOf("\n", s);
  const line = source.slice(s, lineEnd < 0 ? source.length : lineEnd);
  const marker =
    block.tagName === "li"
      ? line.match(/^(?:[-+*]|\d+[.)])(?:[ \t]+\[[ xX]\])?[ \t]*/)
      : /^h[1-6]$/.test(block.tagName ?? "")
        ? line.match(/^#{1,6}[ \t]*/)
        : null;
  return marker ? s + marker[0].length : null;
}

/** Where a block's editable text starts in the source (after `- ` / `## ` for empty ones). */
export function textStart(block: HNode, source: string): number | null {
  return inlineRange(block)?.from ?? emptyAnchor(block, source);
}

/**
 * Where a new paragraph after `block` is inserted: the end of the whole block,
 * not of its text — a setext heading's `---` underline and an ATX heading's
 * closing `#`s stay with the heading.
 */
export function blockEnd(block: HNode): number | null {
  return block.position?.end?.offset ?? null;
}

/** Source range of a block's editable inline content, or null if it has none. */
export function inlineRange(block: HNode): { from: number; to: number } | null {
  const kids = inlineChildren(block);
  const positioned = kids.filter((k) => typeof start(k) === "number" && typeof end(k) === "number");
  if (!positioned.length) return null;
  return { from: start(positioned[0]) as number, to: end(positioned[positioned.length - 1]) as number };
}

/**
 * Break a block's inline content into mapped segments, or null when some part
 * can't be mapped (unknown inline HTML, text that doesn't align) — the block
 * is then left read-only in the preview rather than edited by guesswork.
 */
export function buildSegments(block: HNode, source: string): Segment[] | null {
  const segs: Segment[] = [];
  const walk = (nodes: HNode[], styled: boolean, parent: HNode | null): boolean => {
    for (const n of nodes) {
      if (n.type === "text") {
        const value = n.value ?? "";
        if (!value) continue;
        let from = start(n);
        let to = end(n);
        if (typeof from !== "number" || typeof to !== "number") {
          const ps = parent ? start(parent) : undefined;
          const pe = parent ? end(parent) : undefined;
          if (typeof ps !== "number" || typeof pe !== "number") return false;
          const at = source.slice(ps, pe).indexOf(value);
          if (at < 0) return false;
          from = ps + at;
          to = from + value.length;
        }
        const map = align(value, source.slice(from, to), from);
        if (!map) return false;
        segs.push({ kind: "text", text: value, map, styled });
        continue;
      }
      if (n.type !== "element") continue;
      const s = start(n);
      const e = end(n);
      if (n.tagName === "br") {
        if (typeof s !== "number" || typeof e !== "number") return false;
        segs.push({ kind: "break", text: "\n", from: s, to: e });
      } else if (n.tagName === "img" || n.tagName === "code" || n.tagName === "a" || isMath(n)) {
        // Embeds, inline code and links are rendered non-editable in the
        // preview: one atomic unit each, deleted (or kept) whole.
        if (typeof s !== "number" || typeof e !== "number") return false;
        segs.push({ kind: "atom", text: ATOM, from: s, to: e });
      } else if (isCheckbox(n) || isBlockChild(n)) {
        continue;
      } else if (["strong", "em", "del", "span", "sup", "sub"].includes(n.tagName ?? "")) {
        if (!walk(n.children ?? [], true, n)) return false;
      } else {
        return false;
      }
    }
    return true;
  };
  if (!walk(inlineChildren(block), false, block)) return null;
  if (segs.length) return segs;
  // Empty block: one zero-length segment anchored after its marker.
  const anchor = emptyAnchor(block, source);
  return anchor === null ? null : [{ kind: "text", text: "", map: [anchor], styled: false }];
}

export const plainTextOf = (segs: Segment[]): string => segs.map((s) => s.text).join("");

/** How Enter/Shift+Enter translate for this block. */
export interface SplitContext {
  /** "paragraph": Enter → blank line; "listItem": Enter → new bullet; "none": refuse breaks (table cells). */
  kind: "paragraph" | "listItem" | "none";
  /** What starts the block's first line in the source ("  - ", "> ", "## ", ""). */
  linePrefix: string;
  /** Prefix for a continuation line inside the block (indent / "> "). */
  continuation: string;
}

export function splitContextFor(block: HNode, source: string): SplitContext {
  const range = inlineRange(block);
  const at = range?.from ?? emptyAnchor(block, source) ?? start(block) ?? 0;
  const lineStart = source.lastIndexOf("\n", at - 1) + 1;
  const linePrefix = source.slice(lineStart, at);
  if (block.tagName === "td" || block.tagName === "th") return { kind: "none", linePrefix, continuation: "" };
  const quote = (linePrefix.match(/^[ \t]*(?:>[ \t]?)+/) ?? [""])[0];
  if (block.tagName === "li") {
    // Continuation lines align with the item's content column.
    return { kind: "listItem", linePrefix, continuation: " ".repeat(linePrefix.length) };
  }
  // Paragraph (possibly inside a quote or a loose list item): keep its indentation.
  const indent = /^[ \t]*$/.test(linePrefix) ? linePrefix : quote;
  return { kind: "paragraph", linePrefix: indent, continuation: indent };
}

function isWordChar(c: string | undefined): boolean {
  return !!c && /[\p{L}\p{N}]/u.test(c);
}

/** Escape text the user typed so it stays literal in Markdown. */
function escapeTyped(text: string, before: string | undefined, after: string | undefined, lineStart: boolean): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const prev = i > 0 ? text[i - 1] : before;
    const next = i < text.length - 1 ? text[i + 1] : after;
    const atLineStart = i === 0 ? lineStart : text[i - 1] === "\n";
    if ("\\*`[]<$~|".includes(c)) out += `\\${c}`;
    else if (c === "_" && !(isWordChar(prev) && isWordChar(next))) out += "\\_";
    else if (atLineStart && /[#>+-]/.test(c)) out += `\\${c}`;
    else out += c;
  }
  // A typed "1." at the start of a line would begin an ordered list.
  return lineStart ? out.replace(/^(\d+)([.)])/, "$1\\$2") : out;
}

export type EditPlan =
  | { kind: "none" }
  | { kind: "unsafe"; reason: "crosses-formatting" | "atom" | "breaks-not-allowed" }
  | { kind: "splice"; from: number; to: number; insert: string; focusOffsetInInsert: number | null };

/** Source offset for plain-text offset `k`. `side` picks a segment at a boundary. */
function sourceAt(segs: Segment[], k: number, side: "left" | "right"): number {
  let pos = 0;
  let last = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const len = seg.text.length;
    const segEnd = pos + len;
    const atEnd = k === segEnd;
    const next = segs[i + 1];
    if (k < segEnd || (atEnd && (side === "left" || !next))) {
      const off = k - pos;
      if (seg.kind === "text") return seg.map[off];
      return off === 0 ? seg.from : seg.to;
    }
    last = seg.kind === "text" ? seg.map[len] : seg.to;
    pos = segEnd;
  }
  return last;
}

const segStart = (seg: Segment) => (seg.kind === "text" ? seg.map[0] : seg.from);
const segEnd = (seg: Segment) => (seg.kind === "text" ? seg.map[seg.text.length] : seg.to);

/** Index of the segment containing plain offset `k` (k < total). */
function segmentIndexAt(segs: Segment[], k: number): number {
  let pos = 0;
  for (let i = 0; i < segs.length; i++) {
    if (k < pos + segs[i].text.length) return i;
    pos += segs[i].text.length;
  }
  return segs.length - 1;
}

/**
 * Turn "the block's text went from `oldText` to `newText`" into a source
 * splice. `newText` may contain "\n" (Shift+Enter) and PARAGRAPH_BREAK (Enter).
 */
export function planTextEdit(args: {
  source: string;
  segs: Segment[];
  oldText: string;
  newText: string;
  context: SplitContext;
  /**
   * Whether the typed characters sit inside formatting in the DOM (a <strong>,
   * <em>, …). Plain text can't tell "before **bold**" from "**before bold**"
   * when typing exactly at the edge; the DOM can.
   */
  insertedStyled?: boolean;
}): EditPlan {
  const { source, segs, oldText, context } = args;
  let newText = args.newText.replace(/\u00a0/g, " ");
  // A line break with nothing after it can't be written in Markdown (trailing
  // hard-break spaces at the end of a block are dropped), and browsers keep a
  // placeholder <br> at the end of an edited block. Neither is content.
  if (!oldText.endsWith("\n")) newText = newText.replace(/\n+$/, "");
  // Likewise a trailing paragraph break outside a list would leave an empty
  // paragraph (in a list it is meaningful: a new, empty bullet).
  if (context.kind !== "listItem" && !oldText.endsWith(PARAGRAPH_BREAK)) {
    newText = newText.replace(/[\n\u2029]+$/, "");
  }
  if (newText === oldText) return { kind: "none" };

  let p = 0;
  while (p < oldText.length && p < newText.length && oldText[p] === newText[p]) p++;
  let s = 0;
  while (
    s < oldText.length - p &&
    s < newText.length - p &&
    oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]
  )
    s++;
  const q = oldText.length - s;
  const inserted = newText.slice(p, newText.length - s);

  if (inserted.includes(ATOM)) return { kind: "unsafe", reason: "atom" };
  if (context.kind === "none" && (inserted.includes("\n") || inserted.includes(PARAGRAPH_BREAK))) {
    return { kind: "unsafe", reason: "breaks-not-allowed" };
  }

  let from: number;
  let to: number;
  if (q > p) {
    const first = segmentIndexAt(segs, p);
    const last = segmentIndexAt(segs, q - 1);
    // A deletion may cross segment boundaries only where the source is
    // contiguous — i.e. no hidden markup (a `**`, a `_`) sits between them.
    // Crossing such markup would leave unbalanced syntax.
    for (let i = first; i < last; i++) {
      if (segEnd(segs[i]) !== segStart(segs[i + 1])) return { kind: "unsafe", reason: "crosses-formatting" };
    }
    from = sourceAt(segs, p, "right");
    to = sourceAt(segs, q, "left");
  } else {
    // Pure insertion. At a boundary between plain and formatted text, follow
    // where the DOM put the typed characters; otherwise stay on the left.
    let side: "left" | "right" = "left";
    let pos = 0;
    for (let i = 0; i < segs.length - 1; i++) {
      pos += segs[i].text.length;
      if (pos !== p) continue;
      const left = segs[i];
      const right = segs[i + 1];
      const leftStyled = left.kind === "text" && left.styled;
      const rightStyled = right.kind === "text" && right.styled;
      if (args.insertedStyled && rightStyled && !leftStyled) side = "right";
      if (!args.insertedStyled && leftStyled && !rightStyled) side = "right";
      break;
    }
    from = to = sourceAt(segs, p, side);
  }

  // Build the inserted source.
  const before = from > 0 ? source[from - 1] : undefined;
  const after = source[to];
  const lineStart = from === 0 || source[from - 1] === "\n";
  let insert = "";
  let focusOffsetInInsert: number | null = null;
  const pieces = inserted.split(/(\n|\u2029)/);
  let atLineStart = lineStart;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece === "\n") {
      insert += `  \n${context.continuation}`;
      atLineStart = true;
    } else if (piece === PARAGRAPH_BREAK) {
      if (context.kind === "listItem") {
        insert += `\n${context.linePrefix}`;
      } else {
        const blank = context.continuation.replace(/[ \t]+$/, "");
        insert += `\n${blank}\n${context.continuation}`;
      }
      focusOffsetInInsert = insert.length;
      atLineStart = true;
    } else if (piece) {
      const prevChar = insert ? insert[insert.length - 1] : before;
      const nextChar = i === pieces.length - 1 ? after : undefined;
      insert += escapeTyped(piece, prevChar, nextChar, atLineStart);
      atLineStart = false;
    }
  }
  // The text split off by Enter must not keep leading blanks (they'd shift the
  // new block's start) — and a heading's second half becomes a paragraph.
  if (focusOffsetInInsert !== null && focusOffsetInInsert === insert.length) {
    const rest = source.slice(to);
    const trimmed = rest.match(/^[ \t]*/)?.[0].length ?? 0;
    to += trimmed;
  }
  return { kind: "splice", from, to, insert, focusOffsetInInsert };
}

/** Apply a splice; `focusAt` is where the caret belongs after a split. */
export function applyPlan(
  source: string,
  plan: Extract<EditPlan, { kind: "splice" }>
): { source: string; focusAt: number | null } {
  const next = source.slice(0, plan.from) + plan.insert + source.slice(plan.to);
  return {
    source: next,
    focusAt: plan.focusOffsetInInsert === null ? null : plan.from + plan.focusOffsetInInsert,
  };
}

/** Replace a formula's TeX while keeping its original `$` / `$$` delimiters and layout. */
export function rewriteMath(originalSlice: string, tex: string): string {
  const open = originalSlice.match(/^\$+/)?.[0] ?? "$";
  const close = originalSlice.match(/\$+$/)?.[0] ?? open;
  const ownLines = open.length >= 2 && originalSlice.slice(open.length).startsWith("\n");
  return ownLines ? `${open}\n${tex.trim()}\n${close}` : `${open}${tex.trim()}${close}`;
}

/** Markdown for text typed into a new (draft) paragraph or heading. */
export function draftToMarkdown(text: string, kind: "paragraph" | "heading"): string {
  const lines = text.replace(/ /g, " ").replace(/\r\n?/g, "\n").split("\n");
  const body = lines
    .map((line, i) => escapeTyped(line, i === 0 ? undefined : "\n", undefined, true))
    .join("  \n");
  return kind === "heading" ? `## ${body.replace(/ {2}\n/g, " ")}` : body;
}
