import { describe, expect, it } from "vitest";
import {
  AI_ERROR_KEYS,
  AUTH_FAILED_PREFIX,
  EMPTY_RESPONSE_PREFIX,
  MODEL_UNAVAILABLE_MODEL_END,
  MODEL_UNAVAILABLE_PREFIX,
  NETWORK_ERROR_PREFIX,
  NOT_FOUND_MODEL_END,
  NOT_FOUND_PREFIX,
  PROVIDER_DETAIL_OPEN,
  RATE_LIMITED_PREFIX,
  UNKNOWN_PROVIDER_DETAIL,
  localizeAiError,
} from "./aiErrors";
import { JA } from "./i18n";

const MODEL = "meta-llama/llama-3.3-70b-instruct:free";

describe("localizeAiError — classification and Japanese copy", () => {
  it("localizes ModelUnavailable in Japanese and names the model", () => {
    const r = localizeAiError(
      `Model unavailable: '${MODEL}' could not be served by the provider (HTTP 404). Choose another model in Settings. (provider: No endpoints found)`,
      "ja"
    );
    expect(r.kind).toBe("model-unavailable");
    expect(r.model).toBe(MODEL);
    expect(r.openSettings).toBe(true);
    expect(r.text).toBe(
      `モデル「${MODEL}」は提供元で利用できません。設定で別のモデルを選んでください。（提供元: No endpoints found）`
    );
  });

  it("keeps an English UI in English but drops the transport prefix", () => {
    const r = localizeAiError(
      `Model unavailable: '${MODEL}' could not be served by the provider (HTTP 404). Choose another model in Settings. (provider: No endpoints found)`,
      "en"
    );
    expect(r.text).toBe(
      `The model '${MODEL}' is not available from the provider. Choose another model in Settings. (Provider: No endpoints found)`
    );
  });

  it("classifies a custom-endpoint 404 as 'model or endpoint' and never reports a model issue", () => {
    const r = localizeAiError(
      "Network / API error: Not found (404): the model 'llama3' or the endpoint URL is wrong. Check both in Settings. (provider: page not found)",
      "ja"
    );
    expect(r.kind).toBe("not-found");
    expect(r.model).toBeUndefined();
    expect(r.openSettings).toBe(true);
    expect(r.text).toBe(
      "見つかりません(404): モデル「llama3」またはエンドポイントURLが正しくありません。設定で両方を確認してください。（提供元: page not found）"
    );
  });

  it("localizes 429 and keeps the provider detail", () => {
    const r = localizeAiError(
      "Network / API error: Rate limited (429). Free OpenRouter models share tight limits — wait a minute and retry, switch to another model in Settings, or add credit at openrouter.ai. (provider: busy (retry later))",
      "ja"
    );
    expect(r.kind).toBe("rate-limited");
    // Detail keeps its own parentheses: everything up to the FINAL ")".
    expect(r.text.endsWith("（提供元: busy (retry later)）")).toBe(true);
    expect(r.text.startsWith("利用制限中です(429)。")).toBe(true);
  });

  it("localizes 401/403 and carries the status code into the copy", () => {
    const r = localizeAiError(
      "Network / API error: Authorization failed (403). Check your OpenRouter API key in Settings. (provider: unknown error)",
      "ja"
    );
    expect(r.kind).toBe("auth");
    // The "unknown error" placeholder is not worth showing (and is English).
    expect(r.text).toBe("認証に失敗しました(403)。設定でOpenRouter APIキーを確認してください。");
  });

  it("maps both empty-response wordings (complete and stream) to one message", () => {
    for (const raw of [
      "Network / API error: The model returned an empty response.",
      "Network / API error: The model returned an empty response. Try again, or switch models in Settings.",
    ]) {
      const r = localizeAiError(raw, "ja");
      expect(r.kind, raw).toBe("empty-response");
      expect(r.text, raw).toBe("モデルから空の応答が返りました。再試行するか、設定でモデルを切り替えてください。");
    }
  });

  it("localizes the generic 'API <code>: …' shape without offering Settings", () => {
    const r = localizeAiError("Network / API error: API 502: bad gateway", "ja");
    expect(r.kind).toBe("http");
    expect(r.openSettings).toBe(false);
    expect(r.text).toBe("AIプロバイダがエラーを返しました(HTTP 502)。（提供元: bad gateway）");
  });

  it("does not let '$' sequences in provider detail act as replacement patterns", () => {
    const r = localizeAiError("Network / API error: API 500: cost $& $1 {model}", "en");
    expect(r.text).toBe("The AI provider returned an error (HTTP 500). (Provider: cost $& $1 {model})");
  });

  it("passes unknown errors through unchanged", () => {
    expect(localizeAiError("File I/O error: x", "ja")).toEqual({
      text: "File I/O error: x",
      kind: "unknown",
      openSettings: false,
    });
    const net = "Network / API error: error sending request for url (https://openrouter.ai/)";
    expect(localizeAiError(net, "ja").text).toBe(net);
    // A malformed ModelUnavailable (no closing marker) is not guessed at.
    expect(localizeAiError("Model unavailable: 'x", "ja").text).toBe("Model unavailable: 'x");
  });
});

describe("the Japanese dictionary covers every AI error key", () => {
  it("has a Japanese entry for each key (translate(KEY, lang) calls are invisible to the t() scan)", () => {
    const cjk = /[぀-ヿ一-龯]/;
    const keys = Object.values(AI_ERROR_KEYS);
    expect(keys.length).toBeGreaterThanOrEqual(7);
    for (const k of keys) {
      expect(JA[k], `missing JA for "${k}"`).toBeDefined();
      expect(cjk.test(JA[k]), `"${k}" → "${JA[k]}" is not Japanese`).toBe(true);
      // Placeholders must survive translation or interpolation silently drops the value.
      for (const ph of k.match(/\{\w+\}/g) ?? []) expect(JA[k], `${k}: ${ph}`).toContain(ph);
    }
  });
});

// ---------------------------------------------------------------------------
// Contract with the Rust producer. The frontend only receives AppError's
// Display string, so the markers above are a cross-language contract. Read the
// Rust sources raw and feed REAL samples built from their literals back into
// the localizer: a wording change on either side fails here.
// ---------------------------------------------------------------------------

const rustSource = (path: string): string => {
  const files = import.meta.glob(["../src-tauri/src/error.rs", "../src-tauri/src/ai.rs"], {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>;
  const src = files[path];
  if (typeof src !== "string") throw new Error(`could not read ${path}`);
  // Rust string continuations: a trailing "\" + newline + indentation is elided.
  return src.replace(/\\\n\s*/g, "");
};

/** The body of `fn map_provider_error` in ai.rs (up to the next top-level item). */
const mapperBody = (): string => {
  const ai = rustSource("../src-tauri/src/ai.rs");
  const start = ai.indexOf("fn map_provider_error(");
  expect(start, "fn map_provider_error not found in ai.rs").toBeGreaterThan(-1);
  const end = ai.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return ai.slice(start, end);
};

/** The string literal in `src` that starts with `marker` (Rust escapes undone). */
const literalStartingWith = (src: string, marker: string): string => {
  for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const lit = m[1].replace(/\\(["\\'])/g, "$1");
    if (lit.startsWith(marker)) return lit;
  }
  throw new Error(`no Rust literal starts with ${JSON.stringify(marker)}`);
};

const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);

describe("contract with src-tauri error.rs / ai.rs", () => {
  it("error.rs ModelUnavailable Display round-trips through the localizer", () => {
    const err = rustSource("../src-tauri/src/error.rs");
    const m = err.match(/#\[error\("((?:[^"\\]|\\.)*)"\)\]\s*ModelUnavailable\s*\{/);
    expect(m, "ModelUnavailable #[error(...)] not found").not.toBeNull();
    const template = m![1];
    expect(template.startsWith(MODEL_UNAVAILABLE_PREFIX + "{model}" + MODEL_UNAVAILABLE_MODEL_END)).toBe(true);
    expect(template.endsWith(PROVIDER_DETAIL_OPEN + "{detail})")).toBe(true);

    const sample = fill(template, { model: MODEL, detail: "No endpoints found" });
    const r = localizeAiError(sample, "ja");
    expect(r.kind).toBe("model-unavailable");
    expect(r.model).toBe(MODEL);
    expect(r.text).toContain("（提供元: No endpoints found）");
  });

  it("error.rs Network variant carries the prefix the localizer strips", () => {
    const err = rustSource("../src-tauri/src/error.rs");
    const m = err.match(/#\[error\("((?:[^"\\]|\\.)*)"\)\]\s*Network\(String\)/);
    expect(m?.[1]).toBe(NETWORK_ERROR_PREFIX + "{0}");
  });

  it("every Network message built by ai.rs map_provider_error is classified", () => {
    const body = mapperBody();
    const vars = { model: "llama3", provider_msg: "detail (x)", status: "401", code: "502" };
    const cases: Array<[string, string]> = [
      [NOT_FOUND_PREFIX, "not-found"],
      [RATE_LIMITED_PREFIX, "rate-limited"],
      [AUTH_FAILED_PREFIX, "auth"],
      ["API {code}: ", "http"],
    ];
    for (const [marker, kind] of cases) {
      const lit = literalStartingWith(body, marker);
      const sample = NETWORK_ERROR_PREFIX + fill(lit, vars);
      const r = localizeAiError(sample, "ja");
      expect(r.kind, sample).toBe(kind);
      expect(r.text, sample).toContain("（提供元: detail (x)）");
      expect(r.text, sample).not.toContain(NETWORK_ERROR_PREFIX);
    }
    // The 404 marker's model boundary matches too, so the model id is extracted.
    expect(literalStartingWith(body, NOT_FOUND_PREFIX)).toContain(
      NOT_FOUND_PREFIX + "{model}" + NOT_FOUND_MODEL_END
    );
    // The 404 → ModelUnavailable arm is the error.rs variant tested above.
    expect(body).toMatch(/AppError::ModelUnavailable\s*\{/);
  });

  it("ai.rs uses the same 'unknown error' placeholder the localizer hides", () => {
    const ai = rustSource("../src-tauri/src/ai.rs");
    const detailFn = ai.slice(ai.indexOf("fn provider_detail("), ai.indexOf("fn is_openrouter_endpoint("));
    expect(detailFn).toContain(`"${UNKNOWN_PROVIDER_DETAIL}"`);
  });

  it("both ai.rs empty-response errors are recognized", () => {
    const ai = rustSource("../src-tauri/src/ai.rs");
    const lits = [...ai.matchAll(/"(The model returned an empty response[^"]*)"/g)].map((m) => m[1]);
    expect(lits.length).toBeGreaterThanOrEqual(2); // complete() + finalize_stream()
    for (const lit of lits) {
      expect(lit.startsWith(EMPTY_RESPONSE_PREFIX)).toBe(true);
      expect(localizeAiError(NETWORK_ERROR_PREFIX + lit, "ja").kind, lit).toBe("empty-response");
    }
  });
});

describe("ux-a11y-i18n-8 — the model-issue chip is built, and aiErrors.ts does not call it planned", () => {
  const raw = import.meta.glob(["./aiErrors.ts", "./components/HealthBar.tsx"], {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>;

  it("HealthBar renders the persistent chip; the dead 'planned' label key is gone", () => {
    expect(raw["./components/HealthBar.tsx"]).toMatch(/translateWith\("Model unavailable: \{model\}"/);
    expect(Object.keys(AI_ERROR_KEYS)).not.toContain("modelUnavailableLabel");
    expect(raw["./aiErrors.ts"]).not.toMatch(/HealthBar chip; planned/);
  });
});
