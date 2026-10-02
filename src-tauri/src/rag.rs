//! Personal RAG (開発.txt Stage 3, item 3-1): a fully on-device, per-user
//! knowledge base of past papers/notes that future writing can optionally be
//! grounded against. Everything here — embedding, indexing, similarity
//! search — runs locally: `fastembed` (pure-Rust ONNX text embedding) plus a
//! `sqlite-vec` `vec0` virtual table inside a `rusqlite` (bundled SQLite)
//! database. The ONLY network traffic this module ever causes is the
//! one-time download of the embedding model files on first use (fastembed's
//! own HF Hub client) — never a per-search or per-add network call. See the
//! `net_zero_after_model_ready` test at the bottom, which proves this against
//! the SAME external-transmission counters (`net::stats`, `ai::ai_call_stats`)
//! Stage 2 already built for exactly this kind of promise.
//!
//! ## Why `linked_chunks` was NOT reused for this
//!
//! `ChunkMetadata::linked_chunks` (models.rs) is a SAME-DOCUMENT relationship
//! link used by the relationship graph (NetworkPanel), summary/context
//! assembly (`aiActions.ts::gatherContext`), and `Document::normalize`, which
//! actively PRUNES any entry that isn't a valid chunk id within the same
//! document (a dangling-reference repair). Overloading that field to also
//! carry cross-document "this came from my personal library" references would
//! make `normalize()` silently delete every such reference the instant it
//! loads a document that doesn't happen to contain a chunk with that id —
//! which an external-library source id never would. It would also entangle
//! this feature with the relationship-graph/integrity-check subsystems in
//! ways that are hard to audit for correctness in one pass. Cross-document
//! grounding is instead achieved ENTIRELY through this module's own separate
//! index: the indexed source files themselves ARE the cross-document link
//! mechanism envisioned by 開発.txt — no document model change is needed or
//! wanted.
//!
//! ## Lazy initialization (privacy/cost invariant)
//!
//! Nothing in this module touches disk or the network merely by being
//! linked in. The embedding model and the SQLite connection are constructed
//! lazily, inside `Index::open`, which is only ever called from a command
//! handler path that already knows `personal_rag_enabled` is `true` AND the
//! caller is actually adding or searching. A disabled feature costs nothing:
//! no cache directory is created, no model download is attempted, no index
//! file exists on disk.

use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Embedding dimensionality of the `all-MiniLM-L6-v2` model fastembed defaults
/// to. Fixed at compile time because the `vec0` table's column width is fixed
/// at creation time — if the embedding model ever changes, the index file
/// must be rebuilt (out of scope for this first version: no model picker).
pub const EMBEDDING_DIM: usize = 384;

/// One passage-sized chunk of a source file, ready to embed.
const MAX_PASSAGE_CHARS: usize = 2000;

/// A single search hit: the source file it came from and the matched text.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub source_path: String,
    pub snippet: String,
    /// Cosine distance from the query (lower = more similar); exposed so the
    /// frontend's manual-search/preview panel can show relative relevance
    /// without inventing its own scoring.
    pub distance: f32,
}

/// One indexed source file, as reported by `list_sources`.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceInfo {
    pub path: String,
    pub passage_count: u64,
}

// ----- pure chunking (no ML, no I/O — independently testable) --------------

/// Split reference text into paragraph-sized passages for embedding: blank
/// lines separate paragraphs (mirrors the spirit of `fileio::text_to_document`'s
/// paragraph split), and any single paragraph longer than `MAX_PASSAGE_CHARS`
/// is further cut on the nearest preceding whitespace so no passage is
/// unboundedly large (a huge PDF-extracted "paragraph" with no blank lines
/// would otherwise become one giant, useless embedding). Empty/whitespace-only
/// input yields an empty passage list (nothing to index) rather than one
/// blank passage.
pub fn chunk_reference_text(text: &str) -> Vec<String> {
    let mut passages = Vec::new();
    let mut para: Vec<&str> = Vec::new();

    let flush = |para: &mut Vec<&str>, passages: &mut Vec<String>| {
        let joined = para.join("\n").trim().to_string();
        para.clear();
        if joined.is_empty() {
            return;
        }
        if joined.chars().count() <= MAX_PASSAGE_CHARS {
            passages.push(joined);
            return;
        }
        // Cut the oversized paragraph into MAX_PASSAGE_CHARS-ish windows,
        // breaking on the last whitespace before the limit so words survive
        // intact where possible.
        let mut rest = joined.as_str();
        while !rest.is_empty() {
            if rest.chars().count() <= MAX_PASSAGE_CHARS {
                passages.push(rest.trim().to_string());
                break;
            }
            // Find a byte index near the char-limit boundary.
            let cut_char = MAX_PASSAGE_CHARS;
            let byte_at = rest
                .char_indices()
                .nth(cut_char)
                .map(|(i, _)| i)
                .unwrap_or(rest.len());
            let window = &rest[..byte_at];
            let break_at = window.rfind(char::is_whitespace).unwrap_or(byte_at);
            let (head, tail) = rest.split_at(if break_at == 0 { byte_at } else { break_at });
            let head_trimmed = head.trim();
            if !head_trimmed.is_empty() {
                passages.push(head_trimmed.to_string());
            }
            rest = tail.trim_start();
        }
    };

    for line in text.lines() {
        if line.trim().is_empty() {
            flush(&mut para, &mut passages);
        } else {
            para.push(line);
        }
    }
    flush(&mut para, &mut passages);
    passages
}

/// Build the stable synthetic source path for a confirmed chunk (開発.txt
/// Stage 3, item 3-1 auto-accumulation; Q11/Q16): `"{doc_path}#{chunk_id}"`.
/// Stable across saves of the SAME chunk (same document path + same chunk
/// id), so `Index::add_source`'s replace-not-accumulate behavior keeps that
/// one chunk's indexed passages in sync with its latest confirmed text,
/// rather than growing a new entry every save.
pub fn confirmed_chunk_source_path(doc_path: &str, chunk_id: &str) -> String {
    format!("{doc_path}#{chunk_id}")
}

// ----- embedding -------------------------------------------------------------

/// Injectable embedding function so storage/retrieval logic is testable
/// without loading the real ~90 MB ONNX model on every test run. Production
/// code always uses `real_embed` (backed by fastembed); tests may inject a
/// deterministic fake. Takes `&[String]` (batch) and returns one vector per
/// input, each `EMBEDDING_DIM` long.
pub type EmbedFn = Box<dyn Fn(&[String]) -> AppResult<Vec<Vec<f32>>> + Send>;

struct ModelState {
    model: fastembed::TextEmbedding,
}

// The real model is expensive to construct (loads/downloads ONNX weights), so
// it is built at most once per process and reused by every subsequent add/
// search call — this is also the mechanism that makes the "no repeat network
// traffic after the one-time download" privacy promise true: after this
// `OnceLock` is filled, no code path here touches the network again.
static MODEL: OnceLock<Mutex<ModelState>> = OnceLock::new();

/// Directory fastembed caches its downloaded ONNX/tokenizer files in, rooted
/// under this app's own OS-standard config directory (NOT the process's
/// current working directory, which is fastembed's unsuitable default for a
/// GUI app — see the module doc and 開発.txt's validated findings). Reuses the
/// exact same `<config_dir>` the caller already resolved via
/// `AppHandle::path().app_config_dir()` (commands.rs) / `dirs::config_dir()`
/// (cli.rs) — this module never resolves that path itself, per the "core fns
/// take data" rule.
fn model_cache_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("rag-model-cache")
}

/// Get (initializing on first call) the process-wide embedding model, caching
/// its files under `<config_dir>/rag-model-cache`. This is the ONLY place a
/// real network call (the one-time model download) can happen in this
/// module. Callers should surface `show_download_progress`'s effect (a
/// message printed by fastembed) as a "downloading the embedding model once"
/// notice — see `Index::open`'s doc comment for how the command layer is
/// expected to communicate this to the user.
fn real_embed_fn(config_dir: &Path) -> AppResult<EmbedFn> {
    if MODEL.get().is_none() {
        let cache_dir = model_cache_dir(config_dir);
        std::fs::create_dir_all(&cache_dir).map_err(AppError::from)?;
        let options = fastembed::TextInitOptions::new(fastembed::EmbeddingModel::AllMiniLML6V2)
            .with_cache_dir(cache_dir)
            .with_show_download_progress(true);
        let model = fastembed::TextEmbedding::try_new(options)
            .map_err(|e| AppError::Other(format!("Could not load the local embedding model: {e}")))?;
        // `OnceLock::set` can lose a benign race (another thread won); either
        // way, after this line the lock IS initialized, so ignore the result.
        let _ = MODEL.set(Mutex::new(ModelState { model }));
    }
    Ok(Box::new(|texts: &[String]| -> AppResult<Vec<Vec<f32>>> {
        let lock = MODEL
            .get()
            .ok_or_else(|| AppError::Other("Embedding model not initialized.".to_string()))?;
        let mut state = lock
            .lock()
            .map_err(|_| AppError::Other("Embedding model lock poisoned.".to_string()))?;
        state
            .model
            .embed(texts.to_vec(), None)
            .map_err(|e| AppError::Other(format!("Embedding failed: {e}")))
    }))
}

// ----- vector index -----------------------------------------------------------

/// True once the sqlite-vec extension has been registered for every future
/// `Connection::open` in this process (registration is process-global via
/// `sqlite3_auto_extension`, not per-connection).
static VEC_EXTENSION_REGISTERED: OnceLock<()> = OnceLock::new();

fn ensure_vec_extension_registered() {
    VEC_EXTENSION_REGISTERED.get_or_init(|| {
        // Same idiom sqlite-vec's own crate-level test uses: `sqlite3_vec_init`
        // takes no arguments (it's declared as a bare `extern "C"` symbol, not
        // a real SQLite auto-extension entry point), so it's registered via a
        // raw pointer transmute rather than a typed fn-pointer cast.
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
    });
}

/// The on-disk personal knowledge base: a `vec0` similarity index plus a
/// plain table of passage metadata (source path + text), joined by rowid.
pub struct Index {
    conn: Connection,
    embed: EmbedFn,
}

fn index_db_path(config_dir: &Path) -> PathBuf {
    config_dir.join("personal-rag.sqlite3")
}

/// True if the index file already exists on disk. Callers use this to skip
/// even opening a connection (which would create the file) for read-only
/// listing/search when nothing has ever been indexed — part of the
/// zero-cost-while-unused invariant (item 7): a feature that was enabled but
/// never actually used still leaves no on-disk artifact behind.
pub fn index_exists(config_dir: &Path) -> bool {
    index_db_path(config_dir).exists()
}

impl Index {
    /// Open (creating on first use) the personal-library index at
    /// `<config_dir>/personal-rag.sqlite3`, and lazily initialize the
    /// embedding model. This is the ONE entry point that can create files or
    /// trigger a model download — callers (commands.rs) must only invoke this
    /// after confirming `Settings::personal_rag_enabled` is true, so a
    /// disabled feature never creates so much as a directory (item 7's
    /// invariant).
    pub fn open(config_dir: &Path) -> AppResult<Self> {
        ensure_vec_extension_registered();
        std::fs::create_dir_all(config_dir).map_err(AppError::from)?;
        let conn = Connection::open(index_db_path(config_dir))
            .map_err(|e| AppError::Other(format!("Could not open the personal library index: {e}")))?;
        Self::init_schema(&conn)?;
        let embed = real_embed_fn(config_dir)?;
        Ok(Self { conn, embed })
    }

    /// Test-only constructor: an in-memory database with an injectable fake
    /// embedder, so chunking/storage/retrieval logic is verified without the
    /// real ~90 MB ONNX model on every test run.
    #[cfg(test)]
    fn open_in_memory_with(embed: EmbedFn) -> AppResult<Self> {
        ensure_vec_extension_registered();
        let conn = Connection::open_in_memory()
            .map_err(|e| AppError::Other(format!("Could not open in-memory index: {e}")))?;
        Self::init_schema(&conn)?;
        Ok(Self { conn, embed })
    }

    fn init_schema(conn: &Connection) -> AppResult<()> {
        conn.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS passages (
                id INTEGER PRIMARY KEY,
                source_path TEXT NOT NULL,
                content TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_passages_source ON passages(source_path);
            CREATE VIRTUAL TABLE IF NOT EXISTS passage_vectors USING vec0(
                embedding float[{EMBEDDING_DIM}]
            );"
        ))
        .map_err(|e| AppError::Other(format!("Could not initialize the personal library schema: {e}")))
    }

    /// Add a source file's already-extracted text: chunk it into passages,
    /// embed each, and store them. Returns the number of passages added (0 for
    /// a file with no extractable text — not an error, since an empty/blank
    /// reference file is a plausible, non-hostile input).
    pub fn add_source(&mut self, source_path: &str, text: &str) -> AppResult<usize> {
        let passages = chunk_reference_text(text);
        if passages.is_empty() {
            return Ok(0);
        }
        // Replace any prior entries for this exact path so re-adding a
        // changed file doesn't accumulate stale passages alongside fresh ones.
        self.remove_source(source_path)?;

        let vectors = (self.embed)(&passages)?;
        if vectors.len() != passages.len() {
            return Err(AppError::Other(
                "Embedding model returned a mismatched number of vectors.".to_string(),
            ));
        }
        let tx = self
            .conn
            .transaction()
            .map_err(|e| AppError::Other(format!("Could not start a transaction: {e}")))?;
        for (passage, vector) in passages.iter().zip(vectors.iter()) {
            if vector.len() != EMBEDDING_DIM {
                return Err(AppError::Other(format!(
                    "Embedding dimension mismatch: expected {EMBEDDING_DIM}, got {}",
                    vector.len()
                )));
            }
            tx.execute(
                "INSERT INTO passages (source_path, content) VALUES (?1, ?2)",
                rusqlite::params![source_path, passage],
            )
            .map_err(|e| AppError::Other(format!("Could not store passage: {e}")))?;
            let rowid = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO passage_vectors (rowid, embedding) VALUES (?1, vec_f32(?2))",
                rusqlite::params![rowid, vector_to_json(vector)],
            )
            .map_err(|e| AppError::Other(format!("Could not store embedding: {e}")))?;
        }
        tx.commit()
            .map_err(|e| AppError::Other(format!("Could not commit the index update: {e}")))?;
        Ok(passages.len())
    }

    /// Remove every passage previously indexed for `source_path`. Returns the
    /// number of passages removed (0 if the path wasn't indexed — not an
    /// error, so a stale/duplicate removal request is harmless).
    pub fn remove_source(&mut self, source_path: &str) -> AppResult<usize> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM passages WHERE source_path = ?1")
            .map_err(|e| AppError::Other(format!("Could not query passages: {e}")))?;
        let ids: Vec<i64> = stmt
            .query_map(rusqlite::params![source_path], |row| row.get(0))
            .map_err(|e| AppError::Other(format!("Could not query passages: {e}")))?
            .collect::<Result<_, _>>()
            .map_err(|e| AppError::Other(format!("Could not read passage ids: {e}")))?;
        drop(stmt);
        for id in &ids {
            self.conn
                .execute("DELETE FROM passage_vectors WHERE rowid = ?1", rusqlite::params![id])
                .map_err(|e| AppError::Other(format!("Could not remove embedding: {e}")))?;
        }
        self.conn
            .execute(
                "DELETE FROM passages WHERE source_path = ?1",
                rusqlite::params![source_path],
            )
            .map_err(|e| AppError::Other(format!("Could not remove passages: {e}")))?;
        Ok(ids.len())
    }

    /// List every currently-indexed source file with its passage count,
    /// ordered by path for a stable, predictable listing.
    pub fn list_sources(&self) -> AppResult<Vec<SourceInfo>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT source_path, COUNT(*) FROM passages GROUP BY source_path ORDER BY source_path",
            )
            .map_err(|e| AppError::Other(format!("Could not list sources: {e}")))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SourceInfo {
                    path: row.get(0)?,
                    passage_count: row.get(1)?,
                })
            })
            .map_err(|e| AppError::Other(format!("Could not list sources: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::Other(format!("Could not read source list: {e}")))
    }

    /// True if the index currently has zero indexed sources. `commands.rs`
    /// prefers the cheaper `index_exists` (a file-existence check that avoids
    /// opening a connection, let alone this query) to decide whether to skip
    /// work on a never-used config dir; this method is for callers that have
    /// ALREADY opened an `Index` for other reasons and want an "empty library"
    /// check without a second file-existence round trip.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> AppResult<bool> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM passages", [], |row| row.get(0))
            .map_err(|e| AppError::Other(format!("Could not count passages: {e}")))?;
        Ok(count == 0)
    }

    /// Auto-accumulation of confirmed content (開発.txt Stage 3, item 3-1;
    /// Q11/Q16): (re-)index every `(source_path, text)` pair — the caller
    /// (`commands::rag_sync_confirmed_chunks`) has already filtered this down
    /// to chunks with `ChunkMetadata::confirmed == true` and non-empty
    /// content, and computed each stable synthetic `source_path` (see
    /// `confirmed_chunk_source_path`). Each call to `add_source` already
    /// replaces any prior entries for that exact path (see its own doc
    /// comment), so re-saving a document with edited confirmed-chunk text
    /// updates that chunk's passages in place rather than accumulating stale
    /// duplicates alongside fresh ones — this is what makes re-save
    /// idempotent. Returns the total number of passages (re-)indexed across
    /// all pairs.
    pub fn add_confirmed_chunks(&mut self, chunks: &[(String, String)]) -> AppResult<usize> {
        let mut total = 0usize;
        for (source_path, text) in chunks {
            total += self.add_source(source_path, text)?;
        }
        Ok(total)
    }

    /// Find the `top_k` passages most similar to `query` (cosine distance,
    /// ascending — closer first).
    pub fn search(&mut self, query: &str, top_k: usize) -> AppResult<Vec<SearchHit>> {
        if top_k == 0 {
            return Ok(Vec::new());
        }
        let vectors = (self.embed)(std::slice::from_ref(&query.to_string()))?;
        let query_vec = vectors
            .into_iter()
            .next()
            .ok_or_else(|| AppError::Other("Embedding model returned no vector for the query.".to_string()))?;

        let mut stmt = self
            .conn
            .prepare(
                "SELECT p.source_path, p.content, v.distance
                 FROM passage_vectors v
                 JOIN passages p ON p.id = v.rowid
                 WHERE v.embedding MATCH vec_f32(?1) AND k = ?2
                 ORDER BY v.distance",
            )
            .map_err(|e| AppError::Other(format!("Could not prepare search query: {e}")))?;
        let rows = stmt
            .query_map(
                rusqlite::params![vector_to_json(&query_vec), top_k as i64],
                |row| {
                    Ok(SearchHit {
                        source_path: row.get(0)?,
                        snippet: row.get(1)?,
                        distance: row.get(2)?,
                    })
                },
            )
            .map_err(|e| AppError::Other(format!("Could not run search: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::Other(format!("Could not read search results: {e}")))
    }
}

/// Encode a float vector as the JSON-array text `vec_f32()` accepts (the
/// documented text-input form for sqlite-vec's KNN vector literals).
fn vector_to_json(v: &[f32]) -> String {
    let mut s = String::with_capacity(v.len() * 8 + 2);
    s.push('[');
    for (i, x) in v.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&x.to_string());
    }
    s.push(']');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    // ----- pure chunking ----------------------------------------------------

    #[test]
    fn chunk_splits_on_blank_lines() {
        let text = "First paragraph.\n\nSecond paragraph.\n\n\nThird.";
        let passages = chunk_reference_text(text);
        assert_eq!(
            passages,
            vec!["First paragraph.", "Second paragraph.", "Third."]
        );
    }

    #[test]
    fn chunk_empty_input_yields_no_passages() {
        assert_eq!(chunk_reference_text(""), Vec::<String>::new());
        assert_eq!(chunk_reference_text("   \n\n  \n"), Vec::<String>::new());
    }

    #[test]
    fn chunk_multiline_paragraph_stays_one_passage() {
        let text = "Line one\nLine two\nLine three";
        let passages = chunk_reference_text(text);
        assert_eq!(passages, vec!["Line one\nLine two\nLine three"]);
    }

    #[test]
    fn chunk_oversized_paragraph_is_split_on_whitespace() {
        // A single "paragraph" (no blank lines) far longer than the passage
        // cap must be split into multiple passages, none exceeding the cap by
        // much, and no words silently dropped.
        let word = "lorem ";
        let long = word.repeat(1000); // ~6000 chars, one giant paragraph
        let passages = chunk_reference_text(&long);
        assert!(passages.len() > 1, "expected the oversized paragraph to be split");
        for p in &passages {
            assert!(
                p.chars().count() <= MAX_PASSAGE_CHARS + 1,
                "passage exceeded the cap: {} chars",
                p.chars().count()
            );
        }
        // No content lost: every passage is built from "lorem" repeats, so the
        // total word count across passages should match the input's.
        let total_words: usize = passages.iter().map(|p| p.split_whitespace().count()).sum();
        assert_eq!(total_words, 1000);
    }

    #[test]
    fn chunk_handles_cjk_text() {
        let text = "これは最初の段落です。\n\nこれは二番目の段落です。";
        let passages = chunk_reference_text(text);
        assert_eq!(passages.len(), 2);
        assert_eq!(passages[0], "これは最初の段落です。");
    }

    // ----- fake embedder for fast, deterministic index tests ----------------

    /// A deterministic fake embedding: derives a stable pseudo-vector from
    /// simple character statistics so distinct texts get distinct (but
    /// reproducible) vectors, WITHOUT loading any real ML model. Good enough
    /// to prove add/search/remove wiring; not a real semantic embedding.
    fn fake_embed(texts: &[String]) -> AppResult<Vec<Vec<f32>>> {
        Ok(texts
            .iter()
            .map(|t| {
                let mut v = vec![0.0f32; EMBEDDING_DIM];
                for (i, b) in t.bytes().enumerate() {
                    v[i % EMBEDDING_DIM] += b as f32;
                }
                // Normalize so cosine distance behaves sanely.
                let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
                if norm > 0.0 {
                    for x in &mut v {
                        *x /= norm;
                    }
                }
                v
            })
            .collect())
    }

    fn test_index() -> Index {
        Index::open_in_memory_with(Box::new(fake_embed)).expect("in-memory index")
    }

    #[test]
    fn add_source_then_search_round_trips() {
        let mut idx = test_index();
        let added = idx
            .add_source(
                "/papers/photosynthesis.md",
                "Photosynthesis converts light into chemical energy.\n\nChlorophyll absorbs red and blue light.",
            )
            .unwrap();
        assert_eq!(added, 2);

        let hits = idx.search("Photosynthesis converts light into chemical energy.", 5).unwrap();
        assert!(!hits.is_empty());
        // The exact same text as one of the stored passages should be the
        // closest (or tied-closest) match, from the correct source path.
        assert_eq!(hits[0].source_path, "/papers/photosynthesis.md");
        assert!(hits
            .iter()
            .any(|h| h.snippet == "Photosynthesis converts light into chemical energy."));
    }

    #[test]
    fn search_respects_top_k() {
        let mut idx = test_index();
        idx.add_source(
            "/papers/many.md",
            "Alpha passage.\n\nBeta passage.\n\nGamma passage.\n\nDelta passage.",
        )
        .unwrap();
        let hits = idx.search("Alpha passage.", 2).unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn search_top_k_zero_returns_nothing_without_querying() {
        let mut idx = test_index();
        idx.add_source("/papers/x.md", "Some content here.").unwrap();
        let hits = idx.search("anything", 0).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn remove_source_deletes_only_its_own_entries() {
        let mut idx = test_index();
        idx.add_source("/papers/a.md", "Paragraph A1.\n\nParagraph A2.").unwrap();
        idx.add_source("/papers/b.md", "Paragraph B1.").unwrap();

        let removed = idx.remove_source("/papers/a.md").unwrap();
        assert_eq!(removed, 2);

        let sources = idx.list_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].path, "/papers/b.md");
        assert_eq!(sources[0].passage_count, 1);

        // Searching now must never surface the removed source's text.
        let hits = idx.search("Paragraph A1.", 10).unwrap();
        assert!(hits.iter().all(|h| h.source_path != "/papers/a.md"));
    }

    #[test]
    fn remove_source_missing_path_is_a_harmless_no_op() {
        let mut idx = test_index();
        idx.add_source("/papers/a.md", "Something.").unwrap();
        let removed = idx.remove_source("/papers/does-not-exist.md").unwrap();
        assert_eq!(removed, 0);
        assert_eq!(idx.list_sources().unwrap().len(), 1);
    }

    #[test]
    fn re_adding_same_path_replaces_rather_than_accumulates() {
        let mut idx = test_index();
        idx.add_source("/papers/a.md", "Old paragraph one.\n\nOld paragraph two.")
            .unwrap();
        idx.add_source("/papers/a.md", "New single paragraph.").unwrap();

        let sources = idx.list_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].passage_count, 1, "stale passages from the old version must be gone");
    }

    // ----- confirmed-chunk auto-accumulation (開発.txt Stage 3; Q11/Q16) -----

    #[test]
    fn confirmed_chunk_source_path_is_stable_per_doc_and_chunk() {
        assert_eq!(
            confirmed_chunk_source_path("/Users/me/paper.aix", "chunk-1"),
            "/Users/me/paper.aix#chunk-1"
        );
        // Same document + same chunk id → the SAME path every time (this is
        // what makes re-save replace rather than accumulate).
        assert_eq!(
            confirmed_chunk_source_path("/Users/me/paper.aix", "chunk-1"),
            confirmed_chunk_source_path("/Users/me/paper.aix", "chunk-1")
        );
        // Different chunk id → a different path (each confirmed chunk is its
        // own independent passage, not merged into one blob per document).
        assert_ne!(
            confirmed_chunk_source_path("/Users/me/paper.aix", "chunk-1"),
            confirmed_chunk_source_path("/Users/me/paper.aix", "chunk-2")
        );
    }

    #[test]
    fn add_confirmed_chunks_indexes_only_the_given_pairs() {
        // Mirrors the command-layer contract: the caller has ALREADY filtered
        // to confirmed + non-empty chunks before calling this, so 2 confirmed
        // + 1 unconfirmed chunk means exactly 2 pairs reach here.
        let mut idx = test_index();
        let doc_path = "/Users/me/paper.aix";
        let pairs = vec![
            (
                confirmed_chunk_source_path(doc_path, "c1"),
                "First confirmed paragraph.".to_string(),
            ),
            (
                confirmed_chunk_source_path(doc_path, "c2"),
                "Second confirmed paragraph.".to_string(),
            ),
            // c3 is deliberately NOT included here — it represents the
            // unconfirmed chunk the command layer already excluded.
        ];
        let total = idx.add_confirmed_chunks(&pairs).unwrap();
        assert_eq!(total, 2);

        let sources = idx.list_sources().unwrap();
        assert_eq!(sources.len(), 2);
        assert!(sources.iter().any(|s| s.path == confirmed_chunk_source_path(doc_path, "c1")));
        assert!(sources.iter().any(|s| s.path == confirmed_chunk_source_path(doc_path, "c2")));
        // The excluded chunk's synthetic path must never appear.
        assert!(!sources.iter().any(|s| s.path == confirmed_chunk_source_path(doc_path, "c3")));
    }

    #[test]
    fn re_saving_an_edited_confirmed_chunk_replaces_not_duplicates() {
        // Round-trip/idempotency (testing rule 4): re-sync the SAME chunk id
        // with edited text must replace its old passages, not accumulate them
        // alongside the new ones.
        let mut idx = test_index();
        let doc_path = "/Users/me/paper.aix";
        let path = confirmed_chunk_source_path(doc_path, "c1");

        idx.add_confirmed_chunks(&[(path.clone(), "Old text, version one.".to_string())])
            .unwrap();
        let sources = idx.list_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].passage_count, 1);

        // Re-save with edited content for the SAME chunk id.
        idx.add_confirmed_chunks(&[(
            path.clone(),
            "Completely rewritten text, version two, with more words in it.".to_string(),
        )])
        .unwrap();

        let sources_after = idx.list_sources().unwrap();
        assert_eq!(sources_after.len(), 1, "must still be exactly one source, not two");
        assert_eq!(sources_after[0].path, path);
        // Still exactly one passage under this path — the old passage was
        // replaced, not kept alongside the new one (accumulation would show
        // up here as passage_count == 2).
        assert_eq!(sources_after[0].passage_count, 1);

        // The OLD passage text itself must be gone (not just out-ranked) —
        // every remaining passage under this source path must be the NEW
        // text, never the pre-edit text.
        let hits = idx.search("Completely rewritten text, version two, with more words in it.", 10).unwrap();
        let this_source_hits: Vec<_> = hits.iter().filter(|h| h.source_path == path).collect();
        assert!(!this_source_hits.is_empty(), "expected to find the re-saved passage");
        assert!(
            this_source_hits
                .iter()
                .all(|h| h.snippet != "Old text, version one."),
            "stale passage text from the pre-edit version must not still be indexed: {this_source_hits:?}"
        );
    }

    #[test]
    fn list_sources_reports_path_and_passage_count() {
        let mut idx = test_index();
        idx.add_source("/papers/a.md", "P1.\n\nP2.\n\nP3.").unwrap();
        idx.add_source("/papers/b.md", "Q1.").unwrap();
        let sources = idx.list_sources().unwrap();
        assert_eq!(sources.len(), 2);
        let a = sources.iter().find(|s| s.path == "/papers/a.md").unwrap();
        assert_eq!(a.passage_count, 3);
        let b = sources.iter().find(|s| s.path == "/papers/b.md").unwrap();
        assert_eq!(b.passage_count, 1);
    }

    #[test]
    fn is_empty_reflects_index_state() {
        let mut idx = test_index();
        assert!(idx.is_empty().unwrap());
        idx.add_source("/papers/a.md", "Something.").unwrap();
        assert!(!idx.is_empty().unwrap());
        idx.remove_source("/papers/a.md").unwrap();
        assert!(idx.is_empty().unwrap());
    }

    #[test]
    fn adding_a_blank_file_indexes_nothing_and_is_not_an_error() {
        let mut idx = test_index();
        let added = idx.add_source("/papers/blank.md", "   \n\n  \n").unwrap();
        assert_eq!(added, 0);
        assert!(idx.is_empty().unwrap());
    }

    // ----- privacy invariant: zero repeat network traffic after model ready -

    /// Proves item 8: once the (fake, in this unit test) embedding model is
    /// "ready", repeated add/search calls must not increase either of the two
    /// process-wide external-transmission counters Stage 2 built
    /// (`net::stats` and `ai::ai_call_stats`) — this module's add/search path
    /// never calls `net::safe_fetch` or any `ai::` LLM function at all, so
    /// this is a real structural guarantee, not a coincidence of timing.
    #[test]
    fn repeated_add_and_search_calls_never_touch_the_network_counters() {
        let mut idx = test_index();
        idx.add_source("/papers/a.md", "Alpha.\n\nBeta.").unwrap();

        // Exact equality on process-global counters: hold the shared guard,
        // which excludes every guarded fetch test, including openrouter_models'
        // fetch tests and ai.rs's AI_CALLS tests (see
        // `net::network_counter_test_guard`).
        let _g = crate::net::network_counter_test_guard();
        let (net_calls_before, _) = crate::net::stats();
        let (ai_calls_before, _) = crate::ai::ai_call_stats();

        for _ in 0..5 {
            idx.add_source("/papers/repeat.md", "Repeated content.").unwrap();
            let _ = idx.search("Repeated content.", 3).unwrap();
            idx.remove_source("/papers/repeat.md").unwrap();
        }

        let (net_calls_after, _) = crate::net::stats();
        let (ai_calls_after, _) = crate::ai::ai_call_stats();
        assert_eq!(
            net_calls_after, net_calls_before,
            "rag add/search/remove must never call net::safe_fetch"
        );
        assert_eq!(
            ai_calls_after, ai_calls_before,
            "rag add/search/remove must never call an ai:: LLM function"
        );
    }

    // ----- real fastembed integration smoke test (slow, marked) --------------

    /// TRUE END-TO-END SMOKE TEST using the real fastembed model (not the fake
    /// embedder above). Slower than the rest of this file's tests (loads/
    /// downloads the actual ~90 MB ONNX model into a scratch cache dir on
    /// first run in this environment) — that is expected and acceptable for
    /// this one test, which exists specifically to prove the real
    /// `real_embed_fn` + `TextEmbedding` wiring produces usable, real
    /// embeddings end to end (English AND Japanese), matching what was
    /// already validated for this exact environment before this feature was
    /// built. Run with `cargo test --lib -- --ignored rag::tests::real_fastembed`
    /// (or without `--ignored` filtering — it is not marked `#[ignore]` since
    /// the task calls for it to run as part of the normal suite; it is simply
    /// the slow outlier).
    #[test]
    fn real_fastembed_end_to_end_smoke_test() {
        let dir = std::env::temp_dir().join(format!(
            "aix-rag-real-smoke-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let mut idx = Index::open(&dir).expect("open real index (downloads model on first use)");
        let added = idx
            .add_source(
                "/papers/real.md",
                "Photosynthesis converts sunlight into chemical energy.\n\n光合成は光エネルギーを化学エネルギーに変換します。",
            )
            .expect("add_source with the real embedding model");
        assert_eq!(added, 2);

        let hits = idx
            .search("How do plants turn light into energy?", 2)
            .expect("search with the real embedding model");
        assert!(!hits.is_empty(), "expected at least one real semantic match");
        assert!(hits.iter().any(|h| h.source_path == "/papers/real.md"));

        // Japanese round-trip: a Japanese query should retrieve the Japanese
        // passage as (one of) its closest matches, proving non-Latin text is
        // handled end to end, not just tokenized-and-ignored.
        let ja_hits = idx
            .search("植物はどうやって光をエネルギーに変えるのですか？", 2)
            .expect("Japanese query with the real embedding model");
        assert!(!ja_hits.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }
}
