import { describe, expect, it } from "vitest";
import { JA } from "./i18n";
import { IMAGE_ERROR_KEYS, IMAGE_ERROR_PREFIX, IO_ERROR_PREFIX, localizeImageError } from "./imageErrors";

const errorRs = (
  import.meta.glob("../src-tauri/src/error.rs", { eager: true, query: "?raw", import: "default" }) as Record<
    string,
    string
  >
)["../src-tauri/src/error.rs"];

/** The `#[error("…")]` literal of one AppError variant, from error.rs itself. */
function errorLiteral(variant: string): string {
  const m = new RegExp(String.raw`#\[error\("((?:[^"\\]|\\.)*)"\)\]\s*(?:///[^\n]*\n\s*)*${variant}\b`).exec(errorRs);
  expect(m, `no #[error] literal for AppError::${variant}`).not.toBeNull();
  return m![1];
}

/** Fill a Rust format string the way `thiserror` would for these fields. */
function render(lit: string, vars: Record<string, string>): string {
  return lit.replace(/\{(\w+)(?::[^}]*)?\}/g, (_, name: string) => vars[name] ?? `{${name}}`);
}

describe("localizeImageError — Rust image errors in the UI language", () => {
  const unsupported = render(errorLiteral("UnsupportedImage"), { "0": "fig.tiff" });
  const tooLarge = render(errorLiteral("ImageTooLarge"), { name: "big.png", size_mb: "30.4", limit_mb: "25" });

  it("reads the real error.rs wording (contract: prefixes match Rust)", () => {
    expect(unsupported.startsWith(IMAGE_ERROR_PREFIX)).toBe(true);
    expect(tooLarge.startsWith(IMAGE_ERROR_PREFIX)).toBe(true);
    expect(errorLiteral("Io")).toBe(`${IO_ERROR_PREFIX}{0}`);
  });

  it("localizes an unsupported type, keeping the file name", () => {
    expect(localizeImageError(unsupported, "ja")).toBe(
      "画像「fig.tiff」を読み込めません: 対応していない画像形式です。PNG・JPEG・GIF・WEBP・BMPを使用してください。"
    );
  });

  it("localizes an over-limit file, keeping the size and the limit", () => {
    expect(localizeImageError(tooLarge, "ja")).toBe(
      "画像「big.png」を読み込めません: ファイルサイズが30.4 MBで、上限の25 MBを超えています。"
    );
  });

  it("localizes a missing file (std::io NotFound) and keeps other I/O errors verbatim", () => {
    expect(localizeImageError(`${IO_ERROR_PREFIX}No such file or directory (os error 2)`, "ja")).toBe(
      "画像ファイルが見つかりません。"
    );
    const other = `${IO_ERROR_PREFIX}Permission denied (os error 13)`;
    expect(localizeImageError(other, "ja")).toBe(other);
  });

  it("leaves English untouched and passes unknown strings through", () => {
    expect(localizeImageError(unsupported, "en")).toBe(unsupported);
    expect(localizeImageError("Something else entirely", "ja")).toBe("Something else entirely");
    // A name containing the separator does not confuse the parse.
    const odd = render(errorLiteral("UnsupportedImage"), { "0": "a': b.tiff" });
    expect(localizeImageError(odd, "ja")).toContain("「a': b.tiff」");
  });

  it("every key has Japanese copy with the same placeholders", () => {
    for (const key of Object.values(IMAGE_ERROR_KEYS)) {
      expect(JA[key], key).toBeDefined();
      const holders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(holders(JA[key])).toEqual(holders(key));
    }
  });
});

describe("image-error wiring (preview + insert catch sites)", () => {
  const raw = import.meta.glob(["./components/ResolvedImage.tsx", "./fileActions.ts"], {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>;

  it("ResolvedImage localizes the raw Rust reason", () => {
    expect(raw["./components/ResolvedImage.tsx"]).toMatch(/state\.raw \? localizeImageError\(state\.reason, lang\)/);
  });

  it("the file-picker insert localizes its catch", () => {
    const src = raw["./fileActions.ts"];
    const fn = src.slice(src.indexOf("export async function pickAndInsertLocalImage"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(
      /catch \(e\) \{\s*const lang = uiLangFor\(useStore\.getState\(\)\.settings\?\.defaultTargetLanguage\);\s*useStore\.getState\(\)\.notify\(localizeImageError\(message\(e\), lang\), "error"\);/
    );
  });
});
