// Localize local-image read errors coming back from the Rust backend.
//
// Constraints:
// - `read_local_image` failures reach the webview only as the English Display
//   string of `AppError` (src-tauri/src/error.rs: UnsupportedImage,
//   ImageTooLarge, Io). Classification is by those literals' stable leading
//   text; imageErrors.test.ts raw-reads error.rs and builds its samples from
//   the real `#[error("…")]` strings, so a reworded Rust message fails the test.
// - Pure: callers pass the UI language. English returns the raw text.
// - Unknown strings pass through unchanged. Of the I/O errors only "not found"
//   (`os error 2`) is recognized; other I/O failures stay verbatim.

import { translate, translateWith, type UiLang } from "./i18n";

/** error.rs UnsupportedImage / ImageTooLarge: "Can't read image '<name>': …" */
export const IMAGE_ERROR_PREFIX = "Can't read image '";
/** error.rs Io: "File I/O error: <std::io::Error>" */
export const IO_ERROR_PREFIX = "File I/O error: ";

/** Dictionary keys (English copy; JA entries in i18n.ts). */
export const IMAGE_ERROR_KEYS = {
  unsupported: "Can't read image “{name}”: unsupported image type. Use PNG, JPEG, GIF, WEBP, or BMP.",
  tooLarge: "Can't read image “{name}”: the file is {size} MB, over the {limit} MB limit.",
  notFound: "Image file not found.",
} as const;

const UNSUPPORTED_RE = /^Can't read image '([\s\S]+)': unsupported image type\./;
const TOO_LARGE_RE = /^Can't read image '([\s\S]+)': the file is ([\d.]+) MB, over the (\d+) MB limit\.$/;
const IO_NOT_FOUND_RE = /\(os error 2\)\s*$/;

/** One backend image-read error in the UI language. */
export function localizeImageError(raw: string, lang: UiLang): string {
  if (lang === "en") return raw;
  if (raw.startsWith(IMAGE_ERROR_PREFIX)) {
    const big = TOO_LARGE_RE.exec(raw);
    if (big) return translateWith(IMAGE_ERROR_KEYS.tooLarge, lang, { name: big[1], size: big[2], limit: big[3] });
    const bad = UNSUPPORTED_RE.exec(raw);
    if (bad) return translateWith(IMAGE_ERROR_KEYS.unsupported, lang, { name: bad[1] });
  }
  if (raw.startsWith(IO_ERROR_PREFIX) && IO_NOT_FOUND_RE.test(raw)) return translate(IMAGE_ERROR_KEYS.notFound, lang);
  return raw;
}
