//! Headless CLI surface — the first slice of the "Agent Experience" (AX) work
//! (report_v2 §10 T2). It lets an agent or CI script drive the document engine
//! WITHOUT the GUI, reusing the exact same pure backend functions the Tauri
//! commands call. This loop covers the offline, network-free operations
//! (inspect, convert, self-describe) plus the AI verbs (run/analyze/draft);
//! the MCP wrapper (`mcp` subcommand, see `mcp.rs`) is a READ-ONLY stdio
//! server for external agent clients — write/apply-edit is a still-open,
//! deliberately deferred future item, not built here.
//!
//! Recognized invocations (a non-subcommand first arg returns `None` so a normal
//! GUI launch — which may carry OS-injected args — is never hijacked):
//!   nurumayufacet capabilities            self-describing JSON manifest
//!   nurumayufacet info <file.aix> [--json]  document structure (ids/types/summaries)
//!   nurumayufacet show <file.aix> <chunkId>  print one chunk's raw content
//!   nurumayufacet export <in.aix> <out.{txt,md,rtf,pdf,pptx}>
//!   nurumayufacet ai <verb> <file.aix> <chunkId> [instruction] [--json]
//!       runs one AI action (translate/proofread/summarize/expand/detailed/
//!       concentrate/focus/harmonize/custom) against a single chunk and prints
//!       the result. READ-ONLY: never writes back to the source file (a
//!       future capability) — this pass only reads and prints.
//!   nurumayufacet mcp
//!       runs a minimal READ-ONLY Model Context Protocol server over stdio
//!       (JSON-RPC 2.0, newline-delimited) for external MCP clients (Claude
//!       Desktop, Claude Code, etc). See `mcp.rs` for the tool list and
//!       protocol details. No file path here — each tool call carries its
//!       own document path.
//!   nurumayufacet help

use crate::ai::{self, AiRequest, LlmConfig};
use crate::models::Document;
use crate::settings::{self, Settings};
use crate::{deck, fileio, imageio, pptx};

const SUBCOMMANDS: &[&str] = &[
    "capabilities",
    "info",
    "show",
    "export",
    "ai",
    "mcp",
    "help",
    "--help",
    "-h",
];

/// The action verbs the `ai` CLI arm accepts — kept as the single source of
/// truth alongside the capabilities manifest's `aiActions` list (mirrors the
/// `CLI_EXPORT_FORMATS` pattern above) so the two can't silently drift.
pub const CLI_AI_ACTIONS: &[&str] = &[
    "translate", "proofread", "summarize", "expand", "detailed", "concentrate", "focus",
    "harmonize", "custom",
];

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
            let warnings = export(&doc, output)?;
            for w in warnings {
                eprintln!("warning: {w}");
            }
            println!("wrote {output}");
            Ok(())
        }
        "ai" => run_ai(rest),
        "mcp" => crate::mcp::run_stdio_server(),
        _ => {
            print_usage();
            Err(format!("unknown command '{cmd}'"))
        }
    }
}

/// Parsed, ready-to-run shape of an `ai` invocation — everything that can be
/// checked without touching the network. Kept separate from `AiRequest` (the
/// wire type `ai.rs`/the GUI use) so this module's own bookkeeping (as_json,
/// the resolved chunk id) doesn't leak into that shared contract.
#[derive(Debug)]
struct AiInvocation {
    request: AiRequest,
    chunk_id: String,
    as_json: bool,
}

/// Parse args, load the document, find the chunk, and assemble the `AiRequest`
/// — the whole "commands are glue, push logic down" pure/testable slice of the
/// `ai` verb. Only the final network call (`ai::run_action`) is left out, so
/// this can be unit-tested without hitting the network (project testing rule).
///
/// Shape: `ai <verb> <file.aix> <chunkId> [instruction] [--json]`
/// `instruction` is a positional arg, ONLY consulted (and only meaningful) for
/// the `custom` verb — for every other verb it's ignored if present.
fn prepare_ai_request(rest: &[String]) -> Result<AiInvocation, String> {
    let as_json = rest.iter().any(|a| a == "--json");
    let positional: Vec<&String> = rest.iter().filter(|a| a.as_str() != "--json").collect();

    let verb = positional
        .first()
        .ok_or("ai: missing <verb> (one of: ".to_string() + &CLI_AI_ACTIONS.join(", ") + ")")?;
    if !CLI_AI_ACTIONS.contains(&verb.as_str()) {
        return Err(format!(
            "ai: unknown verb '{verb}' (one of: {})",
            CLI_AI_ACTIONS.join(", ")
        ));
    }
    let path = positional.get(1).ok_or("ai: missing <file.aix>")?;
    let id = positional.get(2).ok_or("ai: missing <chunkId>")?;
    let instruction = positional.get(3).map(|s| s.to_string());

    let instruction_is_blank = instruction.as_deref().map(str::trim).unwrap_or("").is_empty();
    if verb.as_str() == "custom" && instruction_is_blank {
        return Err(
            "ai: the 'custom' verb needs an <instruction> positional arg, e.g. \
             `ai custom file.aix chunkId \"tighten this paragraph\"`"
                .to_string(),
        );
    }

    let doc = load(path)?;
    let chunk = doc.chunks.iter().find(|c| &c.id == *id).ok_or_else(|| {
        let ids = doc
            .chunks
            .iter()
            .map(|c| format!("  {} ({})", c.id, c.metadata.chunk_type))
            .collect::<Vec<_>>()
            .join("\n");
        format!("ai: no chunk with id '{id}'. Valid ids:\n{ids}")
    })?;

    let request = AiRequest {
        action: verb.to_string(),
        text: chunk.content.clone(),
        context_before: None,
        context_after: None,
        target_language: None,
        style: None,
        instruction,
        output_language: None,
        tone: None,
        section_heading: None,
        document_map: None,
        linked_content: None,
    };

    Ok(AiInvocation {
        request,
        chunk_id: chunk.id.clone(),
        as_json,
    })
}

/// True for endpoints served from the local machine (e.g. an Ollama bridge),
/// which don't need an API key. Mirrors `commands.rs`'s private
/// `is_local_endpoint` (not reusable across the module boundary as-is) so the
/// CLI path grants the exact same keyless-local-endpoint allowance the GUI's
/// `ai_process` command does.
fn is_local_endpoint(endpoint: &str) -> bool {
    let e = endpoint.to_ascii_lowercase();
    e.contains("localhost") || e.contains("127.0.0.1") || e.contains("0.0.0.0") || e.contains("[::1]")
}

/// Resolve the API key for a request, same rule as `commands.rs`'s
/// `api_key_for`: remote providers require a key; local endpoints may run
/// keyless.
fn cli_api_key_for(endpoint: &str) -> Result<String, String> {
    match settings::get_api_key().map_err(|e| e.to_string())? {
        Some(k) if !k.trim().is_empty() => Ok(k),
        _ if is_local_endpoint(endpoint) => Ok(String::new()),
        _ => Err(
            "ai: no API key is configured. Open the app's Settings screen and add your \
             OpenRouter API key (or another provider's), then re-run this command. \
             (Local endpoints such as Ollama can leave the key blank.)"
                .to_string(),
        ),
    }
}

/// Resolve an `LlmConfig` the same way the GUI's `ai_process` command does
/// (`commands.rs`: `Settings::load(config_dir)` + `api_key_for(endpoint)`),
/// but from a CLI-resolved config dir since there is no `AppHandle` here.
fn load_cli_llm_config() -> Result<LlmConfig, String> {
    let config_dir = cli_config_dir()?;
    let s = Settings::load(&config_dir);
    let api_key = cli_api_key_for(&s.endpoint)?;
    Ok(LlmConfig {
        endpoint: s.endpoint,
        model: s.model,
        api_key,
        temperature: s.temperature,
    })
}

/// The same per-OS config directory Tauri's `AppHandle::path().app_config_dir()`
/// resolves to (`<OS config dir>/<bundle identifier>`), computed without an
/// `AppHandle` — none exists outside the GUI. Kept in lockstep with
/// `tauri.conf.json`'s `identifier`.
fn cli_config_dir() -> Result<std::path::PathBuf, String> {
    const BUNDLE_IDENTIFIER: &str = "com.aix.texteditor";
    dirs::config_dir()
        .map(|d| d.join(BUNDLE_IDENTIFIER))
        .ok_or_else(|| "ai: could not resolve the OS config directory".to_string())
}

/// Build the exact string `run_ai` prints for a completed action — split out
/// from `run_ai` so the `--json` shape is unit-testable without a network call
/// (the network call itself, `ai::run_action`, is the only part that can't be
/// exercised offline).
fn format_ai_output(invocation: &AiInvocation, result: &str) -> String {
    if invocation.as_json {
        serde_json::json!({
            "chunkId": invocation.chunk_id,
            "action": invocation.request.action,
            "result": result,
        })
        .to_string()
    } else {
        result.to_string()
    }
}

fn run_ai(rest: &[String]) -> Result<(), String> {
    let invocation = prepare_ai_request(rest)?;
    let config = load_cli_llm_config()?;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))?;
    let result = rt
        .block_on(ai::run_action(&config, &invocation.request))
        .map_err(|e| e.to_string())?;

    println!("{}", format_ai_output(&invocation, &result));
    Ok(())
}

/// Load a `.aix` file into a `Document`, repairing invariants the same way
/// the GUI load path does. `pub(crate)` so `mcp.rs` reuses this exact
/// implementation rather than re-parsing documents itself.
pub(crate) fn load(path: &str) -> Result<Document, String> {
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

/// Export `doc` to `output` (extension picks the format). Returns any
/// non-fatal warnings collected during export (currently only pptx produces
/// any); the caller decides how to surface them (CLI: stderr, MCP: response
/// field) — this function never swallows them. `pub(crate)` so `mcp.rs`'s
/// `export` tool reuses this exact implementation rather than a second copy.
pub(crate) fn export(doc: &Document, output: &str) -> Result<Vec<String>, String> {
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
            Ok(warnings)
        }
        _ => fileio::export_to_path(doc, output, &ext)
            .map(|()| Vec::new())
            .map_err(|e| e.to_string()),
    }
}

/// Self-describing manifest so a caller can discover what this build supports at
/// runtime instead of hard-coding field names (report_v2 §9 A6). `pub(crate)`
/// so `mcp.rs`'s contract test can assert its tool list matches this manifest.
pub(crate) fn capabilities_json() -> String {
    serde_json::json!({
        "app": "NurumayuFacet",
        "version": env!("CARGO_PKG_VERSION"),
        "aixSchemaVersion": 1,
        "aiActions": CLI_AI_ACTIONS,
        // Both surfaces can run an AI action now: the GUI's one-click buttons,
        // and `nurumayufacet ai <verb> <file.aix> <chunkId>` from a script or
        // agent. An array (not the old plain "gui" string) so a script consumer
        // can tell both are live rather than silently misreading a renamed enum.
        "aiActionsRunVia": ["gui", "cli"],
        "chunkTypes": ["text", "heading", "diagram", "image"],
        "exportFormats": CLI_EXPORT_FORMATS,
        // Read-only MCP stdio server (`nurumayufacet mcp`) — see mcp.rs. No
        // write/apply-edit tool yet; that's a planned future capability
        // pending an approval-gated-writes decision, deliberately not listed
        // here as if it existed.
        "mcp": { "tools": crate::mcp::MCP_TOOLS },
        "cli": ["capabilities", "info", "show", "export", "ai", "mcp", "help"]
    })
    .to_string()
}

/// `pub(crate)` so `mcp.rs`'s `get_document`/`list_chunks` tools reuse the
/// exact same per-chunk JSON shape the CLI's `info --json` prints, rather
/// than a second, potentially drifting copy.
pub(crate) fn info_json(doc: &Document) -> String {
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
         \tnurumayufacet ai <verb> <file.aix> <chunkId> [instruction] [--json]\n\
         \t                                           run one AI action on a chunk\n\
         \t                                           verb = translate | proofread | summarize |\n\
         \t                                                  expand | detailed | concentrate |\n\
         \t                                                  focus | harmonize | custom\n\
         \t                                           'custom' requires <instruction> as an extra\n\
         \t                                           trailing positional arg (before --json).\n\
         \t                                           Requires an API key configured via the GUI's\n\
         \t                                           Settings screen (OS keychain).\n\
         \t                                           READ-ONLY: prints the result; never writes\n\
         \t                                           back to <file.aix> (planned, not built yet).\n\
         \t                                           --json wraps the result as {{chunkId,action,result}}.\n\
         \tnurumayufacet mcp                          run a read-only MCP stdio server\n\
         \t                                           (JSON-RPC 2.0, one message per line) for\n\
         \t                                           external agent clients. No write/apply-edit\n\
         \t                                           tool yet (planned, pending an approval-gating\n\
         \t                                           decision) — see `mcp.rs` for the tool list.\n\
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
        // Contract updated in this change: AI actions now run via BOTH the GUI
        // and the CLI `ai` verb, so the manifest reports an array of surfaces
        // rather than the old plain "gui" string (project rule: contract tests
        // are updated in the SAME change as the behavior they assert on).
        let via: Vec<&str> = m["aiActionsRunVia"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(via, vec!["gui", "cli"]);
        let actions: Vec<&str> = m["aiActions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(actions.as_slice(), CLI_AI_ACTIONS);
        // The MCP tool list must match the real implementation in mcp.rs
        // (duplicated here, and again in mcp.rs's own test, so neither module
        // can drift from the manifest without a red test).
        let mcp_tools: Vec<&str> = m["mcp"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(mcp_tools.as_slice(), crate::mcp::MCP_TOOLS);
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

    /// Writes a one-chunk .aix file to a unique temp path and returns it as a
    /// String (the shape `prepare_ai_request`/`load` expect).
    fn write_temp_doc(tag: &str, chunk_id: &str, content: &str) -> String {
        let mut doc = Document::new("D");
        let mut c = Chunk::new_text(0, content);
        c.id = chunk_id.into();
        doc.chunks.push(c);
        let path = std::env::temp_dir().join(format!(
            "aix_cli_ai_test_{tag}_{}_{}.aix",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, serde_json::to_string(&doc).unwrap()).unwrap();
        path.to_str().unwrap().to_string()
    }

    #[test]
    fn prepare_ai_request_missing_verb_is_a_clear_error() {
        let err = prepare_ai_request(&[]).unwrap_err();
        assert!(err.contains("missing <verb>"), "got: {err}");
    }

    #[test]
    fn prepare_ai_request_unknown_verb_lists_valid_ones() {
        let err = prepare_ai_request(&["not-a-verb".into(), "f.aix".into(), "c1".into()])
            .unwrap_err();
        assert!(err.contains("not-a-verb") && err.contains("translate"), "got: {err}");
    }

    #[test]
    fn prepare_ai_request_missing_file_is_a_clear_error() {
        let err = prepare_ai_request(&["translate".into()]).unwrap_err();
        assert!(err.contains("missing <file.aix>"), "got: {err}");
    }

    #[test]
    fn prepare_ai_request_missing_chunk_id_is_a_clear_error() {
        let path = write_temp_doc("missing_chunk_id", "c1", "hello");
        let err = prepare_ai_request(&["translate".into(), path.clone()]).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(err.contains("missing <chunkId>"), "got: {err}");
    }

    #[test]
    fn prepare_ai_request_unknown_file_is_a_clear_error() {
        let err = prepare_ai_request(&[
            "translate".into(),
            "/no/such/path/definitely_missing.aix".into(),
            "c1".into(),
        ])
        .unwrap_err();
        assert!(err.contains("read"), "got: {err}");
    }

    #[test]
    fn prepare_ai_request_unknown_chunk_lists_valid_ids() {
        let path = write_temp_doc("unknown_chunk", "c1", "hello");
        let err = prepare_ai_request(&["translate".into(), path.clone(), "nope".into()])
            .unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(
            err.contains("nope") && err.contains("c1"),
            "the error should name the bad id and list valid ones: {err}"
        );
    }

    #[test]
    fn prepare_ai_request_custom_without_instruction_is_a_clear_error() {
        let path = write_temp_doc("custom_missing_instruction", "c1", "hello");
        let err = prepare_ai_request(&["custom".into(), path.clone(), "c1".into()]).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(err.contains("instruction"), "got: {err}");
    }

    #[test]
    fn prepare_ai_request_custom_with_instruction_succeeds_and_carries_it() {
        let path = write_temp_doc("custom_with_instruction", "c1", "hello world");
        let inv = prepare_ai_request(&[
            "custom".into(),
            path.clone(),
            "c1".into(),
            "tighten this paragraph".into(),
        ])
        .unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(inv.request.action, "custom");
        assert_eq!(inv.request.text, "hello world");
        assert_eq!(inv.chunk_id, "c1");
        assert_eq!(inv.request.instruction.as_deref(), Some("tighten this paragraph"));
        assert!(!inv.as_json);
    }

    #[test]
    fn prepare_ai_request_json_flag_is_detected_and_not_swallowed_as_a_positional() {
        let path = write_temp_doc("json_flag", "c1", "hello world");
        let inv = prepare_ai_request(&["translate".into(), path.clone(), "c1".into(), "--json".into()])
            .unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(inv.as_json);
        assert_eq!(inv.request.action, "translate");
        assert_eq!(inv.chunk_id, "c1");
    }

    #[test]
    fn prepare_ai_request_populates_text_from_the_found_chunk() {
        let path = write_temp_doc("text_from_chunk", "target", "the paragraph body");
        let inv = prepare_ai_request(&["summarize".into(), path.clone(), "target".into()]).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(inv.request.text, "the paragraph body");
        assert_eq!(inv.request.action, "summarize");
    }

    #[test]
    fn ai_is_registered_as_a_subcommand() {
        assert!(SUBCOMMANDS.contains(&"ai"));
    }

    #[test]
    fn format_ai_output_json_mode_is_valid_parseable_json_with_expected_fields() {
        let invocation = AiInvocation {
            request: AiRequest {
                action: "translate".to_string(),
                text: "hola".to_string(),
                context_before: None,
                context_after: None,
                target_language: None,
                style: None,
                instruction: None,
                output_language: None,
                tone: None,
                section_heading: None,
                document_map: None,
                linked_content: None,
            },
            chunk_id: "c1".to_string(),
            as_json: true,
        };
        let printed = format_ai_output(&invocation, "hello");
        let v: serde_json::Value =
            serde_json::from_str(&printed).expect("--json output must be valid JSON");
        assert_eq!(v["chunkId"], "c1");
        assert_eq!(v["action"], "translate");
        assert_eq!(v["result"], "hello");
        // Exactly these three fields — no stray/renamed keys a script might miss.
        let keys: std::collections::BTreeSet<&str> =
            v.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            ["action", "chunkId", "result"].into_iter().collect()
        );
    }

    #[test]
    fn format_ai_output_plain_mode_prints_only_the_result() {
        let invocation = AiInvocation {
            request: AiRequest {
                action: "summarize".to_string(),
                text: "hola".to_string(),
                context_before: None,
                context_after: None,
                target_language: None,
                style: None,
                instruction: None,
                output_language: None,
                tone: None,
                section_heading: None,
                document_map: None,
                linked_content: None,
            },
            chunk_id: "c1".to_string(),
            as_json: false,
        };
        let printed = format_ai_output(&invocation, "a summary");
        assert_eq!(printed, "a summary");
    }

    #[test]
    fn is_local_endpoint_recognizes_loopback_forms() {
        assert!(is_local_endpoint("http://localhost:11434/v1/chat/completions"));
        assert!(is_local_endpoint("http://127.0.0.1:11434"));
        assert!(is_local_endpoint("http://[::1]:11434"));
        assert!(is_local_endpoint("HTTP://LOCALHOST:11434")); // case-insensitive
        assert!(!is_local_endpoint("https://openrouter.ai/api/v1/chat/completions"));
    }
}
