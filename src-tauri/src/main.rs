// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Headless CLI (Agent Experience): if invoked with a known subcommand, run it
    // and exit instead of launching the GUI. A bare launch (no args) falls through.
    if let Some(code) = nurumayueditor_lib::cli::try_run() {
        std::process::exit(code);
    }
    nurumayueditor_lib::run()
}
