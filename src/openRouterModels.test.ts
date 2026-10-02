import { describe, expect, it } from "vitest";
import {
  applyModelSelection,
  catalogFailed,
  catalogFetchBlock,
  catalogLoaded,
  catalogLoading,
  DEFAULT_CATALOG_FILTERS,
  EMPTY_CATALOG_STATE,
  filterCatalog,
  formatCatalogPrice,
  formatContextLength,
  isFreeModel,
  isOpenRouterEndpoint,
  missingSavedModels,
  type CatalogState,
} from "./openRouterModels";
import { DEFAULT_SETTINGS } from "./settingsDefaults";
import type { OpenRouterModel, OpenRouterPricing, Settings } from "./types";

const price = (p: Partial<OpenRouterPricing> = {}): OpenRouterPricing => ({
  prompt: null,
  completion: null,
  request: null,
  image: null,
  imageOutput: null,
  ...p,
});

const model = (id: string, over: Partial<OpenRouterModel> = {}): OpenRouterModel => ({
  id,
  name: id,
  description: "",
  contextLength: null,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: [],
  pricing: price({ prompt: "0.000001", completion: "0.000002" }),
  ...over,
});

const FREE = price({ prompt: "0", completion: "0" });

const models: OpenRouterModel[] = [
  model("vendor/text"),
  model("vendor/image", { outputModalities: ["image"] }),
  model("vendor/both", { outputModalities: ["text", "image"] }),
  model("vendor/free", { pricing: FREE }),
  model("google/gemma-jp:free", { name: "Google: ジェマ 日本語モデル", pricing: FREE }),
];

// Identity translator: the English key is the English copy.
const tEn = (k: string) => k;

const base: Settings = { ...DEFAULT_SETTINGS, models: ["a"], model: "a", removedModels: ["x"] };

describe("applyModelSelection — one path for manual add and catalog select", () => {
  it("selecting catalog model adds once, selects and clears tombstone", () => {
    const next = applyModelSelection(base, "text", "x");
    expect(next.models.filter((i) => i === "x")).toHaveLength(1);
    expect(next.model).toBe("x");
    expect(next.removedModels).not.toContain("x");
  });

  it("selecting a model already in the list selects it without duplicating", () => {
    const next = applyModelSelection({ ...base, models: ["a", "b"] }, "text", "b");
    expect(next.models).toEqual(["a", "b"]);
    expect(next.model).toBe("b");
  });

  it("trims the id; a blank id changes nothing (same object)", () => {
    expect(applyModelSelection(base, "text", "  y  ").models).toEqual(["a", "y"]);
    expect(applyModelSelection(base, "text", "   ")).toBe(base);
    expect(applyModelSelection(base, "text", "")).toBe(base);
  });

  it("the image kind touches only imageModels / imageModel", () => {
    const next = applyModelSelection(base, "image", "vendor/img");
    expect(next.imageModels).toEqual([...base.imageModels, "vendor/img"]);
    expect(next.imageModel).toBe("vendor/img");
    expect(next.models).toBe(base.models);
    expect(next.model).toBe("a");
  });

  it("works when removedModels is absent (legacy settings)", () => {
    const legacy: Settings = { ...base, removedModels: undefined };
    expect(applyModelSelection(legacy, "text", "z").removedModels).toEqual([]);
  });
});

describe("isFreeModel / formatCatalogPrice", () => {
  it("only an exact 0 prompt and 0 completion price is free", () => {
    expect(isFreeModel(model("f", { pricing: FREE }))).toBe(true);
    expect(isFreeModel(model("f", { pricing: price({ prompt: "0.0", completion: "0" }) }))).toBe(true);
    expect(isFreeModel(model("p"))).toBe(false);
    expect(isFreeModel(model("p", { pricing: price({ prompt: "0", completion: "0.0000001" }) }))).toBe(false);
  });

  it("negative, missing and non-numeric prices are not free and format as —", () => {
    const bad = ["-1", "", "   ", "abc", "0x0", "Infinity", "NaN", null, undefined as unknown as null];
    for (const p of bad) {
      const m = model("m", { pricing: price({ prompt: p, completion: p }) });
      expect(isFreeModel(m), String(p)).toBe(false);
      expect(formatCatalogPrice(m, tEn), String(p)).toBe("—");
    }
    // One side valid, the other invalid → still not free, still —.
    const half = model("h", { pricing: price({ prompt: "0", completion: "-1" }) });
    expect(isFreeModel(half)).toBe(false);
    expect(formatCatalogPrice(half, tEn)).toBe("—");
  });

  it("a zero-token model with a non-zero request or image price is NOT free (stricter than 0/0)", () => {
    for (const extra of [{ request: "0.01" }, { image: "0.002" }, { imageOutput: "0.00003" }, { imageOutput: "-1" }]) {
      const m = model("m", { pricing: price({ prompt: "0", completion: "0", ...extra }) });
      expect(isFreeModel(m), JSON.stringify(extra)).toBe(false);
    }
    // Zero or absent extras keep it free.
    expect(isFreeModel(model("m", { pricing: price({ prompt: "0", completion: "0", request: "0", image: null }) }))).toBe(true);
  });

  it("free formats as the translated Free label", () => {
    expect(formatCatalogPrice(model("f", { pricing: FREE }), tEn)).toBe("Free");
    expect(formatCatalogPrice(model("f", { pricing: FREE }), (k) => (k === "Free" ? "無料" : k))).toBe("無料");
  });

  it("paid formats as USD per 1M input / output tokens", () => {
    const m = model("p", { pricing: price({ prompt: "0.00000015", completion: "0.0000006" }) });
    expect(formatCatalogPrice(m, tEn)).toBe("$0.15 in / $0.60 out per 1M tokens");
    const big = model("b", { pricing: price({ prompt: "0.000015", completion: "0.000075" }) });
    expect(formatCatalogPrice(big, tEn)).toBe("$15.00 in / $75.00 out per 1M tokens");
    const tiny = model("t", { pricing: price({ prompt: "0.000000001", completion: "0" }) });
    expect(formatCatalogPrice(tiny, tEn)).toBe("<$0.01 in / $0 out per 1M tokens");
  });

  it("formats context length compactly", () => {
    expect(formatContextLength(131072)).toBe("131K");
    expect(formatContextLength(1048576)).toBe("1M");
    expect(formatContextLength(2000000)).toBe("2M");
    expect(formatContextLength(1500000)).toBe("1.5M");
    expect(formatContextLength(512)).toBe("512");
    expect(formatContextLength(null)).toBeNull();
    expect(formatContextLength(0)).toBeNull();
    expect(formatContextLength(Number.NaN)).toBeNull();
  });
});

describe("filterCatalog", () => {
  const ids = (list: OpenRouterModel[]) => list.map((m) => m.id);

  it("image-only model never appears in text list; text+image appears in both", () => {
    const text = ids(filterCatalog(models, "text", "", false));
    const image = ids(filterCatalog(models, "image", "", false));
    expect(text).not.toContain("vendor/image");
    expect(text).toContain("vendor/both");
    expect(image).toEqual(["vendor/image", "vendor/both"]);
  });

  it("free only keeps exactly the free models", () => {
    expect(ids(filterCatalog(models, "text", "", true))).toEqual(["vendor/free", "google/gemma-jp:free"]);
  });

  it("search matches CJK and slug case-insensitively", () => {
    expect(ids(filterCatalog(models, "text", "ジェマ", false))).toEqual(["google/gemma-jp:free"]);
    expect(ids(filterCatalog(models, "text", "GEMMA", false))).toEqual(["google/gemma-jp:free"]);
    expect(ids(filterCatalog(models, "text", "Vendor/TEXT", false))).toEqual(["vendor/text"]);
  });

  it("search normalizes width (NFKC) and requires every word (mixed script)", () => {
    // Half-width katakana query matches the full-width name.
    expect(ids(filterCatalog(models, "text", "ｼﾞｪﾏ", false))).toEqual(["google/gemma-jp:free"]);
    expect(ids(filterCatalog(models, "text", "google 日本語", false))).toEqual(["google/gemma-jp:free"]);
    expect(ids(filterCatalog(models, "text", "google 中文", false))).toEqual([]);
  });

  it("modality match ignores case and whitespace; an empty query returns every match", () => {
    const odd = [model("odd", { outputModalities: [" Text "] })];
    expect(ids(filterCatalog(odd, "text", "  ", false))).toEqual(["odd"]);
  });

  it("free only is the default filter", () => {
    expect(DEFAULT_CATALOG_FILTERS).toEqual({ query: "", freeOnly: true });
  });
});

describe("catalog state reducer", () => {
  const loaded: CatalogState = catalogLoaded(EMPTY_CATALOG_STATE, { models, skipped: 2, warnings: ["x"] });

  it("starts idle and empty", () => {
    expect(EMPTY_CATALOG_STATE).toEqual({ status: "idle", models: [], skipped: 0, error: null, loaded: false });
  });

  it("loaded replaces the list and records the skipped count", () => {
    expect(loaded).toEqual({ status: "ready", models, skipped: 2, error: null, loaded: true });
  });

  it("failed refresh preserves previous catalog and saved models", () => {
    const failed = catalogFailed(catalogLoading(loaded), "OpenRouter is rate-limiting requests (HTTP 429).");
    expect(failed.models).toEqual(models);
    expect(failed.loaded).toBe(true);
    expect(failed.status).toBe("error");
    expect(failed.error).toContain("429");
  });

  it("a refresh in flight keeps the previous list visible and clears the old error", () => {
    const loading = catalogLoading(catalogFailed(loaded, "boom"));
    expect(loading.status).toBe("loading");
    expect(loading.models).toEqual(models);
    expect(loading.error).toBeNull();
  });

  it("a later success clears the error", () => {
    const again = catalogLoaded(catalogFailed(loaded, "boom"), { models: [models[0]], skipped: 0, warnings: [] });
    expect(again).toEqual({ status: "ready", models: [models[0]], skipped: 0, error: null, loaded: true });
  });
});

describe("missingSavedModels — warn, never delete", () => {
  it("marks saved openrouter model missing without deleting it", () => {
    const saved = ["vendor/text", "retired/model:free"];
    expect(missingSavedModels(saved, catalogLoaded(EMPTY_CATALOG_STATE, { models, skipped: 0, warnings: [] }))).toEqual([
      "retired/model:free",
    ]);
    expect(saved).toEqual(["vendor/text", "retired/model:free"]); // input untouched
  });

  it("marks nothing before a catalog has loaded (idle, loading, first fetch failed)", () => {
    const saved = ["anything"];
    expect(missingSavedModels(saved, EMPTY_CATALOG_STATE)).toEqual([]);
    expect(missingSavedModels(saved, catalogLoading(EMPTY_CATALOG_STATE))).toEqual([]);
    expect(missingSavedModels(saved, catalogFailed(EMPTY_CATALOG_STATE, "offline"))).toEqual([]);
  });

  it("an empty catalog (provider glitch) marks nothing", () => {
    const empty = catalogLoaded(EMPTY_CATALOG_STATE, { models: [], skipped: 0, warnings: [] });
    expect(missingSavedModels(["vendor/text", "other"], empty)).toEqual([]);
  });

  it("keeps marking against the previous catalog after a failed refresh", () => {
    const loaded = catalogLoaded(EMPTY_CATALOG_STATE, { models, skipped: 0, warnings: [] });
    expect(missingSavedModels(["gone"], catalogFailed(loaded, "429"))).toEqual(["gone"]);
  });
});

// The Rust command refuses any endpoint that is not https://openrouter.ai
// (openrouter_models.rs is_openrouter_endpoint). The UI gate must agree, so
// the fixtures come from the Rust test itself.
describe("isOpenRouterEndpoint mirrors the Rust catalog gate", () => {
  const rust = Object.values(
    import.meta.glob("../src-tauri/src/openrouter_models.rs", { eager: true, query: "?raw", import: "default" })
  )[0] as string;
  const head = "fn catalog_requires_openrouter_https_and_a_key() {";
  const start = rust.indexOf(head);
  const body = rust.slice(start, rust.indexOf("\n    }\n", start));
  const accepted = [
    ...[...body.matchAll(/let ok = "([^"]+)";/g)].map((m) => m[1]),
    ...[...body.matchAll(/validate_catalog_request\("([^"]+)", "[^"]*\S[^"]*"\)\.is_ok\(\)/g)].map((m) => m[1]),
  ];
  const refusedList = body.match(/for endpoint in \[([\s\S]*?)\]/)?.[1] ?? "";
  const refused = [...refusedList.matchAll(/"([^"]*)"/g)].map((m) => m[1]);

  it("found the Rust fixtures", () => {
    expect(start).toBeGreaterThan(-1);
    expect(accepted.length).toBeGreaterThanOrEqual(2);
    expect(refused.length).toBeGreaterThanOrEqual(5);
  });

  it("accepts every endpoint Rust accepts", () => {
    for (const e of accepted) expect(isOpenRouterEndpoint(e), e).toBe(true);
  });

  it("refuses every endpoint Rust refuses", () => {
    for (const e of refused) expect(isOpenRouterEndpoint(e), e).toBe(false);
  });

  it("the Rust gate still checks https, the exact host and port 443", () => {
    const fn = rust.slice(rust.indexOf("pub fn is_openrouter_endpoint"), rust.indexOf("pub fn ensure_openrouter_endpoint"));
    expect(fn).toContain('url.scheme() == "https"');
    expect(fn).toContain('url.host_str() == Some("openrouter.ai")');
    expect(fn).toContain("Some(443)");
  });

  it("port and whitespace edge cases", () => {
    expect(isOpenRouterEndpoint("  https://openrouter.ai/api/v1/chat/completions  ")).toBe(true);
    expect(isOpenRouterEndpoint("https://openrouter.ai:443/api/v1")).toBe(true);
    expect(isOpenRouterEndpoint("https://openrouter.ai:8443/api/v1")).toBe(false);
    expect(isOpenRouterEndpoint("https://openrouter.ai./api/v1")).toBe(false);
  });
});

// security-rust-1 (frontend half): list_openrouter_models reads the keychain
// key only when the PERSISTED endpoint is OpenRouter too, and it never sees a
// key typed into the form. Fetch is therefore blocked, with a reason, until
// the endpoint and key the user sees are the ones the backend will use.
describe("catalogFetchBlock — Fetch only for what is saved", () => {
  const OR = "https://openrouter.ai/api/v1/chat/completions";
  const GROQ = "https://api.groq.com/openai/v1/chat/completions";

  it("a non-OpenRouter form endpoint keeps the custom-endpoint reason (saved or not)", () => {
    expect(catalogFetchBlock(GROQ, GROQ, "")).toBe("custom-endpoint");
    expect(catalogFetchBlock(GROQ, OR, "")).toBe("custom-endpoint");
    expect(catalogFetchBlock(GROQ, OR, "sk-or-typed")).toBe("custom-endpoint");
  });

  it("an OpenRouter form endpoint over a saved non-OpenRouter endpoint is blocked until saved", () => {
    expect(catalogFetchBlock(OR, GROQ, "")).toBe("endpoint-unsaved");
    expect(catalogFetchBlock(OR, "", "")).toBe("endpoint-unsaved");
  });

  it("an unsaved edit between two OpenRouter URLs is blocked too (the form differs from the saved value)", () => {
    expect(catalogFetchBlock("https://openrouter.ai/api/v1", OR, "")).toBe("endpoint-unsaved");
  });

  it("the endpoint reason wins over the key reason (save fixes both at once)", () => {
    expect(catalogFetchBlock(OR, GROQ, "sk-or-typed")).toBe("endpoint-unsaved");
  });

  it("unsaved text in the API-key field blocks; whitespace-only text is not a key (save() trims it away)", () => {
    expect(catalogFetchBlock(OR, OR, "sk-or-typed")).toBe("key-unsaved");
    expect(catalogFetchBlock(OR, OR, "   ")).toBeNull();
  });

  it("saved OpenRouter endpoint shown unchanged and an empty key field: Fetch is allowed", () => {
    expect(catalogFetchBlock(OR, OR, "")).toBeNull();
    // Surrounding whitespace is not an edit (both sides are trimmed, like the Rust gate).
    expect(catalogFetchBlock(`  ${OR} `, OR, "")).toBeNull();
    expect(catalogFetchBlock(DEFAULT_SETTINGS.endpoint, DEFAULT_SETTINGS.endpoint, "")).toBeNull();
  });
});

// ----- Wiring guards (no DOM in this suite) ----------------------------------
// These prove the pure helpers are the ones the UI calls. Runtime behaviour
// (no request on opening Settings, the loading button, focus) is checked by
// hand in the installed app.
const componentSources = import.meta.glob(
  ["./components/SettingsModal.tsx", "./components/OpenRouterModelCatalog.tsx"],
  { eager: true, query: "?raw", import: "default" }
) as Record<string, string>;
const settingsSrc = () => componentSources["./components/SettingsModal.tsx"] ?? "";
const catalogSrc = () => componentSources["./components/OpenRouterModelCatalog.tsx"] ?? "";

describe("SettingsModal wiring", () => {
  it("manual add goes through applyModelSelection (no inline copy of the logic)", () => {
    expect(settingsSrc()).toMatch(/setForm\(\(f\) => applyModelSelection\(f, kind, raw\)\)/);
    expect(settingsSrc()).not.toMatch(/\[activeKey\]: id/);
  });

  it("renders the catalog for both model lists and selects through the same path", () => {
    expect(settingsSrc()).toMatch(/<OpenRouterModelCatalog[\s\S]*?kind=\{kind\}/);
    expect(settingsSrc()).toMatch(/onSelect=\{\(id\) => addModelTo\(kind, id\)\}/);
    expect(settingsSrc()).toMatch(/renderModelList\(\s*"text"/);
    expect(settingsSrc()).toMatch(/renderModelList\(\s*"image"/);
  });

  it("marks saved models missing from the catalog and the model behind the last 404", () => {
    expect(settingsSrc()).toContain("missingSavedModels(");
    expect(settingsSrc()).toMatch(/useStore\(\(s\) => s\.aiModelIssue\)/);
    expect(settingsSrc()).toContain('t("Unavailable (404)")');
    expect(settingsSrc()).toContain('t("Not found in the current OpenRouter catalog")');
  });

  it("opening Settings never fetches: the dialog itself does not call the catalog API", () => {
    expect(settingsSrc()).not.toContain("listOpenRouterModels");
    expect(settingsSrc()).toContain("useOpenRouterCatalog(");
  });

  it("gates Fetch on the SAVED endpoint and the unsaved key text, and hands the block to the hook and the catalog", () => {
    expect(settingsSrc()).toMatch(
      /const fetchBlock = catalogFetchBlock\(\s*form\.endpoint,\s*\(storedSettings \?\? DEFAULT_SETTINGS\)\.endpoint,\s*apiKey\s*\)/
    );
    expect(settingsSrc()).toMatch(/useOpenRouterCatalog\(form\.endpoint, fetchBlock\)/);
    expect(settingsSrc()).toMatch(/<OpenRouterModelCatalog[\s\S]*?fetchBlock=\{fetchBlock\}/);
  });
});

describe("OpenRouterModelCatalog wiring", () => {
  it("uses the pure helpers", () => {
    for (const fn of [
      "filterCatalog(",
      "formatCatalogPrice(",
      "formatContextLength(",
      "isOpenRouterEndpoint(",
      "catalogLoading",
      "catalogLoaded(",
      "catalogFailed(",
    ]) {
      expect(catalogSrc(), fn).toContain(fn);
    }
  });

  it("fetches only from the explicit button handler, never from an effect", () => {
    expect([...catalogSrc().matchAll(/api\.listOpenRouterModels\(/g)]).toHaveLength(1);
    expect(catalogSrc()).not.toContain("useEffect");
  });

  it("a blocked fetch never reaches the API: the hook checks the block before the call", () => {
    const fetchFn = catalogSrc().slice(catalogSrc().indexOf("const fetchCatalog"));
    const guard = fetchFn.indexOf("block !== null");
    const call = fetchFn.indexOf("api.listOpenRouterModels(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(call);
  });

  it("disables Fetch and Try again while blocked, with a visible reason tied to the button", () => {
    const src = catalogSrc();
    // Both buttons that run fetchAndOpen are disabled by the same flag.
    expect(src).toMatch(/onClick=\{fetchAndOpen\}\s*disabled=\{loading \|\| blocked\}/);
    expect(src).toMatch(/onClick=\{fetchAndOpen\}\s*disabled=\{blocked\}/);
    // One literal reason per block code, rendered inline and described-by.
    expect(src).toContain('t("Save the endpoint first to load the OpenRouter list.")');
    expect(src).toContain('t("Save the API key first to load the OpenRouter list.")');
    expect(src).toMatch(/aria-describedby=\{blockReason \? reasonId : undefined\}/);
    expect(src).toMatch(/<span id=\{reasonId\}[^>]*>\s*\{blockReason\}/);
    // The existing custom-endpoint reason is still the one shown for that code.
    expect(src).toMatch(/fetchBlock === "custom-endpoint"/);
    expect(src).toContain('t("Use manual model IDs with a custom endpoint.")');
  });

  it("guards against a double fetch while one is in flight", () => {
    const fetchFn = catalogSrc().slice(catalogSrc().indexOf("const fetchCatalog"));
    const guard = fetchFn.indexOf("inFlight.current");
    const call = fetchFn.indexOf("api.listOpenRouterModels(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(call);
  });

  it("the Fetch button and the inline Retry both run the same fetch", () => {
    expect([...catalogSrc().matchAll(/onClick=\{fetchAndOpen\}/g)].length).toBeGreaterThanOrEqual(2);
    expect(catalogSrc()).toContain('t("Try again")');
  });

  it("Free only starts from the shared default (ON)", () => {
    expect(catalogSrc()).toContain("useState(DEFAULT_CATALOG_FILTERS.freeOnly)");
  });

  it("owns no Enter / Escape handling (the shared Modal owns Escape)", () => {
    expect(catalogSrc()).not.toMatch(/key === "(Escape|Enter)"/);
  });
});
