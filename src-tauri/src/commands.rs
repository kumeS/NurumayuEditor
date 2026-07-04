//! Tauri command surface — the only entry points the frontend can invoke.
//!
//! These are plain application commands (not plugin commands), so they do not
//! require capability/ACL grants; registering them in `generate_handler!` is
//! sufficient. The API key is read here on the Rust side and never crosses to
//! the frontend.

use crate::ai::{self, AiRequest, LlmConfig};
use crate::deck;
use crate::error::{AppError, AppResult};
use crate::fileio;
use crate::imageio;
use crate::models::{AnalysisResult, Document};
use crate::pptx;
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
