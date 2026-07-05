//! User settings + secure API-key storage.
//!
//! - Non-secret settings (endpoint, model, temperature, default target language)
//!   are persisted as JSON under the app config directory.
//! - The OpenRouter API key is stored in the OS-native secret store via `keyring`
//!   (macOS Keychain / Windows Credential Manager / Linux Secret Service). It is
//!   never written to disk in plaintext and never serialized to the frontend.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::Path;

// Kept as com.aix.texteditor across the NurumayuFacet rebrand on purpose: this
// keychain service id is invisible to users; changing it (like the matching
// bundle identifier in tauri.conf.json) would strand every existing user's
// stored API key. The rebrand is display-only, so internal ids stay put and
// no migration is needed.
pub const KEYRING_SERVICE: &str = "com.aix.texteditor";
pub const KEYRING_ACCOUNT: &str = "openrouter-api-key";
pub const SETTINGS_FILE: &str = "settings.json";

pub const DEFAULT_ENDPOINT: &str = "https://openrouter.ai/api/v1/chat/completions";
/// The default text model. Model availability on OpenRouter changes over time,
/// so this is fully overridable from the Settings screen.
pub const DEFAULT_MODEL: &str = "deepseek/deepseek-v4-flash";

/// Default image-generation model. NOTE: image model ids change over time on
/// OpenRouter — these are starting points, fully editable from Settings.
pub const DEFAULT_IMAGE_MODEL: &str = "google/gemini-2.5-flash-image";

/// Starter list of selectable text models. Users add/remove their own from
/// Settings; ids may change over time on OpenRouter, so the list is editable.
fn default_models() -> Vec<String> {
    vec![
        DEFAULT_MODEL.to_string(), // deepseek/deepseek-v4-flash (default)
        "qwen/qwen3.6-flash".to_string(),
        "meta-llama/llama-4-maverick".to_string(),
        "moonshotai/kimi-k2.5".to_string(),
        "google/gemma-4-31b-it:free".to_string(),
        "meta-llama/llama-3.3-70b-instruct:free".to_string(),
        "deepseek/deepseek-r1:free".to_string(),
    ]
}

fn default_image_model() -> String {
    DEFAULT_IMAGE_MODEL.to_string()
}

/// Starter list of image-generation models (e.g. Google "Nano Banana"). Verify
/// the exact ids on openrouter.ai/models — edit/add from Settings.
fn default_image_models() -> Vec<String> {
    vec![
        DEFAULT_IMAGE_MODEL.to_string(), // Nano Banana (Gemini 2.5 Flash Image)
        "x-ai/grok-imagine-image-quality".to_string(),
        "recraft/recraft-v4-pro".to_string(),
        "openai/gpt-5.4-image-2".to_string(),
        "black-forest-labs/flux.2-klein-4b".to_string(),
        "google/gemini-3-pro-image-preview".to_string(), // Nano Banana Pro (verify id)
    ]
}

/// Default writing tone (empty = the AI's neutral academic default). The
/// Settings screen offers a small set of presets (blog / memo / report /
/// scientific / academic-paper); the chosen tone is applied to every writing
/// action so the whole document keeps a consistent voice.
fn default_writing_tone() -> String {
    String::new()
}

/// Default editor body font family. One of "serif" | "sans" | "mono";
/// anything else is reset to "serif" on load.
fn default_editor_font_family() -> String {
    "serif".to_string()
}

/// Default editor body font size in px. Clamped to 12..=28 on load.
fn default_editor_font_size() -> u32 {
    17
}

/// Map a locale string (`ja_JP`, `en_US.UTF-8`, `zh-Hans-CN`, …) to the display
/// name used for the default output language, or `None` when the language code
/// isn't one we pre-translate. Pure so it's unit-testable.
fn language_from_locale(locale: &str) -> Option<&'static str> {
    let loc = locale.trim().to_lowercase();
    let lang = loc.split(['_', '.', '-']).next().unwrap_or("");
    match lang {
        "en" => Some("English"),
        "ja" => Some("日本語"),
        "zh" => Some("中文"),
        "ko" => Some("한국어"),
        "es" => Some("Español"),
        "fr" => Some("Français"),
        "de" => Some("Deutsch"),
        "pt" => Some("Português"),
        "it" => Some("Italiano"),
        "ru" => Some("Русский"),
        "ar" => Some("العربية"),
        _ => None,
    }
}

/// Read a global macOS user default via the `defaults` CLI, e.g.
/// `defaults read -g AppleLocale` → `ja_JP`.
#[cfg(target_os = "macos")]
fn macos_defaults_read(key: &str) -> Option<String> {
    let out = std::process::Command::new("defaults")
        .args(["read", "-g", key])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Best-effort default output language from the OS locale, so a Japanese (or
/// other non-English) user isn't forced to English out of the box. Used only
/// for a fresh install; fully overridable in Settings. Falls back to English.
///
/// Env vars (LANG/LC_*) are checked first, but a Finder/Dock launch on macOS
/// inherits launchd's environment, which sets none of them — so when they
/// yield no match we ask the system preferences via `defaults read`.
fn default_language() -> String {
    let loc = std::env::var("LANG")
        .or_else(|_| std::env::var("LC_ALL"))
        .or_else(|_| std::env::var("LC_MESSAGES"))
        .unwrap_or_default();
    if let Some(lang) = language_from_locale(&loc) {
        return lang.to_string();
    }
    #[cfg(target_os = "macos")]
    {
        // `AppleLocale` is a plain locale string (`ja_JP`).
        if let Some(lang) = macos_defaults_read("AppleLocale")
            .as_deref()
            .and_then(language_from_locale)
        {
            return lang.to_string();
        }
        // `AppleLanguages` prints a plist array like `(\n    "ja-JP",\n …)`;
        // the first quoted entry is the user's preferred language.
        if let Some(lang) = macos_defaults_read("AppleLanguages")
            .as_deref()
            .and_then(|s| s.split('"').nth(1))
            .and_then(language_from_locale)
        {
            return lang.to_string();
        }
    }
    "English".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub endpoint: String,
    /// The active text model id used for requests.
    pub model: String,
    /// The user's selectable text-model list. `#[serde(default)]` keeps older
    /// settings files (without this field) loadable.
    #[serde(default = "default_models")]
    pub models: Vec<String>,
    /// The active image-generation model id.
    #[serde(default = "default_image_model")]
    pub image_model: String,
    /// The user's selectable image-model list.
    #[serde(default = "default_image_models")]
    pub image_models: Vec<String>,
    /// The default output language for ALL AI actions (translate target plus the
    /// language every other action writes its result in). Surfaced in Settings as
    /// "Default language" — see the prompt assembly in `ai.rs`.
    pub default_target_language: String,
    /// The global writing tone applied to writing actions (proofread/expand/…
    /// and drafts). `#[serde(default)]` keeps older settings files loadable.
    #[serde(default = "default_writing_tone")]
    pub writing_tone: String,
    pub temperature: f32,
    /// Built-in default model ids the user explicitly removed. Without this
    /// tombstone list, `merge_default_models` would resurrect a deleted
    /// built-in on every load.
    #[serde(default)]
    pub removed_models: Vec<String>,
    /// Editor body font family: "serif" | "sans" | "mono".
    #[serde(default = "default_editor_font_family")]
    pub editor_font_family: String,
    /// Editor body font size in px (12..=28).
    #[serde(default = "default_editor_font_size")]
    pub editor_font_size: u32,
    /// Ghost-text inline completion (開発.txt Stage 2, item 2-4): when true,
    /// only fire a completion request when the configured endpoint is a local
    /// one (see `commands::is_local_endpoint`) — a real privacy preference,
    /// not a cosmetic toggle, so ghost-text is simply skipped rather than
    /// silently sent to a remote endpoint when this is on but the endpoint
    /// isn't local. Off by default (opt-in), like every other auto-picked
    /// behaviour in this app's Settings. `#[serde(default)]` keeps older
    /// settings files (without this field) loadable.
    #[serde(default)]
    pub limit_completion_to_local_model: bool,
    /// Grant-application beachhead (開発.txt Stage 2, item 2-1): a GLOBAL,
    /// user-configurable character-limit warning threshold — "warn me when
    /// any paragraph exceeds N characters". Generic (useful for any
    /// length-constrained writing, not just grant forms specifically); this
    /// project does NOT bundle any real institutional form's actual limits
    /// (that bundling decision is explicitly unresolved — see 開発.txt §9).
    /// `None` (the default) means the feature is off — the frontend shows no
    /// extra UI until the user opts in. Per-chunk character counts themselves
    /// are computed live from `chunk.content` on the frontend (CJK-aware via
    /// `Array.from(...).length`); nothing about the count is persisted here,
    /// only the threshold. `#[serde(default, skip_serializing_if =
    /// "Option::is_none")]` keeps older settings files loadable and keeps a
    /// never-configured limit out of the saved JSON entirely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub char_limit_warning: Option<u32>,
    /// Personal RAG (開発.txt Stage 3, item 3-1): opt-in to grounding AI
    /// writing/revision actions against the user's own local knowledge base
    /// of past papers/notes (`rag.rs`, fully on-device — embedding, indexing,
    /// and search never leave the machine). Off by default, matching this
    /// app's "auto-picked behaviour starts off" tone: this setting alone does
    /// not create the index or download the embedding model — both are
    /// lazily initialized on the FIRST add-source or search call made while
    /// this is true (see `rag::Index::open` and its callers in
    /// `commands.rs`), so leaving this off costs nothing at all, forever.
    /// `#[serde(default)]` keeps older settings files (without this field)
    /// loadable.
    #[serde(default)]
    pub personal_rag_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            endpoint: DEFAULT_ENDPOINT.to_string(),
            model: DEFAULT_MODEL.to_string(),
            models: default_models(),
            image_model: default_image_model(),
            image_models: default_image_models(),
            default_target_language: default_language(),
            writing_tone: default_writing_tone(),
            temperature: 0.3,
            removed_models: Vec::new(),
            editor_font_family: default_editor_font_family(),
            editor_font_size: default_editor_font_size(),
            limit_completion_to_local_model: false,
            char_limit_warning: None,
            personal_rag_enabled: false,
        }
    }
}

impl Settings {
    /// Load settings from `<config_dir>/settings.json`, falling back to defaults
    /// when the file is absent. A file that exists but fails to parse is backed
    /// up to `settings.json.bak` (instead of being silently overwritten on the
    /// next save) so a hand-edit typo can't destroy the user's configuration.
    pub fn load(config_dir: &Path) -> Self {
        let path = config_dir.join(SETTINGS_FILE);
        let mut settings = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Settings>(&text) {
                Ok(s) => s,
                Err(e) => {
                    let bak = path.with_extension("json.bak");
                    let _ = std::fs::remove_file(&bak); // overwrite an older backup
                    let _ = std::fs::rename(&path, &bak);
                    eprintln!(
                        "settings: {SETTINGS_FILE} is corrupt ({e}); backed up to {} and using defaults",
                        bak.display()
                    );
                    Settings::default()
                }
            },
            // Missing (or unreadable) file: first run, use defaults.
            Err(_) => Settings::default(),
        };
        // Existing users have a saved `models`/`imageModels` list, so serde keeps
        // that list and the new built-in defaults never appear. Merge in any
        // pre-registered model that's missing, preserving the user's own
        // additions and ordering.
        settings.merge_default_models();
        settings.sanitize();
        settings
    }

    /// Append any built-in default model that isn't already in the list,
    /// skipping ids the user explicitly removed (see `removed_models`).
    fn merge_default_models(&mut self) {
        for m in default_models() {
            if !self.removed_models.contains(&m) && !self.models.iter().any(|x| x == &m) {
                self.models.push(m);
            }
        }
        for m in default_image_models() {
            if !self.removed_models.contains(&m) && !self.image_models.iter().any(|x| x == &m) {
                self.image_models.push(m);
            }
        }
    }

    /// Coerce out-of-range values (e.g. from a hand-edited file) back to safe
    /// ones so the editor never renders with an unusable font.
    fn sanitize(&mut self) {
        self.editor_font_size = self.editor_font_size.clamp(12, 28);
        if !matches!(self.editor_font_family.as_str(), "serif" | "sans" | "mono") {
            self.editor_font_family = default_editor_font_family();
        }
    }

    /// Written atomically (temp + rename, same pattern as the session autosave)
    /// so a crash mid-write can't corrupt the settings file.
    pub fn save(&self, config_dir: &Path) -> AppResult<()> {
        std::fs::create_dir_all(config_dir)?;
        let path = config_dir.join(SETTINGS_FILE);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }
}

// ----- OS keychain helpers -------------------------------------------------

fn entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(AppError::from)
}

pub fn set_api_key(key: &str) -> AppResult<()> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return delete_api_key();
    }
    entry()?.set_password(trimmed)?;
    Ok(())
}

pub fn get_api_key() -> AppResult<Option<String>> {
    match entry()?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

pub fn delete_api_key() -> AppResult<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Unique per-test temp config dir (std-only; removed by each test).
    fn temp_config_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aix-settings-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn corrupt_file_is_backed_up_and_defaults_returned() {
        let dir = temp_config_dir("corrupt");
        let path = dir.join(SETTINGS_FILE);
        std::fs::write(&path, "{ not valid json !!!").unwrap();

        let settings = Settings::load(&dir);
        assert_eq!(settings.endpoint, DEFAULT_ENDPOINT);
        assert_eq!(settings.model, DEFAULT_MODEL);

        let bak = dir.join("settings.json.bak");
        assert!(bak.exists(), "corrupt file should be renamed to .bak");
        assert!(!path.exists(), "corrupt original should be gone");
        assert_eq!(
            std::fs::read_to_string(&bak).unwrap(),
            "{ not valid json !!!"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_file_returns_defaults_without_backup() {
        let dir = temp_config_dir("missing");
        let settings = Settings::load(&dir);
        assert_eq!(settings.endpoint, DEFAULT_ENDPOINT);
        assert!(!dir.join("settings.json.bak").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_is_atomic_valid_json_and_leaves_no_tmp() {
        let dir = temp_config_dir("save");
        let settings = Settings::default();
        settings.save(&dir).unwrap();

        let text = std::fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap();
        let reparsed: Settings = serde_json::from_str(&text).unwrap();
        assert_eq!(reparsed.endpoint, settings.endpoint);
        // camelCase JSON keys per the frontend schema contract.
        assert!(text.contains("\"removedModels\""), "got: {text}");
        assert!(text.contains("\"editorFontFamily\""), "got: {text}");
        assert!(text.contains("\"editorFontSize\""), "got: {text}");
        assert!(!dir.join("settings.json.tmp").exists(), ".tmp left behind");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn merge_skips_tombstoned_default_models() {
        let mut settings = Settings::default();
        settings.models.clear();
        settings.image_models.clear();
        settings.removed_models = vec![
            DEFAULT_MODEL.to_string(),
            DEFAULT_IMAGE_MODEL.to_string(),
        ];
        settings.merge_default_models();
        assert!(
            !settings.models.iter().any(|m| m == DEFAULT_MODEL),
            "tombstoned text model resurrected"
        );
        assert!(
            !settings.image_models.iter().any(|m| m == DEFAULT_IMAGE_MODEL),
            "tombstoned image model resurrected"
        );
        // Non-tombstoned defaults still merge in.
        assert!(settings.models.iter().any(|m| m == "qwen/qwen3.6-flash"));
    }

    #[test]
    fn language_from_locale_maps_known_codes() {
        assert_eq!(language_from_locale("ja_JP"), Some("日本語"));
        assert_eq!(language_from_locale("en_US.UTF-8"), Some("English"));
        assert_eq!(language_from_locale("zh-Hans-CN"), Some("中文"));
        assert_eq!(language_from_locale("ko_KR.UTF-8"), Some("한국어"));
        assert_eq!(language_from_locale("FR_fr"), Some("Français"));
    }

    #[test]
    fn language_from_locale_rejects_junk() {
        assert_eq!(language_from_locale(""), None);
        assert_eq!(language_from_locale("C"), None);
        assert_eq!(language_from_locale("POSIX"), None);
        assert_eq!(language_from_locale("xx_YY"), None);
    }

    #[test]
    fn load_clamps_font_size_and_resets_unknown_family() {
        let dir = temp_config_dir("fonts");
        let mut settings = Settings::default();
        settings.editor_font_size = 99;
        settings.editor_font_family = "comic-sans".to_string();
        settings.save(&dir).unwrap();
        let loaded = Settings::load(&dir);
        assert_eq!(loaded.editor_font_size, 28);
        assert_eq!(loaded.editor_font_family, "serif");

        settings.editor_font_size = 1;
        settings.editor_font_family = "mono".to_string();
        settings.save(&dir).unwrap();
        let loaded = Settings::load(&dir);
        assert_eq!(loaded.editor_font_size, 12);
        assert_eq!(loaded.editor_font_family, "mono");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn limit_completion_to_local_model_round_trips_and_defaults_false() {
        let dir = temp_config_dir("ghost-toggle");

        // Back-compat: an old settings file written before this field existed
        // has no such key at all — it must load as `false`, not fail to parse.
        std::fs::write(
            dir.join(SETTINGS_FILE),
            r#"{"endpoint":"https://openrouter.ai/api/v1/chat/completions","model":"m","defaultTargetLanguage":"English","temperature":0.3}"#,
        )
        .unwrap();
        let loaded = Settings::load(&dir);
        assert!(!loaded.limit_completion_to_local_model);

        // Explicitly set true, save, reload — the value round-trips.
        let mut settings = loaded;
        settings.limit_completion_to_local_model = true;
        settings.save(&dir).unwrap();
        let reloaded = Settings::load(&dir);
        assert!(reloaded.limit_completion_to_local_model);

        // camelCase JSON key per the frontend schema contract.
        let text = std::fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap();
        assert!(text.contains("\"limitCompletionToLocalModel\""), "got: {text}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn char_limit_warning_round_trips_and_defaults_to_unset() {
        let dir = temp_config_dir("char-limit");

        // Back-compat: an old settings file written before this field existed
        // has no such key at all — it must load as `None`, not fail to parse.
        std::fs::write(
            dir.join(SETTINGS_FILE),
            r#"{"endpoint":"https://openrouter.ai/api/v1/chat/completions","model":"m","defaultTargetLanguage":"English","temperature":0.3}"#,
        )
        .unwrap();
        let loaded = Settings::load(&dir);
        assert_eq!(loaded.char_limit_warning, None);

        // A fresh Default::default() is also unset.
        assert_eq!(Settings::default().char_limit_warning, None);

        // Explicitly set, save, reload — the value round-trips.
        let mut settings = loaded;
        settings.char_limit_warning = Some(800);
        settings.save(&dir).unwrap();
        let reloaded = Settings::load(&dir);
        assert_eq!(reloaded.char_limit_warning, Some(800));

        // camelCase JSON key per the frontend schema contract.
        let text = std::fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap();
        assert!(text.contains("\"charLimitWarning\": 800"), "got: {text}");

        // Clearing it back to None removes the key from the saved JSON
        // (skip_serializing_if) rather than writing a literal `null`.
        settings.char_limit_warning = None;
        settings.save(&dir).unwrap();
        let text = std::fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap();
        assert!(!text.contains("charLimitWarning"), "got: {text}");
        let reloaded = Settings::load(&dir);
        assert_eq!(reloaded.char_limit_warning, None);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn personal_rag_enabled_round_trips_and_defaults_false() {
        let dir = temp_config_dir("personal-rag-toggle");

        // Back-compat: an old settings file written before this field existed
        // has no such key at all — it must load as `false`, not fail to parse.
        std::fs::write(
            dir.join(SETTINGS_FILE),
            r#"{"endpoint":"https://openrouter.ai/api/v1/chat/completions","model":"m","defaultTargetLanguage":"English","temperature":0.3}"#,
        )
        .unwrap();
        let loaded = Settings::load(&dir);
        assert!(!loaded.personal_rag_enabled);

        // A fresh Default::default() is also off.
        assert!(!Settings::default().personal_rag_enabled);

        // Explicitly set true, save, reload — the value round-trips.
        let mut settings = loaded;
        settings.personal_rag_enabled = true;
        settings.save(&dir).unwrap();
        let reloaded = Settings::load(&dir);
        assert!(reloaded.personal_rag_enabled);

        // camelCase JSON key per the frontend schema contract.
        let text = std::fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap();
        assert!(text.contains("\"personalRagEnabled\": true"), "got: {text}");

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
