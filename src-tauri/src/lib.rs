//! NurumayuEditor — Tauri backend entry point.

mod ai;
pub mod cli;
mod citations;
mod commands;
mod deck;
mod error;
mod fileio;
mod imageio;
mod mcp;
mod menu;
mod models;
mod net;
mod pdf;
mod pptx;
mod rag;
mod settings;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|_window, _event| {
            // macOS: the red close button HIDES the window and vetoes the close,
            // so the app keeps running (re-shown from the Dock via Reopen below).
            // Owning this in Rust — rather than a frontend onCloseRequested
            // listener — avoids a startup race where the window is destroyed
            // before JS is ready, which on macOS quits the whole app.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                api.prevent_close();
                let _ = _window.hide();
            }
        })
        .setup(|app| {
            // Native menu mirroring the toolbar; custom items emit a "menu" event.
            // Built with the saved "Default language" so the menu bar matches
            // the in-app chrome from the first frame (Settings rebuilds it via
            // `set_menu_language` when the user changes languages).
            let language = app
                .path()
                .app_config_dir()
                .map(|dir| settings::Settings::load(&dir).default_target_language)
                .unwrap_or_default();
            let menu = menu::build(app, &language)?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let _ = app.emit("menu", event.id().0.clone());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_document,
            commands::export_document,
            commands::export_pptx,
            commands::save_document_json,
            commands::open_document_json,
            commands::list_directory,
            commands::set_menu_language,
            commands::get_settings,
            commands::save_settings,
            commands::set_api_key,
            commands::has_api_key,
            commands::delete_api_key,
            commands::get_network_stats,
            commands::ai_process,
            commands::ai_process_stream,
            commands::ai_ghost_complete_stream,
            commands::ai_draft_stream,
            commands::ai_generate_image,
            commands::read_local_image,
            commands::ai_generate_diagram,
            commands::ai_analyze_document,
            commands::read_reference_file,
            commands::fetch_url_text,
            commands::rag_add_source,
            commands::rag_remove_source,
            commands::rag_list_sources,
            commands::rag_search,
            commands::rag_sync_confirmed_chunks,
            commands::citations_import_bibtex,
            commands::citations_list,
            commands::citations_lookup_doi,
            commands::citations_lookup_arxiv,
            commands::citations_add_entry,
            commands::citations_add_lookup_result,
            commands::citations_remove_entry,
            commands::citations_format,
            commands::citations_bibliography,
            commands::speak_text,
            commands::stop_speaking,
            commands::save_session,
            commands::load_session,
            commands::clear_session,
            commands::quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, _event| match _event {
            // Keep the app alive when the last window "closes": an OS/user exit
            // (last window gone) has `code == None` and is vetoed; a programmatic
            // exit — Cmd+Q → quit_app → app.exit(0) — passes `Some(0)` and is
            // allowed through, so real quits still work.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            // Dock-click after the window was hidden: re-show it, or rebuild it
            // from config if it was ever destroyed.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(w) = _app_handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                } else if let Some(cfg) = _app_handle
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|w| w.label == "main")
                    .cloned()
                {
                    let _ = tauri::WebviewWindowBuilder::from_config(_app_handle, &cfg)
                        .and_then(|b| b.build());
                }
            }
            _ => {}
        });
}
