//! PDF export — a simple paginated text rendering of the document (CLI + GUI).
//!
//! Uses `printpdf` with a Unicode TTF discovered on the system at runtime: the
//! PDF format's 14 built-in fonts are Latin-1 only, so CJK documents need a
//! real font embedded. Layout is deliberately naive — A4 portrait, fixed
//! margins, per-size width-aware character wrapping (CJK counts double), no
//! hyphenation — a readable printout, not typesetting.

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

/// Render `doc` to a PDF at `path` (written atomically).
pub fn document_to_pdf(doc: &Document, path: &str) -> AppResult<()> {
    let font_path = find_font().ok_or_else(|| {
        AppError::Other(
            "PDF export needs a Unicode TTF font on this system — looked for Arial Unicode, \
             Noto Sans CJK, and DejaVu Sans in the standard font folders."
                .to_string(),
        )
    })?;
    let (pdf, page1, layer1) =
        PdfDocument::new(doc.title.trim(), Mm(PAGE_W_MM), Mm(PAGE_H_MM), "Layer 1");
    let file = std::fs::File::open(font_path)?;
    let font = pdf
        .add_external_font(std::io::BufReader::new(file))
        .map_err(|e| AppError::Other(format!("PDF export could not embed '{font_path}': {e}")))?;
    let layer = pdf.get_page(page1).get_layer(layer1);
    let mut w = PdfWriter { pdf, font, layer, y: PAGE_H_MM - MARGIN_MM };

    if !doc.title.trim().is_empty() {
        w.wrapped(doc.title.trim(), TITLE_PT);
        w.gap();
    }
    for chunk in &doc.chunks {
        if chunk.is_heading() {
            let size = heading_pt(chunk.metadata.level.unwrap_or(1).clamp(1, 3));
            w.wrapped(chunk.content.trim(), size);
        } else if chunk.is_image() {
            // No raster embedding (yet) — a labelled placeholder, like txt export.
            let caption = chunk.metadata.summary.clone().unwrap_or_default();
            w.wrapped(&format!("[Image: {caption}]"), BODY_PT);
        } else {
            // Text paragraphs and diagram source alike: lines as-is, wrapped.
            w.wrapped(&chunk.content, BODY_PT);
        }
        w.gap();
    }

    let bytes = w
        .pdf
        .save_to_bytes()
        .map_err(|e| AppError::Other(format!("PDF export failed: {e}")))?;
    crate::fileio::write_atomic(path, &bytes)
}

/// Cursor over the growing document: current layer plus the baseline `y`
/// (mm from the page bottom, moving downward), breaking pages as it goes.
struct PdfWriter {
    pdf: PdfDocumentReference,
    font: IndirectFontRef,
    layer: PdfLayerReference,
    y: f32,
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
        document_to_pdf(&doc, path.to_str().unwrap()).expect("export pdf");
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
    }
}
