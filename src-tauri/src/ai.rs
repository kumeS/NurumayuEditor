//! AI integration.
//!
//! Per requirement §4.3 the network/LLM layer is expressed as a trait
//! (`LlmProvider`) so that other providers (a local Ollama endpoint, a different
//! REST API, ...) can be slotted in without touching the command layer. The
//! current concrete implementation talks to an OpenAI-compatible chat-completions
//! endpoint (OpenRouter by default).
//!
//! Requests carry the surrounding paragraph chunks as context (requirement
//! §3.1, "context-aware editing") so the model produces logically coherent text.

use crate::error::{AppError, AppResult};
use crate::models::{AnalysisResult, Document, CHUNK_TYPE_HEADING, CHUNK_TYPE_TEXT};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

// ----- "zero external transmission" visibility (開発.txt Stage 2, item 2-2) --
//
// Process-wide counters for actual LLM API traffic. NOTE for future readers:
// unlike reference/image fetches (guarded through `net::safe_fetch`), the LLM
// calls below do NOT go through that chokepoint at all — `complete()`,
// `complete_stream()`, and `generate_image()` each build their own
// `reqwest::Client` and funnel the real request through `send_with_retry`
// here. That is deliberately the single instrumentation point (one counter
// bump covers all three call sites) rather than three separate ones. Kept as
// a SEPARATE pair of counters from `net::stats()` — LLM calls and
// reference/image fetches are conceptually different traffic, and a user
// should be able to tell them apart in the health bar.
static AI_CALLS: AtomicU64 = AtomicU64::new(0);
static AI_BYTES: AtomicU64 = AtomicU64::new(0);

/// Current LLM-call traffic: `(calls, bytes)`. A "call" is every attempt that
/// reaches `send_with_retry` (i.e. actually sent, or tried to send, a request
/// to the configured endpoint — retries of the SAME logical call are not
/// double-counted); "bytes" counts the response body bytes of the final
/// (non-retried) response actually returned to the caller.
pub fn ai_call_stats() -> (u64, u64) {
    (AI_CALLS.load(Ordering::Relaxed), AI_BYTES.load(Ordering::Relaxed))
}

/// Configuration needed to reach a provider for a single request.
#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub endpoint: String,
    pub model: String,
    pub api_key: String,
    pub temperature: f32,
}

/// The extensibility seam: any chat-style LLM backend implements this.
#[allow(async_fn_in_trait)]
pub trait LlmProvider: Send + Sync {
    async fn complete(&self, system: &str, user: &str) -> AppResult<String>;
}

/// OpenAI-compatible chat completions provider (OpenRouter by default).
pub struct OpenRouterProvider {
    pub config: LlmConfig,
}

impl OpenRouterProvider {
    pub fn new(config: LlmConfig) -> Self {
        Self { config }
    }
}

/// POST `payload` to `endpoint` with the standard OpenRouter headers, retrying
/// transient failures. Free OpenRouter models share tight rate limits and
/// frequently return 429 (or transient 5xx) under load, and a laptop's network
/// can blip mid-request — so retry a few times with backoff, honouring
/// Retry-After, before handing the final response (or error) back to the
/// caller for its own status/error mapping.
async fn send_with_retry(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    payload: &serde_json::Value,
) -> AppResult<reqwest::Response> {
    // One logical LLM call, however many retries it takes underneath — counted
    // once, up front, since this is the single funnel point all three call
    // sites (complete/complete_stream/generate_image) go through.
    AI_CALLS.fetch_add(1, Ordering::Relaxed);

    const MAX_ATTEMPTS: u32 = 3;
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let sent = client
            .post(endpoint)
            .header("Authorization", format!("Bearer {api_key}"))
            // OpenRouter attribution headers (optional but recommended).
            .header("HTTP-Referer", "https://github.com/kumeS/NurumayuFacet")
            .header("X-Title", "NurumayuFacet")
            .json(payload)
            .send()
            .await;

        let res = match sent {
            Ok(res) => res,
            // Network-level failures (DNS, connect, timeout) are transient too.
            Err(_) if attempt < MAX_ATTEMPTS => {
                let wait = (1u64 << (attempt - 1)).min(5);
                tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                continue;
            }
            Err(e) => return Err(AppError::from(e)),
        };

        let status = res.status();

        // 429 (rate limit) and 5xx are transient — retry with backoff.
        if (status.as_u16() == 429 || status.is_server_error()) && attempt < MAX_ATTEMPTS {
            let retry_after = res
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok());
            // Honour Retry-After, else exponential backoff; cap so the UI
            // never hangs for long.
            let wait = retry_after.unwrap_or(1u64 << (attempt - 1)).min(5);
            tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
            continue;
        }

        return Ok(res);
    }
}

impl LlmProvider for OpenRouterProvider {
    async fn complete(&self, system: &str, user: &str) -> AppResult<String> {
        let client = reqwest::Client::new();
        let payload = json!({
            "model": self.config.model,
            "temperature": self.config.temperature,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ]
        });

        let res = send_with_retry(&client, &self.config.endpoint, &self.config.api_key, &payload)
            .await?;
        let status = res.status();
        let raw = res.bytes().await?;
        AI_BYTES.fetch_add(raw.len() as u64, Ordering::Relaxed);
        let body: serde_json::Value = serde_json::from_slice(&raw)?;

        if !status.is_success() {
            let provider_msg = body["error"]["message"]
                .as_str()
                .or_else(|| body["error"].as_str())
                .unwrap_or("unknown error");
            let msg = match status.as_u16() {
                429 => format!(
                    "Rate limited (429). Free OpenRouter models share tight limits — wait a minute and \
                     retry, switch to another model in Settings, or add credit at openrouter.ai. \
                     (provider: {provider_msg})"
                ),
                401 | 403 => format!(
                    "Authorization failed ({}). Check your OpenRouter API key in Settings. \
                     (provider: {provider_msg})",
                    status.as_u16()
                ),
                404 => format!(
                    "Model not found (404). Verify the model id in Settings — it may be unavailable or \
                     have changed. (provider: {provider_msg})"
                ),
                code => format!("API {code}: {provider_msg}"),
            };
            return Err(AppError::Network(msg));
        }

        let out = body["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string();

        if out.is_empty() {
            return Err(AppError::Network(
                "The model returned an empty response.".to_string(),
            ));
        }
        Ok(out)
    }
}

/// Per-call overrides for the chat-completions request payload. Strictly
/// additive/optional: every existing call site keeps building its payload
/// from `config.temperature` and no max-token cap (`None`/default) unless it
/// explicitly opts in, so this cannot change behaviour for any existing
/// action. Ghost-text (開発.txt Stage 2, item 2-4) is the first caller that
/// sets both fields, to keep its completion short, fast and cheap.
#[derive(Debug, Clone, Copy, Default)]
pub struct CompletionOverrides {
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

/// Build the JSON payload for a streaming chat-completions request. Pure (no
/// I/O) so the override plumbing is unit-testable without a network call.
/// `overrides.temperature` replaces `config.temperature`; `overrides.max_tokens`
/// is added only when present — omitting it entirely reproduces exactly what
/// `complete_stream` always sent, before this function existed.
fn build_stream_payload(
    config: &LlmConfig,
    system: &str,
    user: &str,
    overrides: Option<CompletionOverrides>,
) -> serde_json::Value {
    let temperature = overrides.and_then(|o| o.temperature).unwrap_or(config.temperature);
    let mut payload = json!({
        "model": config.model,
        "temperature": temperature,
        "stream": true,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });
    if let Some(max_tokens) = overrides.and_then(|o| o.max_tokens) {
        payload["max_tokens"] = json!(max_tokens);
    }
    payload
}

impl OpenRouterProvider {
    /// Stream a completion token-by-token. `on_delta` is called with the FULL
    /// accumulated text each time new content arrives; the final text is returned.
    pub async fn complete_stream<F: FnMut(&str)>(
        &self,
        system: &str,
        user: &str,
        on_delta: F,
    ) -> AppResult<String> {
        self.complete_stream_with(system, user, None, on_delta).await
    }

    /// Same as `complete_stream`, with optional per-call `overrides` (temperature /
    /// max_tokens). `None` reproduces the exact payload `complete_stream` always
    /// sent, so this is a backward-compatible superset, not a behaviour change.
    pub async fn complete_stream_with<F: FnMut(&str)>(
        &self,
        system: &str,
        user: &str,
        overrides: Option<CompletionOverrides>,
        mut on_delta: F,
    ) -> AppResult<String> {
        let client = reqwest::Client::new();
        let payload = build_stream_payload(&self.config, system, user, overrides);

        // Retries (429/5xx/network) happen inside `send_with_retry`, i.e. only
        // BEFORE the first delta has been forwarded to the caller. Once the
        // stream is being consumed, a failure is returned as-is — replaying a
        // partially-delivered stream would show the user duplicated text.
        let res = send_with_retry(&client, &self.config.endpoint, &self.config.api_key, &payload)
            .await?;

        let status = res.status();
        if !status.is_success() {
            let body: serde_json::Value = res.json().await.unwrap_or_else(|_| json!({}));
            let provider_msg = body["error"]["message"]
                .as_str()
                .or_else(|| body["error"].as_str())
                .unwrap_or("unknown error");
            return Err(AppError::Network(match status.as_u16() {
                429 => format!(
                    "Rate limited (429). Free OpenRouter models share tight limits — wait a minute and \
                     retry, switch to another model in Settings, or add credit at openrouter.ai. \
                     (provider: {provider_msg})"
                ),
                401 | 403 => format!(
                    "Authorization failed ({}). Check your OpenRouter API key in Settings. \
                     (provider: {provider_msg})",
                    status.as_u16()
                ),
                code => format!("API {code}: {provider_msg}"),
            }));
        }

        // Server-Sent Events: bytes arrive on arbitrary boundaries, so buffer
        // raw bytes and only parse COMPLETE lines (split on '\n'). A multibyte
        // UTF-8 char never contains 0x0A, so splitting on the newline byte is safe.
        let mut stream = res.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut full = String::new();

        while let Some(item) = stream.next().await {
            let bytes = item.map_err(AppError::from)?;
            AI_BYTES.fetch_add(bytes.len() as u64, Ordering::Relaxed);
            buf.extend_from_slice(&bytes);

            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
                let line = line.trim_end_matches('\r').trim();

                if line.is_empty() || line.starts_with(':') {
                    continue; // blank line or SSE comment / keep-alive
                }
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    return finalize_stream(full);
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                        if !delta.is_empty() {
                            full.push_str(delta);
                            on_delta(&full);
                        }
                    }
                }
            }
        }
        finalize_stream(full)
    }
}

/// Guard the streaming path against an empty result (content-filtered response,
/// early close before any delta, or only role/usage chunks) — mirroring the
/// non-streaming `complete()` so an empty stream never silently clobbers the
/// user's paragraph with "".
fn finalize_stream(full: String) -> AppResult<String> {
    if full.trim().is_empty() {
        return Err(AppError::Network(
            "The model returned an empty response. Try again, or switch models in Settings.".into(),
        ));
    }
    Ok(full)
}

// ----- request / result types --------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    /// "translate" | "proofread" | "summarize" | "custom"
    pub action: String,
    pub text: String,
    #[serde(default)]
    pub context_before: Option<String>,
    #[serde(default)]
    pub context_after: Option<String>,
    #[serde(default)]
    pub target_language: Option<String>,
    /// Target writing style for the "proofread" action (e.g. "concise and
    /// formal"). When empty, proofreading defaults to the global writing tone,
    /// then to a scholarly tone.
    #[serde(default)]
    pub style: Option<String>,
    /// Free-form instruction for the "custom" action.
    #[serde(default)]
    pub instruction: Option<String>,
    /// The configured default language. Every non-translate action is pinned to
    /// write its output in this language so results never silently drift away
    /// from what the user set in Settings.
    #[serde(default)]
    pub output_language: Option<String>,
    /// The global writing tone (blog / memo / report / scientific / academic).
    /// Applied to the open-ended writing actions for a consistent voice.
    #[serde(default)]
    pub tone: Option<String>,
    /// The nearest preceding heading — the SECTION the target paragraph lives
    /// under. Lets the model edit with awareness of where it is in the document
    /// (T1: whole-document context assembly).
    #[serde(default)]
    pub section_heading: Option<String>,
    /// A compact document outline: one line per other chunk (its summary, or a
    /// trimmed snippet). Gives the model document-wide awareness without sending
    /// the full text. Assembled on the frontend from metadata.summary.
    #[serde(default)]
    pub document_map: Option<String>,
    /// Full content of the chunks this paragraph is graph-linked to
    /// (metadata.linkedChunks) — the supporting/related material.
    #[serde(default)]
    pub linked_content: Option<String>,
}

/// Trailing constraints appended to a writing action's system prompt: pin the
/// OUTPUT LANGUAGE (so a result never drifts away from the user's configured
/// default language — e.g. Japanese text staying Japanese after proofreading)
/// and, optionally, the global writing tone.
fn output_constraints(language: Option<&str>, tone: Option<&str>) -> String {
    let mut s = String::new();
    if let Some(lang) = language.map(str::trim).filter(|l| !l.is_empty()) {
        s.push_str(&format!(
            " IMPORTANT: write your ENTIRE output in {lang}, regardless of the input language — \
             do not switch to any other language."
        ));
    }
    if let Some(t) = tone.map(str::trim).filter(|t| !t.is_empty()) {
        s.push_str(&format!(" Adopt a {t} writing tone."));
    }
    s
}

// Analysis graph types (AnalysisNode/Edge/Result) live in `models.rs` so they
// can be persisted on `Document`.

// ----- high-level operations ----------------------------------------------

fn context_block(req: &AiRequest) -> String {
    let mut ctx = String::new();
    let push = |ctx: &mut String, label: &str, body: &Option<String>| {
        if let Some(v) = body.as_ref().filter(|s| !s.trim().is_empty()) {
            ctx.push_str(label);
            ctx.push('\n');
            ctx.push_str(v.trim());
            ctx.push_str("\n\n");
        }
    };
    // T1: document-wide awareness — which section, the whole-doc outline, and the
    // graph-linked material — in addition to the immediate prose neighbours.
    push(&mut ctx, "[Section this paragraph belongs to]", &req.section_heading);
    push(&mut ctx, "[Document outline (other paragraphs, for orientation only)]", &req.document_map);
    push(&mut ctx, "[Preceding paragraph]", &req.context_before);
    push(&mut ctx, "[Following paragraph]", &req.context_after);
    push(&mut ctx, "[Related/linked material]", &req.linked_content);
    ctx
}

/// Build the system prompt for a one-click action.
fn action_system(req: &AiRequest) -> AppResult<String> {
    let lang = req.output_language.as_deref();
    let tone = req.tone.as_deref();

    let system = match req.action.as_str() {
        "translate" => {
            let target = req
                .target_language
                .clone()
                .unwrap_or_else(|| "English".to_string());
            format!(
                "You are an expert academic translator. Translate the user's target paragraph into {target}, \
                 preserving meaning, terminology and an academic tone. Use the surrounding context only to \
                 disambiguate; do not translate or repeat the context. Output ONLY the translated paragraph, \
                 with no preamble, notes, or quotation marks.{}",
                // Translate already names its target language; only the tone is
                // an extra constraint here.
                output_constraints(None, tone)
            )
        }
        "proofread" => {
            // Explicit per-action style wins; otherwise fall back to the global
            // writing tone, then to a scholarly default.
            let style = req
                .style
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or_else(|| tone.map(str::trim).filter(|t| !t.is_empty()))
                .unwrap_or("scholarly and academic");
            format!(
                "You are a meticulous copy-editor. Correct spelling, grammar and punctuation, improve \
                 clarity and concision, and adjust the writing toward a {style} style, while preserving \
                 the author's meaning. Use the surrounding context only for consistency. \
                 Output ONLY the revised paragraph, with no preamble, explanations, or quotation marks.{}",
                output_constraints(lang, None)
            )
        }
        "summarize" => format!(
            "You are an expert academic editor. Write a single concise sentence summarizing the \
             target paragraph, suitable as metadata. Output ONLY that sentence.{}",
            output_constraints(lang, None)
        ),
        "expand" => format!(
            "You are an academic writing assistant. Expand and develop the target paragraph: add \
             supporting sentences, elaboration, and smooth transitions so it reads more thoroughly, while \
             preserving the original meaning and tone. Do not introduce unrelated claims or \
             fabricated facts. Use the surrounding context only for coherence; do not repeat it. Output \
             ONLY the expanded paragraph, with no preamble, explanation, or quotation marks.{}",
            output_constraints(lang, tone)
        ),
        "detailed" => format!(
            "You are an academic writing assistant. Rewrite the target paragraph in greater \
             detail: turn general statements into specific, concrete ones and add clarifying explanation, \
             while preserving the original meaning and tone. Do not invent false facts, data, \
             or citations. Use the surrounding context only for coherence; do not repeat it. Output ONLY \
             the revised paragraph, with no preamble, explanation, or quotation marks.{}",
            output_constraints(lang, tone)
        ),
        "concentrate" => format!(
            "You are an academic writing assistant. Condense the target paragraph: remove \
             redundancy and wordiness and tighten the phrasing so it is more concise, while keeping all \
             key information and preserving the original meaning and tone. Use the surrounding \
             context only for coherence; do not repeat it. Output ONLY the condensed paragraph, with no \
             preamble, explanation, or quotation marks.{}",
            output_constraints(lang, tone)
        ),
        "focus" => format!(
            "You are an academic writing assistant. Sharpen the target paragraph so it centers \
             clearly on its main point: cut tangential or digressive material and keep the core argument, \
             while preserving the original meaning and tone. Use the surrounding context only \
             for coherence; do not repeat it. Output ONLY the focused paragraph, with no preamble, \
             explanation, or quotation marks.{}",
            output_constraints(lang, tone)
        ),
        "harmonize" => format!(
            "You are an academic writing assistant. Revise the target paragraph so it connects smoothly \
             and logically with the preceding and following paragraphs: smooth abrupt transitions, align \
             terminology, tense and voice with the neighbours, and remove repetition of what they already \
             say — while preserving the paragraph's own meaning. Use the surrounding context as the \
             reference for coherence; do NOT merge it in or repeat it. Output ONLY the revised paragraph, \
             with no preamble, explanation, or quotation marks.{}",
            output_constraints(lang, tone)
        ),
        "custom" => {
            let base = req
                .instruction
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    "You are a helpful academic writing assistant. Improve the target paragraph.".to_string()
                });
            format!("{base}{}", output_constraints(lang, tone))
        }
        other => return Err(AppError::Other(format!("Unknown AI action: '{other}'"))),
    };
    Ok(system)
}

/// Assemble the user message (surrounding context + the target paragraph).
fn action_user(req: &AiRequest) -> String {
    format!("{}[Target paragraph]\n{}", context_block(req), req.text.trim())
}

/// Run a one-click text action (translate / proofread / summarize / custom).
pub async fn run_action(config: &LlmConfig, req: &AiRequest) -> AppResult<String> {
    let provider = OpenRouterProvider::new(config.clone());
    let system = action_system(req)?;
    let user = action_user(req);
    provider.complete(&system, &user).await
}

/// Streaming variant of `run_action`: `on_delta` receives the FULL accumulated
/// text each time new content arrives; the final text is returned.
pub async fn run_action_stream<F: FnMut(&str)>(
    config: &LlmConfig,
    req: &AiRequest,
    on_delta: F,
) -> AppResult<String> {
    let provider = OpenRouterProvider::new(config.clone());
    let system = action_system(req)?;
    let user = action_user(req);
    provider.complete_stream(&system, &user, on_delta).await
}

// ----- ghost-text inline completion (開発.txt Stage 2, item 2-4) -----------
//
// Deliberately NOT routed through `AiRequest`/`action_system`/`action_user`:
// those assemble a whole-document-aware context (section heading, document
// map, linked chunks) sized for one-click actions the user explicitly
// triggered, which is both slower and unnecessary for a completion that must
// feel instant while the user is still typing. This is a narrow, separate
// request shape by design — see `commands::ai_ghost_complete_stream`.

/// Max tokens requested for a ghost-text continuation — short by design (a
/// phrase to a sentence, not a paragraph), which keeps latency and cost low.
const GHOST_TEXT_MAX_TOKENS: u32 = 40;
/// Low, near-deterministic temperature: a ghost suggestion that changes
/// wildly between keystrokes is more distracting than no suggestion at all.
const GHOST_TEXT_TEMPERATURE: f32 = 0.2;

/// Stream a short inline continuation of `prefix` (the text immediately
/// before the cursor). `context_hint` is optional, cheap orientation (e.g. the
/// section heading) — never a full document map, so this stays fast.
/// `on_delta` receives the FULL accumulated text each time new content
/// arrives; the final text is returned.
pub async fn complete_ghost_text_stream<F: FnMut(&str)>(
    config: &LlmConfig,
    prefix: &str,
    context_hint: &str,
    on_delta: F,
) -> AppResult<String> {
    let provider = OpenRouterProvider::new(config.clone());
    let system = "You are an inline autocomplete engine for a prose writing tool. Continue the \
        user's sentence/paragraph naturally from exactly where it stops. Output ONLY the \
        continuation text — no repetition of what was already written, no preamble, no \
        quotation marks, no markdown. Keep it brief: a few words to at most one short sentence. \
        Stop at a natural point (end of clause or sentence) rather than trailing off mid-word.";
    let user = if context_hint.trim().is_empty() {
        format!("[Text so far]\n{}", prefix)
    } else {
        format!("[Section]\n{}\n\n[Text so far]\n{}", context_hint.trim(), prefix)
    };
    let overrides = CompletionOverrides {
        max_tokens: Some(GHOST_TEXT_MAX_TOKENS),
        temperature: Some(GHOST_TEXT_TEMPERATURE),
    };
    provider
        .complete_stream_with(system, &user, Some(overrides), on_delta)
        .await
}

fn strip_code_fences(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        // Drop the optional language tag on the first line and the trailing fence.
        let after_lang = rest.splitn(2, '\n').nth(1).unwrap_or("");
        let body = after_lang
            .trim_end()
            .strip_suffix("```")
            .unwrap_or(after_lang);
        return body.trim().to_string();
    }
    t.to_string()
}

/// Generate Mermaid diagram code from a description / paragraph.
pub async fn generate_diagram(
    config: &LlmConfig,
    text: &str,
    instruction: Option<&str>,
) -> AppResult<String> {
    let provider = OpenRouterProvider::new(config.clone());
    let extra = instruction
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!(" Additional instruction: {s}."))
        .unwrap_or_default();
    // The hard constraints below exist to reduce Mermaid PARSE failures — the
    // most common breakages are unquoted labels with punctuation and
    // parentheses/brackets inside flowchart node text.
    let system = format!(
        "You are a diagramming assistant. Convert the user's text into a single valid Mermaid.js diagram. \
         Prefer 'flowchart TD' unless another diagram type (sequence, class, or mind map) clearly fits \
         the content better. To keep the code parseable by Mermaid: wrap every node label that contains \
         spaces or punctuation in double quotes (e.g. A[\"label text\"]), never put parentheses or \
         brackets inside flowchart node text, and keep the diagram under about 40 nodes. Output ONLY raw \
         Mermaid code. Do NOT wrap it in Markdown code fences and do NOT add any explanation.{extra}"
    );
    let raw = provider.complete(&system, text.trim()).await?;
    Ok(strip_code_fences(&raw))
}

/// Generate an image from a text prompt using the configured image model.
/// Returns a data URL (or remote URL). Fails loud (with a response hint) if no
/// image is found, rather than silently producing a blank image.
pub async fn generate_image(config: &LlmConfig, prompt: &str) -> AppResult<String> {
    let client = reqwest::Client::new();
    let payload = json!({
        "model": config.model,
        "messages": [{ "role": "user", "content": prompt }],
        // Ask image-capable models (e.g. Gemini "Nano Banana") for image output.
        "modalities": ["image", "text"]
    });
    let res = send_with_retry(&client, &config.endpoint, &config.api_key, &payload).await?;

    let status = res.status();
    let raw = res.bytes().await?;
    AI_BYTES.fetch_add(raw.len() as u64, Ordering::Relaxed);
    let body: serde_json::Value = serde_json::from_slice(&raw)?;
    if !status.is_success() {
        let provider_msg = body["error"]["message"]
            .as_str()
            .or_else(|| body["error"].as_str())
            .unwrap_or("unknown error");
        return Err(AppError::Network(format!(
            "Image API {}: {provider_msg}",
            status.as_u16()
        )));
    }

    if let Some(url) = extract_image_url(&body) {
        return Ok(url);
    }
    // Fail loud with a short hint of the response shape (base64 can be huge).
    let hint: String = body.to_string().chars().take(300).collect();
    Err(AppError::Network(format!(
        "The image model returned no image. Verify '{}' is an image-generation model \
         on openrouter.ai/models. Response (truncated): {hint}",
        config.model
    )))
}

/// Best-effort extraction of a generated image URL from various response shapes.
fn extract_image_url(body: &serde_json::Value) -> Option<String> {
    let msg = &body["choices"][0]["message"];

    // 1) OpenRouter image-capable chat: message.images[].image_url.url
    if let Some(images) = msg["images"].as_array() {
        for img in images {
            for path in [&img["image_url"]["url"], &img["url"]] {
                if let Some(u) = path.as_str() {
                    if !u.is_empty() {
                        return Some(u.to_string());
                    }
                }
            }
        }
    }
    // 2) message.content is a string containing a data: URL
    if let Some(content) = msg["content"].as_str() {
        if let Some(u) = find_data_url(content) {
            return Some(u);
        }
    }
    // 3) message.content is an array of parts ({type:"image_url", image_url:{url}})
    if let Some(parts) = msg["content"].as_array() {
        for p in parts {
            if let Some(u) = p["image_url"]["url"].as_str() {
                if !u.is_empty() {
                    return Some(u.to_string());
                }
            }
        }
    }
    // 4) OpenAI images-API style: data[0].url / data[0].b64_json
    if let Some(first) = body["data"].as_array().and_then(|a| a.first()) {
        if let Some(u) = first["url"].as_str() {
            if !u.is_empty() {
                return Some(u.to_string());
            }
        }
        if let Some(b64) = first["b64_json"].as_str() {
            if !b64.is_empty() {
                return Some(format!("data:image/png;base64,{b64}"));
            }
        }
    }
    None
}

fn find_data_url(s: &str) -> Option<String> {
    let idx = s.find("data:image/")?;
    let rest = &s[idx..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == ')' || c == '"' || c == '\'')
        .unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

const DRAFT_SYSTEM_PROMPT: &str =
    "You are an academic writing assistant. Write a coherent, well-structured first draft on the user's \
     theme. Organise it with Markdown ATX headings to show the document structure — '#' for chapter-level \
     headings, '##' for sections, '###' for subsections — and write the body as clear prose paragraphs \
     separated by blank lines. Order the material logically (e.g. introduction, development, conclusion). \
     Do NOT restate the theme verbatim as the very first line, and do NOT use bullet lists, tables, code \
     fences, or any commentary — output ONLY the draft itself (headings and paragraphs).";

/// Stream a draft, invoking `on_delta` with the full accumulated text as it grows.
/// `target_words` sets an approximate length; `output_language`/`tone` pin the
/// language and voice; `reference` is optional supporting material (pasted text,
/// fetched URL/PDF text) the draft should draw on.
pub async fn generate_draft_stream<F: FnMut(&str)>(
    config: &LlmConfig,
    theme: &str,
    target_words: Option<u32>,
    output_language: Option<&str>,
    tone: Option<&str>,
    reference: Option<&str>,
    on_delta: F,
) -> AppResult<String> {
    let provider = OpenRouterProvider::new(config.clone());

    let mut system = DRAFT_SYSTEM_PROMPT.to_string();
    if let Some(w) = target_words.filter(|w| *w > 0) {
        system.push_str(&format!(
            " Aim for approximately {w} words in total (within about ±20%); pace the \
             structure and depth to hit that length."
        ));
    }
    system.push_str(&output_constraints(output_language, tone));

    let user = match reference.map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => {
            // Cap the reference so an over-long paste/PDF can't blow the context.
            let snippet: String = r.chars().take(12_000).collect();
            format!(
                "Theme: {}\n\n[Reference material to draw on — ground the draft in this; do not copy it verbatim]\n{}",
                theme.trim(),
                snippet
            )
        }
        None => theme.trim().to_string(),
    };

    provider.complete_stream(&system, &user, on_delta).await
}

/// Slice out the FIRST balanced top-level JSON object in `s`, skipping over
/// braces that live inside string literals (and escaped quotes within them) —
/// a naive first-`{`/last-`}` scan breaks as soon as the model appends prose
/// containing a `}` after the JSON. Returns `None` when no balanced object
/// exists. Scanning bytes is safe: `{`/`}`/`"`/`\` never occur inside a
/// multibyte UTF-8 sequence, so every match is a char boundary.
fn find_balanced_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (i, &b) in s.as_bytes().iter().enumerate().skip(start) {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Pull the JSON object out of a model response that may wrap it in code
/// fences, a bare "json" language tag, or surrounding prose. Falls back to the
/// fence-stripped input when no balanced object is found, so the serde error
/// downstream still shows what the model actually said.
fn extract_json(s: &str) -> String {
    let stripped = strip_code_fences(s);
    // Some models emit the language tag without a fence ("json\n{...}").
    let body = stripped
        .trim_start()
        .strip_prefix("json")
        .map(str::trim_start)
        .unwrap_or(&stripped);
    match find_balanced_object(body) {
        Some(obj) => obj.to_string(),
        None => stripped,
    }
}

/// Build the paragraph listing fed to the analyzer: one entry per text chunk
/// and per heading chunk (annotated with its level so the model can tell
/// section titles apart from prose); diagrams and images carry no
/// paragraph-level relations and are excluded, as are whitespace-only chunks.
fn analysis_listing(doc: &Document) -> String {
    let mut listing = String::new();
    for chunk in doc.chunks.iter() {
        let is_heading = chunk.metadata.chunk_type == CHUNK_TYPE_HEADING;
        if chunk.metadata.chunk_type != CHUNK_TYPE_TEXT && !is_heading {
            continue;
        }
        let snippet: String = chunk.content.chars().take(800).collect();
        if snippet.trim().is_empty() {
            continue;
        }
        if is_heading {
            let level = chunk.metadata.level.unwrap_or(1);
            listing.push_str(&format!(
                "- id: {} (heading level {level})\n  text: {}\n",
                chunk.id,
                snippet.replace('\n', " ")
            ));
        } else {
            listing.push_str(&format!("- id: {}\n  text: {}\n", chunk.id, snippet.replace('\n', " ")));
        }
    }
    listing
}

/// Analyze the whole document and extract a relationship graph between chunks.
pub async fn analyze_document(config: &LlmConfig, doc: &Document) -> AppResult<AnalysisResult> {
    let provider = OpenRouterProvider::new(config.clone());

    let listing = analysis_listing(doc);
    if listing.trim().is_empty() {
        return Ok(AnalysisResult { nodes: vec![], edges: vec![], analyzed_at: None });
    }

    let system = "You are a discourse-analysis engine for academic writing. Given a list of paragraphs \
         (each with an id; entries marked \"(heading level n)\" are section titles), build a relationship \
         network at TWO levels.\n\
         1) PARAGRAPH nodes: one per provided paragraph. Set kind=\"paragraph\", id = the paragraph id, \
         label = a 3-6 word topic, summary = one sentence. Heading entries are section titles: still emit \
         them as kind=\"paragraph\" nodes carrying the heading text, and connect each section heading to \
         the paragraphs it governs (relation \"elaboration\", or a more specific type where one clearly \
         fits).\n\
         2) SENTENCE nodes: split each paragraph into its sentences and create one node per sentence. Set \
         kind=\"sentence\", parent = the owning paragraph id, id = \"<paragraphId>#s<n>\" (n starts at 1 per \
         paragraph), label = a 3-6 word gist, summary = the sentence text.\n\
         Then add EDGES describing the logical relationship between nodes — between paragraphs, between \
         sentences, and across levels where relevant. Each edge MUST set \"relation\" to EXACTLY one of: \
         cause, effect, evidence, claim, elaboration, contrast, condition, example, definition, sequence.\n\
         Respond with STRICT JSON only, no markdown, of the exact shape: \
         {\"nodes\":[{\"id\":\"...\",\"kind\":\"paragraph|sentence\",\"parent\":\"<paragraph id or omit>\",\
         \"label\":\"...\",\"summary\":\"...\"}],\
         \"edges\":[{\"source\":\"<id>\",\"target\":\"<id>\",\"relation\":\"<type>\"}]}. \
         Use ONLY the provided paragraph ids (and the \"<paragraphId>#s<n>\" form for sentences). Keep \
         labels short.";

    let user = format!("Paragraphs:\n{listing}");
    let raw = provider.complete(system, &user).await?;
    let json_str = extract_json(&raw);
    let mut result: AnalysisResult = match serde_json::from_str(&json_str) {
        Ok(r) => r,
        Err(first_err) => {
            // One strict-JSON retry: models occasionally wrap the JSON in prose
            // or emit trailing commentary. Feed the parse error back so the
            // model can correct the exact problem; a second failure surfaces
            // the usual error.
            let strict_system = format!(
                "{system}\n\nYour previous response could not be parsed as JSON ({first_err}). \
                 Respond with STRICT JSON only — no prose, no markdown."
            );
            let raw = provider.complete(&strict_system, &user).await?;
            let json_str = extract_json(&raw);
            serde_json::from_str(&json_str).map_err(|e| {
                AppError::Other(format!("Could not parse analysis JSON from model: {e}"))
            })?
        }
    };

    normalize_analysis(&mut result);
    Ok(result)
}

/// Post-parse fixes for a freshly-parsed analysis: default any node the model
/// left without a kind to "paragraph", normalize edge relations toward the
/// canonical closed set ("Cause " → "cause"; unknown values are left as-is —
/// the renderer falls back to grey for them), and drop edges whose endpoints
/// aren't real nodes (keeps the graph consistent).
fn normalize_analysis(result: &mut AnalysisResult) {
    for n in result.nodes.iter_mut() {
        if n.kind.trim().is_empty() {
            n.kind = "paragraph".to_string();
        }
    }
    for e in result.edges.iter_mut() {
        e.relation = e.relation.trim().to_lowercase();
    }
    // Shared dangling-edge rule (item 52) — the same helper the load-boundary
    // repair (Document::normalize step 5) uses, so the two sites can't drift.
    result.drop_dangling_edges();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AnalysisEdge, AnalysisNode, Chunk, Document, CHUNK_TYPE_IMAGE};

    fn test_config() -> LlmConfig {
        LlmConfig {
            endpoint: "http://example.invalid/".to_string(),
            model: "test/model".to_string(),
            api_key: "test-key".to_string(),
            temperature: 0.3,
        }
    }

    /// f32 -> JSON goes through f64, so e.g. 0.3f32 prints as
    /// 0.30000001192092896 — compare via the f32 round-trip instead of a raw
    /// JSON `Value` equality, which is what these tests actually care about.
    fn temperature_of(payload: &serde_json::Value) -> f32 {
        payload["temperature"].as_f64().expect("temperature is a number") as f32
    }

    #[test]
    fn build_stream_payload_without_overrides_matches_prior_shape() {
        // No overrides: reproduces exactly what `complete_stream` always sent —
        // config.temperature, no max_tokens key at all.
        let payload = build_stream_payload(&test_config(), "sys", "usr", None);
        assert_eq!(temperature_of(&payload), 0.3);
        assert!(
            payload.get("max_tokens").is_none(),
            "max_tokens must be absent when no override is given: {payload}"
        );
        assert_eq!(payload["model"], json!("test/model"));
        assert_eq!(payload["messages"][0]["content"], json!("sys"));
        assert_eq!(payload["messages"][1]["content"], json!("usr"));
    }

    #[test]
    fn build_stream_payload_overrides_reach_the_payload() {
        // Ghost-text's low-temperature / short-max-tokens request actually lands
        // in the built JSON, without touching the default config.temperature.
        let overrides = CompletionOverrides { max_tokens: Some(40), temperature: Some(0.2) };
        let payload = build_stream_payload(&test_config(), "sys", "usr", Some(overrides));
        assert_eq!(temperature_of(&payload), 0.2);
        assert_eq!(payload["max_tokens"], json!(40));
    }

    #[test]
    fn build_stream_payload_partial_override_only_sets_given_field() {
        // Overriding only max_tokens must NOT also change the temperature away
        // from config.temperature — the two fields are independent.
        let overrides = CompletionOverrides { max_tokens: Some(10), temperature: None };
        let payload = build_stream_payload(&test_config(), "sys", "usr", Some(overrides));
        assert_eq!(temperature_of(&payload), 0.3);
        assert_eq!(payload["max_tokens"], json!(10));
    }

    // `send_with_retry` is the single funnel point `complete()`, `complete_stream()`
    // and `generate_image()` all go through, so exercising it directly (rather
    // than the three call sites, and without a real network call / new mock-
    // server dependency) is enough to prove the counter fires exactly once per
    // LOGICAL call — even though the target here fails on every one of its
    // internal retry attempts. `example.invalid` is reserved by RFC 2606 to
    // never resolve, so this never touches the network; a short client timeout
    // keeps each of the 3 attempts (and their capped backoff) fast.
    #[test]
    fn send_with_retry_counts_one_call_despite_internal_retries() {
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let (calls_before, _) = ai_call_stats();

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(200))
            .build()
            .expect("client");
        let result = rt.block_on(send_with_retry(
            &client,
            "http://example.invalid/",
            "test-key",
            &json!({}),
        ));

        assert!(result.is_err(), "a non-resolving host must fail");
        let (calls_after, _) = ai_call_stats();
        // Exactly one logical call counted, no matter how many retry attempts
        // `send_with_retry` made internally.
        assert_eq!(calls_after, calls_before + 1);
    }

    #[test]
    fn extract_json_plain_object() {
        let s = r#"{"nodes":[],"edges":[]}"#;
        assert_eq!(extract_json(s), s);
    }

    #[test]
    fn extract_json_fenced_block() {
        let s = "```json\n{\"nodes\":[],\"edges\":[]}\n```";
        assert_eq!(extract_json(s), r#"{"nodes":[],"edges":[]}"#);
    }

    #[test]
    fn extract_json_bare_language_tag() {
        // Some models emit the language tag without a fence.
        assert_eq!(extract_json("json\n{\"a\":1}"), r#"{"a":1}"#);
    }

    #[test]
    fn extract_json_prose_with_braces_in_strings() {
        // The JSON itself contains braces and escaped quotes inside string
        // literals, and the trailing prose contains a bare '}' — a naive
        // first-'{'/last-'}' scan would slice through the prose.
        let s = "Sure! Here is the graph:\n\
                 {\"label\":\"set {x} and \\\"y\\\"\",\"n\":1}\n\
                 Hope that helps — note the stray } above.";
        let out = extract_json(s);
        assert_eq!(out, "{\"label\":\"set {x} and \\\"y\\\"\",\"n\":1}");
        assert!(serde_json::from_str::<serde_json::Value>(&out).is_ok());
    }

    #[test]
    fn extract_json_unbalanced_garbage_falls_through() {
        let s = "{\"a\": \"never closed";
        assert!(find_balanced_object(s).is_none());
        // extract_json falls back to the fence-stripped input so the serde
        // error downstream still shows what the model actually said.
        let out = extract_json(s);
        assert_eq!(out, s);
        assert!(serde_json::from_str::<serde_json::Value>(&out).is_err());
    }

    #[test]
    fn normalize_analysis_lowercases_relations_and_drops_dangling_edges() {
        let mut result = AnalysisResult {
            nodes: vec![
                AnalysisNode {
                    id: "a".into(),
                    label: "A".into(),
                    summary: String::new(),
                    kind: String::new(),
                    parent: None,
                },
                AnalysisNode {
                    id: "b".into(),
                    label: "B".into(),
                    summary: String::new(),
                    kind: "sentence".into(),
                    parent: Some("a".into()),
                },
            ],
            edges: vec![
                AnalysisEdge { source: "a".into(), target: "b".into(), relation: " Cause ".into() },
                AnalysisEdge { source: "a".into(), target: "ghost".into(), relation: "evidence".into() },
            ],
            analyzed_at: None,
        };
        normalize_analysis(&mut result);
        // Missing kind defaults to "paragraph"; explicit kinds survive.
        assert_eq!(result.nodes[0].kind, "paragraph");
        assert_eq!(result.nodes[1].kind, "sentence");
        // Relation is trimmed + lowercased; the dangling edge is dropped.
        assert_eq!(result.edges.len(), 1);
        assert_eq!(result.edges[0].relation, "cause");
    }

    #[test]
    fn analysis_listing_includes_headings_and_skips_non_prose() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 2, "Methods"));
        doc.chunks.push(Chunk::new_text(1, "First paragraph."));
        doc.chunks.push(Chunk::new_text(2, "   ")); // whitespace-only → skipped
        doc.chunks.push(Chunk::new_diagram(3, "flowchart TD", "mermaid"));
        let mut img = Chunk::new_text(4, "data:image/png;base64,AAAA");
        img.metadata.chunk_type = CHUNK_TYPE_IMAGE.to_string();
        doc.chunks.push(img);

        let listing = analysis_listing(&doc);
        assert!(listing.contains(&format!(
            "- id: {} (heading level 2)\n  text: Methods\n",
            doc.chunks[0].id
        )));
        assert!(listing.contains(&format!(
            "- id: {}\n  text: First paragraph.\n",
            doc.chunks[1].id
        )));
        // Only the heading and the text paragraph made it in.
        assert_eq!(listing.matches("- id:").count(), 2);
    }
}
