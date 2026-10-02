//! PPTX (Office Open XML) export, written by hand (no external pptx crate).
//!
//! A `Deck` is serialized into a minimal, valid `.pptx` zip that opens in
//! PowerPoint / Keynote / Google Slides. We emit explicit absolute-positioned
//! shapes (`p:sp` text boxes, `p:pic` images) per slide rather than relying on
//! slide-master placeholder inheritance — the simplest robust path, and the
//! text stays editable. Geometry is computed in code (EMU); the layout template
//! is chosen upstream in `deck::document_to_deck`.
//!
//! Slide BODY text (prose chunks, detached `slideBody` lines, and the section
//! layout's subtitle fallback) is converted from Markdown by `slidetext` (the
//! golden-locked twin of the preview's `slideText.ts`): list items become
//! separate paragraphs (level → `lvl`/indent, numbered label as text), fences
//! become monospace lines without a bullet, inline bold/italic/code become run
//! properties, and soft breaks become `<a:br/>`. http(s)/mailto links get a
//! per-slide external hyperlink relationship (`rIdL1`, `rIdL2`, … — a separate
//! id namespace from the layout/image/notes `rIdN` ids); any other link target
//! is exported as plain text and counted in a warning. Slide titles and
//! explicit subtitle chunks are still written verbatim (Markdown there is
//! planned).

use crate::error::{AppError, AppResult};
use crate::imageio::{decode_image, fit, image_ext};
use crate::models::{Chunk, Deck, Slide, CHUNK_TYPE_TEXT};
use crate::slidetext::{
    chunk_to_paragraphs, is_clickable_href, paragraph_lines, visible_text, ParaKind, Run, SlidePara,
};
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

// English Metric Units. 914400 EMU = 1 inch, 12700 = 1 pt.
const SLIDE_W: i64 = 12_192_000; // 16:9
const SLIDE_H: i64 = 6_858_000;
const MARGIN: i64 = 685_800; // 0.75 in
const BODY_Y: i64 = 1_600_200;
// Height reserved for an explicit subtitle's own shape on every non-section
// layout (section has its own, differently-sized Subtitle box already). Body/
// image content starts BODY_Y + SUBTITLE_H down when a subtitle is present —
// mirrors the frontend, where the subtitle is a separate full-width element
// in normal document flow, ABOVE the bullets/image, not merged into them.
const SUBTITLE_H: i64 = 700_000;
/// Gutter between grid cells when a slide shows multiple images: 114300 EMU
/// (0.125 in) == exactly 12px in the frontend's 1280×720 preview frame, per the
/// multi-image grid contract shared with `SlideEditor.tsx`.
const IMAGE_GRID_GAP: i64 = 114_300;
/// At most this many visuals render per slide; extras are counted and warned.
const MAX_VISUALS: usize = 6;

/// Outcome of an export: how many slides were written and any non-fatal notes
/// (e.g. images that couldn't be embedded, diagram chunks not yet supported).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PptxReport {
    pub slides: usize,
    pub warnings: Vec<String>,
}

/// Build the `.pptx` bytes for a deck, plus any non-fatal warnings. Call
/// `imageio::resolve_remote_images` first so remote image URLs become embeddable.
pub fn deck_to_pptx(deck: &Deck) -> AppResult<(Vec<u8>, Vec<String>)> {
    let n = deck.slides.len();

    // Tally what the layout can't carry yet, so the caller can surface it. Image
    // outcomes (failed fetch / unsupported format / extras) and bullet overflow
    // are recorded per-slide in `build_slide`; diagrams without a rendered
    // snapshot are counted up front (the frontend injects `renderedImage` at
    // export time; a snapshot-carrying diagram joins its slide's visuals).
    let diagrams: usize = deck
        .slides
        .iter()
        .flat_map(|s| &s.chunks)
        .filter(|c| c.is_diagram() && !has_rendered_image(c))
        .count();
    let mut stats = ExportStats::default();
    let mut buf = Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(&mut buf);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let add = |zip: &mut ZipWriter<&mut Cursor<Vec<u8>>>, name: &str, data: &[u8]| -> AppResult<()> {
        zip.start_file(name, opts)
            .map_err(|e| AppError::Other(format!("PPTX zip error: {e}")))?;
        zip.write_all(data)?;
        Ok(())
    };

    // Slide numbers (1-based) that carry non-empty speaker notes, so the
    // content-types manifest declares a notesSlideN.xml override ONLY for
    // slides that actually get one — no empty notesSlide parts.
    let notes_slide_numbers: Vec<usize> = deck
        .slides
        .iter()
        .enumerate()
        .filter(|(_, s)| !s.notes.trim().is_empty())
        .map(|(i, _)| i + 1)
        .collect();

    add(
        &mut zip,
        "[Content_Types].xml",
        content_types(n, &notes_slide_numbers).as_bytes(),
    )?;
    add(&mut zip, "_rels/.rels", PACKAGE_RELS.as_bytes())?;
    add(&mut zip, "docProps/core.xml", core_xml(&deck.title).as_bytes())?;
    add(&mut zip, "docProps/app.xml", app_xml(n).as_bytes())?;
    add(&mut zip, "ppt/presentation.xml", presentation_xml(n).as_bytes())?;
    add(
        &mut zip,
        "ppt/_rels/presentation.xml.rels",
        presentation_rels(n).as_bytes(),
    )?;
    add(&mut zip, "ppt/theme/theme1.xml", THEME.as_bytes())?;
    add(
        &mut zip,
        "ppt/slideMasters/slideMaster1.xml",
        SLIDE_MASTER.as_bytes(),
    )?;
    add(
        &mut zip,
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        SLIDE_MASTER_RELS.as_bytes(),
    )?;
    add(
        &mut zip,
        "ppt/slideLayouts/slideLayout1.xml",
        SLIDE_LAYOUT.as_bytes(),
    )?;
    add(
        &mut zip,
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        SLIDE_LAYOUT_RELS.as_bytes(),
    )?;

    let mut media_counter = 0usize;
    for (i, slide) in deck.slides.iter().enumerate() {
        let (sp_tree, images, links) = build_slide(slide, &mut media_counter, &mut stats);
        let n1 = i + 1;
        let has_notes = !slide.notes.trim().is_empty();
        add(
            &mut zip,
            &format!("ppt/slides/slide{n1}.xml"),
            slide_xml(&sp_tree).as_bytes(),
        )?;
        add(
            &mut zip,
            &format!("ppt/slides/_rels/slide{n1}.xml.rels"),
            slide_rels(&images, has_notes.then_some(n1), &links.targets).as_bytes(),
        )?;
        for img in &images {
            add(&mut zip, &format!("ppt/media/{}", img.file), &img.bytes)?;
        }
        if has_notes {
            add(
                &mut zip,
                &format!("ppt/notesSlides/notesSlide{n1}.xml"),
                notes_slide_xml(&slide.notes).as_bytes(),
            )?;
            add(
                &mut zip,
                &format!("ppt/notesSlides/_rels/notesSlide{n1}.xml.rels"),
                notes_slide_rels(n1).as_bytes(),
            )?;
        }
    }

    zip.finish()
        .map_err(|e| AppError::Other(format!("PPTX zip error: {e}")))?;

    let mut warnings = Vec::new();
    if stats.fetch_failed > 0 {
        warnings.push(format!(
            "{} image(s) couldn't be downloaded and were left out.",
            stats.fetch_failed
        ));
    }
    if stats.local_unresolved > 0 {
        warnings.push(format!(
            "{} local image(s) couldn't be read from the document's folder and were left out.",
            stats.local_unresolved
        ));
    }
    if stats.unsupported_format > 0 {
        warnings.push(format!(
            "{} image(s) use a format PowerPoint can't embed (e.g. WEBP or SVG) and were left out.",
            stats.unsupported_format
        ));
    }
    if stats.extra_images > 0 {
        warnings.push(format!(
            "{} extra image(s) were left out — only the first 6 images per slide are exported.",
            stats.extra_images
        ));
    }
    if stats.layout_dropped > 0 {
        warnings.push(format!(
            "{} image(s) were left out — their slide's layout has no image area.",
            stats.layout_dropped
        ));
    }
    if stats.overflow_slides > 0 {
        warnings.push(format!(
            "{} slide(s) have more text than fits and may be cut off — consider splitting them.",
            stats.overflow_slides
        ));
    }
    if stats.unlinked_links > 0 {
        warnings.push(format!(
            "{} link(s) don't point to a web or mail address and were exported as plain text.",
            stats.unlinked_links
        ));
    }
    if diagrams > 0 {
        warnings.push(format!(
            "{diagrams} diagram(s) had no rendered snapshot and were left out — export from the app (not the CLI) to include them."
        ));
    }
    Ok((buf.into_inner(), warnings))
}

// ----- per-slide shape tree -------------------------------------------------

struct SlideImage {
    rid: String,
    file: String,
    bytes: Vec<u8>,
}

/// Per-export tally of content that the layout couldn't carry, so the caller can
/// surface a *specific* warning for each cause (A7) instead of one conflated note.
#[derive(Default)]
struct ExportStats {
    /// Image chunks whose bytes couldn't be decoded (e.g. a remote fetch failed
    /// and the content was cleared).
    fetch_failed: usize,
    /// Image chunks still holding a local file reference (a document-relative
    /// path or `file:` URL) — the GUI inlines readable ones before export
    /// (fileActions `withEmbeddedLocalImages`), the CLI via
    /// `imageio::embed_local_images`; the MCP export resolves none (planned).
    local_unresolved: usize,
    /// Image chunks in a format PowerPoint can't embed (WEBP/SVG/unknown).
    unsupported_format: usize,
    /// Visuals dropped because the slide already showed `MAX_VISUALS` of them.
    extra_images: usize,
    /// Visuals dropped because the slide's layout has no image area.
    layout_dropped: usize,
    /// Slides whose estimated bullet text likely overflows the body box.
    overflow_slides: usize,
    /// Markdown links whose target isn't http(s)/mailto, written as plain text.
    unlinked_links: usize,
}

/// A slide's external hyperlink targets, in first-use order; target `k`
/// (0-based) is relationship `rIdL{k+1}` in the slide's .rels.
#[derive(Default)]
struct SlideLinks {
    targets: Vec<String>,
}

impl SlideLinks {
    fn rid_for(&mut self, href: &str) -> String {
        let k = match self.targets.iter().position(|t| t == href) {
            Some(k) => k,
            None => {
                self.targets.push(href.to_string());
                self.targets.len() - 1
            }
        };
        format!("rIdL{}", k + 1)
    }
}

/// An undecodable image payload that is a local file reference rather than
/// inline data or a remote URL. Mirrors `resolveImageSource` in
/// src/localImages.ts: a `file:` URL is local; any OTHER explicit scheme
/// (`http:`, `https:`, `data:`, ...) is not. A scheme-less payload is local
/// when it has no `base64,` marker and contains a `.` (never in base64 — a
/// file extension) or a `\`. `/` alone is NOT a signal: bare base64 has it.
pub(crate) fn looks_like_local_path(payload: &str) -> bool {
    let p = payload.trim();
    if p.get(..5).is_some_and(|s| s.eq_ignore_ascii_case("file:")) {
        return true;
    }
    if has_url_scheme(p) {
        return false;
    }
    !p.contains("base64,") && (p.contains('.') || p.contains('\\'))
}

/// `^[a-z][a-z0-9+.-]*:` (case-insensitive) — an explicit URL scheme.
fn has_url_scheme(s: &str) -> bool {
    let Some(colon) = s.find(':') else {
        return false;
    };
    let mut chars = s[..colon].chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

fn is_text(c: &Chunk) -> bool {
    c.metadata.chunk_type == CHUNK_TYPE_TEXT
}

/// A diagram chunk carrying a rendered snapshot (see `ChunkMetadata::rendered_image`).
fn has_rendered_image(c: &Chunk) -> bool {
    c.metadata
        .rendered_image
        .as_deref()
        .is_some_and(|r| !r.trim().is_empty())
}

/// The slide's lead chunk: its heading, else its first chunk. Rust twin of TS
/// `slideLead` (src/slides.ts) — where slide-level overrides live.
fn slide_lead(slide: &Slide) -> Option<&Chunk> {
    slide.chunks.iter().find(|c| c.is_heading()).or_else(|| slide.chunks.first())
}

/// The slide body as converted paragraphs (BUG-020). Mirrors TS
/// `slideParagraphs` / `slideBullets` (src/slides.ts): the LEAD chunk's
/// `slideBody` lines when it has them (a detached slide; read from `slide_lead`
/// only, like TS `slideLead`, so a stray `slide_body` on any other chunk is
/// ignored — independent of deck.rs's normalisation), else every non-subtitle
/// text chunk — each trimmed, blanks skipped — through `chunk_to_paragraphs`.
fn body_paragraphs(slide: &Slide) -> Vec<SlidePara> {
    // Req 2: a "detached" slide renders its own `slideBody` lines (a summary /
    // custom content) instead of the linked editor paragraphs.
    let sources: Vec<&str> = match slide_lead(slide).and_then(|c| c.metadata.slide_body.as_ref()) {
        Some(body) => body.iter().map(|b| b.trim()).collect(),
        None => slide
            .chunks
            .iter()
            .filter(|c| is_text(c) && !c.is_subtitle())
            .map(|c| c.content.trim())
            .collect(),
    };
    sources
        .into_iter()
        .filter(|t| !t.is_empty())
        .flat_map(chunk_to_paragraphs)
        .collect()
}

fn build_slide(
    slide: &Slide,
    media_counter: &mut usize,
    stats: &mut ExportStats,
) -> (String, Vec<SlideImage>, SlideLinks) {
    let mut shapes = String::new();
    let mut images = Vec::new();
    let mut links = SlideLinks::default();
    let mut sid: u32 = 2; // shape id 1 is the group

    let heading = slide
        .chunks
        .iter()
        .find(|c| c.is_heading())
        .map(|c| c.content.clone());
    // Req 3: an explicit subtitle chunk (section falls back to the first bullet).
    let subtitle_text: Option<String> = slide
        .chunks
        .iter()
        .find(|c| c.is_subtitle())
        .map(|c| c.content.clone());
    let paras = body_paragraphs(slide);
    // The slide's "visuals": image chunks with non-empty content, plus diagram
    // chunks carrying a rendered snapshot (`renderedImage`, injected by the
    // frontend at export time), ordered by (slot ?? MAX) then document order
    // (stable sort). MUST stay identical to the preview grid in
    // `SlideEditor.tsx` — an empty content string (e.g. a remote fetch that
    // already failed and was cleared — see `decode_image`) is NOT a visual, so
    // it never reserves a blank image region the frontend doesn't show.
    let mut visuals: Vec<(&Chunk, &str)> = slide
        .chunks
        .iter()
        .filter_map(|c| {
            if c.is_image() && !c.content.trim().is_empty() {
                Some((c, c.content.as_str()))
            } else if c.is_diagram() {
                c.metadata
                    .rendered_image
                    .as_deref()
                    .filter(|r| !r.trim().is_empty())
                    .map(|r| (c, r))
            } else {
                None
            }
        })
        .collect();
    visuals.sort_by_key(|(c, _)| c.metadata.slot.unwrap_or(u32::MAX));
    // Image chunks whose content is empty aren't visuals but must still be
    // surfaced as failures, not silently lost (A7).
    let empty_images = slide
        .chunks
        .iter()
        .filter(|c| c.is_image() && c.content.trim().is_empty())
        .count();
    let has_visuals = !visuals.is_empty();
    // Non-section layouts push their content down by a fixed subtitle-box
    // height when an explicit subtitle is set (mirrors the frontend, where
    // the subtitle is its own full-width element in normal document flow,
    // ABOVE the bullets/image — not merged into their box). `section` has its
    // own separately-sized Subtitle box below and ignores this.
    let content_y = BODY_Y + if subtitle_text.is_some() { SUBTITLE_H } else { 0 };
    let content_avail_h = SLIDE_H - content_y - MARGIN;

    // A7: estimate whether the bullets overflow the body box (bullet layouts
    // only). A char-count heuristic — approximate, but enough to warn the user
    // that text may be clipped so they can split the slide. Only counts a
    // layout's narrower/shorter box when it's actually rendered that way (i.e.
    // a visual shows) — see the no-visual fallback in the layout match below,
    // which renders full-width instead.
    if slide.layout != "section" {
        let (cpl, base_max_lines): (usize, usize) = match slide.layout.as_str() {
            "title-image" | "title-image-left" if has_visuals => (60, 14),
            "image-top" if has_visuals => (110, 6),
            _ => (110, 14),
        };
        // Scale down proportionally to how much a subtitle box shrank this
        // layout's available height, instead of a flat +1 line — the subtitle
        // no longer shares the bullets' own box, so it no longer costs the
        // bullets a line of THEIR box; it costs them a share of the height.
        let base_avail = SLIDE_H - BODY_Y - MARGIN;
        let max_lines = ((base_max_lines as i64) * content_avail_h / base_avail).max(1) as usize;
        // Visible text of the converted paragraphs (markers and link URLs
        // never count) — the same `paragraph_lines` the rail badge uses.
        if paragraph_lines(&paras, cpl) > max_lines {
            stats.overflow_slides += 1;
        }
    }

    // Section slides have no Body shape: only their subtitle fallback is
    // written, so the body must not register links or count warnings here.
    let bullets_only: String = if slide.layout == "section" {
        String::new()
    } else {
        paras.iter().map(|p| para_xml(p, &mut links, stats)).collect()
    };

    match slide.layout.as_str() {
        "section" => {
            let title = heading
                .clone()
                .unwrap_or_else(|| paras.first().map(visible_text).unwrap_or_default());
            shapes.push_str(&text_box(
                sid,
                "Title",
                MARGIN,
                SLIDE_H / 2 - 1_143_000,
                SLIDE_W - 2 * MARGIN,
                1_143_000,
                &title_para(&title),
            ));
            sid += 1;
            // Explicit subtitle wins; else the first body paragraph
            // (positional fallback), converted like the preview renders it.
            let sub = match (&subtitle_text, paras.first()) {
                (Some(text), _) => Some(subtitle_para(text)),
                (None, Some(first)) => Some(subtitle_runs_para(first, &mut links, stats)),
                (None, None) => None,
            };
            if let Some(sub) = sub {
                shapes.push_str(&text_box(
                    sid,
                    "Subtitle",
                    MARGIN,
                    SLIDE_H / 2 + 50_000,
                    SLIDE_W - 2 * MARGIN,
                    900_000,
                    &sub,
                ));
            }
        }
        "title-image" | "title-image-left" => {
            if let Some(h) = &heading {
                shapes.push_str(&title_box(sid, h));
                sid += 1;
            }
            sid = push_subtitle_box(&mut shapes, sid, &subtitle_text);
            if !has_visuals {
                // No visual shows yet — render full-width, same as
                // "title-content". Mirrors the frontend (`SlideContent`), which
                // only reserves the image column when a visual actually shows,
                // so preview and export never disagree about a blank column. A
                // present-but-content-empty image chunk still gets counted
                // below so its failure is surfaced, not silently dropped (A7).
                shapes.push_str(&text_box(
                    sid,
                    "Body",
                    MARGIN,
                    content_y,
                    SLIDE_W - 2 * MARGIN,
                    content_avail_h,
                    &bullets_only,
                ));
            } else {
                let body_cx = (SLIDE_W - 2 * MARGIN) * 55 / 100;
                let gap = 400_050;
                let image_cx = SLIDE_W - 2 * MARGIN - body_cx - gap;
                // "-left" mirrors the box positions; sizes stay the same either way.
                let (body_x, image_x) = if slide.layout == "title-image-left" {
                    (MARGIN + image_cx + gap, MARGIN)
                } else {
                    (MARGIN, MARGIN + body_cx + gap)
                };
                shapes.push_str(&text_box(
                    sid,
                    "Body",
                    body_x,
                    content_y,
                    body_cx,
                    content_avail_h,
                    &bullets_only,
                ));
                sid += 1;
                let region = Rect { x: image_x, y: content_y, cx: image_cx, cy: content_avail_h };
                let (pic_shapes, embedded, _sid) =
                    embed_visuals(&visuals, sid, region, false, media_counter, stats);
                shapes.push_str(&pic_shapes);
                images.extend(embedded);
            }
        }
        "image-top" => {
            if let Some(h) = &heading {
                shapes.push_str(&title_box(sid, h));
                sid += 1;
            }
            sid = push_subtitle_box(&mut shapes, sid, &subtitle_text);
            if !has_visuals {
                // Same no-visual(-showing) fallback as title-image(-left) above.
                shapes.push_str(&text_box(
                    sid,
                    "Body",
                    MARGIN,
                    content_y,
                    SLIDE_W - 2 * MARGIN,
                    content_avail_h,
                    &bullets_only,
                ));
            } else {
                let image_cy = content_avail_h * 45 / 100;
                let gap = 160_020;
                let body_y = content_y + image_cy + gap;
                let body_cy = SLIDE_H - MARGIN - body_y;
                let region = Rect { x: MARGIN, y: content_y, cx: SLIDE_W - 2 * MARGIN, cy: image_cy };
                let (pic_shapes, embedded, next_sid) =
                    embed_visuals(&visuals, sid, region, true, media_counter, stats);
                shapes.push_str(&pic_shapes);
                sid = next_sid;
                images.extend(embedded);
                shapes.push_str(&text_box(
                    sid,
                    "Body",
                    MARGIN,
                    body_y,
                    SLIDE_W - 2 * MARGIN,
                    body_cy,
                    &bullets_only,
                ));
            }
        }
        _ => {
            // "title-content": title (+ optional subtitle box) + full-width bullets
            if let Some(h) = &heading {
                shapes.push_str(&title_box(sid, h));
                sid += 1;
            }
            sid = push_subtitle_box(&mut shapes, sid, &subtitle_text);
            shapes.push_str(&text_box(
                sid,
                "Body",
                MARGIN,
                content_y,
                SLIDE_W - 2 * MARGIN,
                content_avail_h,
                &bullets_only,
            ));
        }
    }

    // Visuals on a layout that doesn't render them (a section/title-content
    // slide) are dropped — surface that rather than lose them silently (A7).
    // Image-capable layouts instead surface their content-empty image chunks
    // (a remote fetch that already failed) as failed downloads.
    let renders_image = matches!(
        slide.layout.as_str(),
        "title-image" | "title-image-left" | "image-top"
    );
    if renders_image {
        stats.fetch_failed += empty_images;
    } else {
        stats.layout_dropped += visuals.len() + empty_images;
    }

    let sp_tree = format!(
        r#"<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>{shapes}"#
    );
    (sp_tree, images, links)
}

/// An EMU box (position + size) — groups the 4 geometry args that every
/// layout's image/text boxes pass around, so functions placing a shape don't
/// need one parameter per coordinate.
#[derive(Clone, Copy)]
struct Rect {
    x: i64,
    y: i64,
    cx: i64,
    cy: i64,
}

/// How many columns × rows the image region splits into for `n` visuals
/// (n ≤ `MAX_VISUALS`). `band` is true for the wide image-top strip, false for
/// the tall side column of title-image(-left). MUST stay identical to the
/// preview grid in `SlideEditor.tsx` (multi-image grid contract).
fn grid_dims(band: bool, n: usize) -> (usize, usize) {
    if band {
        match n {
            1 => (1, 1),
            2 => (2, 1),
            3 | 4 => (2, 2),
            _ => (3, 2),
        }
    } else {
        match n {
            1 => (1, 1),
            2 => (1, 2),
            3 | 4 => (2, 2),
            _ => (2, 3),
        }
    }
}

/// The `idx`-th (row-major) cell of `region` split into `cols` × `rows` with an
/// `IMAGE_GRID_GAP` gutter between cells.
fn grid_cell(region: Rect, cols: usize, rows: usize, idx: usize) -> Rect {
    let (cols_i, rows_i) = (cols as i64, rows as i64);
    let cw = (region.cx - (cols_i - 1) * IMAGE_GRID_GAP) / cols_i;
    let ch = (region.cy - (rows_i - 1) * IMAGE_GRID_GAP) / rows_i;
    let (col, row) = ((idx % cols) as i64, (idx / cols) as i64);
    Rect {
        x: region.x + col * (cw + IMAGE_GRID_GAP),
        y: region.y + row * (ch + IMAGE_GRID_GAP),
        cx: cw,
        cy: ch,
    }
}

/// Embed a slide's visuals inside `region`, subdividing it into the grid the
/// multi-image contract prescribes and aspect-fitting each image inside its
/// cell (`fit`). Shared by every image-capable layout (title-image,
/// title-image-left, image-top) so their region geometry is the only thing
/// that differs between them. Visuals beyond `MAX_VISUALS` are counted as
/// dropped extras; an undecodable/unsupported visual is counted and produces
/// no shape (A7 — always surfaced, never silently dropped), leaving its cell
/// empty. Returns the `<p:pic>` shapes XML, the media assets to write (each
/// with its own per-slide rel id: rId2, rId3, ...), and the next free shape id.
fn embed_visuals(
    visuals: &[(&Chunk, &str)],
    mut sid: u32,
    region: Rect,
    band: bool,
    media_counter: &mut usize,
    stats: &mut ExportStats,
) -> (String, Vec<SlideImage>, u32) {
    if visuals.len() > MAX_VISUALS {
        stats.extra_images += visuals.len() - MAX_VISUALS;
    }
    let shown = visuals.len().min(MAX_VISUALS);
    let (cols, rows) = grid_dims(band, shown);
    let mut shapes = String::new();
    let mut images: Vec<SlideImage> = Vec::new();
    for (idx, (_chunk, payload)) in visuals.iter().take(MAX_VISUALS).enumerate() {
        let Some(bytes) = decode_image(payload) else {
            if looks_like_local_path(payload) {
                stats.local_unresolved += 1;
            } else {
                stats.fetch_failed += 1;
            }
            continue;
        };
        let Some((ext, _kind)) = image_ext(&bytes) else {
            stats.unsupported_format += 1;
            continue;
        };
        *media_counter += 1;
        // rId1 is the slide-layout rel; images take rId2, rId3, ... per slide.
        let rid = format!("rId{}", 2 + images.len());
        let file = format!("image{}.{}", media_counter, ext);
        let cell = grid_cell(region, cols, rows, idx);
        let (x, y, cx, cy) = fit(&bytes, cell.x, cell.y, cell.cx, cell.cy);
        shapes.push_str(&picture(sid, &rid, x, y, cx, cy));
        sid += 1;
        images.push(SlideImage { rid, file, bytes });
    }
    (shapes, images, sid)
}

/// Push a full-width Subtitle shape right after the title, when an explicit
/// subtitle is set; returns the next free shape id (unchanged when there's no
/// subtitle). Shared by every non-section layout — `section` has its own,
/// differently-positioned Subtitle box (see the "section" match arm) and
/// doesn't call this. The subtitle is its OWN shape rather than folded into
/// the bullets' text box so it renders full-width, above the bullets/image,
/// matching the frontend's normal document flow.
fn push_subtitle_box(shapes: &mut String, sid: u32, subtitle: &Option<String>) -> u32 {
    match subtitle {
        None => sid,
        Some(sub) => {
            shapes.push_str(&text_box(
                sid,
                "Subtitle",
                MARGIN,
                BODY_Y,
                SLIDE_W - 2 * MARGIN,
                SUBTITLE_H,
                &subtitle_para(sub),
            ));
            sid + 1
        }
    }
}

// ----- shape / run builders -------------------------------------------------

fn esc(s: &str) -> String {
    // B1: strip characters the XML 1.0 `Char` production forbids BEFORE escaping.
    // C0 control characters (except tab/LF/CR) and the noncharacters U+FFFE/FFFF
    // are illegal inside `<a:t>`/`<dc:title>`; left in, PowerPoint reports the
    // .pptx as corrupt and offers "repair" — an unopenable file, produced
    // silently. Such characters are common in text pasted from PDFs. (Rust `char`
    // is always a Unicode scalar value, so surrogates can't occur here.)
    s.chars()
        .filter(|&c| {
            matches!(c,
                '\t' | '\n' | '\r'
                | '\u{20}'..='\u{D7FF}'
                | '\u{E000}'..='\u{FFFD}'
                | '\u{10000}'..='\u{10FFFF}')
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn title_para(text: &str) -> String {
    format!(
        r#"<a:p><a:pPr/><a:r><a:rPr lang="en-US" sz="2800" b="1" dirty="0"/><a:t>{}</a:t></a:r></a:p>"#,
        esc(text)
    )
}

fn subtitle_para(text: &str) -> String {
    format!(
        r#"<a:p><a:pPr/><a:r><a:rPr lang="en-US" sz="2000" dirty="0"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r></a:p>"#,
        esc(text)
    )
}

/// Extra left margin per list/quote nesting level (there is no master list
/// style, so `lvl` alone wouldn't indent).
const LEVEL_INDENT: i64 = 457_200;
/// Monospace face for code paragraphs and code runs.
const CODE_FONT: &str = "Menlo";

/// How a paragraph's runs are drawn, on top of each run's own flags.
#[derive(Clone, Copy)]
struct RunStyle {
    sz: u32,
    mono: bool,
    italic: bool,
    /// A theme color for non-link text (`tx2` for quotes and subtitles).
    color: Option<&'static str>,
}

/// One `SlidePara` → one `<a:p>`. Bullets keep the `•` glyph; numbered items
/// show their label as text (no auto-numbering); code/plain have no bullet and
/// no indent; quotes are indented, italic and `tx2`. Empty paragraphs (a blank
/// code line) keep their line via `endParaRPr`.
fn para_xml(p: &SlidePara, links: &mut SlideLinks, stats: &mut ExportStats) -> String {
    let level = p.level as i64;
    let lvl = if p.level > 0 { format!(r#" lvl="{}""#, p.level) } else { String::new() };
    let mar_l = 285_750 + level * LEVEL_INDENT;
    let (ppr, style) = match p.kind {
        ParaKind::Bullet => (
            format!(r#"<a:pPr marL="{mar_l}"{lvl} indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>"#),
            RunStyle { sz: 1800, mono: false, italic: false, color: None },
        ),
        ParaKind::Numbered => (
            format!(r#"<a:pPr marL="{mar_l}"{lvl} indent="-285750"><a:buNone/></a:pPr>"#),
            RunStyle { sz: 1800, mono: false, italic: false, color: None },
        ),
        ParaKind::Quote => (
            format!(r#"<a:pPr marL="{mar_l}"{lvl} indent="0"><a:buNone/></a:pPr>"#),
            RunStyle { sz: 1800, mono: false, italic: true, color: Some("tx2") },
        ),
        ParaKind::Code => (
            r#"<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>"#.to_string(),
            RunStyle { sz: 1600, mono: true, italic: false, color: None },
        ),
        ParaKind::Plain => (
            r#"<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>"#.to_string(),
            RunStyle { sz: 1800, mono: false, italic: false, color: None },
        ),
    };
    let mut body = String::new();
    if let Some(label) = &p.label {
        let label_run = Run { text: format!("{label} "), bold: false, italic: false, code: false, href: None };
        body.push_str(&runs_xml(std::slice::from_ref(&label_run), style, links, stats));
    }
    body.push_str(&runs_xml(&p.runs, style, links, stats));
    if body.is_empty() {
        return format!(r#"<a:p>{ppr}<a:endParaRPr lang="en-US" sz="{}"/></a:p>"#, style.sz);
    }
    format!("<a:p>{ppr}{body}</a:p>")
}

/// The section layout's subtitle fallback: the first body paragraph's runs in
/// subtitle styling (no bullet).
fn subtitle_runs_para(p: &SlidePara, links: &mut SlideLinks, stats: &mut ExportStats) -> String {
    let style = RunStyle { sz: 2000, mono: p.kind == ParaKind::Code, italic: false, color: Some("tx2") };
    format!("<a:p><a:pPr/>{}</a:p>", runs_xml(&p.runs, style, links, stats))
}

/// Runs → `<a:r>` elements. A `\n` inside run text becomes `<a:br/>`. Child
/// order inside `<a:rPr>` is schema-enforced: solidFill, latin, hlinkClick.
fn runs_xml(runs: &[Run], style: RunStyle, links: &mut SlideLinks, stats: &mut ExportStats) -> String {
    let mut out = String::new();
    let mut prev_href: Option<&str> = None;
    for run in runs {
        let rid = match run.href.as_deref() {
            Some(href) if is_clickable_href(href) => Some(links.rid_for(&href.replace(' ', "%20"))),
            Some(href) => {
                // Count each unclickable link once, not once per styled run.
                if prev_href != Some(href) {
                    stats.unlinked_links += 1;
                }
                None
            }
            None => None,
        };
        prev_href = run.href.as_deref();
        let mut attrs = format!(r#" lang="en-US" sz="{}""#, style.sz);
        if run.bold {
            attrs.push_str(r#" b="1""#);
        }
        if run.italic || style.italic {
            attrs.push_str(r#" i="1""#);
        }
        if rid.is_some() {
            attrs.push_str(r#" u="sng""#);
        }
        let mut children = String::new();
        if rid.is_some() {
            children.push_str(r#"<a:solidFill><a:schemeClr val="hlink"/></a:solidFill>"#);
        } else if let Some(color) = style.color {
            children.push_str(&format!(r#"<a:solidFill><a:schemeClr val="{color}"/></a:solidFill>"#));
        }
        if run.code || style.mono {
            children.push_str(&format!(r#"<a:latin typeface="{CODE_FONT}"/>"#));
        }
        if let Some(rid) = &rid {
            children.push_str(&format!(r#"<a:hlinkClick r:id="{rid}"/>"#));
        }
        let rpr = if children.is_empty() {
            format!(r#"<a:rPr{attrs} dirty="0"/>"#)
        } else {
            format!(r#"<a:rPr{attrs} dirty="0">{children}</a:rPr>"#)
        };
        for (k, seg) in run.text.split('\n').enumerate() {
            if k > 0 {
                out.push_str("<a:br/>");
            }
            if !seg.is_empty() {
                out.push_str(&format!("<a:r>{rpr}<a:t>{}</a:t></a:r>", esc(seg)));
            }
        }
    }
    out
}

fn title_box(id: u32, text: &str) -> String {
    text_box(
        id,
        "Title",
        MARGIN,
        365_760,
        SLIDE_W - 2 * MARGIN,
        1_000_000,
        &title_para(text),
    )
}

fn text_box(id: u32, name: &str, x: i64, y: i64, cx: i64, cy: i64, paras: &str) -> String {
    let body = if paras.is_empty() {
        r#"<a:p><a:endParaRPr lang="en-US"/></a:p>"#.to_string()
    } else {
        paras.to_string()
    };
    format!(
        r#"<p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>{body}</p:txBody></p:sp>"#,
        id = id,
        name = esc(name),
    )
}

fn picture(id: u32, rid: &str, x: i64, y: i64, cx: i64, cy: i64) -> String {
    format!(
        r#"<p:pic><p:nvPicPr><p:cNvPr id="{id}" name="Image {id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>"#
    )
}

// ----- per-slide XML --------------------------------------------------------

fn slide_xml(sp_tree: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>{sp_tree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#
    )
}

/// `notes_slide_num`: `Some(n1)` when this slide has a `ppt/notesSlides/notesSlideN1.xml`
/// part to link to (its own 1-based slide number — notesSlides are numbered to
/// match their owning slide, so N1 == the slide's own number), `None` when it has none.
/// `links`: external hyperlink targets; target `k` becomes `rIdL{k+1}` (see
/// `SlideLinks`), a namespace that can't collide with the layout/image/notes ids.
fn slide_rels(images: &[SlideImage], notes_slide_num: Option<usize>, links: &[String]) -> String {
    let mut rels = String::from(
        r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>"#,
    );
    for img in images {
        rels.push_str(&format!(
            r#"<Relationship Id="{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/{file}"/>"#,
            rid = img.rid,
            file = img.file
        ));
    }
    if let Some(n) = notes_slide_num {
        // rId1 is the layout, rId2.. are images (see `embed_visuals`) — the
        // notesSlide relationship takes the next free id after all of them.
        let rid = format!("rId{}", 2 + images.len());
        rels.push_str(&format!(
            r#"<Relationship Id="{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide{n}.xml"/>"#
        ));
    }
    for (k, target) in links.iter().enumerate() {
        rels.push_str(&format!(
            r#"<Relationship Id="rIdL{n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="{target}" TargetMode="External"/>"#,
            n = k + 1,
            target = esc(target)
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>"#
    )
}

// ----- fixed package parts --------------------------------------------------

fn content_types(n_slides: usize, notes_slide_numbers: &[usize]) -> String {
    let mut overrides = String::new();
    for i in 1..=n_slides {
        overrides.push_str(&format!(
            r#"<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>"#
        ));
    }
    // Only slides that actually carry notes get a notesSlideN.xml override —
    // no empty notesSlide parts are ever written (see `deck_to_pptx`).
    for n in notes_slide_numbers {
        overrides.push_str(&format!(
            r#"<Override PartName="/ppt/notesSlides/notesSlide{n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>"#
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="bmp" ContentType="image/bmp"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>{overrides}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>"#
    )
}

// ----- speaker notes (notesSlide) -------------------------------------------
//
// KNOWN LIMITATION: this emits a minimal notesSlide part with its own
// slideLayout-less `<p:notes>` tree and a rels file that points ONLY back to
// its owning slide — there is no `ppt/notesMasters/notesMaster1.xml` part and
// no presentation-level `notesMasterIdLst`. A full OOXML notes reference chain
// (presentation → notesMaster → notesLayout) is more than this minimal writer
// implements; PowerPoint, Keynote and LibreOffice all tolerate a notesSlide
// part without a separate notesMaster (they fall back to a default notes
// layout), so the notes text is readable, but a notesMaster-driven custom
// notes page design is NOT supported. Only emitted for slides with non-empty
// notes (see `deck_to_pptx`) — a slide with no notes gets no notesSlide part.
fn notes_slide_xml(notes: &str) -> String {
    let paras: String = notes
        .split('\n')
        .map(|line| {
            if line.trim().is_empty() {
                r#"<a:p><a:endParaRPr lang="en-US"/></a:p>"#.to_string()
            } else {
                format!(
                    r#"<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>{}</a:t></a:r></a:p>"#,
                    esc(line)
                )
            }
        })
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"#
    )
}

fn notes_slide_rels(slide_num: usize) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide{slide_num}.xml"/></Relationships>"#
    )
}

const PACKAGE_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>"#;

fn presentation_xml(n_slides: usize) -> String {
    let mut ids = String::new();
    for i in 0..n_slides {
        ids.push_str(&format!(
            r#"<p:sldId id="{sid}" r:id="rId{rid}"/>"#,
            sid = 256 + i,
            rid = 2 + i
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx="{w}" cy="{h}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>"#,
        w = SLIDE_W,
        h = SLIDE_H
    )
}

fn presentation_rels(n_slides: usize) -> String {
    let mut rels = String::from(
        r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>"#,
    );
    for i in 0..n_slides {
        rels.push_str(&format!(
            r#"<Relationship Id="rId{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{n}.xml"/>"#,
            rid = 2 + i,
            n = i + 1
        ));
    }
    rels.push_str(&format!(
        r#"<Relationship Id="rId{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>"#,
        rid = 2 + n_slides
    ));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>"#
    )
}

const SLIDE_MASTER: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>"#;

const SLIDE_MASTER_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>"#;

const SLIDE_LAYOUT: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#;

const SLIDE_LAYOUT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>"#;

const THEME: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="aix"><a:themeElements><a:clrScheme name="aix"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2933"/></a:dk2><a:lt2><a:srgbClr val="F4F5F7"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="0F9D58"/></a:accent2><a:accent3><a:srgbClr val="F4B400"/></a:accent3><a:accent4><a:srgbClr val="DB4437"/></a:accent4><a:accent5><a:srgbClr val="9333EA"/></a:accent5><a:accent6><a:srgbClr val="FF6D00"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="9333EA"/></a:folHlink></a:clrScheme><a:fontScheme name="aix"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="aix"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>"#;

fn core_xml(title: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>{title}</dc:title><dc:creator>NurumayuEditor</dc:creator><cp:lastModifiedBy>NurumayuEditor</cp:lastModifiedBy></cp:coreProperties>"#,
        title = esc(title)
    )
}

fn app_xml(n_slides: usize) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>NurumayuEditor</Application><Slides>{n}</Slides><PresentationFormat>Widescreen</PresentationFormat></Properties>"#,
        n = n_slides
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::document_to_deck;
    use crate::models::{Chunk, Document};

    #[test]
    fn document_exports_to_valid_pptx_zip() {
        let mut doc = Document::new("Test Deck");
        doc.chunks.push(Chunk::new_heading(0, 1, "Section One"));
        doc.chunks.push(Chunk::new_text(1, "First bullet"));
        doc.chunks.push(Chunk::new_text(2, "Second & <special> \"quote\""));
        let deck = document_to_deck(&doc);
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build pptx");
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        if std::env::var("PPTX_DUMP").is_ok() {
            std::fs::write("/tmp/aix_real.pptx", &bytes).ok();
        }

        assert!(bytes.starts_with(b"PK"), "not a zip");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("open zip");
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        for req in [
            "[Content_Types].xml",
            "_rels/.rels",
            "ppt/presentation.xml",
            "ppt/slides/slide1.xml",
            "ppt/theme/theme1.xml",
            "ppt/slideMasters/slideMaster1.xml",
        ] {
            assert!(names.iter().any(|n| n == req), "missing part {req}");
        }
    }

    #[test]
    fn unresolved_image_is_reported_not_silently_dropped() {
        // An image chunk whose content is a remote URL (unresolved here, as a
        // failed fetch would leave it) must produce a visible warning.
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Has a picture"));
        doc.chunks.push(Chunk::new_text(1, "caption"));
        let mut img = Chunk::new_text(2, "https://example.com/x.png");
        img.metadata.chunk_type = crate::models::CHUNK_TYPE_IMAGE.to_string();
        doc.chunks.push(img);
        let deck = document_to_deck(&doc);
        let (_bytes, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(
            warnings.iter().any(|w| w.contains("image")),
            "expected an image warning, got {warnings:?}"
        );
    }

    // ----- B1: control-character stripping -----

    #[test]
    fn esc_strips_c0_controls_keeps_tab_nl_cr() {
        let input = "a\u{0}b\u{1}c\u{8}\u{B}\u{C}\u{1F}d\te\nf\rg";
        assert_eq!(esc(input), "abcd\te\nf\rg");
    }

    #[test]
    fn esc_drops_noncharacters_keeps_unicode() {
        // U+FFFE/U+FFFF are illegal in XML; astral chars (U+1F600) must survive.
        assert_eq!(esc("x\u{FFFE}y\u{FFFF}z日本😀"), "xyz日本😀");
    }

    #[test]
    fn esc_escapes_xml_entities() {
        assert_eq!(esc("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
    }

    #[test]
    fn export_with_control_chars_produces_legal_xml() {
        // A document whose title and body carry C0 control chars must still
        // produce slide/core XML with no illegal bytes (otherwise PowerPoint
        // reports the file as corrupt).
        let mut doc = Document::new("Title\u{7}with\u{1}bell");
        doc.chunks.push(Chunk::new_heading(0, 1, "Head\u{8}ing"));
        doc.chunks.push(Chunk::new_text(1, "body\u{1F}text\u{0}here"));
        let deck = document_to_deck(&doc);
        let (bytes, _w) = deck_to_pptx(&deck).expect("build");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        for part in ["ppt/slides/slide1.xml", "docProps/core.xml"] {
            use std::io::Read;
            let mut s = String::new();
            zip.by_name(part).unwrap().read_to_string(&mut s).unwrap();
            assert!(
                !s.bytes()
                    .any(|b| b < 0x20 && b != b'\t' && b != b'\n' && b != b'\r'),
                "{part} still contains an illegal control byte"
            );
        }
    }

    // ----- B5 / A7: embed + warning integration -----
    // (image_ext / image_size / fit unit tests moved to `imageio.rs` with the
    // functions themselves.)

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
    fn gif_image_embedded_with_gif_part() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Pic"));
        doc.chunks
            .push(image_chunk(1, data_url("image/gif", b"GIF89a\x04\x00\x02\x00\x80\x00\x00")));
        let deck = document_to_deck(&doc);
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let parts: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(parts.iter().any(|n| n == "ppt/media/image1.gif"), "no gif media part: {parts:?}");
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
    }

    #[test]
    fn relative_path_image_reports_local_not_download() {
        // G11: an unresolved document-relative figure (what the CLI sees, or
        // the GUI when the file couldn't be read) is a LOCAL image that
        // couldn't be read — never a failed download.
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Pic"));
        doc.chunks.push(Chunk::new_text(1, "a bullet"));
        doc.chunks.push(image_chunk(2, "figures/x.png".to_string()));
        doc.chunks.push(Chunk::new_heading(3, 1, "Pic 2"));
        doc.chunks.push(image_chunk(4, "file:///Users/me/fig%201.jpg".to_string()));
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides[0].layout, "title-image");
        let (_bytes, warnings) = deck_to_pptx(&deck).expect("build");
        let local: Vec<&String> = warnings
            .iter()
            .filter(|w| w.starts_with("2 local image(s)"))
            .collect();
        assert_eq!(
            local,
            vec!["2 local image(s) couldn't be read from the document's folder and were left out."],
            "warnings: {warnings:?}"
        );
        assert!(
            !warnings.iter().any(|w| w.contains("couldn't be downloaded")),
            "a local path is not a download: {warnings:?}"
        );
    }

    #[test]
    fn unresolved_remote_or_scheme_payloads_are_not_local_images() {
        // A remote URL that reached the writer unresolved (deck_to_pptx called
        // without resolve_remote_images, or an upper-case scheme the resolver
        // skips) and a non-base64 data: URL contain '.', but are not local
        // files — only a `file:` scheme or a scheme-less path is.
        for payload in [
            "https://e.x/i.png",
            "HTTPS://e.x/i.png",
            "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
        ] {
            let mut doc = Document::new("D");
            doc.chunks.push(Chunk::new_heading(0, 1, "Pic"));
            doc.chunks.push(image_chunk(1, payload.to_string()));
            let deck = document_to_deck(&doc);
            let (_bytes, warnings) = deck_to_pptx(&deck).expect("build");
            assert!(
                !warnings.iter().any(|w| w.contains("local image")),
                "{payload}: {warnings:?}"
            );
            assert!(
                warnings.iter().any(|w| w.starts_with("1 image(s) couldn't be downloaded")),
                "{payload}: {warnings:?}"
            );
        }
    }

    #[test]
    fn corrupt_inline_image_still_reports_a_failed_image_not_a_local_one() {
        // Bare base64 also contains '/', so '/' alone must not classify a
        // payload as a local path.
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Pic"));
        doc.chunks.push(image_chunk(1, "ab/c=*not-base64".to_string()));
        let deck = document_to_deck(&doc);
        let (_bytes, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(
            !warnings.iter().any(|w| w.contains("local image")),
            "warnings: {warnings:?}"
        );
        assert!(
            warnings.iter().any(|w| w.starts_with("1 image(s) couldn't be downloaded")),
            "warnings: {warnings:?}"
        );
    }

    #[test]
    fn webp_image_warns_and_is_not_embedded() {
        let webp = [0x52u8, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0];
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Pic"));
        doc.chunks.push(image_chunk(1, data_url("image/webp", &webp)));
        let deck = document_to_deck(&doc);
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let parts: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        assert!(!parts.iter().any(|n| n.starts_with("ppt/media/")), "webp must not be embedded");
        assert!(warnings.iter().any(|w| w.contains("format")), "expected a format warning: {warnings:?}");
    }

    #[test]
    fn two_images_both_embed_with_distinct_rel_ids() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Pic"));
        doc.chunks.push(image_chunk(1, data_url("image/png", b"\x89PNG\r\n\x1a\n")));
        doc.chunks.push(image_chunk(2, data_url("image/png", b"\x89PNG\r\n\x1a\n")));
        let deck = document_to_deck(&doc);
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let media = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .filter(|n| n.starts_with("ppt/media/"))
            .count();
        assert_eq!(media, 2, "both images should embed");
        use std::io::Read;
        let mut rels = String::new();
        zip.by_name("ppt/slides/_rels/slide1.xml.rels")
            .unwrap()
            .read_to_string(&mut rels)
            .unwrap();
        assert!(rels.contains(r#"Id="rId2""#) && rels.contains(r#"Id="rId3""#),
            "each image needs its own rel id: {rels}");
    }

    /// The `(x, y)` of each `<p:pic>`'s `<a:off>`, in document order.
    fn pic_offsets(xml: &str) -> Vec<(i64, i64)> {
        let mut out = Vec::new();
        let mut rest = xml;
        while let Some(start) = rest.find("<p:pic>") {
            let end = rest[start..].find("</p:pic>").map(|i| start + i).unwrap();
            let block = &rest[start..end];
            let x0 = block.find(r#"<a:off x=""#).unwrap() + r#"<a:off x=""#.len();
            let x1 = block[x0..].find('"').unwrap() + x0;
            let y0 = block[x1..].find(r#"y=""#).unwrap() + x1 + 3;
            let y1 = block[y0..].find('"').unwrap() + y0;
            out.push((block[x0..x1].parse().unwrap(), block[y0..y1].parse().unwrap()));
            rest = &rest[end..];
        }
        out
    }

    #[test]
    fn two_images_stack_vertically_in_the_side_column() {
        // Column region, n=2 → 1 col × 2 rows: identical images land at the
        // same x, one cell pitch (cell height + gap) apart vertically.
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Pic"));
        doc.chunks.push(Chunk::new_text(1, "a bullet"));
        doc.chunks.push(image_chunk(2, data_url("image/png", b"\x89PNG\r\n\x1a\n")));
        doc.chunks.push(image_chunk(3, data_url("image/png", b"\x89PNG\r\n\x1a\n")));
        let xml = slide1_xml(&doc);
        let pics = pic_offsets(&xml);
        assert_eq!(pics.len(), 2, "both pictures should render: {xml}");
        let avail_h = SLIDE_H - BODY_Y - MARGIN;
        let cell_h = (avail_h - IMAGE_GRID_GAP) / 2;
        assert_eq!(pics[0].0, pics[1].0, "stacked cells share the same x: {pics:?}");
        assert_eq!(
            pics[1].1 - pics[0].1,
            cell_h + IMAGE_GRID_GAP,
            "second image should sit one cell pitch below the first: {pics:?}"
        );
    }

    #[test]
    fn three_images_form_a_two_by_two_grid_row_major() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Pics"));
        doc.chunks.push(Chunk::new_text(1, "a bullet"));
        for i in 0..3 {
            doc.chunks.push(image_chunk(i + 2, data_url("image/png", b"\x89PNG\r\n\x1a\n")));
        }
        let xml = slide1_xml(&doc);
        let pics = pic_offsets(&xml);
        assert_eq!(pics.len(), 3, "all three pictures should render: {xml}");
        // Row-major: first two share the top row; the third starts the second
        // row back in the first column (the fourth cell stays empty).
        assert_eq!(pics[0].1, pics[1].1, "row 1 shares a y: {pics:?}");
        assert!(pics[1].0 > pics[0].0, "second image sits in column 2: {pics:?}");
        assert!(pics[2].1 > pics[0].1, "third image starts row 2: {pics:?}");
        assert_eq!(pics[2].0, pics[0].0, "third image returns to column 1: {pics:?}");
    }

    #[test]
    fn diagram_with_rendered_snapshot_embeds_as_an_image() {
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Graph");
        h.metadata.layout = Some("title-image".to_string());
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "explains the graph"));
        let mut d = Chunk::new_diagram(2, "graph TD; A-->B;", "mermaid");
        d.metadata.rendered_image = Some(data_url("image/png", b"\x89PNG\r\n\x1a\n"));
        doc.chunks.push(d);
        let deck = document_to_deck(&doc);
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(warnings.is_empty(), "a snapshot-carrying diagram must not warn: {warnings:?}");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let parts: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(parts.iter().any(|n| n == "ppt/media/image1.png"), "snapshot not embedded: {parts:?}");
    }

    #[test]
    fn diagram_without_snapshot_warns_about_the_missing_render() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Graph"));
        doc.chunks.push(Chunk::new_diagram(1, "graph TD; A-->B;", "mermaid"));
        let deck = document_to_deck(&doc);
        let (_bytes, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(
            warnings.iter().any(|w| w.contains("rendered snapshot")),
            "expected a no-snapshot diagram warning: {warnings:?}"
        );
    }

    #[test]
    fn seven_visuals_embed_six_and_warn() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Wall"));
        for i in 0..7 {
            doc.chunks.push(image_chunk(i + 1, data_url("image/png", b"\x89PNG\r\n\x1a\n")));
        }
        let deck = document_to_deck(&doc);
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let media = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .filter(|n| n.starts_with("ppt/media/"))
            .count();
        assert_eq!(media, 6, "only the first 6 visuals embed");
        assert!(
            warnings.iter().any(|w| w.contains("first 6")),
            "expected an extras warning: {warnings:?}"
        );
    }

    #[test]
    fn slot_orders_visuals_before_document_order() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Pic"));
        let mut png = image_chunk(1, data_url("image/png", b"\x89PNG\r\n\x1a\n"));
        png.metadata.slot = Some(2);
        let mut gif = image_chunk(2, data_url("image/gif", b"GIF89a\x04\x00\x02\x00\x80\x00\x00"));
        gif.metadata.slot = Some(1);
        doc.chunks.push(png);
        doc.chunks.push(gif);
        let deck = document_to_deck(&doc);
        let (bytes, _w) = deck_to_pptx(&deck).expect("build");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        use std::io::Read;
        let mut rels = String::new();
        zip.by_name("ppt/slides/_rels/slide1.xml.rels")
            .unwrap()
            .read_to_string(&mut rels)
            .unwrap();
        // The gif (slot 1) renders first despite coming second in the document,
        // so it takes the first image rel (rId2) and the first media slot.
        assert!(
            rels.contains(r#"Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.gif""#),
            "slot order should beat document order: {rels}"
        );
    }

    fn slide1_xml(doc: &Document) -> String {
        use std::io::Read;
        let deck = document_to_deck(doc);
        let (bytes, _w) = deck_to_pptx(&deck).expect("build");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let mut xml = String::new();
        zip.by_name("ppt/slides/slide1.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        xml
    }

    #[test]
    fn explicit_subtitle_renders_on_section_slide() {
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Cover");
        h.metadata.layout = Some("section".to_string());
        doc.chunks.push(h);
        let mut sub = Chunk::new_text(1, "The subtitle");
        sub.metadata.subtitle = true;
        doc.chunks.push(sub);
        let xml = slide1_xml(&doc);
        assert!(xml.contains("Cover"), "title missing: {xml}");
        assert!(xml.contains("The subtitle"), "subtitle missing: {xml}");
    }

    #[test]
    fn detached_slide_body_replaces_the_prose_bullets() {
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Topic");
        h.metadata.slide_body = Some(vec!["Summary one".into(), "Summary two".into()]);
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "original prose paragraph"));
        let xml = slide1_xml(&doc);
        assert!(xml.contains("Summary one") && xml.contains("Summary two"), "slideBody missing: {xml}");
        assert!(!xml.contains("original prose"), "prose should be ignored when detached: {xml}");
    }

    /// The plain text of each body paragraph (runs concatenated).
    fn body_texts(slide: &Slide) -> Vec<String> {
        body_paragraphs(slide)
            .iter()
            .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect())
            .collect()
    }

    // TS `slideBullets` reads `slideBody` from `slideLead` (heading, else the
    // first chunk) only. Slides are built directly here, bypassing
    // deck::document_to_deck's normalisation, so a stray `slide_body` on a
    // non-lead chunk is actually present.
    #[test]
    fn body_paragraphs_reads_slide_body_from_the_lead_chunk_only() {
        // Heading without slide_body + a text chunk carrying a stray one → prose.
        let mut s = Slide::new(0, "title-content");
        s.chunks.push(Chunk::new_heading(0, 1, "Topic"));
        let mut t = Chunk::new_text(1, "linked prose");
        t.metadata.slide_body = Some(vec!["stray body".into()]);
        s.chunks.push(t);
        assert_eq!(body_texts(&s), vec!["linked prose"]);

        // The heading is the lead even when it isn't the first chunk.
        let mut s = Slide::new(0, "title-content");
        let mut t = Chunk::new_text(0, "prose");
        t.metadata.slide_body = Some(vec!["stray".into()]);
        s.chunks.push(t);
        let mut h = Chunk::new_heading(1, 1, "Topic");
        h.metadata.slide_body = Some(vec!["  Lead body  ".into(), "  ".into()]);
        s.chunks.push(h);
        assert_eq!(body_texts(&s), vec!["Lead body"]);

        // A heading-less slide: its first chunk is the lead.
        let mut s = Slide::new(0, "title-content");
        let mut first = Chunk::new_text(0, "first");
        first.metadata.slide_body = Some(vec!["要約 1".into()]);
        s.chunks.push(first);
        let mut second = Chunk::new_text(1, "second");
        second.metadata.slide_body = Some(vec!["ignored".into()]);
        s.chunks.push(second);
        assert_eq!(body_texts(&s), vec!["要約 1"]);
    }

    #[test]
    fn long_bullets_warn_overflow_but_short_deck_does_not() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Dense"));
        for i in 0..20 {
            doc.chunks.push(Chunk::new_text(i + 1, "x".repeat(100)));
        }
        let deck = document_to_deck(&doc);
        let (_b, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(warnings.iter().any(|w| w.contains("cut off")), "expected an overflow warning: {warnings:?}");
    }

    // ----- new layouts: title-image-left / image-top, and the no-image WYSIWYG fix -----

    fn full_body_cx() -> i64 {
        SLIDE_W - 2 * MARGIN
    }

    /// The `<p:sp>...</p:sp>` block for the shape named `name`, so assertions
    /// can check ITS geometry specifically — a bare `xml.contains(...)` can be
    /// satisfied by an unrelated shape (e.g. the Title box, which happens to
    /// share the full-slide-width cx with a correctly-full-width Body box).
    fn shape_xml<'a>(xml: &'a str, name: &str) -> &'a str {
        let marker = format!(r#"name="{name}""#);
        let start = xml.find(&marker).unwrap_or_else(|| panic!("no shape named {name}: {xml}"));
        let end = xml[start..].find("</p:sp>").map(|i| start + i).unwrap();
        &xml[start..end]
    }

    #[test]
    fn title_image_without_an_image_renders_full_width_not_a_blank_column() {
        // Regression: the layout used to reserve the narrow 55% body box even
        // when the slide had no image chunk at all, leaving dead space on the
        // right in the exported file while the live preview (which only
        // narrows when an image chunk exists) showed full width. Both must
        // agree. Scoped to the Body shape itself — the Title box always spans
        // the full width regardless of the Body box's own (bug's) width, so a
        // whole-document substring check would pass even with the bug back.
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "No picture yet");
        h.metadata.layout = Some("title-image".to_string());
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "a bullet"));
        let xml = slide1_xml(&doc);
        let body = shape_xml(&xml, "Body");
        assert!(
            body.contains(&format!(r#"cx="{}""#, full_body_cx())),
            "expected a full-width Body box: {body}"
        );
    }

    #[test]
    fn title_image_left_places_image_on_the_left() {
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Left image");
        h.metadata.layout = Some("title-image-left".to_string());
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "a bullet"));
        doc.chunks
            .push(image_chunk(2, data_url("image/png", b"\x89PNG\r\n\x1a\n")));
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides[0].layout, "title-image-left");
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        assert!(
            (0..zip.len())
                .map(|i| zip.by_index(i).unwrap().name().to_string())
                .any(|n| n == "ppt/media/image1.png"),
            "image not embedded"
        );
        use std::io::Read;
        let mut xml = String::new();
        zip.by_name("ppt/slides/slide1.xml").unwrap().read_to_string(&mut xml).unwrap();
        // The picture shape itself (not just the title, which also starts at
        // MARGIN) must be flush against the left margin.
        let pic_start = xml.find("<p:pic>").expect("no picture shape");
        let pic_end = xml[pic_start..].find("</p:pic>").map(|i| pic_start + i).unwrap();
        let pic_xml = &xml[pic_start..pic_end];
        assert!(pic_xml.contains(&format!(r#"x="{MARGIN}""#)), "image should be flush left: {pic_xml}");
        // The bullet body sits to the image's right (a larger x-offset). Mirror
        // the exact formula build_slide uses, not an approximation.
        let body_cx = full_body_cx() * 55 / 100;
        let gap = 400_050;
        let image_cx = full_body_cx() - body_cx - gap;
        let body_x = MARGIN + image_cx + gap;
        assert!(
            xml.contains(&format!(r#"name="Body"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{body_x}""#)),
            "expected the Body text box to start at x={body_x}: {xml}"
        );
    }

    #[test]
    fn image_top_stacks_image_above_bullets() {
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Banner image");
        h.metadata.layout = Some("image-top".to_string());
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "explains the picture above"));
        doc.chunks
            .push(image_chunk(2, data_url("image/png", b"\x89PNG\r\n\x1a\n")));
        let deck = document_to_deck(&doc);
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        use std::io::Read;
        let mut xml = String::new();
        zip.by_name("ppt/slides/slide1.xml").unwrap().read_to_string(&mut xml).unwrap();
        assert!(xml.contains("<p:pic>"), "image not embedded: {xml}");
        assert!(xml.contains("explains the picture above"), "bullet missing: {xml}");
        // The image band starts at the top of the body area (y = BODY_Y); the
        // bullet text box starts further down, below the image band — i.e. the
        // image is stacked ABOVE the bullets, not beside them.
        let avail = SLIDE_H - BODY_Y - MARGIN;
        let image_cy = avail * 45 / 100;
        let body_y = BODY_Y + image_cy + 160_020;
        assert!(xml.contains(&format!(r#"y="{BODY_Y}""#)), "image band should start at BODY_Y: {xml}");
        assert!(xml.contains(&format!(r#"y="{body_y}""#)), "bullet box should start below the image band: {xml}");
    }

    #[test]
    fn unknown_legacy_layout_falls_back_gracefully() {
        // normalize() resets unknown layout strings to auto-pick before export
        // ever sees them (models.rs known_layouts); document_to_deck's own
        // fallback (the `_` match arm) covers any value that slips through.
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "T"));
        doc.chunks.push(Chunk::new_text(1, "body"));
        let mut deck = document_to_deck(&doc);
        deck.slides[0].layout = "some-future-layout".to_string();
        let (_bytes, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
    }

    // ----- subtitle is its own full-width shape, not folded into the bullets -----
    // (WYSIWYG parity fix: SlideEditor.tsx has always rendered the subtitle as a
    // separate element above the bullets/image; pptx.rs used to fold it into the
    // SAME box as the bullets, disagreeing with the preview on both position and
    // width whenever a slide had both a subtitle and an image.)

    #[test]
    fn subtitle_is_a_separate_shape_from_the_bullets_on_title_content() {
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Topic");
        h.metadata.layout = Some("title-content".to_string());
        doc.chunks.push(h);
        let mut sub = Chunk::new_text(1, "The subtitle");
        sub.metadata.subtitle = true;
        doc.chunks.push(sub);
        doc.chunks.push(Chunk::new_text(2, "A bullet"));
        let xml = slide1_xml(&doc);
        let subtitle_shape = shape_xml(&xml, "Subtitle");
        assert!(subtitle_shape.contains("The subtitle"), "subtitle text missing from its own shape: {subtitle_shape}");
        let body_shape = shape_xml(&xml, "Body");
        assert!(!body_shape.contains("The subtitle"), "subtitle should not be folded into the Body box: {body_shape}");
        assert!(body_shape.contains("A bullet"), "bullet missing from Body: {body_shape}");
    }

    #[test]
    fn subtitle_stays_full_width_and_above_the_image_on_title_image_left() {
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Topic");
        h.metadata.layout = Some("title-image-left".to_string());
        doc.chunks.push(h);
        let mut sub = Chunk::new_text(1, "The subtitle");
        sub.metadata.subtitle = true;
        doc.chunks.push(sub);
        doc.chunks.push(Chunk::new_text(2, "A bullet"));
        doc.chunks
            .push(image_chunk(3, data_url("image/png", b"\x89PNG\r\n\x1a\n")));
        let xml = slide1_xml(&doc);
        let subtitle_shape = shape_xml(&xml, "Subtitle");
        // Full slide width, not the narrowed 55% bullets column.
        assert!(
            subtitle_shape.contains(&format!(r#"cx="{}""#, full_body_cx())),
            "subtitle should span the full width: {subtitle_shape}"
        );
        assert!(
            subtitle_shape.contains(&format!(r#"y="{BODY_Y}""#)),
            "subtitle should sit right under the title, above the bullets/image row: {subtitle_shape}"
        );
        let body_shape = shape_xml(&xml, "Body");
        assert!(!body_shape.contains("The subtitle"), "subtitle should not be folded into the Body box: {body_shape}");
        // The bullets/image row starts BELOW the subtitle box.
        let content_y = BODY_Y + SUBTITLE_H;
        assert!(
            body_shape.contains(&format!(r#"y="{content_y}""#)),
            "Body box should start below the subtitle: {body_shape}"
        );
    }

    #[test]
    fn image_chunk_with_empty_content_renders_full_width_and_warns() {
        // has_image gates on non-empty CONTENT (matching the frontend's
        // `slideImage()` truthiness check), not mere chunk existence — an
        // image chunk that exists but has empty content (e.g. a remote fetch
        // that already failed) must not reserve a blank image column.
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Topic");
        h.metadata.layout = Some("title-image".to_string());
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "a bullet"));
        doc.chunks.push(image_chunk(2, String::new()));
        let deck = document_to_deck(&doc);
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(warnings.iter().any(|w| w.contains("downloaded")), "expected a failed-image warning: {warnings:?}");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        use std::io::Read;
        let mut xml = String::new();
        zip.by_name("ppt/slides/slide1.xml").unwrap().read_to_string(&mut xml).unwrap();
        let body = shape_xml(&xml, "Body");
        assert!(
            body.contains(&format!(r#"cx="{}""#, full_body_cx())),
            "expected a full-width Body box, not a blank image column: {body}"
        );
    }

    // ----- speaker notes: notesSlide export -----

    /// The `<a:t>` texts inside the notes part's "Notes Placeholder" `<p:sp>`
    /// only (scoped extraction, not a whole-part contains()).
    fn notes_placeholder_texts(notes_xml: &str) -> Vec<String> {
        let sp = notes_xml
            .split("<p:sp>")
            .skip(1)
            .find(|sp| sp.contains(r#"name="Notes Placeholder""#))
            .and_then(|sp| sp.split("</p:sp>").next())
            .expect("a Notes Placeholder shape");
        sp.split("<a:t>")
            .skip(1)
            .filter_map(|s| s.split("</a:t>").next())
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn leading_slide_notes_emit_notes_slide() {
        // BUG-007: the doc-title-derived first slide (no heading chunk) carries
        // the notes set on its lead chunk into notesSlide1.
        let mut doc = Document::new("連動テスト文書");
        let mut t = Chunk::new_text(0, "本文");
        t.metadata.notes = Some("N".to_string());
        doc.chunks.push(t);
        let deck = document_to_deck(&doc);
        let (bytes, _warnings) = deck_to_pptx(&deck).expect("build");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        use std::io::Read as _;
        let mut notes_xml = String::new();
        zip.by_name("ppt/notesSlides/notesSlide1.xml")
            .expect("notesSlide1.xml part")
            .read_to_string(&mut notes_xml)
            .unwrap();
        assert_eq!(notes_placeholder_texts(&notes_xml), vec!["N".to_string()]);
    }

    #[test]
    fn slide_with_notes_gets_a_notes_slide_part_containing_its_text() {
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Topic");
        h.metadata.notes = Some("Remember to mention X".to_string());
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "a bullet"));
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides[0].notes, "Remember to mention X");
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(
            names.iter().any(|n| n == "ppt/notesSlides/notesSlide1.xml"),
            "expected a notesSlide1.xml part: {names:?}"
        );
        assert!(
            names.iter().any(|n| n == "ppt/notesSlides/_rels/notesSlide1.xml.rels"),
            "expected a notesSlide1.xml.rels part: {names:?}"
        );
        use std::io::Read as _;
        let mut notes_xml = String::new();
        zip.by_name("ppt/notesSlides/notesSlide1.xml")
            .unwrap()
            .read_to_string(&mut notes_xml)
            .unwrap();
        // Scope the assertion to the notesSlide entry's OWN bytes, not a
        // whole-archive contains() check.
        assert!(
            notes_xml.contains("Remember to mention X"),
            "notes text missing from notesSlide1.xml: {notes_xml}"
        );
        let mut rels_xml = String::new();
        zip.by_name("ppt/notesSlides/_rels/notesSlide1.xml.rels")
            .unwrap()
            .read_to_string(&mut rels_xml)
            .unwrap();
        assert!(
            rels_xml.contains("../slides/slide1.xml"),
            "notesSlide rels should point back to its slide: {rels_xml}"
        );
        // The slide's own rels must carry a notesSlide relationship too.
        let mut slide_rels_xml = String::new();
        zip.by_name("ppt/slides/_rels/slide1.xml.rels")
            .unwrap()
            .read_to_string(&mut slide_rels_xml)
            .unwrap();
        assert!(
            slide_rels_xml.contains("relationships/notesSlide")
                && slide_rels_xml.contains("../notesSlides/notesSlide1.xml"),
            "slide1.xml.rels should link to its notesSlide: {slide_rels_xml}"
        );
        // Content-types manifest must declare the notesSlide part.
        let mut ct = String::new();
        zip.by_name("[Content_Types].xml").unwrap().read_to_string(&mut ct).unwrap();
        assert!(
            ct.contains("/ppt/notesSlides/notesSlide1.xml"),
            "content-types missing notesSlide override: {ct}"
        );
    }

    #[test]
    fn slide_with_empty_notes_produces_no_notes_slide_part() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Topic"));
        doc.chunks.push(Chunk::new_text(1, "a bullet"));
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides[0].notes, "");
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(
            !names.iter().any(|n| n.starts_with("ppt/notesSlides/")),
            "no notesSlides parts should exist for a slide with empty notes: {names:?}"
        );
        use std::io::Read as _;
        let mut slide_rels_xml = String::new();
        zip.by_name("ppt/slides/_rels/slide1.xml.rels")
            .unwrap()
            .read_to_string(&mut slide_rels_xml)
            .unwrap();
        assert!(
            !slide_rels_xml.contains("notesSlide"),
            "slide1.xml.rels should not reference a notesSlide when there are no notes: {slide_rels_xml}"
        );
    }

    #[test]
    fn notes_with_xml_special_and_control_chars_escape_to_legal_xml() {
        // A malicious/weird notes string carrying angle brackets, ampersands,
        // quotes and a C0 control char must not produce invalid XML or break
        // the zip — `notes_slide_xml` must run every line through the shared
        // `esc()` helper, not skip escaping. Scoped to the notesSlide1.xml
        // entry's own bytes, not a whole-archive contains() check.
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Topic");
        h.metadata.notes = Some("<script>alert(\"x\")</script> & bad\u{7}bell\u{1}".to_string());
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "a bullet"));
        let deck = document_to_deck(&doc);
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        use std::io::Read as _;
        let mut notes_xml = String::new();
        zip.by_name("ppt/notesSlides/notesSlide1.xml")
            .unwrap()
            .read_to_string(&mut notes_xml)
            .unwrap();
        // The raw special characters must be gone (escaped), replaced by their
        // entities, and the C0 control bytes must be stripped entirely.
        assert!(
            !notes_xml.contains("<script>") && !notes_xml.contains("</script>"),
            "raw '<script>' tag must not survive unescaped in notesSlide1.xml: {notes_xml}"
        );
        assert!(
            notes_xml.contains("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; bad"),
            "expected the escaped notes text in notesSlide1.xml: {notes_xml}"
        );
        assert!(
            !notes_xml
                .bytes()
                .any(|b| b < 0x20 && b != b'\t' && b != b'\n' && b != b'\r'),
            "notesSlide1.xml still contains an illegal control byte: {notes_xml}"
        );
        // The whole part must still be well-formed enough to round-trip through
        // a real XML-unaware check: every '<' that isn't part of a real tag was
        // escaped, so the only literal '<' bytes left open real elements/tags.
        assert!(notes_xml.starts_with("<?xml"), "notesSlide1.xml should still be valid XML preamble");
    }

    #[test]
    fn mixed_notes_only_emit_parts_for_slides_that_have_them() {
        // A 2-slide deck where only the SECOND slide has notes must produce
        // exactly one notesSlide part, numbered to match its own slide (2),
        // not slide 1.
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "First"));
        doc.chunks.push(Chunk::new_text(1, "bullet one"));
        let mut h2 = Chunk::new_heading(2, 1, "Second");
        h2.metadata.notes = Some("Only slide two has notes".to_string());
        doc.chunks.push(h2);
        doc.chunks.push(Chunk::new_text(3, "bullet two"));
        let deck = document_to_deck(&doc);
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build");
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(!names.iter().any(|n| n == "ppt/notesSlides/notesSlide1.xml"));
        assert!(names.iter().any(|n| n == "ppt/notesSlides/notesSlide2.xml"));
    }

    // ----- BUG-020: Markdown in slide bodies becomes paragraphs and runs -----
    // Every assertion is scoped to ONE shape's <a:p> elements (testing rule 2):
    // the Title/Subtitle boxes can never satisfy a Body assertion.

    /// The `<a:p>…</a:p>` elements of the shape named `name`, in order.
    fn shape_paras(xml: &str, name: &str) -> Vec<String> {
        shape_xml(xml, name)
            .split("<a:p>")
            .skip(1)
            .map(|p| p.split("</a:p>").next().unwrap_or_default().to_string())
            .collect()
    }

    /// The `<a:t>` texts of one paragraph.
    fn para_texts(p: &str) -> Vec<String> {
        p.split("<a:t>")
            .skip(1)
            .filter_map(|s| s.split("</a:t>").next())
            .map(str::to_string)
            .collect()
    }

    /// The `<a:r>` element whose `<a:t>` is exactly `text`.
    fn run_with_text<'a>(p: &'a str, text: &str) -> &'a str {
        p.split("<a:r>")
            .skip(1)
            .map(|r| r.split("</a:r>").next().unwrap_or_default())
            .find(|r| r.contains(&format!("<a:t>{text}</a:t>")))
            .unwrap_or_else(|| panic!("no run with text {text:?} in {p}"))
    }

    fn deck_parts(doc: &Document) -> (String, String, Vec<String>) {
        use std::io::Read;
        let deck = document_to_deck(doc);
        let (bytes, warnings) = deck_to_pptx(&deck).expect("build");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
        let mut xml = String::new();
        zip.by_name("ppt/slides/slide1.xml").unwrap().read_to_string(&mut xml).unwrap();
        let mut rels = String::new();
        zip.by_name("ppt/slides/_rels/slide1.xml.rels").unwrap().read_to_string(&mut rels).unwrap();
        (xml, rels, warnings)
    }

    fn one_text_slide(text: &str) -> Document {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "第1節"));
        doc.chunks.push(Chunk::new_text(1, text));
        doc
    }

    #[test]
    fn markdown_bullets_become_runs() {
        let (xml, _rels, _w) =
            deck_parts(&one_text_slide("最初の段落。**太字**と[リンク](https://example.com)。"));
        let paras = shape_paras(&xml, "Body");
        assert_eq!(paras.len(), 1, "one prose paragraph: {paras:?}");
        assert_eq!(para_texts(&paras[0]), vec!["最初の段落。", "太字", "と", "リンク", "。"]);
        let bold = run_with_text(&paras[0], "太字");
        assert!(bold.contains(r#" b="1""#), "bold run lacks b=1: {bold}");
        let plain = run_with_text(&paras[0], "と");
        assert!(!plain.contains(r#" b="1""#), "neighbour must not be bold: {plain}");
        for t in para_texts(&paras[0]) {
            assert!(!t.contains("**") && !t.contains("]("), "raw Markdown leaked: {t}");
        }
    }

    #[test]
    fn list_chunk_splits_into_paragraphs() {
        let (xml, _rels, _w) = deck_parts(&one_text_slide("- 項目A\n- 項目B"));
        let paras = shape_paras(&xml, "Body");
        assert_eq!(paras.len(), 2, "two bullets: {paras:?}");
        for (p, want) in paras.iter().zip(["項目A", "項目B"]) {
            assert!(p.contains(r#"<a:buChar char="&#8226;"/>"#), "bullet glyph missing: {p}");
            assert_eq!(para_texts(p), vec![want.to_string()]);
        }
    }

    #[test]
    fn nested_and_numbered_items_keep_level_and_label() {
        let (xml, _rels, _w) = deck_parts(&one_text_slide("1. 一\n   - 子"));
        let paras = shape_paras(&xml, "Body");
        assert_eq!(paras.len(), 2, "{paras:?}");
        assert!(paras[0].contains("<a:buNone/>"), "numbered uses its label, not a glyph: {}", paras[0]);
        assert_eq!(para_texts(&paras[0]), vec!["1. ", "一"]);
        assert!(paras[1].contains(r#" lvl="1""#), "nested item keeps its level: {}", paras[1]);
    }

    #[test]
    fn fenced_code_is_monospace_without_fences() {
        let (xml, _rels, _w) = deck_parts(&one_text_slide("```text\nコード行\n```"));
        let paras = shape_paras(&xml, "Body");
        assert_eq!(paras.len(), 1, "{paras:?}");
        assert!(paras[0].contains("<a:buNone/>"), "code has no bullet: {}", paras[0]);
        let run = run_with_text(&paras[0], "コード行");
        assert!(run.contains(r#"<a:latin typeface="Menlo"/>"#), "code run not monospace: {run}");
        for t in para_texts(&paras[0]) {
            assert!(!t.starts_with("```"), "fence leaked: {t}");
        }
    }

    // para_xml doc: an empty paragraph (a blank line inside a fence) keeps its
    // line via `endParaRPr` at the code size, instead of vanishing.
    #[test]
    fn blank_code_line_keeps_its_paragraph() {
        let (xml, _rels, _w) = deck_parts(&one_text_slide("```text\n一行目\n\n三行目\n```"));
        let paras = shape_paras(&xml, "Body");
        assert_eq!(paras.len(), 3, "{paras:?}");
        assert_eq!(
            paras[1],
            r#"<a:pPr marL="0" indent="0"><a:buNone/></a:pPr><a:endParaRPr lang="en-US" sz="1600"/>"#
        );
        assert_eq!(para_texts(&paras[0]), vec!["一行目"]);
        assert_eq!(para_texts(&paras[2]), vec!["三行目"]);
    }

    #[test]
    fn soft_break_becomes_a_line_break_inside_one_paragraph() {
        let (xml, _rels, _w) = deck_parts(&one_text_slide("一行目\n二行目"));
        let paras = shape_paras(&xml, "Body");
        assert_eq!(paras.len(), 1, "{paras:?}");
        assert_eq!(para_texts(&paras[0]), vec!["一行目", "二行目"]);
        let first = paras[0].find("一行目").unwrap();
        let second = paras[0].find("二行目").unwrap();
        assert!(paras[0][first..second].contains("<a:br/>"), "no <a:br/> between lines: {}", paras[0]);
        for t in para_texts(&paras[0]) {
            assert!(!t.contains('\n'), "newline inside <a:t>: {t:?}");
        }
    }

    #[test]
    fn hyperlink_gets_an_external_slide_rel_after_images_and_notes() {
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Links");
        h.metadata.notes = Some("speaker".to_string());
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "[リンク](https://example.com/?a=1&b=2) と [別](https://example.com/?a=1&b=2)"));
        doc.chunks.push(image_chunk(2, data_url("image/png", b"\x89PNG\r\n\x1a\n")));
        let (xml, rels, warnings) = deck_parts(&doc);
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        let paras = shape_paras(&xml, "Body");
        let link = run_with_text(&paras[0], "リンク");
        assert!(link.contains(r#"<a:hlinkClick r:id="rIdL1"/>"#), "no click target: {link}");
        assert!(link.contains(r#" u="sng""#), "link not underlined: {link}");
        // The same URL reuses its relationship.
        assert!(run_with_text(&paras[0], "別").contains(r#"r:id="rIdL1""#));
        // rId1 layout, rId2 image, rId3 notes, rIdL1 link: all distinct.
        let ids: Vec<&str> = rels
            .split(r#"Id=""#)
            .skip(1)
            .filter_map(|s| s.split('"').next())
            .collect();
        assert_eq!(ids, vec!["rId1", "rId2", "rId3", "rIdL1"], "rels: {rels}");
        let link_rel = rels
            .split("<Relationship ")
            .find(|r| r.contains(r#"Id="rIdL1""#))
            .expect("hyperlink rel");
        assert!(link_rel.contains("relationships/hyperlink"), "{link_rel}");
        assert!(link_rel.contains(r#"Target="https://example.com/?a=1&amp;b=2""#), "{link_rel}");
        assert!(link_rel.contains(r#"TargetMode="External""#), "{link_rel}");
    }

    #[test]
    fn non_web_link_is_plain_text_and_warned() {
        let (xml, rels, warnings) = deck_parts(&one_text_slide("[x](javascript:alert(1)) [y](notes.md)"));
        let paras = shape_paras(&xml, "Body");
        assert!(!paras[0].contains("hlinkClick"), "unsafe link must not be clickable: {}", paras[0]);
        assert!(!rels.contains("relationships/hyperlink"), "{rels}");
        assert_eq!(
            warnings,
            vec!["2 link(s) don't point to a web or mail address and were exported as plain text."]
        );
    }

    #[test]
    fn section_subtitle_fallback_is_converted() {
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Cover");
        h.metadata.layout = Some("section".to_string());
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "**副題**です"));
        let (xml, _rels, _w) = deck_parts(&doc);
        let paras = shape_paras(&xml, "Subtitle");
        assert_eq!(paras.len(), 1, "{paras:?}");
        assert_eq!(para_texts(&paras[0]), vec!["副題", "です"]);
        assert!(run_with_text(&paras[0], "副題").contains(r#" b="1""#), "{}", paras[0]);
    }

    #[test]
    fn section_slide_only_processes_its_subtitle_fallback() {
        // A section slide writes no Body shape, so paragraphs after the
        // subtitle fallback must not register links or count warnings.
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Cover");
        h.metadata.layout = Some("section".to_string());
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "[x](notes.md)"));
        doc.chunks.push(Chunk::new_text(2, "[y](https://e.x)"));
        let (_xml, rels, warnings) = deck_parts(&doc);
        assert_eq!(
            warnings,
            vec!["1 link(s) don't point to a web or mail address and were exported as plain text."]
        );
        assert!(!rels.contains("relationships/hyperlink"), "unreferenced link rel: {rels}");
    }

    #[test]
    fn link_url_never_counts_toward_overflow() {
        // Mirrors slides.test.ts "overflow counts visible text".
        let url = format!("https://example.com/{}", "x".repeat(120 * 20));
        let (_xml, _rels, warnings) = deck_parts(&one_text_slide(&format!("[リンク]({url})")));
        assert!(!warnings.iter().any(|w| w.contains("cut off")), "{warnings:?}");
    }

    #[test]
    fn list_items_each_count_toward_overflow() {
        // Mirrors slides.test.ts "overflow counts each list item as its own line".
        let items: Vec<String> = (0..15).map(|i| format!("- item {i}")).collect();
        let (_xml, _rels, warnings) = deck_parts(&one_text_slide(&items.join("\n")));
        assert!(warnings.iter().any(|w| w.contains("cut off")), "{warnings:?}");
    }
}
