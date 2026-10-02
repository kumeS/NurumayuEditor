//! Derive a slide `Deck` from a text `Document` (v1.2.0).
//!
//! Deterministic, AI-free conversion used by the "Export to PowerPoint" path:
//! each heading starts a new slide (its text becomes the slide title), the
//! following paragraphs become bullets, and image chunks attach to their slide.
//! The layout is then picked from the slide's chunk composition. AI-assisted
//! deck generation (bulletizing, image suggestions) is a separate, later step.
//!
//! Sync contract: layout resolution here (first non-empty `metadata.layout`
//! override, else auto-pick) mirrors the TS `resolveLayout`, and a slide's
//! multi-image GRID (which visuals show, their slot/document ordering, and the
//! cell subdivision of the layout's image region) is defined identically in
//! `pptx.rs` (export) and `SlideEditor.tsx` (preview) — change one, change all.
//!
//! Sync contract (notes): a slide's `notes` field is derived from its LEAD
//! chunk's `metadata.notes` (empty string when absent): the heading chunk, or
//! — for the heading-less leading slide — its first chunk, whose notes the
//! synthetic doc-title heading carries. Notes on any other chunk are ignored.
//! This MUST mirror the TS `slideNotes`/`slideLead` in `slides.ts` — change
//! one, change both. The same lead rule hosts a detached slide's
//! `slide_body` (TS `slideBullets`/`isSlideDetached`): the deck keeps it on
//! the slide's heading only and clears it from every other chunk. Known
//! limit: inserting a heading above a leading slide's lead chunk makes it a
//! body chunk, and its notes and slideBody stop being read (same on both
//! sides); notes are never written to `.md` (planned).

use crate::models::{
    Chunk, Deck, Document, Slide, SLIDE_LAYOUT_SECTION, SLIDE_LAYOUT_TITLE_CONTENT,
    SLIDE_LAYOUT_TITLE_IMAGE,
};

/// Build a deck from a document. Headings delimit slides; content before the
/// first heading goes on an opening slide titled with the document title.
pub fn document_to_deck(doc: &Document) -> Deck {
    let mut slides: Vec<Slide> = Vec::new();
    let mut current: Option<Slide> = None;
    let mut order = 0u32;

    for chunk in &doc.chunks {
        if chunk.is_heading() {
            if let Some(s) = current.take() {
                slides.push(s);
            }
            let mut s = Slide::new(order, SLIDE_LAYOUT_TITLE_CONTENT);
            s.chunks.push(chunk.clone());
            current = Some(s);
            order += 1;
        } else {
            match current.as_mut() {
                Some(s) => s.chunks.push(chunk.clone()),
                None => {
                    // Content before any heading → an opening slide whose title
                    // is the document title.
                    // Its speaker notes and slideBody live on its lead
                    // (first) chunk; the synthetic heading carries them so the
                    // heading-based derivation below and pptx.rs apply
                    // unchanged (BUG-007).
                    let mut s = Slide::new(order, SLIDE_LAYOUT_TITLE_CONTENT);
                    let mut h = Chunk::new_heading(0, 1, doc.title.clone());
                    h.metadata.notes = chunk.metadata.notes.clone();
                    h.metadata.slide_body = chunk.metadata.slide_body.clone();
                    s.chunks.push(h);
                    s.chunks.push(chunk.clone());
                    current = Some(s);
                    order += 1;
                }
            }
        }
    }
    if let Some(s) = current.take() {
        slides.push(s);
    }

    // `slideBody` is read from the slide's lead only (TS `slideLead`): the
    // heading, which for a leading slide is the synthetic one carrying its
    // first chunk's. Drop it from every other chunk. pptx.rs's
    // `body_paragraphs` reads only the lead's (`slide_lead`), so this is
    // defence in depth, not load-bearing.
    for s in &mut slides {
        for c in s.chunks.iter_mut().filter(|c| !c.is_heading()) {
            c.metadata.slide_body = None;
        }
    }

    // Empty document → a single section slide carrying just the title.
    if slides.is_empty() {
        let mut s = Slide::new(0, SLIDE_LAYOUT_SECTION);
        s.chunks.push(Chunk::new_heading(0, 1, doc.title.clone()));
        slides.push(s);
    }

    // Pick a layout per slide: honor an explicit override on the slide's heading
    // chunk (set from the slide editor's layout picker), else auto-pick from
    // content.
    for s in &mut slides {
        // The layout override may sit on the heading OR, for a heading-less
        // (leading) slide, on its first content chunk — take the first found so
        // any slide can carry a layout (mirrors the TS `resolveLayout`).
        let override_layout = s
            .chunks
            .iter()
            .find_map(|c| c.metadata.layout.clone())
            .filter(|l| !l.trim().is_empty());
        s.layout = override_layout.unwrap_or_else(|| {
            let has_image = s.chunks.iter().any(|c| c.is_image());
            let body = s.chunks.iter().filter(|c| !c.is_heading()).count();
            if has_image {
                SLIDE_LAYOUT_TITLE_IMAGE.to_string()
            } else if body == 0 {
                SLIDE_LAYOUT_SECTION.to_string()
            } else {
                SLIDE_LAYOUT_TITLE_CONTENT.to_string()
            }
        });

        // Speaker notes: the slide's heading chunk's `metadata.notes` (for a
        // leading slide, the synthetic heading carries its lead chunk's), or
        // an empty string when absent. Sync contract with the TS `slideNotes` —
        // see the module doc comment.
        s.notes = s
            .chunks
            .iter()
            .find(|c| c.is_heading())
            .and_then(|c| c.metadata.notes.clone())
            .unwrap_or_default();
    }

    let mut deck = Deck::new(&doc.title);
    deck.slides = slides;
    deck
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_delimit_slides() {
        let mut doc = Document::new("My Doc");
        doc.chunks.push(Chunk::new_heading(0, 1, "Intro"));
        doc.chunks.push(Chunk::new_text(1, "Point A"));
        doc.chunks.push(Chunk::new_text(2, "Point B"));
        doc.chunks.push(Chunk::new_heading(3, 1, "Details"));
        doc.chunks.push(Chunk::new_text(4, "More"));
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides.len(), 2);
        assert_eq!(deck.slides[0].chunks.len(), 3); // title + 2 bullets
        assert_eq!(deck.slides[0].layout, SLIDE_LAYOUT_TITLE_CONTENT);
    }

    #[test]
    fn content_before_first_heading_gets_title_slide() {
        let mut doc = Document::new("Untitled");
        doc.chunks.push(Chunk::new_text(0, "Lonely paragraph"));
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides.len(), 1);
        assert!(deck.slides[0].chunks[0].is_heading());
    }

    #[test]
    fn heading_layout_override_beats_auto() {
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Intro");
        // Body text would auto-pick title-content; the override must win.
        h.metadata.layout = Some(SLIDE_LAYOUT_SECTION.to_string());
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "Some body text"));
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides.len(), 1);
        assert_eq!(deck.slides[0].layout, SLIDE_LAYOUT_SECTION);
    }

    #[test]
    fn layout_override_on_heading_less_leading_slide() {
        // Content before the first heading forms a leading slide; a layout
        // override on its first chunk must be honoured (Req 1).
        let mut doc = Document::new("D");
        let mut t = Chunk::new_text(0, "lead paragraph");
        t.metadata.layout = Some(SLIDE_LAYOUT_TITLE_IMAGE.to_string());
        doc.chunks.push(t);
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides.len(), 1);
        assert_eq!(deck.slides[0].layout, SLIDE_LAYOUT_TITLE_IMAGE);
    }

    #[test]
    fn empty_document_yields_one_section_slide() {
        let doc = Document::new("Empty");
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides.len(), 1);
        assert_eq!(deck.slides[0].layout, SLIDE_LAYOUT_SECTION);
    }

    #[test]
    fn manual_only_layouts_are_never_auto_picked_but_pass_through_as_overrides() {
        // title-image-left / image-top are manual-choice-only (auto-pick still
        // only ever produces section/title-content/title-image, see the
        // `layout` field doc comment in models.rs) — but an explicit override
        // must still win, exactly like the other layouts.
        use crate::models::{SLIDE_LAYOUT_IMAGE_TOP, SLIDE_LAYOUT_TITLE_IMAGE_LEFT};

        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Left image");
        h.metadata.layout = Some(SLIDE_LAYOUT_TITLE_IMAGE_LEFT.to_string());
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "bullet"));
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides[0].layout, SLIDE_LAYOUT_TITLE_IMAGE_LEFT);

        let mut doc2 = Document::new("D2");
        let mut h2 = Chunk::new_heading(0, 1, "Banner");
        h2.metadata.layout = Some(SLIDE_LAYOUT_IMAGE_TOP.to_string());
        doc2.chunks.push(h2);
        doc2.chunks.push(Chunk::new_text(1, "bullet"));
        let deck2 = document_to_deck(&doc2);
        assert_eq!(deck2.slides[0].layout, SLIDE_LAYOUT_IMAGE_TOP);

        // Meanwhile, an image with NO override still auto-picks "title-image"
        // (right), not either of the manual-only variants.
        let mut doc3 = Document::new("D3");
        doc3.chunks.push(Chunk::new_heading(0, 1, "Auto"));
        let mut img = Chunk::new_text(1, "u");
        img.metadata.chunk_type = crate::models::CHUNK_TYPE_IMAGE.to_string();
        doc3.chunks.push(img);
        let deck3 = document_to_deck(&doc3);
        assert_eq!(deck3.slides[0].layout, SLIDE_LAYOUT_TITLE_IMAGE);
    }

    #[test]
    fn heading_notes_populate_the_slides_notes_field() {
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Intro");
        h.metadata.notes = Some("Remember to mention X".to_string());
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "bullet"));
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides[0].notes, "Remember to mention X");
    }

    #[test]
    fn leading_slide_notes_come_from_its_first_chunk() {
        // BUG-007: a heading-less leading slide hosts its notes on its lead
        // (first) chunk, like layout/slideBody — mirrors the TS `slideNotes`.
        let mut doc = Document::new("D");
        let mut t = Chunk::new_text(0, "lonely");
        t.metadata.notes = Some("N".into());
        doc.chunks.push(t);
        doc.chunks.push(Chunk::new_text(1, "more"));
        doc.chunks.push(Chunk::new_heading(2, 1, "Next"));
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides[0].notes, "N");
        assert_eq!(deck.slides[1].notes, "");
    }

    #[test]
    fn notes_on_a_body_chunk_of_a_heading_slide_are_ignored() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "T"));
        let mut b = Chunk::new_text(1, "body");
        b.metadata.notes = Some("stale".into());
        doc.chunks.push(b);
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides[0].notes, "");
    }

    // ----- slideBody host (mirrors TS `slideLead` / `slideBullets` /
    // `isSlideDetached` in slides.ts and the "detach / slideBody (Req 2)"
    // cases in slides.test.ts). After `document_to_deck`, a slide's only
    // `slide_body` is on its heading — the lead pptx.rs's `slide_lead` reads.

    /// Which chunks of a slide carry a `slide_body`, as (index, lines).
    fn slide_body_hosts(s: &Slide) -> Vec<(usize, Vec<String>)> {
        s.chunks
            .iter()
            .enumerate()
            .filter_map(|(i, c)| c.metadata.slide_body.clone().map(|b| (i, b)))
            .collect()
    }

    #[test]
    fn slide_body_on_the_heading_is_kept() {
        let mut doc = Document::new("D");
        let mut h = Chunk::new_heading(0, 1, "Title");
        h.metadata.slide_body = Some(vec!["Sum A".into(), "Sum B".into()]);
        doc.chunks.push(h);
        doc.chunks.push(Chunk::new_text(1, "original prose"));
        let deck = document_to_deck(&doc);
        assert_eq!(
            slide_body_hosts(&deck.slides[0]),
            vec![(0, vec!["Sum A".to_string(), "Sum B".to_string()])]
        );
    }

    #[test]
    fn no_slide_body_means_no_host() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "T"));
        doc.chunks.push(Chunk::new_text(1, "prose"));
        let deck = document_to_deck(&doc);
        assert!(slide_body_hosts(&deck.slides[0]).is_empty());
    }

    #[test]
    fn leading_slide_takes_its_slide_body_from_its_first_chunk() {
        let mut doc = Document::new("D");
        let mut t = Chunk::new_text(0, "lead");
        t.metadata.slide_body = Some(vec!["S1".into()]);
        doc.chunks.push(t);
        doc.chunks.push(Chunk::new_text(1, "more"));
        let deck = document_to_deck(&doc);
        // Carried by the synthetic heading (index 0), like the lead's notes.
        assert_eq!(slide_body_hosts(&deck.slides[0]), vec![(0, vec!["S1".to_string()])]);
    }

    #[test]
    fn slide_body_on_a_body_chunk_of_a_heading_slide_is_ignored() {
        // TS `slideLead` is the heading, so this slide is NOT detached there.
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "T"));
        let mut b = Chunk::new_text(1, "body");
        b.metadata.slide_body = Some(vec!["stale".into()]);
        doc.chunks.push(b);
        let deck = document_to_deck(&doc);
        assert!(slide_body_hosts(&deck.slides[0]).is_empty(), "{:?}", slide_body_hosts(&deck.slides[0]));
    }

    #[test]
    fn slide_body_on_a_later_chunk_of_a_leading_slide_is_ignored() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_text(0, "lead"));
        let mut later = Chunk::new_text(1, "later");
        later.metadata.slide_body = Some(vec!["stale".into()]);
        doc.chunks.push(later);
        let deck = document_to_deck(&doc);
        assert!(slide_body_hosts(&deck.slides[0]).is_empty(), "{:?}", slide_body_hosts(&deck.slides[0]));
    }

    #[test]
    fn heading_without_notes_yields_empty_slide_notes() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "Intro"));
        doc.chunks.push(Chunk::new_text(1, "bullet"));
        let deck = document_to_deck(&doc);
        assert_eq!(deck.slides[0].notes, "");
    }
}
