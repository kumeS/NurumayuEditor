//! Core document data model (chunk-based architecture).
//!
//! A `Document` is an ordered collection of paragraph-sized `Chunk`s — the
//! editor treats each paragraph like a Jupyter cell. The model mirrors the
//! conceptual structure in the requirements spec (§5): every chunk carries
//! `metadata` with its type, optional diagram `format`, an optional `summary`
//! used for relationship analysis, and `linkedChunks` for the network graph.
//!
//! All structs serialize as camelCase to match the TypeScript types 1:1.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

pub const CHUNK_TYPE_TEXT: &str = "text";
pub const CHUNK_TYPE_DIAGRAM: &str = "diagram";
pub const CHUNK_TYPE_HEADING: &str = "heading";
pub const CHUNK_TYPE_IMAGE: &str = "image";
pub const DIAGRAM_FORMAT_MERMAID: &str = "mermaid";

/// Generate a fresh UUID v4 string id.
pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkMetadata {
    /// "text", "diagram", or "heading".
    #[serde(default = "default_chunk_type")]
    pub chunk_type: String,
    /// Diagram notation when `chunk_type == "diagram"` (e.g. "mermaid").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// Heading level (1–3) when `chunk_type == "heading"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,
    /// One-line summary used by the relationship/network analysis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Ids of chunks this chunk is logically linked to.
    #[serde(default)]
    pub linked_chunks: Vec<String>,
    /// For image chunks: the prompt/source text used to generate the image, so a
    /// "regenerate" can re-run the same request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_prompt: Option<String>,
    /// Prior content values for this chunk (text: previous paragraph versions;
    /// image: previously generated image URLs) so the user can swap back to an
    /// earlier version. The current value lives in `Chunk::content`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content_history: Vec<String>,
    /// For a chunk that begins a slide: an explicit slide-layout override
    /// ("section" | "title-content" | "title-image" | "title-image-left" |
    /// "image-top"). When absent, the layout is auto-picked from the slide's
    /// content (see `deck.rs`) — auto-pick only ever produces "section",
    /// "title-content" or "title-image"; the left/top image variants are
    /// manual-choice only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
    /// A text chunk marked as a subtitle (secondary title line, Req 3). In slide
    /// mode it fills the slide's subtitle box and is excluded from the bullets.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub subtitle: bool,
    /// Slide-only body override (Req 2): when set on a slide's lead chunk, the
    /// slide renders THESE lines (a summary / custom content) instead of the
    /// linked editor paragraphs — a reversible "detach" from the prose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slide_body: Option<Vec<String>>,
    /// For diagram chunks: a PNG data URL of the rendered graph, injected by the
    /// frontend into EXPORT payloads only so PPTX/RTF can embed the picture
    /// (the mermaid source in `content` stays the canonical value).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rendered_image: Option<String>,
    /// Review comments attached to this chunk (frontend-owned; Rust only
    /// persists them through save/load).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comments: Option<Vec<ReviewComment>>,
    /// Hex hash of the chunk's content at the time `summary` was written, so
    /// the frontend can tell a stale summary from a fresh one (it computes the
    /// hash; Rust only persists it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_hash: Option<String>,
    /// Optional ordering index for a slide's images (lower renders first; ties
    /// broken by document order) — see the multi-image grid in `pptx.rs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<u32>,
}

/// A review comment on a chunk (frontend-owned; persisted only). Mirrors the
/// TypeScript `ReviewComment` 1:1.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub text: String,
    /// Creation time in ms since the Unix epoch.
    #[serde(default)]
    pub created_at: u64,
    /// "user" | "ai".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved: Option<bool>,
}

fn default_chunk_type() -> String {
    CHUNK_TYPE_TEXT.to_string()
}

impl Default for ChunkMetadata {
    fn default() -> Self {
        Self {
            chunk_type: default_chunk_type(),
            format: None,
            level: None,
            summary: None,
            linked_chunks: Vec::new(),
            image_prompt: None,
            content_history: Vec::new(),
            layout: None,
            subtitle: false,
            slide_body: None,
            rendered_image: None,
            comments: None,
            summary_hash: None,
            slot: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub id: String,
    pub order: u32,
    pub content: String,
    #[serde(default)]
    pub metadata: ChunkMetadata,
}

impl Chunk {
    pub fn new_text(order: u32, content: impl Into<String>) -> Self {
        Self {
            id: new_id(),
            order,
            content: content.into(),
            metadata: ChunkMetadata::default(),
        }
    }

    pub fn new_diagram(order: u32, code: impl Into<String>, format: impl Into<String>) -> Self {
        Self {
            id: new_id(),
            order,
            content: code.into(),
            metadata: ChunkMetadata {
                chunk_type: CHUNK_TYPE_DIAGRAM.to_string(),
                format: Some(format.into()),
                ..Default::default()
            },
        }
    }

    /// A heading chunk (`# Title`). `level` is clamped to 1–3.
    pub fn new_heading(order: u32, level: u8, text: impl Into<String>) -> Self {
        Self {
            id: new_id(),
            order,
            content: text.into(),
            metadata: ChunkMetadata {
                chunk_type: CHUNK_TYPE_HEADING.to_string(),
                level: Some(level.clamp(1, 3)),
                ..Default::default()
            },
        }
    }

    pub fn is_diagram(&self) -> bool {
        self.metadata.chunk_type == CHUNK_TYPE_DIAGRAM
    }

    pub fn is_heading(&self) -> bool {
        self.metadata.chunk_type == CHUNK_TYPE_HEADING
    }

    pub fn is_image(&self) -> bool {
        self.metadata.chunk_type == CHUNK_TYPE_IMAGE
    }

    /// A text chunk flagged as a subtitle (Req 3).
    pub fn is_subtitle(&self) -> bool {
        self.metadata.subtitle && self.metadata.chunk_type == CHUNK_TYPE_TEXT
    }
}

/// View mode: "editor" (prose document) or "slide" (a deck) — switchable at
/// any time from the frontend toolbar. Persisted so a document reopens in the
/// view it was last saved in.
pub const DOC_MODE_EDITOR: &str = "editor";
/// The "slide" mode literal — set on the frontend; kept here as the documented
/// contract for the field's valid values.
#[allow(dead_code)]
pub const DOC_MODE_SLIDE: &str = "slide";

fn default_doc_mode() -> String {
    DOC_MODE_EDITOR.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub title: String,
    pub chunks: Vec<Chunk>,
    /// "editor" | "slide". Older .aix files without it load as "editor".
    #[serde(default = "default_doc_mode")]
    pub mode: String,
    /// Persisted relationship graph (spec §3.4) so it survives save/reopen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analysis: Option<AnalysisResult>,
}

impl Document {
    pub fn new(title: &str) -> Self {
        Self {
            id: new_id(),
            title: title.to_string(),
            chunks: Vec::new(),
            mode: default_doc_mode(),
            analysis: None,
        }
    }

    /// Validate and repair a freshly-loaded document so the editor's invariants
    /// hold before it is handed to the UI/undo/save/graph code (A1). A `.aix`
    /// file (or a CLI/agent-produced one) can violate them — empty chunk list,
    /// duplicate/blank ids, out-of-range heading levels, unknown enums, and
    /// `linkedChunks`/analysis references to chunks that no longer exist — and
    /// every one of those silently breaks something downstream (duplicate ids
    /// cause invisible cross-edits; dangling graph nodes jump to deleted text).
    ///
    /// Mutates `self` in place and returns human-readable notes for each class of
    /// repair (empty when the document was already well-formed) so the caller can
    /// tell the user what was changed.
    pub fn normalize(&mut self) -> Vec<String> {
        let mut notes = Vec::new();

        // ---- 1. At least one chunk (the editor always needs a writing surface).
        if self.chunks.is_empty() {
            self.chunks.push(Chunk::new_text(0, ""));
            notes.push("Document had no content; added an empty paragraph.".to_string());
        }

        // ---- 2. Known document mode.
        if self.mode != DOC_MODE_EDITOR && self.mode != DOC_MODE_SLIDE {
            notes.push(format!(
                "Unknown document mode '{}'; reset to '{}'.",
                self.mode, DOC_MODE_EDITOR
            ));
            self.mode = DOC_MODE_EDITOR.to_string();
        }

        // ---- 3. Unique, non-empty chunk ids. First occurrence keeps its id;
        // blanks and later duplicates are renumbered. References (linkedChunks /
        // analysis) addressed the original id, which still resolves to the kept
        // chunk, so they need no rewrite.
        let mut seen: HashSet<String> = HashSet::new();
        let mut renumbered = 0usize;
        for c in &mut self.chunks {
            if c.id.trim().is_empty() || !seen.insert(c.id.clone()) {
                let fresh = new_id();
                seen.insert(fresh.clone());
                c.id = fresh;
                renumbered += 1;
            }
        }
        if renumbered > 0 {
            notes.push(format!(
                "{renumbered} chunk(s) had a missing or duplicate id; assigned new ids."
            ));
        }

        let valid: HashSet<String> = self.chunks.iter().map(|c| c.id.clone()).collect();

        // ---- 4. Per-chunk metadata sanity.
        let known_types = [
            CHUNK_TYPE_TEXT,
            CHUNK_TYPE_HEADING,
            CHUNK_TYPE_DIAGRAM,
            CHUNK_TYPE_IMAGE,
        ];
        let known_layouts = [
            SLIDE_LAYOUT_SECTION,
            SLIDE_LAYOUT_TITLE_CONTENT,
            SLIDE_LAYOUT_TITLE_IMAGE,
            SLIDE_LAYOUT_TITLE_IMAGE_LEFT,
            SLIDE_LAYOUT_IMAGE_TOP,
        ];
        let mut coerced_types = 0usize;
        let mut clamped_levels = 0usize;
        let mut dropped_layouts = 0usize;
        let mut dropped_links = 0usize;
        for c in &mut self.chunks {
            if !known_types.contains(&c.metadata.chunk_type.as_str()) {
                c.metadata.chunk_type = CHUNK_TYPE_TEXT.to_string();
                coerced_types += 1;
            }
            if c.metadata.chunk_type == CHUNK_TYPE_HEADING {
                let lv = c.metadata.level.unwrap_or(1).clamp(1, 3);
                if c.metadata.level != Some(lv) {
                    c.metadata.level = Some(lv);
                    clamped_levels += 1;
                }
            }
            if let Some(layout) = &c.metadata.layout {
                if !known_layouts.contains(&layout.as_str()) {
                    c.metadata.layout = None; // fall back to auto-pick
                    dropped_layouts += 1;
                }
            }
            let before = c.metadata.linked_chunks.len();
            c.metadata
                .linked_chunks
                .retain(|t| t != &c.id && valid.contains(t));
            dropped_links += before - c.metadata.linked_chunks.len();
        }
        if coerced_types > 0 {
            notes.push(format!("{coerced_types} chunk(s) had an unknown type; reset to text."));
        }
        if clamped_levels > 0 {
            notes.push(format!("{clamped_levels} heading(s) had an out-of-range level; clamped to 1–3."));
        }
        if dropped_layouts > 0 {
            notes.push(format!("{dropped_layouts} slide(s) had an unknown layout; reset to auto."));
        }
        if dropped_links > 0 {
            notes.push(format!("Removed {dropped_links} link(s) to missing paragraphs."));
        }

        // ---- 5. Prune a persisted analysis graph of references to gone chunks.
        if let Some(a) = self.analysis.as_mut() {
            // Degenerate self-edges aren't "damage" (the graph view ignores them);
            // drop them silently so they don't trigger a spurious "repaired" note
            // (and a dirty reopen) for an otherwise-valid document.
            a.edges.retain(|e| e.source != e.target);
            let before_nodes = a.nodes.len();
            a.nodes.retain(|n| match n.kind.as_str() {
                "sentence" => n.parent.as_ref().map(|p| valid.contains(p)).unwrap_or(false),
                _ => valid.contains(&n.id),
            });
            let pruned = (before_nodes - a.nodes.len()) + a.drop_dangling_edges();
            if pruned > 0 {
                notes.push(format!(
                    "Removed {pruned} relationship-graph node(s)/edge(s) referencing missing paragraphs."
                ));
            }
        }

        // ---- 6. Re-sequence chunk order to match position.
        for (i, c) in self.chunks.iter_mut().enumerate() {
            c.order = i as u32;
        }

        notes
    }
}

// ----- slide deck model (v1.2.0) -------------------------------------------
//
// A `Deck` is an ordered list of `Slide`s; a slide is a `layout` plus a small
// group of the same `Chunk`s used by the text editor (heading = title,
// text = bullets, image, diagram), so every per-chunk AI action works inside
// slides unchanged. Decks are export-only to `.pptx` for now (see `pptx.rs`);
// `deck::document_to_deck` derives one from a text document.

pub const SLIDE_LAYOUT_SECTION: &str = "section";
pub const SLIDE_LAYOUT_TITLE_CONTENT: &str = "title-content";
pub const SLIDE_LAYOUT_TITLE_IMAGE: &str = "title-image";
pub const SLIDE_LAYOUT_TITLE_IMAGE_LEFT: &str = "title-image-left";
pub const SLIDE_LAYOUT_IMAGE_TOP: &str = "image-top";

fn default_layout() -> String {
    SLIDE_LAYOUT_TITLE_CONTENT.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slide {
    pub id: String,
    pub order: u32,
    /// "section" | "title-content" | "title-image" | "title-image-left" |
    /// "image-top".
    #[serde(default = "default_layout")]
    pub layout: String,
    /// Reused editor chunks: heading = title, text = bullets, image, diagram.
    #[serde(default)]
    pub chunks: Vec<Chunk>,
    /// Speaker notes (not yet emitted to PPTX; reserved for a later phase).
    #[serde(default)]
    pub notes: String,
}

impl Slide {
    pub fn new(order: u32, layout: impl Into<String>) -> Self {
        Self {
            id: new_id(),
            order,
            layout: layout.into(),
            chunks: Vec::new(),
            notes: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deck {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub slides: Vec<Slide>,
}

impl Deck {
    pub fn new(title: &str) -> Self {
        Self {
            id: new_id(),
            title: title.to_string(),
            slides: Vec::new(),
        }
    }
}

// ----- relationship analysis graph (spec §3.4) -----------------------------
//
// The graph has two node kinds: "paragraph" (id = chunk id) and "sentence"
// (id = "<paragraphId>#s<n>", `parent` = the owning paragraph). Edges carry a
// `relation` property naming the relationship type (cause, evidence, …).

fn default_node_kind() -> String {
    "paragraph".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisNode {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub summary: String,
    /// "paragraph" or "sentence".
    #[serde(default = "default_node_kind")]
    pub kind: String,
    /// For sentence nodes: id of the owning paragraph (chunk).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisEdge {
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub relation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    #[serde(default)]
    pub nodes: Vec<AnalysisNode>,
    #[serde(default)]
    pub edges: Vec<AnalysisEdge>,
    /// When the analysis ran, in ms since the Unix epoch (absent on older files).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analyzed_at: Option<u64>,
}

impl AnalysisResult {
    /// Drop edges whose endpoints aren't in the current node set, returning how
    /// many were removed. This is THE dangling-edge rule (item 52) — shared by
    /// the load-boundary repair (`Document::normalize` step 5) and the
    /// post-parse hygiene in `ai::analyze_document`, which previously carried
    /// their own copies. The frontend twin is `pruneAnalysis` in store.ts.
    pub fn drop_dangling_edges(&mut self) -> usize {
        let node_ids: HashSet<&str> = self.nodes.iter().map(|n| n.id.as_str()).collect();
        let before = self.edges.len();
        self.edges
            .retain(|e| node_ids.contains(e.source.as_str()) && node_ids.contains(e.target.as_str()));
        before - self.edges.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_document_gets_a_paragraph() {
        let mut doc = Document::new("D");
        let notes = doc.normalize();
        assert_eq!(doc.chunks.len(), 1);
        assert_eq!(doc.chunks[0].metadata.chunk_type, CHUNK_TYPE_TEXT);
        assert!(!notes.is_empty());
    }

    #[test]
    fn duplicate_and_blank_ids_are_renumbered() {
        let mut doc = Document::new("D");
        let mut a = Chunk::new_text(0, "a");
        a.id = "dup".into();
        let mut b = Chunk::new_text(1, "b");
        b.id = "dup".into(); // duplicate
        let mut c = Chunk::new_text(2, "c");
        c.id = "".into(); // blank
        doc.chunks = vec![a, b, c];
        let notes = doc.normalize();
        let ids: HashSet<&String> = doc.chunks.iter().map(|c| &c.id).collect();
        assert_eq!(ids.len(), 3, "all ids unique");
        assert!(doc.chunks.iter().all(|c| !c.id.trim().is_empty()));
        assert_eq!(doc.chunks[0].id, "dup", "first occurrence keeps its id");
        assert!(notes.iter().any(|n| n.contains("id")));
    }

    #[test]
    fn dangling_links_and_graph_are_pruned() {
        let mut doc = Document::new("D");
        let mut a = Chunk::new_text(0, "a");
        a.id = "c1".into();
        a.metadata.linked_chunks = vec!["c2".into(), "ghost".into(), "c1".into()];
        let mut b = Chunk::new_text(1, "b");
        b.id = "c2".into();
        doc.chunks = vec![a, b];
        doc.analysis = Some(AnalysisResult {
            nodes: vec![
                AnalysisNode { id: "c1".into(), label: "".into(), summary: "".into(), kind: "paragraph".into(), parent: None },
                AnalysisNode { id: "ghost".into(), label: "".into(), summary: "".into(), kind: "paragraph".into(), parent: None },
            ],
            edges: vec![
                AnalysisEdge { source: "c1".into(), target: "ghost".into(), relation: "".into() },
                AnalysisEdge { source: "c1".into(), target: "c1".into(), relation: "".into() },
            ],
            analyzed_at: None,
        });
        doc.normalize();
        // self-link + ghost link dropped; only the valid "c2" link remains.
        assert_eq!(doc.chunks[0].metadata.linked_chunks, vec!["c2".to_string()]);
        let a = doc.analysis.unwrap();
        assert_eq!(a.nodes.iter().map(|n| n.id.clone()).collect::<Vec<_>>(), vec!["c1"]);
        assert!(a.edges.is_empty(), "edges touching ghost are pruned");
    }

    #[test]
    fn unknown_enums_are_coerced() {
        let mut doc = Document::new("D");
        doc.mode = "weird".into();
        let mut h = Chunk::new_heading(0, 1, "H");
        h.metadata.level = Some(9); // out of range
        h.metadata.layout = Some("bogus".into());
        let mut t = Chunk::new_text(1, "t");
        t.metadata.chunk_type = "mystery".into();
        doc.chunks = vec![h, t];
        doc.normalize();
        assert_eq!(doc.mode, DOC_MODE_EDITOR);
        assert_eq!(doc.chunks[0].metadata.level, Some(3));
        assert_eq!(doc.chunks[0].metadata.layout, None);
        assert_eq!(doc.chunks[1].metadata.chunk_type, CHUNK_TYPE_TEXT);
    }

    #[test]
    fn well_formed_document_is_unchanged() {
        let mut doc = Document::new("D");
        doc.chunks.push(Chunk::new_heading(0, 1, "H"));
        doc.chunks.push(Chunk::new_text(1, "body"));
        let notes = doc.normalize();
        assert!(notes.is_empty(), "no repairs expected: {notes:?}");
    }
}
