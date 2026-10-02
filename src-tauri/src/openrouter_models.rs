//! OpenRouter model catalog: fetch `GET /api/v1/models` and normalize it into
//! the frontend-safe `OpenRouterCatalog` (camelCase; mirrored by
//! `OpenRouterCatalog`/`OpenRouterModel`/`OpenRouterPricing` in src/types.ts,
//! contract-tested below).
//!
//! Constraints this module keeps:
//!
//!   * The fetched URL is the fixed constant `OPENROUTER_MODELS_URL`. The
//!     renderer-supplied `endpoint` only GATES the request
//!     (`ensure_openrouter_endpoint`: https + host `openrouter.ai`); no
//!     caller-supplied string is ever fetched.
//!   * The request goes through `net::safe_fetch_bearer`: SSRF guard per hop,
//!     8 MB cap (`MAX_CATALOG_BYTES`), 20 s timeout (`CATALOG_TIMEOUT_SECS`),
//!     and the bearer only on same-origin https hops. It is counted in
//!     `net::stats()` (fetch counters), never as an AI call.
//!   * The API key is read in Rust, used only as the bearer value, and never
//!     returned, logged or placed in an error message. It is read only when
//!     the PERSISTED endpoint is OpenRouter too (`list_catalog`): the one
//!     keychain slot holds the saved endpoint's key, which may belong to
//!     another provider while the form shows an unsaved OpenRouter URL.
//!   * Parsing is lossy by design and reports it: a row without a usable id,
//!     or a duplicate id, is skipped and counted (`skipped` + `warnings`);
//!     one bad row never fails the whole catalog. Wrongly typed optional
//!     fields degrade to `null`/empty instead of dropping the row. Prices stay
//!     verbatim strings (numbers are stringified); deciding "free" is the
//!     frontend's job.
//!   * Retry: this is a documented exemption from rust.md rule 8's shared
//!     retry/backoff, and it holds only on this condition: the fetch is
//!     user-triggered, and the Settings catalog UI (OpenRouterModelCatalog.tsx)
//!     shows a failure inline with a "Try again" control that reruns the same
//!     fetch (guarded in openRouterModels.test.ts). Given that, a silent
//!     in-process retry would only delay the error. 401/403, 429, 5xx,
//!     offline and timeout get distinct messages (`map_catalog_failure`) so
//!     the user knows whether waiting helps.
//!
//! Known limit: a VPN / split-DNS setup that resolves openrouter.ai to a
//! private address is refused by the SSRF guard (see net.rs), even though the
//! chat calls in ai.rs, which skip that guard, would work.

use crate::error::{AppError, AppResult};
use crate::net::{self, FetchFailure};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

/// The only URL this module fetches. `output_modalities` defaults to text
/// server-side, so `all` is required for the image-model list.
pub const OPENROUTER_MODELS_URL: &str =
    "https://openrouter.ai/api/v1/models?output_modalities=all&sort=most-popular";
/// Response size cap (the full catalog is a few MB).
pub const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;
/// Request timeout.
pub const CATALOG_TIMEOUT_SECS: u64 = 20;

/// Per-token/per-request prices as the API's decimal USD strings, verbatim.
/// `None` when the API omits the field or sends a non-string, non-number.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterPricing {
    pub prompt: Option<String>,
    pub completion: Option<String>,
    pub request: Option<String>,
    pub image: Option<String>,
    pub image_output: Option<String>,
}

/// One catalog entry. Optional values serialize as `null` (never an absent
/// key), which src/types.ts mirrors as `| null`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterModel {
    pub id: String,
    /// Display name; falls back to `id` when missing or blank.
    pub name: String,
    pub description: String,
    pub context_length: Option<u64>,
    pub input_modalities: Vec<String>,
    pub output_modalities: Vec<String>,
    pub supported_parameters: Vec<String>,
    pub pricing: OpenRouterPricing,
}

/// Parse report: the usable models plus what was dropped and why.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterCatalog {
    pub models: Vec<OpenRouterModel>,
    /// Rows dropped (no usable id, or a duplicate id).
    pub skipped: u32,
    /// One specific, counted message per dropped class.
    pub warnings: Vec<String>,
}

/// True for `https://openrouter.ai/...` on the default port. Userinfo tricks
/// (`https://openrouter.ai@evil.com`) and look-alike hosts fail because the
/// parsed host is compared exactly.
pub fn is_openrouter_endpoint(endpoint: &str) -> bool {
    reqwest::Url::parse(endpoint.trim()).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("openrouter.ai")
            && url.port_or_known_default() == Some(443)
    })
}

pub fn ensure_openrouter_endpoint(endpoint: &str) -> AppResult<()> {
    if is_openrouter_endpoint(endpoint) {
        Ok(())
    } else {
        Err(AppError::Config(
            "The OpenRouter model list is available only when the endpoint is \
             OpenRouter (https://openrouter.ai/…)."
                .into(),
        ))
    }
}

/// Pure pre-flight check: an OpenRouter endpoint and a non-blank key.
pub fn validate_catalog_request(endpoint: &str, api_key: &str) -> AppResult<()> {
    ensure_openrouter_endpoint(endpoint)?;
    if api_key.trim().is_empty() {
        return Err(AppError::Config(
            "No API key is set. Open Settings and add your OpenRouter API key to \
             load the model list."
                .into(),
        ));
    }
    Ok(())
}

/// The command's whole flow: gate on BOTH the form `endpoint` and the
/// persisted `saved_endpoint` BEFORE reading the key, then fetch the fixed
/// URL. The keychain slot holds the saved endpoint's key, so a saved
/// non-OpenRouter endpoint (e.g. Groq) never has its key read or sent to
/// openrouter.ai, even while the form shows an unsaved OpenRouter URL; the
/// user saves first. `key_for` is `commands::api_key_for` in production.
pub async fn list_catalog<F>(
    endpoint: &str,
    saved_endpoint: &str,
    key_for: F,
) -> AppResult<OpenRouterCatalog>
where
    F: FnOnce(&str) -> AppResult<String>,
{
    ensure_openrouter_endpoint(endpoint)?;
    ensure_openrouter_endpoint(saved_endpoint)?;
    let api_key = key_for(endpoint)?;
    validate_catalog_request(endpoint, &api_key)?;
    fetch_catalog_from(OPENROUTER_MODELS_URL, &api_key).await
}

/// Fetch + parse. Private so the URL cannot come from outside this module;
/// production passes `OPENROUTER_MODELS_URL`, tests a blocked loopback URL.
async fn fetch_catalog_from(url: &str, api_key: &str) -> AppResult<OpenRouterCatalog> {
    let bytes = net::safe_fetch_bearer(url, MAX_CATALOG_BYTES, CATALOG_TIMEOUT_SECS, api_key)
        .await
        .map_err(map_catalog_failure)?;
    parse_catalog(&bytes)
}

const OFFLINE_MESSAGE: &str = "Could not reach openrouter.ai to load the model list. \
     You may be offline, or DNS is not answering. Check the connection and try again.";

/// Word each failure class so the user can tell whether to fix the key, wait,
/// or check the connection. Never includes the key (FetchFailure holds none).
pub fn map_catalog_failure(failure: FetchFailure) -> AppError {
    let message = match failure {
        FetchFailure::Status(code @ (401 | 403)) => format!(
            "OpenRouter rejected the API key (HTTP {code}) while loading the model list. \
             Check the key in Settings."
        ),
        FetchFailure::Status(429) => "OpenRouter is rate-limiting requests (HTTP 429). \
             Wait a moment, then load the model list again."
            .to_string(),
        FetchFailure::Status(code @ 500..=599) => format!(
            "OpenRouter is unavailable right now (HTTP {code}). \
             Try loading the model list again later."
        ),
        FetchFailure::Status(code) => {
            format!("Could not load the OpenRouter model list (HTTP {code}).")
        }
        FetchFailure::Unresolved => OFFLINE_MESSAGE.to_string(),
        FetchFailure::Transport(e) if e.is_timeout() => format!(
            "Loading the OpenRouter model list timed out after {CATALOG_TIMEOUT_SECS} s. \
             Check the connection and try again."
        ),
        FetchFailure::Transport(e) if e.is_connect() => OFFLINE_MESSAGE.to_string(),
        FetchFailure::Transport(e) => format!("Could not load the OpenRouter model list: {e}"),
        FetchFailure::Blocked(_) => "Refusing to load the model list: openrouter.ai resolved \
             to a private or loopback address (a VPN or DNS override?)."
            .to_string(),
        FetchFailure::TooLarge(_) => format!(
            "The OpenRouter model list exceeded the {} MB limit and was not loaded.",
            MAX_CATALOG_BYTES / (1024 * 1024)
        ),
        FetchFailure::Refused(message) => message,
    };
    AppError::Network(message)
}

/// A price as the API's string; numbers are stringified, anything else is None.
fn price(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// The string elements of an array field (non-strings dropped); [] otherwise.
fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn context_length(v: Option<&Value>) -> Option<u64> {
    let v = v?;
    v.as_u64().or_else(|| {
        v.as_f64()
            .filter(|f| f.is_finite() && *f >= 0.0 && *f <= u64::MAX as f64)
            .map(|f| f as u64)
    })
}

/// Normalize one raw row; None when it has no usable id.
fn normalize_row(row: &Value) -> Option<OpenRouterModel> {
    let obj = row.as_object()?;
    let id = obj.get("id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let text = |key: &str| obj.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let name = text("name");
    let architecture = obj.get("architecture");
    let arch = |key: &str| strings(architecture.and_then(|a| a.get(key)));
    let pricing = obj.get("pricing");
    let p = |key: &str| price(pricing.and_then(|p| p.get(key)));
    Some(OpenRouterModel {
        id: id.to_string(),
        name: if name.trim().is_empty() { id.to_string() } else { name },
        description: text("description"),
        context_length: context_length(obj.get("context_length")),
        input_modalities: arch("input_modalities"),
        output_modalities: arch("output_modalities"),
        supported_parameters: strings(obj.get("supported_parameters")),
        pricing: OpenRouterPricing {
            prompt: p("prompt"),
            completion: p("completion"),
            request: p("request"),
            image: p("image"),
            image_output: p("image_output"),
        },
    })
}

fn entries(n: u32) -> &'static str {
    if n == 1 { "entry" } else { "entries" }
}

/// Parse the `{"data":[...]}` body. The top-level shape must be right (else
/// Err); individual rows are skipped and counted.
pub fn parse_catalog(bytes: &[u8]) -> AppResult<OpenRouterCatalog> {
    let root: Value = serde_json::from_slice(bytes).map_err(|e| {
        AppError::Network(format!("The OpenRouter model list was not valid JSON ({e})."))
    })?;
    let rows = root.get("data").and_then(Value::as_array).ok_or_else(|| {
        AppError::Network(
            "The OpenRouter model list had an unexpected shape (no \"data\" array).".into(),
        )
    })?;

    let mut models = Vec::with_capacity(rows.len());
    let mut seen: HashSet<String> = HashSet::with_capacity(rows.len());
    let (mut without_id, mut duplicates) = (0u32, 0u32);
    for row in rows {
        match normalize_row(row) {
            None => without_id += 1,
            Some(m) if !seen.insert(m.id.clone()) => duplicates += 1,
            Some(m) => models.push(m),
        }
    }

    let mut warnings = Vec::new();
    if without_id > 0 {
        warnings.push(format!(
            "Skipped {without_id} catalog {} without a usable model id.",
            entries(without_id)
        ));
    }
    if duplicates > 0 {
        warnings.push(format!("Skipped {duplicates} duplicate catalog {}.", entries(duplicates)));
    }
    Ok(OpenRouterCatalog { models, skipped: without_id + duplicates, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::FetchFailure;

    const OFFICIAL_SHAPE: &[u8] = br#"{"data":[{"id":"vendor/text-image","name":"Text Image","description":"demo","context_length":128000,"architecture":{"modality":"text+image->text+image","input_modalities":["text","image"],"output_modalities":["text","image"]},"supported_parameters":["temperature"],"pricing":{"prompt":"0","completion":"0","request":"0","image":"0.04","image_output":"0.03","web_search":"0.01"},"top_provider":{"is_moderated":false}}]}"#;

    #[test]
    fn parses_official_catalog_shape_into_frontend_safe_models() {
        let catalog = parse_catalog(OFFICIAL_SHAPE).unwrap();
        assert_eq!(catalog.skipped, 0);
        let m = &catalog.models[0];
        assert_eq!(m.id, "vendor/text-image");
        assert_eq!(m.name, "Text Image");
        assert_eq!(m.description, "demo");
        assert_eq!(m.context_length, Some(128_000));
        assert_eq!(m.input_modalities, ["text", "image"]);
        assert_eq!(m.output_modalities, ["text", "image"]);
        assert_eq!(m.supported_parameters, ["temperature"]);
        assert_eq!(m.pricing.prompt.as_deref(), Some("0"));
        assert_eq!(m.pricing.completion.as_deref(), Some("0"));
        assert_eq!(m.pricing.request.as_deref(), Some("0"));
        assert_eq!(m.pricing.image.as_deref(), Some("0.04"));
        assert_eq!(m.pricing.image_output.as_deref(), Some("0.03"));
    }

    #[test]
    fn missing_optional_fields_default_instead_of_failing() {
        let catalog = parse_catalog(br#"{"data":[{"id":"a/b"}]}"#).unwrap();
        assert_eq!(catalog.skipped, 0);
        let m = &catalog.models[0];
        assert_eq!(m.context_length, None);
        assert_eq!(m.pricing.prompt, None);
        assert!(m.input_modalities.is_empty() && m.output_modalities.is_empty());
        // A missing/blank name falls back to the id, so the UI never renders
        // an empty row label.
        assert_eq!(m.name, "a/b");
        assert_eq!(m.description, "");
    }

    #[test]
    fn model_without_id_is_skipped_and_counted() {
        let json = br#"{"data":[{"id":"ok/one"},{"id":"   "},{"name":"no id"},"not an object",{"id":42}]}"#;
        let catalog = parse_catalog(json).unwrap();
        assert_eq!(catalog.models.len(), 1);
        assert_eq!(catalog.models[0].id, "ok/one");
        assert_eq!(catalog.skipped, 4);
        assert_eq!(
            catalog.warnings,
            ["Skipped 4 catalog entries without a usable model id."]
        );
    }

    #[test]
    fn duplicate_ids_are_kept_once_and_counted() {
        let json = br#"{"data":[{"id":"x/y","name":"first"},{"id":"x/y","name":"second"}]}"#;
        let catalog = parse_catalog(json).unwrap();
        assert_eq!(catalog.models.len(), 1);
        assert_eq!(catalog.models[0].name, "first");
        assert_eq!(catalog.skipped, 1);
        assert_eq!(catalog.warnings, ["Skipped 1 duplicate catalog entry."]);
    }

    #[test]
    fn a_wrongly_typed_field_does_not_drop_the_row() {
        // Numbers where strings are documented, a float context length, a
        // null architecture, a sentinel "-1" and a non-numeric price: the row
        // survives and prices stay verbatim strings for the frontend to judge.
        let json = br#"{"data":[{"id":"r/router","context_length":8192.0,"architecture":null,"pricing":{"prompt":-1,"completion":"abc","request":0.5,"image":null}}]}"#;
        let catalog = parse_catalog(json).unwrap();
        assert_eq!(catalog.skipped, 0);
        let m = &catalog.models[0];
        assert_eq!(m.context_length, Some(8192));
        assert_eq!(m.pricing.prompt.as_deref(), Some("-1"));
        assert_eq!(m.pricing.completion.as_deref(), Some("abc"));
        assert_eq!(m.pricing.request.as_deref(), Some("0.5"));
        assert_eq!(m.pricing.image, None);
        assert!(m.output_modalities.is_empty());
    }

    #[test]
    fn empty_data_is_an_empty_catalog_not_an_error() {
        let catalog = parse_catalog(br#"{"data":[]}"#).unwrap();
        assert!(catalog.models.is_empty());
        assert_eq!(catalog.skipped, 0);
        assert!(catalog.warnings.is_empty());
    }

    #[test]
    fn wrong_top_level_shapes_are_errors() {
        for bad in [
            &br#"[{"id":"a/b"}]"#[..], // a bare array (plausible, but not the API)
            br#"{"models":[]}"#,       // missing "data"
            br#"{"data":{"id":"a/b"}}"#, // "data" not an array
            b"",
            b"<html>502 Bad Gateway</html>",
            b"```json\n{\"data\":[]}\n```", // fenced
        ] {
            let err = parse_catalog(bad).expect_err("must be refused").to_string();
            assert!(
                err.contains("OpenRouter model list"),
                "{:?} → {err}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    #[test]
    fn non_latin_names_survive_parsing() {
        let json = r#"{"data":[{"id":"v/ja","name":"日本語モデル 🚀","description":"中文说明"}]}"#;
        let catalog = parse_catalog(json.as_bytes()).unwrap();
        assert_eq!(catalog.models[0].name, "日本語モデル 🚀");
        assert_eq!(catalog.models[0].description, "中文说明");
    }

    #[test]
    fn serialized_model_uses_camelcase_keys() {
        let catalog = parse_catalog(OFFICIAL_SHAPE).unwrap();
        let v = serde_json::to_value(&catalog).unwrap();
        let model = v["models"][0].as_object().unwrap();
        assert!(model.contains_key("outputModalities"));
        assert!(model.contains_key("contextLength"));
        assert!(!model.contains_key("output_modalities"));
        assert!(!model.contains_key("context_length"));
        let pricing = model["pricing"].as_object().unwrap();
        assert!(pricing.contains_key("imageOutput"));
        assert!(!pricing.contains_key("image_output"));
        // Only the documented pricing keys reach the frontend.
        assert!(!pricing.contains_key("webSearch"));
    }

    #[test]
    fn catalog_requires_openrouter_https_and_a_key() {
        let ok = "https://openrouter.ai/api/v1/chat/completions";
        assert!(validate_catalog_request(ok, "sk-or-x").is_ok());
        assert!(validate_catalog_request("https://OpenRouter.AI/api/v1/chat/completions", "k").is_ok());
        for endpoint in [
            "http://openrouter.ai/api/v1/chat/completions",
            "https://openrouter.ai.evil.com/api/v1/chat/completions",
            "https://openrouter.ai@evil.com/api/v1/chat/completions",
            "https://evil.com/?h=openrouter.ai",
            "https://api.openrouter.ai/v1",
            "http://localhost:11434/v1",
            "not a url",
            "",
        ] {
            assert!(validate_catalog_request(endpoint, "k").is_err(), "{endpoint} must be refused");
        }
        // No key → refused (even on an OpenRouter endpoint whose path contains
        // "localhost", which commands::api_key_for would treat as keyless).
        assert!(validate_catalog_request(ok, "").is_err());
        assert!(validate_catalog_request(ok, "   ").is_err());
        assert!(validate_catalog_request("https://openrouter.ai/localhost", "").is_err());
    }

    #[test]
    fn catalog_status_messages_are_specific() {
        let msg = |f: FetchFailure| map_catalog_failure(f).to_string();
        let unauthorized = msg(FetchFailure::Status(401));
        assert!(unauthorized.contains("API key") && unauthorized.contains("401"), "{unauthorized}");
        assert!(msg(FetchFailure::Status(403)).contains("API key"));
        let limited = msg(FetchFailure::Status(429));
        assert!(limited.contains("429") && limited.contains("rate"), "{limited}");
        let down = msg(FetchFailure::Status(503));
        assert!(down.contains("503") && down.contains("unavailable"), "{down}");
        let offline = msg(FetchFailure::Unresolved);
        assert!(offline.contains("offline"), "{offline}");
        let blocked = msg(FetchFailure::Blocked("x".into()));
        assert!(blocked.contains("private"), "{blocked}");
        let other = msg(FetchFailure::Status(418));
        assert!(other.contains("418"), "{other}");
        // Each class reads differently.
        let all = [&unauthorized, &limited, &down, &offline, &blocked, &other];
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    // The attempt goes through net.rs, so it lands in the FETCH counters.
    // Holds the shared counter guard so it cannot race the exact-equality
    // counter tests elsewhere; `>=` is kept as a belt-and-braces tolerance.
    #[test]
    fn catalog_fetch_counts_as_a_fetch() {
        let _g = crate::net::network_counter_test_guard();
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let (before, _) = crate::net::stats();
        let result = rt.block_on(fetch_catalog_from("http://127.0.0.1:9/", "sk-or-test"));
        assert!(result.is_err());
        let (after, _) = crate::net::stats();
        assert!(after >= before + 1, "before={before}, after={after}");
    }

    // Gate order: a non-OpenRouter endpoint is refused before the key is read
    // (no keychain prompt), and a blank key is refused before any fetch.
    #[test]
    fn list_catalog_gates_on_the_endpoint_before_reading_the_key() {
        let _g = crate::net::network_counter_test_guard();
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let or = "https://openrouter.ai/api/v1/chat/completions";
        let res = rt.block_on(list_catalog("http://localhost:11434/v1", or, |_| {
            panic!("the key must not be read for a non-OpenRouter endpoint")
        }));
        assert!(matches!(res, Err(AppError::Config(_))), "got {res:?}");

        let res = rt.block_on(list_catalog(or, or, |_| Ok(String::new())));
        let err = res.expect_err("blank key must be refused").to_string();
        assert!(err.contains("No API key"), "{err}");

        let res = rt.block_on(list_catalog(or, or, |_| Err(AppError::Keyring("locked".into()))));
        assert!(matches!(res, Err(AppError::Keyring(_))), "got {res:?}");
    }

    // security-rust-1: the single keychain slot holds the key of the SAVED
    // endpoint. An OpenRouter endpoint typed into the form (unsaved) while a
    // Groq/other endpoint is saved must not send that other provider's key to
    // openrouter.ai — the keychain is never read.
    #[test]
    fn list_catalog_never_reads_the_key_unless_the_saved_endpoint_is_openrouter() {
        let _g = crate::net::network_counter_test_guard();
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let form = "https://openrouter.ai/api/v1/chat/completions";
        for saved in [
            "https://api.groq.com/openai/v1/chat/completions",
            "http://localhost:11434/v1/chat/completions",
            "https://openrouter.ai.evil.com/api/v1/chat/completions",
            "",
        ] {
            let res = rt.block_on(list_catalog(form, saved, |_| {
                panic!("the key must not be read while the saved endpoint is {saved:?}")
            }));
            let err = res.expect_err(saved);
            assert!(matches!(err, AppError::Config(_)), "{saved}: {err:?}");
            assert_eq!(
                err.to_string(),
                "Configuration error: The OpenRouter model list is available only when the \
                 endpoint is OpenRouter (https://openrouter.ai/…).",
                "{saved}"
            );
        }
        // A first run (no settings file) saves the default endpoint, which is
        // OpenRouter, so it still reaches the key check instead of this gate.
        assert!(is_openrouter_endpoint(crate::settings::DEFAULT_ENDPOINT));
    }

    #[test]
    fn the_catalog_url_is_the_fixed_https_openrouter_constant() {
        let url = reqwest::Url::parse(OPENROUTER_MODELS_URL).unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("openrouter.ai"));
        assert_eq!(url.path(), "/api/v1/models");
        // output_modalities defaults to text server-side; "all" is needed for
        // the image-model list.
        assert!(url.query_pairs().any(|(k, v)| k == "output_modalities" && v == "all"));
        assert_eq!(MAX_CATALOG_BYTES, 8 * 1024 * 1024);
        assert_eq!(CATALOG_TIMEOUT_SECS, 20);
    }

    // ----- TS mirror contract (src/types.ts) + wiring guards -----------------

    /// Field lines of `export interface <name> { ... }` in types.ts, as
    /// (field, type) pairs. Scoped to that one block.
    fn ts_interface_fields(name: &str) -> Vec<(String, String)> {
        let src = include_str!("../../src/types.ts");
        let head = format!("export interface {name} {{");
        let start = src.find(&head).unwrap_or_else(|| panic!("{name} missing from types.ts"));
        let body = &src[start + head.len()..];
        let body = &body[..body.find("\n}").expect("interface end")];
        body.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("//") && !l.starts_with("/*") && !l.starts_with('*'))
            .map(|l| {
                let (k, t) = l.split_once(':').unwrap_or_else(|| panic!("bad field line: {l}"));
                (k.trim().to_string(), t.trim().trim_end_matches(';').trim().to_string())
            })
            .collect()
    }

    /// Every Rust key appears in TS with matching nullability, and vice versa.
    fn assert_mirrors(name: &str, rust: &serde_json::Map<String, serde_json::Value>) {
        let ts = ts_interface_fields(name);
        let mut ts_keys: Vec<&str> = ts.iter().map(|(k, _)| k.as_str()).collect();
        let mut rust_keys: Vec<&str> = rust.keys().map(String::as_str).collect();
        ts_keys.sort_unstable();
        rust_keys.sort_unstable();
        assert_eq!(ts_keys, rust_keys, "{name}: field names differ");
        for (k, t) in &ts {
            assert!(!k.ends_with('?'), "{name}.{k}: Rust always emits the key; use `| null`, not `?`");
            let ts_nullable = t.split('|').any(|p| p.trim() == "null");
            assert_eq!(rust[k].is_null(), ts_nullable, "{name}.{k}: nullability differs ({t})");
        }
    }

    #[test]
    fn ts_types_mirror_the_serialized_catalog_exactly() {
        // All optional fields None, so every nullable key serializes as null.
        let catalog = parse_catalog(br#"{"data":[{"id":"a/b"}]}"#).unwrap();
        let v = serde_json::to_value(&catalog).unwrap();
        assert_mirrors("OpenRouterCatalog", v.as_object().unwrap());
        assert_mirrors("OpenRouterModel", v["models"][0].as_object().unwrap());
        assert_mirrors("OpenRouterPricing", v["models"][0]["pricing"].as_object().unwrap());
    }

    #[test]
    fn command_is_registered_and_wrapped_with_only_the_endpoint() {
        let lib = include_str!("lib.rs");
        let handlers = &lib[lib.find("generate_handler![").expect("handler list")..];
        let handlers = &handlers[..handlers.find("])").expect("handler list end")];
        assert!(handlers.contains("commands::list_openrouter_models,"));

        let api = include_str!("../../src/api.ts");
        let start = api.find("listOpenRouterModels:").expect("api.ts wrapper");
        let wrapper = &api[start..start + api[start..].find("),").expect("wrapper end")];
        assert!(
            wrapper.contains(r#"invoke<OpenRouterCatalog>("list_openrouter_models", { endpoint }"#),
            "{wrapper}"
        );

        // The command gates on the PERSISTED endpoint (loaded from settings),
        // not on the form value twice (security-rust-1).
        let commands = include_str!("commands.rs");
        let start = commands.find("pub async fn list_openrouter_models(").expect("command");
        let body = &commands[start..start + commands[start..].find("\n}").expect("command end")];
        assert!(
            body.contains("let saved = load_settings_in(&config_dir(&app)?).endpoint;"),
            "{body}"
        );
        assert!(body.contains("list_catalog(&endpoint, &saved, api_key_for)"), "{body}");
    }
}
