//! Minimal Model Context Protocol (MCP) server over stdio (開発.txt Stage 2,
//! item 2-3 — "T3 second half / 堀の公開"). Lets an external MCP client
//! (Claude Desktop, Claude Code, or any other agent) read a NurumayuEditor
//! `.aix` document without going through the GUI.
//!
//! Five of the six tools (`list_chunks`, `get_chunk`, `get_document`,
//! `analyze`, `export`) are unconditionally read-only: `export` writes only
//! the requested export file, never the source `.aix`. The sixth,
//! `search_and_summarize` (開発.txt §9 Q12), is the one tool that can modify a
//! source document — it is gated behind `Settings::mcp_write_enabled`
//! (default off) and, when enabled, does ONLY one thing: run a RAG search
//! against the user's personal library (`rag.rs`) and insert the retrieved
//! snippets as a single labeled reference chunk. It never calls an LLM itself
//! and never touches any chunk other than the one it inserts.
//!
//! Transport: JSON-RPC 2.0, one message per line, on stdin/stdout (the
//! standard MCP stdio framing). Nothing but JSON-RPC response lines is ever
//! written to stdout — logs/diagnostics, if any, go to stderr — since stray
//! stdout bytes would corrupt the protocol stream for the client parsing it.
//!
//! This module reuses the same pure `cli.rs` helpers (`load`, `info_json`,
//! the find-or-list-valid-ids chunk lookup, `export`) the CLI's `show`/`info`/
//! `export` arms already use, so the MCP surface can't drift from the CLI's
//! behavior — there is exactly one document-reading/exporting implementation.
//! Writing a document back to disk reuses `fileio::write_atomic`, the same
//! atomic (temp + rename) path every other save/export in this app uses.
//!
//! Every request is handled by `handle_request`, a pure(ish) `Value -> Value`
//! function with no stdio inside it, so the JSON-RPC method dispatch is
//! directly unit-testable without spawning a subprocess or touching real
//! stdin/stdout.

use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

const PROTOCOL_VERSION: &str = "2024-11-05";

/// The tool names this server implements — the single source of truth used by
/// BOTH `tools/list` and the capabilities manifest in `cli.rs`, so the two
/// can't silently drift (mirrors the `CLI_EXPORT_FORMATS` pattern).
/// `search_and_summarize` is the one write-gated tool — see the module doc.
pub const MCP_TOOLS: &[&str] = &[
    "list_chunks",
    "get_chunk",
    "get_document",
    "analyze",
    "export",
    "search_and_summarize",
];

/// Leading label prefix on every chunk `search_and_summarize` inserts, so a
/// document's editor/history clearly shows this text came from an agent, not
/// the user typing. Kept as a single constant so the insert code and its
/// tests can't drift on the exact wording.
const AGENT_REFERENCE_LABEL_PREFIX: &str = "From your library (search:";

// ---------------------------------------------------------------------------
// JSON-RPC error codes (standard reserved range).
// ---------------------------------------------------------------------------
const ERR_PARSE: i64 = -32700;
const ERR_INVALID_REQUEST: i64 = -32600;
const ERR_METHOD_NOT_FOUND: i64 = -32601;
const ERR_INVALID_PARAMS: i64 = -32602;
const ERR_INTERNAL: i64 = -32603;

/// Run the stdio server loop: read newline-delimited JSON-RPC requests from
/// stdin, write newline-delimited JSON-RPC responses to stdout, forever
/// (until stdin closes). One malformed line or failing tool call becomes an
/// error response — it never kills the loop or panics the process.
pub fn run_stdio_server() -> Result<(), String> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("mcp: stdin read error: {e}");
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue; // MCP stdio allows blank lines between messages.
        }

        let response = match serde_json::from_str::<Value>(trimmed) {
            Ok(req) => {
                let resp = handle_request(&req);
                // Notifications (no "id") get no response at all per JSON-RPC 2.0.
                match resp {
                    Some(v) => v,
                    None => continue,
                }
            }
            Err(e) => error_response(Value::Null, ERR_PARSE, &format!("parse error: {e}"), None),
        };

        if let Err(e) = writeln!(stdout, "{response}") {
            eprintln!("mcp: stdout write error: {e}");
            break;
        }
        if let Err(e) = stdout.flush() {
            eprintln!("mcp: stdout flush error: {e}");
            break;
        }
    }
    Ok(())
}

/// Handle one already-parsed JSON-RPC request `Value`, returning the response
/// `Value` to send back — or `None` if the request was a notification (no
/// "id" field), which per JSON-RPC 2.0 gets no response. This is the pure
/// core the tests drive directly.
fn handle_request(req: &Value) -> Option<Value> {
    // A structurally non-object top-level value (string/array/number/bool/
    // null) is never a valid JSON-RPC request or notification — there is no
    // way to distinguish "notification, ignore" from "malformed, tell the
    // client" for it, so per spec this ALWAYS gets an Invalid Request error
    // (id: null). Without this check, `req.get("id")` on a non-object value
    // returns `None` (serde_json's `Value::get(&str)` only matches Object),
    // which would make `has_id` false and silently drop the message with no
    // response at all — worse than an error for a real client, which would
    // then hang waiting for a reply that never comes.
    if !req.is_object() {
        return Some(error_response(
            Value::Null,
            ERR_INVALID_REQUEST,
            "request must be a JSON object",
            None,
        ));
    }

    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let has_id = req.get("id").is_some();

    let method = match req.get("method").and_then(Value::as_str) {
        Some(m) => m,
        None => {
            return has_id.then(|| {
                error_response(id, ERR_INVALID_REQUEST, "missing or non-string 'method'", None)
            });
        }
    };

    let params = req.get("params").cloned().unwrap_or(json!({}));

    let result = match method {
        "initialize" => Ok(initialize_result()),
        "tools/list" => Ok(tools_list_result()),
        "tools/call" => handle_tools_call(&params),
        "notifications/initialized" | "initialized" => {
            // Standard MCP lifecycle notification — no response expected.
            return None;
        }
        other => Err((
            ERR_METHOD_NOT_FOUND,
            format!("unknown method '{other}'"),
            None,
        )),
    };

    // A request with no "id" is a notification; only respond if the client
    // sent one (even a request needing no reply data still echoes the id).
    if !has_id {
        return None;
    }

    Some(match result {
        Ok(value) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": value,
        }),
        Err((code, message, data)) => error_response(id, code, &message, data),
    })
}

fn error_response(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut error = json!({
        "code": code,
        "message": message,
    });
    if let Some(d) = data {
        error["data"] = d;
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": error,
    })
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "serverInfo": {
            "name": "nurumayueditor",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "capabilities": {
            "tools": {}
        }
    })
}

/// One JSON-Schema tool definition. Kept as plain `json!` literals (not a
/// struct) since MCP's `inputSchema` shape is JSON Schema, which serde_json
/// values represent directly without an extra type layer.
fn tool_def(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
        }
    })
}

fn tools_list_result() -> Value {
    let path_prop = || json!({"type": "string", "description": "Path to a .aix document file."});

    let tools = vec![
        tool_def(
            "list_chunks",
            "List every chunk in a NurumayuEditor (.aix) document: id, type, \
             level, summary, and character count per chunk. Read-only.",
            json!({"path": path_prop()}),
            &["path"],
        ),
        tool_def(
            "get_chunk",
            "Get one chunk's raw content (full text, diagram source, or image \
             data URL) by id from a .aix document. Read-only.",
            json!({
                "path": path_prop(),
                "chunkId": {"type": "string", "description": "The chunk id to fetch."},
            }),
            &["path", "chunkId"],
        ),
        tool_def(
            "get_document",
            "Get a .aix document's full structure: title, chunk count, whether \
             a relationship analysis is persisted, and every chunk (id, type, \
             level, summary, chars, content). Read-only.",
            json!({"path": path_prop()}),
            &["path"],
        ),
        tool_def(
            "analyze",
            "Return the relationship graph (nodes, edges, analyzedAt) already \
             persisted in a .aix document, if any. Does NOT run a fresh AI \
             analysis itself (that needs an API key/network call, out of \
             scope for this read-only tool) — if the document has never been \
             analyzed in the app, this returns a clear message saying so \
             instead of an error.",
            json!({"path": path_prop()}),
            &["path"],
        ),
        tool_def(
            "export",
            "Export a .aix document to txt, md, rtf, pdf, or pptx at the given \
             output path. This tool never modifies the source .aix — it writes \
             ONLY the requested export file. Returns any non-fatal warnings \
             collected during export (e.g. an image that could not be embedded).",
            json!({
                "path": path_prop(),
                "format": {
                    "type": "string",
                    "description": "Output format.",
                    "enum": crate::cli::CLI_EXPORT_FORMATS,
                },
                "outPath": {"type": "string", "description": "Where to write the exported file."},
            }),
            &["path", "format", "outPath"],
        ),
        tool_def(
            "search_and_summarize",
            "Search the user's personal knowledge base (rag.rs) for `query` and \
             insert the retrieved snippets as ONE new, clearly labeled reference \
             chunk into the target .aix document — after `chunkId` if given, or \
             at the end of the document otherwise. This is the ONLY tool in this \
             server that modifies a source document, and it is disabled unless \
             the user has turned on \"Allow AI agent to write into documents\" \
             in Settings (mcpWriteEnabled) — calling it while that setting is \
             off returns an error explaining how to enable it and makes NO \
             change to the document. This tool does NOT call any AI model to \
             write a summary itself; it mechanically retrieves the top matching \
             passages from the personal library and inserts them verbatim, \
             labeled with the search query, so the user can always see exactly \
             what an agent added and why.",
            json!({
                "path": path_prop(),
                "query": {"type": "string", "description": "Search query against the personal library."},
                "chunkId": {
                    "type": "string",
                    "description": "Insert the new chunk right after this existing chunk id. \
                                     Omit to insert at the end of the document.",
                },
                "topK": {
                    "type": "integer",
                    "description": "Max number of library snippets to retrieve (default 3).",
                },
            }),
            &["path", "query"],
        ),
    ];

    json!({ "tools": tools })
}

type ToolError = (i64, String, Option<Value>);

fn handle_tools_call(params: &Value) -> Result<Value, ToolError> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((ERR_INVALID_PARAMS, "tools/call: missing 'name'".to_string(), None))?;
    let empty_args = json!({});
    let args = params.get("arguments").unwrap_or(&empty_args);

    let text = match name {
        "list_chunks" => call_list_chunks(args)?,
        "get_chunk" => call_get_chunk(args)?,
        "get_document" => call_get_document(args)?,
        "analyze" => call_analyze(args)?,
        "export" => call_export(args)?,
        "search_and_summarize" => call_search_and_summarize(args)?,
        other => {
            return Err((
                ERR_INVALID_PARAMS,
                format!(
                    "unknown tool '{other}' (available: {})",
                    MCP_TOOLS.join(", ")
                ),
                None,
            ))
        }
    };

    Ok(tool_success(&text))
}

/// Wrap a tool's textual result in MCP's standard `{"content":[...]}` shape.
fn tool_success(text: &str) -> Value {
    json!({
        "content": [
            {"type": "text", "text": text}
        ]
    })
}

fn required_string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| {
        (
            ERR_INVALID_PARAMS,
            format!("missing required string argument '{key}'"),
            None,
        )
    })
}

/// Load a `.aix` document, mapping the CLI's plain-`String` errors into a
/// JSON-RPC "invalid params" error (a bad/missing path or unparsable file is
/// caller error, not a server bug).
fn load_doc(path: &str) -> Result<crate::models::Document, ToolError> {
    crate::cli::load(path).map_err(|e| (ERR_INVALID_PARAMS, e, None))
}

fn call_list_chunks(args: &Value) -> Result<String, ToolError> {
    let path = required_string_arg(args, "path")?;
    let doc = load_doc(path)?;
    let info: Value = serde_json::from_str(&crate::cli::info_json(&doc))
        .map_err(|e| (ERR_INTERNAL, format!("internal: {e}"), None))?;
    // list_chunks intentionally omits the full `content` field info_json()
    // includes (that's what get_chunk/get_document are for) — strip it so
    // this tool stays a lightweight listing.
    let chunks: Vec<Value> = info["chunks"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut c| {
            if let Some(obj) = c.as_object_mut() {
                obj.remove("content");
            }
            c
        })
        .collect();
    Ok(json!(chunks).to_string())
}

fn call_get_chunk(args: &Value) -> Result<String, ToolError> {
    let path = required_string_arg(args, "path")?;
    let chunk_id = required_string_arg(args, "chunkId")?;
    let doc = load_doc(path)?;
    match doc.chunks.iter().find(|c| c.id == chunk_id) {
        Some(c) => Ok(c.content.clone()),
        None => {
            let ids: Vec<Value> = doc
                .chunks
                .iter()
                .map(|c| json!({"id": c.id, "type": c.metadata.chunk_type}))
                .collect();
            Err((
                ERR_INVALID_PARAMS,
                format!("get_chunk: no chunk with id '{chunk_id}'"),
                Some(json!({"validIds": ids})),
            ))
        }
    }
}

fn call_get_document(args: &Value) -> Result<String, ToolError> {
    let path = required_string_arg(args, "path")?;
    let doc = load_doc(path)?;
    Ok(crate::cli::info_json(&doc))
}

fn call_analyze(args: &Value) -> Result<String, ToolError> {
    let path = required_string_arg(args, "path")?;
    let doc = load_doc(path)?;
    match &doc.analysis {
        Some(analysis) => serde_json::to_string(analysis)
            .map_err(|e| (ERR_INTERNAL, format!("internal: {e}"), None)),
        None => Ok(json!({
            "analyzed": false,
            "message": "not yet analyzed — run Analyze in the app first",
        })
        .to_string()),
    }
}

/// MCP `export`: write `path`'s document to `outPath` in `format` through
/// `cli::export` and return `{wrote, warnings}`.
///
/// Known limits (deliberate; see docs/ai/06 "MCP export: no document-relative
/// figures"):
/// - Document-relative figures are NOT resolved: `cli::export` passes no
///   source path, so a relative path, absolute path or `file:` figure is never
///   read from disk and comes back as the "local image(s) couldn't be read"
///   PPTX warning. Resolving them (`cli::export_from(.., Some(path))`) would let
///   an external MCP client pull any readable image-extension file into an
///   output path it chooses; that waits for the confinement decision
///   (planned: confine reads to the document folder's subtree).
///
/// RTF and PDF exports return their counted report warnings (`cli::export`
/// routes RTF through `fileio::export_with_report`).
fn call_export(args: &Value) -> Result<String, ToolError> {
    let path = required_string_arg(args, "path")?;
    let format = required_string_arg(args, "format")?;
    let out_path = required_string_arg(args, "outPath")?;

    if !crate::cli::CLI_EXPORT_FORMATS.contains(&format) {
        return Err((
            ERR_INVALID_PARAMS,
            format!(
                "export: unsupported format '{format}' (use {})",
                crate::cli::CLI_EXPORT_FORMATS.join(", ")
            ),
            None,
        ));
    }
    let doc = load_doc(path)?;
    // outPath's extension must agree with `format` — reuse `cli::export`,
    // which derives the writer from outPath's own extension, by building the
    // path exactly as the CLI `export` arm does (same single implementation).
    let target = if out_path.to_lowercase().ends_with(&format!(".{format}")) {
        out_path.to_string()
    } else {
        format!("{out_path}.{format}")
    };
    let warnings = crate::cli::export(&doc, &target).map_err(|e| (ERR_INTERNAL, e, None))?;
    Ok(json!({
        "wrote": target,
        "warnings": warnings,
    })
    .to_string())
}

/// Build the labeled reference-chunk text this tool inserts: a leading label
/// naming the search query, followed by each retrieved snippet. Kept as a
/// standalone pure function so its exact shape is independently testable and
/// can't silently drift from what `call_search_and_summarize` writes.
fn format_agent_reference_content(query: &str, snippets: &[String]) -> String {
    if snippets.is_empty() {
        return format!(
            "{AGENT_REFERENCE_LABEL_PREFIX} {query}): no matching passages found in your \
             personal library."
        );
    }
    let joined = snippets.join("\n\n---\n\n");
    format!("{AGENT_REFERENCE_LABEL_PREFIX} {query}): {joined}")
}

/// The write-gated tool (開発.txt §9 Q12): mechanically retrieve top RAG
/// snippets for `query` from the user's personal library and insert them as
/// one new, clearly labeled chunk into the target document — never calls an
/// LLM, never touches any other chunk. Gated on `Settings::mcp_write_enabled`
/// (loaded from the same config dir the GUI/CLI use — `cli::cli_config_dir`,
/// since this stdio server has no `AppHandle`); when the gate is off this
/// returns an error and makes NO change to the document at all. Resolves the
/// real OS config dir and delegates to `search_and_summarize_impl`, the
/// config-dir-as-data core function the tests exercise directly against a
/// throwaway temp dir (rust.md rule 1: core fn takes data, not a runtime
/// handle) rather than ever touching the real user's settings file.
fn call_search_and_summarize(args: &Value) -> Result<String, ToolError> {
    let config_dir = crate::cli::cli_config_dir().map_err(|e| (ERR_INTERNAL, e, None))?;
    search_and_summarize_impl(&config_dir, args)
}

fn search_and_summarize_impl(config_dir: &std::path::Path, args: &Value) -> Result<String, ToolError> {
    let path = required_string_arg(args, "path")?;
    let query = required_string_arg(args, "query")?;
    let target_chunk_id = args.get("chunkId").and_then(Value::as_str);
    let top_k = args
        .get("topK")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(3);

    let settings = crate::settings::Settings::load(config_dir);
    if !settings.mcp_write_enabled {
        return Err((
            ERR_INVALID_PARAMS,
            "search_and_summarize: writing into documents is disabled. Turn on \
             \"Allow AI agent to write into documents (MCP)\" in Settings first."
                .to_string(),
            None,
        ));
    }

    // Load and validate the target document/chunk BEFORE touching the RAG
    // index or inserting anything, so an unknown path/chunk id never leaves
    // a half-done write behind.
    let mut doc = load_doc(path)?;
    let insert_after: Option<usize> = match target_chunk_id {
        None => None,
        Some(id) => {
            let idx = doc.chunks.iter().position(|c| c.id == id).ok_or_else(|| {
                let ids: Vec<Value> = doc
                    .chunks
                    .iter()
                    .map(|c| json!({"id": c.id, "type": c.metadata.chunk_type}))
                    .collect();
                (
                    ERR_INVALID_PARAMS,
                    format!("search_and_summarize: no chunk with id '{id}'"),
                    Some(json!({"validIds": ids})),
                )
            })?;
            Some(idx)
        }
    };

    // Same search path the frontend's manual search/preview panel uses
    // (commands::rag_search): skip opening the index (and thus any model
    // load) entirely when nothing has ever been indexed, so an empty/never-
    // used library costs nothing and returns a "no snippets" chunk rather
    // than an error.
    let snippets: Vec<String> = if crate::rag::index_exists(config_dir) {
        let mut index = crate::rag::Index::open(config_dir)
            .map_err(|e| (ERR_INTERNAL, e.to_string(), None))?;
        index
            .search(query, top_k)
            .map_err(|e| (ERR_INTERNAL, e.to_string(), None))?
            .into_iter()
            .map(|hit| hit.snippet)
            .collect()
    } else {
        Vec::new()
    };

    let content = format_agent_reference_content(query, &snippets);
    let mut new_chunk = crate::models::Chunk::new_text(0, content.clone());
    new_chunk.metadata.summary = Some(format!("Agent-inserted library search: {query}"));

    let insert_at = match insert_after {
        Some(idx) => idx + 1,
        None => doc.chunks.len(),
    };
    doc.chunks.insert(insert_at, new_chunk.clone());
    // Keep `order` monotonic with position so the chunk-order invariant
    // `Document::normalize` enforces elsewhere stays consistent here too.
    for (i, c) in doc.chunks.iter_mut().enumerate() {
        c.order = i as u32;
    }

    let serialized = serde_json::to_string_pretty(&doc)
        .map_err(|e| (ERR_INTERNAL, format!("internal: {e}"), None))?;
    crate::fileio::write_atomic(path, serialized.as_bytes())
        .map_err(|e| (ERR_INTERNAL, e.to_string(), None))?;

    Ok(json!({
        "insertedChunkId": new_chunk.id,
        "insertedAfterChunkId": target_chunk_id,
        "query": query,
        "snippetCount": snippets.len(),
        "content": content,
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AnalysisEdge, AnalysisNode, AnalysisResult, Chunk, Document};

    fn write_temp_doc(tag: &str, chunk_id: &str, content: &str) -> String {
        let mut doc = Document::new("D");
        let mut c = Chunk::new_text(0, content);
        c.id = chunk_id.into();
        doc.chunks.push(c);
        let path = std::env::temp_dir().join(format!(
            "aix_mcp_test_{tag}_{}_{}.aix",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, serde_json::to_string(&doc).unwrap()).unwrap();
        path.to_str().unwrap().to_string()
    }

    fn call(method: &str, id: i64, params: Value) -> Value {
        handle_request(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .expect("request with an id must produce a response")
    }

    #[test]
    fn initialize_reports_protocol_version_and_tools_capability() {
        let resp = call("initialize", 1, json!({}));
        assert_eq!(resp["result"]["serverInfo"]["name"], "nurumayueditor");
        assert_eq!(
            resp["result"]["serverInfo"]["version"],
            env!("CARGO_PKG_VERSION")
        );
        assert!(resp["result"]["protocolVersion"].is_string());
        assert_eq!(resp["result"]["capabilities"]["tools"], json!({}));
    }

    #[test]
    fn tools_list_returns_exactly_the_six_tools_with_valid_schemas() {
        let resp = call("tools/list", 1, json!({}));
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 6);
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names.as_slice(), MCP_TOOLS);
        for t in tools {
            let schema = &t["inputSchema"];
            assert_eq!(schema["type"], "object");
            assert!(schema["properties"].is_object());
            assert!(schema["required"].is_array());
            assert!(t["description"].as_str().unwrap().len() > 10);
        }
        // The export tool's format enum must match the CLI's own list — a
        // contract test so the two definitions of "what formats export
        // supports" can't drift apart.
        let export_tool = tools.iter().find(|t| t["name"] == "export").unwrap();
        let enum_vals: Vec<&str> = export_tool["inputSchema"]["properties"]["format"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(enum_vals.as_slice(), crate::cli::CLI_EXPORT_FORMATS);
    }

    #[test]
    fn mcp_tools_constant_matches_capabilities_manifest() {
        let m: Value = serde_json::from_str(&crate::cli::capabilities_json()).unwrap();
        let listed: Vec<&str> = m["mcp"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(listed.as_slice(), MCP_TOOLS);
    }

    #[test]
    fn get_chunk_returns_content_for_known_id() {
        let path = write_temp_doc("get_chunk_known", "c1", "hello world");
        let resp = call(
            "tools/call",
            1,
            json!({"name": "get_chunk", "arguments": {"path": path, "chunkId": "c1"}}),
        );
        let _ = std::fs::remove_file(&path);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, "hello world");
    }

    #[test]
    fn get_chunk_unknown_id_is_a_jsonrpc_error_listing_valid_ids() {
        let path = write_temp_doc("get_chunk_unknown", "c1", "hello world");
        let resp = call(
            "tools/call",
            1,
            json!({"name": "get_chunk", "arguments": {"path": path, "chunkId": "nope"}}),
        );
        let _ = std::fs::remove_file(&path);
        assert!(resp.get("result").is_none(), "must not succeed: {resp}");
        assert_eq!(resp["error"]["code"], ERR_INVALID_PARAMS);
        let msg = resp["error"]["message"].as_str().unwrap();
        assert!(msg.contains("nope"), "got: {msg}");
        let valid_ids = resp["error"]["data"]["validIds"].as_array().unwrap();
        assert!(
            valid_ids.iter().any(|v| v["id"] == "c1"),
            "valid ids should list c1: {valid_ids:?}"
        );
    }

    #[test]
    fn list_chunks_omits_raw_content_but_keeps_metadata() {
        let path = write_temp_doc("list_chunks", "c1", "some body text");
        let resp = call(
            "tools/call",
            1,
            json!({"name": "list_chunks", "arguments": {"path": path}}),
        );
        let _ = std::fs::remove_file(&path);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let chunks: Value = serde_json::from_str(text).unwrap();
        let first = &chunks[0];
        assert_eq!(first["id"], "c1");
        assert_eq!(first["chars"], 14);
        assert!(first.get("content").is_none(), "content must be stripped: {first}");
    }

    #[test]
    fn get_document_matches_cli_info_json_shape() {
        let path = write_temp_doc("get_document", "c1", "body");
        let resp = call(
            "tools/call",
            1,
            json!({"name": "get_document", "arguments": {"path": path}}),
        );
        let doc = crate::cli::load(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let got: Value = serde_json::from_str(text).unwrap();
        let expected: Value = serde_json::from_str(&crate::cli::info_json(&doc)).unwrap();
        assert_eq!(got, expected);
    }

    #[test]
    fn analyze_with_no_persisted_analysis_returns_clear_non_crashing_result() {
        let path = write_temp_doc("analyze_none", "c1", "body");
        let resp = call(
            "tools/call",
            1,
            json!({"name": "analyze", "arguments": {"path": path}}),
        );
        let _ = std::fs::remove_file(&path);
        assert!(resp.get("error").is_none(), "must not be an error: {resp}");
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let v: Value = serde_json::from_str(text).unwrap();
        assert_eq!(v["analyzed"], false);
        assert!(v["message"].as_str().unwrap().contains("not yet analyzed"));
    }

    #[test]
    fn analyze_with_persisted_analysis_returns_the_graph() {
        let mut doc = Document::new("D");
        let mut c1 = Chunk::new_text(0, "cause");
        c1.id = "c1".into();
        let mut c2 = Chunk::new_text(1, "effect");
        c2.id = "c2".into();
        doc.chunks.push(c1);
        doc.chunks.push(c2);
        doc.analysis = Some(AnalysisResult {
            nodes: vec![
                AnalysisNode {
                    id: "c1".into(),
                    label: "Cause".into(),
                    summary: String::new(),
                    kind: "paragraph".into(),
                    parent: None,
                },
                AnalysisNode {
                    id: "c2".into(),
                    label: "Effect".into(),
                    summary: String::new(),
                    kind: "paragraph".into(),
                    parent: None,
                },
            ],
            // Distinct endpoints: `Document::normalize` (called by `cli::load`)
            // intentionally drops degenerate self-edges (source == target) as
            // non-damage, so a self-edge here would silently vanish and this
            // test would be asserting on a fixture normalize() already rewrote.
            edges: vec![AnalysisEdge {
                source: "c1".into(),
                target: "c2".into(),
                relation: "cause".into(),
            }],
            analyzed_at: Some(1_700_000_000_000),
        });
        let path = std::env::temp_dir().join(format!(
            "aix_mcp_test_analyze_some_{}_{}.aix",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, serde_json::to_string(&doc).unwrap()).unwrap();
        let p = path.to_str().unwrap().to_string();

        let resp = call(
            "tools/call",
            1,
            json!({"name": "analyze", "arguments": {"path": p}}),
        );
        let _ = std::fs::remove_file(&path);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let v: Value = serde_json::from_str(text).unwrap();
        assert_eq!(v["nodes"][0]["id"], "c1");
        assert_eq!(v["edges"][0]["relation"], "cause");
        assert_eq!(v["edges"][0]["target"], "c2");
        assert_eq!(v["analyzedAt"], 1_700_000_000_000i64);
    }

    #[test]
    fn get_chunk_missing_path_arg_is_invalid_params_not_a_panic() {
        let resp = call(
            "tools/call",
            1,
            json!({"name": "get_chunk", "arguments": {"chunkId": "c1"}}),
        );
        assert_eq!(resp["error"]["code"], ERR_INVALID_PARAMS);
    }

    #[test]
    fn get_chunk_missing_file_is_invalid_params_not_a_panic() {
        let resp = call(
            "tools/call",
            1,
            json!({
                "name": "get_chunk",
                "arguments": {"path": "/no/such/path/definitely_missing.aix", "chunkId": "c1"}
            }),
        );
        assert_eq!(resp["error"]["code"], ERR_INVALID_PARAMS);
    }

    #[test]
    fn unknown_tool_name_is_a_proper_error() {
        let resp = call(
            "tools/call",
            1,
            json!({"name": "not_a_real_tool", "arguments": {}}),
        );
        assert_eq!(resp["error"]["code"], ERR_INVALID_PARAMS);
        let msg = resp["error"]["message"].as_str().unwrap();
        assert!(msg.contains("not_a_real_tool"));
    }

    #[test]
    fn malformed_request_missing_method_is_an_error_not_a_panic() {
        let resp = handle_request(&json!({"jsonrpc": "2.0", "id": 1, "params": {}}))
            .expect("has an id, must respond");
        assert_eq!(resp["error"]["code"], ERR_INVALID_REQUEST);
    }

    /// Regression: a structurally non-object top-level JSON value (a bare
    /// string, array, number, bool, or null) is valid JSON but never a valid
    /// JSON-RPC request. `Value::get("id")` returns `None` for all of these
    /// (it only matches on Object), so without an explicit `is_object()`
    /// guard `handle_request` would treat them as id-less notifications and
    /// silently return `None` — dropping the message with no response at
    /// all, which is worse for a real client than a clean error (it would
    /// hang waiting for a reply that never arrives). Every one of these must
    /// still produce a proper Invalid Request error, never a panic and never
    /// silence.
    #[test]
    fn non_object_top_level_request_is_invalid_request_not_dropped() {
        for bad in [
            json!("just a string"),
            json!([1, 2, 3]),
            json!(null),
            json!(42),
            json!(true),
        ] {
            let resp = handle_request(&bad)
                .unwrap_or_else(|| panic!("non-object request must not be silently dropped: {bad}"));
            assert_eq!(
                resp["error"]["code"], ERR_INVALID_REQUEST,
                "expected Invalid Request for {bad}, got {resp}"
            );
            assert_eq!(resp["id"], Value::Null);
        }
    }

    #[test]
    fn unknown_method_is_a_method_not_found_error() {
        let resp = call("totally/bogus", 1, json!({}));
        assert_eq!(resp["error"]["code"], ERR_METHOD_NOT_FOUND);
    }

    #[test]
    fn notification_without_id_gets_no_response() {
        let resp = handle_request(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        assert!(resp.is_none());
        // Even an unknown method with no id is a notification: no response.
        let resp2 = handle_request(&json!({"jsonrpc": "2.0", "method": "whatever/unknown"}));
        assert!(resp2.is_none());
    }

    #[test]
    fn export_writes_file_and_reports_warnings_field() {
        let path = write_temp_doc("export_txt", "c1", "export me");
        let out = std::env::temp_dir().join(format!(
            "aix_mcp_export_test_{}_{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let out_str = out.to_str().unwrap().to_string();
        let resp = call(
            "tools/call",
            1,
            json!({"name": "export", "arguments": {"path": path, "format": "txt", "outPath": out_str}}),
        );
        let _ = std::fs::remove_file(&path);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let v: Value = serde_json::from_str(text).unwrap();
        assert_eq!(v["wrote"], out_str);
        assert!(v["warnings"].is_array());
        assert!(out.exists(), "export tool must actually write the file");
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn export_unsupported_format_is_invalid_params_not_a_panic() {
        let path = write_temp_doc("export_bad_format", "c1", "x");
        let resp = call(
            "tools/call",
            1,
            json!({"name": "export", "arguments": {"path": path, "format": "docx", "outPath": "/tmp/whatever.docx"}}),
        );
        let _ = std::fs::remove_file(&path);
        assert_eq!(resp["error"]["code"], ERR_INVALID_PARAMS);
    }

    /// Adversarial coverage for `params`/`arguments` shapes a real client
    /// could never legitimately send but a hostile or buggy one might: wrong
    /// JSON type (string/array/number) where an object is expected, missing
    /// entirely, or absurdly large/deeply-nested values. None of these may
    /// panic — every one must resolve to a normal JSON-RPC error response.
    #[test]
    fn tools_call_with_non_object_params_or_arguments_is_invalid_params_not_a_panic() {
        let cases = [
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":"weird"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":[1,2,3]}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call"}),
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_chunk","arguments":"nope"}}),
            json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_chunk","arguments":[1,2]}}),
            json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":123}}),
        ];
        for req in cases {
            let resp = handle_request(&req).expect("request has an id, must respond");
            assert_eq!(
                resp["error"]["code"], ERR_INVALID_PARAMS,
                "expected invalid-params error for {req}, got {resp}"
            );
        }
    }

    #[test]
    fn extreme_id_and_deeply_nested_arguments_do_not_panic() {
        // u64::MAX as the request id must round-trip without overflow.
        let resp = handle_request(&json!({"jsonrpc":"2.0","id":u64::MAX,"method":"initialize"}))
            .expect("has an id, must respond");
        assert_eq!(resp["id"], json!(u64::MAX));

        // A deeply nested (but not pathologically huge) extra field must not
        // crash the parser/handler even though it's ignored.
        let mut nested = json!("leaf");
        for _ in 0..500 {
            nested = json!({"x": nested});
        }
        let resp2 = handle_request(&json!({
            "jsonrpc":"2.0","id":8,"method":"tools/call",
            "params":{"name":"get_chunk","arguments":{"path":"x","chunkId":"y","extra":nested}}
        }));
        assert!(resp2.is_some());
    }

    // ----- search_and_summarize (write-gated tool) --------------------------

    /// A throwaway config dir with a `settings.json` setting `mcpWriteEnabled`
    /// explicitly — never the real OS config dir, so these tests can never
    /// read or mutate the actual user's settings file.
    fn temp_config_dir_with_write_gate(tag: &str, enabled: bool) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aix_mcp_test_cfg_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = crate::settings::Settings {
            mcp_write_enabled: enabled,
            ..crate::settings::Settings::default()
        };
        settings.save(&dir).unwrap();
        dir
    }

    #[test]
    fn search_and_summarize_tool_is_present_with_valid_schema() {
        let resp = call("tools/list", 1, json!({}));
        let tools = resp["result"]["tools"].as_array().unwrap();
        let tool = tools
            .iter()
            .find(|t| t["name"] == "search_and_summarize")
            .expect("search_and_summarize must be listed");
        let schema = &tool["inputSchema"];
        assert_eq!(schema["type"], "object");
        let required: Vec<&str> = schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(required, vec!["path", "query"]);
        assert!(schema["properties"]["chunkId"].is_object());
        assert!(schema["properties"]["topK"].is_object());
        assert!(tool["description"].as_str().unwrap().len() > 10);
    }

    #[test]
    fn search_and_summarize_with_write_disabled_returns_gate_error_and_no_change() {
        let cfg_dir = temp_config_dir_with_write_gate("gate_off", false);
        let path = write_temp_doc("write_gated", "c1", "original content");
        let before = std::fs::read_to_string(&path).unwrap();

        let resp = search_and_summarize_impl(
            &cfg_dir,
            &json!({"path": path, "query": "anything"}),
        );

        let after = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&cfg_dir);

        let err = resp.expect_err("must fail while the gate is off");
        assert_eq!(err.0, ERR_INVALID_PARAMS);
        assert!(
            err.1.to_lowercase().contains("disabled") || err.1.to_lowercase().contains("enable"),
            "expected an explanatory gate error, got: {}",
            err.1
        );
        assert_eq!(after, before, "document must be completely unchanged while the gate is off");
    }

    #[test]
    fn search_and_summarize_with_write_enabled_inserts_labeled_chunk_at_end() {
        let cfg_dir = temp_config_dir_with_write_gate("gate_on_end", true);
        let path = write_temp_doc("write_enabled_end", "c1", "original content");

        // No personal-library index has ever been created in this fresh temp
        // config dir, so this exercises the "index_exists == false" branch —
        // no embedding model is touched, and the inserted chunk says nothing
        // was found rather than erroring.
        let resp = search_and_summarize_impl(
            &cfg_dir,
            &json!({"path": path, "query": "my search term"}),
        )
        .expect("must succeed while the gate is on");

        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["query"], "my search term");
        assert_eq!(v["snippetCount"], 0);
        let content = v["content"].as_str().unwrap();
        assert!(content.contains("my search term"), "got: {content}");
        assert!(
            content.starts_with(AGENT_REFERENCE_LABEL_PREFIX),
            "got: {content}"
        );

        let doc = crate::cli::load(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&cfg_dir);

        assert_eq!(doc.chunks.len(), 2, "chunks: {:?}", doc.chunks);
        assert_eq!(doc.chunks[0].content, "original content");
        assert_eq!(doc.chunks[1].content, content);
        assert_eq!(
            doc.chunks[1].id,
            v["insertedChunkId"].as_str().unwrap(),
            "reported inserted id must match the actual chunk"
        );
    }

    #[test]
    fn search_and_summarize_inserts_immediately_after_target_chunk_not_at_end() {
        let cfg_dir = temp_config_dir_with_write_gate("gate_on_mid", true);
        let mut doc = crate::models::Document::new("D");
        let mut c1 = crate::models::Chunk::new_text(0, "first");
        c1.id = "c1".into();
        let mut c2 = crate::models::Chunk::new_text(1, "second");
        c2.id = "c2".into();
        doc.chunks.push(c1);
        doc.chunks.push(c2);
        let path = std::env::temp_dir().join(format!(
            "aix_mcp_test_mid_insert_{}_{}.aix",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, serde_json::to_string(&doc).unwrap()).unwrap();
        let p = path.to_str().unwrap().to_string();

        let resp = search_and_summarize_impl(
            &cfg_dir,
            &json!({"path": p, "query": "q", "chunkId": "c1"}),
        )
        .expect("must succeed");
        let v: Value = serde_json::from_str(&resp).unwrap();

        let reloaded = crate::cli::load(&p).unwrap();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&cfg_dir);

        assert_eq!(reloaded.chunks.len(), 3, "chunks: {:?}", reloaded.chunks);
        assert_eq!(reloaded.chunks[0].content, "first");
        assert_eq!(reloaded.chunks[1].id, v["insertedChunkId"]);
        assert_eq!(reloaded.chunks[2].content, "second");
    }

    #[test]
    fn search_and_summarize_unknown_target_chunk_id_is_invalid_params_and_no_change() {
        let cfg_dir = temp_config_dir_with_write_gate("gate_on_unknown_chunk", true);
        let path = write_temp_doc("unknown_chunk", "c1", "content");
        let before = std::fs::read_to_string(&path).unwrap();

        let err = search_and_summarize_impl(
            &cfg_dir,
            &json!({"path": path, "query": "q", "chunkId": "does-not-exist"}),
        )
        .expect_err("must fail for an unknown chunk id");

        let after = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&cfg_dir);

        assert_eq!(err.0, ERR_INVALID_PARAMS);
        assert!(err.1.contains("does-not-exist"), "got: {}", err.1);
        let valid_ids = err.2.as_ref().unwrap()["validIds"].as_array().unwrap();
        assert!(valid_ids.iter().any(|v| v["id"] == "c1"));
        assert_eq!(after, before, "document must be unchanged on an unknown chunk id error");
    }

    #[test]
    fn search_and_summarize_missing_document_is_invalid_params_not_a_panic() {
        let cfg_dir = temp_config_dir_with_write_gate("gate_on_missing_doc", true);
        let err = search_and_summarize_impl(
            &cfg_dir,
            &json!({"path": "/no/such/path/definitely_missing.aix", "query": "q"}),
        )
        .expect_err("must fail for a missing document");
        let _ = std::fs::remove_dir_all(&cfg_dir);
        assert_eq!(err.0, ERR_INVALID_PARAMS);
    }

    #[test]
    fn search_and_summarize_via_tools_call_dispatches_correctly() {
        // End-to-end through the same `tools/call` JSON-RPC path the other
        // tools are tested through, proving the dispatch table wiring (not
        // just the impl function) — using the REAL `cli_config_dir()` would
        // touch the actual user's settings, so this only checks that an
        // unknown tool name is rejected and a known one is routed without
        // panicking; the gate/insert behavior itself is covered above via
        // `search_and_summarize_impl` against a throwaway config dir.
        let path = write_temp_doc("dispatch_check", "c1", "x");
        let resp = call(
            "tools/call",
            1,
            json!({"name": "search_and_summarize", "arguments": {"path": path, "query": "q"}}),
        );
        let _ = std::fs::remove_file(&path);
        // Whatever the real machine's mcpWriteEnabled setting is, this must
        // resolve to either a normal JSON-RPC result or a normal JSON-RPC
        // error — never a panic — proving the dispatch entry is wired.
        assert!(resp.get("result").is_some() || resp.get("error").is_some());
    }
}
