//! Citation management (開発.txt Stage 3, item 3-2).
//!
//! Deliberate scope, stated up front so it is never silently mistaken for
//! more than it is:
//!
//!   * This is "bring your own references and format them" — NOT a literature
//!     search engine. There is no discovery/recommendation feature here and
//!     none is planned; that space (Elicit, Consensus, and similar) is an
//!     explicit non-goal for this project.
//!   * BibTeX import uses the well-established `biblatex` crate (not a
//!     hand-rolled parser). BibTeX is the universal export format from
//!     Zotero and virtually every other reference manager, so this alone
//!     covers "already have a library elsewhere" without needing to talk to
//!     any of those tools directly.
//!   * Citation-style formatting supports EXACTLY TWO hand-written styles:
//!     **APA (7th edition, author-date)** and **IEEE (numbered bracket)**.
//!     This is NOT a general Citation Style Language (CSL) engine — that is
//!     a much bigger undertaking and explicitly out of scope for this first
//!     version. Additional styles are a natural, planned future extension.
//!   * DOI/arXiv metadata lookup goes through the CrossRef REST API and the
//!     arXiv Atom API respectively, both via `net::safe_fetch` — the single
//!     guarded fetch chokepoint (SSRF filtering, size cap, timeout). Parsing
//!     of both response shapes is a small, hand-written subset (title,
//!     authors, year, container/venue) — not a general JSON schema or a
//!     general Atom/RSS parser.
//!
//! ## Persistence: per-document, not a new cross-document store
//!
//! Citations are stored inside the SAME `.aix` document JSON the rest of the
//! app already round-trips (`CitationLibrary`, embedded as an extra top-level
//! key alongside chunks — see `commands.rs`'s `citations_*` handlers for how
//! the per-document file is resolved). A per-document library is the
//! simpler, safer choice for a first version: it needs no new cross-document
//! storage location (unlike the personal-RAG feature's independent sqlite
//! index, which genuinely needs to outlive any one document), and citations
//! naturally travel with the paper that cites them.
//!
//! Concretely, the library lives in a sidecar JSON file next to the `.aix`
//! document (`<document>.citations.json`), keyed by the document's own file
//! path, so opening the same document later sees the same library without
//! requiring any change to `models::Document` (owned by a sibling feature,
//! out of scope for this change) or to the `.aix` schema itself.

use crate::error::{AppError, AppResult};
use crate::fileio;
use biblatex::{Bibliography, ChunksExt};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ----- data model ------------------------------------------------------

/// One imported/looked-up citation entry. Deliberately flat (no nested BibTeX
/// chunk types leak out of this module) so it serializes simply to/from JSON
/// and mirrors 1:1 into `src/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CitationEntry {
    /// Stable id for this entry (UUID v4), independent of the BibTeX key so
    /// renaming the key in a re-imported `.bib` doesn't orphan references.
    pub id: String,
    /// The original BibTeX citation key, kept for round-tripping and display
    /// (e.g. "smith2020").
    pub bibtex_key: String,
    /// "article", "inproceedings", "book", … (lowercased BibTeX/BibLaTeX entry
    /// type name).
    pub entry_type: String,
    pub authors: Vec<String>,
    pub title: String,
    /// Publication year, if determinable from the entry's date/year fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    /// Journal/booktitle/venue — whichever the entry type supplies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// The persisted, per-document citation library (see module doc for why this
/// is per-document rather than a new cross-document store).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationLibrary {
    #[serde(default)]
    pub entries: Vec<CitationEntry>,
}

/// The two supported citation styles (see module doc: this is intentionally
/// NOT a general CSL engine).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CitationStyle {
    Apa,
    Ieee,
}

impl std::str::FromStr for CitationStyle {
    type Err = AppError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "apa" => Ok(Self::Apa),
            "ieee" => Ok(Self::Ieee),
            other => Err(AppError::Other(format!(
                "Unknown citation style '{other}'. Supported styles: apa, ieee."
            ))),
        }
    }
}

// ----- sidecar persistence ----------------------------------------------

/// The sidecar file path for a given `.aix` document path: `<doc>.citations.json`.
/// Kept alongside the document rather than inside the `.aix` JSON itself so
/// this feature never needs to touch `models::Document` (owned by a sibling
/// feature) or the `.aix` schema/back-compat story.
pub fn library_path_for(document_path: &str) -> PathBuf {
    let mut p = PathBuf::from(document_path);
    let file_name = p
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    p.set_file_name(format!("{file_name}.citations.json"));
    p
}

/// Load the citation library for a document. A missing sidecar (no citations
/// imported yet) is a real empty library, not an error.
pub fn load_library(document_path: &str) -> AppResult<CitationLibrary> {
    let path = library_path_for(document_path);
    if !path.exists() {
        return Ok(CitationLibrary::default());
    }
    let text = std::fs::read_to_string(&path)?;
    match serde_json::from_str(&text) {
        Ok(lib) => Ok(lib),
        Err(_) => {
            // A corrupt sidecar is treated the same way `commands::load_session`
            // treats a corrupt session file: self-heal rather than hard-fail
            // every future open of this document.
            Ok(CitationLibrary::default())
        }
    }
}

/// Persist the citation library for a document (atomic write — A9).
pub fn save_library(document_path: &str, library: &CitationLibrary) -> AppResult<()> {
    let path = library_path_for(document_path);
    fileio::write_atomic(&path, serde_json::to_string_pretty(library)?.as_bytes())
}

// ----- BibTeX import (pure parsing — no I/O) ----------------------------

/// Parse `.bib` source text into citation entries. Pure function: takes data,
/// returns data, so it is directly unit-testable against fixture strings
/// without touching disk.
///
/// A syntactically malformed `.bib` (unbalanced braces, stray tokens, …)
/// yields a clear, actionable `AppError` rather than a panic. An
/// individual entry that parses syntactically but is missing its title is
/// SKIPPED with a warning message collected in the returned report rather
/// than aborting the whole import — one bad entry in a 200-entry library
/// export shouldn't block the other 199.
pub struct ImportReport {
    pub entries: Vec<CitationEntry>,
    pub warnings: Vec<String>,
}

pub fn parse_bibtex(src: &str) -> AppResult<ImportReport> {
    let bib = Bibliography::parse(src).map_err(|e| {
        AppError::Other(format!(
            "Could not parse the BibTeX file: {e}. Check for a missing brace or comma near \
             the reported position."
        ))
    })?;

    let mut entries = Vec::new();
    let mut warnings = Vec::new();

    for entry in bib.iter() {
        match entry_from_biblatex(entry) {
            Ok(e) => entries.push(e),
            Err(msg) => warnings.push(format!("Entry '{}': {msg}", entry.key)),
        }
    }

    Ok(ImportReport { entries, warnings })
}

/// Convert one parsed `biblatex::Entry` into our flat `CitationEntry`.
/// `Err(message)` for an entry missing a required field (title) — the ONE
/// field every citation style needs to produce non-garbage output; authors,
/// year, venue, etc. are all optional and simply omitted when absent.
fn entry_from_biblatex(entry: &biblatex::Entry) -> Result<CitationEntry, String> {
    let title = entry
        .title()
        .map(|c| c.format_verbatim())
        .map_err(|_| "missing required 'title' field".to_string())?;

    let authors = entry
        .author()
        .map(|people| people.iter().map(format_person_name).collect::<Vec<_>>())
        .unwrap_or_default();

    let year = extract_year(entry);

    let venue = entry
        .journal()
        .map(|c| c.format_verbatim())
        .ok()
        .or_else(|| entry.book_title().map(|c| c.format_verbatim()).ok())
        .or_else(|| entry.publisher().ok().map(|c| format_chunks_list(&c)))
        .or_else(|| entry.venue().map(|c| c.format_verbatim()).ok());

    let doi = entry.doi().ok();
    let volume = entry.volume().ok().map(|v| format_permissive_i64(&v));
    let number = entry.number().map(|c| c.format_verbatim()).ok();
    let pages = entry.pages().ok().map(|p| format_pages(&p));
    let publisher = entry.publisher().ok().map(|c| format_chunks_list(&c));
    let url = entry.url().ok();

    Ok(CitationEntry {
        id: uuid::Uuid::new_v4().to_string(),
        bibtex_key: entry.key.clone(),
        entry_type: entry.entry_type.to_string().to_ascii_lowercase(),
        authors,
        title,
        year,
        venue,
        doi,
        volume,
        number,
        pages,
        publisher,
        url,
    })
}

fn format_person_name(p: &biblatex::Person) -> String {
    if p.given_name.is_empty() {
        p.name.clone()
    } else {
        format!("{} {}", p.given_name, p.name)
    }
}

/// `volume`/`edition` are typed as `PermissiveType<i64>` (a plain integer, or
/// a literal string like "Special Issue" that doesn't parse as one).
fn format_permissive_i64(v: &biblatex::PermissiveType<i64>) -> String {
    match v {
        biblatex::PermissiveType::Typed(n) => n.to_string(),
        biblatex::PermissiveType::Chunks(chunks) => chunks.format_verbatim(),
    }
}

/// `publisher`/`organization`/`orig_location` are typed as `Vec<Chunks>` (a
/// BibLaTeX entry may list more than one publisher) — join them for display.
fn format_chunks_list(list: &[biblatex::Chunks]) -> String {
    list.iter()
        .map(|c| c.format_verbatim())
        .collect::<Vec<_>>()
        .join(", ")
}

fn format_pages(p: &biblatex::PermissiveType<Vec<std::ops::Range<u32>>>) -> String {
    match p {
        biblatex::PermissiveType::Typed(ranges) => ranges
            .iter()
            .map(|r| {
                if r.end > r.start {
                    format!("{}-{}", r.start, r.end)
                } else {
                    format!("{}", r.start)
                }
            })
            .collect::<Vec<_>>()
            .join(", "),
        biblatex::PermissiveType::Chunks(chunks) => chunks.format_verbatim(),
    }
}

/// Best-effort year extraction: try the typed `date()`/`year` fields; on any
/// failure fall back to scanning the raw `year` (or `date`) field text for a
/// plausible 4-digit year. Real-world `.bib` files vary a lot here (`{2020}`,
/// `2020`, `2020-05`, a BibLaTeX `date = {2020-05-01}`, …) and this must never
/// panic on any of them.
fn extract_year(entry: &biblatex::Entry) -> Option<i32> {
    if let Some(raw) = entry.get("year") {
        if let Some(y) = first_four_digit_number(&raw.format_verbatim()) {
            return Some(y);
        }
    }
    if let Some(raw) = entry.get("date") {
        if let Some(y) = first_four_digit_number(&raw.format_verbatim()) {
            return Some(y);
        }
    }
    None
}

fn first_four_digit_number(s: &str) -> Option<i32> {
    let bytes: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        if bytes[i..i + 4].iter().all(|c| c.is_ascii_digit()) {
            let is_boundary_before = i == 0 || !bytes[i - 1].is_ascii_digit();
            let is_boundary_after = i + 4 == bytes.len() || !bytes[i + 4].is_ascii_digit();
            if is_boundary_before && is_boundary_after {
                return bytes[i..i + 4].iter().collect::<String>().parse().ok();
            }
        }
        i += 1;
    }
    None
}

// ----- citation-style formatting (hand-written; APA + IEEE only) -------

/// Format one entry in the given style. `index` is the entry's 1-based
/// position in the bibliography list, used only by IEEE's numbered-bracket
/// style (APA ignores it — author-date has no numbering).
pub fn format_citation(entry: &CitationEntry, style: CitationStyle, index: usize) -> String {
    match style {
        CitationStyle::Apa => format_apa(entry),
        CitationStyle::Ieee => format_ieee(entry, index),
    }
}

/// APA 7th-edition author-date style, e.g.:
/// `Smith, J., & Doe, J. (2020). A study of things. Journal of Studies, 12(3), 100-110.`
fn format_apa(e: &CitationEntry) -> String {
    let authors = format_authors_apa(&e.authors);
    let year = e
        .year
        .map(|y| y.to_string())
        .unwrap_or_else(|| "n.d.".to_string());
    let mut out = String::new();
    if !authors.is_empty() {
        out.push_str(&authors);
        out.push(' ');
    }
    out.push_str(&format!("({year}). "));
    out.push_str(e.title.trim());
    if !e.title.trim().ends_with('.') {
        out.push('.');
    }
    if let Some(venue) = &e.venue {
        out.push(' ');
        out.push_str(venue);
        let mut vol_num = String::new();
        if let Some(vol) = &e.volume {
            vol_num.push_str(vol);
            if let Some(num) = &e.number {
                vol_num.push_str(&format!("({num})"));
            }
        }
        if !vol_num.is_empty() {
            out.push_str(&format!(", {vol_num}"));
        }
        if let Some(pages) = &e.pages {
            out.push_str(&format!(", {pages}"));
        }
        out.push('.');
    }
    if let Some(doi) = &e.doi {
        out.push_str(&format!(" https://doi.org/{doi}"));
    }
    out
}

/// APA author list: "Last, F. M., & Last, F. M." (last author joined with
/// "&"; earlier ones comma-separated) — a single hand-written rule set, not a
/// full APA-name-abbreviation engine.
fn format_authors_apa(authors: &[String]) -> String {
    let formatted: Vec<String> = authors.iter().map(|a| apa_one_author(a)).collect();
    match formatted.len() {
        0 => String::new(),
        1 => formatted[0].clone(),
        _ => {
            let (last, rest) = formatted.split_last().unwrap();
            format!("{}, & {}", rest.join(", "), last)
        }
    }
}

/// "John Smith" -> "Smith, J."; a bare single-token name is returned as-is.
fn apa_one_author(name: &str) -> String {
    let parts: Vec<&str> = name.split_whitespace().collect();
    match parts.len() {
        0 => String::new(),
        1 => parts[0].to_string(),
        _ => {
            let (given_parts, last) = parts.split_at(parts.len() - 1);
            let initials: String = given_parts
                .iter()
                .filter_map(|p| p.chars().next())
                .map(|c| format!("{}.", c.to_ascii_uppercase()))
                .collect::<Vec<_>>()
                .join(" ");
            format!("{}, {}", last[0], initials)
        }
    }
}

/// IEEE numbered-bracket style, e.g.:
/// `[1] J. Smith and J. Doe, "A study of things," Journal of Studies, vol. 12, no. 3, pp. 100-110, 2020.`
fn format_ieee(e: &CitationEntry, index: usize) -> String {
    let authors = format_authors_ieee(&e.authors);
    let mut out = format!("[{index}] ");
    if !authors.is_empty() {
        out.push_str(&authors);
        out.push_str(", ");
    }
    out.push('"');
    out.push_str(e.title.trim());
    out.push_str(",\" ");
    if let Some(venue) = &e.venue {
        out.push_str(venue);
        out.push_str(", ");
    }
    if let Some(vol) = &e.volume {
        out.push_str(&format!("vol. {vol}, "));
    }
    if let Some(num) = &e.number {
        out.push_str(&format!("no. {num}, "));
    }
    if let Some(pages) = &e.pages {
        out.push_str(&format!("pp. {pages}, "));
    }
    if let Some(y) = e.year {
        out.push_str(&format!("{y}."));
    } else {
        // Trim a trailing ", " left dangling when there's no year to close with.
        if out.ends_with(", ") {
            out.truncate(out.len() - 2);
            out.push('.');
        } else {
            out.push('.');
        }
    }
    if let Some(doi) = &e.doi {
        out.push_str(&format!(" doi: {doi}."));
    }
    out
}

/// IEEE author list: "F. Last" per author, joined with "and" (or ", " before
/// the final "and" when there are 3+, matching IEEE's own house style).
fn format_authors_ieee(authors: &[String]) -> String {
    let formatted: Vec<String> = authors.iter().map(|a| ieee_one_author(a)).collect();
    match formatted.len() {
        0 => String::new(),
        1 => formatted[0].clone(),
        2 => format!("{} and {}", formatted[0], formatted[1]),
        _ => {
            let (last, rest) = formatted.split_last().unwrap();
            format!("{}, and {}", rest.join(", "), last)
        }
    }
}

/// "John Smith" -> "J. Smith".
fn ieee_one_author(name: &str) -> String {
    let parts: Vec<&str> = name.split_whitespace().collect();
    match parts.len() {
        0 => String::new(),
        1 => parts[0].to_string(),
        _ => {
            let (given_parts, last) = parts.split_at(parts.len() - 1);
            let initials: String = given_parts
                .iter()
                .filter_map(|p| p.chars().next())
                .map(|c| format!("{}.", c.to_ascii_uppercase()))
                .collect::<Vec<_>>()
                .join(" ");
            format!("{} {}", initials, last[0])
        }
    }
}

/// Build an end-of-document bibliography/references list from the given
/// entries (only those actually cited, chosen by the caller), in the given
/// style. IEEE numbers them in the given order (1-based); APA sorts
/// alphabetically by the first author's surname (falling back to title when
/// there's no author), matching each style's own convention.
pub fn format_bibliography(entries: &[CitationEntry], style: CitationStyle) -> Vec<String> {
    match style {
        CitationStyle::Ieee => entries
            .iter()
            .enumerate()
            .map(|(i, e)| format_citation(e, style, i + 1))
            .collect(),
        CitationStyle::Apa => {
            let mut sorted: Vec<&CitationEntry> = entries.iter().collect();
            sorted.sort_by_key(|e| {
                e.authors
                    .first()
                    .map(|a| a.split_whitespace().last().unwrap_or(a).to_ascii_lowercase())
                    .unwrap_or_else(|| e.title.to_ascii_lowercase())
            });
            sorted
                .iter()
                .map(|e| format_citation(e, style, 0))
                .collect()
        }
    }
}

// ----- DOI / arXiv metadata lookup (parsing only — fetch is in commands.rs) --

/// Metadata fetched for auto-filling a new citation entry.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LookupResult {
    pub title: String,
    pub authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abstract_text: Option<String>,
}

impl LookupResult {
    /// Turn a lookup result into a full citation entry ready to add to the
    /// library (fresh id + a synthetic BibTeX key so it displays sensibly
    /// even though it was never parsed from a `.bib` file).
    pub fn into_entry(self, doi_or_arxiv_key: &str) -> CitationEntry {
        CitationEntry {
            id: uuid::Uuid::new_v4().to_string(),
            bibtex_key: doi_or_arxiv_key.to_string(),
            entry_type: "article".to_string(),
            authors: self.authors,
            title: self.title,
            year: self.year,
            venue: self.venue,
            doi: self.doi,
            volume: None,
            number: None,
            pages: None,
            publisher: None,
            url: None,
        }
    }
}

/// Parse a CrossRef `/works/{doi}` JSON response body into a `LookupResult`.
/// Pure function over already-fetched bytes/text — no network I/O — so it is
/// directly testable against a hand-written fixture matching CrossRef's real
/// shape (`{"message": {"title": [...], "author": [...], ...}}`).
pub fn parse_crossref_json(body: &str) -> AppResult<LookupResult> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| AppError::Other(format!("CrossRef response was not valid JSON: {e}")))?;
    let msg = v
        .get("message")
        .ok_or_else(|| AppError::Other("CrossRef response had no 'message' field.".to_string()))?;

    let title = msg
        .get("title")
        .and_then(|t| t.as_array())
        .and_then(|a| a.first())
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    if title.is_empty() {
        return Err(AppError::Other(
            "CrossRef response had no title — this DOI may not be registered with CrossRef."
                .to_string(),
        ));
    }

    let authors = msg
        .get("author")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let given = p.get("given").and_then(|g| g.as_str()).unwrap_or("");
                    let family = p.get("family").and_then(|g| g.as_str()).unwrap_or("");
                    if given.is_empty() && family.is_empty() {
                        None
                    } else if given.is_empty() {
                        Some(family.to_string())
                    } else {
                        Some(format!("{given} {family}"))
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let year = msg
        .get("published")
        .or_else(|| msg.get("published-print"))
        .or_else(|| msg.get("published-online"))
        .or_else(|| msg.get("issued"))
        .and_then(|d| d.get("date-parts"))
        .and_then(|dp| dp.as_array())
        .and_then(|a| a.first())
        .and_then(|inner| inner.as_array())
        .and_then(|inner| inner.first())
        .and_then(|y| y.as_i64())
        .map(|y| y as i32);

    let venue = msg
        .get("container-title")
        .and_then(|t| t.as_array())
        .and_then(|a| a.first())
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());

    let doi = msg
        .get("DOI")
        .and_then(|d| d.as_str())
        .map(|s| s.to_string());

    Ok(LookupResult {
        title,
        authors,
        year,
        venue,
        doi,
        abstract_text: None,
    })
}

/// Parse an arXiv Atom API response body (a `<feed><entry>...</entry></feed>`
/// document) into a `LookupResult`. Hand-written for the small, well-known
/// subset of Atom fields arXiv actually returns — not a general Atom/RSS
/// parser. Pure function over already-fetched text.
pub fn parse_arxiv_atom(body: &str) -> AppResult<LookupResult> {
    let entry = extract_tag_block(body, "entry").ok_or_else(|| {
        AppError::Other(
            "arXiv response had no <entry> — check the arXiv id is correct.".to_string(),
        )
    })?;

    let title = extract_tag_text(&entry, "title")
        .map(|t| collapse_whitespace(&decode_xml_entities(&t)))
        .unwrap_or_default();
    if title.is_empty() {
        return Err(AppError::Other(
            "arXiv response entry had no <title>.".to_string(),
        ));
    }

    let authors = extract_all_tag_blocks(&entry, "author")
        .iter()
        .filter_map(|a| extract_tag_text(a, "name"))
        .map(|n| collapse_whitespace(&decode_xml_entities(&n)))
        .collect::<Vec<_>>();

    let year = extract_tag_text(&entry, "published")
        .and_then(|d| first_four_digit_number(&d));

    let abstract_text = extract_tag_text(&entry, "summary")
        .map(|s| collapse_whitespace(&decode_xml_entities(&s)));

    // arXiv's <arxiv:doi> element, when present, gives a published-version DOI.
    let doi = extract_tag_text(&entry, "arxiv:doi").map(|s| s.trim().to_string());

    Ok(LookupResult {
        title,
        authors,
        year,
        venue: Some("arXiv".to_string()),
        doi,
        abstract_text,
    })
}

/// Extract the inner text of the first `<tag ...>...</tag>` block found
/// anywhere in `xml` (namespace-prefixed tags like `arxiv:doi` match exactly
/// by their full name). Returns `None` if the tag isn't present or is
/// self-closing/empty. Deliberately minimal: no attribute parsing, no
/// nested-same-name handling beyond "first occurrence" — sufficient for the
/// flat, well-known arXiv entry shape this function is scoped to.
fn extract_tag_block(xml: &str, tag: &str) -> Option<String> {
    let open_start = format!("<{tag}");
    let start = xml.find(&open_start)?;
    let open_end = xml[start..].find('>')? + start + 1;
    let close = format!("</{tag}>");
    let end = xml[open_end..].find(&close)? + open_end;
    Some(xml[open_end..end].to_string())
}

fn extract_all_tag_blocks(xml: &str, tag: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut rest = xml;
    let open_start = format!("<{tag}");
    let close = format!("</{tag}>");
    while let Some(start) = rest.find(&open_start) {
        let Some(open_end_rel) = rest[start..].find('>') else {
            break;
        };
        let open_end = start + open_end_rel + 1;
        let Some(end_rel) = rest[open_end..].find(&close) else {
            break;
        };
        let end = open_end + end_rel;
        blocks.push(rest[open_end..end].to_string());
        rest = &rest[end + close.len()..];
    }
    blocks
}

fn extract_tag_text(xml: &str, tag: &str) -> Option<String> {
    extract_tag_block(xml, tag)
}

fn decode_xml_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ----- BibTeX round-trip ---------------------------------------------

    const FIXTURE_BIB: &str = r#"
@article{smith2020,
  author = {John Smith and Jane Doe},
  title = {A Study of Things},
  journal = {Journal of Studies},
  year = {2020},
  volume = {12},
  number = {3},
  pages = {100--110},
  doi = {10.1234/abcd.5678}
}

@inproceedings{lee2019,
  author = {Alice Lee},
  title = {Proceedings Paper on Widgets},
  booktitle = {Proc. of the Conf. on Widgets},
  year = {2019},
}
"#;

    #[test]
    fn parses_article_and_inproceedings_fixture_correctly() {
        let report = parse_bibtex(FIXTURE_BIB).expect("well-formed fixture must parse");
        assert!(report.warnings.is_empty(), "no entries should warn: {:?}", report.warnings);
        assert_eq!(report.entries.len(), 2);

        let article = report
            .entries
            .iter()
            .find(|e| e.bibtex_key == "smith2020")
            .expect("smith2020 present");
        assert_eq!(article.entry_type, "article");
        assert_eq!(article.title, "A Study of Things");
        assert_eq!(article.authors, vec!["John Smith", "Jane Doe"]);
        assert_eq!(article.year, Some(2020));
        assert_eq!(article.venue.as_deref(), Some("Journal of Studies"));
        assert_eq!(article.doi.as_deref(), Some("10.1234/abcd.5678"));
        assert_eq!(article.volume.as_deref(), Some("12"));
        assert_eq!(article.number.as_deref(), Some("3"));
        assert_eq!(article.pages.as_deref(), Some("100-110"));

        let inproc = report
            .entries
            .iter()
            .find(|e| e.bibtex_key == "lee2019")
            .expect("lee2019 present");
        assert_eq!(inproc.entry_type, "inproceedings");
        assert_eq!(inproc.title, "Proceedings Paper on Widgets");
        assert_eq!(inproc.authors, vec!["Alice Lee"]);
        assert_eq!(inproc.year, Some(2019));
        assert_eq!(inproc.venue.as_deref(), Some("Proc. of the Conf. on Widgets"));
        assert_eq!(inproc.doi, None);
    }

    #[test]
    fn each_imported_entry_gets_a_distinct_id() {
        let report = parse_bibtex(FIXTURE_BIB).unwrap();
        let ids: std::collections::HashSet<_> = report.entries.iter().map(|e| &e.id).collect();
        assert_eq!(ids.len(), report.entries.len());
    }

    // ----- adversarial input ----------------------------------------------

    #[test]
    fn syntactically_malformed_bibtex_is_a_clear_error_not_a_panic() {
        let bad = "@article{oops author = {unterminated";
        let result = parse_bibtex(bad);
        assert!(result.is_err(), "malformed BibTeX must be rejected, not silently accepted");
    }

    #[test]
    fn entry_missing_required_title_is_skipped_with_a_warning_not_silently_dropped() {
        let bib = r#"
@article{good2021,
  author = {Somebody Good},
  title = {A Fine Title},
  year = {2021}
}

@article{notitle2021,
  author = {Nobody Notitle},
  year = {2021}
}
"#;
        let report = parse_bibtex(bib).expect("syntactically valid, so parse succeeds");
        assert_eq!(report.entries.len(), 1, "only the entry with a title is kept");
        assert_eq!(report.entries[0].bibtex_key, "good2021");
        assert_eq!(report.warnings.len(), 1);
        assert!(
            report.warnings[0].contains("notitle2021"),
            "warning must name the offending entry: {}",
            report.warnings[0]
        );
        assert!(
            report.warnings[0].contains("title"),
            "warning must say what was missing: {}",
            report.warnings[0]
        );
    }

    #[test]
    fn empty_bibtex_input_yields_an_empty_library_not_an_error() {
        let report = parse_bibtex("").expect("empty input is valid, empty BibTeX");
        assert!(report.entries.is_empty());
        assert!(report.warnings.is_empty());
    }

    // ----- APA / IEEE formatters (fixed, hand-constructed expected output) --

    fn fixture_entry() -> CitationEntry {
        CitationEntry {
            id: "test-id".to_string(),
            bibtex_key: "smith2020".to_string(),
            entry_type: "article".to_string(),
            authors: vec!["John Smith".to_string(), "Jane Doe".to_string()],
            title: "A Study of Things".to_string(),
            year: Some(2020),
            venue: Some("Journal of Studies".to_string()),
            doi: Some("10.1234/abcd.5678".to_string()),
            volume: Some("12".to_string()),
            number: Some("3".to_string()),
            pages: Some("100-110".to_string()),
            publisher: None,
            url: None,
        }
    }

    // ----- CitationStyle parsing (the commands layer's `style.parse()?`) ----

    #[test]
    fn citation_style_parses_known_names_case_insensitively() {
        assert_eq!("apa".parse::<CitationStyle>().unwrap(), CitationStyle::Apa);
        assert_eq!("APA".parse::<CitationStyle>().unwrap(), CitationStyle::Apa);
        assert_eq!("ieee".parse::<CitationStyle>().unwrap(), CitationStyle::Ieee);
        assert_eq!("IEEE".parse::<CitationStyle>().unwrap(), CitationStyle::Ieee);
    }

    #[test]
    fn citation_style_rejects_an_unknown_name_with_an_actionable_error() {
        let result = "chicago".parse::<CitationStyle>();
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("chicago"), "error should name the bad input: {msg}");
        assert!(
            msg.contains("apa") && msg.contains("ieee"),
            "error should name the supported styles: {msg}"
        );
    }

    #[test]
    fn apa_format_matches_the_exact_expected_string() {
        let out = format_citation(&fixture_entry(), CitationStyle::Apa, 1);
        assert_eq!(
            out,
            "Smith, J., & Doe, J. (2020). A Study of Things. Journal of Studies, 12(3), 100-110. https://doi.org/10.1234/abcd.5678"
        );
    }

    #[test]
    fn ieee_format_matches_the_exact_expected_string() {
        let out = format_citation(&fixture_entry(), CitationStyle::Ieee, 1);
        assert_eq!(
            out,
            "[1] J. Smith and J. Doe, \"A Study of Things,\" Journal of Studies, vol. 12, no. 3, pp. 100-110, 2020. doi: 10.1234/abcd.5678."
        );
    }

    #[test]
    fn apa_handles_missing_year_and_single_author() {
        let mut e = fixture_entry();
        e.authors = vec!["Jane Doe".to_string()];
        e.year = None;
        e.doi = None;
        let out = format_citation(&e, CitationStyle::Apa, 1);
        assert_eq!(
            out,
            "Doe, J. (n.d.). A Study of Things. Journal of Studies, 12(3), 100-110."
        );
    }

    #[test]
    fn ieee_numbers_reflect_bibliography_position() {
        let e = fixture_entry();
        let out = format_citation(&e, CitationStyle::Ieee, 7);
        assert!(out.starts_with("[7] "), "expected IEEE entry numbered [7], got: {out}");
    }

    #[test]
    fn bibliography_list_ieee_preserves_input_order_and_numbers_sequentially() {
        let mut e2 = fixture_entry();
        e2.bibtex_key = "lee2019".to_string();
        e2.title = "Proceedings Paper".to_string();
        let entries = vec![fixture_entry(), e2];
        let list = format_bibliography(&entries, CitationStyle::Ieee);
        assert_eq!(list.len(), 2);
        assert!(list[0].starts_with("[1] "));
        assert!(list[1].starts_with("[2] "));
    }

    #[test]
    fn bibliography_list_apa_sorts_by_author_surname() {
        let mut e_b = fixture_entry();
        e_b.authors = vec!["Zack Zephyr".to_string()];
        e_b.title = "Z Comes Last".to_string();
        let mut e_a = fixture_entry();
        e_a.authors = vec!["Amy Apple".to_string()];
        e_a.title = "A Comes First".to_string();
        let entries = vec![e_b, e_a];
        let list = format_bibliography(&entries, CitationStyle::Apa);
        assert_eq!(list.len(), 2);
        assert!(
            list[0].starts_with("Apple, A."),
            "Apple should sort before Zephyr, got: {}",
            list[0]
        );
    }

    // ----- CrossRef JSON parsing (canned fixture, no network) --------------

    const CROSSREF_FIXTURE: &str = r#"
    {
      "status": "ok",
      "message-type": "work",
      "message": {
        "DOI": "10.1234/abcd.5678",
        "title": ["A Study of Things"],
        "container-title": ["Journal of Studies"],
        "author": [
          { "given": "John", "family": "Smith" },
          { "given": "Jane", "family": "Doe" }
        ],
        "published": { "date-parts": [[2020, 6, 1]] }
      }
    }
    "#;

    #[test]
    fn crossref_json_parses_title_authors_year_and_venue() {
        let result = parse_crossref_json(CROSSREF_FIXTURE).expect("valid fixture parses");
        assert_eq!(result.title, "A Study of Things");
        assert_eq!(result.authors, vec!["John Smith", "Jane Doe"]);
        assert_eq!(result.year, Some(2020));
        assert_eq!(result.venue.as_deref(), Some("Journal of Studies"));
        assert_eq!(result.doi.as_deref(), Some("10.1234/abcd.5678"));
    }

    #[test]
    fn crossref_json_missing_message_is_a_clear_error() {
        let result = parse_crossref_json(r#"{"status": "ok"}"#);
        assert!(result.is_err());
    }

    #[test]
    fn crossref_json_missing_title_is_a_clear_error() {
        let body = r#"{"message": {"DOI": "10.1/x", "author": []}}"#;
        let result = parse_crossref_json(body);
        assert!(result.is_err());
    }

    #[test]
    fn crossref_malformed_json_is_a_clear_error_not_a_panic() {
        let result = parse_crossref_json("{not valid json");
        assert!(result.is_err());
    }

    // ----- arXiv Atom XML parsing (canned fixture, no network) -------------

    const ARXIV_FIXTURE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2101.00001v1</id>
    <published>2021-01-01T00:00:00Z</published>
    <title>  A Deep Study of &amp; Widgets
   </title>
    <summary>  This paper studies widgets in depth.
    </summary>
    <author><name>John Smith</name></author>
    <author><name>Jane Doe</name></author>
  </entry>
</feed>
"#;

    #[test]
    fn arxiv_atom_parses_title_authors_year_and_abstract() {
        let result = parse_arxiv_atom(ARXIV_FIXTURE).expect("valid fixture parses");
        assert_eq!(result.title, "A Deep Study of & Widgets");
        assert_eq!(result.authors, vec!["John Smith", "Jane Doe"]);
        assert_eq!(result.year, Some(2021));
        assert_eq!(result.venue.as_deref(), Some("arXiv"));
        assert_eq!(
            result.abstract_text.as_deref(),
            Some("This paper studies widgets in depth.")
        );
    }

    #[test]
    fn arxiv_atom_missing_entry_is_a_clear_error_not_a_panic() {
        let empty_feed = r#"<feed xmlns="http://www.w3.org/2005/Atom"></feed>"#;
        let result = parse_arxiv_atom(empty_feed);
        assert!(result.is_err());
    }

    #[test]
    fn arxiv_atom_entry_missing_title_is_a_clear_error() {
        let body = r#"<feed><entry><published>2021-01-01T00:00:00Z</published></entry></feed>"#;
        let result = parse_arxiv_atom(body);
        assert!(result.is_err());
    }

    // ----- sidecar persistence ---------------------------------------------

    #[test]
    fn library_path_for_appends_citations_json_suffix() {
        let p = library_path_for("/Users/me/Documents/paper.aix");
        assert_eq!(
            p,
            std::path::PathBuf::from("/Users/me/Documents/paper.aix.citations.json")
        );
    }

    #[test]
    fn load_library_for_a_document_with_no_sidecar_is_an_empty_library() {
        let path = std::env::temp_dir().join(format!(
            "nurumayufacet_citations_test_missing_{}.aix",
            uuid::Uuid::new_v4()
        ));
        let lib = load_library(path.to_str().unwrap()).expect("missing sidecar is not an error");
        assert!(lib.entries.is_empty());
    }

    #[test]
    fn save_then_load_round_trips_entries() {
        let doc_path = std::env::temp_dir().join(format!(
            "nurumayufacet_citations_test_roundtrip_{}.aix",
            uuid::Uuid::new_v4()
        ));
        let doc_path_str = doc_path.to_str().unwrap().to_string();
        let sidecar = library_path_for(&doc_path_str);

        let lib = CitationLibrary {
            entries: vec![fixture_entry()],
        };
        save_library(&doc_path_str, &lib).expect("save should succeed");
        let loaded = load_library(&doc_path_str).expect("load should succeed");
        assert_eq!(loaded.entries.len(), 1);
        assert_eq!(loaded.entries[0].bibtex_key, "smith2020");

        let _ = std::fs::remove_file(&sidecar); // test cleanup
    }

    #[test]
    fn corrupt_sidecar_self_heals_to_an_empty_library_instead_of_erroring() {
        let doc_path = std::env::temp_dir().join(format!(
            "nurumayufacet_citations_test_corrupt_{}.aix",
            uuid::Uuid::new_v4()
        ));
        let doc_path_str = doc_path.to_str().unwrap().to_string();
        let sidecar = library_path_for(&doc_path_str);
        std::fs::write(&sidecar, b"{ not json").unwrap();

        let loaded = load_library(&doc_path_str).expect("corrupt sidecar must not error");
        assert!(loaded.entries.is_empty());

        let _ = std::fs::remove_file(&sidecar); // test cleanup
    }
}
