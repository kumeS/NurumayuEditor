// Markdown text chunk → slide paragraphs (BUG-020). Pure and deterministic.
//
// DUAL IMPLEMENTATION: this is the TS twin of src-tauri/src/slidetext.rs (the
// PPTX/CLI side). Both are locked by ONE golden fixture,
// src-tauri/tests/fixtures/slide_paragraphs.golden.json, read by
// src/slideText.test.ts and slidetext.rs's tests — change both in lockstep,
// function by function (the Rust file mirrors these names in snake_case).
//
// What it handles (a CommonMark subset, agreeing with the Markdown Preview's
// react-markdown on the inline cases the fixture marks `oracle`):
// - Each list item (`-`, `*`, `+`, `N.`, `N)`) is its own paragraph with the
//   marker stripped; nesting depth comes from indentation. Numbered items keep
//   their marker as `label`. A blank line, quote or fence ends a list item;
//   other lines continue it (soft break).
// - A plain paragraph is one bullet; soft and hard line breaks are kept as "\n"
//   inside run text.
// - Fenced code (``` or ~~~, any longer fence, unclosed → to the end) becomes
//   one `code` paragraph per line, without fences or info string.
// - `>` quotes are stripped (depth → level) and become `quote` paragraphs.
// - Inline: **bold**/__bold__, *italic*/_italic_ with CommonMark flanking and
//   the rule of 3; `code` spans; [text](url "title") and <scheme:…> autolinks
//   (runs carry `href`); backslash escapes removed.
// - Tables and HTML blocks stay as raw text, one `plain` monospace paragraph per
//   line. Thematic breaks (---, * * *) are dropped (they carry no text).
// Known limits (planned): structured tables, inline images (`![a](u)` stays
// literal text), strikethrough, entity references, reference-style links,
// indented code blocks, lists inside quotes, setext headings.

export type SlideParaKind = "bullet" | "numbered" | "code" | "quote" | "plain";

/** A styled span. Flags are present only when true; `href` only on links. */
export interface SlideRun {
  text: string;
  bold?: true;
  italic?: true;
  code?: true;
  href?: string;
}

export interface SlidePara {
  kind: SlideParaKind;
  /** Nesting depth (list indentation / quote depth), 0-based, capped at 8. */
  level: number;
  /** The numbered marker as written ("1.", "3)"); only on `numbered`. */
  label?: string;
  runs: SlideRun[];
}

const MAX_LEVEL = 8;

// ---- character classes (micromark semantics) --------------------------------

const PUNCT_RE = /[\p{P}\p{S}]/u;

/**
 * Unicode punctuation as micromark sees it: General Category P or S, tested per
 * UTF-16 unit, so astral code points (emoji) never count. Rust mirrors this
 * with a generated table (PUNCT_RANGES), checked against this predicate.
 */
export function isPunct(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return cp <= 0xffff && PUNCT_RE.test(ch);
}

/** Unicode whitespace for flanking: tab, LF, FF, CR and category Zs. */
export function isWs(ch: string): boolean {
  if (ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r" || ch === " ") return true;
  const cp = ch.codePointAt(0) ?? 0;
  return (
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

function isAsciiPunct(ch: string | undefined): boolean {
  return ch !== undefined && ch.length === 1 && "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".includes(ch);
}

function isAsciiAlpha(ch: string | undefined): boolean {
  return ch !== undefined && /^[A-Za-z]$/.test(ch);
}

function isAsciiAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /^[A-Za-z0-9]$/.test(ch);
}

// ---- inline parsing -----------------------------------------------------------

type Item =
  | { t: "text"; text: string; code: boolean }
  | { t: "delim"; ch: string; count: number; orig: number; canOpen: boolean; canClose: boolean }
  | { t: "link"; runs: SlideRun[]; href: string };

/** Length of the run of `ch` starting at `i`. */
function runLen(cs: string[], i: number, ch: string): number {
  let k = 0;
  while (i + k < cs.length && cs[i + k] === ch) k++;
  return k;
}

/** Start index of the next backtick run of exactly `k` at or after `from`, or -1. */
function findBacktickRun(cs: string[], from: number, k: number): number {
  let p = from;
  while (p < cs.length) {
    if (cs[p] === "`") {
      const m = runLen(cs, p, "`");
      if (m === k) return p;
      p += m;
    } else {
      p++;
    }
  }
  return -1;
}

/** micromark's limit on nested parentheses in a link destination. */
const MAX_DEST_PARENS = 32;

/**
 * Index of the `]` closing the `[` at `start`, or -1. One scan resolves every
 * `[` it passes (a scan from an inner `[` would continue identically), so the
 * per-parse `cache` keeps unmatched brackets linear instead of quadratic.
 */
function findBracketClose(cs: string[], start: number, cache: Map<number, number>): number {
  const hit = cache.get(start);
  if (hit !== undefined) return hit;
  const stack: number[] = [];
  let j = start;
  while (j < cs.length) {
    const c = cs[j];
    if (c === "\\" && j + 1 < cs.length) {
      j += 2;
      continue;
    }
    if (c === "`") {
      const k = runLen(cs, j, "`");
      const p = findBacktickRun(cs, j + k, k);
      j = p >= 0 ? p + k : j + k;
      continue;
    }
    if (c === "[") stack.push(j);
    else if (c === "]" && stack.length > 0) {
      const open = stack.pop() as number;
      cache.set(open, j);
      if (open === start) return j;
    }
    j++;
  }
  for (const open of stack) cache.set(open, -1);
  return -1;
}

function skipLinkWs(cs: string[], p: number): number {
  while (p < cs.length && (cs[p] === " " || cs[p] === "\t" || cs[p] === "\n")) p++;
  return p;
}

/**
 * Parse `[text](dest "title")` starting at the `[` at `start`. Returns the
 * index after `)`, the text span and the destination, or null.
 */
function parseLinkTail(
  cs: string[],
  start: number,
  cache: Map<number, number>
): { end: number; textStart: number; textEnd: number; href: string } | null {
  const close = findBracketClose(cs, start, cache);
  if (close < 0) return null;
  if (cs[close + 1] !== "(") return null;
  let p = skipLinkWs(cs, close + 2);
  let href = "";
  if (cs[p] === "<") {
    p++;
    while (p < cs.length && cs[p] !== ">") {
      if (cs[p] === "\n" || cs[p] === "<") return null;
      if (cs[p] === "\\" && isAsciiPunct(cs[p + 1])) {
        href += cs[p + 1];
        p += 2;
        continue;
      }
      href += cs[p];
      p++;
    }
    if (p >= cs.length) return null;
    p++;
  } else {
    let parens = 0;
    while (p < cs.length) {
      const c = cs[p];
      if (c === "\\" && isAsciiPunct(cs[p + 1])) {
        href += cs[p + 1];
        p += 2;
        continue;
      }
      if (c === " " || c === "\t" || c === "\n" || (c.codePointAt(0) ?? 0) < 0x20) break;
      if (c === "(") {
        if (parens >= MAX_DEST_PARENS) return null;
        parens++;
      }
      if (c === ")") {
        if (parens === 0) break;
        parens--;
      }
      href += c;
      p++;
    }
    if (parens !== 0) return null;
  }
  const afterDest = p;
  p = skipLinkWs(cs, p);
  if (p > afterDest && (cs[p] === '"' || cs[p] === "'" || cs[p] === "(")) {
    const closing = cs[p] === "(" ? ")" : cs[p];
    let q = p + 1;
    while (q < cs.length && cs[q] !== closing) {
      if (cs[q] === "\\") q++;
      q++;
    }
    if (q >= cs.length) return null;
    p = skipLinkWs(cs, q + 1);
  }
  if (cs[p] !== ")") return null;
  return { end: p + 1, textStart: start + 1, textEnd: close, href };
}

/** `<scheme:…>` autolink at `start` (the `<`): index after `>` and the URL, or null. */
function parseAutolink(cs: string[], start: number): { end: number; url: string } | null {
  let p = start + 1;
  if (!isAsciiAlpha(cs[p])) return null;
  let n = 0;
  while (p < cs.length && (isAsciiAlnum(cs[p]) || cs[p] === "+" || cs[p] === "." || cs[p] === "-")) {
    p++;
    n++;
  }
  if (n < 2 || n > 32 || cs[p] !== ":") return null;
  while (p < cs.length && cs[p] !== ">") {
    const c = cs[p];
    if (c === " " || c === "<" || (c.codePointAt(0) ?? 0) < 0x20) return null;
    p++;
  }
  if (p >= cs.length) return null;
  return { end: p + 1, url: cs.slice(start + 1, p).join("") };
}

function pushText(items: Item[], text: string) {
  const last = items[items.length - 1];
  if (last && last.t === "text" && !last.code) last.text += text;
  else items.push({ t: "text", text, code: false });
}

function sameFormat(a: SlideRun, b: SlideRun): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.href === b.href;
}

function makeRun(text: string, bold: boolean, italic: boolean, code: boolean, href?: string): SlideRun {
  const r: SlideRun = { text };
  if (bold) r.bold = true;
  if (italic) r.italic = true;
  if (code) r.code = true;
  if (href !== undefined) r.href = href;
  return r;
}

/** Inline Markdown → runs. `cs` is a code-point array; its ends count as whitespace. */
function parseInline(cs: string[], allowLinks: boolean): SlideRun[] {
  const items: Item[] = [];
  const brackets = new Map<number, number>();
  let i = 0;
  while (i < cs.length) {
    const c = cs[i];
    if (c === "\\") {
      if (isAsciiPunct(cs[i + 1])) {
        pushText(items, cs[i + 1]);
        i += 2;
      } else if (cs[i + 1] === "\n") {
        pushText(items, "\n");
        i += 2;
      } else {
        pushText(items, "\\");
        i++;
      }
      continue;
    }
    if (c === "`") {
      const k = runLen(cs, i, "`");
      const p = findBacktickRun(cs, i + k, k);
      if (p >= 0) {
        let content = cs.slice(i + k, p).map((x) => (x === "\n" ? " " : x));
        if (
          content.length >= 2 &&
          content[0] === " " &&
          content[content.length - 1] === " " &&
          content.some((x) => x !== " ")
        ) {
          content = content.slice(1, -1);
        }
        items.push({ t: "text", text: content.join(""), code: true });
        i = p + k;
      } else {
        pushText(items, "`".repeat(k));
        i += k;
      }
      continue;
    }
    if (c === "!" && cs[i + 1] === "[") {
      // Inline images stay literal (planned) — never reduced to their alt text.
      const img = parseLinkTail(cs, i + 1, brackets);
      if (img) {
        pushText(items, cs.slice(i, img.end).join(""));
        i = img.end;
      } else {
        pushText(items, "!");
        i++;
      }
      continue;
    }
    if (c === "[" && allowLinks) {
      const link = parseLinkTail(cs, i, brackets);
      if (link) {
        items.push({
          t: "link",
          runs: parseInline(cs.slice(link.textStart, link.textEnd), false),
          href: link.href,
        });
        i = link.end;
      } else {
        pushText(items, "[");
        i++;
      }
      continue;
    }
    if (c === "<" && allowLinks) {
      const auto = parseAutolink(cs, i);
      if (auto) {
        items.push({ t: "link", runs: [{ text: auto.url }], href: auto.url });
        i = auto.end;
      } else {
        pushText(items, "<");
        i++;
      }
      continue;
    }
    if (c === "*" || c === "_") {
      const k = runLen(cs, i, c);
      const prev = i > 0 ? cs[i - 1] : undefined;
      const next = i + k < cs.length ? cs[i + k] : undefined;
      const prevWs = prev === undefined || isWs(prev);
      const nextWs = next === undefined || isWs(next);
      const prevP = prev !== undefined && isPunct(prev);
      const nextP = next !== undefined && isPunct(next);
      const left = !nextWs && (!nextP || prevWs || prevP);
      const right = !prevWs && (!prevP || nextWs || nextP);
      const canOpen = c === "*" ? left : left && (!right || prevP);
      const canClose = c === "*" ? right : right && (!left || nextP);
      items.push({ t: "delim", ch: c, count: k, orig: k, canOpen, canClose });
      i += k;
      continue;
    }
    pushText(items, c);
    i++;
  }

  // CommonMark "process emphasis" over the delimiter items.
  const dl: number[] = [];
  items.forEach((it, idx) => {
    if (it.t === "delim") dl.push(idx);
  });
  const alive = dl.map(() => true);
  const ranges: [number, number, number][] = [];
  // CommonMark `openers_bottom`: after a failed search, later closers with the
  // same (char, canOpen, orig % 3) never re-scan those openers (keeps it linear).
  const bottom = new Map<string, number>();
  let ci = 0;
  while (ci < dl.length) {
    const closer = items[dl[ci]] as Extract<Item, { t: "delim" }>;
    if (!alive[ci] || !closer.canClose || closer.count === 0) {
      ci++;
      continue;
    }
    const key = `${closer.ch}${closer.canOpen ? 1 : 0}${closer.orig % 3}`;
    let found = -1;
    for (let oi = ci - 1; oi > (bottom.get(key) ?? -1); oi--) {
      if (!alive[oi]) continue;
      const o = items[dl[oi]] as Extract<Item, { t: "delim" }>;
      if (o.ch !== closer.ch || !o.canOpen || o.count === 0) continue;
      if (
        (o.canClose || closer.canOpen) &&
        (o.orig + closer.orig) % 3 === 0 &&
        !(o.orig % 3 === 0 && closer.orig % 3 === 0)
      ) {
        continue;
      }
      found = oi;
      break;
    }
    if (found >= 0) {
      const o = items[dl[found]] as Extract<Item, { t: "delim" }>;
      const use = o.count >= 2 && closer.count >= 2 ? 2 : 1;
      ranges.push([dl[found], dl[ci], use]);
      o.count -= use;
      closer.count -= use;
      for (let k = found + 1; k < ci; k++) alive[k] = false;
      if (o.count === 0) alive[found] = false;
      if (closer.count === 0) {
        alive[ci] = false;
        ci++;
      }
    } else {
      bottom.set(key, ci - 1);
      if (!closer.canOpen) alive[ci] = false;
      ci++;
    }
  }

  const runs: SlideRun[] = [];
  const push = (r: SlideRun) => {
    if (r.text === "") return;
    const last = runs[runs.length - 1];
    if (last && sameFormat(last, r)) last.text += r.text;
    else runs.push(r);
  };
  // Items strictly inside a matched pair take its style: a linear prefix sum
  // over (opener, closer) boundaries (pairs nest or are disjoint).
  const boldDiff = new Array<number>(items.length + 1).fill(0);
  const italicDiff = new Array<number>(items.length + 1).fill(0);
  for (const [o, c, u] of ranges) {
    const diff = u === 2 ? boldDiff : italicDiff;
    diff[o + 1]++;
    diff[c]--;
  }
  let boldDepth = 0;
  let italicDepth = 0;
  items.forEach((it, idx) => {
    boldDepth += boldDiff[idx];
    italicDepth += italicDiff[idx];
    const bold = boldDepth > 0;
    const italic = italicDepth > 0;
    if (it.t === "text") push(makeRun(it.text, bold, italic, it.code));
    else if (it.t === "delim") push(makeRun(it.ch.repeat(it.count), bold, italic, false));
    else {
      for (const r of it.runs) {
        push(makeRun(r.text, bold || !!r.bold, italic || !!r.italic, !!r.code, it.href));
      }
    }
  });
  return runs;
}

// ---- block parsing ------------------------------------------------------------

interface Pending {
  kind: SlideParaKind;
  level: number;
  label?: string;
  lines: string[];
  isItem: boolean;
  quoteDepth: number;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** The line's leading-space count when it is at most 3; -1 when indented further. */
function smallIndent(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n <= 3 ? n : -1;
}

function fenceOpen(line: string): { ch: string; len: number; indent: number } | null {
  const indent = smallIndent(line);
  if (indent < 0) return null;
  const ch = line[indent];
  if (ch !== "`" && ch !== "~") return null;
  const cs = Array.from(line);
  const len = runLen(cs, indent, ch);
  if (len < 3) return null;
  if (ch === "`" && cs.slice(indent + len).includes("`")) return null;
  return { ch, len, indent };
}

function isFenceClose(line: string, ch: string, len: number): boolean {
  const indent = smallIndent(line);
  if (indent < 0) return false;
  const cs = Array.from(line);
  const k = runLen(cs, indent, ch);
  return k >= len && cs.slice(indent + k).every((c) => c === " " || c === "\t");
}

function stripIndent(line: string, n: number): string {
  let k = 0;
  while (k < n && line[k] === " ") k++;
  return line.slice(k);
}

function isThematicBreak(line: string): boolean {
  if (smallIndent(line) < 0) return false;
  const cs = Array.from(line).filter((c) => c !== " " && c !== "\t");
  return cs.length >= 3 && (cs[0] === "-" || cs[0] === "*" || cs[0] === "_") && cs.every((c) => c === cs[0]);
}

function isDelimRow(line: string): boolean {
  const t = line.trim();
  return (
    t !== "" &&
    t.includes("|") &&
    t.includes("-") &&
    Array.from(t).every((c) => c === "|" || c === "-" || c === ":" || c === " " || c === "\t")
  );
}

function isHtmlStart(line: string): boolean {
  const indent = smallIndent(line);
  if (indent < 0) return false;
  const cs = Array.from(line.slice(indent));
  if (cs[0] !== "<") return false;
  if (cs[1] === "!" || cs[1] === "?") return true;
  let p = cs[1] === "/" ? 2 : 1;
  if (!isAsciiAlpha(cs[p])) return false;
  while (isAsciiAlnum(cs[p]) || cs[p] === "-") p++;
  const next = cs[p];
  return next === undefined || next === " " || next === "\t" || next === ">" || next === "/";
}

interface ListItem {
  indent: number;
  label?: string;
  number: number;
  content: string;
}

function listItem(line: string): ListItem | null {
  let w = 0;
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    w = line[i] === "\t" ? w + 4 - (w % 4) : w + 1;
    i++;
  }
  const rest = line.slice(i);
  const c = rest[0];
  if (c === "-" || c === "*" || c === "+") {
    const after = rest[1];
    if (after !== undefined && after !== " " && after !== "\t") return null;
    return { indent: w, number: 0, content: rest.slice(1).trim() };
  }
  let d = 0;
  while (d < rest.length && d < 9 && rest[d] >= "0" && rest[d] <= "9") d++;
  if (d === 0) return null;
  const delim = rest[d];
  if (delim !== "." && delim !== ")") return null;
  const after = rest[d + 1];
  if (after !== undefined && after !== " " && after !== "\t") return null;
  return {
    indent: w,
    label: rest.slice(0, d + 1),
    number: parseInt(rest.slice(0, d), 10),
    content: rest.slice(d + 1).trim(),
  };
}

function quoteLine(line: string): { depth: number; content: string } | null {
  let rest = line;
  let depth = 0;
  for (;;) {
    const indent = smallIndent(rest);
    if (indent < 0 || rest[indent] !== ">") break;
    rest = rest.slice(indent + 1);
    if (rest[0] === " " || rest[0] === "\t") rest = rest.slice(1);
    depth++;
  }
  return depth === 0 ? null : { depth, content: rest };
}

function levelFor(stack: number[], indent: number): number {
  while (stack.length > 0 && stack[stack.length - 1] >= indent) stack.pop();
  const level = Math.min(stack.length, MAX_LEVEL);
  stack.push(indent);
  return level;
}

function flush(pending: Pending | null, out: SlidePara[]) {
  if (!pending) return;
  const text = pending.lines.map((l) => l.trim()).join("\n");
  const runs = parseInline(Array.from(text), true);
  if (runs.length === 0) return;
  const { kind, level, label } = pending;
  out.push(label !== undefined ? { kind, level, label, runs } : { kind, level, runs });
}

/** Convert one text chunk (raw Markdown) into slide paragraphs. */
export function chunkToParagraphs(text: string): SlidePara[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: SlidePara[] = [];
  let pending: Pending | null = null;
  const stack: number[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = fenceOpen(line);
    if (fence) {
      flush(pending, out);
      pending = null;
      stack.length = 0;
      i++;
      while (i < lines.length) {
        if (isFenceClose(lines[i], fence.ch, fence.len)) {
          i++;
          break;
        }
        const code = stripIndent(lines[i], fence.indent);
        out.push({ kind: "code", level: 0, runs: code === "" ? [] : [{ text: code }] });
        i++;
      }
      continue;
    }
    if (isBlank(line)) {
      flush(pending, out);
      pending = null;
      i++;
      continue;
    }
    if (isThematicBreak(line)) {
      flush(pending, out);
      pending = null;
      stack.length = 0;
      i++;
      continue;
    }
    if (
      pending === null &&
      ((line.includes("|") && i + 1 < lines.length && isDelimRow(lines[i + 1])) || isHtmlStart(line))
    ) {
      stack.length = 0;
      while (i < lines.length && !isBlank(lines[i])) {
        out.push({ kind: "plain", level: 0, runs: [{ text: lines[i].trimEnd(), code: true }] });
        i++;
      }
      continue;
    }
    const item = listItem(line);
    if (item) {
      const interrupts =
        pending === null ||
        pending.isItem ||
        pending.quoteDepth > 0 ||
        (item.content !== "" && (item.label === undefined || item.number === 1));
      if (interrupts) {
        flush(pending, out);
        const level = levelFor(stack, item.indent);
        pending = {
          kind: item.label === undefined ? "bullet" : "numbered",
          level,
          label: item.label,
          lines: [item.content],
          isItem: true,
          quoteDepth: 0,
        };
        i++;
        continue;
      }
    }
    const quote = quoteLine(line);
    if (quote) {
      if (pending && pending.quoteDepth === quote.depth && !isBlank(quote.content)) {
        pending.lines.push(quote.content);
      } else {
        flush(pending, out);
        pending = null;
        stack.length = 0;
        if (!isBlank(quote.content)) {
          pending = {
            kind: "quote",
            level: Math.min(quote.depth - 1, MAX_LEVEL),
            lines: [quote.content],
            isItem: false,
            quoteDepth: quote.depth,
          };
        }
      }
      i++;
      continue;
    }
    if (pending) {
      pending.lines.push(line);
    } else {
      stack.length = 0;
      pending = { kind: "bullet", level: 0, lines: [line], isItem: false, quoteDepth: 0 };
    }
    i++;
  }
  flush(pending, out);
  return out;
}

// ---- shared helpers for renderers and the overflow heuristic ------------------

/**
 * Whether a run's `href` is rendered as a link: web and mail targets only.
 * Anything else (javascript:, relative paths, anchors, file:) renders as plain
 * text in the preview AND the PPTX (which counts it in a warning). Mirrors
 * slidetext.rs `is_clickable_href` (golden `clickable` cases).
 */
export function isClickableHref(href: string): boolean {
  const h = href.trim().toLowerCase();
  return h.startsWith("http://") || h.startsWith("https://") || h.startsWith("mailto:");
}

/** The text a reader sees: a numbered label + space, then the runs' text. */
export function visibleText(p: SlidePara): string {
  return (p.label !== undefined ? `${p.label} ` : "") + p.runs.map((r) => r.text).join("");
}

/**
 * Estimated rendered line count at `cpl` characters per line: each "\n"
 * segment of each paragraph's visible text takes max(1, ceil(chars / cpl))
 * lines (code points). Mirrors slidetext.rs `paragraph_lines`; the rail's
 * overflow badge and the PPTX overflow warning both use it.
 */
export function paragraphLines(paras: SlidePara[], cpl: number): number {
  let lines = 0;
  for (const p of paras) {
    for (const seg of visibleText(p).split("\n")) {
      lines += Math.max(1, Math.ceil(Array.from(seg).length / cpl));
    }
  }
  return lines;
}

export type SlideBlock = { type: "para"; para: SlidePara } | { type: "code"; lines: SlidePara[] };

/** Preview-only grouping: adjacent `code` paragraphs render as one code block. */
export function groupSlideBlocks(paras: SlidePara[]): SlideBlock[] {
  const blocks: SlideBlock[] = [];
  for (const para of paras) {
    const last = blocks[blocks.length - 1];
    if (para.kind === "code") {
      if (last && last.type === "code") last.lines.push(para);
      else blocks.push({ type: "code", lines: [para] });
    } else {
      blocks.push({ type: "para", para });
    }
  }
  return blocks;
}
