// Pure logic behind the OpenRouter model catalog in Settings
// (components/OpenRouterModelCatalog.tsx) and the shared "select a model" path.
//
// Constraints (tested in openRouterModels.test.ts):
// - applyModelSelection is the ONE way a model id enters a picker, for both
//   manual entry and catalog selection: trimmed, added once, selected, and
//   its removedModels tombstone lifted. A blank id changes nothing.
// - Prices are the API's verbatim USD-per-token strings. Only a plain
//   non-negative decimal counts as a price. A model is free only when prompt
//   and completion are exactly 0 AND no other listed price (request, image,
//   imageOutput) is non-zero or invalid. Negative (router sentinel), missing
//   or non-numeric prices are never "free" and format as "—".
// - The catalog reducer never drops the previous list: a refresh in flight and
//   a failed refresh keep it, so a 429 never empties the picker.
// - missingSavedModels only warns. Nothing here removes a saved model.
// - isOpenRouterEndpoint mirrors the Rust gate in openrouter_models.rs
//   (https, exact host openrouter.ai, port 443); the test reuses the Rust
//   test's fixtures.
// - catalogFetchBlock is the ONE decision behind the catalog's Fetch / Try
//   again (security-rust-1): the backend reads the keychain key only when the
//   PERSISTED endpoint is OpenRouter, and never sees a key typed into the
//   form, so Fetch stays blocked, with a reason, while the form endpoint
//   differs from the saved one or the key field holds unsaved text. The Rust
//   check stays authoritative; this only keeps the UI from offering a fetch
//   that would use a different endpoint or key than the one shown.
//
// Known limits:
// - OpenRouter routing shortcuts such as ":online" or ":nitro" are not
//   separate catalog rows, so a saved id with such a suffix is reported as
//   not found. The badge is a warning only.
// - Only prompt/completion prices are shown; image prices are used for the
//   free decision but not displayed (planned).

import { interpolate } from "./i18n";
import type { OpenRouterCatalog, OpenRouterModel, Settings } from "./types";

export type CatalogKind = "text" | "image";

/** The Settings fields a picker of this kind edits. */
export function modelKeysFor(kind: CatalogKind): {
  listKey: "models" | "imageModels";
  activeKey: "model" | "imageModel";
} {
  return kind === "text"
    ? { listKey: "models", activeKey: "model" }
    : { listKey: "imageModels", activeKey: "imageModel" };
}

/** Add `raw` (trimmed) to the kind's list once, select it, and lift its
 *  tombstone (item 69). Returns `s` itself when the id is blank. */
export function applyModelSelection(s: Settings, kind: CatalogKind, raw: string): Settings {
  const id = raw.trim();
  if (!id) return s;
  const { listKey, activeKey } = modelKeysFor(kind);
  return {
    ...s,
    [listKey]: s[listKey].includes(id) ? s[listKey] : [...s[listKey], id],
    [activeKey]: id,
    removedModels: (s.removedModels ?? []).filter((m) => m !== id),
  };
}

const DECIMAL = /^\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

/** A price string as a number, or null when it is absent, negative or not a
 *  plain decimal ("", "-1", "abc", "0x0", "Infinity" are all null). */
export function parseCatalogPrice(v: string | null | undefined): number | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!DECIMAL.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function isFreeModel(m: OpenRouterModel): boolean {
  const p = m.pricing ?? {};
  if (parseCatalogPrice(p.prompt) !== 0 || parseCatalogPrice(p.completion) !== 0) return false;
  // Any other listed price must also be zero: a non-zero or invalid one means
  // the model is not actually free.
  return [p.request, p.image, p.imageOutput].every(
    (x) => x === null || x === undefined || parseCatalogPrice(x) === 0
  );
}

/** USD per token → a short "per 1M tokens" amount. */
function usdPerMillion(perToken: number): string {
  const v = perToken * 1_000_000;
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  if (v < 1) return `$${v.toPrecision(2)}`;
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v)}`;
}

/** "Free", "$0.15 in / $0.60 out per 1M tokens", or "—" when either price is
 *  missing or invalid. `t` is the UI translator. */
export function formatCatalogPrice(m: OpenRouterModel, t: (key: string) => string): string {
  if (isFreeModel(m)) return t("Free");
  const input = parseCatalogPrice(m.pricing?.prompt);
  const output = parseCatalogPrice(m.pricing?.completion);
  if (input === null || output === null) return "—";
  return interpolate(t("{input} in / {output} out per 1M tokens"), {
    input: usdPerMillion(input),
    output: usdPerMillion(output),
  });
}

/** 131072 → "131K", 1048576 → "1M"; null for an unknown length. */
export function formatContextLength(n: number | null | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

/** Whether the model can produce this kind of output. */
export function hasOutputModality(m: OpenRouterModel, kind: CatalogKind): boolean {
  return (m.outputModalities ?? []).some((x) => x.trim().toLowerCase() === kind);
}

/** Width- and case-folded text for search (half-width ｶﾅ matches カナ). */
function fold(s: string): string {
  return s.normalize("NFKC").toLocaleLowerCase();
}

/** Models of this kind whose name or id contains every word of `query`,
 *  optionally only free ones. Keeps the catalog's order. */
export function filterCatalog(
  models: OpenRouterModel[],
  kind: CatalogKind,
  query: string,
  freeOnly: boolean
): OpenRouterModel[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return models.filter((m) => {
    if (!hasOutputModality(m, kind)) return false;
    if (freeOnly && !isFreeModel(m)) return false;
    if (!words.length) return true;
    const hay = fold(`${m.name}\n${m.id}`);
    return words.every((w) => hay.includes(w));
  });
}

/** Initial filters: no query, "Free only" ON. */
export const DEFAULT_CATALOG_FILTERS: Readonly<{ query: string; freeOnly: boolean }> = {
  query: "",
  freeOnly: true,
};

// ----- Catalog request state ---------------------------------------------------

export interface CatalogState {
  status: "idle" | "loading" | "ready" | "error";
  /** The last successfully loaded list (kept through refreshes and failures). */
  models: OpenRouterModel[];
  /** Rows the backend dropped (no id / duplicate id) in the last load. */
  skipped: number;
  /** The last failure, verbatim from the backend. */
  error: string | null;
  /** True once any load has succeeded. */
  loaded: boolean;
}

export const EMPTY_CATALOG_STATE: CatalogState = {
  status: "idle",
  models: [],
  skipped: 0,
  error: null,
  loaded: false,
};

export function catalogLoading(s: CatalogState): CatalogState {
  return { ...s, status: "loading", error: null };
}

export function catalogLoaded(_s: CatalogState, catalog: OpenRouterCatalog): CatalogState {
  return { status: "ready", models: catalog.models, skipped: catalog.skipped, error: null, loaded: true };
}

export function catalogFailed(s: CatalogState, error: string): CatalogState {
  return { ...s, status: "error", error };
}

/** Saved ids absent from the loaded catalog; empty until a catalog has loaded,
 *  and for an empty catalog (a provider glitch, not proof every model is gone). */
export function missingSavedModels(saved: string[], s: CatalogState): string[] {
  if (!s.loaded || s.models.length === 0) return [];
  const ids = new Set(s.models.map((m) => m.id));
  return saved.filter((id) => !ids.has(id));
}

/** Why the catalog cannot be fetched right now (null = it can):
 *  - "custom-endpoint": the form endpoint is not OpenRouter;
 *  - "endpoint-unsaved": the form endpoint differs from the saved one, or the
 *    saved one is not OpenRouter (the backend gates on the saved value);
 *  - "key-unsaved": the API-key field holds text not yet saved to the
 *    keychain (the backend would use the saved key, not the typed one). */
export type CatalogFetchBlock = "custom-endpoint" | "endpoint-unsaved" | "key-unsaved";

/** The Fetch gate. Endpoints compare trimmed (as the Rust gate parses them);
 *  key text that is blank after trimming is not a key (save() trims it). */
export function catalogFetchBlock(
  formEndpoint: string,
  savedEndpoint: string,
  unsavedApiKey: string
): CatalogFetchBlock | null {
  if (!isOpenRouterEndpoint(formEndpoint)) return "custom-endpoint";
  if (formEndpoint.trim() !== savedEndpoint.trim() || !isOpenRouterEndpoint(savedEndpoint)) {
    return "endpoint-unsaved";
  }
  if (unsavedApiKey.trim()) return "key-unsaved";
  return null;
}

/** Mirror of Rust `openrouter_models::is_openrouter_endpoint`. */
export function isOpenRouterEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint.trim());
    return url.protocol === "https:" && url.hostname === "openrouter.ai" && url.port === "";
  } catch {
    return false;
  }
}
