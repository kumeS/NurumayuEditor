import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  chunkToParagraphs,
  groupSlideBlocks,
  isClickableHref,
  isPunct,
  isWs,
  paragraphLines,
  visibleText,
  type SlidePara,
  type SlideRun,
} from "./slideText";
import { SlideContent } from "./components/SlideEditor";
import type { Chunk } from "./types";

// BUG-020 dual implementation: src/slideText.ts (preview/Present) and
// src-tauri/src/slidetext.rs (PPTX export, CLI) read the SAME golden fixture.
// slidetext.rs::tests::golden_contract asserts the Rust side; this file the TS
// side, plus a react-markdown oracle (the Markdown Preview renderer) for the
// inline-only cases.

function rawGlob(record: Record<string, unknown>): string {
  return Object.values(record)[0] as string;
}

const golden = JSON.parse(
  rawGlob(
    import.meta.glob("../src-tauri/tests/fixtures/slide_paragraphs.golden.json", {
      eager: true,
      query: "?raw",
      import: "default",
    })
  )
) as {
  cases: { name: string; input: string; oracle?: boolean; expected: SlidePara[] }[];
  lines: { name: string; input: string; cpl: number; expected: number }[];
  clickable: { href: string; expected: boolean }[];
};

describe("chunkToParagraphs — golden contract with Rust slidetext.rs", () => {
  it("the fixture is loaded and non-trivial", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(30);
    expect(golden.lines.length).toBeGreaterThanOrEqual(5);
  });

  for (const c of golden.cases) {
    it(c.name, () => {
      expect(chunkToParagraphs(c.input)).toEqual(c.expected);
    });
  }

  it("never serializes a false flag or an absent label/href (shape is part of the contract)", () => {
    for (const c of golden.cases) {
      const json = JSON.stringify(chunkToParagraphs(c.input));
      expect(json, c.name).not.toMatch(/:false\b|:null\b|"label":undefined/);
    }
  });
});

describe("paragraphLines — the overflow count shared by the rail badge and the PPTX warning", () => {
  for (const c of golden.lines) {
    it(c.name, () => {
      expect(paragraphLines(chunkToParagraphs(c.input), c.cpl)).toBe(c.expected);
    });
  }

  it("visibleText includes a numbered label but never Markdown markers or URLs", () => {
    const [p] = chunkToParagraphs("3. **太字**と[リンク](https://example.com)");
    expect(visibleText(p)).toBe("3. 太字とリンク");
  });
});

describe("isClickableHref — which links both renderers treat as links", () => {
  it("the fixture lists both kinds", () => {
    expect(golden.clickable.some((c) => c.expected)).toBe(true);
    expect(golden.clickable.some((c) => !c.expected)).toBe(true);
  });
  for (const c of golden.clickable) {
    it(JSON.stringify(c.href), () => {
      expect(isClickableHref(c.href)).toBe(c.expected);
    });
  }
});

// ---- react-markdown oracle (the Markdown Preview renderer) -----------------

type Tok = { close: boolean; tag: string; attrs: string } | { text: string };

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function tokens(html: string): Tok[] {
  const out: Tok[] = [];
  const re = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) out.push({ text: decode(m[4]) });
    else out.push({ close: m[1] === "/", tag: m[2], attrs: m[3] });
  }
  return out;
}

/** Outermost `<tag>` inner texts (plus href for `a`), in document order. */
function htmlSegments(toks: Tok[], tag: string): string[] {
  const segs: string[] = [];
  let depth = 0;
  let cur = "";
  let href = "";
  for (const t of toks) {
    if ("text" in t) {
      if (depth > 0) cur += t.text;
    } else if (t.tag === tag) {
      if (!t.close) {
        if (depth === 0) {
          cur = "";
          href = decode(/href="([^"]*)"/.exec(t.attrs)?.[1] ?? "");
        }
        depth++;
      } else {
        depth--;
        if (depth === 0) segs.push(tag === "a" ? `${cur} -> ${href}` : cur);
      }
    }
  }
  return segs;
}

/** Maximal runs of consecutive runs sharing a flag (or the same href). */
function runSegments(runs: SlideRun[], key: "bold" | "italic" | "code" | "href"): string[] {
  const segs: string[] = [];
  let cur = "";
  let curHref: string | undefined;
  let open = false;
  const close = () => {
    if (open) segs.push(key === "href" ? `${cur} -> ${curHref}` : cur);
    open = false;
    cur = "";
  };
  for (const r of runs) {
    const on = key === "href" ? r.href !== undefined : !!r[key];
    if (!on || (key === "href" && open && r.href !== curHref)) close();
    if (on) {
      open = true;
      curHref = r.href;
      cur += r.text;
    }
  }
  close();
  return segs;
}

describe("react-markdown oracle — Slides agree with the Markdown Preview on inline formatting", () => {
  const oracleCases = golden.cases.filter((c) => c.oracle);

  it("covers the CJK emphasis cases", () => {
    const inputs = oracleCases.map((c) => c.input);
    expect(inputs).toEqual(
      expect.arrayContaining(["の**太字**と", "「**強調**」の", "**「強調」**の"])
    );
  });

  for (const c of oracleCases) {
    it(c.input, () => {
      const html = renderToStaticMarkup(
        createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, c.input)
      );
      const toks = tokens(html);
      const paras = chunkToParagraphs(c.input);
      expect(paras).toHaveLength(1);
      const runs = paras[0].runs;
      const htmlText = toks.map((t) => ("text" in t ? t.text : "")).join("");
      expect(runs.map((r) => r.text).join("")).toBe(htmlText);
      expect(runSegments(runs, "bold")).toEqual(htmlSegments(toks, "strong"));
      expect(runSegments(runs, "italic")).toEqual(htmlSegments(toks, "em"));
      expect(runSegments(runs, "code")).toEqual(htmlSegments(toks, "code"));
      expect(runSegments(runs, "href")).toEqual(htmlSegments(toks, "a"));
    });
  }
});

// ---- character classes: TS uses the regex, Rust a generated table ---------

const rustSource = rawGlob(
  import.meta.glob("../src-tauri/src/slidetext.rs", {
    eager: true,
    query: "?raw",
    import: "default",
  })
);

describe("character classes (micromark semantics, locked across TS and Rust)", () => {
  it("isPunct is Unicode P|S on the BMP and false for astral code points (micromark checks UTF-16 units)", () => {
    expect(isPunct("「")).toBe(true);
    expect(isPunct("・")).toBe(true);
    expect(isPunct("€")).toBe(true);
    expect(isPunct("ー")).toBe(false);
    expect(isPunct("々")).toBe(false);
    expect(isPunct("😀")).toBe(false);
  });

  it("isWs is tab/LF/FF/CR plus Unicode Zs (U+3000 included)", () => {
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCharCode(cp);
      expect(isWs(ch), cp.toString(16)).toBe(/[\t\n\f\r\p{Zs}]/u.test(ch));
    }
  });

  it("Rust PUNCT_RANGES equals the TS punctuation predicate on every BMP code point", () => {
    const start = rustSource.indexOf("const PUNCT_RANGES");
    expect(start, "PUNCT_RANGES missing from slidetext.rs").toBeGreaterThan(-1);
    const body = rustSource.slice(start, rustSource.indexOf("];", start));
    const ranges = [...body.matchAll(/\(0x([0-9A-F]+), 0x([0-9A-F]+)\)/g)].map((m) => [
      parseInt(m[1], 16),
      parseInt(m[2], 16),
    ]);
    expect(ranges.length).toBeGreaterThan(100);
    const inRust = (cp: number) => ranges.some(([a, b]) => cp >= a && cp <= b);
    const mismatches: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (inRust(cp) !== isPunct(String.fromCharCode(cp))) mismatches.push(cp.toString(16));
    }
    expect(mismatches).toEqual([]);
  });

  it("Rust is_ws lists the same whitespace set", () => {
    const fn = rustSource.slice(rustSource.indexOf("fn is_ws("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    for (const lit of ["'\\t'", "'\\n'", "'\\u{C}'", "'\\r'", "' '", "'\\u{A0}'", "'\\u{1680}'",
      "'\\u{2000}'..='\\u{200A}'", "'\\u{202F}'", "'\\u{205F}'", "'\\u{3000}'"]) {
      expect(body, lit).toContain(lit);
    }
  });
});

// ---- preview grouping -------------------------------------------------------

describe("groupSlideBlocks — consecutive code lines render as one block in the preview", () => {
  it("groups adjacent code paragraphs and keeps everything else one per block", () => {
    const paras = chunkToParagraphs("前\n\n```\na\n\nb\n```\n\n後");
    const blocks = groupSlideBlocks(paras);
    expect(blocks.map((b) => (b.type === "code" ? `code:${b.lines.length}` : b.para.kind))).toEqual([
      "bullet",
      "code:3",
      "bullet",
    ]);
  });
});

// ---- wiring guards (no DOM in this suite) -----------------------------------

const componentRaw = import.meta.glob(
  ["./components/SlideEditor.tsx", "./slides.ts"],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;
const slideEditor = componentRaw["./components/SlideEditor.tsx"];
const slidesTs = componentRaw["./slides.ts"];

function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n(?:export |function |const |interface |\/\*\*|\/\/ )/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("wiring: the slide surfaces render converted paragraphs, never raw Markdown", () => {
  it("SlideContent renders slideParagraphs (not slideBullets) through the run renderer", () => {
    const s = fnBody(slideEditor, "SlideContent");
    expect(s).toMatch(/const paras = slideParagraphs\(slide\);/);
    expect(s).not.toMatch(/slideBullets\(/);
    expect(s).toMatch(/<SlideRuns runs=\{/);
    expect(s).toMatch(/groupSlideBlocks\(paras\)/);
  });

  it("the run renderer never navigates: no href attribute, no raw HTML injection", () => {
    const runs = fnBody(slideEditor, "SlideRuns");
    expect(runs).not.toMatch(/href=/);
    expect(runs).not.toMatch(/<a\b/);
    expect(slideEditor).not.toMatch(/dangerouslySetInnerHTML/);
    expect(runs).toMatch(/r\.bold/);
    expect(runs).toMatch(/r\.italic/);
    expect(runs).toMatch(/r\.code/);
    expect(runs).toMatch(/r\.href/);
    // Only targets the PPTX export makes clickable are styled as links.
    expect(runs).toMatch(/isClickableHref\(r\.href\)/);
  });

  it("slides.ts derives paragraphs and the overflow count from the converter", () => {
    expect(fnBody(slidesTs, "slideParagraphs")).toMatch(/chunkToParagraphs/);
    expect(fnBody(slidesTs, "slideOverflows")).toMatch(/paragraphLines\(slideParagraphs\(s\), cpl\)/);
  });
});

describe("BUG-020 revert-check gap — the slide BODY renders inline runs (rendered, not regex)", () => {
  const c = (id: string, content: string, chunkType: "heading" | "text", level?: number): Chunk => ({
    id,
    order: 0,
    content,
    metadata: { chunkType, linkedChunks: [], ...(level ? { level } : {}) },
  });

  it("bold and link runs in a title-content body list are styled; nothing navigates", () => {
    const items = [c("h", "Title", "heading", 2), c("b", "**太字**と[リンク](https://e.x)", "text")];
    const html = renderToStaticMarkup(
      createElement(SlideContent, { slide: { items, indices: [0, 1] }, layout: "title-content", docTitle: "D" })
    );
    const ul = html.slice(html.indexOf("<ul"), html.indexOf("</ul>") + 5);
    expect(ul.length).toBeGreaterThan(10);
    expect(ul).toMatch(/<span style="font-weight:700">太字<\/span>/);
    expect(ul).toMatch(/<span title="https:\/\/e\.x" style="[^"]*text-decoration:underline[^"]*">リンク<\/span>/);
    expect(ul).not.toMatch(/<a\b/);
    expect(ul).not.toContain("**");
  });
});
