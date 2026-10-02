// Render-time localization of the English messages the Rust backend writes
// into lossy-operation reports (PdfReport / PPTX warnings / OpenRouterCatalog
// warnings / RtfReport warnings) and OpenRouter model-list errors.
//
// Constraints:
// - Pure: (raw, lang) -> string. English UI returns `raw` unchanged. A report
//   warning no rule recognises goes through the dictionary (translate), which
//   localizes frontend-written English literals such as the Markdown Save As
//   warning and returns anything else — e.g. draft reports that were already
//   localized when written — unchanged. An unrecognised catalog error is
//   returned unchanged.
// - Numbers in the Rust text are carried into the translation.
// - Every rule names the exact Rust literal it mirrors (`rust`, in source
//   form). exportWarnings.test.ts reads pdf.rs, pptx.rs, fileio.rs (RTF) and
//   openrouter_models.rs and fails when a Rust message is added or reworded
//   without a matching rule here, or when a rule's literal no longer exists.
//   CATALOG_KEY_ERROR_RULES mirrors commands.rs `api_key_for` (the key is read
//   there before openrouter_models.rs validates it); its test checks only that
//   function's literals, not the rest of commands.rs.
// - Japanese copy lives in the translateWith(...) calls below, so the i18n
//   coverage scan sees each key.

import { translate, translateWith, type UiLang } from "./i18n";

export interface LocalizeRule {
  /** The Rust format!/string literal this rule mirrors, as written in source. */
  rust: string;
  /** Matches the rendered English message. */
  re: RegExp;
  /** Japanese rendering from the match. */
  ja: (m: RegExpMatchArray) => string;
  /** Rendered English examples (used by the tests). */
  samples: string[];
}

export const EXPORT_WARNING_RULES: LocalizeRule[] = [
  // ----- pdf.rs lossy_report -----
  {
    rust: "{} replaced by {} (image embedding in PDF is planned).",
    re: /^(\d+) images? (?:was|were) replaced by (?:a text placeholder|text placeholders) \(image embedding in PDF is planned\)\.$/,
    ja: (m) =>
      translateWith("{n} image(s) replaced by text placeholders (image embedding in PDF is planned).", "ja", { n: m[1] }),
    samples: [
      "1 image was replaced by a text placeholder (image embedding in PDF is planned).",
      "3 images were replaced by text placeholders (image embedding in PDF is planned).",
    ],
  },
  {
    rust: "{} exported as {} source text (diagram rendering in PDF is planned).",
    re: /^(\d+) diagrams? (?:was|were) exported as (?:its|their) source text \(diagram rendering in PDF is planned\)\.$/,
    ja: (m) =>
      translateWith("{n} diagram(s) exported as source text (diagram rendering in PDF is planned).", "ja", { n: m[1] }),
    samples: [
      "1 diagram was exported as its source text (diagram rendering in PDF is planned).",
      "2 diagrams were exported as their source text (diagram rendering in PDF is planned).",
    ],
  },
  {
    rust: "{} Markdown formatting that is shown as plain text in the PDF.",
    re: /^(\d+) paragraphs? contains? Markdown formatting that is shown as plain text in the PDF\.$/,
    ja: (m) =>
      translateWith("{n} paragraph(s) contain Markdown formatting that is shown as plain text in the PDF.", "ja", {
        n: m[1],
      }),
    samples: [
      "1 paragraph contains Markdown formatting that is shown as plain text in the PDF.",
      "2 paragraphs contain Markdown formatting that is shown as plain text in the PDF.",
    ],
  },
  // ----- pptx.rs build_pptx -----
  {
    rust: "{} image(s) couldn't be downloaded and were left out.",
    re: /^(\d+) image\(s\) couldn't be downloaded and were left out\.$/,
    ja: (m) => translateWith("{n} image(s) couldn't be downloaded and were left out.", "ja", { n: m[1] }),
    samples: ["4 image(s) couldn't be downloaded and were left out."],
  },
  {
    rust: "{} local image(s) couldn't be read from the document's folder and were left out.",
    re: /^(\d+) local image\(s\) couldn't be read from the document's folder and were left out\.$/,
    ja: (m) =>
      translateWith("{n} local image(s) couldn't be read from the document's folder and were left out.", "ja", {
        n: m[1],
      }),
    samples: ["2 local image(s) couldn't be read from the document's folder and were left out."],
  },
  {
    rust: "{} image(s) use a format PowerPoint can't embed (e.g. WEBP or SVG) and were left out.",
    re: /^(\d+) image\(s\) use a format PowerPoint can't embed \(e\.g\. WEBP or SVG\) and were left out\.$/,
    ja: (m) =>
      translateWith("{n} image(s) use a format PowerPoint can't embed (e.g. WEBP or SVG) and were left out.", "ja", {
        n: m[1],
      }),
    samples: ["2 image(s) use a format PowerPoint can't embed (e.g. WEBP or SVG) and were left out."],
  },
  {
    rust: "{} extra image(s) were left out — only the first 6 images per slide are exported.",
    re: /^(\d+) extra image\(s\) were left out — only the first 6 images per slide are exported\.$/,
    ja: (m) =>
      translateWith("{n} extra image(s) were left out — only the first 6 images per slide are exported.", "ja", {
        n: m[1],
      }),
    samples: ["3 extra image(s) were left out — only the first 6 images per slide are exported."],
  },
  {
    rust: "{} image(s) were left out — their slide's layout has no image area.",
    re: /^(\d+) image\(s\) were left out — their slide's layout has no image area\.$/,
    ja: (m) => translateWith("{n} image(s) were left out — their slide's layout has no image area.", "ja", { n: m[1] }),
    samples: ["1 image(s) were left out — their slide's layout has no image area."],
  },
  {
    rust: "{} slide(s) have more text than fits and may be cut off — consider splitting them.",
    re: /^(\d+) slide\(s\) have more text than fits and may be cut off — consider splitting them\.$/,
    ja: (m) =>
      translateWith("{n} slide(s) have more text than fits and may be cut off — consider splitting them.", "ja", {
        n: m[1],
      }),
    samples: ["12 slide(s) have more text than fits and may be cut off — consider splitting them."],
  },
  {
    rust: "{} link(s) don't point to a web or mail address and were exported as plain text.",
    re: /^(\d+) link\(s\) don't point to a web or mail address and were exported as plain text\.$/,
    ja: (m) =>
      translateWith("{n} link(s) don't point to a web or mail address and were exported as plain text.", "ja", {
        n: m[1],
      }),
    samples: ["2 link(s) don't point to a web or mail address and were exported as plain text."],
  },
  {
    rust: "{diagrams} diagram(s) had no rendered snapshot and were left out — export from the app (not the CLI) to include them.",
    re: /^(\d+) diagram\(s\) had no rendered snapshot and were left out — export from the app \(not the CLI\) to include them\.$/,
    ja: (m) =>
      translateWith(
        "{n} diagram(s) had no rendered snapshot and were left out — export from the app (not the CLI) to include them.",
        "ja",
        { n: m[1] }
      ),
    samples: ["2 diagram(s) had no rendered snapshot and were left out — export from the app (not the CLI) to include them."],
  },
  // ----- fileio.rs push_rtf_warnings (RtfReport) -----
  {
    rust: "{} image(s) couldn't be downloaded and were exported as text placeholders.",
    re: /^(\d+) image\(s\) couldn't be downloaded and were exported as text placeholders\.$/,
    ja: (m) =>
      translateWith("{n} image(s) couldn't be downloaded and were exported as text placeholders.", "ja", { n: m[1] }),
    samples: ["2 image(s) couldn't be downloaded and were exported as text placeholders."],
  },
  {
    rust: "{} local image(s) couldn't be read from the document's folder and were exported as text placeholders.",
    re: /^(\d+) local image\(s\) couldn't be read from the document's folder and were exported as text placeholders\.$/,
    ja: (m) =>
      translateWith(
        "{n} local image(s) couldn't be read from the document's folder and were exported as text placeholders.",
        "ja",
        { n: m[1] }
      ),
    samples: ["3 local image(s) couldn't be read from the document's folder and were exported as text placeholders."],
  },
  {
    rust: "{} image(s) couldn't be embedded in RTF (only PNG and JPEG are supported) and were exported as text placeholders.",
    re: /^(\d+) image\(s\) couldn't be embedded in RTF \(only PNG and JPEG are supported\) and were exported as text placeholders\.$/,
    ja: (m) =>
      translateWith(
        "{n} image(s) couldn't be embedded in RTF (only PNG and JPEG are supported) and were exported as text placeholders.",
        "ja",
        { n: m[1] }
      ),
    samples: ["4 image(s) couldn't be embedded in RTF (only PNG and JPEG are supported) and were exported as text placeholders."],
  },
  {
    rust: "{} diagram(s) had no rendered snapshot and were exported as source text.",
    re: /^(\d+) diagram\(s\) had no rendered snapshot and were exported as source text\.$/,
    ja: (m) =>
      translateWith("{n} diagram(s) had no rendered snapshot and were exported as source text.", "ja", { n: m[1] }),
    samples: ["1 diagram(s) had no rendered snapshot and were exported as source text."],
  },
  // ----- openrouter_models.rs parse_catalog -----
  {
    rust: "Skipped {without_id} catalog {} without a usable model id.",
    re: /^Skipped (\d+) catalog entr(?:y|ies) without a usable model id\.$/,
    ja: (m) => translateWith("Skipped {n} catalog entries without a usable model id.", "ja", { n: m[1] }),
    samples: ["Skipped 1 catalog entry without a usable model id.", "Skipped 5 catalog entries without a usable model id."],
  },
  {
    rust: "Skipped {duplicates} duplicate catalog {}.",
    re: /^Skipped (\d+) duplicate catalog entr(?:y|ies)\.$/,
    ja: (m) => translateWith("Skipped {n} duplicate catalog entries.", "ja", { n: m[1] }),
    samples: ["Skipped 1 duplicate catalog entry.", "Skipped 7 duplicate catalog entries."],
  },
];

export const CATALOG_ERROR_RULES: LocalizeRule[] = [
  {
    rust: "The OpenRouter model list is available only when the endpoint is OpenRouter (https://openrouter.ai/…).",
    re: /^The OpenRouter model list is available only when the endpoint is OpenRouter \(https:\/\/openrouter\.ai\/…\)\.$/,
    ja: () => translateWith("The OpenRouter model list is available only with the OpenRouter endpoint.", "ja", {}),
    samples: ["The OpenRouter model list is available only when the endpoint is OpenRouter (https://openrouter.ai/…)."],
  },
  {
    rust: "No API key is set. Open Settings and add your OpenRouter API key to load the model list.",
    re: /^No API key is set\. Open Settings and add your OpenRouter API key to load the model list\.$/,
    ja: () => translateWith("No API key is set. Add your OpenRouter API key in Settings to load the model list.", "ja", {}),
    samples: ["No API key is set. Open Settings and add your OpenRouter API key to load the model list."],
  },
  {
    rust: "Could not reach openrouter.ai to load the model list. You may be offline, or DNS is not answering. Check the connection and try again.",
    re: /^Could not reach openrouter\.ai to load the model list\. You may be offline, or DNS is not answering\. Check the connection and try again\.$/,
    ja: () =>
      translateWith("Could not reach openrouter.ai to load the model list. Check the connection and try again.", "ja", {}),
    samples: [
      "Could not reach openrouter.ai to load the model list. You may be offline, or DNS is not answering. Check the connection and try again.",
    ],
  },
  {
    rust: "OpenRouter rejected the API key (HTTP {code}) while loading the model list. Check the key in Settings.",
    re: /^OpenRouter rejected the API key \(HTTP (\d+)\) while loading the model list\. Check the key in Settings\.$/,
    ja: (m) => translateWith("OpenRouter rejected the API key (HTTP {code}). Check the key in Settings.", "ja", { code: m[1] }),
    samples: ["OpenRouter rejected the API key (HTTP 403) while loading the model list. Check the key in Settings."],
  },
  {
    rust: "OpenRouter is rate-limiting requests (HTTP 429). Wait a moment, then load the model list again.",
    re: /^OpenRouter is rate-limiting requests \(HTTP 429\)\. Wait a moment, then load the model list again\.$/,
    ja: () => translateWith("OpenRouter is rate-limiting requests (HTTP 429). Wait a moment, then try again.", "ja", {}),
    samples: ["OpenRouter is rate-limiting requests (HTTP 429). Wait a moment, then load the model list again."],
  },
  {
    rust: "OpenRouter is unavailable right now (HTTP {code}). Try loading the model list again later.",
    re: /^OpenRouter is unavailable right now \(HTTP (\d+)\)\. Try loading the model list again later\.$/,
    ja: (m) => translateWith("OpenRouter is unavailable right now (HTTP {code}). Try again later.", "ja", { code: m[1] }),
    samples: ["OpenRouter is unavailable right now (HTTP 503). Try loading the model list again later."],
  },
  {
    rust: "Could not load the OpenRouter model list (HTTP {code}).",
    re: /^Could not load the OpenRouter model list \(HTTP (\d+)\)\.$/,
    ja: (m) => translateWith("Could not load the OpenRouter model list (HTTP {code}).", "ja", { code: m[1] }),
    samples: ["Could not load the OpenRouter model list (HTTP 418)."],
  },
  {
    rust: "Loading the OpenRouter model list timed out after {CATALOG_TIMEOUT_SECS} s. Check the connection and try again.",
    re: /^Loading the OpenRouter model list timed out after (\d+) s\. Check the connection and try again\.$/,
    ja: (m) =>
      translateWith("Loading the OpenRouter model list timed out after {n} s. Check the connection and try again.", "ja", {
        n: m[1],
      }),
    samples: ["Loading the OpenRouter model list timed out after 20 s. Check the connection and try again."],
  },
  {
    rust: "Could not load the OpenRouter model list: {e}",
    re: /^Could not load the OpenRouter model list: ([\s\S]+)$/,
    ja: (m) => translateWith("Could not load the OpenRouter model list: {detail}", "ja", { detail: m[1] }),
    samples: ["Could not load the OpenRouter model list: connection reset"],
  },
  {
    rust: "Refusing to load the model list: openrouter.ai resolved to a private or loopback address (a VPN or DNS override?).",
    re: /^Refusing to load the model list: openrouter\.ai resolved to a private or loopback address \(a VPN or DNS override\?\)\.$/,
    ja: () =>
      translateWith(
        "Refusing to load the model list: openrouter.ai resolved to a private or loopback address (a VPN or DNS override?).",
        "ja",
        {}
      ),
    samples: ["Refusing to load the model list: openrouter.ai resolved to a private or loopback address (a VPN or DNS override?)."],
  },
  {
    rust: "The OpenRouter model list exceeded the {} MB limit and was not loaded.",
    re: /^The OpenRouter model list exceeded the (\d+) MB limit and was not loaded\.$/,
    ja: (m) => translateWith("The OpenRouter model list exceeded the {n} MB limit and was not loaded.", "ja", { n: m[1] }),
    samples: ["The OpenRouter model list exceeded the 8 MB limit and was not loaded."],
  },
  {
    rust: "The OpenRouter model list was not valid JSON ({e}).",
    re: /^The OpenRouter model list was not valid JSON \(([\s\S]+)\)\.$/,
    ja: (m) => translateWith("The OpenRouter model list was not valid JSON ({detail}).", "ja", { detail: m[1] }),
    samples: ["The OpenRouter model list was not valid JSON (expected value at line 1 column 1)."],
  },
  {
    rust: String.raw`The OpenRouter model list had an unexpected shape (no \"data\" array).`,
    re: /^The OpenRouter model list had an unexpected shape \(no "data" array\)\.$/,
    ja: () => translateWith("The OpenRouter model list had an unexpected shape.", "ja", {}),
    samples: ['The OpenRouter model list had an unexpected shape (no "data" array).'],
  },
];

/** commands.rs `api_key_for`: with an empty keychain, list_openrouter_models
 *  fails here, before openrouter_models.rs sees the key, so this is the no-key
 *  message the catalog panel actually shows. */
export const CATALOG_KEY_ERROR_RULES: LocalizeRule[] = [
  {
    rust: "No API key is set. Open Settings and add your OpenRouter API key. (Local endpoints such as Ollama can leave the key blank.)",
    re: /^No API key is set\. Open Settings and add your OpenRouter API key\. \(Local endpoints such as Ollama can leave the key blank\.\)$/,
    ja: () => translateWith("No API key is set. Add your OpenRouter API key in Settings to load the model list.", "ja", {}),
    samples: [
      "No API key is set. Open Settings and add your OpenRouter API key. (Local endpoints such as Ollama can leave the key blank.)",
    ],
  },
];

function applyRules(text: string, rules: LocalizeRule[]): string | null {
  for (const rule of rules) {
    const m = text.match(rule.re);
    if (m) return rule.ja(m);
  }
  return null;
}

/** One report warning in the UI language (unknown text is returned as-is). */
export function localizeExportWarning(raw: string, lang: UiLang): string {
  if (lang === "en") return raw;
  return applyRules(raw, EXPORT_WARNING_RULES) ?? translate(raw, lang);
}

/** AppError Display prefixes the catalog errors arrive with. */
const ERROR_PREFIX = /^(?:Network \/ API error|Configuration error): /;

/** A model-list error in the UI language (unknown text is returned as-is). */
export function localizeCatalogError(raw: string, lang: UiLang): string {
  if (lang === "en") return raw;
  const body = raw.replace(ERROR_PREFIX, "");
  return applyRules(body, CATALOG_ERROR_RULES) ?? applyRules(body, CATALOG_KEY_ERROR_RULES) ?? raw;
}
