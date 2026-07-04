//! Headless CLI surface — the first slice of the "Agent Experience" (AX) work
//! (report_v2 §10 T2). It lets an agent or CI script drive the document engine
//! WITHOUT the GUI, reusing the exact same pure backend functions the Tauri
//! commands call. This loop covers the offline, network-free operations
//! (inspect, convert, self-describe); the AI verbs (run/analyze/draft) and an
//! MCP wrapper are the documented next-loop extension.
//!
//! Recognized invocations (a non-subcommand first arg returns `None` so a normal
//! GUI launch — which may carry OS-injected args — is never hijacked):
//!   nurumayufacet capabilities            self-describing JSON manifest
//!   nurumayufacet info <file.aix> [--json]  document structure (ids/types/summaries)
//!   nurumayufacet show <file.aix> <chunkId>  print one chunk's raw content
//!   nurumayufacet export <in.aix> <out.{txt,md,rtf,pdf,pptx}>
//!   nurumayufacet help

use crate::models::Document;
use crate::{deck, fileio, imageio, pptx};

const SUBCOMMANDS: &[&str] = &["capabilities", "info", "show", "export", "help", "--help", "-h"];

/// The single source of truth for what `export` accepts — used by BOTH the
/// export dispatch and the capabilities manifest, so the manifest can't drift
/// from reality (it used to claim "pdf" before PDF export existed).
pub const CLI_EXPORT_FORMATS: &[&str] = &["txt", "md", "markdown", "rtf", "pdf", "pptx"];

/// Returns `Some(exit_code)` if the args were a CLI invocation we handled (the
/// caller should then exit), or `None` to fall through to launching the GUI.
pub fn try_run() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first()?;
    if !SUBCOMMANDS.contains(&cmd.as_str()) {
        return None; // not ours — let the GUI start
    }
    let code = match run(cmd, &args[1..]) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("nurumayufacet: {e}");
            1
        }
    };
    Some(code)
}

fn run(cmd: &str, rest: &[String]) -> Result<(), String> {
    match cmd {
        "help" | "--help" | "-h" => {
            print_usage();
            Ok(())
        }
        "capabilities" => {
            println!("{}", capabilities_json());
            Ok(())
        }
        "info" => {
            let path = rest.first().ok_or("info: missing <file.aix>")?;
            let as_json = rest.iter().any(|a| a == "--json");
            let doc = load(path)?;
            if as_json {
                println!("{}", info_json(&doc));
            } else {
                print_info(&doc);
            }
            Ok(())
        }
        "show" => {
            let path = rest.first().ok_or("show: missing <file.aix>")?;
            let id = rest.get(1).ok_or("show: missing <chunkId>")?;
            let doc = load(path)?;
            match doc.chunks.iter().find(|c| &c.id == id) {
                Some(c) => {
                    // Raw content only (diagram source, full text, image data
                    // URL) — pipe-friendly for scripts and agents.
                    println!("{}", c.content);
                    Ok(())
                }
                None => {
                    let ids = doc
                        .chunks
                        .iter()
                        .map(|c| format!("  {} ({})", c.id, c.metadata.chunk_type))
                        .collect::<Vec<_>>()
                        .join("\n");
                    Err(format!("show: no chunk with id '{id}'. Valid ids:\n{ids}"))
                }
            }
        }
        "export" => {
            let input = rest.first().ok_or("export: missing <in.aix>")?;
            let output = rest
                .get(1)
                .ok_or("export: missing <out.{txt,md,rtf,pdf,pptx}>")?;
            let doc = load(input)?;
            export(&doc, output)?;
            println!("wrote {output}");
            Ok(())
        }
        _ => {
            print_usage();
            Err(format!("unknown command '{cmd}'"))
        }
    }
}

fn load(path: &str) -> Result<Document, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    let mut doc: Document = serde_json::from_str(&text)
        .map_err(|e| format!("parse {path} (expected .aix JSON): {e}"))?;
    // Repair invariants the same way the GUI load path does (A1); surface fixes
    // on stderr so a scripting/agent caller can see what was changed.
    for note in doc.normalize() {
        eprintln!("note: {note}");
    }
    Ok(doc)
}

fn export(doc: &Document, output: &str) -> Result<(), String> {
    let ext = output
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase();
    if !CLI_EXPORT_FORMATS.contains(&ext.as_str()) {
        return Err(format!(
            "unsupported export extension '.{ext}' (use {})",
            CLI_EXPORT_FORMATS.join(", ")
        ));
    }
    match ext.as_str() {
        "pptx" => {
            let mut d = deck::document_to_deck(doc);
            // The writer is synchronous; spin up a minimal runtime to fetch
            // remote image URLs first, same as the GUI export path.
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| format!("tokio runtime: {e}"))?;
            rt.block_on(imageio::resolve_remote_images(
                d.slides.iter_mut().flat_map(|s| s.chunks.iter_mut()),
            ));
            let (bytes, warnings) = pptx::deck_to_pptx(&d).map_err(|e| e.to_string())?;
            fileio::write_atomic(output, &bytes).map_err(|e| format!("write {output}: {e}"))?;
            for w in warnings {
                eprintln!("warning: {w}");
            }
            Ok(())
        }
        _ => fileio::export_to_path(doc, output, &ext).map_err(|e| e.to_string()),
    }
}

/// Self-describing manifest so a caller can discover what this build supports at
/// runtime instead of hard-coding field names (report_v2 §9 A6).
fn capabilities_json() -> String {
    serde_json::json!({
        "app": "NurumayuFacet",
        "version": env!("CARGO_PKG_VERSION"),
        "aixSchemaVersion": 1,
        "aiActions": [
            "translate", "proofread", "summarize", "expand", "detailed",
            "concentrate", "focus", "harmonize", "custom"
        ],
        // Honest note for agents: the AI actions run through the GUI only —
        // none of them are CLI verbs (yet).
        "aiActionsRunVia": "gui",
        "chunkTypes": ["text", "heading", "diagram", "image"],
        "exportFormats": CLI_EXPORT_FORMATS,
        "cli": ["capabilities", "info", "show", "export", "help"]
    })
    .to_string()
}

fn info_json(doc: &Document) -> String {
    let chunks: Vec<serde_json::Value> = doc
        .chunks
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "type": c.metadata.chunk_type,
                "level": c.metadata.level,
                "summary": c.metadata.summary,
                "chars": c.content.chars().count(),
                "content": c.content,
            })
        })
        .collect();
    serde_json::json!({
        "id": doc.id,
        "title": doc.title,
        "chunkCount": doc.chunks.len(),
        "hasAnalysis": doc.analysis.is_some(),
        "chunks": chunks,
    })
    .to_string()
}

fn print_info(doc: &Document) {
    let title = if doc.title.trim().is_empty() {
        "(untitled)"
    } else {
        doc.title.trim()
    };
    println!("Title: {title}");
    println!("Chunks: {}", doc.chunks.len());
    for (i, c) in doc.chunks.iter().enumerate() {
        let kind = &c.metadata.chunk_type;
        let preview: String = c.content.chars().take(60).collect();
        let preview = preview.replace('\n', " ");
        println!("  [{i:>3}] {kind:<8} {} | {preview}", c.id);
    }
}

fn print_usage() {
    eprintln!(
        "nurumayufacet — headless CLI\n\
         \n\
         USAGE:\n\
         \tnurumayufacet capabilities                 self-describing JSON manifest\n\
         \tnurumayufacet info <file.aix> [--json]     document structure\n\
         \tnurumayufacet show <file.aix> <chunkId>    print one chunk's raw content\n\
         \tnurumayufacet export <in.aix> <out.ext>    ext = txt | md | rtf | pdf | pptx\n\
         \tnurumayufacet help\n\
         \n\
         Run with no arguments to launch the GUI."
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Chunk, Document};

    #[test]
    fn manifest_export_formats_match_the_dispatch_list() {
        let m: serde_json::Value = serde_json::from_str(&capabilities_json()).unwrap();
        let listed: Vec<&str> = m["exportFormats"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(listed.as_slice(), CLI_EXPORT_FORMATS);
        assert_eq!(m["aiActionsRunVia"], "gui");
    }

    #[test]
    fn every_subcommand_is_in_the_manifest_cli_list() {
        let m: serde_json::Value = serde_json::from_str(&capabilities_json()).unwrap();
        let cli: Vec<&str> = m["cli"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        // Flag aliases (--help/-h) are spellings of `help`, not verbs.
        for sc in SUBCOMMANDS.iter().filter(|s| !s.starts_with('-')) {
            assert!(cli.contains(sc), "manifest cli list is missing '{sc}'");
        }
    }

    #[test]
    fn info_json_includes_full_content_and_chars() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_text(0, "Full text body"));
        let v: serde_json::Value = serde_json::from_str(&info_json(&doc)).unwrap();
        assert_eq!(v["chunks"][0]["content"], "Full text body");
        assert_eq!(v["chunks"][0]["chars"], 14);
    }

    #[test]
    fn show_prints_known_chunk_and_lists_ids_for_unknown() {
        let mut doc = Document::new("D");
        let mut c = Chunk::new_text(0, "chunk body");
        c.id = "c1".into();
        doc.chunks.push(c);
        let path = std::env::temp_dir().join("aix_cli_show_test.aix");
        std::fs::write(&path, serde_json::to_string(&doc).unwrap()).unwrap();
        let p = path.to_str().unwrap().to_string();
        assert!(run("show", &[p.clone(), "c1".into()]).is_ok());
        let err = run("show", &[p, "nope".into()]).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(
            err.contains("nope") && err.contains("c1"),
            "the error should name the bad id and list valid ones: {err}"
        );
    }
}
