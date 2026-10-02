// Localize AI / provider errors coming back from the Rust backend.
//
// Constraints:
// - The backend's `AppError` reaches the webview only as its English Display
//   string (src-tauri/src/error.rs), so classification is by stable leading
//   markers. Each marker below is a contract with a literal in error.rs or in
//   `map_provider_error` / the empty-response guards in ai.rs, and
//   aiErrors.test.ts raw-reads those Rust files to keep both sides in step.
// - Pure: no store access. Callers pass the UI language.
// - Unknown strings pass through unchanged; nothing is guessed at.
// - Known limit: errors from other AI failure paths (network-level transport
//   errors, "image model returned no image", analysis JSON parse failures)
//   are not recognized and stay English.

import { translate, translateWith, type UiLang } from "./i18n";

/** error.rs `AppError::Network` Display prefix, stripped before matching. */
export const NETWORK_ERROR_PREFIX = "Network / API error: ";
/** error.rs `AppError::ModelUnavailable`: "Model unavailable: '<model>' could not be served…" */
export const MODEL_UNAVAILABLE_PREFIX = "Model unavailable: '";
export const MODEL_UNAVAILABLE_MODEL_END = "' could not be served by the provider";
/** ai.rs map_provider_error, 404 from a non-OpenRouter endpoint. */
export const NOT_FOUND_PREFIX = "Not found (404): the model '";
export const NOT_FOUND_MODEL_END = "' or the endpoint URL is wrong";
/** ai.rs map_provider_error, 429. */
export const RATE_LIMITED_PREFIX = "Rate limited (429)";
/** ai.rs map_provider_error, 401 / 403: "Authorization failed (<status>)…" */
export const AUTH_FAILED_PREFIX = "Authorization failed (";
/** ai.rs complete() / finalize_stream(). */
export const EMPTY_RESPONSE_PREFIX = "The model returned an empty response";
/** Every mapped message ends with " (provider: <detail>)". */
export const PROVIDER_DETAIL_OPEN = " (provider: ";
/** ai.rs provider_detail() placeholder when the provider said nothing usable. */
export const UNKNOWN_PROVIDER_DETAIL = "unknown error";

/** Dictionary keys used here (English copy; JA entries in i18n.ts). */
export const AI_ERROR_KEYS = {
  modelUnavailable:
    "The model '{model}' is not available from the provider. Choose another model in Settings.",
  notFound:
    "Not found (404): the model '{model}' or the endpoint URL is wrong. Check both in Settings.",
  rateLimited:
    "Rate limited (429). Wait a minute and retry, switch models in Settings, or add credit at openrouter.ai.",
  authFailed: "Authorization failed ({code}). Check your OpenRouter API key in Settings.",
  emptyResponse: "The model returned an empty response. Try again, or switch models in Settings.",
  http: "The AI provider returned an error (HTTP {code}).",
  provider: "Provider",
  // The persistent model-issue indicator is HealthBar's aiModelIssue chip
  // ("Model unavailable: {model}" + Open Settings); its copy lives there.
} as const;

export type AiErrorKind =
  | "model-unavailable"
  | "not-found"
  | "rate-limited"
  | "auth"
  | "empty-response"
  | "http"
  | "unknown";

export interface LocalizedAiError {
  /** Message to show, in the UI language (unchanged input for "unknown"). */
  text: string;
  kind: AiErrorKind;
  /** Set ONLY for "model-unavailable": the configured model the provider can't serve. */
  model?: string;
  /** True when the fix lives in Settings (model, endpoint, API key). */
  openSettings: boolean;
}

/** Split "<head> (provider: <detail>)" → [head, detail]. */
function splitDetail(s: string): [string, string | undefined] {
  const i = s.indexOf(PROVIDER_DETAIL_OPEN);
  if (i < 0) return [s, undefined];
  const rest = s.slice(i + PROVIDER_DETAIL_OPEN.length);
  return [s.slice(0, i), rest.endsWith(")") ? rest.slice(0, -1) : rest];
}

function withDetail(text: string, detail: string | undefined, lang: UiLang): string {
  const d = detail?.trim();
  if (!d || d === UNKNOWN_PROVIDER_DETAIL) return text;
  const label = translate(AI_ERROR_KEYS.provider, lang);
  return lang === "ja" ? `${text}（${label}: ${d}）` : `${text} (${label}: ${d})`;
}

/** Text between `prefix` and `end` at the start of `s`, if both are present. */
function between(s: string, prefix: string, end: string): string | undefined {
  if (!s.startsWith(prefix)) return undefined;
  const stop = s.indexOf(end, prefix.length);
  return stop < 0 ? undefined : s.slice(prefix.length, stop);
}

/** Classify and localize one backend error string. */
export function localizeAiError(raw: string, lang: UiLang): LocalizedAiError {
  const unknown: LocalizedAiError = { text: raw, kind: "unknown", openSettings: false };
  const s = raw.startsWith(NETWORK_ERROR_PREFIX) ? raw.slice(NETWORK_ERROR_PREFIX.length) : raw;
  const [, detail] = splitDetail(s);

  const unavailable = between(s, MODEL_UNAVAILABLE_PREFIX, MODEL_UNAVAILABLE_MODEL_END);
  if (unavailable !== undefined) {
    return {
      text: withDetail(translateWith(AI_ERROR_KEYS.modelUnavailable, lang, { model: unavailable }), detail, lang),
      kind: "model-unavailable",
      model: unavailable,
      openSettings: true,
    };
  }

  const notFound = between(s, NOT_FOUND_PREFIX, NOT_FOUND_MODEL_END);
  if (notFound !== undefined) {
    return {
      text: withDetail(translateWith(AI_ERROR_KEYS.notFound, lang, { model: notFound }), detail, lang),
      kind: "not-found",
      openSettings: true,
    };
  }

  if (s.startsWith(RATE_LIMITED_PREFIX)) {
    return {
      text: withDetail(translate(AI_ERROR_KEYS.rateLimited, lang), detail, lang),
      kind: "rate-limited",
      openSettings: true,
    };
  }

  const auth = s.startsWith(AUTH_FAILED_PREFIX) ? /^\((\d{3})\)/.exec(s.slice(AUTH_FAILED_PREFIX.length - 1)) : null;
  if (auth) {
    return {
      text: withDetail(translateWith(AI_ERROR_KEYS.authFailed, lang, { code: auth[1] }), detail, lang),
      kind: "auth",
      openSettings: true,
    };
  }

  if (s.startsWith(EMPTY_RESPONSE_PREFIX)) {
    return {
      text: translate(AI_ERROR_KEYS.emptyResponse, lang),
      kind: "empty-response",
      openSettings: true,
    };
  }

  const http = /^API (\d{3}): ([\s\S]*)$/.exec(s);
  if (http) {
    return {
      text: withDetail(translateWith(AI_ERROR_KEYS.http, lang, { code: http[1] }), http[2], lang),
      kind: "http",
      openSettings: false,
    };
  }

  return unknown;
}
