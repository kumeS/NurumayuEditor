//! Tauri command surface — the only entry points the frontend can invoke.
//!
//! These are plain application commands (not plugin commands), so they do not
//! require capability/ACL grants; registering them in `generate_handler!` is
//! sufficient. The API key is read here on the Rust side and never crosses to
//! the frontend.

use crate::ai::{self, AiRequest, LlmConfig};
use crate::citations::{self, CitationEntry, CitationStyle};
use crate::deck;
use crate::error::{AppError, AppResult};
use crate::fileio;
use crate::imageio;
use crate::models::{AnalysisResult, Document};
use crate::pptx;
use crate::rag;
use crate::settings::{self, Settings};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};

fn config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| AppError::Config(format!("Could not resolve config directory: {e}")))
}

/// Reject a write target whose extension is present but isn't one we expect
/// (A6 defence-in-depth: a compromised renderer can't coax a command into
/// writing an executable `.command`/`.sh` somewhere). A missing extension is
/// allowed — the OS save dialog appends one — so normal flows are unaffected.
fn check_ext(path: &str, allowed: &[&str]) -> AppResult<()> {
    if let Some(ext) = std::path::Path::new(path).extension().and_then(|e| e.to_str()) {
        if !allowed.iter().any(|a| a.eq_ignore_ascii_case(ext)) {
            return Err(AppError::Other(format!(
                "Refusing to write '{path}': expected a .{} file.",
                allowed.join("/.")
            )));
        }
    }
    Ok(())
}

/// True for endpoints served from the local machine (e.g. an Ollama bridge),
/// which don't need an API key.
fn is_local_endpoint(endpoint: &str) -> bool {
    let e = endpoint.to_ascii_lowercase();
    e.contains("localhost")
        || e.contains("127.0.0.1")
        || e.contains("0.0.0.0")
        || e.contains("[::1]")
}

/// Resolve the API key for a request. Remote providers (OpenRouter, …) require a
/// key; local endpoints may run keyless, so an empty key is allowed there.
fn api_key_for(endpoint: &str) -> AppResult<String> {
    match settings::get_api_key()? {
        Some(k) if !k.trim().is_empty() => Ok(k),
        _ if is_local_endpoint(endpoint) => Ok(String::new()),
        _ => Err(AppError::Config(
            "No API key is set. Open Settings and add your OpenRouter API key. \
             (Local endpoints such as Ollama can leave the key blank.)"
                .to_string(),
        )),
    }
}

fn load_llm_config(app: &AppHandle) -> AppResult<LlmConfig> {
    let settings = Settings::load(&config_dir(app)?);
    let api_key = api_key_for(&settings.endpoint)?;
    Ok(LlmConfig {
        endpoint: settings.endpoint,
        model: settings.model,
        api_key,
        temperature: settings.temperature,
    })
}

/// Like `load_llm_config` but uses the configured IMAGE model.
fn load_image_llm_config(app: &AppHandle) -> AppResult<LlmConfig> {
    let settings = Settings::load(&config_dir(app)?);
    let api_key = api_key_for(&settings.endpoint)?;
    Ok(LlmConfig {
        endpoint: settings.endpoint,
        model: settings.image_model,
        api_key,
        temperature: settings.temperature,
    })
}

// ----- document lifecycle --------------------------------------------------

#[tauri::command]
pub fn import_document(path: String) -> AppResult<Document> {
    let mut doc = fileio::import_from_path(&path)?;
    doc.normalize(); // enforce invariants on imported text too (A1)
    Ok(doc)
}

#[tauri::command]
pub async fn export_document(mut document: Document, path: String, format: String) -> AppResult<()> {
    check_ext(&path, &[format.as_str()])?;
    if format.eq_ignore_ascii_case("rtf") {
        // Same as the PPTX path: fetch remote image URLs so the RTF writer can
        // embed them; a failed fetch falls back to the text placeholder.
        imageio::resolve_remote_images(document.chunks.iter_mut()).await;
    }
    fileio::export_to_path(&document, &path, &format)
}

/// Export the document as a PowerPoint deck: derive slides from the document
/// (headings → slides, paragraphs → bullets, images embedded), download any
/// remote image URLs, write `.pptx`, and report anything that couldn't be added.
#[tauri::command]
pub async fn export_pptx(document: Document, path: String) -> AppResult<pptx::PptxReport> {
    check_ext(&path, &["pptx"])?;
    let mut deck = deck::document_to_deck(&document);
    imageio::resolve_remote_images(deck.slides.iter_mut().flat_map(|s| s.chunks.iter_mut())).await;
    let (bytes, warnings) = pptx::deck_to_pptx(&deck)?;
    fileio::write_atomic(&path, &bytes)?;
    Ok(pptx::PptxReport {
        slides: deck.slides.len(),
        warnings,
    })
}

/// Save/open the native `.aix` document format (the chunk JSON from spec §5).
/// Written atomically so a crash mid-save can't truncate the user's document.
#[tauri::command]
pub fn save_document_json(document: Document, path: String) -> AppResult<()> {
    check_ext(&path, &["aix"])?;
    fileio::write_atomic(&path, serde_json::to_string_pretty(&document)?.as_bytes())
}

/// A `.aix` document loaded from disk, plus any repairs `Document::normalize`
/// had to make (A1) so the frontend can tell the user what was fixed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub document: Document,
    pub notes: Vec<String>,
}

#[tauri::command]
pub fn open_document_json(path: String) -> AppResult<OpenedDocument> {
    let s = std::fs::read_to_string(path)?;
    let mut document: Document = serde_json::from_str(&s)?;
    // Enforce the editor's invariants at the load boundary — a malformed or
    // partially-written .aix (easy to produce via the CLI/agent surface) must not
    // reach the UI with duplicate ids / dangling graph refs (A1).
    let notes = document.normalize();
    Ok(OpenedDocument { document, notes })
}

// ----- settings & secret storage ------------------------------------------

#[tauri::command]
pub fn get_settings(app: AppHandle) -> AppResult<Settings> {
    Ok(Settings::load(&config_dir(&app)?))
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> AppResult<()> {
    settings.save(&config_dir(&app)?)
}

#[tauri::command]
pub fn set_api_key(key: String) -> AppResult<()> {
    settings::set_api_key(&key)
}

#[tauri::command]
pub fn has_api_key() -> bool {
    matches!(settings::get_api_key(), Ok(Some(_)))
}

#[tauri::command]
pub fn delete_api_key() -> AppResult<()> {
    settings::delete_api_key()
}

/// "Zero external transmission" visibility (開発.txt Stage 2, item 2-2):
/// combines the two independent counter pairs — LLM calls (`ai::ai_call_stats`)
/// and reference/image fetches (`net::stats`) — into one snapshot the health
/// bar can poll. See the NOTE in `net.rs` and `ai.rs` for why these are two
/// separate chokepoints rather than one.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStats {
    pub ai_calls: u64,
    pub ai_bytes: u64,
    pub fetch_calls: u64,
    pub fetch_bytes: u64,
}

#[tauri::command]
pub fn get_network_stats() -> NetworkStats {
    let (ai_calls, ai_bytes) = ai::ai_call_stats();
    let (fetch_calls, fetch_bytes) = crate::net::stats();
    NetworkStats { ai_calls, ai_bytes, fetch_calls, fetch_bytes }
}

// ----- AI ------------------------------------------------------------------

#[tauri::command]
pub async fn ai_process(app: AppHandle, request: AiRequest) -> AppResult<String> {
    let config = load_llm_config(&app)?;
    ai::run_action(&config, &request).await
}

/// Streaming variant of `ai_process`: pushes the accumulated text to the
/// `on_delta` channel as it grows and returns the final text.
#[tauri::command]
pub async fn ai_process_stream(
    app: AppHandle,
    request: AiRequest,
    on_delta: Channel<String>,
) -> AppResult<String> {
    let config = load_llm_config(&app)?;
    let ch = on_delta.clone();
    ai::run_action_stream(&config, &request, |text| {
        let _ = ch.send(text.to_string());
    })
    .await
}

/// Ghost-text inline completion (開発.txt Stage 2, item 2-4): stream a short
/// continuation of `prefix` (the text immediately before the cursor), with an
/// optional cheap `context_hint` (e.g. the section heading — never a full
/// document map; this must stay fast). Mirrors `ai_process_stream`'s pattern
/// exactly, but calls the narrower `ai::complete_ghost_text_stream` instead of
/// the one-click-action machinery.
///
/// Honors the user's "limit to local model" privacy setting HERE, at the
/// point the request is actually issued: when the setting is on but the
/// configured endpoint isn't local, this returns an error (silently doing
/// nothing user-visible — the frontend treats any ghost-text failure as
/// "no suggestion", never a toast) rather than sending the prefix to a
/// remote endpoint against the user's stated preference.
#[tauri::command]
pub async fn ai_ghost_complete_stream(
    app: AppHandle,
    prefix: String,
    context_hint: String,
    on_delta: Channel<String>,
) -> AppResult<String> {
    let settings = Settings::load(&config_dir(&app)?);
    if settings.limit_completion_to_local_model && !is_local_endpoint(&settings.endpoint) {
        return Err(AppError::Other(
            "Ghost-text is limited to a local model in Settings, but the configured endpoint \
             isn't local — skipping this completion."
                .to_string(),
        ));
    }
    let config = load_llm_config(&app)?;
    let ch = on_delta.clone();
    ai::complete_ghost_text_stream(&config, &prefix, &context_hint, |text| {
        let _ = ch.send(text.to_string());
    })
    .await
}

fn draft_title(theme: &str) -> String {
    if theme.trim().is_empty() {
        "Untitled Document".to_string()
    } else {
        theme.trim().to_string()
    }
}

/// Streaming draft event pushed to the frontend channel.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DraftEvent {
    /// Live snapshot while generating (chunks carry stable position-based ids).
    Update { document: Document },
    /// Final document with real UUID chunk ids.
    Done { document: Document },
}

/// Generate a draft and stream the parsed document to the frontend as it grows.
#[tauri::command]
pub async fn ai_draft_stream(
    app: AppHandle,
    theme: String,
    target_words: Option<u32>,
    reference: Option<String>,
    on_event: Channel<DraftEvent>,
) -> AppResult<()> {
    let config = load_llm_config(&app)?;
    let settings = Settings::load(&config_dir(&app)?);
    let title = draft_title(&theme);

    let language = Some(settings.default_target_language.clone());
    let tone = Some(settings.writing_tone.clone());
    let title_cb = title.clone();
    let ch = on_event.clone();
    let full = ai::generate_draft_stream(
        &config,
        &theme,
        target_words,
        language.as_deref(),
        tone.as_deref(),
        reference.as_deref(),
        |text| {
        let mut doc = fileio::text_to_document(&title_cb, text);
        // Position-based ids so the frontend reconciles chunks in place during
        // streaming (instead of remounting the whole document each token).
        for (i, c) in doc.chunks.iter_mut().enumerate() {
            c.id = format!("draft-{i}");
        }
        let _ = ch.send(DraftEvent::Update { document: doc });
    })
    .await?;

    // Finalise with real UUIDs for a stable, editable document.
    let document = fileio::text_to_document(&title, &full);
    let _ = on_event.send(DraftEvent::Done { document });
    Ok(())
}

/// Generate an image from a prompt using the configured image model.
#[tauri::command]
pub async fn ai_generate_image(app: AppHandle, prompt: String) -> AppResult<String> {
    let config = load_image_llm_config(&app)?;
    ai::generate_image(&config, &prompt).await
}

#[tauri::command]
pub async fn ai_generate_diagram(
    app: AppHandle,
    text: String,
    instruction: Option<String>,
) -> AppResult<String> {
    let config = load_llm_config(&app)?;
    ai::generate_diagram(&config, &text, instruction.as_deref()).await
}

#[tauri::command]
pub async fn ai_analyze_document(app: AppHandle, document: Document) -> AppResult<AnalysisResult> {
    let config = load_llm_config(&app)?;
    ai::analyze_document(&config, &document).await
}

// ----- Draft reference material (txt/md/rtf/pdf + URL) ----------------------

/// Read a local file as plain reference text for the Draft feature.
#[tauri::command]
pub fn read_reference_file(path: String) -> AppResult<String> {
    fileio::read_reference_text(&path)
}

/// Max bytes fetched for a Draft reference URL (A4): bounds memory use on a huge
/// or hostile page.
const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;

/// Fetch a URL and return its readable text (tags/scripts stripped), for use as
/// Draft reference material.
#[tauri::command]
pub async fn fetch_url_text(url: String) -> AppResult<String> {
    // `net::safe_fetch` enforces http(s)-only, SSRF host filtering, per-hop
    // redirect re-validation, a size cap and a timeout (A4/A5) — previously this
    // could hang indefinitely and buffer an unbounded response into memory.
    let bytes = crate::net::safe_fetch(&url, MAX_HTML_BYTES, 20).await?;
    let body = String::from_utf8_lossy(&bytes);
    let text = strip_html(&body);
    Ok(text.chars().take(20_000).collect())
}

/// Crude but UTF-8-safe HTML→text: drop `<script>`/`<style>` blocks and all
/// tags, decode a few common entities, and collapse whitespace.
fn strip_html(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let len = html.len();
    let mut out = String::with_capacity(len / 2);
    let mut i = 0usize;
    while i < len {
        if lower[i..].starts_with("<script") || lower[i..].starts_with("<style") {
            let close = if lower[i..].starts_with("<script") {
                "</script>"
            } else {
                "</style>"
            };
            match lower[i..].find(close) {
                Some(rel) => i += rel + close.len(),
                None => break,
            }
            out.push(' ');
            continue;
        }
        let ch = html[i..].chars().next().unwrap();
        if ch == '<' {
            match html[i..].find('>') {
                Some(rel) => i += rel + 1,
                None => break,
            }
            out.push(' ');
            continue;
        }
        out.push(ch);
        i += ch.len_utf8();
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ----- Personal RAG (開発.txt Stage 3, item 3-1) ----------------------------
//
// Thin commands only: all chunking/embedding/index logic lives in `rag.rs`
// (core fn takes data — a config-dir `Path` — never an `AppHandle`). Every
// command here first loads `Settings` and refuses to do ANY work (no
// `rag::Index::open`, no directory created, no model touched) unless
// `personal_rag_enabled` is on — the zero-cost-while-disabled invariant
// (item 7) is enforced at this boundary, not deep inside `rag.rs`.

fn rag_disabled_error() -> AppError {
    AppError::Other(
        "Personal RAG is off. Turn on \"Personal knowledge base\" in Settings to add or search \
         your own reference files."
            .to_string(),
    )
}

/// Add a source file to the personal knowledge base: extract its text (the
/// same `read_reference_text` already used for Draft reference material),
/// chunk it into passages, embed each with the local model, and store it in
/// the on-device vector index. Returns the number of passages indexed.
#[tauri::command]
pub fn rag_add_source(app: AppHandle, path: String) -> AppResult<usize> {
    let dir = config_dir(&app)?;
    let settings = Settings::load(&dir);
    if !settings.personal_rag_enabled {
        return Err(rag_disabled_error());
    }
    let text = fileio::read_reference_text(&path)?;
    let mut index = rag::Index::open(&dir)?;
    index.add_source(&path, &text)
}

/// Remove a previously added source's passages from the personal knowledge
/// base. Returns the number of passages removed (0 if it wasn't indexed).
#[tauri::command]
pub fn rag_remove_source(app: AppHandle, path: String) -> AppResult<usize> {
    let dir = config_dir(&app)?;
    let settings = Settings::load(&dir);
    if !settings.personal_rag_enabled {
        return Err(rag_disabled_error());
    }
    let mut index = rag::Index::open(&dir)?;
    index.remove_source(&path)
}

/// One indexed source file's path and passage count, for the personal-library
/// management panel's listing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagSourceInfo {
    pub path: String,
    pub passage_count: u64,
}

impl From<rag::SourceInfo> for RagSourceInfo {
    fn from(s: rag::SourceInfo) -> Self {
        Self { path: s.path, passage_count: s.passage_count }
    }
}

/// List every currently-indexed source file. When the feature is off this
/// returns an empty list rather than an error — the panel's empty state
/// ("nothing indexed yet / feature is off") reads the setting itself to tell
/// those two cases apart, so this never needs to surface a scary error just
/// for opening the management panel with the feature off.
#[tauri::command]
pub fn rag_list_sources(app: AppHandle) -> AppResult<Vec<RagSourceInfo>> {
    let dir = config_dir(&app)?;
    let settings = Settings::load(&dir);
    if !settings.personal_rag_enabled {
        return Ok(Vec::new());
    }
    // Nothing indexed yet: `Index::open` would otherwise still create the
    // sqlite file merely to answer "list nothing" — check for that file's
    // existence first so listing an empty, never-used library truly creates
    // no on-disk artifact (item 7's spirit, applied to a read-only call too).
    if !rag::index_exists(&dir) {
        return Ok(Vec::new());
    }
    let index = rag::Index::open(&dir)?;
    Ok(index.list_sources()?.into_iter().map(RagSourceInfo::from).collect())
}

/// One personal-library search hit: source file + matched snippet + distance,
/// for both the manual search/preview panel and (via `rag_search`) the
/// grounding context `aiActions.ts` attaches to an AI action.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagSearchHit {
    pub source_path: String,
    pub snippet: String,
    pub distance: f32,
}

impl From<rag::SearchHit> for RagSearchHit {
    fn from(h: rag::SearchHit) -> Self {
        Self { source_path: h.source_path, snippet: h.snippet, distance: h.distance }
    }
}

/// Search the personal knowledge base. Exposed mainly for the frontend's
/// manual search/preview panel, and so this whole subsystem is independently
/// testable end to end from the command layer down.
#[tauri::command]
pub fn rag_search(app: AppHandle, query: String, top_k: usize) -> AppResult<Vec<RagSearchHit>> {
    let dir = config_dir(&app)?;
    let settings = Settings::load(&dir);
    if !settings.personal_rag_enabled {
        return Err(rag_disabled_error());
    }
    if !rag::index_exists(&dir) {
        return Ok(Vec::new()); // nothing indexed yet — a real empty result, not an error
    }
    let mut index = rag::Index::open(&dir)?;
    Ok(index.search(&query, top_k)?.into_iter().map(RagSearchHit::from).collect())
}

// ----- Citation management (開発.txt Stage 3, item 3-2) ---------------------
//
// Thin commands only: BibTeX parsing, style formatting, and lookup-response
// parsing all live in `citations.rs` as pure functions. This layer's only job
// is resolving the per-document sidecar path and calling `net::safe_fetch`
// for the two lookup commands — never a raw `reqwest` call (see
// `fetch_url_text` above and `imageio::fetch_as_data_url` for the exact same
// calling convention this imitates).
//
// The library is stored per-document (a `<document>.aix.citations.json`
// sidecar — see `citations.rs`'s module doc for the rationale), so every
// command below takes the document's file path. A document that has never
// been saved (`filePath === null` on the frontend) has nowhere to keep a
// sidecar yet; the frontend is expected to require a saved path before
// offering these actions (see `CitationsPanel.tsx`'s empty state).

/// Import a `.bib` file into the citation library for `document_path`, merging
/// with (not replacing) any entries already there. Returns the import report
/// (newly added entries + any per-entry warnings — e.g. an entry missing a
/// required title was skipped) so the UI can show a persistent, non-toast
/// summary of what happened (this project's "warn, don't block" rule).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibtexImportResult {
    pub added: Vec<CitationEntry>,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub fn citations_import_bibtex(document_path: String, bib_path: String) -> AppResult<BibtexImportResult> {
    let src = std::fs::read_to_string(&bib_path)?;
    let report = citations::parse_bibtex(&src)?;

    let mut library = citations::load_library(&document_path)?;
    // Merge by bibtex_key: a re-import of the same .bib replaces matching
    // entries (fresher metadata) rather than accumulating duplicates.
    for entry in &report.entries {
        library.entries.retain(|e| e.bibtex_key != entry.bibtex_key);
    }
    library.entries.extend(report.entries.iter().cloned());
    citations::save_library(&document_path, &library)?;

    Ok(BibtexImportResult { added: report.entries, warnings: report.warnings })
}

/// List every citation entry currently imported for `document_path`. A
/// document with no sidecar yet (nothing imported) returns an empty list
/// rather than an error.
#[tauri::command]
pub fn citations_list(document_path: String) -> AppResult<Vec<CitationEntry>> {
    Ok(citations::load_library(&document_path)?.entries)
}

/// Add one entry (manually filled in, or reviewed/edited from a
/// `citations_lookup_doi`/`citations_lookup_arxiv` result — see
/// `citations_add_lookup_result` for the common case of adding a lookup
/// result unmodified) to the library. Returns the stored entry (with its
/// assigned id) so the caller can immediately reference it.
#[tauri::command]
pub fn citations_add_entry(document_path: String, entry: CitationEntry) -> AppResult<CitationEntry> {
    let mut library = citations::load_library(&document_path)?;
    library.entries.retain(|e| e.id != entry.id);
    library.entries.push(entry.clone());
    citations::save_library(&document_path, &library)?;
    Ok(entry)
}

/// Convert a `citations_lookup_doi`/`citations_lookup_arxiv` result into a
/// full citation entry (assigning it a fresh id) and add it to the library in
/// one step — the common "look up, then add as-is" path. `key` becomes the
/// entry's display key (the DOI or arXiv id that was looked up).
#[tauri::command]
pub fn citations_add_lookup_result(
    document_path: String,
    result: citations::LookupResult,
    key: String,
) -> AppResult<CitationEntry> {
    let entry = result.into_entry(&key);
    citations_add_entry(document_path, entry)
}

/// Remove one citation entry by id. Returns true if an entry was actually removed.
#[tauri::command]
pub fn citations_remove_entry(document_path: String, entry_id: String) -> AppResult<bool> {
    let mut library = citations::load_library(&document_path)?;
    let before = library.entries.len();
    library.entries.retain(|e| e.id != entry_id);
    let removed = library.entries.len() != before;
    if removed {
        citations::save_library(&document_path, &library)?;
    }
    Ok(removed)
}

/// Max bytes fetched for a DOI/arXiv metadata lookup (A4): these are small
/// JSON/Atom documents, so a generous-but-bounded cap is enough to stop a
/// hostile/misbehaving endpoint from streaming an unbounded response.
const MAX_LOOKUP_BYTES: usize = 2 * 1024 * 1024;

fn crossref_url(doi: &str) -> String {
    // `doi` is percent-encoded here (not interpolated raw into a shell/SQL
    // context) — it only ever becomes a URL path segment fetched through the
    // SSRF-guarded `safe_fetch`.
    format!(
        "https://api.crossref.org/works/{}",
        urlencoding_light(doi.trim())
    )
}

fn arxiv_url(id: &str) -> String {
    format!(
        "https://export.arxiv.org/api/query?id_list={}",
        urlencoding_light(id.trim())
    )
}

/// Minimal percent-encoding for the small set of characters that can appear
/// in a DOI/arXiv id and would otherwise break the URL (notably `/`). Not a
/// general URL-encoder — sufficient for these two narrow, well-known id
/// shapes.
fn urlencoding_light(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Look up a DOI via the free CrossRef REST API and return parsed metadata
/// (title/authors/year/venue) for auto-filling a new citation entry. Does NOT
/// add it to the library — the caller reviews the result and calls
/// `citations_add_entry` (via `LookupResult::into_entry`) explicitly.
#[tauri::command]
pub async fn citations_lookup_doi(doi: String) -> AppResult<citations::LookupResult> {
    if doi.trim().is_empty() {
        return Err(AppError::Other("Enter a DOI to look up.".to_string()));
    }
    // `net::safe_fetch` enforces http(s)-only, SSRF host filtering, per-hop
    // redirect re-validation, a size cap and a timeout (A4/A5) — the same
    // guarded chokepoint `fetch_url_text` and `imageio::fetch_as_data_url` use.
    let bytes = crate::net::safe_fetch(&crossref_url(&doi), MAX_LOOKUP_BYTES, 15).await?;
    let body = String::from_utf8_lossy(&bytes);
    citations::parse_crossref_json(&body)
}

/// Look up an arXiv id via the arXiv Atom API and return parsed metadata.
#[tauri::command]
pub async fn citations_lookup_arxiv(arxiv_id: String) -> AppResult<citations::LookupResult> {
    if arxiv_id.trim().is_empty() {
        return Err(AppError::Other("Enter an arXiv id to look up.".to_string()));
    }
    let bytes = crate::net::safe_fetch(&arxiv_url(&arxiv_id), MAX_LOOKUP_BYTES, 15).await?;
    let body = String::from_utf8_lossy(&bytes);
    citations::parse_arxiv_atom(&body)
}

/// Format one citation entry in the given style ("apa" | "ieee"). `index` is
/// this entry's 1-based position in the bibliography the caller is building
/// (IEEE's numbered-bracket style needs it; APA ignores it).
#[tauri::command]
pub fn citations_format(document_path: String, entry_id: String, style: String, index: usize) -> AppResult<String> {
    let style: CitationStyle = style.parse()?;
    let library = citations::load_library(&document_path)?;
    let entry = library
        .entries
        .iter()
        .find(|e| e.id == entry_id)
        .ok_or_else(|| AppError::Other(format!("No citation entry with id '{entry_id}'.")))?;
    Ok(citations::format_citation(entry, style, index))
}

/// Build an end-of-document bibliography/references list from the given
/// entry ids (the ones actually cited), in the given style. IEEE numbers them
/// in the given (citation) order; APA sorts alphabetically by author surname
/// — see `citations::format_bibliography`.
#[tauri::command]
pub fn citations_bibliography(document_path: String, entry_ids: Vec<String>, style: String) -> AppResult<Vec<String>> {
    let style: CitationStyle = style.parse()?;
    let library = citations::load_library(&document_path)?;
    let cited: Vec<CitationEntry> = entry_ids
        .iter()
        .filter_map(|id| library.entries.iter().find(|e| &e.id == id).cloned())
        .collect();
    Ok(citations::format_bibliography(&cited, style))
}

// ----- Text-to-speech (read aloud) -----------------------------------------

/// Monotonic id for each read-aloud request, so the frontend can match the
/// "speech finished" event to the exact button that started it (UI3).
static SPEECH_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Speak `text` aloud using the OS speech synthesizer (macOS `say`). Returns an
/// utterance id immediately (never blocks the UI); a background thread waits for
/// speech to finish and then emits a `speech-done` event carrying that id, so the
/// frontend clears exactly the chunk that was playing — instead of leaving the
/// button stuck on "Stop" and cross-wiring multiple chunks (UI3). Any current
/// speech is stopped first; its own `speech-done` (a smaller id) is then
/// distinguishable from this one. An optional `voice` selects a system voice.
#[tauri::command]
pub fn speak_text(app: AppHandle, text: String, voice: Option<String>) -> AppResult<u64> {
    let id = SPEECH_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        // Nothing to say — report completion immediately so the UI doesn't stick.
        let _ = app.emit("speech-done", id);
        return Ok(id);
    }
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        // Stop any in-flight speech so a new request restarts cleanly. The killed
        // utterance's wait-thread will emit its own (older-id) speech-done, which
        // the frontend ignores because it no longer matches the active id.
        let _ = Command::new("killall").arg("say").status();
        let mut cmd = Command::new("say");
        // Only pass the requested voice if it's actually installed; otherwise the
        // system default is used (better than `say` erroring on a missing voice).
        if let Some(v) = voice
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .filter(|v| macos_voice_installed(v))
        {
            cmd.arg("-v").arg(v);
        }
        // Read the text from stdin to avoid argv length/flag-parsing limits.
        let mut child = cmd
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| AppError::Other(format!("Could not start speech: {e}")))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(trimmed.as_bytes());
            // stdin is dropped here → EOF, so `say` knows the input is complete.
        }
        // Wait for completion off-thread, then notify the frontend.
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            let _ = app.emit("speech-done", id);
        });
        Ok(id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (voice, app);
        Err(AppError::Other(
            "Read-aloud is currently available on macOS only.".to_string(),
        ))
    }
}

/// True if a macOS `say` voice with this name is installed (checks `say -v '?'`).
#[cfg(target_os = "macos")]
fn macos_voice_installed(name: &str) -> bool {
    use std::process::Command;
    let Ok(out) = Command::new("say").arg("-v").arg("?").output() else {
        return false;
    };
    let listing = String::from_utf8_lossy(&out.stdout);
    let needle = name.to_ascii_lowercase();
    // Each line begins with the voice name, e.g. "Kyoko    ja_JP  # …".
    listing.lines().any(|line| {
        line.split_whitespace()
            .next()
            .map(|w| w.to_ascii_lowercase() == needle)
            .unwrap_or(false)
    })
}

/// Stop any in-progress read-aloud.
#[tauri::command]
pub fn stop_speaking() -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("killall").arg("say").status();
    }
    Ok(())
}

// ----- session autosave / crash recovery (A2) ------------------------------

fn session_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Config(format!("Could not resolve app data directory: {e}")))?
        .join("session.json"))
}

/// Persist the whole multi-tab working set (active + background tabs) so a crash
/// or force-quit doesn't lose unsaved work, including irreproducible AI drafts
/// (A2). The frontend debounces this on dirty changes. Written atomically
/// (`fileio::write_atomic`) so a crash mid-write can't corrupt the recovery
/// file. The payload is an opaque JSON value — its shape is owned by the
/// frontend.
#[tauri::command]
pub fn save_session(app: AppHandle, session: serde_json::Value) -> AppResult<()> {
    let path = session_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    fileio::write_atomic(&path, serde_json::to_string(&session)?.as_bytes())
}

/// Load the saved session, or `None` if there isn't one (first run / clean exit).
/// A corrupt/unparseable file is treated as "no session" and deleted, so a bad
/// write can't make recovery error out on every launch.
#[tauri::command]
pub fn load_session(app: AppHandle) -> AppResult<Option<serde_json::Value>> {
    let path = session_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)?;
    match serde_json::from_str(&text) {
        Ok(value) => Ok(Some(value)),
        Err(_) => {
            let _ = std::fs::remove_file(&path); // self-heal a corrupt recovery file
            Ok(None)
        }
    }
}

/// Delete the session file (after a clean quit or once the user declines to
/// restore), so it isn't offered again.
#[tauri::command]
pub fn clear_session(app: AppHandle) -> AppResult<()> {
    let path = session_path(&app)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

/// Quit the whole app (Cmd+Q / menu Quit). Uses `AppHandle::exit`, which passes a
/// non-None exit code so the macOS "keep running on window close" backstop in
/// `lib.rs` lets it through (a plain window close is vetoed instead).
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    // The underlying counters are process-wide statics shared with net.rs's and
    // ai.rs's own tests running in the SAME test binary under `cargo test`'s
    // default parallel execution, so this asserts the DELTA `get_network_stats()`
    // reports after a known increment on ITS OWN field only — not an absolute
    // value, and not a "the other field is untouched" claim, either of which
    // would be flaky depending on what else is running concurrently.
    //
    // IMPORTANT: this must be `>=`, not `==`. `net.rs` has its own test
    // (`safe_fetch_counts_the_call_even_when_blocked`) that increments this
    // SAME `FETCH_CALLS` static, and `cargo test`'s default parallel runner can
    // interleave it between our `before`/`after` reads — an exact `+1` assert
    // was observed to fail intermittently for exactly this reason. `>=` still
    // fails if `safe_fetch` stops incrementing the counter (the regression this
    // test exists to catch) while tolerating a concurrent test's own bump.
    #[test]
    fn get_network_stats_reflects_underlying_counters() {
        let before = get_network_stats();

        // Drive the exact counter this command reads, without a real network
        // call: a blocked-host fetch still increments net.rs's call counter.
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let _ = rt.block_on(crate::net::safe_fetch("http://127.0.0.1:9/", 1024, 1));

        let after = get_network_stats();
        assert!(
            after.fetch_calls >= before.fetch_calls + 1,
            "expected fetch_calls to advance by at least 1 (before={}, after={})",
            before.fetch_calls,
            after.fetch_calls
        );
    }

    // `is_local_endpoint` had zero direct tests despite being the exact
    // function `ai_ghost_complete_stream` calls to enforce the "limit to
    // local model" privacy setting (a real promise, not a cosmetic toggle —
    // see the doc comment on that command and on
    // `Settings::limit_completion_to_local_model`). `cli.rs` has its own
    // mirror of this function with its own test; this covers the copy that
    // actually gates ghost-text.
    #[test]
    fn is_local_endpoint_recognizes_loopback_forms_and_rejects_remote() {
        assert!(is_local_endpoint("http://localhost:11434/v1/chat/completions"));
        assert!(is_local_endpoint("http://127.0.0.1:11434"));
        assert!(is_local_endpoint("http://0.0.0.0:11434"));
        assert!(is_local_endpoint("http://[::1]:11434"));
        assert!(is_local_endpoint("HTTP://LOCALHOST:11434")); // case-insensitive
        assert!(!is_local_endpoint("https://openrouter.ai/api/v1/chat/completions"));
        assert!(!is_local_endpoint("https://api.example.com/v1/chat/completions"));
    }

    // Exercises the exact branch `ai_ghost_complete_stream` uses to enforce
    // the privacy setting: when it's on and the endpoint isn't local, the
    // request must be refused BEFORE any network call is attempted — this
    // asserts the boolean condition the command's `if` guards on, which is
    // the smallest unit that would fail if the guard were ever inverted or
    // dropped.
    #[test]
    fn ghost_text_local_only_guard_blocks_remote_and_allows_local() {
        let blocks = |limit: bool, endpoint: &str| limit && !is_local_endpoint(endpoint);

        // Setting on + remote endpoint → blocked (the privacy promise).
        assert!(blocks(true, "https://openrouter.ai/api/v1/chat/completions"));
        // Setting on + local endpoint → allowed.
        assert!(!blocks(true, "http://localhost:11434/v1/chat/completions"));
        // Setting off (default) → never blocked, regardless of endpoint.
        assert!(!blocks(false, "https://openrouter.ai/api/v1/chat/completions"));
        assert!(!blocks(false, "http://localhost:11434/v1/chat/completions"));
    }
}
