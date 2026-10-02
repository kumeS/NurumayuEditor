//! Native application menu mirroring the in-app toolbar.
//!
//! Custom items emit a `"menu"` event whose payload is the item id; the frontend
//! dispatches each to the SAME handler as the toolbar, so the native menu bar
//! and the in-app UI stay consistent. Clipboard and window items use native
//! predefined behaviour. Custom items deliberately carry NO accelerators — the
//! keyboard shortcuts are owned by the frontend (`useShortcuts`), so there is no
//! double-firing; the menu adds click parity and discoverability.
//!
//! Labels follow the Settings "Default language": the menu is built with the
//! saved language at startup and rebuilt (`set_menu_language`) when it changes,
//! so the native menu bar never disagrees with the in-app chrome. Only the
//! custom items are translated — `about`/`hide`/`minimize` and the clipboard
//! items are macOS predefined items, which the OS already localises itself.

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Manager, Runtime};

/// Japanese copy for every custom menu label. Keys are the English label, so an
/// untranslated entry degrades to English rather than vanishing.
const JA: &[(&str, &str)] = &[
    ("Settings…", "設定…"),
    ("Quit NurumayuEditor", "NurumayuEditorを終了"),
    ("File", "ファイル"),
    ("New Tab", "新しいタブ"),
    ("Open…", "開く…"),
    ("Open Folder…", "フォルダを開く…"),
    ("Save", "保存"),
    ("Save As…", "別名で保存…"),
    ("Import…", "読み込み…"),
    ("Export", "書き出し"),
    ("Export as .txt", ".txt で書き出し"),
    ("Export as .md", ".md で書き出し"),
    ("Export as .rtf", ".rtf で書き出し"),
    ("Export as .pptx", ".pptx で書き出し"),
    ("Export as .pdf", ".pdf で書き出し"),
    ("Edit", "編集"),
    ("Undo", "元に戻す"),
    ("Redo", "やり直す"),
    ("Find…", "検索…"),
    ("Find and Replace…", "検索と置換…"),
    ("Find Next", "次を検索"),
    ("Find Previous", "前を検索"),
    ("Go to Line…", "行へ移動…"),
    ("Close Tab", "タブを閉じる"),
    ("Draft a document by AI…", "AIで文書を下書き…"),
    ("Analyze relationships", "関係を分析"),
    ("Window", "ウインドウ"),
    ("Help", "ヘルプ"),
    ("How to write (workflow guide)…", "書き方ガイド(ワークフロー)…"),
];

/// True when the configured default language means "render the UI in Japanese".
/// Mirrors the frontend's `uiLangFor` (src/i18n.ts) — the two must agree, or the
/// menu bar and the in-app chrome would end up in different languages.
pub fn is_japanese(language: &str) -> bool {
    language == "日本語"
}

/// Translate one menu label for `language`; unknown keys fall back to English.
fn label(language: &str, key: &'static str) -> &'static str {
    if !is_japanese(language) {
        return key;
    }
    JA.iter()
        .find(|(en, _)| *en == key)
        .map(|(_, ja)| *ja)
        .unwrap_or(key)
}

pub fn build<R: Runtime, M: Manager<R>>(app: &M, language: &str) -> tauri::Result<Menu<R>> {
    let l = |key: &'static str| label(language, key);
    // App menu (shows as the app menu on macOS).
    let settings = MenuItemBuilder::with_id("settings", l("Settings…")).build(app)?;
    // Custom Quit (NOT the predefined .quit()) so it emits "menu"→"quit" and the
    // frontend can run the unsaved-changes guard before the app exits. It keeps
    // the conventional Cmd+Q accelerator; there is no frontend Cmd+Q shortcut, so
    // it does not double-fire.
    let quit = MenuItemBuilder::with_id("quit", l("Quit NurumayuEditor"))
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "NurumayuEditor")
        .about(Some(AboutMetadata {
            name: Some("NurumayuEditor".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            copyright: Some(
                "Copyright (c) 2026 Satoshi Kume. Artistic License 2.0.".into(),
            ),
            ..Default::default()
        }))
        .separator()
        .item(&settings)
        .separator()
        .hide()
        .separator()
        .item(&quit)
        .build()?;

    // File
    let new_tab = MenuItemBuilder::with_id("new_tab", l("New Tab")).build(app)?;
    let open = MenuItemBuilder::with_id("open", l("Open…")).build(app)?;
    let open_folder = MenuItemBuilder::with_id("open_folder", l("Open Folder…")).build(app)?;
    let save = MenuItemBuilder::with_id("save", l("Save")).build(app)?;
    let save_as = MenuItemBuilder::with_id("save_as", l("Save As…")).build(app)?;
    // ⌘W stays a frontend shortcut (no accelerator), like every custom item.
    let close_tab = MenuItemBuilder::with_id("close_tab", l("Close Tab")).build(app)?;
    let import = MenuItemBuilder::with_id("import", l("Import…")).build(app)?;
    let export_txt = MenuItemBuilder::with_id("export_txt", l("Export as .txt")).build(app)?;
    let export_md = MenuItemBuilder::with_id("export_md", l("Export as .md")).build(app)?;
    let export_rtf = MenuItemBuilder::with_id("export_rtf", l("Export as .rtf")).build(app)?;
    let export_pptx = MenuItemBuilder::with_id("export_pptx", l("Export as .pptx")).build(app)?;
    let export_pdf = MenuItemBuilder::with_id("export_pdf", l("Export as .pdf")).build(app)?;
    let export = SubmenuBuilder::new(app, l("Export"))
        .item(&export_txt)
        .item(&export_md)
        .item(&export_rtf)
        .item(&export_pptx)
        .item(&export_pdf)
        .build()?;
    let file_menu = SubmenuBuilder::new(app, l("File"))
        .item(&new_tab)
        .item(&open)
        .item(&open_folder)
        .item(&save)
        .item(&save_as)
        .item(&close_tab)
        .separator()
        .item(&import)
        .item(&export)
        .build()?;

    // Edit — Undo/Redo are routed to the app's own history; clipboard is native.
    let undo = MenuItemBuilder::with_id("undo", l("Undo")).build(app)?;
    let redo = MenuItemBuilder::with_id("redo", l("Redo")).build(app)?;
    // Find (BUG-010): the docked find bar. Shortcuts (⌘F, ⌥⌘F, ⌘G, ⇧⌘G, ⌘L)
    // are frontend-owned, so these items carry no accelerators either.
    let find = MenuItemBuilder::with_id("find", l("Find…")).build(app)?;
    let find_replace = MenuItemBuilder::with_id("find_replace", l("Find and Replace…")).build(app)?;
    let find_next = MenuItemBuilder::with_id("find_next", l("Find Next")).build(app)?;
    let find_previous = MenuItemBuilder::with_id("find_previous", l("Find Previous")).build(app)?;
    let go_to_line = MenuItemBuilder::with_id("go_to_line", l("Go to Line…")).build(app)?;
    let edit_menu = SubmenuBuilder::new(app, l("Edit"))
        .item(&undo)
        .item(&redo)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find)
        .item(&find_replace)
        .item(&find_next)
        .item(&find_previous)
        .item(&go_to_line)
        .build()?;

    // AI
    let draft = MenuItemBuilder::with_id("draft", l("Draft a document by AI…")).build(app)?;
    let analyze = MenuItemBuilder::with_id("analyze", l("Analyze relationships")).build(app)?;
    let ai_menu = SubmenuBuilder::new(app, "AI")
        .item(&draft)
        .item(&analyze)
        .build()?;

    // Window
    let window_menu = SubmenuBuilder::new(app, l("Window"))
        .minimize()
        .separator()
        .close_window()
        .build()?;

    // Help — links to the in-app workflow guide.
    let help_guide = MenuItemBuilder::with_id("help", l("How to write (workflow guide)…")).build(app)?;
    let help_menu = SubmenuBuilder::new(app, l("Help")).item(&help_guide).build()?;

    MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &ai_menu,
            &window_menu,
            &help_menu,
        ])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn japanese_is_detected_only_for_the_japanese_language_name() {
        assert!(is_japanese("日本語"));
        assert!(!is_japanese("English"));
        assert!(!is_japanese(""));
        assert!(!is_japanese("中文"));
    }

    #[test]
    fn labels_are_english_verbatim_for_non_japanese_languages() {
        assert_eq!(label("English", "Save As…"), "Save As…");
        assert_eq!(label("Français", "Open Folder…"), "Open Folder…");
    }

    #[test]
    fn labels_are_translated_for_japanese() {
        assert_eq!(label("日本語", "Save As…"), "別名で保存…");
        assert_eq!(label("日本語", "Open Folder…"), "フォルダを開く…");
    }

    /// BUG-010: the Edit menu's find items and File → Close Tab follow the
    /// language setting like every other custom item.
    #[test]
    fn edit_menu_find_labels_are_translated() {
        assert_eq!(label("日本語", "Find…"), "検索…");
        assert_eq!(label("日本語", "Find and Replace…"), "検索と置換…");
        assert_eq!(label("日本語", "Find Next"), "次を検索");
        assert_eq!(label("日本語", "Find Previous"), "前を検索");
        assert_eq!(label("日本語", "Go to Line…"), "行へ移動…");
        assert_eq!(label("日本語", "Close Tab"), "タブを閉じる");
    }

    /// The find items and Close Tab are built (ids the frontend dispatches) and
    /// carry no accelerator: ⌘F/⌘G/⌘L/⌘W belong to the frontend shortcuts, so a
    /// menu key equivalent would fire them twice.
    #[test]
    fn find_items_and_close_tab_are_built_without_accelerators() {
        let source = include_str!("menu.rs");
        let source = source.split("#[cfg(test)]").next().unwrap_or(source);
        for id in ["find", "find_replace", "find_next", "find_previous", "go_to_line", "close_tab"] {
            let needle = format!("with_id(\"{id}\"");
            let at = source
                .find(&needle)
                .unwrap_or_else(|| panic!("menu item {id} is not built"));
            let stmt = &source[at..at + source[at..].find(';').unwrap_or(0)];
            assert!(!stmt.contains("accelerator"), "{id} must not carry an accelerator");
        }
    }

    #[test]
    fn an_untranslated_key_falls_back_to_english_rather_than_disappearing() {
        assert_eq!(label("日本語", "Some Future Menu Item"), "Some Future Menu Item");
    }

    /// The menu's promise is "every custom item follows the language setting";
    /// a new item with no JA entry would silently stay English in a Japanese
    /// menu bar, so keep the table and the builder in step.
    #[test]
    fn every_custom_menu_label_used_by_build_has_a_japanese_entry() {
        // Scan only the builder half of this file: the test module below
        // contains the same `, l("` literal and would match itself.
        let source = include_str!("menu.rs");
        let source = source.split("#[cfg(test)]").next().unwrap_or(source);
        let mut missing = Vec::new();
        // Only the builder's own alias — `, l("…")` — never `label("…")` from
        // these tests, which would otherwise match a bare `l("` search.
        for part in source.split(", l(\"").skip(1) {
            if let Some(key) = part.split("\")").next() {
                if key.is_empty() {
                    continue;
                }
                if !JA.iter().any(|(en, _)| *en == key) {
                    missing.push(key.to_string());
                }
            }
        }
        assert!(missing.is_empty(), "menu labels with no Japanese entry: {missing:?}");
    }
}
