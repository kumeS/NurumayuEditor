//! PDF export — a simple paginated text rendering of the document (CLI + GUI).
//!
//! Uses `printpdf` with a Unicode TTF discovered on the system at runtime: the
//! PDF format's 14 built-in fonts are Latin-1 only, so CJK documents need a
//! real font embedded. Layout is deliberately naive — A4 portrait, fixed
//! margins, per-size width-aware character wrapping (CJK counts double), no
//! hyphenation — a readable printout, not typesetting.
//!
//! Constraints:
//! - `render_pdf` is pure (document + font bytes in → PDF bytes + report out);
//!   only `document_to_pdf` touches the font folders and only `write_pdf`
//!   touches the destination (atomically, via `fileio::write_atomic`).
//! - The export is lossy and says so: every lossy class is counted in
//!   `PdfReport` with a specific warning — images become `[Image: caption]`
//!   placeholders, diagrams print as their source text, and paragraphs whose
//!   Markdown markup (`**`, links, list markers, …) prints literally are
//!   counted whenever the app treats that markup as formatting
//!   (`markup_is_formatting`: Markdown mode, Slide mode — whose preview and
//!   PPTX render it — or any Markdown-backed document). Only a plain
//!   (non-Markdown) Editor document prints `**` as the text it is. Embedding
//!   images and rendered diagrams is planned, not built.
//! - No usable font among `FONT_CANDIDATES` → an actionable `AppError`.
//!   Glyph coverage is NOT checked: Arial Unicode (macOS/Windows) covers CJK,
//!   but the DejaVu Sans fallback (Linux; the Noto `.ttc` is skipped) does
//!   not, so CJK text prints as missing glyphs there (unreported — known limit).

use crate::error::{AppError, AppResult};
use crate::models::Document;
use printpdf::{IndirectFontRef, Mm, PdfDocument, PdfDocumentReference, PdfLayerReference};
use std::path::Path;

// A4 portrait with 20 mm margins.
const PAGE_W_MM: f32 = 210.0;
const PAGE_H_MM: f32 = 297.0;
const MARGIN_MM: f32 = 20.0;
/// Line height multiplier (matches the editor's relaxed prose spacing).
const LINE_HEIGHT: f32 = 1.45;
/// 1 pt = 1/72 in = 0.352778 mm.
const PT_TO_MM: f32 = 0.352_778;
const TITLE_PT: f32 = 18.0;
const BODY_PT: f32 = 10.5;
/// Wrap width in "units" (CJK chars count 2) at `BODY_PT`; other sizes scale
/// inversely, so bigger text wraps sooner.
const BODY_UNITS_PER_LINE: f32 = 92.0;

/// Candidate Unicode TTFs, checked in order. The `.ttc` collection is listed
/// for documentation but skipped — the embedder reads plain TTF only.
const FONT_CANDIDATES: &[&str] = &[
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "C:\\Windows\\Fonts\\ARIALUNI.TTF",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", // skipped: .ttc
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

/// First usable (existing, non-`.ttc`) font path, or `None`.
fn find_font() -> Option<&'static str> {
    FONT_CANDIDATES
        .iter()
        .copied()
        .find(|p| !p.to_ascii_lowercase().ends_with(".ttc") && Path::new(p).exists())
}

/// Heading font size by level (1–3).
fn heading_pt(level: u8) -> f32 {
    match level {
        1 => 15.0,
        2 => 13.0,
        _ => 11.5,
    }
}

/// Outcome of a PDF export: page count plus a counted, human-readable warning
/// per lossy class (mirrored by `PdfReport` in `src/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfReport {
    pub pages: usize,
    pub warnings: Vec<String>,
    pub images_omitted: usize,
    pub diagrams_as_source: usize,
    pub markdown_as_plain_text: usize,
}

/// `"1 image was"` / `"3 images were"` — count, noun and verb agree.
fn counted(n: usize, singular: &str, plural: &str) -> String {
    format!("{n} {}", if n == 1 { singular } else { plural })
}

/// True when the app renders `doc`'s Markdown markup as formatting somewhere,
/// so printing it literally loses something: Markdown mode, Slide mode (Slide
/// preview / Present / PPTX convert `**`, links and list markers through
/// slidetext.rs — BUG-020), or a Markdown-backed document (`markdown_source`
/// present, even `""`) in any view, since the mode switch is view-only
/// (BUG-019). Only a plain Editor document keeps `**` as literal text.
pub(crate) fn markup_is_formatting(doc: &Document) -> bool {
    doc.mode == crate::models::DOC_MODE_MARKDOWN
        || doc.mode == crate::models::DOC_MODE_SLIDE
        || doc.markdown_source.is_some()
}

/// Count what the PDF cannot carry (pure; `pages` is left 0 for the renderer
/// to fill in). Images and diagrams are always lossy; Markdown markup is lossy
/// whenever `markup_is_formatting` — in a plain Editor document a `**` is text
/// the user typed and prints exactly as written.
fn lossy_report(doc: &Document) -> PdfReport {
    let images = doc.chunks.iter().filter(|c| c.is_image()).count();
    let diagrams = doc.chunks.iter().filter(|c| c.is_diagram()).count();
    let markdown = if markup_is_formatting(doc) {
        doc.chunks
            .iter()
            .filter(|c| !c.is_image() && !c.is_diagram() && has_markdown_markup(&c.content))
            .count()
    } else {
        0
    };
    let mut warnings = Vec::new();
    if images > 0 {
        warnings.push(format!(
            "{} replaced by {} (image embedding in PDF is planned).",
            counted(images, "image was", "images were"),
            if images == 1 { "a text placeholder" } else { "text placeholders" }
        ));
    }
    if diagrams > 0 {
        warnings.push(format!(
            "{} exported as {} source text (diagram rendering in PDF is planned).",
            counted(diagrams, "diagram was", "diagrams were"),
            if diagrams == 1 { "its" } else { "their" }
        ));
    }
    if markdown > 0 {
        warnings.push(format!(
            "{} Markdown formatting that is shown as plain text in the PDF.",
            counted(markdown, "paragraph contains", "paragraphs contain")
        ));
    }
    PdfReport {
        pages: 0,
        warnings,
        images_omitted: images,
        diagrams_as_source: diagrams,
        markdown_as_plain_text: markdown,
    }
}

/// True when `text` carries Markdown markup that the PDF prints literally:
/// inline emphasis/code/strike (`**`, `__`, `*x*`, `` ` ``, `~~`), links and
/// images (`](`), or a line starting with a list, quote or table marker.
/// Deliberately conservative about lookalikes (`snake_case`, `2 * 3`, `1.5`).
fn has_markdown_markup(text: &str) -> bool {
    if ["**", "__", "~~", "`", "]("].iter().any(|m| text.contains(m)) {
        return true;
    }
    if has_single_star_emphasis(text) {
        return true;
    }
    text.lines().any(|line| {
        let l = line.trim_start();
        if ["- ", "* ", "+ ", "> "].iter().any(|m| l.starts_with(m)) || l.starts_with('|') {
            return true;
        }
        // Ordered list: digits then ". " (so "1.5 litres" is not a list).
        let digits = l.chars().take_while(|c| c.is_ascii_digit()).count();
        digits > 0 && l[digits..].starts_with(". ")
    })
}

/// `*word*` emphasis: an opening `*` at a word start followed by a non-space,
/// closed by a later `*` that follows a non-space.
fn has_single_star_emphasis(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let mut open: Option<usize> = None;
    for (i, &c) in chars.iter().enumerate() {
        if c != '*' {
            continue;
        }
        let prev = if i == 0 { None } else { Some(chars[i - 1]) };
        let next = chars.get(i + 1).copied();
        match open {
            Some(_) if prev.is_some_and(|p| !p.is_whitespace()) => return true,
            _ => {
                let at_word_start = prev.map_or(true, |p| p.is_whitespace() || "([{\"'".contains(p));
                if at_word_start && next.is_some_and(|n| !n.is_whitespace()) {
                    open = Some(i);
                }
            }
        }
    }
    false
}

/// Render `doc` to PDF bytes using the TTF/OTF `font` bytes (pure: no disk or
/// network access). Returns the bytes plus the lossy-content report.
pub fn render_pdf(doc: &Document, font: &[u8]) -> AppResult<(Vec<u8>, PdfReport)> {
    let mut report = lossy_report(doc);
    let (pdf, page1, layer1) =
        PdfDocument::new(doc.title.trim(), Mm(PAGE_W_MM), Mm(PAGE_H_MM), "Layer 1");
    let font = pdf
        .add_external_font(std::io::Cursor::new(font))
        .map_err(|e| AppError::Other(format!("PDF export could not embed the font: {e}")))?;
    let layer = pdf.get_page(page1).get_layer(layer1);
    let mut w = PdfWriter { pdf, font, layer, y: PAGE_H_MM - MARGIN_MM, pages: 1 };

    if !doc.title.trim().is_empty() {
        w.wrapped(doc.title.trim(), TITLE_PT);
        w.gap();
    }
    for chunk in &doc.chunks {
        if chunk.is_heading() {
            let size = heading_pt(chunk.metadata.level.unwrap_or(1).clamp(1, 3));
            w.wrapped(chunk.content.trim(), size);
        } else if chunk.is_image() {
            // No raster embedding (planned) — a labelled placeholder, like txt
            // export; counted in the report.
            let caption = chunk.metadata.summary.clone().unwrap_or_default();
            w.wrapped(&format!("[Image: {caption}]"), BODY_PT);
        } else {
            // Text paragraphs and diagram source alike: lines as-is, wrapped.
            w.wrapped(&chunk.content, BODY_PT);
        }
        w.gap();
    }

    report.pages = w.pages;
    let bytes = w
        .pdf
        .save_to_bytes()
        .map_err(|e| AppError::Other(format!("PDF export failed: {e}")))?;
    Ok((bytes, report))
}

/// Render `doc` with the first usable system font (see `FONT_CANDIDATES`).
pub fn document_to_pdf(doc: &Document) -> AppResult<(Vec<u8>, PdfReport)> {
    let font_path = find_font().ok_or_else(|| {
        AppError::Other(
            "PDF export needs a Unicode TTF font on this system — looked for Arial Unicode, \
             Noto Sans CJK, and DejaVu Sans in the standard font folders."
                .to_string(),
        )
    })?;
    let font = std::fs::read(font_path)?;
    render_pdf(doc, &font).map_err(|e| match e {
        AppError::Other(m) => AppError::Other(format!("{m} ('{font_path}')")),
        other => other,
    })
}

/// Render `doc` and write it to `path` atomically; returns the report so the
/// caller can surface every warning (GUI: health-bar export report; CLI/MCP:
/// warnings list).
pub fn write_pdf(doc: &Document, path: &str) -> AppResult<PdfReport> {
    let (bytes, report) = document_to_pdf(doc)?;
    crate::fileio::write_atomic(path, &bytes)?;
    Ok(report)
}

/// Cursor over the growing document: current layer plus the baseline `y`
/// (mm from the page bottom, moving downward), breaking pages as it goes.
struct PdfWriter {
    pdf: PdfDocumentReference,
    font: IndirectFontRef,
    layer: PdfLayerReference,
    y: f32,
    /// Pages emitted so far (starts at 1; `line` adds one per page break).
    pages: usize,
}

impl PdfWriter {
    /// Emit one already-wrapped line at `size`, breaking the page when the
    /// baseline would drop into the bottom margin.
    fn line(&mut self, text: &str, size: f32) {
        let lh = size * LINE_HEIGHT * PT_TO_MM;
        if self.y - lh < MARGIN_MM {
            let (page, layer) = self.pdf.add_page(Mm(PAGE_W_MM), Mm(PAGE_H_MM), "Layer 1");
            self.layer = self.pdf.get_page(page).get_layer(layer);
            self.y = PAGE_H_MM - MARGIN_MM;
            self.pages += 1;
        }
        self.y -= lh;
        if !text.is_empty() {
            self.layer
                .use_text(text, size, Mm(MARGIN_MM), Mm(self.y), &self.font);
        }
    }

    /// Emit `text` at `size`, keeping its own line breaks and wrapping each
    /// line to the page width.
    fn wrapped(&mut self, text: &str, size: f32) {
        for raw in text.lines() {
            for line in wrap_line(raw, units_per_line(size)) {
                self.line(&line, size);
            }
        }
    }

    /// Inter-chunk spacing (half a body line); the next `line` call handles
    /// any page break this pushes past.
    fn gap(&mut self) {
        self.y -= BODY_PT * LINE_HEIGHT * PT_TO_MM * 0.5;
    }
}

fn units_per_line(size: f32) -> f32 {
    BODY_UNITS_PER_LINE * BODY_PT / size
}

/// Width units for a char: CJK/fullwidth glyphs are roughly twice as wide as
/// Latin ones in a proportional font, so they count 2.
fn char_units(c: char) -> f32 {
    let wide = matches!(c,
        '\u{1100}'..='\u{115F}'     // Hangul Jamo
        | '\u{2E80}'..='\u{303E}'   // CJK radicals, Kangxi, CJK punctuation
        | '\u{3041}'..='\u{33FF}'   // kana, CJK compatibility
        | '\u{3400}'..='\u{4DBF}'   // CJK extension A
        | '\u{4E00}'..='\u{9FFF}'   // CJK unified ideographs
        | '\u{AC00}'..='\u{D7A3}'   // Hangul syllables
        | '\u{F900}'..='\u{FAFF}'   // CJK compatibility ideographs
        | '\u{FE30}'..='\u{FE4F}'   // CJK compatibility forms
        | '\u{FF00}'..='\u{FF60}'   // fullwidth forms
        | '\u{FFE0}'..='\u{FFE6}'
        | '\u{20000}'..='\u{2FFFD}' // CJK extensions B+
    );
    if wide {
        2.0
    } else {
        1.0
    }
}

/// Naive width-aware wrap: fill up to `max_units`, preferring to break at the
/// last space; spaceless runs (CJK, long tokens) hard-break at the limit.
fn wrap_line(line: &str, max_units: f32) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut cur_units = 0.0_f32;
    let mut last_space: Option<usize> = None; // byte index into `cur`
    for c in line.chars() {
        let u = char_units(c);
        if cur_units + u > max_units && !cur.is_empty() {
            if c == ' ' {
                // The overflowing char IS the separator — break right here
                // (the space is consumed by the line break).
                out.push(std::mem::take(&mut cur));
                cur_units = 0.0;
                last_space = None;
                continue;
            }
            if let Some(i) = last_space.filter(|&i| i > 0) {
                // Break at the space (which is dropped); the tail wraps down.
                let rest = cur[i + 1..].to_string();
                cur.truncate(i);
                out.push(std::mem::take(&mut cur));
                cur = rest;
            } else {
                out.push(std::mem::take(&mut cur));
            }
            cur_units = cur.chars().map(char_units).sum();
            last_space = cur.rfind(' ');
        }
        if c == ' ' {
            last_space = Some(cur.len());
        }
        cur.push(c);
        cur_units += u;
    }
    if !cur.is_empty() || out.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Chunk, Document};

    #[test]
    fn wrap_line_breaks_at_spaces_and_counts_cjk_double() {
        let wrapped = wrap_line("aaa bbb ccc", 7.0);
        assert_eq!(wrapped, vec!["aaa bbb", "ccc"]);
        // 4 CJK chars = 8 units → splits at 3 chars (6 units) for a 7-unit line.
        let wrapped = wrap_line("日本語文", 7.0);
        assert_eq!(wrapped, vec!["日本語", "文"]);
        // Empty input still yields one (empty) line.
        assert_eq!(wrap_line("", 7.0), vec![""]);
    }

    fn lossy_doc() -> Document {
        let mut doc = Document::new("Lossy");
        doc.chunks.push(Chunk::new_heading(0, 1, "Heading"));
        doc.chunks.push(Chunk::new_text(1, "Plain paragraph."));
        doc.chunks
            .push(Chunk::new_diagram(2, "graph TD; A-->B;", "mermaid"));
        let mut img = Chunk::new_text(3, "data:image/png;base64,xxxx");
        img.metadata.chunk_type = crate::models::CHUNK_TYPE_IMAGE.to_string();
        img.metadata.summary = Some("a chart".into());
        doc.chunks.push(img);
        doc
    }

    #[test]
    fn pdf_report_counts_lossy_chunks() {
        let r = lossy_report(&lossy_doc());
        assert_eq!(r.images_omitted, 1);
        assert_eq!(r.diagrams_as_source, 1);
        assert_eq!(r.markdown_as_plain_text, 0);
        assert_eq!(
            r.warnings,
            vec![
                "1 image was replaced by a text placeholder (image embedding in PDF is planned).",
                "1 diagram was exported as its source text (diagram rendering in PDF is planned).",
            ]
        );
    }

    #[test]
    fn pdf_report_pluralises_counts() {
        let mut doc = lossy_doc();
        doc.chunks
            .push(Chunk::new_diagram(4, "graph LR; X-->Y;", "mermaid"));
        let r = lossy_report(&doc);
        assert_eq!(r.diagrams_as_source, 2);
        assert_eq!(
            r.warnings[1],
            "2 diagrams were exported as their source text (diagram rendering in PDF is planned)."
        );
    }

    #[test]
    fn clean_doc_has_no_warnings() {
        let mut doc = Document::new("Clean");
        doc.chunks.push(Chunk::new_heading(0, 1, "Heading"));
        doc.chunks.push(Chunk::new_text(1, "Just prose, 日本語も。"));
        let r = lossy_report(&doc);
        assert!(r.warnings.is_empty(), "unexpected warnings: {:?}", r.warnings);
        assert_eq!((r.images_omitted, r.diagrams_as_source, r.markdown_as_plain_text), (0, 0, 0));
    }

    #[test]
    fn markdown_mode_counts_chunks_whose_markup_prints_literally() {
        let mut doc = Document::new("Md");
        doc.mode = crate::models::DOC_MODE_MARKDOWN.to_string();
        doc.chunks.push(Chunk::new_heading(0, 2, "A **bold** heading"));
        doc.chunks.push(Chunk::new_text(1, "See [the docs](https://example.com)."));
        doc.chunks.push(Chunk::new_text(2, "Plain sentence with snake_case_name."));
        let r = lossy_report(&doc);
        assert_eq!(r.markdown_as_plain_text, 2);
        assert_eq!(
            r.warnings,
            vec!["2 paragraphs contain Markdown formatting that is shown as plain text in the PDF."]
        );
    }

    #[test]
    fn plain_editor_document_markers_are_content_not_formatting() {
        // A plain (non-Markdown) Editor document: `**` is literal text the user
        // typed and nothing renders it, so nothing is lost.
        let mut doc = Document::new("Ed");
        assert_eq!(doc.mode, crate::models::DOC_MODE_EDITOR);
        assert_eq!(doc.markdown_source, None);
        doc.chunks.push(Chunk::new_text(0, "Use **stars** literally."));
        let r = lossy_report(&doc);
        assert_eq!(r.markdown_as_plain_text, 0);
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn slide_mode_counts_markup_the_slide_view_renders() {
        // Slide preview / Present / PPTX format this markup (slidetext.rs,
        // BUG-020), so the literal PDF print is lossy in Slide mode too.
        let mut doc = Document::new("Slides");
        doc.mode = crate::models::DOC_MODE_SLIDE.to_string();
        doc.chunks.push(Chunk::new_text(0, "Use **bold** and [docs](https://x.y)"));
        doc.chunks.push(Chunk::new_text(1, "**重要** です"));
        doc.chunks.push(Chunk::new_text(2, "- item"));
        doc.chunks.push(Chunk::new_text(3, "Plain prose"));
        let r = lossy_report(&doc);
        assert_eq!(r.markdown_as_plain_text, 3);
        assert_eq!(
            r.warnings,
            vec!["3 paragraphs contain Markdown formatting that is shown as plain text in the PDF."]
        );
    }

    #[test]
    fn markdown_backed_document_counts_markup_in_editor_view() {
        // A .md document viewed in Editor mode is still the same Markdown
        // (BUG-019: the mode switch is view-only), so its markup is formatting.
        // `Some("")` is how a new Markdown document starts (store.ts newDoc).
        for source in ["Use **bold** here.\n", ""] {
            let mut doc = Document::new("Md in editor view");
            doc.markdown_source = Some(source.to_string());
            doc.chunks.push(Chunk::new_text(0, "Use **bold** here."));
            doc.chunks.push(Chunk::new_text(1, "Plain prose"));
            let r = lossy_report(&doc);
            assert_eq!(r.markdown_as_plain_text, 1, "source {source:?}");
            assert_eq!(
                r.warnings,
                vec!["1 paragraph contains Markdown formatting that is shown as plain text in the PDF."]
            );
        }
    }

    #[test]
    fn markdown_markup_detector_flags_markup_and_ignores_lookalikes() {
        for yes in [
            "**b**",
            "__b__",
            "*em* here",
            "`code`",
            "~~gone~~",
            "[t](u)",
            "![alt](img.png)",
            "- item",
            "* item",
            "+ item",
            "> quote",
            "1. first",
            "text\n  - nested item",
            "| a | b |",
        ] {
            assert!(has_markdown_markup(yes), "should flag {yes:?}");
        }
        for no in [
            "",
            "snake_case_name and another_one",
            "2 * 3 = 6",
            "a*b",
            "https://example.com/path_with_underscores",
            "Just a sentence.",
            "日本語の本文。",
            "-5 degrees",
            "1.5 litres",
        ] {
            assert!(!has_markdown_markup(no), "should not flag {no:?}");
        }
    }

    #[test]
    fn render_pdf_rejects_an_unreadable_font_with_an_actionable_error() {
        let err = render_pdf(&lossy_doc(), b"not a font").unwrap_err();
        assert!(
            err.to_string().contains("PDF export could not embed the font"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn render_pdf_returns_bytes_and_the_report() {
        let Some(font) = find_font() else {
            eprintln!("skipping: no usable TTF font on this system");
            return;
        };
        let bytes = std::fs::read(font).unwrap();
        let (pdf, r) = render_pdf(&lossy_doc(), &bytes).expect("render");
        assert!(pdf.starts_with(b"%PDF"));
        assert_eq!(r.pages, 1);
        assert_eq!((r.images_omitted, r.diagrams_as_source), (1, 1));
        // Enough body text to spill onto more pages → the page count follows.
        let mut long = lossy_doc();
        long.chunks.push(Chunk::new_text(9, "Line.\n".repeat(200)));
        let (_, r) = render_pdf(&long, &bytes).expect("render long");
        assert!(r.pages >= 3, "expected several pages, got {}", r.pages);
    }

    #[test]
    fn write_pdf_writes_the_file_and_returns_the_report() {
        if find_font().is_none() {
            eprintln!("skipping: no usable TTF font on this system");
            return;
        }
        let path = std::env::temp_dir().join(format!("aix_pdf_write_{}.pdf", crate::models::new_id()));
        let r = write_pdf(&lossy_doc(), path.to_str().unwrap()).expect("write");
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(bytes.starts_with(b"%PDF"));
        assert_eq!(r.warnings.len(), 2);
    }

    #[test]
    fn exports_a_pdf_smoke() {
        // Runtime-skip on systems without any of the candidate fonts, so CI on
        // odd images doesn't fail for an environmental reason.
        if find_font().is_none() {
            eprintln!("skipping PDF smoke test: no usable TTF font on this system");
            return;
        }
        let mut doc = Document::new("PDF Test 日本語");
        doc.chunks.push(Chunk::new_heading(0, 1, "Heading One"));
        doc.chunks.push(Chunk::new_text(1, "Body paragraph. ".repeat(80)));
        doc.chunks.push(Chunk::new_text(2, "日本語の本文。".repeat(60)));
        doc.chunks
            .push(Chunk::new_diagram(3, "graph TD; A-->B;", "mermaid"));
        let mut img = Chunk::new_text(4, "data:image/png;base64,xxxx");
        img.metadata.chunk_type = crate::models::CHUNK_TYPE_IMAGE.to_string();
        img.metadata.summary = Some("a chart".into());
        doc.chunks.push(img);

        let path = std::env::temp_dir().join("aix_pdf_smoke_test.pdf");
        write_pdf(&doc, path.to_str().unwrap()).expect("export pdf");
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"%PDF"), "not a PDF header");
        assert!(bytes.len() > 1024, "suspiciously small: {} bytes", bytes.len());
        // Round-trip through the same extractor the Draft feature uses: the
        // text must survive font subsetting (a broken ToUnicode map would
        // garble it — and silently break copy/paste for users).
        let extracted = pdf_extract::extract_text(&path).expect("re-extract text");
        let _ = std::fs::remove_file(&path);
        assert!(extracted.contains("Heading One"), "heading lost: {extracted:.200}");
        assert!(extracted.contains("Body paragraph."), "body lost");
        // CJK gate: the embedded Unicode font must carry Japanese text through
        // subsetting (the reason this exporter exists instead of Latin-1 base fonts).
        let compact: String = extracted.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(compact.contains("日本語の本文"), "CJK lost: {extracted:.200}");
    }
}
