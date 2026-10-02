import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import {
  ATOM,
  PARAGRAPH_BREAK,
  applyPlan,
  blockEnd,
  rewriteMath,
  draftToMarkdown,
  buildSegments,
  inlineRange,
  planTextEdit,
  plainTextOf,
  splitContextFor,
  type HNode,
} from "./previewEditing";
import { PREVIEW_REHYPE_PLUGINS } from "./markdownPreview";

// Real hast, produced by the same remark → rehype pipeline the preview uses,
// so positions and node shapes are the ones the component will see.
function hastOf(markdown: string): HNode {
  let processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkRehype);
  for (const plugin of PREVIEW_REHYPE_PLUGINS) processor = processor.use(plugin as never);
  return processor.runSync(processor.parse(markdown)) as unknown as HNode;
}

/** Every element in document order with the given tag. */
function all(node: HNode, tag: string, out: HNode[] = []): HNode[] {
  if (node.type === "element" && node.tagName === tag) out.push(node);
  for (const child of node.children ?? []) all(child, tag, out);
  return out;
}

/** Simulate typing: replace the block's plain text and splice the source. */
function edit(
  source: string,
  block: HNode,
  newText: (old: string) => string,
  insertedStyled = false
): string | null {
  const segs = buildSegments(block, source);
  if (!segs) return null;
  const old = plainTextOf(segs);
  const plan = planTextEdit({
    source,
    segs,
    oldText: old,
    newText: newText(old),
    context: splitContextFor(block, source),
    insertedStyled,
  });
  return plan.kind === "splice" ? applyPlan(source, plan).source : plan.kind === "none" ? source : null;
}

// Lines taken from the user's note (03_vis_preprint_v2/note_01_vis_v2_図表レビュー.md).
const NOTE = [
  "すべての数値は凍結版の結果です。R1〜R8 を直して回し直すと、図 1〜3 と表 1〜5 のうち、警告なしの誤りや警告のあったモデルに関わる数値が変わります（§11）。",
  "",
  "**結果**",
  "- 層と隠れ次元が分かった 138 本を描いた。約 134 M パラメータでは、層数が 8〜30 層に分かれる。",
  "- 一致した 106 本では、埋め込み以外のパラメータ数と $12Ld^2$ の比の中央値が 1.02 だった。",
  "- 学習パラメータに占める埋め込み＋出力層の割合は、200 M 未満で中央値 37%（n=17）。",
  "  - 軸 1 は、どの 1 項目を抜いても変わらない（全項目との |r| ≥ 0.984）。",
  "",
].join("\n");

describe("buildSegments — rendered text ⇄ exact source offsets", () => {
  it("maps every block of the real note (unedited) back to identical source", () => {
    const hast = hastOf(NOTE);
    for (const block of [...all(hast, "p"), ...all(hast, "li")]) {
      const segs = buildSegments(block, NOTE);
      expect(segs, "block should be mappable").not.toBeNull();
      // No-op edit must leave the source byte-identical.
      expect(edit(NOTE, block, (t) => t)).toBe(NOTE);
    }
  });

  it("treats inline math as one atomic unit", () => {
    const li = all(hastOf(NOTE), "li")[1];
    const text = plainTextOf(buildSegments(li, NOTE)!);
    expect(text).toContain(`パラメータ数と ${ATOM} の比`);
  });

  it("maps backslash escapes and entities", () => {
    const source = "a \\*literal\\* &amp; b\n";
    const p = all(hastOf(source), "p")[0];
    expect(plainTextOf(buildSegments(p, source)!)).toBe("a *literal* & b");
    expect(edit(source, p, (t) => t)).toBe(source);
  });

  it("excludes a list item's nested list and task checkbox from its editable text", () => {
    const source = "- [ ] parent task\n  - child\n";
    const li = all(hastOf(source), "li")[0];
    expect(plainTextOf(buildSegments(li, source)!)).toBe("parent task");
    const range = inlineRange(li)!;
    expect(source.slice(range.from, range.to)).toBe("parent task");
  });
});

describe("inline code and links are atomic (the preview renders them non-editable)", () => {
  const source = "対象は `panel_candidates_v1.tsv` と [資料](https://example.com) です。\n";
  const p = () => all(hastOf(source), "p")[0];

  it("is mappable, and a no-op edit is byte-identical", () => {
    expect(plainTextOf(buildSegments(p(), source)!)).toBe(`対象は ${ATOM} と ${ATOM} です。`);
    expect(edit(source, p(), (t) => t)).toBe(source);
  });

  it("deleting the code span removes the whole `…` (never leaves empty backticks)", () => {
    expect(edit(source, p(), (t) => t.replace(`${ATOM} と`, " と"))).toBe(
      "対象は  と [資料](https://example.com) です。\n"
    );
  });

  it("deleting the link removes the whole [text](url)", () => {
    expect(edit(source, p(), (t) => t.replace(` ${ATOM} です`, " です"))).toBe(
      "対象は `panel_candidates_v1.tsv` と です。\n"
    );
  });

  it("text typed right after the code span lands outside it", () => {
    expect(edit(source, p(), (t) => t.replace(`${ATOM} と`, `${ATOM} を読む と`))).toBe(
      "対象は `panel_candidates_v1.tsv` を読む と [資料](https://example.com) です。\n"
    );
  });
});

describe("empty blocks", () => {
  it("types into an empty bullet right after its marker (never at the start of the file)", () => {
    const source = "intro\n\n- one\n- \n- two\n";
    const li = all(hastOf(source), "li")[1];
    expect(edit(source, li, () => "new")).toBe("intro\n\n- one\n- new\n- two\n");
  });

  it("Enter in an empty bullet adds another bullet with the same marker", () => {
    // A sibling empty item inside an existing nested list (what Enter creates).
    const source = "- top\n  - one\n  - \n";
    const li = all(hastOf(source), "li")[2];
    expect(edit(source, li, () => `a${PARAGRAPH_BREAK}b`)).toBe("- top\n  - one\n  - a\n  - b\n");
  });

  it("leaves an empty table cell read-only rather than guessing a position", () => {
    const source = "| a | |\n|---|---|\n| c | d |\n";
    const empty = all(hastOf(source), "th")[1];
    expect(buildSegments(empty, source)).toBeNull();
  });
});

describe("planTextEdit — only the typed characters change", () => {
  it("inserts CJK inside a list item without touching the math or the marker", () => {
    const li = all(hastOf(NOTE), "li")[1];
    const out = edit(NOTE, li, (t) => t.replace("中央値が", "中央値が約"));
    expect(out).toBe(NOTE.replace("中央値が 1.02", "中央値が約 1.02"));
    expect(out).toContain("$12Ld^2$");
  });

  it("edits a nested list item in place", () => {
    const li = all(hastOf(NOTE), "li")[3];
    const out = edit(NOTE, li, (t) => t.replace("変わらない", "ほぼ変わらない"));
    expect(out).toBe(NOTE.replace("変わらない", "ほぼ変わらない"));
  });

  it("types inside bold text without breaking the ** markers", () => {
    const source = "before **bold word** after\n";
    const p = all(hastOf(source), "p")[0];
    expect(edit(source, p, (t) => t.replace("bold word", "bold big word"))).toBe("before **bold big word** after\n");
  });

  it("at the exact edge of bold, follows where the DOM put the typed text", () => {
    const source = "before **bold** after\n";
    const p = all(hastOf(source), "p")[0];
    const typeAtEdge = (t: string) => t.replace("bold", "very bold");
    // Caret inside <strong> → text goes inside the ** markers …
    expect(edit(source, p, typeAtEdge, true)).toBe("before **very bold** after\n");
    // … caret before it → text stays outside.
    expect(edit(source, p, typeAtEdge, false)).toBe("before very **bold** after\n");
  });

  it("deletes a character at the start and at the end of a block", () => {
    const source = "abcdef\n";
    const p = all(hastOf(source), "p")[0];
    expect(edit(source, p, (t) => t.slice(1))).toBe("bcdef\n");
    expect(edit(source, p, (t) => t.slice(0, -1))).toBe("abcde\n");
  });

  it("escapes Markdown syntax the user typed as literal text", () => {
    const source = "price\n";
    const p = all(hastOf(source), "p")[0];
    expect(edit(source, p, (t) => `${t} *5 [x] $3`)).toBe("price \\*5 \\[x\\] \\$3\n");
  });

  it("does not escape an intraword underscore (snake_case stays readable)", () => {
    const source = "name\n";
    const p = all(hastOf(source), "p")[0];
    expect(edit(source, p, () => "snake_case")).toBe("snake_case\n");
  });

  it("normalizes the no-break spaces WebKit types at the end of a text node", () => {
    const source = "a\n";
    const p = all(hastOf(source), "p")[0];
    expect(edit(source, p, () => "a\u00a0b")).toBe("a b\n");
  });

  it("refuses an edit that spans formatting (it would leave unbalanced markers)", () => {
    const source = "abc **def** ghi\n";
    const p = all(hastOf(source), "p")[0];
    // Delete "c de" — crosses the opening **.
    expect(edit(source, p, (t) => t.replace("c de", ""))).toBeNull();
  });

  it("refuses to type into a spot that would need to create a new atom", () => {
    const source = "x\n";
    const p = all(hastOf(source), "p")[0];
    expect(edit(source, p, (t) => `${t}${ATOM}`)).toBeNull();
  });
});

describe("line and paragraph breaks (the reported 'joined lines' bug)", () => {
  it("Shift+Enter becomes a Markdown hard break, not a soft one that renders joined", () => {
    const source = "first second\n";
    const p = all(hastOf(source), "p")[0];
    expect(edit(source, p, (t) => t.replace(" second", "\nsecond"))).toBe("first  \nsecond\n");
  });

  it("Shift+Enter at the end of a block, then typing, puts the text on the new line", () => {
    // The DOM carries a trailing placeholder <br> after the typed line.
    const source = "Epsilon\n\nnext\n";
    const p = all(hastOf(source), "p")[0];
    expect(edit(source, p, (t) => `${t}\nsecond line\n`)).toBe("Epsilon  \nsecond line\n\nnext\n");
  });

  it("drops a trailing line break with nothing after it (not representable, no stray blank line)", () => {
    const source = "Epsilon\n\nnext\n";
    const p = all(hastOf(source), "p")[0];
    expect(edit(source, p, (t) => `${t}\n\n`)).toBe(source);
    expect(edit(source, p, (t) => `${t}!\n`)).toBe("Epsilon!\n\nnext\n");
  });

  it("Enter on the empty last line after Shift+Enter never leaves an empty paragraph", () => {
    const source = "Epsilon\n\nnext\n";
    const p = all(hastOf(source), "p")[0];
    expect(edit(source, p, (t) => `${t}\nthird\n${PARAGRAPH_BREAK}`)).toBe("Epsilon  \nthird\n\nnext\n");
  });

  it("a hard break is one line break in the preview text (no duplicate newline after the <br>)", () => {
    const source = "line one  \nline two\n";
    const p = all(hastOf(source), "p")[0];
    expect(plainTextOf(buildSegments(p, source)!)).toBe("line one\nline two");
    expect(edit(source, p, (t) => t.replace("line two", "line 2"))).toBe("line one  \nline 2\n");
  });

  it("keeps an existing hard break intact when editing elsewhere in the paragraph", () => {
    const source = "line one  \nline two\n";
    const p = all(hastOf(source), "p")[0];
    expect(edit(source, p, (t) => t.replace("two", "2"))).toBe("line one  \nline 2\n");
  });

  it("Enter splits a paragraph into two paragraphs", () => {
    const source = "前半の文。後半の文。\n";
    const p = all(hastOf(source), "p")[0];
    expect(edit(source, p, (t) => t.replace("。後", `。${PARAGRAPH_BREAK}後`))).toBe("前半の文。\n\n後半の文。\n");
  });

  it("Enter in a list item starts a new bullet with the same marker and indent", () => {
    const li = all(hastOf(NOTE), "li")[3]; // nested "  - 軸 1 は…"
    const out = edit(NOTE, li, (t) => t.replace("（全項目", `${PARAGRAPH_BREAK}（全項目`));
    expect(out).toContain("  - 軸 1 は、どの 1 項目を抜いても変わらない\n  - （全項目との |r| ≥ 0.984）。");
  });

  it("Enter at the end of a list item creates an empty bullet (a real, editable item)", () => {
    const source = "- one\n- two\n";
    const li = all(hastOf(source), "li")[0];
    expect(edit(source, li, (t) => `${t}${PARAGRAPH_BREAK}`)).toBe("- one\n- \n- two\n");
  });

  it("Enter in a heading splits off a normal paragraph", () => {
    const source = "## Title part rest\n";
    const h2 = all(hastOf(source), "h2")[0];
    expect(edit(source, h2, (t) => t.replace(" rest", `${PARAGRAPH_BREAK}rest`))).toBe("## Title part\n\nrest\n");
  });

  it("refuses line breaks inside a table cell (they would break the table)", () => {
    const source = "| a | b |\n|---|---|\n| c | d |\n";
    const td = all(hastOf(source), "td")[0];
    expect(edit(source, td, (t) => `${t}\nx`)).toBeNull();
    expect(edit(source, td, (t) => `${t}${PARAGRAPH_BREAK}x`)).toBeNull();
  });

  it("reports where the caret should land after a split", () => {
    const source = "ab\n";
    const p = all(hastOf(source), "p")[0];
    const segs = buildSegments(p, source)!;
    const plan = planTextEdit({
      source,
      segs,
      oldText: "ab",
      newText: `a${PARAGRAPH_BREAK}b`,
      context: splitContextFor(p, source),
    });
    expect(plan.kind).toBe("splice");
    const applied = applyPlan(source, plan as Extract<typeof plan, { kind: "splice" }>);
    expect(applied.source).toBe("a\n\nb\n");
    expect(applied.focusAt).toBe(applied.source.indexOf("b"));
  });
});

describe("exhaustive: a keystroke at every offset of the real note", () => {
  it("lands exactly where typed, in every paragraph and list item", () => {
    const hast = hastOf(NOTE);
    const blocks = [...all(hast, "p"), ...all(hast, "li")];
    let checked = 0;
    blocks.forEach((block, index) => {
      const segs = buildSegments(block, NOTE)!;
      const old = plainTextOf(segs);
      for (let k = 0; k <= old.length; k++) {
        const out = edit(NOTE, block, (t) => `${t.slice(0, k)}Ｘ${t.slice(k)}`);
        expect(out, `block ${index} offset ${k}`).not.toBeNull();
        // Re-render the edited source: the same block now reads old+Ｘ at k.
        const again = [...all(hastOf(out!), "p"), ...all(hastOf(out!), "li")][index];
        expect(plainTextOf(buildSegments(again, out!)!), `block ${index} offset ${k}`).toBe(
          `${old.slice(0, k)}Ｘ${old.slice(k)}`
        );
        // …and nothing else in the file moved: exactly one character was added.
        expect(out!.length).toBe(NOTE.length + 1);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(250); // the loop really ran over the whole excerpt
  });
});

describe("rewriteMath — editing a formula keeps its delimiters", () => {
  it("keeps inline $…$", () => {
    expect(rewriteMath("$12Ld^2$", "12 L d^2")).toBe("$12 L d^2$");
  });
  it("keeps $$ … $$ on its own lines for display math", () => {
    expect(rewriteMath("$$\nE = mc^2\n$$", "E = m c^2")).toBe("$$\nE = m c^2\n$$");
  });
  it("keeps same-line $$…$$", () => {
    expect(rewriteMath("$$a+b$$", "a-b")).toBe("$$a-b$$");
  });
});

describe("blockEnd — where a paragraph added after a block goes", () => {
  const add = (source: string, block: HNode) => {
    const at = blockEnd(block)!;
    return `${source.slice(0, at)}\n\nnew para${source.slice(at)}`;
  };
  it("keeps a setext heading's --- underline with the heading", () => {
    const source = "# note\n\n---\ntype: review\nupdated: 2026-09-26\n---\n\nbody\n";
    const next = add(source, all(hastOf(source), "h2")[0]);
    expect(next).toBe("# note\n\n---\ntype: review\nupdated: 2026-09-26\n---\n\nnew para\n\nbody\n");
    const h2 = all(hastOf(next), "h2");
    expect(h2).toHaveLength(1);
    expect(plainTextOf(buildSegments(h2[0], next)!)).toBe("type: review\nupdated: 2026-09-26");
    expect(all(hastOf(next), "p").map((p) => plainTextOf(buildSegments(p, next)!))).toEqual(["new para", "body"]);
  });
  it("keeps an ATX heading's closing #s with the heading", () => {
    const source = "## Title ##\nbody\n";
    expect(add(source, all(hastOf(source), "h2")[0])).toBe("## Title ##\n\nnew para\nbody\n");
  });
});

describe("draftToMarkdown — a paragraph typed into a new (draft) block", () => {
  it("escapes literal syntax and turns Shift+Enter into hard breaks", () => {
    expect(draftToMarkdown("costs *5\nsecond line", "paragraph")).toBe("costs \\*5  \nsecond line");
  });
  it("a heading draft gets a ## marker", () => {
    expect(draftToMarkdown("新しい見出し", "heading")).toBe("## 新しい見出し");
  });
  it("a leading # typed into a paragraph stays literal", () => {
    expect(draftToMarkdown("#1 priority", "paragraph")).toBe("\\#1 priority");
  });
});
