//! Markdown text chunk → slide paragraphs (BUG-020). Pure and deterministic.
//!
//! DUAL IMPLEMENTATION: this is the Rust twin of `src/slideText.ts` (the
//! Preview/Present side). Both are locked by ONE golden fixture,
//! `tests/fixtures/slide_paragraphs.golden.json`, read by `tests::golden_contract`
//! here and by `src/slideText.test.ts` — change both in lockstep, function by
//! function (names mirror the TS ones in snake_case). The serialized shape is
//! part of the contract: false flags and absent `label`/`href` are omitted.
//!
//! Handled (a CommonMark subset that agrees with the Markdown Preview on the
//! fixture's inline cases): list items (`-`, `*`, `+`, `N.`, `N)`) become one
//! paragraph each with the marker stripped and indentation as `level`;
//! numbered items keep their marker as `label`; a plain paragraph is one
//! bullet with soft/hard breaks kept as `\n`; fenced code becomes one `code`
//! paragraph per line without fences or info string; `>` quotes are stripped;
//! inline `**`/`__` bold, `*`/`_` italic (CommonMark flanking + rule of 3),
//! code spans, `[text](url)` and `<scheme:…>` autolinks (runs carry `href`),
//! backslash escapes. Tables and HTML blocks stay raw text as `plain`
//! monospace lines; thematic breaks are dropped (they carry no text).
//!
//! Known limits (planned): structured tables, inline images (`![a](u)` stays
//! literal text), strikethrough, entity references, reference-style links,
//! indented code, lists inside quotes, setext headings. Punctuation follows
//! micromark: Unicode P|S per UTF-16 unit, so astral code points never count
//! (`PUNCT_RANGES` is generated from the same rule and verified by vitest).

use serde::Serialize;

const MAX_LEVEL: usize = 8;

/// What a paragraph is, which decides its marker and styling on a slide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ParaKind {
    Bullet,
    Numbered,
    Code,
    Quote,
    Plain,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A styled span of visible text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub text: String,
    #[serde(skip_serializing_if = "is_false")]
    pub bold: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub italic: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub code: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
}

impl Run {
    fn plain(text: impl Into<String>) -> Self {
        Run { text: text.into(), bold: false, italic: false, code: false, href: None }
    }

    fn same_format(&self, other: &Run) -> bool {
        self.bold == other.bold
            && self.italic == other.italic
            && self.code == other.code
            && self.href == other.href
    }
}

/// One slide paragraph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlidePara {
    pub kind: ParaKind,
    /// Nesting depth (list indentation / quote depth), 0-based, capped at 8.
    pub level: usize,
    /// The numbered marker as written ("1.", "3)"); only on `Numbered`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub runs: Vec<Run>,
}

// ---- character classes (micromark semantics) --------------------------------

/// Unicode General Category P|S on the BMP, as inclusive ranges. GENERATED from
/// `/[\p{P}\p{S}]/u`; `src/slideText.test.ts` re-checks every BMP code point
/// against the TS predicate, so regenerate rather than hand-edit.
const PUNCT_RANGES: &[(u32, u32)] = &[
    (0x0021, 0x002F), (0x003A, 0x0040), (0x005B, 0x0060), (0x007B, 0x007E), (0x00A1, 0x00A9),
    (0x00AB, 0x00AC), (0x00AE, 0x00B1), (0x00B4, 0x00B4), (0x00B6, 0x00B8), (0x00BB, 0x00BB),
    (0x00BF, 0x00BF), (0x00D7, 0x00D7), (0x00F7, 0x00F7), (0x02C2, 0x02C5), (0x02D2, 0x02DF),
    (0x02E5, 0x02EB), (0x02ED, 0x02ED), (0x02EF, 0x02FF), (0x0375, 0x0375), (0x037E, 0x037E),
    (0x0384, 0x0385), (0x0387, 0x0387), (0x03F6, 0x03F6), (0x0482, 0x0482), (0x055A, 0x055F),
    (0x0589, 0x058A), (0x058D, 0x058F), (0x05BE, 0x05BE), (0x05C0, 0x05C0), (0x05C3, 0x05C3),
    (0x05C6, 0x05C6), (0x05F3, 0x05F4), (0x0606, 0x060F), (0x061B, 0x061B), (0x061D, 0x061F),
    (0x066A, 0x066D), (0x06D4, 0x06D4), (0x06DE, 0x06DE), (0x06E9, 0x06E9), (0x06FD, 0x06FE),
    (0x0700, 0x070D), (0x07F6, 0x07F9), (0x07FE, 0x07FF), (0x0830, 0x083E), (0x085E, 0x085E),
    (0x0888, 0x0888), (0x0964, 0x0965), (0x0970, 0x0970), (0x09F2, 0x09F3), (0x09FA, 0x09FB),
    (0x09FD, 0x09FD), (0x0A76, 0x0A76), (0x0AF0, 0x0AF1), (0x0B70, 0x0B70), (0x0BF3, 0x0BFA),
    (0x0C77, 0x0C77), (0x0C7F, 0x0C7F), (0x0C84, 0x0C84), (0x0D4F, 0x0D4F), (0x0D79, 0x0D79),
    (0x0DF4, 0x0DF4), (0x0E3F, 0x0E3F), (0x0E4F, 0x0E4F), (0x0E5A, 0x0E5B), (0x0F01, 0x0F17),
    (0x0F1A, 0x0F1F), (0x0F34, 0x0F34), (0x0F36, 0x0F36), (0x0F38, 0x0F38), (0x0F3A, 0x0F3D),
    (0x0F85, 0x0F85), (0x0FBE, 0x0FC5), (0x0FC7, 0x0FCC), (0x0FCE, 0x0FDA), (0x104A, 0x104F),
    (0x109E, 0x109F), (0x10FB, 0x10FB), (0x1360, 0x1368), (0x1390, 0x1399), (0x1400, 0x1400),
    (0x166D, 0x166E), (0x169B, 0x169C), (0x16EB, 0x16ED), (0x1735, 0x1736), (0x17D4, 0x17D6),
    (0x17D8, 0x17DB), (0x1800, 0x180A), (0x1940, 0x1940), (0x1944, 0x1945), (0x19DE, 0x19FF),
    (0x1A1E, 0x1A1F), (0x1AA0, 0x1AA6), (0x1AA8, 0x1AAD), (0x1B4E, 0x1B4F), (0x1B5A, 0x1B6A),
    (0x1B74, 0x1B7F), (0x1BFC, 0x1BFF), (0x1C3B, 0x1C3F), (0x1C7E, 0x1C7F), (0x1CC0, 0x1CC7),
    (0x1CD3, 0x1CD3), (0x1FBD, 0x1FBD), (0x1FBF, 0x1FC1), (0x1FCD, 0x1FCF), (0x1FDD, 0x1FDF),
    (0x1FED, 0x1FEF), (0x1FFD, 0x1FFE), (0x2010, 0x2027), (0x2030, 0x205E), (0x207A, 0x207E),
    (0x208A, 0x208E), (0x20A0, 0x20C1), (0x2100, 0x2101), (0x2103, 0x2106), (0x2108, 0x2109),
    (0x2114, 0x2114), (0x2116, 0x2118), (0x211E, 0x2123), (0x2125, 0x2125), (0x2127, 0x2127),
    (0x2129, 0x2129), (0x212E, 0x212E), (0x213A, 0x213B), (0x2140, 0x2144), (0x214A, 0x214D),
    (0x214F, 0x214F), (0x218A, 0x218B), (0x2190, 0x2429), (0x2440, 0x244A), (0x249C, 0x24E9),
    (0x2500, 0x2775), (0x2794, 0x2B73), (0x2B76, 0x2BFF), (0x2CE5, 0x2CEA), (0x2CF9, 0x2CFC),
    (0x2CFE, 0x2CFF), (0x2D70, 0x2D70), (0x2E00, 0x2E2E), (0x2E30, 0x2E5D), (0x2E80, 0x2E99),
    (0x2E9B, 0x2EF3), (0x2F00, 0x2FD5), (0x2FF0, 0x2FFF), (0x3001, 0x3004), (0x3008, 0x3020),
    (0x3030, 0x3030), (0x3036, 0x3037), (0x303D, 0x303F), (0x309B, 0x309C), (0x30A0, 0x30A0),
    (0x30FB, 0x30FB), (0x3190, 0x3191), (0x3196, 0x319F), (0x31C0, 0x31E5), (0x31EF, 0x31EF),
    (0x3200, 0x321E), (0x322A, 0x3247), (0x3250, 0x3250), (0x3260, 0x327F), (0x328A, 0x32B0),
    (0x32C0, 0x33FF), (0x4DC0, 0x4DFF), (0xA490, 0xA4C6), (0xA4FE, 0xA4FF), (0xA60D, 0xA60F),
    (0xA673, 0xA673), (0xA67E, 0xA67E), (0xA6F2, 0xA6F7), (0xA700, 0xA716), (0xA720, 0xA721),
    (0xA789, 0xA78A), (0xA828, 0xA82B), (0xA836, 0xA839), (0xA874, 0xA877), (0xA8CE, 0xA8CF),
    (0xA8F8, 0xA8FA), (0xA8FC, 0xA8FC), (0xA92E, 0xA92F), (0xA95F, 0xA95F), (0xA9C1, 0xA9CD),
    (0xA9DE, 0xA9DF), (0xAA5C, 0xAA5F), (0xAA77, 0xAA79), (0xAADE, 0xAADF), (0xAAF0, 0xAAF1),
    (0xAB5B, 0xAB5B), (0xAB6A, 0xAB6B), (0xABEB, 0xABEB), (0xFB29, 0xFB29), (0xFBB2, 0xFBD2),
    (0xFD3E, 0xFD4F), (0xFD90, 0xFD91), (0xFDC8, 0xFDCF), (0xFDFC, 0xFDFF), (0xFE10, 0xFE19),
    (0xFE30, 0xFE52), (0xFE54, 0xFE66), (0xFE68, 0xFE6B), (0xFF01, 0xFF0F), (0xFF1A, 0xFF20),
    (0xFF3B, 0xFF40), (0xFF5B, 0xFF65), (0xFFE0, 0xFFE6), (0xFFE8, 0xFFEE), (0xFFFC, 0xFFFD),
];

fn is_punct(c: char) -> bool {
    let cp = c as u32;
    if cp > 0xFFFF {
        return false;
    }
    PUNCT_RANGES
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                std::cmp::Ordering::Less
            } else if lo > cp {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Unicode whitespace for flanking: tab, LF, FF, CR and category Zs.
fn is_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
            | '\u{202F}' | '\u{205F}' | '\u{3000}'
    )
}

fn is_ascii_punct(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_punctuation())
}

// ---- inline parsing -----------------------------------------------------------

enum Item {
    Text { text: String, code: bool },
    Delim { ch: char, count: usize, orig: usize, can_open: bool, can_close: bool },
    Link { runs: Vec<Run>, href: String },
}

fn run_len(cs: &[char], i: usize, ch: char) -> usize {
    cs[i.min(cs.len())..].iter().take_while(|&&c| c == ch).count()
}

/// Start index of the next backtick run of exactly `k` at or after `from`.
fn find_backtick_run(cs: &[char], from: usize, k: usize) -> Option<usize> {
    let mut p = from;
    while p < cs.len() {
        if cs[p] == '`' {
            let m = run_len(cs, p, '`');
            if m == k {
                return Some(p);
            }
            p += m;
        } else {
            p += 1;
        }
    }
    None
}

/// micromark's limit on nested parentheses in a link destination.
const MAX_DEST_PARENS: usize = 32;

/// Index of the `]` closing the `[` at `start`. One scan resolves every `[`
/// it passes (a scan from an inner `[` would continue identically), so the
/// per-parse `cache` keeps unmatched brackets linear instead of quadratic.
fn find_bracket_close(
    cs: &[char],
    start: usize,
    cache: &mut std::collections::HashMap<usize, Option<usize>>,
) -> Option<usize> {
    if let Some(&hit) = cache.get(&start) {
        return hit;
    }
    let mut stack: Vec<usize> = Vec::new();
    let mut j = start;
    while j < cs.len() {
        let c = cs[j];
        if c == '\\' && j + 1 < cs.len() {
            j += 2;
            continue;
        }
        if c == '`' {
            let k = run_len(cs, j, '`');
            j = match find_backtick_run(cs, j + k, k) {
                Some(p) => p + k,
                None => j + k,
            };
            continue;
        }
        if c == '[' {
            stack.push(j);
        } else if c == ']' {
            if let Some(open) = stack.pop() {
                cache.insert(open, Some(j));
                if open == start {
                    return Some(j);
                }
            }
        }
        j += 1;
    }
    for open in stack {
        cache.insert(open, None);
    }
    None
}

fn skip_link_ws(cs: &[char], mut p: usize) -> usize {
    while p < cs.len() && matches!(cs[p], ' ' | '\t' | '\n') {
        p += 1;
    }
    p
}

struct LinkTail {
    end: usize,
    text_start: usize,
    text_end: usize,
    href: String,
}

/// Parse `[text](dest "title")` starting at the `[` at `start`.
fn parse_link_tail(
    cs: &[char],
    start: usize,
    cache: &mut std::collections::HashMap<usize, Option<usize>>,
) -> Option<LinkTail> {
    let close = find_bracket_close(cs, start, cache)?;
    if cs.get(close + 1) != Some(&'(') {
        return None;
    }
    let mut p = skip_link_ws(cs, close + 2);
    let mut href = String::new();
    if cs.get(p) == Some(&'<') {
        p += 1;
        while p < cs.len() && cs[p] != '>' {
            if cs[p] == '\n' || cs[p] == '<' {
                return None;
            }
            if cs[p] == '\\' && is_ascii_punct(cs.get(p + 1).copied()) {
                href.push(cs[p + 1]);
                p += 2;
                continue;
            }
            href.push(cs[p]);
            p += 1;
        }
        if p >= cs.len() {
            return None;
        }
        p += 1;
    } else {
        let mut parens = 0usize;
        while p < cs.len() {
            let c = cs[p];
            if c == '\\' && is_ascii_punct(cs.get(p + 1).copied()) {
                href.push(cs[p + 1]);
                p += 2;
                continue;
            }
            if c == ' ' || c == '\t' || c == '\n' || (c as u32) < 0x20 {
                break;
            }
            if c == '(' {
                if parens >= MAX_DEST_PARENS {
                    return None;
                }
                parens += 1;
            }
            if c == ')' {
                if parens == 0 {
                    break;
                }
                parens -= 1;
            }
            href.push(c);
            p += 1;
        }
        if parens != 0 {
            return None;
        }
    }
    let after_dest = p;
    p = skip_link_ws(cs, p);
    if p > after_dest && matches!(cs.get(p), Some('"') | Some('\'') | Some('(')) {
        let closing = if cs[p] == '(' { ')' } else { cs[p] };
        let mut q = p + 1;
        while q < cs.len() && cs[q] != closing {
            if cs[q] == '\\' {
                q += 1;
            }
            q += 1;
        }
        if q >= cs.len() {
            return None;
        }
        p = skip_link_ws(cs, q + 1);
    }
    if cs.get(p) != Some(&')') {
        return None;
    }
    Some(LinkTail { end: p + 1, text_start: start + 1, text_end: close, href })
}

/// `<scheme:…>` autolink at `start` (the `<`): index after `>` and the URL.
fn parse_autolink(cs: &[char], start: usize) -> Option<(usize, String)> {
    let mut p = start + 1;
    if !cs.get(p).is_some_and(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let mut n = 0;
    while p < cs.len() && (cs[p].is_ascii_alphanumeric() || matches!(cs[p], '+' | '.' | '-')) {
        p += 1;
        n += 1;
    }
    if !(2..=32).contains(&n) || cs.get(p) != Some(&':') {
        return None;
    }
    while p < cs.len() && cs[p] != '>' {
        let c = cs[p];
        if c == ' ' || c == '<' || (c as u32) < 0x20 {
            return None;
        }
        p += 1;
    }
    if p >= cs.len() {
        return None;
    }
    Some((p + 1, cs[start + 1..p].iter().collect()))
}

fn push_text(items: &mut Vec<Item>, text: &str) {
    if let Some(Item::Text { text: last, code: false }) = items.last_mut() {
        last.push_str(text);
    } else {
        items.push(Item::Text { text: text.to_string(), code: false });
    }
}

/// Inline Markdown → runs. The slice ends count as whitespace for flanking.
fn parse_inline(cs: &[char], allow_links: bool) -> Vec<Run> {
    let mut items: Vec<Item> = Vec::new();
    let mut brackets: std::collections::HashMap<usize, Option<usize>> =
        std::collections::HashMap::new();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if c == '\\' {
            let next = cs.get(i + 1).copied();
            if is_ascii_punct(next) {
                push_text(&mut items, &cs[i + 1].to_string());
                i += 2;
            } else if next == Some('\n') {
                push_text(&mut items, "\n");
                i += 2;
            } else {
                push_text(&mut items, "\\");
                i += 1;
            }
            continue;
        }
        if c == '`' {
            let k = run_len(cs, i, '`');
            if let Some(p) = find_backtick_run(cs, i + k, k) {
                let mut content: Vec<char> =
                    cs[i + k..p].iter().map(|&x| if x == '\n' { ' ' } else { x }).collect();
                if content.len() >= 2
                    && content[0] == ' '
                    && content[content.len() - 1] == ' '
                    && content.iter().any(|&x| x != ' ')
                {
                    content = content[1..content.len() - 1].to_vec();
                }
                items.push(Item::Text { text: content.into_iter().collect(), code: true });
                i = p + k;
            } else {
                push_text(&mut items, &"`".repeat(k));
                i += k;
            }
            continue;
        }
        if c == '!' && cs.get(i + 1) == Some(&'[') {
            // Inline images stay literal (planned) — never reduced to alt text.
            if let Some(img) = parse_link_tail(cs, i + 1, &mut brackets) {
                let raw: String = cs[i..img.end].iter().collect();
                push_text(&mut items, &raw);
                i = img.end;
            } else {
                push_text(&mut items, "!");
                i += 1;
            }
            continue;
        }
        if c == '[' && allow_links {
            if let Some(link) = parse_link_tail(cs, i, &mut brackets) {
                items.push(Item::Link {
                    runs: parse_inline(&cs[link.text_start..link.text_end], false),
                    href: link.href,
                });
                i = link.end;
            } else {
                push_text(&mut items, "[");
                i += 1;
            }
            continue;
        }
        if c == '<' && allow_links {
            if let Some((end, url)) = parse_autolink(cs, i) {
                items.push(Item::Link { runs: vec![Run::plain(url.clone())], href: url });
                i = end;
            } else {
                push_text(&mut items, "<");
                i += 1;
            }
            continue;
        }
        if c == '*' || c == '_' {
            let k = run_len(cs, i, c);
            let prev = if i > 0 { Some(cs[i - 1]) } else { None };
            let next = cs.get(i + k).copied();
            let prev_ws = prev.map_or(true, is_ws);
            let next_ws = next.map_or(true, is_ws);
            let prev_p = prev.is_some_and(is_punct);
            let next_p = next.is_some_and(is_punct);
            let left = !next_ws && (!next_p || prev_ws || prev_p);
            let right = !prev_ws && (!prev_p || next_ws || next_p);
            let (can_open, can_close) = if c == '*' {
                (left, right)
            } else {
                (left && (!right || prev_p), right && (!left || next_p))
            };
            items.push(Item::Delim { ch: c, count: k, orig: k, can_open, can_close });
            i += k;
            continue;
        }
        push_text(&mut items, &c.to_string());
        i += 1;
    }

    // CommonMark "process emphasis" over the delimiter items.
    let dl: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, it)| matches!(it, Item::Delim { .. }))
        .map(|(idx, _)| idx)
        .collect();
    let delim = |items: &[Item], idx: usize| -> (char, usize, usize, bool, bool) {
        match items[idx] {
            Item::Delim { ch, count, orig, can_open, can_close } => {
                (ch, count, orig, can_open, can_close)
            }
            _ => ('\0', 0, 0, false, false),
        }
    };
    let set_count = |items: &mut [Item], idx: usize, n: usize| {
        if let Item::Delim { count, .. } = &mut items[idx] {
            *count = n;
        }
    };
    let mut alive = vec![true; dl.len()];
    let mut ranges: Vec<(usize, usize, usize)> = Vec::new();
    // CommonMark `openers_bottom`: after a failed search, later closers with the
    // same (char, can_open, orig % 3) never re-scan those openers (keeps it linear).
    let mut bottom: std::collections::HashMap<(char, bool, usize), usize> =
        std::collections::HashMap::new();
    let mut ci = 0;
    while ci < dl.len() {
        let (cch, ccount, corig, ccan_open, ccan_close) = delim(&items, dl[ci]);
        if !alive[ci] || !ccan_close || ccount == 0 {
            ci += 1;
            continue;
        }
        let key = (cch, ccan_open, corig % 3);
        // Openers below index `lowest` were already ruled out for this key.
        let lowest = bottom.get(&key).copied().unwrap_or(0);
        let mut found = None;
        for oi in (lowest..ci).rev() {
            if !alive[oi] {
                continue;
            }
            let (och, ocount, oorig, ocan_open, ocan_close) = delim(&items, dl[oi]);
            if och != cch || !ocan_open || ocount == 0 {
                continue;
            }
            if (ocan_close || ccan_open)
                && (oorig + corig) % 3 == 0
                && !(oorig % 3 == 0 && corig % 3 == 0)
            {
                continue;
            }
            found = Some(oi);
            break;
        }
        match found {
            Some(oi) => {
                let ocount = delim(&items, dl[oi]).1;
                let used = if ocount >= 2 && ccount >= 2 { 2 } else { 1 };
                ranges.push((dl[oi], dl[ci], used));
                set_count(&mut items, dl[oi], ocount - used);
                set_count(&mut items, dl[ci], ccount - used);
                for flag in alive.iter_mut().take(ci).skip(oi + 1) {
                    *flag = false;
                }
                if ocount == used {
                    alive[oi] = false;
                }
                if ccount == used {
                    alive[ci] = false;
                    ci += 1;
                }
            }
            None => {
                bottom.insert(key, ci);
                if !ccan_open {
                    alive[ci] = false;
                }
                ci += 1;
            }
        }
    }

    let mut runs: Vec<Run> = Vec::new();
    let mut push = |r: Run| {
        if r.text.is_empty() {
            return;
        }
        match runs.last_mut() {
            Some(last) if last.same_format(&r) => last.text.push_str(&r.text),
            _ => runs.push(r),
        }
    };
    // Items strictly inside a matched pair take its style: a linear prefix sum
    // over (opener, closer) boundaries (pairs nest or are disjoint).
    let mut bold_diff = vec![0i64; items.len() + 1];
    let mut italic_diff = vec![0i64; items.len() + 1];
    for &(o, c, u) in &ranges {
        let diff = if u == 2 { &mut bold_diff } else { &mut italic_diff };
        diff[o + 1] += 1;
        diff[c] -= 1;
    }
    let (mut bold_depth, mut italic_depth) = (0i64, 0i64);
    for (idx, it) in items.into_iter().enumerate() {
        bold_depth += bold_diff[idx];
        italic_depth += italic_diff[idx];
        let bold = bold_depth > 0;
        let italic = italic_depth > 0;
        match it {
            Item::Text { text, code } => push(Run { text, bold, italic, code, href: None }),
            Item::Delim { ch, count, .. } => push(Run {
                text: ch.to_string().repeat(count),
                bold,
                italic,
                code: false,
                href: None,
            }),
            Item::Link { runs: inner, href } => {
                for r in inner {
                    push(Run {
                        text: r.text,
                        bold: bold || r.bold,
                        italic: italic || r.italic,
                        code: r.code,
                        href: Some(href.clone()),
                    });
                }
            }
        }
    }
    runs
}

// ---- block parsing ------------------------------------------------------------

struct Pending {
    kind: ParaKind,
    level: usize,
    label: Option<String>,
    lines: Vec<String>,
    is_item: bool,
    quote_depth: usize,
}

fn is_blank(line: &str) -> bool {
    line.trim().is_empty()
}

/// The line's leading-space count when it is at most 3; `None` when indented further.
fn small_indent(line: &str) -> Option<usize> {
    let n = line.chars().take_while(|&c| c == ' ').count();
    (n <= 3).then_some(n)
}

fn fence_open(line: &str) -> Option<(char, usize, usize)> {
    let indent = small_indent(line)?;
    let cs: Vec<char> = line.chars().collect();
    let ch = *cs.get(indent)?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let len = run_len(&cs, indent, ch);
    if len < 3 {
        return None;
    }
    if ch == '`' && cs[indent + len..].contains(&'`') {
        return None;
    }
    Some((ch, len, indent))
}

fn is_fence_close(line: &str, ch: char, len: usize) -> bool {
    let Some(indent) = small_indent(line) else {
        return false;
    };
    let cs: Vec<char> = line.chars().collect();
    let k = run_len(&cs, indent, ch);
    k >= len && cs[indent + k..].iter().all(|&c| c == ' ' || c == '\t')
}

fn strip_indent(line: &str, n: usize) -> &str {
    let k = line.chars().take(n).take_while(|&c| c == ' ').count();
    &line[k..]
}

fn is_thematic_break(line: &str) -> bool {
    if small_indent(line).is_none() {
        return false;
    }
    let cs: Vec<char> = line.chars().filter(|&c| c != ' ' && c != '\t').collect();
    cs.len() >= 3 && matches!(cs[0], '-' | '*' | '_') && cs.iter().all(|&c| c == cs[0])
}

fn is_delim_row(line: &str) -> bool {
    let t = line.trim();
    !t.is_empty()
        && t.contains('|')
        && t.contains('-')
        && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t'))
}

fn is_html_start(line: &str) -> bool {
    let Some(indent) = small_indent(line) else {
        return false;
    };
    let cs: Vec<char> = line[indent..].chars().collect();
    if cs.first() != Some(&'<') {
        return false;
    }
    if matches!(cs.get(1), Some('!') | Some('?')) {
        return true;
    }
    let mut p = if cs.get(1) == Some(&'/') { 2 } else { 1 };
    if !cs.get(p).is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    while cs.get(p).is_some_and(|c| c.is_ascii_alphanumeric() || *c == '-') {
        p += 1;
    }
    matches!(cs.get(p), None | Some(' ') | Some('\t') | Some('>') | Some('/'))
}

struct ListItem {
    indent: usize,
    label: Option<String>,
    number: u64,
    content: String,
}

fn list_item(line: &str) -> Option<ListItem> {
    let mut w = 0usize;
    let mut i = 0usize;
    for c in line.chars() {
        match c {
            ' ' => w += 1,
            '\t' => w = w + 4 - (w % 4),
            _ => break,
        }
        i += 1; // ' ' and '\t' are one byte each
    }
    let rest = &line[i..];
    let rc: Vec<char> = rest.chars().collect();
    let first = *rc.first()?;
    let spaced = |c: Option<&char>| matches!(c, None | Some(' ') | Some('\t'));
    if matches!(first, '-' | '*' | '+') {
        if !spaced(rc.get(1)) {
            return None;
        }
        return Some(ListItem { indent: w, label: None, number: 0, content: rest[1..].trim().to_string() });
    }
    let d = rc.iter().take(9).take_while(|c| c.is_ascii_digit()).count();
    if d == 0 || !matches!(rc.get(d), Some('.') | Some(')')) || !spaced(rc.get(d + 1)) {
        return None;
    }
    Some(ListItem {
        indent: w,
        label: Some(rest[..d + 1].to_string()),
        number: rest[..d].parse().unwrap_or(0),
        content: rest[d + 1..].trim().to_string(),
    })
}

fn quote_line(line: &str) -> Option<(usize, &str)> {
    let mut rest = line;
    let mut depth = 0;
    loop {
        match small_indent(rest) {
            Some(indent) if rest[indent..].starts_with('>') => {
                rest = &rest[indent + 1..];
                if rest.starts_with(' ') || rest.starts_with('\t') {
                    rest = &rest[1..];
                }
                depth += 1;
            }
            _ => break,
        }
    }
    (depth > 0).then_some((depth, rest))
}

fn level_for(stack: &mut Vec<usize>, indent: usize) -> usize {
    while stack.last().is_some_and(|&top| top >= indent) {
        stack.pop();
    }
    let level = stack.len().min(MAX_LEVEL);
    stack.push(indent);
    level
}

fn flush(pending: Option<Pending>, out: &mut Vec<SlidePara>) {
    let Some(p) = pending else {
        return;
    };
    let text = p.lines.iter().map(|l| l.trim()).collect::<Vec<_>>().join("\n");
    let cs: Vec<char> = text.chars().collect();
    let runs = parse_inline(&cs, true);
    if runs.is_empty() {
        return;
    }
    out.push(SlidePara { kind: p.kind, level: p.level, label: p.label, runs });
}

/// Convert one text chunk (raw Markdown) into slide paragraphs.
pub fn chunk_to_paragraphs(text: &str) -> Vec<SlidePara> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<SlidePara> = Vec::new();
    let mut pending: Option<Pending> = None;
    let mut stack: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some((ch, len, indent)) = fence_open(line) {
            flush(pending.take(), &mut out);
            stack.clear();
            i += 1;
            while i < lines.len() {
                if is_fence_close(lines[i], ch, len) {
                    i += 1;
                    break;
                }
                let code = strip_indent(lines[i], indent);
                let runs = if code.is_empty() { Vec::new() } else { vec![Run::plain(code)] };
                out.push(SlidePara { kind: ParaKind::Code, level: 0, label: None, runs });
                i += 1;
            }
            continue;
        }
        if is_blank(line) {
            flush(pending.take(), &mut out);
            i += 1;
            continue;
        }
        if is_thematic_break(line) {
            flush(pending.take(), &mut out);
            stack.clear();
            i += 1;
            continue;
        }
        if pending.is_none()
            && ((line.contains('|') && i + 1 < lines.len() && is_delim_row(lines[i + 1]))
                || is_html_start(line))
        {
            stack.clear();
            while i < lines.len() && !is_blank(lines[i]) {
                let mut run = Run::plain(lines[i].trim_end());
                run.code = true;
                out.push(SlidePara { kind: ParaKind::Plain, level: 0, label: None, runs: vec![run] });
                i += 1;
            }
            continue;
        }
        if let Some(item) = list_item(line) {
            let interrupts = match &pending {
                None => true,
                Some(p) => {
                    p.is_item
                        || p.quote_depth > 0
                        || (!item.content.is_empty() && (item.label.is_none() || item.number == 1))
                }
            };
            if interrupts {
                flush(pending.take(), &mut out);
                let level = level_for(&mut stack, item.indent);
                let kind = if item.label.is_none() { ParaKind::Bullet } else { ParaKind::Numbered };
                pending = Some(Pending {
                    kind,
                    level,
                    label: item.label,
                    lines: vec![item.content],
                    is_item: true,
                    quote_depth: 0,
                });
                i += 1;
                continue;
            }
        }
        if let Some((depth, content)) = quote_line(line) {
            match pending.as_mut() {
                Some(p) if p.quote_depth == depth && !is_blank(content) => {
                    p.lines.push(content.to_string());
                }
                _ => {
                    flush(pending.take(), &mut out);
                    stack.clear();
                    if !is_blank(content) {
                        pending = Some(Pending {
                            kind: ParaKind::Quote,
                            level: (depth - 1).min(MAX_LEVEL),
                            label: None,
                            lines: vec![content.to_string()],
                            is_item: false,
                            quote_depth: depth,
                        });
                    }
                }
            }
            i += 1;
            continue;
        }
        match pending.as_mut() {
            Some(p) => p.lines.push(line.to_string()),
            None => {
                stack.clear();
                pending = Some(Pending {
                    kind: ParaKind::Bullet,
                    level: 0,
                    label: None,
                    lines: vec![line.to_string()],
                    is_item: false,
                    quote_depth: 0,
                });
            }
        }
        i += 1;
    }
    flush(pending, &mut out);
    out
}

// ---- shared helpers for the PPTX writer and the overflow heuristic ------------

/// Whether a run's `href` is rendered as a link: web and mail targets only.
/// Anything else (javascript:, relative paths, anchors, file:) is written as
/// plain text (and counted by pptx.rs). Mirrors TS `isClickableHref`.
pub fn is_clickable_href(href: &str) -> bool {
    let h = href.trim().to_ascii_lowercase();
    h.starts_with("http://") || h.starts_with("https://") || h.starts_with("mailto:")
}

/// The text a reader sees: a numbered label + space, then the runs' text.
pub fn visible_text(p: &SlidePara) -> String {
    let mut s = p.label.as_ref().map(|l| format!("{l} ")).unwrap_or_default();
    for r in &p.runs {
        s.push_str(&r.text);
    }
    s
}

/// Estimated rendered line count at `cpl` characters per line: each `\n`
/// segment of each paragraph's visible text takes max(1, ceil(chars / cpl))
/// lines (chars = code points). Mirrors TS `paragraphLines`.
pub fn paragraph_lines(paras: &[SlidePara], cpl: usize) -> usize {
    paras
        .iter()
        .flat_map(|p| {
            visible_text(p)
                .split('\n')
                .map(|seg| seg.chars().count().div_ceil(cpl.max(1)).max(1))
                .collect::<Vec<_>>()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        input: String,
        expected: serde_json::Value,
    }
    #[derive(serde::Deserialize)]
    struct LinesCase {
        name: String,
        input: String,
        cpl: usize,
        expected: usize,
    }
    #[derive(serde::Deserialize)]
    struct ClickableCase {
        href: String,
        expected: bool,
    }
    #[derive(serde::Deserialize)]
    struct Golden {
        cases: Vec<Case>,
        lines: Vec<LinesCase>,
        clickable: Vec<ClickableCase>,
    }

    fn golden() -> Golden {
        serde_json::from_str(include_str!("../tests/fixtures/slide_paragraphs.golden.json"))
            .expect("golden fixture parses")
    }

    /// Every case: the SERIALIZED output equals the fixture's raw JSON, so a
    /// `false` flag or `null` field the TS side omits fails here too.
    #[test]
    fn golden_contract() {
        let g = golden();
        assert!(g.cases.len() >= 30, "fixture lost its cases");
        let mut mismatches = Vec::new();
        for case in g.cases {
            let actual = serde_json::to_value(chunk_to_paragraphs(&case.input)).expect("serialize");
            if actual != case.expected {
                mismatches.push(format!(
                    "{}\n  expected: {}\n  actual:   {}",
                    case.name, case.expected, actual
                ));
            }
        }
        assert!(mismatches.is_empty(), "golden mismatches:\n{}", mismatches.join("\n"));
    }

    #[test]
    fn golden_lines_contract() {
        let g = golden();
        assert!(g.lines.len() >= 5, "fixture lost its line cases");
        for c in g.lines {
            assert_eq!(
                paragraph_lines(&chunk_to_paragraphs(&c.input), c.cpl),
                c.expected,
                "{}",
                c.name
            );
        }
    }

    #[test]
    fn golden_clickable_contract() {
        let g = golden();
        assert!(g.clickable.iter().any(|c| c.expected) && g.clickable.iter().any(|c| !c.expected));
        for c in g.clickable {
            assert_eq!(is_clickable_href(&c.href), c.expected, "{:?}", c.href);
        }
    }

    #[test]
    fn punctuation_table_is_sorted_and_disjoint() {
        for w in PUNCT_RANGES.windows(2) {
            assert!(w[0].0 <= w[0].1 && w[0].1 < w[1].0, "{:?} / {:?}", w[0], w[1]);
        }
        assert!(is_punct('「') && is_punct('・') && is_punct('€') && is_punct('*'));
        assert!(!is_punct('ー') && !is_punct('々') && !is_punct('a') && !is_punct('😀'));
    }

    #[test]
    fn whitespace_set_matches_zs_plus_controls() {
        for c in ['\t', '\n', '\u{C}', '\r', ' ', '\u{A0}', '\u{2003}', '\u{3000}'] {
            assert!(is_ws(c), "{c:?}");
        }
        for c in ['\u{B}', '\u{2028}', '\u{FEFF}', 'a', '。'] {
            assert!(!is_ws(c), "{c:?}");
        }
    }

    #[test]
    fn adversarial_inputs_do_not_panic() {
        for input in [
            "[", "](", "[a](", "[a](<b", "`", "``a`", "***", "_*_*_", "\\", "<", "<a:", "![",
            "> ", ">", "1.", "- ", "~~~", "| x\n|-", "<div", "\u{0}\u{1}", "😀`😀`",
            "[[[[]]]](x)", "*a **b* c**",
        ] {
            let _ = chunk_to_paragraphs(input);
        }
    }
}
