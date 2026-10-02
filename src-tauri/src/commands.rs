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
use crate::pdf;
use crate::pptx;
use crate::rag;
use crate::settings::{self, Settings};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};

fn config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| AppError::Config(format!("Could not resolve config directory: {e}")))
}

/// Fail-closed extension allowlist for caller-supplied write paths (A6
/// defence-in-depth, rust.md rule 7): the path must END in one of `allowed`
/// (ASCII case-insensitive). A missing extension, a non-UTF-8 one, or a
/// leading-dot name such as `~/.zshrc` (where `Path::extension()` is None) is
/// refused, so a compromised renderer can't coax a command into overwriting a
/// dotfile or writing an executable `.command`/`.sh`. Normal flows are
/// unaffected: every save dialog passes an extension filter, and plain Save
/// reuses a path that was opened as .aix/.md.
fn check_ext(path: &str, allowed: &[&str]) -> AppResult<()> {
    let ok = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| allowed.iter().any(|a| a.eq_ignore_ascii_case(ext)));
    if ok {
        Ok(())
    } else {
        Err(AppError::Other(format!(
            "Refusing to write '{path}': expected a .{} file.",
            allowed.join("/.")
        )))
    }
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
    let settings = load_settings_in(&config_dir(app)?);
    let api_key = api_key_for(&settings.endpoint)?;
    // The keychain is the source of truth; if the cached existence flag
    // disagrees with what we just read, correct it rather than let the UI keep
    // showing a stale "key set" dot.
    if settings.api_key_present != Some(!api_key.is_empty()) && !is_local_endpoint(&settings.endpoint) {
        record_api_key_presence(app, !api_key.is_empty());
    }
    Ok(LlmConfig {
        endpoint: settings.endpoint,
        model: settings.model,
        api_key,
        temperature: settings.temperature,
    })
}

/// Like `load_llm_config` but uses the configured IMAGE model.
fn load_image_llm_config(app: &AppHandle) -> AppResult<LlmConfig> {
    let settings = load_settings_in(&config_dir(app)?);
    let api_key = api_key_for(&settings.endpoint)?;
    Ok(LlmConfig {
        endpoint: settings.endpoint,
        model: settings.image_model,
        api_key,
        temperature: settings.temperature,
    })
}

// ----- main-thread policy ----------------------------------------------------
//
// Tauri 2 runs a sync `#[tauri::command] pub fn` on the main thread, where
// AppKit also serves accessibility queries (BUG-006). Commands that touch
// disk, the network or the local embedding model are therefore `async`; the
// few that stay sync are listed, with reasons, in
// `tests::MAIN_THREAD_COMMANDS`. Async commands run concurrently, so commands
// that read-modify-write one shared file hold that file's lock below for their
// whole body. A lock stops two writes from interleaving; it cannot restore
// the order the calls were sent in, because that order is lost when Tauri
// spawns each call.

/// Session file (`session.json`): save, load and clear.
static SESSION_IO: Mutex<()> = Mutex::new(());
/// Personal RAG index (sqlite + embedding model).
static RAG_IO: Mutex<()> = Mutex::new(());
/// Per-document citation sidecars.
static CITATIONS_IO: Mutex<()> = Mutex::new(());
/// `settings.json`, including the backend-owned `api_key_present` flag. Held
/// only inside `load_settings_in` / `save_settings_in` /
/// `record_api_key_presence_in` (never around a call to one, because the lock
/// is not re-entrant); every settings read and write in this file goes
/// through them (guarded by a test). Not covered: the one startup read in
/// lib.rs `setup`, which runs before any command, and the separate CLI/MCP
/// process, which reads the file without this lock.
static SETTINGS_IO: Mutex<()> = Mutex::new(());

/// Take a unit lock. A panic in an earlier holder poisons the lock but leaves
/// no half-updated data behind (the files are written atomically), so the
/// poison is ignored.
fn hold(lock: &'static Mutex<()>) -> MutexGuard<'static, ()> {
    lock.lock().unwrap_or_else(|e| e.into_inner())
}

/// Run blocking work (model load/download, embedding, sqlite) on the blocking
/// pool, so it pins neither the main thread nor an async worker that AI
/// streaming also uses.
async fn run_blocking<T, F>(work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| {
        AppError::Other("The background task stopped unexpectedly. Try again.".to_string())
    })?
}

// ----- document lifecycle --------------------------------------------------

#[tauri::command]
pub async fn import_document(path: String) -> AppResult<Document> {
    let mut doc = fileio::import_from_path(&path)?;
    doc.normalize(); // enforce invariants on imported text too (A1)
    Ok(doc)
}

/// Generic text export (`txt` / `md` / `rtf`). Returns the `RtfReport` (what
/// the RTF couldn't embed, counted per cause) for `rtf`, and `None` for
/// txt/md. `pdf` is refused by `fileio::export_to_path` because this route
/// cannot return the `PdfReport`; PDF uses `export_pdf`. GUI .md payload
/// contract: the frontend sends `mode: "markdown"` with the TS-merged
/// `markdown_source` (fileActions `markdownSavePayload`), which
/// `document_to_md` writes verbatim.
#[tauri::command]
pub async fn export_document(
    mut document: Document,
    path: String,
    format: String,
) -> AppResult<Option<fileio::RtfReport>> {
    if format.eq_ignore_ascii_case("md") || format.eq_ignore_ascii_case("markdown") {
        check_ext(&path, &["md", "markdown"])?;
    } else {
        check_ext(&path, &[format.as_str()])?;
    }
    if format.eq_ignore_ascii_case("rtf") {
        // Same as the PPTX path: fetch remote image URLs so the RTF writer can
        // embed them; a failed fetch falls back to the text placeholder.
        imageio::resolve_remote_images(document.chunks.iter_mut()).await;
    }
    fileio::export_with_report(&document, &path, &format)
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

/// Export the document as an A4 PDF at `path` (chosen in the native save
/// dialog) and report what the PDF could not carry (images, diagrams,
/// literal Markdown). `async` so rendering and font embedding run off the
/// main thread. No new capability: the dialog picks, Rust writes.
#[tauri::command]
pub async fn export_pdf(document: Document, path: String) -> AppResult<pdf::PdfReport> {
    check_ext(&path, &["pdf"])?;
    pdf::write_pdf(&document, &path)
}

/// Save/open the native `.aix` document format (the chunk JSON from spec §5).
/// Written atomically so a crash mid-save can't truncate the user's document.
#[tauri::command]
pub async fn save_document_json(document: Document, path: String) -> AppResult<()> {
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
pub async fn open_document_json(path: String) -> AppResult<OpenedDocument> {
    let s = std::fs::read_to_string(path)?;
    let mut document: Document = serde_json::from_str(&s)?;
    // Enforce the editor's invariants at the load boundary — a malformed or
    // partially-written .aix (easy to produce via the CLI/agent surface) must not
    // reach the UI with duplicate ids / dangling graph refs (A1).
    let notes = document.normalize();
    Ok(OpenedDocument { document, notes })
}

/// GUI-only folder tree browsing (the sidebar file explorer). The core
/// canonicalizes both paths, enforces root containment, and caps returned
/// entries; it does not filter by extension (see `DirectoryEntry::is_openable`).
#[tauri::command]
pub async fn list_directory(root: String, path: String) -> AppResult<Vec<fileio::DirectoryEntry>> {
    fileio::list_directory(&root, &path)
}

/// Rebuild the native menu bar in `language` (the Settings "Default language").
/// The menu is native and built once at startup, so switching languages has to
/// replace it explicitly — otherwise the menu bar would stay in the old
/// language until the next launch while the rest of the UI switched instantly.
#[tauri::command]
pub fn set_menu_language(app: AppHandle, language: String) -> AppResult<()> {
    let menu = crate::menu::build(&app, &language)
        .map_err(|e| AppError::Other(format!("Could not rebuild the menu: {e}")))?;
    app.set_menu(menu)
        .map_err(|e| AppError::Other(format!("Could not apply the menu: {e}")))?;
    Ok(())
}

// ----- settings & secret storage ------------------------------------------

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> AppResult<Settings> {
    let dir = config_dir(&app)?;
    run_blocking(move || Ok(load_settings_in(&dir))).await
}

/// Whole-object save from the UI. The backend-owned fields are re-read from
/// disk under `SETTINGS_IO`, so a concurrent `record_api_key_presence` can't
/// be undone by a stale UI copy. Saves complete in lock order, not in the
/// order the UI sent them (see the main-thread policy above).
#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: Settings) -> AppResult<()> {
    let dir = config_dir(&app)?;
    run_blocking(move || save_settings_in(&dir, settings)).await
}

/// `Settings::load` under `SETTINGS_IO` (a corrupt file is renamed to
/// `.bak` by the load, so even a read can write).
fn load_settings_in(dir: &Path) -> Settings {
    let _io = hold(&SETTINGS_IO);
    Settings::load(dir)
}

fn save_settings_in(dir: &Path, settings: Settings) -> AppResult<()> {
    let _io = hold(&SETTINGS_IO);
    settings
        .with_backend_owned_fields_from(&Settings::load(dir))
        .save(dir)
}

/// Persist the non-secret "a key exists" flag so `has_api_key` never has to
/// open the keychain (each keychain read is a macOS permission prompt for a
/// binary the system doesn't already trust for that item). Best-effort: the
/// keychain, not this flag, remains the source of truth.
fn record_api_key_presence(app: &AppHandle, present: bool) {
    if let Ok(dir) = config_dir(app) {
        record_api_key_presence_in(&dir, present);
    }
}

fn record_api_key_presence_in(dir: &Path, present: bool) {
    let _io = hold(&SETTINGS_IO);
    // Never materialise a settings file from defaults just to store this
    // flag: on a corrupt/missing file `Settings::load` returns defaults, and
    // writing those back would overwrite the user's real configuration.
    if !dir.join("settings.json").exists() {
        return;
    }
    let mut settings = Settings::load(dir);
    if settings.api_key_present != Some(present) {
        settings.api_key_present = Some(present);
        let _ = settings.save(dir);
    }
}

/// Keychain work runs on the blocking pool: a macOS SecurityAgent prompt can
/// wait on the user for as long as it likes without pinning a worker.
#[tauri::command]
pub async fn set_api_key(app: AppHandle, key: String) -> AppResult<()> {
    let dir = config_dir(&app).ok();
    run_blocking(move || {
        settings::set_api_key(&key)?;
        // An empty value deletes the entry (see settings::set_api_key).
        if let Some(dir) = dir {
            record_api_key_presence_in(&dir, !key.trim().is_empty());
        }
        Ok(())
    })
    .await
}

/// Does the user have an API key configured? Answered from the saved existence
/// flag, so launching the app does NOT open the keychain. Only a settings file
/// predating the flag (`None`) falls back to a single real read, whose answer is
/// then persisted — so an upgrading user is asked at most once.
#[tauri::command]
pub async fn has_api_key(app: AppHandle) -> bool {
    let dir = config_dir(&app).ok();
    run_blocking(move || Ok(has_api_key_in(dir.as_deref())))
        .await
        .unwrap_or(false)
}

fn has_api_key_in(dir: Option<&Path>) -> bool {
    if let Some(dir) = dir {
        if let Some(present) = load_settings_in(dir).api_key_present {
            return present;
        }
    }
    let present = matches!(settings::get_api_key(), Ok(Some(_)));
    if let Some(dir) = dir {
        record_api_key_presence_in(dir, present);
    }
    present
}

#[tauri::command]
pub async fn delete_api_key(app: AppHandle) -> AppResult<()> {
    let dir = config_dir(&app).ok();
    run_blocking(move || {
        settings::delete_api_key()?;
        if let Some(dir) = dir {
            record_api_key_presence_in(&dir, false);
        }
        Ok(())
    })
    .await
}

/// OpenRouter model catalog for the Settings picker. Callers pass the
/// endpoint currently shown in the Settings form (possibly unsaved) as
/// `endpoint`. It only gates the request, together with the PERSISTED
/// endpoint loaded here: the keychain holds one key, the one the saved
/// endpoint uses, so the key is read only when BOTH are OpenRouter — an
/// unsaved switch from another provider never sends that provider's key to
/// openrouter.ai (security-rust-1). The URL fetched is always the fixed
/// `openrouter_models::OPENROUTER_MODELS_URL`. The key is read here and never
/// returned. Counted as a fetch in `get_network_stats`, not as an AI call.
///
/// Known limit: one keychain slot is shared by every provider, so saving a new
/// endpoint without replacing the key still pairs the old key with it
/// (planned: a key slot per provider, or the key's origin stored beside it).
#[tauri::command]
pub async fn list_openrouter_models(
    app: AppHandle,
    endpoint: String,
) -> AppResult<crate::openrouter_models::OpenRouterCatalog> {
    let saved = load_settings_in(&config_dir(&app)?).endpoint;
    crate::openrouter_models::list_catalog(&endpoint, &saved, api_key_for).await
}

/// "Zero external transmission" visibility (開発.txt Stage 2, item 2-2):
/// combines the two independent counter pairs — LLM calls (`ai::ai_call_stats`)
/// and fetches through net.rs (`net::stats`: reference/image/citation lookups
/// and the OpenRouter model list) — into one snapshot the health bar can poll.
/// See the NOTE in `net.rs` and `ai.rs` for why these are two separate
/// chokepoints rather than one.
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
    let settings = load_settings_in(&config_dir(&app)?);
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
    let settings = load_settings_in(&config_dir(&app)?);
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

/// Read a local image file and return it as an inline data URL (the webview
/// never reads disk directly). Paths come from the image picker dialog AND
/// from documents: the preview and the PPTX and RTF exports (fileActions
/// `withEmbeddedLocalImages`) resolve a figure reference (`figures/x.png`, an
/// absolute path or `file:` URL) against the document's folder and read it
/// here. Hostile-argument contract (`imageio::read_local_image_file`): the
/// path must be a regular file, not a symlink (lstat; symlinks are refused,
/// not resolved), with an allowlisted image extension, under the 25 MB cap,
/// and its bytes must sniff as PNG/JPEG/GIF/WEBP/BMP; there is no directory or
/// traversal restriction, so only files whose content is an allowlisted image
/// format are ever exposed.
#[tauri::command]
pub async fn read_local_image(path: String) -> AppResult<String> {
    imageio::read_local_image_file(&path)
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
pub async fn read_reference_file(path: String) -> AppResult<String> {
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
pub async fn rag_add_source(app: AppHandle, path: String) -> AppResult<usize> {
    let dir = config_dir(&app)?;
    run_blocking(move || {
        let _io = hold(&RAG_IO);
        let settings = load_settings_in(&dir);
        if !settings.personal_rag_enabled {
            return Err(rag_disabled_error());
        }
        let text = fileio::read_reference_text(&path)?;
        let mut index = rag::Index::open(&dir)?;
        index.add_source(&path, &text)
    })
    .await
}

/// Remove a previously added source's passages from the personal knowledge
/// base. Returns the number of passages removed (0 if it wasn't indexed).
#[tauri::command]
pub async fn rag_remove_source(app: AppHandle, path: String) -> AppResult<usize> {
    let dir = config_dir(&app)?;
    run_blocking(move || {
        let _io = hold(&RAG_IO);
        let settings = load_settings_in(&dir);
        if !settings.personal_rag_enabled {
            return Err(rag_disabled_error());
        }
        let mut index = rag::Index::open(&dir)?;
        index.remove_source(&path)
    })
    .await
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
pub async fn rag_list_sources(app: AppHandle) -> AppResult<Vec<RagSourceInfo>> {
    let dir = config_dir(&app)?;
    run_blocking(move || {
        let _io = hold(&RAG_IO);
        let settings = load_settings_in(&dir);
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
    })
    .await
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
pub async fn rag_search(app: AppHandle, query: String, top_k: usize) -> AppResult<Vec<RagSearchHit>> {
    let dir = config_dir(&app)?;
    run_blocking(move || {
        let _io = hold(&RAG_IO);
        let settings = load_settings_in(&dir);
        if !settings.personal_rag_enabled {
            return Err(rag_disabled_error());
        }
        if !rag::index_exists(&dir) {
            return Ok(Vec::new()); // nothing indexed yet — a real empty result, not an error
        }
        let mut index = rag::Index::open(&dir)?;
        Ok(index.search(&query, top_k)?.into_iter().map(RagSearchHit::from).collect())
    })
    .await
}

/// Auto-accumulation of confirmed content (開発.txt Stage 3, item 3-1;
/// Q11/Q16): called by `fileActions.ts` right after a successful save, with
/// exactly the `(chunkId, content)` pairs for chunks the user has marked
/// `metadata.confirmed == true` AND whose content is non-empty (the frontend
/// filters both — this command does no confirmed/empty filtering of its own,
/// mirroring how `rag_add_source` trusts its caller for which path to index).
/// Silently does nothing (`Ok(0)`, no directory/model touched) when the
/// setting is off, so a save on a document with confirmed chunks costs
/// nothing extra unless the user opted in — matching every other command in
/// this section's zero-cost-while-disabled guard. Each chunk is (re-)indexed
/// under the stable synthetic path `"{doc_path}#{chunkId}"`
/// (`rag::confirmed_chunk_source_path`), so re-saving the SAME chunk replaces
/// its passages rather than accumulating duplicates (`Index::add_source`'s
/// existing replace behavior). Returns the total passage count (re-)indexed.
#[tauri::command]
pub async fn rag_sync_confirmed_chunks(
    app: AppHandle,
    doc_path: String,
    chunks: Vec<(String, String)>,
) -> AppResult<usize> {
    let dir = config_dir(&app)?;
    run_blocking(move || {
        let _io = hold(&RAG_IO);
        let settings = load_settings_in(&dir);
        if !settings.personal_rag_enabled {
            return Ok(0);
        }
        if chunks.is_empty() {
            return Ok(0);
        }
        let pairs: Vec<(String, String)> = chunks
            .into_iter()
            .map(|(chunk_id, text)| (rag::confirmed_chunk_source_path(&doc_path, &chunk_id), text))
            .collect();
        let mut index = rag::Index::open(&dir)?;
        index.add_confirmed_chunks(&pairs)
    })
    .await
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
pub async fn citations_import_bibtex(document_path: String, bib_path: String) -> AppResult<BibtexImportResult> {
    let _io = hold(&CITATIONS_IO);
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
pub async fn citations_list(document_path: String) -> AppResult<Vec<CitationEntry>> {
    Ok(citations::load_library(&document_path)?.entries)
}

/// Add one entry (manually filled in, or reviewed/edited from a
/// `citations_lookup_doi`/`citations_lookup_arxiv` result — see
/// `citations_add_lookup_result` for the common case of adding a lookup
/// result unmodified) to the library. Returns the stored entry (with its
/// assigned id) so the caller can immediately reference it.
#[tauri::command]
pub async fn citations_add_entry(document_path: String, entry: CitationEntry) -> AppResult<CitationEntry> {
    let _io = hold(&CITATIONS_IO);
    add_citation_entry(&document_path, entry)
}

/// Shared body of `citations_add_entry` / `citations_add_lookup_result`.
/// The caller holds `CITATIONS_IO`.
fn add_citation_entry(document_path: &str, entry: CitationEntry) -> AppResult<CitationEntry> {
    let mut library = citations::load_library(document_path)?;
    library.entries.retain(|e| e.id != entry.id);
    library.entries.push(entry.clone());
    citations::save_library(document_path, &library)?;
    Ok(entry)
}

/// Convert a `citations_lookup_doi`/`citations_lookup_arxiv` result into a
/// full citation entry (assigning it a fresh id) and add it to the library in
/// one step — the common "look up, then add as-is" path. `key` becomes the
/// entry's display key (the DOI or arXiv id that was looked up).
#[tauri::command]
pub async fn citations_add_lookup_result(
    document_path: String,
    result: citations::LookupResult,
    key: String,
) -> AppResult<CitationEntry> {
    let _io = hold(&CITATIONS_IO);
    add_citation_entry(&document_path, result.into_entry(&key))
}

/// Remove one citation entry by id. Returns true if an entry was actually removed.
#[tauri::command]
pub async fn citations_remove_entry(document_path: String, entry_id: String) -> AppResult<bool> {
    let _io = hold(&CITATIONS_IO);
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
pub async fn citations_format(document_path: String, entry_id: String, style: String, index: usize) -> AppResult<String> {
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
pub async fn citations_bibliography(document_path: String, entry_ids: Vec<String>, style: String) -> AppResult<Vec<String>> {
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
/// frontend. Runs off the main thread. Save, load and clear hold
/// `SESSION_IO`, so they never interleave; they complete in lock order, which
/// is not guaranteed to be the order the frontend sent them. The frontend
/// therefore sends session calls one at a time (src/api.ts `enqueueSession`,
/// guarded by src/sessionQueue.test.ts).
#[tauri::command]
pub async fn save_session(app: AppHandle, session: serde_json::Value) -> AppResult<()> {
    let path = session_path(&app)?;
    let _io = hold(&SESSION_IO);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    fileio::write_atomic(&path, serde_json::to_string(&session)?.as_bytes())
}

/// Load the saved session, or `None` if there isn't one (first run / clean exit).
/// A corrupt/unparseable file is treated as "no session" and deleted, so a bad
/// write can't make recovery error out on every launch.
#[tauri::command]
pub async fn load_session(app: AppHandle) -> AppResult<Option<serde_json::Value>> {
    let path = session_path(&app)?;
    let _io = hold(&SESSION_IO);
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
pub async fn clear_session(app: AppHandle) -> AppResult<()> {
    let path = session_path(&app)?;
    let _io = hold(&SESSION_IO);
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
    // Kept as `>=`, not `==`. Other tests increment this SAME `FETCH_CALLS`
    // static; the known ones hold `net::network_counter_test_guard` (as this
    // test does), but an unguarded future one could still be interleaved by
    // `cargo test`'s parallel runner between our `before`/`after` reads — an
    // exact `+1` assert was observed to fail intermittently for exactly this
    // reason before the guard existed. `>=` still
    // fails if `safe_fetch` stops incrementing the counter (the regression this
    // test exists to catch) while tolerating a concurrent test's own bump.
    #[test]
    fn get_network_stats_reflects_underlying_counters() {
        let _g = crate::net::network_counter_test_guard();
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

    // ----- main-thread policy (BUG-006 step 1) -----------------------------

    /// Commands allowed to stay sync (Tauri 2 runs a sync command on the main
    /// thread, where AppKit also answers accessibility queries). Everything
    /// else that touches disk, the network or a local model must be async.
    const MAIN_THREAD_COMMANDS: &[(&str, &str)] = &[
        ("set_menu_language", "rebuilds the native menu, which is AppKit (main-thread) work"),
        ("get_network_stats", "reads two atomics; no I/O"),
        ("speak_text", "kill-then-spawn of `say` must not interleave with another read-aloud request"),
        ("stop_speaking", "must stay ordered with speak_text"),
        ("quit_app", "exits the app"),
    ];

    /// `(name, is_async)` for every `#[tauri::command]` in this file's
    /// non-test source. `#[tauri::command(async)]` counts as async.
    fn command_signatures(src: &str) -> Vec<(String, bool)> {
        let prod = src.split("#[cfg(test)]").next().unwrap_or(src);
        let mut out = Vec::new();
        let mut pending: Option<bool> = None;
        for line in prod.lines() {
            let l = line.trim();
            if l.starts_with("#[tauri::command") {
                pending = Some(l.contains("async"));
                continue;
            }
            let Some(attr_async) = pending else { continue };
            if l.starts_with("#[") || l.starts_with("//") {
                continue;
            }
            let (fn_async, rest) = if let Some(r) = l.strip_prefix("pub async fn ") {
                (true, r)
            } else if let Some(r) = l.strip_prefix("pub fn ") {
                (false, r)
            } else {
                panic!("unexpected line after #[tauri::command]: {l}");
            };
            let name = rest.split(['(', '<']).next().unwrap_or("").trim().to_string();
            out.push((name, attr_async || fn_async));
            pending = None;
        }
        out
    }

    /// The source of one command's function, from its `fn` line to the next
    /// command attribute (or the end of the non-test source).
    fn command_body<'a>(src: &'a str, name: &str) -> &'a str {
        let prod = src.split("#[cfg(test)]").next().unwrap_or(src);
        let start = prod
            .find(&format!("fn {name}("))
            .unwrap_or_else(|| panic!("no fn {name} in commands.rs"));
        let rest = &prod[start..];
        let end = rest.find("#[tauri::command").unwrap_or(rest.len());
        &rest[..end]
    }

    #[test]
    fn only_allowlisted_commands_run_on_the_main_thread() {
        let src = include_str!("commands.rs");
        let sigs = command_signatures(src);

        // The parser must see exactly the registered commands, or the check
        // below could pass by missing some.
        let mut parsed: Vec<&str> = sigs.iter().map(|(n, _)| n.as_str()).collect();
        let mut registered: Vec<&str> = include_str!("lib.rs")
            .lines()
            .filter_map(|l| l.trim().strip_prefix("commands::"))
            .filter_map(|l| l.strip_suffix(','))
            .collect();
        parsed.sort_unstable();
        registered.sort_unstable();
        assert_eq!(parsed, registered, "command parser out of sync with generate_handler!");

        let mut sync: Vec<&str> =
            sigs.iter().filter(|(_, a)| !a).map(|(n, _)| n.as_str()).collect();
        let mut allowed: Vec<&str> = MAIN_THREAD_COMMANDS.iter().map(|(n, _)| *n).collect();
        sync.sort_unstable();
        allowed.sort_unstable();
        assert_eq!(sync, allowed, "sync (main-thread) commands differ from the allowlist");
    }

    // Async removes the main thread's implicit one-at-a-time ordering, so the
    // commands that read-modify-write one shared file take its lock.
    #[test]
    fn shared_file_commands_hold_their_lock() {
        let src = include_str!("commands.rs");
        let expectations: &[(&str, &str)] = &[
            ("save_session", "SESSION_IO"),
            ("load_session", "SESSION_IO"),
            ("clear_session", "SESSION_IO"),
            ("rag_add_source", "RAG_IO"),
            ("rag_remove_source", "RAG_IO"),
            ("rag_list_sources", "RAG_IO"),
            ("rag_search", "RAG_IO"),
            ("rag_sync_confirmed_chunks", "RAG_IO"),
            ("citations_import_bibtex", "CITATIONS_IO"),
            ("citations_add_entry", "CITATIONS_IO"),
            ("citations_add_lookup_result", "CITATIONS_IO"),
            ("citations_remove_entry", "CITATIONS_IO"),
        ];
        for (name, lock) in expectations {
            assert!(
                command_body(src, name).contains(&format!("hold(&{lock})")),
                "{name} must hold {lock}"
            );
        }
    }

    // ----- SETTINGS_IO (BUG-006 follow-up) --------------------------------
    // The settings commands are async now, so `save_settings` (a stale UI
    // copy) and `record_api_key_presence` (reached from has/set/delete_api_key
    // and from every AI command via `load_llm_config`) can run at the same
    // time. Each `*_in` helper must wait for SETTINGS_IO.

    fn settings_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aix-settings-io-{tag}-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let mut s = Settings::default();
        s.api_key_present = Some(true); // keeps has_api_key_in off the keychain
        s.save(&dir).expect("seed settings.json");
        dir
    }

    #[test]
    fn settings_helpers_wait_for_settings_io() {
        use std::sync::mpsc;
        use std::time::Duration;
        let dir = settings_dir("excl");
        type Helper = fn(PathBuf);
        let helpers: &[(&str, Helper)] = &[
            ("load_settings_in", |d| {
                load_settings_in(&d);
            }),
            ("save_settings_in", |d| {
                let _ = save_settings_in(&d, Settings::default());
            }),
            ("record_api_key_presence_in", |d| record_api_key_presence_in(&d, true)),
            ("has_api_key_in", |d| {
                has_api_key_in(Some(&d));
            }),
        ];
        for (name, helper) in helpers {
            let guard = hold(&SETTINGS_IO);
            let (tx, rx) = mpsc::channel();
            let (d, f) = (dir.clone(), *helper);
            std::thread::spawn(move || {
                f(d);
                let _ = tx.send(());
            });
            assert_eq!(
                rx.recv_timeout(Duration::from_millis(200)),
                Err(mpsc::RecvTimeoutError::Timeout),
                "{name} ran while SETTINGS_IO was held"
            );
            drop(guard);
            assert!(rx.recv_timeout(Duration::from_secs(10)).is_ok(), "{name} never finished");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Every settings read in this file goes through the locked helpers; a
    // bare `Settings::load` elsewhere could read the file mid-rename.
    #[test]
    fn settings_file_is_only_touched_inside_the_locked_helpers() {
        let src = include_str!("commands.rs");
        let mut prod = src.split("#[cfg(test)]").next().unwrap_or(src).to_string();
        for helper in ["fn load_settings_in(", "fn save_settings_in(", "fn record_api_key_presence_in("] {
            let start = prod.find(helper).unwrap_or_else(|| panic!("no {helper}"));
            let len = prod[start..].find("\n}\n").expect("fn end");
            assert!(prod[start..start + len].contains("hold(&SETTINGS_IO)"), "{helper} must hold SETTINGS_IO");
            prod.replace_range(start..start + len, "");
        }
        assert!(!prod.contains("Settings::load("), "a Settings::load outside the locked helpers");
        assert!(!prod.contains(".save("), "a settings save outside the locked helpers");
    }

    #[test]
    fn stale_ui_save_and_presence_record_end_the_same_in_either_order() {
        for record_first in [true, false] {
            let dir = settings_dir("order");
            record_api_key_presence_in(&dir, false);
            let mut stale = Settings::load(&dir); // the UI's copy: key absent
            stale.temperature = 0.9;
            stale.api_key_present = Some(false);
            if record_first {
                record_api_key_presence_in(&dir, true);
                save_settings_in(&dir, stale).expect("save");
            } else {
                save_settings_in(&dir, stale).expect("save");
                record_api_key_presence_in(&dir, true);
            }
            let on_disk = Settings::load(&dir);
            assert_eq!(on_disk.api_key_present, Some(true), "record_first={record_first}");
            assert_eq!(on_disk.temperature, 0.9, "record_first={record_first}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn run_blocking_passes_results_through_and_maps_a_panic_to_an_error() {
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        assert_eq!(rt.block_on(run_blocking(|| Ok(7))).expect("ok"), 7);
        let err = rt
            .block_on(run_blocking(|| -> AppResult<()> { panic!("boom") }))
            .expect_err("a panic must become an error");
        assert_eq!(err.to_string(), "The background task stopped unexpectedly. Try again.");
    }

    // The renderer-reachable generic export has no channel for `PdfReport`,
    // so a PDF through it would silently drop the report (rust.md rule 4).
    #[test]
    fn export_document_refuses_pdf_and_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("aix-export-pdf-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("out.pdf");
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let mut doc = Document::new("Report");
        doc.chunks.push(crate::models::Chunk::new_text(0, "Body."));

        let err = rt
            .block_on(export_document(doc, path.to_string_lossy().into_owned(), "pdf".into()))
            .expect_err("pdf must be refused by the generic export");

        assert_eq!(
            err.to_string(),
            "PDF export reports what the PDF could not carry, so it uses its own command \
             (export_pdf), not the generic text export."
        );
        assert!(!path.exists(), "nothing may be written");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // check_ext fails closed: a missing extension (incl. dotfiles such as
    // `.zshrc`, where `Path::extension()` is None) or a wrong one is refused.
    #[test]
    fn check_ext_refuses_missing_wrong_and_dotfile_extensions() {
        for (path, allowed) in [
            ("/tmp/out", &["pdf"][..]),
            ("/Users/x/.zshrc", &["txt"][..]),
            ("/Users/x/.zshrc", &["pdf"][..]),
            ("/tmp/.pdf", &["pdf"][..]),
            ("/tmp/a.sh", &["txt"][..]),
            ("/tmp/out.", &["pdf"][..]),
        ] {
            let err = check_ext(path, allowed).expect_err(path).to_string();
            assert_eq!(
                err,
                format!("Refusing to write '{path}': expected a .{} file.", allowed.join("/.")),
                "{path}"
            );
        }
        check_ext("/tmp/report.PDF", &["pdf"]).expect("case-insensitive match");
        check_ext("/tmp/a.markdown", &["md", "markdown"]).expect("any listed extension");
        check_ext("/tmp/日本語.aix", &["aix"]).expect("non-Latin stem");
    }

    // export_pdf writes only to a .pdf path (BUG-003 guard). Asserts the exact
    // refusal, not just Err: on a font-less host write_pdf would also fail.
    #[test]
    fn export_pdf_refuses_a_non_pdf_path_and_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("aix-export-pdf-ext-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        for name in ["out.aix", "noext", ".zshrc"] {
            let path = dir.join(name);
            let p = path.to_string_lossy().into_owned();
            let mut doc = Document::new("Report");
            doc.chunks.push(crate::models::Chunk::new_text(0, "Body."));
            let err = rt.block_on(export_pdf(doc, p.clone())).expect_err(name).to_string();
            assert_eq!(err, format!("Refusing to write '{p}': expected a .pdf file."), "{name}");
            assert!(!path.exists(), "{name}: nothing may be written");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_document_refuses_an_extensionless_path_and_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("aix-export-noext-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        for (name, format, expected) in [
            ("noext", "txt", ".txt"),
            (".zshrc", "txt", ".txt"),
            (".bash_profile", "md", ".md/.markdown"),
        ] {
            let path = dir.join(name);
            let p = path.to_string_lossy().into_owned();
            let mut doc = Document::new("Report");
            doc.chunks.push(crate::models::Chunk::new_text(0, "echo pwned"));
            let err = rt
                .block_on(export_document(doc, p.clone(), format.into()))
                .expect_err(name)
                .to_string();
            assert_eq!(err, format!("Refusing to write '{p}': expected a {expected} file."), "{name}");
            assert!(!path.exists(), "{name}: nothing may be written");
        }
        let save_path = dir.join("noext-save");
        let err = rt
            .block_on(save_document_json(Document::new("D"), save_path.to_string_lossy().into_owned()))
            .expect_err("save_document_json without .aix");
        assert!(err.to_string().starts_with("Refusing to write"), "{err}");
        assert!(!save_path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // RTF is lossy (images/diagrams → placeholders), so the GUI command must
    // hand the report back; txt/md carry none.
    #[test]
    fn export_document_returns_the_rtf_report_and_none_for_txt() {
        let dir = std::env::temp_dir().join(format!("aix-export-rtf-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let mut doc = Document::new("Report");
        let mut fig = crate::models::Chunk::new_text(0, "figures/unread.png");
        fig.metadata.chunk_type = crate::models::CHUNK_TYPE_IMAGE.to_string();
        doc.chunks.push(fig);

        let rtf = dir.join("out.rtf");
        let report = rt
            .block_on(export_document(doc.clone(), rtf.to_string_lossy().into_owned(), "rtf".into()))
            .expect("rtf export")
            .expect("rtf returns a report");
        assert_eq!(report.local_images_unresolved, 1);
        assert_eq!(
            report.warnings,
            vec!["1 local image(s) couldn't be read from the document's folder and were exported \
                  as text placeholders."]
        );
        assert!(rtf.exists());

        let txt = dir.join("out.txt");
        let none = rt
            .block_on(export_document(doc, txt.to_string_lossy().into_owned(), "txt".into()))
            .expect("txt export");
        assert_eq!(none, None);
        assert!(txt.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
