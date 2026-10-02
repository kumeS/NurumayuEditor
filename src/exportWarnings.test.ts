import { describe, expect, it } from "vitest";
import {
  CATALOG_ERROR_RULES,
  CATALOG_KEY_ERROR_RULES,
  EXPORT_WARNING_RULES,
  localizeCatalogError,
  localizeExportWarning,
} from "./exportWarnings";

const CJK = /[぀-ヿ一-龯]/;

function rustSource(file: string): string {
  const all = import.meta.glob("../src-tauri/src/{pdf,pptx,openrouter_models,fileio,commands}.rs", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>;
  const src = all[`../src-tauri/src/${file}`];
  expect(src, `${file} not found`).toBeTruthy();
  // Production code only, with Rust "\<newline><indent>" continuations joined.
  return src.split("#[cfg(test)]")[0].replace(/\\\n\s*/g, "");
}

/** The literal of every `warnings.push(format!("…"` in a Rust file. */
function pushedWarningTemplates(file: string): string[] {
  return [...rustSource(file).matchAll(/warnings\.push\(format!\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

describe("localizeExportWarning (Rust report warnings, rendered in the UI language)", () => {
  it("translates PDF warnings in both grammatical numbers, keeping the count", () => {
    expect(localizeExportWarning("1 image was replaced by a text placeholder (image embedding in PDF is planned).", "ja")).toBe(
      "画像1件をテキストの代替表示に置き換えました(PDFへの画像埋め込みは今後対応予定です)。"
    );
    expect(localizeExportWarning("3 images were replaced by text placeholders (image embedding in PDF is planned).", "ja")).toBe(
      "画像3件をテキストの代替表示に置き換えました(PDFへの画像埋め込みは今後対応予定です)。"
    );
    expect(localizeExportWarning("1 diagram was exported as its source text (diagram rendering in PDF is planned).", "ja")).toBe(
      "図1件をソースのテキストとして書き出しました(PDFでの図の描画は今後対応予定です)。"
    );
    expect(localizeExportWarning("2 paragraphs contain Markdown formatting that is shown as plain text in the PDF.", "ja")).toBe(
      "2段落にMarkdownの書式があり、PDFではそのまま文字として表示されます。"
    );
  });

  it("translates PPTX warnings, keeping the count", () => {
    expect(localizeExportWarning("4 image(s) couldn't be downloaded and were left out.", "ja")).toBe(
      "画像4件をダウンロードできなかったため、省きました。"
    );
    expect(
      localizeExportWarning("12 slide(s) have more text than fits and may be cut off — consider splitting them.", "ja")
    ).toBe("12枚のスライドは文字が収まらず、切れる可能性があります。スライドの分割を検討してください。");
  });

  it("translates RTF warnings, keeping the count", () => {
    expect(
      localizeExportWarning(
        "2 local image(s) couldn't be read from the document's folder and were exported as text placeholders.",
        "ja"
      )
    ).toBe("ドキュメントのフォルダから読み込めなかったローカル画像2件を、テキストの代替表示として書き出しました。");
    expect(
      localizeExportWarning(
        "3 image(s) couldn't be embedded in RTF (only PNG and JPEG are supported) and were exported as text placeholders.",
        "ja"
      )
    ).toBe("画像3件はRTFに埋め込めない形式のため(対応はPNGとJPEGのみ)、テキストの代替表示として書き出しました。");
  });

  it("keeps English warnings verbatim in the English UI", () => {
    const raw = "3 images were replaced by text placeholders (image embedding in PDF is planned).";
    expect(localizeExportWarning(raw, "en")).toBe(raw);
  });

  it("passes unknown strings through unchanged", () => {
    expect(localizeExportWarning("Something new happened.", "ja")).toBe("Something new happened.");
    // Already-localized draft reports stay as they are.
    expect(localizeExportWarning("下書きは約120語で、目標(約300語)の±20%を外れています。", "ja")).toBe(
      "下書きは約120語で、目標(約300語)の±20%を外れています。"
    );
  });

  it("every rule has a Japanese rendering that keeps the numbers of its sample", () => {
    for (const rule of EXPORT_WARNING_RULES) {
      for (const sample of rule.samples) {
        const out = localizeExportWarning(sample, "ja");
        expect(out, sample).not.toBe(sample);
        expect(out, sample).toMatch(CJK);
        for (const n of sample.match(/\d+/g) ?? []) expect(out, sample).toContain(n);
      }
    }
  });
});

describe("export-warning contract with the Rust report builders", () => {
  it("every warning pdf.rs / pptx.rs / openrouter_models.rs / fileio.rs (RTF) can push has a rule, and every rule's template exists", () => {
    const rust = ["pdf.rs", "pptx.rs", "openrouter_models.rs", "fileio.rs"].flatMap(pushedWarningTemplates);
    expect(rust.length).toBeGreaterThanOrEqual(15);
    expect(pushedWarningTemplates("fileio.rs")).toHaveLength(4);
    const ours = EXPORT_WARNING_RULES.map((r) => r.rust);
    expect([...rust].sort()).toEqual([...ours].sort());
  });
});

describe("localizeCatalogError (OpenRouter model-list failures)", () => {
  it("translates the backend headline, keeping the HTTP code", () => {
    expect(
      localizeCatalogError(
        "Network / API error: OpenRouter rejected the API key (HTTP 401) while loading the model list. Check the key in Settings.",
        "ja"
      )
    ).toBe("OpenRouterがAPIキーを拒否しました(HTTP 401)。設定でキーを確認してください。");
    expect(
      localizeCatalogError("Configuration error: No API key is set. Open Settings and add your OpenRouter API key to load the model list.", "ja")
    ).toBe("APIキーが設定されていません。設定でOpenRouter APIキーを追加すると、モデル一覧を取得できます。");
  });

  it("keeps the transport detail of a generic failure", () => {
    expect(localizeCatalogError("Network / API error: Could not load the OpenRouter model list: connection reset", "ja")).toBe(
      "OpenRouterのモデル一覧を取得できませんでした: connection reset"
    );
  });

  it("is unchanged in English and for unknown errors", () => {
    const raw = "Network / API error: OpenRouter is rate-limiting requests (HTTP 429). Wait a moment, then load the model list again.";
    expect(localizeCatalogError(raw, "en")).toBe(raw);
    expect(localizeCatalogError("Keychain error: locked", "ja")).toBe("Keychain error: locked");
  });

  it("every rule has a Japanese rendering for its samples", () => {
    for (const rule of CATALOG_ERROR_RULES) {
      for (const sample of rule.samples) {
        const out = localizeCatalogError(`Network / API error: ${sample}`, "ja");
        expect(out, sample).toMatch(CJK);
        expect(out, sample).not.toContain("OpenRouter model list");
        for (const n of sample.match(/\d+/g) ?? []) expect(out, sample).toContain(n);
      }
    }
  });

  it("covers every user-facing message openrouter_models.rs can produce, and nothing it cannot", () => {
    const literals = [...rustSource("openrouter_models.rs").matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => m[1])
      .filter((s) => s.length >= 25 && s.includes(" "));
    const ours = [...CATALOG_ERROR_RULES, ...EXPORT_WARNING_RULES].map((r) => r.rust);
    for (const lit of literals) expect(ours, `no rule for Rust message: ${lit}`).toContain(lit);
    for (const r of CATALOG_ERROR_RULES) expect(literals, `stale rule: ${r.rust}`).toContain(r.rust);
  });

  // list_openrouter_models reads the key through commands.rs `api_key_for`
  // BEFORE openrouter_models.rs validates it, so with an empty keychain the
  // message that reaches the catalog panel is commands.rs's, not the module's.
  it("localizes the no-key error commands.rs api_key_for returns to the catalog", () => {
    const raw =
      "Configuration error: No API key is set. Open Settings and add your OpenRouter API key. (Local endpoints such as Ollama can leave the key blank.)";
    expect(localizeCatalogError(raw, "ja")).toBe(
      "APIキーが設定されていません。設定でOpenRouter APIキーを追加すると、モデル一覧を取得できます。"
    );
    expect(localizeCatalogError(raw, "en")).toBe(raw);
  });

  it("the api_key_for rule mirrors a literal that still exists in commands.rs's api_key_for", () => {
    const src = rustSource("commands.rs");
    const fn = src.slice(src.indexOf("fn api_key_for"), src.indexOf("fn load_llm_config"));
    expect(fn.length).toBeGreaterThan(0);
    const literals = [...fn.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    expect(CATALOG_KEY_ERROR_RULES.length).toBeGreaterThan(0);
    for (const r of CATALOG_KEY_ERROR_RULES) {
      expect(literals, `stale rule: ${r.rust}`).toContain(r.rust);
      for (const sample of r.samples) expect(sample).toMatch(r.re);
    }
    // And the reverse: every user-facing message api_key_for can return has a rule.
    const ours = CATALOG_KEY_ERROR_RULES.map((r) => r.rust);
    for (const lit of literals.filter((s) => s.length >= 25 && s.includes(" "))) {
      expect(ours, `no rule for api_key_for message: ${lit}`).toContain(lit);
    }
  });
});

describe("frontend-written report warnings", () => {
  it("the Markdown Save As warning (fileActions.ts literal) is translated through the dictionary", () => {
    expect(
      localizeExportWarning(
        "Saved as Markdown — view mode and any slide-only details won't round-trip; reopening this file will load it as a Markdown document.",
        "ja"
      )
    ).toMatch(/^Markdownとして保存/);
  });
});
