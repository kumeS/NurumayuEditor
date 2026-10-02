//! Local file import/export. All disk I/O lives on the Rust side (per spec §2);
//! the frontend only supplies a path chosen via the dialog plugin.
//!
//! Supported formats: `.txt`, `.md`/`.markdown`, `.rtf` (plus export-only
//! `.pdf` via `pdf.rs`).
//! Import splits the text into paragraph chunks (blank-line separated), ATX
//! heading chunks, and code fences (backtick or tilde, CommonMark closing
//! rule), promoting ```mermaid / ~~~mermaid fences into diagram chunks.
//! Export reverses this. The `.md` import (`markdown_text_to_document`) is in
//! lockstep with TS `markdownToDocument`; tests/fixtures/md_import.golden.json
//! pins the agreed cases and lists the known divergences (frontmatter and
//! image lines are GUI-only).

use crate::error::{AppError, AppResult};
use crate::models::{Chunk, Document, DIAGRAM_FORMAT_MERMAID, DOC_MODE_MARKDOWN};
use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_DIRECTORY_ENTRIES: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    /// True for files the app can actually open (`.aix`/`.md`/`.markdown`).
    /// Directories are never directly "openable" — the tree expands them
    /// instead. The frontend uses this to grey out unsupported file types
    /// rather than duplicating the extension check itself.
    pub is_openable: bool,
}

fn canonical_child(root: &str, path: &str) -> AppResult<(PathBuf, PathBuf)> {
    let root = std::fs::canonicalize(root)?;
    let path = std::fs::canonicalize(path)?;
    if !path.starts_with(&root) {
        return Err(AppError::Other(
            "That path is outside the selected folder.".to_string(),
        ));
    }
    Ok((root, path))
}

fn is_markdown_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "md" | "markdown"
    )
}

fn is_openable_path(path: &Path) -> bool {
    is_markdown_path(path)
        || path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .eq_ignore_ascii_case("aix")
}

/// List every non-hidden entry (directories and files, of any type) directly
/// below a user-selected root. Canonical containment prevents `..` and symlink
/// traversal; the entry cap keeps a huge or hostile directory from consuming
/// unbounded resources. Used to render the folder tree sidebar — a real file
/// explorer, not a Markdown-only browser, so nothing here filters by extension
/// except `is_openable` (a hint, not a filter).
pub fn list_directory(root: &str, path: &str) -> AppResult<Vec<DirectoryEntry>> {
    let (root, directory) = canonical_child(root, path)?;
    if !directory.is_dir() {
        return Err(AppError::Other(
            "The selected path is not a folder.".to_string(),
        ));
    }

    let mut entries = Vec::new();
    for item in std::fs::read_dir(&directory)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let raw_path = item.path();
        let canonical = match std::fs::canonicalize(&raw_path) {
            Ok(value) if value.starts_with(&root) => value,
            _ => continue,
        };
        let is_directory = canonical.is_dir();
        entries.push(DirectoryEntry {
            name,
            path: canonical.to_string_lossy().to_string(),
            is_directory,
            is_openable: !is_directory && is_openable_path(&canonical),
        });
        if entries.len() >= MAX_DIRECTORY_ENTRIES {
            break;
        }
    }
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Read a file and build a `Document` from its contents.
pub fn import_from_path(path: &str) -> AppResult<Document> {
    let p = Path::new(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let title = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled Document")
        .to_string();

    match ext.as_str() {
        "md" | "markdown" => Ok(markdown_text_to_document(&title, &std::fs::read_to_string(p)?)),
        "txt" => Ok(text_to_document(&title, &std::fs::read_to_string(p)?)),
        "rtf" => Ok(text_to_document(&title, &rtf_to_text(&std::fs::read_to_string(p)?))),
        other => Err(AppError::UnsupportedFormat(other.to_string())),
    }
}

/// Build a Markdown-mode `Document` from Markdown `source`. Pure.
///
/// A leading ATX H1 (see `strip_leading_h1`) becomes the title, otherwise
/// `fallback_title` (the file stem) is kept: Markdown export writes the title
/// as that H1, so an export→import round trip is idempotent instead of
/// accumulating a stray title chunk each cycle. The rest is split by
/// `text_to_document`. `markdown_source` keeps `source` byte-for-byte (the
/// parsed chunks are a projection for the AI/slide features).
///
/// Rust twin of TS `markdownToDocument` (src/markdown.ts); the shared golden
/// fixture tests/fixtures/md_import.golden.json pins the cases both must agree
/// on, and its `_comment` lists the known divergences (frontmatter, image
/// lines, an indented first-line H1, empty ATX headings, lone CR).
pub fn markdown_text_to_document(fallback_title: &str, source: &str) -> Document {
    let mut doc = match strip_leading_h1(source) {
        Some((h1, rest)) => text_to_document(&h1, &rest),
        None => text_to_document(fallback_title, source),
    };
    doc.mode = DOC_MODE_MARKDOWN.to_string();
    doc.markdown_source = Some(source.to_string());
    doc
}

/// Extract plain reference text from a file for use as Draft supporting
/// material. Supports `.txt`/`.md`, `.rtf`, and best-effort `.pdf`.
pub fn read_reference_text(path: &str) -> AppResult<String> {
    let p = Path::new(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "txt" | "md" | "markdown" => Ok(std::fs::read_to_string(p)?),
        "rtf" => Ok(rtf_to_text(&std::fs::read_to_string(p)?)),
        "pdf" => pdf_extract::extract_text(p)
            .map_err(|e| AppError::Other(format!("Could not extract text from PDF: {e}"))),
        other => Err(AppError::UnsupportedFormat(other.to_string())),
    }
}

/// If the first non-blank line is an ATX H1 (`# Heading`, `#` then a space or
/// tab; closing `#` run stripped as in `atx_heading`), return its text and the
/// remaining document. Only a level-1 heading qualifies (`## ...` is body).
/// Known limit: the line is `trim_start`ed first, so an indented first-line
/// H1 becomes the title here while TS `LEADING_H1` treats it as a body
/// heading (excluded from the import golden fixture).
fn strip_leading_h1(text: &str) -> Option<(String, String)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut idx = 0;
    while idx < lines.len() && lines[idx].trim().is_empty() {
        idx += 1;
    }
    let (hashes, heading) = atx_heading(lines.get(idx)?.trim_start())?;
    if hashes != 1 {
        return None;
    }
    let remaining = lines[idx + 1..].join("\n");
    Some((heading, remaining))
}

/// What an RTF export could not carry (rust.md rule 4): every image or diagram
/// that was written as a text placeholder / source text instead of a picture,
/// counted per cause, plus one specific warning per non-zero count. Mirrored
/// by TS `RtfReport` in src/types.ts (field list kept equal by
/// src/rtfReport.test.ts); the warning texts are localized by
/// src/exportWarnings.ts, whose test reads them from this file.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RtfReport {
    pub warnings: Vec<String>,
    /// Image chunks with no image bytes that are not a local file reference:
    /// a remote URL whose fetch failed (content cleared) or wasn't attempted.
    pub images_not_downloaded: usize,
    /// Image chunks still holding a local file reference (relative path,
    /// absolute path or `file:` URL — classified by pptx.rs
    /// `looks_like_local_path`) that the caller couldn't inline.
    pub local_images_unresolved: usize,
    /// Image chunks with bytes RTF can't embed: anything but PNG/JPEG (GIF,
    /// WEBP, BMP, SVG, …) or a PNG/JPEG whose size can't be read.
    pub images_not_embeddable: usize,
    /// Diagram chunks without an embeddable rendered snapshot, written as
    /// their source text.
    pub diagrams_as_source: usize,
}

/// Write a `Document` to disk in the requested format and report what the
/// format couldn't carry: `Some(RtfReport)` for RTF, `None` for txt/md (their
/// writers keep the text; images/diagrams stay as references/fences by
/// design). PDF is refused (see `export_to_path`).
pub fn export_with_report(
    doc: &Document,
    path: &str,
    format: &str,
) -> AppResult<Option<RtfReport>> {
    if format.eq_ignore_ascii_case("rtf") {
        let (body, report) = document_to_rtf(doc);
        write_atomic(path, body.as_bytes())?;
        return Ok(Some(report));
    }
    export_to_path(doc, path, format)?;
    Ok(None)
}

/// Write a `Document` to disk in the requested format.
///
/// For RTF this `()` route discards the `RtfReport`, so no export surface
/// calls it for RTF: the GUI (`commands::export_document`) and the headless
/// CLI/MCP export (`cli::export_from`) both go through `export_with_report`,
/// which returns the report.
pub fn export_to_path(doc: &Document, path: &str, format: &str) -> AppResult<()> {
    let body = match format.to_lowercase().as_str() {
        "txt" => document_to_txt(doc),
        "md" | "markdown" => document_to_md(doc),
        "rtf" => document_to_rtf(doc).0,
        // PDF is lossy and returns a `PdfReport`, which this `()` route cannot
        // carry (rust.md rule 4). Refused here, so no caller (notably the
        // renderer-reachable `commands::export_document`) can drop the report;
        // PDF goes through `pdf::write_pdf` (GUI `export_pdf`, CLI/MCP
        // `cli::export`), which returns it.
        "pdf" => {
            return Err(AppError::Other(
                "PDF export reports what the PDF could not carry, so it uses its own command \
                 (export_pdf), not the generic text export."
                    .to_string(),
            ))
        }
        other => return Err(AppError::UnsupportedFormat(other.to_string())),
    };
    write_atomic(path, body.as_bytes())
}

/// Write `bytes` to `path` atomically: write a temp file in the same directory,
/// then rename it over the target. A crash mid-write leaves the previous file
/// intact instead of a truncated one; `rename` replaces an existing file on
/// both Unix and Windows. The ONE implementation shared by every save/export
/// path (documents, exports, PPTX, sessions).
pub fn write_atomic(path: impl AsRef<Path>, bytes: &[u8]) -> AppResult<()> {
    let path = path.as_ref();
    let dir = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("out");
    // A unique temp name so two concurrent writes never clobber each other's temp.
    let tmp = dir.join(format!(".{}.{}.tmp", name, crate::models::new_id()));
    std::fs::write(&tmp, bytes)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp); // don't leave the temp behind on failure
        return Err(e.into());
    }
    Ok(())
}

// ----- text <-> document ---------------------------------------------------

/// Recognise an ATX Markdown heading: `#`–`######` followed by a space/tab.
/// Returns `(raw hash count, heading text)`. The optional closing `#` run is
/// stripped only when whitespace precedes it (CommonMark), so `## Using C#`
/// keeps `C#` while `## Title ##` yields `Title`. Mirrors the TS regex
/// `^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$` (src/markdown.ts), including that
/// a lone run (`## #`, `## ##`) stays the text. Known limit (planned): a
/// whitespace-only heading (`## `) is not a heading here (`None`).
fn atx_heading(line: &str) -> Option<(usize, String)> {
    let hashes = line.chars().take_while(|&c| c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    // ATX rule: the run of hashes must be followed by a space/tab.
    if !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let ws: &[char] = &[' ', '\t'];
    let body = rest.trim_start_matches(ws).trim_end_matches(ws);
    let without_run = body.trim_end_matches('#');
    let text = if without_run.len() < body.len() && without_run.ends_with(ws) {
        // A closing run preceded by whitespace; `body` never starts with
        // whitespace, so what remains is non-empty.
        without_run.trim_end_matches(ws)
    } else {
        body
    };
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some((hashes, text.to_string()))
}

/// `atx_heading` with the level clamped to the model's 1-3. Returns
/// `(level, heading text)`.
fn parse_heading(line: &str) -> Option<(u8, String)> {
    atx_heading(line).map(|(hashes, text)| (hashes.min(3) as u8, text))
}

/// An opening code fence (CommonMark): a run of at least three backticks or
/// three tildes. A backtick fence's info string may not contain a backtick
/// (such a line is inline code, not a fence). Returns `(marker, info)` where
/// `marker` is the full opening run.
fn fence_open(trimmed: &str) -> Option<(&str, &str)> {
    let ch = trimmed.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let run = trimmed.chars().take_while(|&c| c == ch).count();
    if run < 3 {
        return None;
    }
    let (marker, info) = trimmed.split_at(run);
    if ch == '`' && info.contains('`') {
        return None;
    }
    Some((marker, info))
}

/// Whether `line` closes a fence opened by `marker`: only a run of the SAME
/// character, at least as long as the opener, with nothing but whitespace
/// around it.
fn fence_closes(line: &str, marker: &str) -> bool {
    let Some(ch) = marker.chars().next() else {
        return false;
    };
    let candidate = line.trim();
    let run = candidate.chars().take_while(|&c| c == ch).count();
    run >= marker.len() && candidate[run..].trim().is_empty()
}

/// Split plain text / markdown into chunks. Blank lines separate paragraphs;
/// ATX headings (`parse_heading`) become heading chunks; fenced ```mermaid /
/// ~~~mermaid blocks become diagram chunks; other fenced code blocks become
/// text chunks wrapped in their own opening marker (backtick or tilde run, as
/// long as the opener). A fence closes only on a run of the same character at
/// least as long as the opener (`fence_closes`); an unclosed fence runs to the
/// end and the chunk gains the closing marker. Lockstep with TS
/// `parseMarkdownBlocks` (golden: tests/fixtures/md_import.golden.json).
/// Known limit: image lines stay text here (TS makes image chunks).
pub fn text_to_document(title: &str, text: &str) -> Document {
    let mut doc = Document::new(title);
    let mut order: u32 = 0;
    let mut para: Vec<String> = Vec::new();

    let flush_para = |para: &mut Vec<String>, order: &mut u32, doc: &mut Document| {
        let joined = para.join("\n");
        if !joined.trim().is_empty() {
            doc.chunks
                .push(Chunk::new_text(*order, joined.trim_end().to_string()));
            *order += 1;
        }
        para.clear();
    };

    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();

        if let Some((marker, info)) = fence_open(trimmed) {
            // A fenced code block. Per CommonMark, the closing fence is a line
            // that is *only* the opener's character (after trimming), at least
            // as long as the opener — so an inner "```lang" with an info string,
            // or a run of the other fence character, does not close it.
            let lang = info.trim().to_string();
            let mut code: Vec<String> = Vec::new();
            i += 1;
            while i < lines.len() {
                if fence_closes(lines[i], marker) {
                    break; // closing fence
                }
                code.push(lines[i].to_string());
                i += 1;
            }
            // Skip the closing fence if present.
            if i < lines.len() {
                i += 1;
            }
            flush_para(&mut para, &mut order, &mut doc);
            let body = code.join("\n");
            if lang.eq_ignore_ascii_case(DIAGRAM_FORMAT_MERMAID) {
                doc.chunks
                    .push(Chunk::new_diagram(order, body, DIAGRAM_FORMAT_MERMAID));
            } else {
                let fenced = format!("{marker}{lang}\n{body}\n{marker}");
                doc.chunks.push(Chunk::new_text(order, fenced));
            }
            order += 1;
            continue;
        }

        // A Markdown heading becomes its own chunk (chapter/section divider).
        if let Some((level, heading)) = parse_heading(trimmed) {
            flush_para(&mut para, &mut order, &mut doc);
            doc.chunks.push(Chunk::new_heading(order, level, heading));
            order += 1;
            i += 1;
            continue;
        }

        if line.trim().is_empty() {
            flush_para(&mut para, &mut order, &mut doc);
        } else {
            para.push(line.to_string());
        }
        i += 1;
    }
    flush_para(&mut para, &mut order, &mut doc);

    // Never hand back an empty document — give the user a place to start typing.
    if doc.chunks.is_empty() {
        doc.chunks.push(Chunk::new_text(0, ""));
    }
    doc
}

fn heading_prefix(chunk: &Chunk) -> String {
    let level = chunk.metadata.level.unwrap_or(1).clamp(1, 3) as usize;
    "#".repeat(level)
}

fn chunk_as_markdown(chunk: &Chunk) -> String {
    if chunk.is_heading() {
        return format!("{} {}", heading_prefix(chunk), chunk.content.trim());
    }
    if chunk.is_image() {
        let caption = chunk.metadata.summary.clone().unwrap_or_default();
        return format!("![{}]({})", caption, chunk.content.trim());
    }
    if chunk.is_diagram() {
        let fmt = chunk
            .metadata
            .format
            .clone()
            .unwrap_or_else(|| DIAGRAM_FORMAT_MERMAID.to_string());
        format!("```{}\n{}\n```", fmt, chunk.content.trim_end())
    } else {
        chunk.content.clone()
    }
}

fn document_to_md(doc: &Document) -> String {
    // `markdown_source` is written verbatim only in "markdown" mode (the GUI
    // sends its TS-merged text that way). Outside it the source is only the
    // frontend's merge baseline and Rust has no merge, so text is regenerated
    // from `chunks` (see `Document::markdown_source` doc comment).
    if doc.mode == DOC_MODE_MARKDOWN {
        if let Some(source) = &doc.markdown_source {
            return source.clone();
        }
    }
    // Byte-for-byte twin of the TS no-baseline serializer (markdown.ts
    // `serializeChunks`): parts joined by a blank line, trailing whitespace
    // trimmed, one final newline. Guarded by `md_no_baseline_golden_parity`.
    // Known limits: JS and Rust disagree on whether U+FEFF / U+0085 count as
    // trailing whitespace, and TS clamps heading levels to 1-6 where Rust
    // clamps to 1-3 (normalize() and the TS parser keep levels within 1-3, so
    // 4-6 never reach either writer); the golden fixture leaves these out.
    let mut parts: Vec<String> = Vec::new();
    if !doc.title.trim().is_empty() {
        parts.push(format!("# {}", doc.title.trim()));
    }
    parts.extend(doc.chunks.iter().map(chunk_as_markdown));
    let mut out = parts.join("\n\n").trim_end().to_string();
    out.push('\n');
    out
}

fn document_to_txt(doc: &Document) -> String {
    let mut out = String::new();
    if !doc.title.trim().is_empty() {
        out.push_str(doc.title.trim());
        out.push_str("\n\n");
    }
    let body = doc
        .chunks
        .iter()
        .map(|c| {
            if c.is_heading() {
                format!("{} {}", heading_prefix(c), c.content.trim())
            } else if c.is_image() {
                format!("[Image: {}]", c.metadata.summary.clone().unwrap_or_default())
            } else {
                c.content.clone()
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    out.push_str(&body);
    out.push('\n');
    out
}

// ----- RTF -----------------------------------------------------------------

/// Control words that introduce an ignorable destination group (font/colour
/// tables, metadata, pictures, ...). Their entire enclosing group is dropped.
fn is_ignorable_destination(word: &str) -> bool {
    matches!(
        word,
        "fonttbl"
            | "colortbl"
            | "stylesheet"
            | "info"
            | "pict"
            | "themedata"
            | "colorschememapping"
            | "datastore"
            | "latentstyles"
            | "filetbl"
            | "listtable"
            | "listoverridetable"
            | "rsidtbl"
            | "generator"
            | "operator"
            | "author"
            | "title"
            | "creatim"
            | "revtim"
            | "xmlnstbl"
    )
}

/// Decode a single byte from a `\'hh` escape through the Windows-1252 table.
/// Bytes outside 0x80–0x9F map identically to Unicode (Latin-1); only the
/// CP1252-specific punctuation block needs a lookup. Undefined CP1252 slots
/// fall back to the raw code point.
fn cp1252_decode_byte(v: u8) -> char {
    match v {
        0x80 => '\u{20AC}', // €
        0x82 => '\u{201A}', // ‚
        0x83 => '\u{0192}', // ƒ
        0x84 => '\u{201E}', // „
        0x85 => '\u{2026}', // …
        0x86 => '\u{2020}', // †
        0x87 => '\u{2021}', // ‡
        0x88 => '\u{02C6}', // ˆ
        0x89 => '\u{2030}', // ‰
        0x8A => '\u{0160}', // Š
        0x8B => '\u{2039}', // ‹
        0x8C => '\u{0152}', // Œ
        0x8E => '\u{017D}', // Ž
        0x91 => '\u{2018}', // ‘
        0x92 => '\u{2019}', // ’
        0x93 => '\u{201C}', // “
        0x94 => '\u{201D}', // ”
        0x95 => '\u{2022}', // •
        0x96 => '\u{2013}', // –
        0x97 => '\u{2014}', // —
        0x98 => '\u{02DC}', // ˜
        0x99 => '\u{2122}', // ™
        0x9A => '\u{0161}', // š
        0x9B => '\u{203A}', // ›
        0x9C => '\u{0153}', // œ
        0x9E => '\u{017E}', // ž
        0x9F => '\u{0178}', // Ÿ
        other => other as char,
    }
}

/// Minimal, dependency-free RTF -> plain text conversion. It drops control
/// groups (font/color tables, metadata, and `{\*\..}` destinations), turns
/// paragraph/line breaks into newlines, and decodes `\'hh` and `\uN` escapes.
/// This is a pragmatic reader, not a full RTF parser — sufficient for typical
/// documents (including those produced by this app's exporter).
pub fn rtf_to_text(rtf: &str) -> String {
    let chars: Vec<char> = rtf.chars().collect();
    let len = chars.len();
    let mut out = String::new();
    let mut depth: usize = 0; // number of currently open `{`
    // When `Some(level)`, we are skipping content; skipping ends once `depth`
    // drops back below `level` (i.e. the destination's group has closed).
    let mut skip_level: Option<usize> = None;
    let mut i = 0;

    while i < len {
        let is_skip = skip_level.is_some();
        let c = chars[i];
        match c {
            '{' => {
                depth += 1;
                i += 1;
            }
            '}' => {
                depth = depth.saturating_sub(1);
                if let Some(level) = skip_level {
                    if depth < level {
                        skip_level = None;
                    }
                }
                i += 1;
            }
            '\\' => {
                if i + 1 >= len {
                    break;
                }
                let next = chars[i + 1];

                if next == '\\' || next == '{' || next == '}' {
                    if !is_skip {
                        out.push(next);
                    }
                    i += 2;
                    continue;
                }
                if next == '\'' {
                    // \'hh hex byte. Real-world RTF (Word, Pages, TextEdit — and
                    // this app's own exporter) declares \ansicpg1252, so decode
                    // through the Windows-1252 table. That table agrees with
                    // Latin-1 except for 0x80–0x9F, where CP1252 places smart
                    // quotes, dashes, the ellipsis, the bullet, etc.
                    if i + 3 < len {
                        let hex: String = [chars[i + 2], chars[i + 3]].iter().collect();
                        if let Ok(v) = u8::from_str_radix(&hex, 16) {
                            if !is_skip {
                                out.push(cp1252_decode_byte(v));
                            }
                        }
                        i += 4;
                    } else {
                        i += 2;
                    }
                    continue;
                }
                if next == '*' {
                    // `{\*\..}` — an ignorable destination; skip its group.
                    if skip_level.is_none() {
                        skip_level = Some(depth);
                    }
                    i += 2;
                    continue;
                }
                if next.is_ascii_alphabetic() {
                    // Read control word + optional numeric parameter.
                    let mut j = i + 1;
                    let mut word = String::new();
                    while j < len && chars[j].is_ascii_alphabetic() {
                        word.push(chars[j]);
                        j += 1;
                    }
                    let mut num = String::new();
                    if j < len && (chars[j] == '-' || chars[j].is_ascii_digit()) {
                        if chars[j] == '-' {
                            num.push('-');
                            j += 1;
                        }
                        while j < len && chars[j].is_ascii_digit() {
                            num.push(chars[j]);
                            j += 1;
                        }
                    }
                    // A single trailing space is the control word's delimiter.
                    if j < len && chars[j] == ' ' {
                        j += 1;
                    }

                    if is_ignorable_destination(&word) {
                        if skip_level.is_none() {
                            skip_level = Some(depth);
                        }
                    } else if !is_skip {
                        match word.as_str() {
                            "par" | "line" | "sect" | "row" => out.push('\n'),
                            "tab" => out.push('\t'),
                            "u" => {
                                if let Ok(code) = num.parse::<i32>() {
                                    let cp = if code < 0 {
                                        (code + 65536) as u32
                                    } else {
                                        code as u32
                                    };
                                    if let Some(ch) = char::from_u32(cp) {
                                        out.push(ch);
                                    }
                                }
                                // Skip the single substitution character.
                                if j < len
                                    && chars[j] != '\\'
                                    && chars[j] != '{'
                                    && chars[j] != '}'
                                {
                                    j += 1;
                                }
                            }
                            _ => { /* other control words produce no text */ }
                        }
                    } else if word == "u" {
                        // Even while skipping, consume \u's fallback char so it
                        // doesn't desync the parser.
                        if j < len && chars[j] != '\\' && chars[j] != '{' && chars[j] != '}' {
                            j += 1;
                        }
                    }
                    i = j;
                    continue;
                }
                // Unknown control symbol (e.g. \~, \-): skip it.
                i += 2;
            }
            '\r' | '\n' => {
                // Raw newlines in RTF source are not significant.
                i += 1;
            }
            _ => {
                if !is_skip {
                    out.push(c);
                }
                i += 1;
            }
        }
    }

    out.replace("\r\n", "\n").trim().to_string()
}

fn rtf_escape(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '{' => out.push_str("\\{"),
            '}' => out.push_str("\\}"),
            '\n' => out.push_str("\\par\n"),
            '\t' => out.push_str("\\tab "),
            '\r' => {}
            c if (c as u32) < 128 => out.push(c),
            c => {
                // Emit each UTF-16 code unit as a signed \uN with an ASCII fallback.
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    let signed = if *unit > 32767 {
                        *unit as i32 - 65536
                    } else {
                        *unit as i32
                    };
                    out.push_str(&format!("\\u{}?", signed));
                }
            }
        }
    }
    out
}

/// Max display size for an embedded RTF picture, in twips (1/1440 in): 6 in
/// wide × 8 in tall — larger images are scaled down preserving aspect so they
/// stay inside a Letter/A4 page.
const RTF_MAX_W_TWIPS: i64 = 8_640;
const RTF_MAX_H_TWIPS: i64 = 11_520;

/// Build a `{\pict ...}` group for an image data URL, or `None` when it can't
/// be embedded (not PNG/JPEG, undecodable, unknown size) so the caller falls
/// back to the text placeholder. `picw`/`pich` carry the pixel size in
/// himetric (1/100 mm, assuming 96 dpi: px × 26.4583); `picwgoal`/`pichgoal`
/// the display size in twips (px × 15), capped at 6×8 in. The app's own
/// importer skips the hex payload safely (`pict` is an ignorable destination
/// in `rtf_to_text`), so embedded images round-trip without corrupting text.
fn rtf_picture_group(content: &str) -> Option<String> {
    let bytes = crate::imageio::decode_image(content)?;
    let blip = match crate::imageio::image_ext(&bytes)? {
        ("png", _) => "\\pngblip",
        ("jpeg", _) => "\\jpegblip",
        _ => return None, // GIF/BMP/unknown keep the text placeholder
    };
    let (w_px, h_px) = crate::imageio::image_size(&bytes)?;
    let (w_px, h_px) = (w_px as i64, h_px as i64);
    let picw = (w_px as f64 * 26.4583).round() as i64;
    let pich = (h_px as f64 * 26.4583).round() as i64;
    let mut wgoal = w_px * 15;
    let mut hgoal = h_px * 15;
    if wgoal > RTF_MAX_W_TWIPS || hgoal > RTF_MAX_H_TWIPS {
        let scale = f64::min(
            RTF_MAX_W_TWIPS as f64 / wgoal as f64,
            RTF_MAX_H_TWIPS as f64 / hgoal as f64,
        );
        wgoal = (wgoal as f64 * scale).round() as i64;
        hgoal = (hgoal as f64 * scale).round() as i64;
    }
    let mut out =
        format!("{{\\pict{blip}\\picw{picw}\\pich{pich}\\picwgoal{wgoal}\\pichgoal{hgoal}\n");
    // Lowercase hex payload, wrapped at 128 chars (64 bytes) per line.
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && i % 64 == 0 {
            out.push('\n');
        }
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0F) as usize] as char);
    }
    out.push_str("\n}");
    Some(out)
}

/// Append an embedded picture (plus a caption line when a summary is set) to
/// `out`. Returns `false` when the bytes can't be embedded so the caller keeps
/// its existing text fallback.
fn push_rtf_picture(out: &mut String, content: &str, caption: Option<&str>) -> bool {
    let Some(group) = rtf_picture_group(content) else {
        return false;
    };
    out.push_str(&group);
    out.push_str("\\par\n");
    // Keep the caption line the text placeholder used to carry (the summary).
    if let Some(cap) = caption.map(str::trim).filter(|c| !c.is_empty()) {
        out.push_str("{\\i\\fs20 ");
        out.push_str(&rtf_escape(cap));
        out.push_str("}\\par\n");
    }
    true
}

/// The RTF body plus its lossy report: every image/diagram that falls back to
/// a text placeholder / source text is counted by cause (see `RtfReport`).
fn document_to_rtf(doc: &Document) -> (String, RtfReport) {
    let mut report = RtfReport::default();
    let mut out = String::from("{\\rtf1\\ansi\\ansicpg1252\\deff0\n");
    out.push_str("{\\fonttbl{\\f0\\froman Georgia;}{\\f1\\fmodern Consolas;}}\n");
    out.push_str("\\f0\\fs24\n");

    if !doc.title.trim().is_empty() {
        out.push_str("{\\b\\fs36 ");
        out.push_str(&rtf_escape(doc.title.trim()));
        out.push_str("}\\par\\par\n");
    }

    for (idx, chunk) in doc.chunks.iter().enumerate() {
        if idx > 0 {
            out.push_str("\\par\n");
        }
        if chunk.is_image() {
            // A PNG/JPEG data URL embeds as a real picture; anything else
            // (GIF/BMP/remote URL that couldn't be fetched) keeps the placeholder.
            if !push_rtf_picture(&mut out, &chunk.content, chunk.metadata.summary.as_deref()) {
                // Same classification as the PPTX writer (pptx.rs `build_visuals`).
                match crate::imageio::decode_image(&chunk.content) {
                    Some(_) => report.images_not_embeddable += 1,
                    None if crate::pptx::looks_like_local_path(&chunk.content) => {
                        report.local_images_unresolved += 1
                    }
                    None => report.images_not_downloaded += 1,
                }
                let caption = chunk.metadata.summary.clone().unwrap_or_default();
                out.push_str(&rtf_escape(&format!("[Image: {caption}]")));
                out.push_str("\\par\n");
            }
        } else if chunk.is_heading() {
            // Bold, size by level.
            let fs = match chunk.metadata.level.unwrap_or(1).clamp(1, 3) {
                1 => 34,
                2 => 28,
                _ => 24,
            };
            out.push_str(&format!("{{\\b\\fs{fs} "));
            out.push_str(&rtf_escape(chunk.content.trim()));
            out.push_str("}\\par\n");
        } else if chunk.is_diagram() {
            // A rendered snapshot (injected by the frontend at export time)
            // embeds as a real picture; without one the diagram source is
            // rendered as monospace text.
            let snapshot = chunk.metadata.rendered_image.as_deref().unwrap_or("");
            if !push_rtf_picture(&mut out, snapshot, chunk.metadata.summary.as_deref()) {
                report.diagrams_as_source += 1;
                out.push_str("{\\f1\\fs20 ");
                out.push_str(&rtf_escape(&chunk.content));
                out.push_str("}\\par\n");
            }
        } else {
            out.push_str(&rtf_escape(&chunk.content));
            out.push_str("\\par\n");
        }
    }

    out.push_str("}\n");
    push_rtf_warnings(&mut report);
    (out, report)
}

/// One specific warning per non-zero `RtfReport` count. The literals are read
/// by src/exportWarnings.test.ts (each needs a localization rule there).
fn push_rtf_warnings(report: &mut RtfReport) {
    let warnings = &mut report.warnings;
    if report.images_not_downloaded > 0 {
        warnings.push(format!(
            "{} image(s) couldn't be downloaded and were exported as text placeholders.",
            report.images_not_downloaded
        ));
    }
    if report.local_images_unresolved > 0 {
        warnings.push(format!(
            "{} local image(s) couldn't be read from the document's folder and were exported as text placeholders.",
            report.local_images_unresolved
        ));
    }
    if report.images_not_embeddable > 0 {
        warnings.push(format!(
            "{} image(s) couldn't be embedded in RTF (only PNG and JPEG are supported) and were exported as text placeholders.",
            report.images_not_embeddable
        ));
    }
    if report.diagrams_as_source > 0 {
        warnings.push(format!(
            "{} diagram(s) had no rendered snapshot and were exported as source text.",
            report.diagrams_as_source
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CHUNK_TYPE_DIAGRAM, CHUNK_TYPE_HEADING, CHUNK_TYPE_TEXT};

    fn preview_test_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nurumayu-preview-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn directory_listing_is_sorted_dirs_first_and_includes_every_file_type() {
        let root = preview_test_dir();
        let nested = root.join("Notes");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(root.join("z.md"), "# 日本語\n\n本文。\n").unwrap();
        std::fs::write(root.join("a.png"), b"not text").unwrap();
        std::fs::write(root.join("doc.aix"), "{}").unwrap();

        let entries = list_directory(root.to_str().unwrap(), root.to_str().unwrap()).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| (entry.name.as_str(), entry.is_directory))
                .collect::<Vec<_>>(),
            vec![
                ("Notes", true),
                ("a.png", false),
                ("doc.aix", false),
                ("z.md", false),
            ]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_listing_marks_openable_by_extension_only() {
        let root = preview_test_dir();
        std::fs::create_dir(root.join("Notes")).unwrap();
        std::fs::write(root.join("z.md"), "text").unwrap();
        std::fs::write(root.join("w.markdown"), "text").unwrap();
        std::fs::write(root.join("doc.aix"), "{}").unwrap();
        std::fs::write(root.join("a.png"), b"not text").unwrap();

        let entries = list_directory(root.to_str().unwrap(), root.to_str().unwrap()).unwrap();
        let openable = |name: &str| {
            entries
                .iter()
                .find(|e| e.name == name)
                .unwrap_or_else(|| panic!("missing entry {name}"))
                .is_openable
        };
        assert!(!openable("Notes")); // directories are never directly "openable"
        assert!(openable("z.md"));
        assert!(openable("w.markdown"));
        assert!(openable("doc.aix"));
        assert!(!openable("a.png"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_listing_excludes_dotfiles() {
        let root = preview_test_dir();
        std::fs::write(root.join(".hidden.md"), "text").unwrap();
        std::fs::write(root.join("visible.md"), "text").unwrap();

        let entries = list_directory(root.to_str().unwrap(), root.to_str().unwrap()).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["visible.md"]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_listing_reads_cjk_names() {
        let root = preview_test_dir();
        std::fs::write(root.join("日本語.md"), "本文").unwrap();

        let entries = list_directory(root.to_str().unwrap(), root.to_str().unwrap()).unwrap();
        let entry = entries
            .iter()
            .find(|e| e.name == "日本語.md")
            .expect("CJK-named file should be listed");
        assert!(entry.is_openable);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_listing_caps_at_max_entries() {
        let root = preview_test_dir();
        for i in 0..(MAX_DIRECTORY_ENTRIES + 20) {
            std::fs::write(root.join(format!("f{i:04}.txt")), "x").unwrap();
        }
        let entries = list_directory(root.to_str().unwrap(), root.to_str().unwrap()).unwrap();
        assert_eq!(entries.len(), MAX_DIRECTORY_ENTRIES);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_listing_rejects_paths_outside_its_root() {
        let root = preview_test_dir();
        let outside = preview_test_dir();
        std::fs::write(outside.join("private.md"), "secret").unwrap();
        let err = list_directory(
            root.to_str().unwrap(),
            outside.to_str().unwrap(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("outside the selected folder"));
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn splits_paragraphs_on_blank_lines() {
        let doc = text_to_document("T", "Para one.\nstill one.\n\nPara two.");
        assert_eq!(doc.chunks.len(), 2);
        assert_eq!(doc.chunks[0].content, "Para one.\nstill one.");
        assert_eq!(doc.chunks[1].content, "Para two.");
        assert_eq!(doc.chunks[0].order, 0);
        assert_eq!(doc.chunks[1].order, 1);
    }

    #[test]
    fn promotes_mermaid_fence_to_diagram_chunk() {
        let md = "Intro paragraph.\n\n```mermaid\ngraph TD; A-->B;\n```\n\nOutro.";
        let doc = text_to_document("T", md);
        assert_eq!(doc.chunks.len(), 3);
        assert_eq!(doc.chunks[0].metadata.chunk_type, CHUNK_TYPE_TEXT);
        assert_eq!(doc.chunks[1].metadata.chunk_type, CHUNK_TYPE_DIAGRAM);
        assert_eq!(doc.chunks[1].metadata.format.as_deref(), Some("mermaid"));
        assert_eq!(doc.chunks[1].content, "graph TD; A-->B;");
        assert_eq!(doc.chunks[2].content, "Outro.");
    }

    #[test]
    fn empty_input_yields_one_empty_chunk() {
        let doc = text_to_document("T", "   \n\n  ");
        assert_eq!(doc.chunks.len(), 1);
        assert_eq!(doc.chunks[0].content, "");
    }

    #[test]
    fn rtf_strips_control_groups_and_keeps_body() {
        // The critical case: text AFTER a font/colour table must survive.
        let rtf = r"{\rtf1\ansi{\fonttbl{\f0 Arial;}}{\colortbl;\red0\green0\blue0;}\f0\fs24 Hello\par World}";
        let text = rtf_to_text(rtf);
        assert!(text.contains("Hello"), "got: {text:?}");
        assert!(text.contains("World"), "got: {text:?}");
        assert!(!text.contains("Arial"), "font table leaked: {text:?}");
        assert_eq!(text, "Hello\nWorld");
    }

    #[test]
    fn rtf_roundtrip_preserves_unicode_and_escapes() {
        let mut doc = Document::new("タイトル");
        doc.chunks
            .push(Chunk::new_text(0, "日本語のテスト。Hello, world!"));
        doc.chunks.push(Chunk::new_text(
            1,
            "Braces {} and a backslash \\ kept.",
        ));
        let rtf = document_to_rtf(&doc).0;
        let text = rtf_to_text(&rtf);
        assert!(text.contains("日本語のテスト"), "got: {text:?}");
        assert!(text.contains("Hello, world!"), "got: {text:?}");
        assert!(text.contains("タイトル"), "title lost: {text:?}");
        assert!(text.contains("Braces {} and a backslash \\ kept."), "got: {text:?}");
    }

    #[test]
    fn export_md_includes_title_and_mermaid_fence() {
        let mut doc = Document::new("My Title");
        doc.chunks.push(Chunk::new_text(0, "Body paragraph."));
        doc.chunks
            .push(Chunk::new_diagram(1, "graph TD; A-->B;", "mermaid"));
        let md = document_to_md(&doc);
        assert!(md.contains("# My Title"));
        assert!(md.contains("```mermaid"));
        assert!(md.contains("graph TD; A-->B;"));
        assert!(md.contains("Body paragraph."));
    }

    #[test]
    fn import_export_txt_roundtrips_paragraph_count() {
        let doc = text_to_document("Doc", "Alpha para.\n\nBeta para.\n\nGamma para.");
        assert_eq!(doc.chunks.len(), 3);
        let txt = document_to_txt(&doc);
        let reparsed = text_to_document("Doc", &txt);
        // Title line becomes the first chunk on reparse; body paragraphs survive.
        assert!(reparsed.chunks.iter().any(|c| c.content == "Beta para."));
    }

    #[test]
    fn rtf_cp1252_decodes_smart_punctuation() {
        // \'92 = ’ , \'93/\'94 = curly quotes, \'97 = em dash, \'95 = bullet.
        let rtf = r"{\rtf1\ansi\ansicpg1252 it\'92s \'93quoted\'94 \'97 dash \'95 bullet}";
        let text = rtf_to_text(rtf);
        assert_eq!(text, "it’s “quoted” — dash • bullet", "got: {text:?}");
        // No invisible C1 control characters should remain.
        assert!(
            !text.chars().any(|c| ('\u{0080}'..='\u{009F}').contains(&c)),
            "C1 control leaked: {text:?}"
        );
    }

    #[test]
    fn fenced_block_with_inner_info_string_is_not_truncated() {
        // An inner ```text fence (carrying an info string) must NOT close the
        // outer block; only a bare ``` of equal length does.
        let md = "```markdown\nshow a ```text sample\nstill inside\n```\n\nAfter.";
        let doc = text_to_document("T", md);
        assert_eq!(doc.chunks.len(), 2, "chunks: {:?}", doc.chunks);
        assert!(doc.chunks[0].content.contains("```text sample"));
        assert!(doc.chunks[0].content.contains("still inside"));
        assert_eq!(doc.chunks[1].content, "After.");
    }

    #[test]
    fn strip_leading_h1_only_matches_level_one() {
        assert_eq!(
            strip_leading_h1("\n# My Paper\n\nBody."),
            Some(("My Paper".to_string(), "\nBody.".to_string()))
        );
        // A level-2 heading is body, not a title.
        assert_eq!(strip_leading_h1("## Section\n\nBody."), None);
    }

    /// The closing-run rule must not change empty-ATX-heading behavior
    /// (planned work): a lone `#` run after the opener stays the text, as in
    /// TS, and a whitespace-only heading is still not a heading.
    #[test]
    fn closing_run_rule_leaves_lone_runs_and_empty_headings_alone() {
        assert_eq!(parse_heading("## #"), Some((2, "#".to_string())));
        assert_eq!(parse_heading("## ##"), Some((2, "##".to_string())));
        assert_eq!(parse_heading("## # #"), Some((2, "#".to_string())));
        assert_eq!(parse_heading("## "), None);
        assert_eq!(parse_heading("##\t \t"), None);
        // Only a run at the very end is a closing run.
        assert_eq!(parse_heading("## a ## b"), Some((2, "a ## b".to_string())));
        assert_eq!(parse_heading("####### seven"), None);
        // The H1 title uses the same rule, and needs exactly one hash.
        assert_eq!(strip_leading_h1("# C# ##\nrest"), Some(("C#".to_string(), "rest".to_string())));
        assert_eq!(strip_leading_h1("#\tT\nrest"), Some(("T".to_string(), "rest".to_string())));
        assert_eq!(strip_leading_h1("# \nrest"), None);
    }

    /// Round trip for a tilde fence: import → export → import → export keeps
    /// the `~~~` marker and accumulates nothing on the second cycle.
    #[test]
    fn tilde_fence_round_trips_without_accumulation() {
        // The blank line inside the fence and the inner ``` run would split
        // or close a backtick-only parser's block.
        let md = "# Doc\n\nIntro.\n\n~~~js\nconst a = 1;\n\n```\nconst b = 2;\n~~~\n\nAfter.";
        let doc = markdown_text_to_document("Fallback", md);
        assert_eq!(doc.title, "Doc");
        assert_eq!(doc.chunks.len(), 3, "chunks: {:?}", doc.chunks);
        assert_eq!(doc.chunks[1].content, "~~~js\nconst a = 1;\n\n```\nconst b = 2;\n~~~");
        let mut editor = doc.clone();
        editor.mode = "editor".to_string();
        editor.markdown_source = None;
        let out1 = document_to_md(&editor);
        let mut re = markdown_text_to_document("Fallback", &out1);
        assert_eq!(re.title, "Doc");
        let key = |d: &Document| {
            d.chunks
                .iter()
                .map(|c| (c.metadata.chunk_type.clone(), c.content.clone()))
                .collect::<Vec<_>>()
        };
        assert_eq!(key(&re), key(&doc));
        re.mode = "editor".to_string();
        re.markdown_source = None;
        assert_eq!(document_to_md(&re), out1, "second export cycle changed the output");
    }

    #[test]
    fn headings_become_their_own_chunks() {
        let md = "# Chapter One\n\nIntro paragraph.\n\n## Section A\n\nBody of A.\n\n### Sub\n\nDeep.";
        let doc = text_to_document("T", md);
        assert_eq!(doc.chunks.len(), 6, "chunks: {:?}", doc.chunks);
        assert_eq!(doc.chunks[0].metadata.chunk_type, CHUNK_TYPE_HEADING);
        assert_eq!(doc.chunks[0].metadata.level, Some(1));
        assert_eq!(doc.chunks[0].content, "Chapter One");
        assert_eq!(doc.chunks[1].metadata.chunk_type, CHUNK_TYPE_TEXT);
        assert_eq!(doc.chunks[1].content, "Intro paragraph.");
        assert_eq!(doc.chunks[2].metadata.level, Some(2));
        assert_eq!(doc.chunks[2].content, "Section A");
        assert_eq!(doc.chunks[4].metadata.level, Some(3));
        assert_eq!(doc.chunks[4].content, "Sub");
    }

    #[test]
    fn hash_without_space_is_body_and_deep_levels_clamp() {
        let doc = text_to_document("T", "#nospace stays body\n\n#### deep heading");
        assert_eq!(doc.chunks[0].metadata.chunk_type, CHUNK_TYPE_TEXT);
        assert_eq!(doc.chunks[1].metadata.chunk_type, CHUNK_TYPE_HEADING);
        assert_eq!(doc.chunks[1].metadata.level, Some(3)); // #### clamps to 3
    }

    #[test]
    fn export_md_renders_heading_chunks_and_roundtrips() {
        let mut doc = Document::new("Doc");
        doc.chunks.push(Chunk::new_heading(0, 2, "Methods"));
        doc.chunks.push(Chunk::new_text(1, "We did things."));
        let md = document_to_md(&doc);
        assert!(md.contains("## Methods"), "got: {md}");
        let re = text_to_document("Doc", &md);
        assert!(re
            .chunks
            .iter()
            .any(|c| c.is_heading() && c.content == "Methods" && c.metadata.level == Some(2)));
    }

    // ----- RTF picture embedding -----

    /// Minimal PNG header (signature + IHDR size fields) — enough for
    /// `image_ext` and `image_size`.
    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let mut png = vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        png.extend_from_slice(&w.to_be_bytes());
        png.extend_from_slice(&h.to_be_bytes());
        png
    }

    fn data_url(mime: &str, bytes: &[u8]) -> String {
        use base64::Engine;
        format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    fn image_chunk(order: u32, content: String) -> Chunk {
        let mut c = Chunk::new_text(order, content);
        c.metadata.chunk_type = crate::models::CHUNK_TYPE_IMAGE.to_string();
        c
    }

    #[test]
    fn rtf_embeds_png_image_as_pict_with_caption() {
        let mut doc = Document::new("D");
        let mut img = image_chunk(0, data_url("image/png", &png_bytes(4, 2)));
        img.metadata.summary = Some("a tiny picture".to_string());
        doc.chunks.push(img);
        let rtf = document_to_rtf(&doc).0;
        assert!(rtf.contains("\\pict"), "no pict group: {rtf}");
        assert!(rtf.contains("\\pngblip"), "wrong blip type: {rtf}");
        // 4×2 px @96 dpi → himetric ×26.4583, twips ×15.
        assert!(rtf.contains("\\picw106\\pich53"), "himetric size wrong: {rtf}");
        assert!(rtf.contains("\\picwgoal60\\pichgoal30"), "twips size wrong: {rtf}");
        assert!(rtf.contains("a tiny picture"), "caption line missing: {rtf}");
        assert!(!rtf.contains("[Image:"), "placeholder should be replaced: {rtf}");
        // The importer must still read the file (pict is an ignored destination).
        let text = rtf_to_text(&rtf);
        assert!(text.contains("a tiny picture"), "got: {text:?}");
        assert!(!text.contains("89504e47"), "hex payload leaked into text: {text:?}");
    }

    #[test]
    fn rtf_scales_oversized_images_down_to_the_page() {
        let mut doc = Document::new("D");
        // 1000 px wide → 15000 twips, beyond the 8640-twip (6 in) cap.
        doc.chunks
            .push(image_chunk(0, data_url("image/png", &png_bytes(1000, 100))));
        let rtf = document_to_rtf(&doc).0;
        assert!(rtf.contains("\\picwgoal8640\\pichgoal864"), "not scaled: {rtf}");
    }

    #[test]
    fn rtf_keeps_placeholder_for_gif_and_unfetched_images() {
        let mut doc = Document::new("D");
        let mut gif = image_chunk(0, data_url("image/gif", b"GIF89a\x04\x00\x02\x00"));
        gif.metadata.summary = Some("animated".to_string());
        doc.chunks.push(gif);
        doc.chunks
            .push(image_chunk(1, "https://example.com/x.png".to_string()));
        let rtf = document_to_rtf(&doc).0;
        assert!(!rtf.contains("\\pict"), "gif/URL must not embed: {rtf}");
        assert!(rtf.contains("[Image: animated]"), "placeholder missing: {rtf}");
    }

    #[test]
    fn rtf_embeds_a_diagram_rendered_snapshot_as_pict() {
        let mut doc = Document::new("D");
        let mut d = Chunk::new_diagram(0, "graph TD; A-->B;", "mermaid");
        d.metadata.rendered_image = Some(data_url("image/png", &png_bytes(4, 2)));
        doc.chunks.push(d);
        let rtf = document_to_rtf(&doc).0;
        assert!(rtf.contains("\\pict"), "snapshot not embedded: {rtf}");
        assert!(!rtf.contains("graph TD"), "source should be replaced by the picture: {rtf}");

        // Without a snapshot the mono source block stays.
        let mut doc2 = Document::new("D2");
        doc2.chunks
            .push(Chunk::new_diagram(0, "graph TD; A-->B;", "mermaid"));
        let rtf2 = document_to_rtf(&doc2).0;
        assert!(!rtf2.contains("\\pict"), "nothing to embed: {rtf2}");
        assert!(rtf2.contains("graph TD; A--"), "mono source missing: {rtf2}");
    }

    // ----- RTF lossy report (rust.md rule 4) -----

    #[test]
    fn rtf_report_counts_each_placeholder_by_cause_with_one_warning_each() {
        let mut doc = Document::new("D");
        // Embedded: a PNG picture and a diagram snapshot — never counted.
        doc.chunks.push(image_chunk(0, data_url("image/png", &png_bytes(4, 2))));
        let mut snap = Chunk::new_diagram(1, "graph TD; A-->B;", "mermaid");
        snap.metadata.rendered_image = Some(data_url("image/png", &png_bytes(4, 2)));
        doc.chunks.push(snap);
        // Not embeddable: GIF, BMP, WEBP bytes.
        doc.chunks.push(image_chunk(2, data_url("image/gif", b"GIF89a\x04\x00\x02\x00")));
        doc.chunks.push(image_chunk(3, data_url("image/bmp", &[0x42, 0x4D, 1, 2, 3, 4])));
        doc.chunks.push(image_chunk(
            4,
            data_url("image/webp", &[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
        ));
        // Local references the caller couldn't inline (relative, absolute, file:).
        doc.chunks.push(image_chunk(5, "figures/fig 1.png".to_string()));
        doc.chunks.push(image_chunk(6, "/Users/me/研究/図.jpg".to_string()));
        doc.chunks.push(image_chunk(7, "file:///tmp/x.png".to_string()));
        // Remote: a URL left in place, and a fetch that failed (content cleared).
        doc.chunks.push(image_chunk(8, "https://example.com/x.png".to_string()));
        doc.chunks.push(image_chunk(9, String::new()));
        // A diagram with no snapshot → its source text.
        doc.chunks.push(Chunk::new_diagram(10, "graph LR; X-->Y;", "mermaid"));

        let (rtf, report) = document_to_rtf(&doc);
        assert_eq!(rtf.matches("{\\pict").count(), 2, "exactly the PNG and the snapshot embed");
        assert_eq!(
            report,
            RtfReport {
                warnings: vec![
                    "2 image(s) couldn't be downloaded and were exported as text placeholders."
                        .to_string(),
                    "3 local image(s) couldn't be read from the document's folder and were \
                     exported as text placeholders."
                        .to_string(),
                    "3 image(s) couldn't be embedded in RTF (only PNG and JPEG are supported) and \
                     were exported as text placeholders."
                        .to_string(),
                    "1 diagram(s) had no rendered snapshot and were exported as source text."
                        .to_string(),
                ],
                images_not_downloaded: 2,
                local_images_unresolved: 3,
                images_not_embeddable: 3,
                diagrams_as_source: 1,
            }
        );
    }

    #[test]
    fn rtf_report_is_empty_when_everything_embeds() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_text(0, "本文 only"));
        doc.chunks.push(image_chunk(1, data_url("image/png", &png_bytes(4, 2))));
        doc.chunks.push(image_chunk(2, data_url("image/jpeg", &jpeg_bytes(3, 5))));
        let (_rtf, report) = document_to_rtf(&doc);
        assert_eq!(report, RtfReport::default());
    }

    /// Minimal JPEG: SOI + SOF0 with the frame size (enough for `image_size`).
    fn jpeg_bytes(w: u16, h: u16) -> Vec<u8> {
        let mut j = vec![0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08];
        j.extend_from_slice(&h.to_be_bytes());
        j.extend_from_slice(&w.to_be_bytes());
        j.extend_from_slice(&[0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        j
    }

    #[test]
    fn export_with_report_returns_the_rtf_report_and_none_for_text_formats() {
        let dir = preview_test_dir();
        let mut doc = Document::new("D");
        doc.chunks.push(image_chunk(0, "figures/missing.png".to_string()));

        let rtf_path = dir.join("out.rtf");
        let report = export_with_report(&doc, rtf_path.to_str().unwrap(), "RTF")
            .expect("rtf export")
            .expect("rtf carries a report");
        assert_eq!(report.local_images_unresolved, 1);
        assert_eq!(report.warnings.len(), 1);
        assert!(std::fs::read_to_string(&rtf_path).unwrap().contains("[Image: ]"));

        for fmt in ["txt", "md"] {
            let p = dir.join(format!("out.{fmt}"));
            assert_eq!(export_with_report(&doc, p.to_str().unwrap(), fmt).expect(fmt), None);
            assert!(p.exists(), "{fmt} written");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ----- atomic writes -----

    #[test]
    fn write_atomic_replaces_content_and_leaves_no_temp_sibling() {
        let dir = std::env::temp_dir().join("aix_write_atomic_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.txt");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn md_export_import_roundtrip_is_idempotent_on_chunk_count() {
        // Round-trip through a real .md file: the title must not accumulate as a
        // stray content chunk (regression test for the export→import drift bug).
        let mut doc = Document::new("My Paper");
        doc.chunks.push(Chunk::new_text(0, "Alpha paragraph."));
        doc.chunks.push(Chunk::new_text(1, "Beta paragraph."));

        let path = std::env::temp_dir().join("aix_md_roundtrip_test.md");
        let p = path.to_str().unwrap();
        export_to_path(&doc, p, "md").unwrap();

        let reopened = import_from_path(p).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(reopened.title, "My Paper");
        assert_eq!(reopened.chunks.len(), 2, "chunks: {:?}", reopened.chunks);
        assert_eq!(reopened.chunks[0].content, "Alpha paragraph.");
        assert_eq!(reopened.chunks[1].content, "Beta paragraph.");
        // A second cycle stays stable.
        export_to_path(&reopened, p, "md").unwrap();
        let twice = import_from_path(p).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(twice.chunks.len(), 2, "chunks: {:?}", twice.chunks);
    }

    #[test]
    fn markdown_open_and_export_preserve_exact_source() {
        let source = "# 日本語タイトル\r\n\r\n- [x] **完了**  \r\n- [ ] 次\r\n\r\n|項目|値|\r\n|---|---:|\r\n|速度|42|\r\n";
        let path = std::env::temp_dir().join("nurumayu_markdown_exact_source.md");
        std::fs::write(&path, source.as_bytes()).unwrap();

        let doc = import_from_path(path.to_str().unwrap()).unwrap();
        assert_eq!(doc.mode, DOC_MODE_MARKDOWN);
        assert_eq!(doc.markdown_source.as_deref(), Some(source));
        assert_eq!(document_to_md(&doc), source);

        let _ = std::fs::remove_file(path);
    }

    /// A document that once passed through the Markdown workspace keeps a
    /// `markdown_source` even after switching away (the frontend does not clear
    /// it on chunk edits — see `Document::markdown_source` doc comment). Once the
    /// doc has left Markdown mode, that source is stale: `document_to_md` must
    /// derive fresh text from `chunks` instead of returning it verbatim, or a
    /// Save-As-.md from Editor/Slide mode could silently write old content.
    #[test]
    fn document_to_md_ignores_stale_markdown_source_outside_markdown_mode() {
        let mut doc = Document::new("Untitled");
        doc.mode = "editor".to_string();
        doc.chunks.push(Chunk::new_text(0, "Fresh paragraph."));
        doc.markdown_source = Some("# Stale\n\nOld text from a past Markdown session.".to_string());

        let md = document_to_md(&doc);
        assert!(
            md.contains("Fresh paragraph."),
            "expected fresh chunk content, got: {md}"
        );
        assert!(
            !md.contains("Old text from a past Markdown session."),
            "stale markdown_source leaked through: {md}"
        );
    }

    /// Invariant 3 contract test: the no-baseline `.md` serializer has a TS
    /// twin (src/markdown.ts `serializeChunks`, the GUI writer). Both read
    /// the same golden fixture; src/markdown.test.ts asserts the TS side.
    #[test]
    fn md_no_baseline_golden_parity() {
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            title: String,
            chunks: Vec<Chunk>,
            expected: String,
        }
        #[derive(serde::Deserialize)]
        struct Golden {
            cases: Vec<Case>,
        }
        let golden: Golden = serde_json::from_str(include_str!(
            "../tests/fixtures/md_no_baseline.golden.json"
        ))
        .expect("golden fixture parses");
        assert!(golden.cases.len() >= 7, "fixture lost its cases");
        let mut mismatches = Vec::new();
        for case in golden.cases {
            let mut doc = Document::new(&case.title);
            doc.mode = "editor".to_string();
            doc.chunks = case.chunks;
            assert!(doc.markdown_source.is_none());
            let got = document_to_md(&doc);
            if got != case.expected {
                mismatches.push(format!("{}: got {got:?}, expected {:?}", case.name, case.expected));
            }
        }
        assert!(mismatches.is_empty(), "TS/Rust .md drift:\n{}", mismatches.join("\n"));
    }

    /// Invariant 3 contract test: Markdown IMPORT has a TS twin (src/markdown.ts
    /// `markdownToDocument`, the GUI parser). Both read the same golden
    /// fixture; src/markdownImportParity.test.ts asserts the TS side.
    #[test]
    fn md_import_golden_parity() {
        #[derive(serde::Deserialize, Debug, PartialEq)]
        struct GoldenChunk {
            #[serde(rename = "type")]
            kind: String,
            level: Option<u8>,
            content: String,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            md: String,
            title: String,
            chunks: Vec<GoldenChunk>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Golden {
            fallback_title: String,
            cases: Vec<Case>,
        }
        let golden: Golden =
            serde_json::from_str(include_str!("../tests/fixtures/md_import.golden.json"))
                .expect("golden fixture parses");
        assert!(golden.cases.len() >= 15, "fixture lost its cases");
        let mut mismatches = Vec::new();
        for case in golden.cases {
            let doc = markdown_text_to_document(&golden.fallback_title, &case.md);
            assert_eq!(doc.markdown_source.as_deref(), Some(case.md.as_str()), "{}", case.name);
            assert_eq!(doc.mode, DOC_MODE_MARKDOWN, "{}", case.name);
            let got: Vec<GoldenChunk> = doc
                .chunks
                .iter()
                .map(|c| GoldenChunk {
                    kind: c.metadata.chunk_type.clone(),
                    level: c.metadata.level,
                    content: c.content.clone(),
                })
                .collect();
            if doc.title != case.title || got != case.chunks {
                mismatches.push(format!(
                    "{}: got title {:?} chunks {got:?}, expected title {:?} chunks {:?}",
                    case.name, doc.title, case.title, case.chunks
                ));
            }
        }
        assert!(mismatches.is_empty(), "TS/Rust .md import drift:\n{}", mismatches.join("\n"));
    }
}
