import { describe, expect, it } from "vitest";
import { JA, interpolate, tf, translate, translateWith, uiLangFor } from "./i18n";
import { useStore } from "./store";

/**
 * Literal translation keys at call sites: `t("…")` / `tNow("…")` (key is the
 * only argument) and `tf("…", vars)` / `translateWith("…", lang, vars)` (key
 * is the first argument). Keys come back in capture group 1 or 2.
 */
const KEY_CALL_RE =
  /\bt(?:Now)?\("((?:[^"\\]|\\.)+)"\)|\b(?:tf|translateWith)\(\s*"((?:[^"\\]|\\.)+)"\s*,/g;

function translationKeysIn(source: string): string[] {
  return [...source.matchAll(KEY_CALL_RE)].map((m) => m[1] ?? m[2]);
}

describe("uiLangFor — the Settings 'Default language' drives the UI language", () => {
  it("maps 日本語 to the Japanese UI", () => {
    expect(uiLangFor("日本語")).toBe("ja");
  });

  it("maps English (and every other output language) to the English UI", () => {
    expect(uiLangFor("English")).toBe("en");
    expect(uiLangFor("Français")).toBe("en");
    expect(uiLangFor("中文")).toBe("en");
  });

  it("falls back to English before settings have loaded", () => {
    expect(uiLangFor(undefined)).toBe("en");
    expect(uiLangFor("")).toBe("en");
  });
});

describe("translate", () => {
  it("returns the key verbatim in English — the keys ARE the English copy", () => {
    expect(translate("Save", "en")).toBe("Save");
    expect(translate("Open Folder…", "en")).toBe("Open Folder…");
  });

  it("returns the Japanese copy in Japanese", () => {
    expect(translate("Save", "ja")).toBe("保存");
    expect(translate("Open Folder…", "ja")).toBe("フォルダを開く…");
  });

  it("falls back to the English key for a string that has no Japanese entry yet", () => {
    expect(translate("A string nobody has translated", "ja")).toBe(
      "A string nobody has translated"
    );
  });
});

// ----- w1-modal: toolbar / palette wording (BUG-009, BUG-009c) -------------
describe("toolbar wording (BUG-009)", () => {
  it("mode labels are nouns — Markdown stays Markdown in Japanese", () => {
    expect(translate("Markdown", "ja")).toBe("Markdown");
    expect(translate("Markdown source and preview", "ja")).toBe("Markdownソースとプレビュー");
  });

  it("the sidebar toggle names the file list", () => {
    expect(translate("Hide files", "ja")).toBe("ファイル一覧を非表示");
    expect(translate("Show files", "ja")).toBe("ファイル一覧を表示");
    expect(translate("Hide files sidebar", "ja")).toBe("ファイル一覧を非表示");
    expect(translate("Show files sidebar", "ja")).toBe("ファイル一覧を表示");
    expect(translate("Hide the files sidebar", "ja")).toBe("ファイル一覧を非表示");
    expect(translate("Files", "ja")).toBe("ファイル"); // FolderTree header unchanged
  });

  it("Save As matches the native menu's Japanese label", () => {
    expect(translate("Save As…", "ja")).toBe("別名で保存…");
  });
});

describe("find bar copy (BUG-010)", () => {
  it("reports counts and the replace result in Japanese, with the values filled in", () => {
    expect(translateWith("{n} matches", "ja", { n: 3 })).toBe("3 件");
    expect(translateWith("Replaced {n}.", "ja", { n: 12 })).toBe("12 件を置換しました");
    expect(translateWith("Lines 1–{total}", "ja", { total: 40 })).toBe("1–40 行");
    expect(translate("No matches", "ja")).toBe("一致なし");
  });
});

describe("tf / translateWith / interpolate — translate, then fill {name} placeholders", () => {
  it("fills placeholders after translating", () => {
    expect(translateWith("Authorization failed ({code}). Check your OpenRouter API key in Settings.", "ja", { code: 401 })).toBe(
      "認証に失敗しました(401)。設定でOpenRouter APIキーを確認してください。"
    );
    expect(translateWith("Authorization failed ({code}). Check your OpenRouter API key in Settings.", "en", { code: 403 })).toBe(
      "Authorization failed (403). Check your OpenRouter API key in Settings."
    );
  });

  it("replaces every occurrence and leaves unknown placeholders intact", () => {
    expect(interpolate("{a}-{a}-{b}", { a: "x" })).toBe("x-x-{b}");
  });

  it("inserts values literally ('$&' / '$1' are not replacement patterns)", () => {
    expect(interpolate("cost: {v}", { v: "$& $1 $$" })).toBe("cost: $& $1 $$");
  });

  it("tf() follows the live UI language setting", () => {
    const key = "Authorization failed ({code}). Check your OpenRouter API key in Settings.";
    const prev = useStore.getState().settings;
    try {
      useStore.setState({ settings: { ...(prev ?? {}), defaultTargetLanguage: "日本語" } as typeof prev });
      expect(tf(key, { code: 401 })).toBe("認証に失敗しました(401)。設定でOpenRouter APIキーを確認してください。");
      useStore.setState({ settings: { ...(prev ?? {}), defaultTargetLanguage: "English" } as typeof prev });
      expect(tf(key, { code: 401 })).toBe("Authorization failed (401). Check your OpenRouter API key in Settings.");
    } finally {
      useStore.setState({ settings: prev });
    }
  });
});

// ----- w2-settings: OpenRouter model catalog + model markers (BUG-013) -------
describe("model catalog copy (BUG-013, plan criterion 14)", () => {
  const CATALOG_KEYS = [
    "Browse OpenRouter models",
    "Fetch OpenRouter models",
    "Refresh model list",
    "Loading model catalog…",
    "Nothing is sent to OpenRouter until you fetch the list.",
    "Use manual model IDs with a custom endpoint.",
    "Model catalog could not be loaded.",
    "{n} catalog entries could not be read and were skipped.",
    "Search models by name or ID",
    "Free only",
    "{shown} of {total} models",
    "No models match these filters.",
    "OpenRouter returned an empty model list.",
    "Free",
    "{input} in / {output} out per 1M tokens",
    "{n} context",
    "Text output",
    "Image output",
    "Not found in the current OpenRouter catalog",
    "Save the endpoint first to load the OpenRouter list.",
    "Save the API key first to load the OpenRouter list.",
    "Unavailable (404)",
    "The provider could not serve this model in the last AI request. Choose another model.",
  ];

  it("has Japanese labels for every model-catalog state", () => {
    const cjk = /[぀-ヿ一-龯]/;
    for (const k of CATALOG_KEYS) {
      expect(JA[k], `missing JA for "${k}"`).toMatch(cjk);
      // Placeholders survive translation.
      const holders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(holders(JA[k]), k).toEqual(holders(k));
    }
  });

  it("fills the catalog count and price placeholders in Japanese", () => {
    expect(translateWith("{shown} of {total} models", "ja", { shown: 3, total: 40 })).toBe("40件中3件");
    expect(translateWith("{input} in / {output} out per 1M tokens", "ja", { input: "$0.15", output: "$0.60" })).toBe(
      "100万トークンあたり 入力$0.15 / 出力$0.60"
    );
  });
});

// ----- w3-history: the unsaved-changes dialog (BUG-011) ----------------------
describe("unsaved-changes dialog copy (BUG-011)", () => {
  it("translates every label and message, and keeps Save / Don't Save distinct", () => {
    // confirm.ts matches the clicked button by its label: identical Save and
    // Don't Save labels would make the choice unresolvable.
    const keys = [
      "Save",
      "Don't Save",
      "Cancel",
      "Unsaved changes",
      "Do you want to save the changes to “{title}” before closing it?",
      "Do you want to save the changes to “{title}” before quitting?",
    ];
    for (const k of keys) expect(JA[k], `missing JA for "${k}"`).toMatch(/[぀-ヿ一-龯]/);
    expect(JA["Save"]).not.toBe(JA["Don't Save"]);
    expect(new Set([JA["Save"], JA["Don't Save"], JA["Cancel"]]).size).toBe(3);
    expect(translateWith("Do you want to save the changes to “{title}” before quitting?", "ja", { title: "報告書" })).toBe(
      "終了する前に「報告書」の変更を保存しますか?"
    );
  });
});

describe("the Japanese dictionary itself", () => {
  it("has no blank entries (a blank would render as an invisible label)", () => {
    const blank = Object.entries(JA).filter(([, value]) => !value.trim());
    expect(blank).toEqual([]);
  });

  it("never maps a key to the identical English string (that entry would be dead weight)", () => {
    // Allow deliberate identity entries only for strings that are the same in
    // both languages (product names, symbols); flag accidental copy-paste.
    const identity = Object.entries(JA).filter(([key, value]) => key === value);
    expect(identity).toEqual([]);
  });

  it("actually contains Japanese characters for a sample of core chrome", () => {
    const cjk = /[぀-ヿ一-龯]/;
    for (const key of ["Save", "Open", "Settings", "Help", "Undo", "Redo"]) {
      expect(JA[key], `missing translation for "${key}"`).toBeDefined();
      expect(cjk.test(JA[key]), `"${key}" → "${JA[key]}" is not Japanese`).toBe(true);
    }
  });
});

// The promise this file guards: "switch Default language to 日本語 and the whole
// interface is Japanese". A new `t("…")` call with no dictionary entry would
// silently render English inside an otherwise-Japanese UI, so scan the source.
describe("dictionary coverage of the real UI", () => {
  it("the key scanner sees t(), tNow(), tf() and translateWith() call sites", () => {
    const sample = [
      't("Save")',
      'tNow("Open")',
      'tf("Found {n} nodes", { n })',
      "tf(\n  \"Draft created — {n} chunks.\",\n  { n: count }\n)",
      'translateWith("Model {model}", lang, { model })',
      'notify("not a key")',
      'tf(someVariable, { n })',
    ].join("\n");
    expect(translationKeysIn(sample)).toEqual([
      "Save",
      "Open",
      "Found {n} nodes",
      "Draft created — {n} chunks.",
      "Model {model}",
    ]);
  });

  it("has a Japanese entry for every t()/tNow()/tf() key used in the app", () => {
    // Vite's glob (not node:fs) so this stays dependency-free and runs the same
    // way the app is built.
    const sources = import.meta.glob("./**/*.{ts,tsx}", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;

    const used = new Set<string>();
    for (const [path, source] of Object.entries(sources)) {
      if (/\.test\.tsx?$/.test(path) || path.endsWith("/i18n.ts")) continue;
      for (const key of translationKeysIn(source)) used.add(key);
    }

    // "AI" is deliberately identical in both languages (see the dictionary).
    // "Markdown" is the format's name — the mode label stays Markdown (BUG-009).
    const allowedUntranslated = new Set(["AI", "Markdown"]);
    const missing = [...used].filter((k) => !(k in JA) && !allowedUntranslated.has(k)).sort();
    expect(missing, `untranslated UI strings: ${missing.join(" | ")}`).toEqual([]);
    expect(used.size).toBeGreaterThan(100); // the scan actually found the call sites
  });
});

// The complement of the coverage test above: a bare English literal in JSX is
// invisible to the dictionary (nothing to look up), so it silently stays
// English in a Japanese UI. Both real bugs found during the Japanese pass were
// this shape — a placeholder and an inline `>Label<`.
describe("no untranslated literals left in the UI", () => {
  it("wraps every user-visible JSX label in t()", () => {
    const sources = import.meta.glob("./components/**/*.tsx", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;

    // Strings that are deliberately identical in both languages, or not UI copy.
    const allowed = new Set(["MD", "Promise"]);

    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      // HelpModal ships its own per-language content bundles (HELP_I18N) and
      // SettingsModal renders explicit ja/en JSX branches, so their English
      // halves are expected literals rather than missed translations.
      if (/HelpModal|SettingsModal/.test(path)) continue;
      const attrs = source.matchAll(
        /(?:title|aria-label|placeholder|alt)="([A-Z][A-Za-z0-9 ,.:;()/&%…·—–'?!-]{2,90})"/g
      );
      const texts = source.matchAll(
        />\s*([A-Z][A-Za-z][A-Za-z0-9 ,.:;()/&%…·—–'?!]{3,70})\s*</g
      );
      for (const m of [...attrs, ...texts]) {
        const text = m[1].trim();
        if (!allowed.has(text)) offenders.push(`${path}: ${text}`);
      }
    }
    expect(offenders, `untranslated literals: ${offenders.join(" | ")}`).toEqual([]);
  });
});

// ----- w5-copy: extended literal scanner (UX-MIXED-ENGLISH, MISS-05) ---------
// The scanner above only sees `attr="Capitalized"` and one-line `>Text<`.
// English also leaked through label= props, ternary branches, `|| "…"`
// defaults, lowercase placeholders ('optional', 'e.g. …', 'https://…'),
// multi-line JSX text, template literals and notify() toasts.

const CJK_RE = /[぀-ヿ一-龯]/;
/** Words that read the same in both UIs (product/format names, acronyms). */
const PROPER_NOUN_RE =
  /\b(?:Markdown|PPTX|PDF|RTF|OpenRouter|PowerPoint|NurumayuEditor|BibTeX|DOI|arXiv|MCP|Mermaid|KaTeX|LaTeX|URL|AI|IDs?|MD|Ollama)\b/g;
/** Literals that are not UI copy: an API-key format sample, type names, the
 *  default output-language VALUE sent to the model, a cytoscape style mapper. */
const NOT_COPY = new Set(["sk-or-...", "MD", "Promise", "English", "data(label)"]);

/** Blank out comments (keeping newlines, so line numbers stay right). `//`
 *  counts only after whitespace/punctuation, so `https://` in strings survives. */
function stripComments(src: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[\s;{}(),])\/\/[^\n]*/gm, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

/** The literal's text with `${…}` holes and proper nouns removed still has English words. */
function isEnglishCopy(text: string): boolean {
  if (NOT_COPY.has(text.trim()) || CJK_RE.test(text)) return false;
  return /[A-Za-z]{2,}/.test(text.replace(/\$\{[^}]*\}/g, " ").replace(PROPER_NOUN_RE, " "));
}

/** Shapes a branch literal takes when it is copy rather than a code value. */
function looksLikeCopy(text: string): boolean {
  const s = text.replace(/^\$\{[^}]*\}\s*/, "").trim();
  return /^(?:[A-Z][a-z]|\(|e\.g\.|https?:\/\/)/.test(s) && isEnglishCopy(text);
}

const LIT = String.raw`"(?:[^"\\\n]|\\.)*"|\x60[^\x60]*\x60`;
const unquote = (lit: string) => lit.slice(1, -1);

interface LiteralScanOptions {
  /** .tsx: scan JSX attributes, children and ternaries. .ts: notify() and dialog filter names only. */
  tsx: boolean;
  /** Skip JSX text children (SettingsModal: its English prose lives in explicit
   *  `ja ? (<>…</>) : (<>…</>)` fragments; attributes, props, ternaries and
   *  toasts there are still scanned). */
  skipJsxText?: boolean;
  /** Label tables (`const NAME = [{ label: "…" }]`) whose entries are rendered
   *  as `t(x.label)`; the render-site t() call is asserted in uiCopyClaims.test.ts.
   *  Only inside these tables is a property literal accepted, and only when
   *  `isDictionaryKey` says it has JA. Everywhere else (promptDialog options…)
   *  a property literal must be wrapped with t() at the call site. */
  labelTables?: string[];
  isDictionaryKey?: (key: string) => boolean;
}

/** Untranslated English literals in one source file, as `line: text`. */
function scanLiterals(source: string, opts: LiteralScanOptions): string[] {
  const src = stripComments(source);
  const found: { at: number; text: string }[] = [];
  const add = (at: number, text: string) => found.push({ at, text: text.trim() });
  const each = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    for (const m of src.matchAll(re)) fn(m);
  };

  // notify("…") / notify(`…`) toasts and setError("…") panel errors.
  each(new RegExp(String.raw`\b(?:notify|setError)\(\s*(${LIT})`, "g"), (m) => {
    if (isEnglishCopy(unquote(m[1]))) add(m.index!, unquote(m[1]));
  });
  // Native file-dialog filter names: `{ name: "…", extensions: […] }`.
  each(/\{\s*name:\s*"([^"]+)",\s*extensions:/g, (m) => {
    if (isEnglishCopy(m[1])) add(m.index!, m[1]);
  });

  if (opts.tsx) {
    // attr="…" (any case: 'optional', 'e.g. …', 'https://…'), attr={"…"} and attr={`…`}.
    each(/\b(?:title|aria-label|placeholder|alt|label)=(?:"([^"]+)"|\{\s*"([^"]+)"\s*\}|\{\x60([^\x60]*)\x60\})/g, (m) => {
      const text = m[1] ?? m[2] ?? m[3];
      if (isEnglishCopy(text)) add(m.index!, text);
    });
    // Property literals: `placeholder: "…"`, `submitLabel: "…"`, `label: "…"`.
    // Accepted only inside a declared label table AND when the dictionary has the key.
    const tableSpans = (opts.labelTables ?? []).flatMap((name): [number, number][] => {
      const start = src.indexOf(`const ${name}`);
      return start < 0 ? [] : [[start, src.indexOf("];", start)]];
    });
    const inTable = (i: number) => tableSpans.some(([s, e]) => i >= s && i < e);
    each(/\b(?:placeholder|title|label|hint|description|tooltip|submitLabel)\s*:\s*"([^"]+)"/g, (m) => {
      if (!isEnglishCopy(m[1])) return;
      if (inTable(m.index!) && opts.isDictionaryKey?.(m[1])) return;
      add(m.index!, m[1]);
    });
    // Ternary branches: `c ? "A" : "B"`, `c ? t("A") : "B"`, `c ? "A" : t("B")`.
    // An English branch paired with a CJK branch is a deliberate ja/en pair.
    const pairSpans: [number, number][] = [];
    each(new RegExp(String.raw`\?(?![.?:])\s*(${LIT})\s*:\s*(${LIT})`, "g"), (m) => {
      pairSpans.push([m.index!, m.index! + m[0].length]);
      const [a, b] = [unquote(m[1]), unquote(m[2])];
      if (CJK_RE.test(a) || CJK_RE.test(b)) return;
      if (looksLikeCopy(a)) add(m.index!, a);
      if (looksLikeCopy(b)) add(m.index!, b);
    });
    const inPair = (i: number) => pairSpans.some(([s, e]) => i >= s && i < e);
    each(new RegExp(String.raw`\?(?![.?:])\s*(${LIT})\s*:`, "g"), (m) => {
      if (!inPair(m.index!) && looksLikeCopy(unquote(m[1]))) add(m.index!, unquote(m[1]));
    });
    each(new RegExp(String.raw`(?<=[)\]])\s*:\s*(${LIT})`, "g"), (m) => {
      if (!inPair(m.index!) && looksLikeCopy(unquote(m[1]))) add(m.index!, unquote(m[1]));
    });
    // `x || "Fallback"` / `x ?? "Fallback"`.
    each(new RegExp(String.raw`(?:\|\||\?\?)\s*(${LIT})`, "g"), (m) => {
      if (looksLikeCopy(unquote(m[1]))) add(m.index!, unquote(m[1]));
    });
    if (!opts.skipJsxText) {
      // One-line JSX text ending in a tag or an expression: `>Text<`, `>Text {`, `>(optional)<`.
      each(/>[ \t]*([A-Z][a-z][^<>{}\n]*?|\([a-z][a-z ]*\))[ \t]*(?=<|\{)/g, (m) => {
        if (isEnglishCopy(m[1])) add(m.index!, m[1]);
      });
      // Text after a self-closing icon, to the end of the line: `<StopIcon /> Stop`.
      each(/\/>[ \t]+([A-Z][a-z][^<>{}\n]*)$/gm, (m) => {
        if (isEnglishCopy(m[1])) add(m.index!, m[1]);
      });
      // Lowercase words after an expression: `{count} selected</span>`.
      each(/\}[ \t]+([a-z]{2,}(?: [a-z]+)*)[ \t]*</g, (m) => {
        if (isEnglishCopy(m[1])) add(m.index!, m[1]);
      });
      // Multi-line JSX text: a line that is only words, starting with a
      // capitalized one (two words or more), or a lone `(lowercase note)`.
      each(/^[ \t]+([A-Z][a-z]*,? [A-Za-z(][^<>{}=;\n]*|\([a-z][a-z ]*\))$/gm, (m) => {
        if (isEnglishCopy(m[1])) add(m.index!, m[1]);
      });
      // A continuation line of JSX prose: three+ lowercase words, no code punctuation.
      each(/^[ \t]+([a-z]+(?: [a-z]+){2,}[^<>{}=;()\n]*)$/gm, (m) => {
        if (isEnglishCopy(m[1])) add(m.index!, m[1]);
      });
    }
  }

  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  const seen = new Set<string>();
  return found
    .sort((x, y) => x.at - y.at)
    .map((f) => `${lineOf(f.at)}: ${f.text}`)
    .filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
}

describe("extended literal scanner — self-test (one fixture per pattern)", () => {
  const tsx = (s: string) => scanLiterals(s, { tsx: true }).map((x) => x.replace(/^\d+: /, ""));
  const ts = (s: string) => scanLiterals(s, { tsx: false }).map((x) => x.replace(/^\d+: /, ""));

  it("flags each untranslated shape", () => {
    expect(tsx('<Tooltip label="Move down">')).toEqual(["Move down"]);
    expect(tsx('<input placeholder="e.g. concise and formal" />')).toEqual(["e.g. concise and formal"]);
    expect(tsx('<input placeholder="https://… reference URL" />')).toEqual(["https://… reference URL"]);
    expect(tsx('<RailBtn title={x ? "Duplicate slide" : "Add a heading"} />')).toEqual([
      "Duplicate slide",
      "Add a heading",
    ]);
    expect(tsx('{busy ? t("Look up") : "Build references list"}')).toEqual(["Build references list"]);
    expect(tsx('{busy ? "Searching" : t("Search")}')).toEqual(["Searching"]);
    expect(tsx('{e.author || "Unknown author"}')).toEqual(["Unknown author"]);
    expect(tsx("<span>(optional)</span>")).toEqual(["(optional)"]);
    expect(tsx("<p>Detached slide {n}</p>")).toEqual(["Detached slide"]);
    expect(tsx("<p>\n      The draft is grounded in this material (it won't copy it verbatim).\n</p>")).toEqual([
      "The draft is grounded in this material (it won't copy it verbatim).",
    ]);
    expect(tsx('notify("Merged paragraphs.", "success")')).toEqual(["Merged paragraphs."]);
    expect(tsx("notify(`Merged ${n} paragraphs.`)")).toEqual(["Merged ${n} paragraphs."]);
    expect(tsx("<b title={`Model: ${model}`} />")).toEqual(["Model: ${model}"]);
    expect(tsx("<b aria-label={`Remove ${s.label}`} />")).toEqual(["Remove ${s.label}"]);
    expect(tsx('const L = [{ label: "Image right", hint: "Bullets on the left." }];')).toEqual([
      "Image right",
      "Bullets on the left.",
    ]);
    expect(ts('notify(`Exported ${n} slide(s) as PPTX.`, "success")')).toEqual(["Exported ${n} slide(s) as PPTX."]);
    expect(ts('filters: [{ name: "Text documents", extensions: ["txt"] }]')).toEqual(["Text documents"]);
    expect(tsx('setError(\n  "The check could not run."\n);')).toEqual(["The check could not run."]);
    expect(tsx('<input placeholder={"One criterion per line"} />')).toEqual(["One criterion per line"]);
    expect(tsx('promptDialog({ submitLabel: "Run" })')).toEqual(["Run"]);
    expect(tsx('<StopIcon className="h-3 w-3" /> Stop\n</button>')).toEqual(["Stop"]);
    expect(tsx('<span className="x">{count} selected</span>')).toEqual(["selected"]);
    expect(tsx("<div>\n  (empty image)\n</div>")).toEqual(["(empty image)"]);
    expect(tsx('<Icon />{" "}\n    button to add one, or run “AI review” above.\n</div>')).toEqual([
      "button to add one, or run “AI review” above.",
    ]);
  });

  it("ignores translated calls, ja/en pairs, comments, proper nouns and code values", () => {
    expect(tsx('<Tooltip label={t("Move down")}>')).toEqual([]);
    expect(tsx('{ja ? "日本語の説明" : "The English half"}')).toEqual([]);
    expect(tsx("{/* Keyed by view+tab like the main ErrorBoundary above */}")).toEqual([]);
    expect(tsx("  // Keyed by view+tab like the main ErrorBoundary above")).toEqual([]);
    expect(tsx('<option title="Markdown">')).toEqual([]);
    expect(tsx('placeholder={hasKey ? t("Saved") : "sk-or-..."}')).toEqual([]);
    expect(tsx('const mode = isEdit ? "edit" : "split";')).toEqual([]);
    expect(tsx('const o = { kind: "error", label: "Image right" };', )).toEqual(["Image right"]);
    const known = (k: string) => k === "Image right" || k === "e.g. concise and formal";
    expect(
      scanLiterals('const L = [{ label: "Image right" }];', { tsx: true, labelTables: ["L"], isDictionaryKey: known })
    ).toEqual([]);
    // A dictionary key outside a declared label table is still a raw literal:
    // promptDialog renders its options as-is.
    expect(
      scanLiterals('promptDialog({ placeholder: "e.g. concise and formal" });\nconst L = [{ label: "Image right" }];', {
        tsx: true,
        labelTables: ["L"],
        isDictionaryKey: known,
      }).map((x) => x.replace(/^\d+: /, ""))
    ).toEqual(["e.g. concise and formal"]);
    expect(
      scanLiterals('const L = [{ label: "Not in the dictionary" }];', { tsx: true, labelTables: ["L"], isDictionaryKey: known })
        .length
    ).toBe(1);
    expect(tsx("notify(`${n} ${tNow(\"images inserted.\")}`)")).toEqual([]);
    expect(ts('const p = cond ? "Rewrite the text as bullets." : "Summarize it.";')).toEqual([]);
    expect(
      scanLiterals("<p>\n  The English half of a ja/en fragment\n</p>", { tsx: true, skipJsxText: true })
    ).toEqual([]);
    expect(tsx("import {\n  Children,\n  createContext,\n} from \"react\";")).toEqual([]);
    expect(tsx('const lang = useStore((s) => s.lang ?? "English");')).toEqual([]);
    expect(tsx('<span>{t("Size")}: {n}px</span>')).toEqual([]);
  });
});

describe("no untranslated literals — extended scan of components, App, aiActions, fileActions, store", () => {
  it("finds none (allow-list: proper nouns + NOT_COPY; HelpModal ships HELP_I18N bundles)", () => {
    const sources = {
      ...(import.meta.glob("./components/*.tsx", { eager: true, query: "?raw", import: "default" }) as Record<
        string,
        string
      >),
      ...(import.meta.glob(["./App.tsx", "./aiActions.ts", "./fileActions.ts", "./store.ts"], {
        eager: true,
        query: "?raw",
        import: "default",
      }) as Record<string, string>),
    };
    expect(Object.keys(sources).length).toBeGreaterThan(30);
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      if (/HelpModal/.test(path)) continue;
      const hits = scanLiterals(source, {
        tsx: path.endsWith(".tsx"),
        skipJsxText: /SettingsModal/.test(path),
        // Render sites asserted in uiCopyClaims.test.ts ("label tables are translated where they render").
        labelTables: ["LAYOUT_META", "PROOFREAD_STYLES", "WRITING_TONES"],
        isDictionaryKey: (k) => k in JA,
      });
      for (const h of hits) offenders.push(`${path.replace("./", "")}:${h}`);
    }
    expect(offenders, `untranslated literals:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("ux-a11y-i18n-6 — one Japanese length unit: 文字", () => {
  it("no Japanese entry counts with a bare 字 after a number placeholder (the status bar says 文字)", () => {
    const offenders = Object.entries(JA).filter(([, ja]) => /\{(?:n|chars|target)\}字/.test(ja));
    expect(offenders).toEqual([]);
  });

  it("the Draft length and progress copy uses 文字", () => {
    expect(JA["Short (~{words} words)"]).toBe("短め(約{chars}文字)");
    expect(JA["Drafting… {n} characters"]).toBe("下書き中… {n}文字");
  });
});
