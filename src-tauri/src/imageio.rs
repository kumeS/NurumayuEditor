//! Shared image plumbing for exporters (PPTX, RTF) and for user-inserted local
//! images: decode an image chunk's data-URL content, sniff its format from
//! magic bytes, read pixel dimensions, aspect-fit it into a box, resolve
//! remote image URLs to inline data URLs, and read a local image file into an
//! inline data URL (user-picked, or a document-referenced figure that the
//! preview, the GUI PPTX/RTF exports or the CLI PPTX export embed). Pure helpers
//! except `resolve_remote_images` (network) and `read_local_image_file` /
//! `embed_local_images` (disk), which do the I/O the rest of this module
//! doesn't need. A local read returns only a regular, non-symlink file with an
//! allowlisted extension, under the size cap, whose bytes sniff as PNG, JPEG,
//! GIF, WEBP or BMP (`sniff_local_image`); no directory confinement.

use crate::error::{AppError, AppResult};
use crate::models::Chunk;
use base64::Engine;
use std::path::Path;

/// Upper bound on a single fetched remote image (A4), and on a single local
/// image file read by `read_local_image_file` (picked, or referenced by a
/// document — the preview, the GUI PPTX and RTF exports, the CLI PPTX
/// export): a hostile or accidentally huge source can't exhaust memory during
/// preview, export or insertion.
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

/// Extensions accepted for a local image file read by `read_local_image_file`
/// (case-insensitive).
/// Broader than `image_ext`'s export-embeddable set (adds `webp`) since a
/// user's own picture may be a format the PPTX/RTF writers can't embed but the
/// in-app `<img>` preview renders fine.
const LOCAL_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/// Read a local image file and return it as an inline `data:<mime>;base64,...`
/// URL. Callers: the image picker (a dialog-chosen path), the preview and the
/// GUI PPTX and RTF exports resolving a figure a document references
/// (`![](figures/x.png)` → an absolute path next to the document,
/// `src/localImages.ts`; the exports via fileActions `withEmbeddedLocalImages`),
/// and the headless CLI PPTX export (`embed_local_images`). The MCP export
/// resolves no figures (planned, pending the confinement decision in
/// docs/ai/06). The path is therefore renderer-supplied or document-derived.
///
/// Constraints actually enforced, in this order:
/// 1. the extension allowlist (`LOCAL_IMAGE_EXTS`), before the disk is
///    touched (a non-image path never reveals whether it exists);
/// 2. the path itself must be a regular file: `symlink_metadata` (lstat)
///    refuses a symlink (refused outright, never resolved and re-checked —
///    so a symlinked figure doesn't load; a symlinked parent directory is not
///    affected), a directory, FIFO, socket or device, before anything is
///    opened (a FIFO would block a plain read);
/// 3. the `MAX_IMAGE_BYTES` cap (also re-checked on the bytes read);
/// 4. after reading, the content must sniff as an allowlisted image format
///    (`sniff_local_image`: PNG, JPEG, GIF, WEBP, BMP). The data URL's MIME
///    comes from the sniffed content, so a misnamed `.jpg` holding PNG bytes
///    is returned as `image/png`.
///
/// Refusals 1, 2 and 4 are `AppError::UnsupportedImage` (localized by
/// src/imageErrors.ts). There is NO directory or traversal restriction: any
/// absolute path the process can read is returned if it passes the checks
/// above (so a document can embed an image file from anywhere on disk, by
/// design of relative and absolute figure references; docs/ai/06). Known
/// limit: a path swapped for a symlink between the lstat and the open is not
/// caught, but its bytes still have to sniff as an image.
pub fn read_local_image_file(path: &str) -> AppResult<String> {
    let p = Path::new(path);
    let name = || {
        p.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path)
            .to_string()
    };

    // Pure check first: a non-image path is refused without touching the
    // disk, so this renderer-reachable command can't probe whether arbitrary
    // files exist.
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !LOCAL_IMAGE_EXTS.iter().any(|a| *a == ext) {
        return Err(AppError::UnsupportedImage(name()));
    }

    let meta = std::fs::symlink_metadata(p)?;
    if !meta.file_type().is_file() {
        return Err(AppError::UnsupportedImage(name()));
    }

    let too_large = |len: u64| AppError::ImageTooLarge {
        name: name(),
        size_mb: len as f64 / (1024.0 * 1024.0),
        limit_mb: (MAX_IMAGE_BYTES / (1024 * 1024)) as u64,
    };
    if meta.len() > MAX_IMAGE_BYTES as u64 {
        return Err(too_large(meta.len()));
    }

    // Read at most one byte past the cap, so a file that grew after the
    // metadata check still can't exhaust memory.
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(std::fs::File::open(p)?, MAX_IMAGE_BYTES as u64 + 1),
        &mut bytes,
    )?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(too_large(bytes.len() as u64));
    }

    let mime = sniff_local_image(&bytes).ok_or_else(|| AppError::UnsupportedImage(name()))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// The MIME type of `bytes` when they start like one of the formats a local
/// image read may return (`LOCAL_IMAGE_EXTS`), else `None`. Pure. Stricter
/// than `image_ext` (the export embedder): the full 8-byte PNG signature,
/// `GIF87a`/`GIF89a`, `RIFF`+`WEBP`, and for BMP the `BM` tag plus a known
/// DIB header size, so text that merely begins "BM" or "GIF8" is refused.
/// A header check only: a file with a valid signature and a corrupt body
/// still passes (the `<img>` then shows a broken image).
pub(crate) fn sniff_local_image(bytes: &[u8]) -> Option<&'static str> {
    const PNG_SIG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.starts_with(PNG_SIG) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 18 && bytes.starts_with(b"BM") {
        let dib = u32::from_le_bytes([bytes[14], bytes[15], bytes[16], bytes[17]]);
        // BITMAPCOREHEADER, OS/2 v2 (16/64), INFO, V2, V3, V4, V5 headers.
        matches!(dib, 12 | 16 | 40 | 52 | 56 | 64 | 108 | 124).then_some("image/bmp")
    } else {
        None
    }
}

/// Where a document-referenced image file lives, as an absolute path — or
/// `None` when `src` is not a local file (remote, inline data, empty, another
/// scheme) or is relative with no `doc_path` to resolve against. Pure.
///
/// Sync contract: this is the Rust twin of the `"local"` result of TS
/// `resolveImageSource` (src/localImages.ts) — same rules, same order: drop
/// `?query`/`#fragment`, then percent-decode (a malformed escape or invalid
/// UTF-8 keeps the text verbatim), then collapse `.`/`..` (never above `/`).
/// The tests mirror src/localImages.test.ts case for case; change both.
/// `doc_path` must be absolute (the dirname rule treats a bare name as `/`).
pub(crate) fn local_image_path(src: &str, doc_path: Option<&str>) -> Option<String> {
    let value = src.trim();
    if value.is_empty() || starts_with_ci(value, "http:") || starts_with_ci(value, "https:")
        || starts_with_ci(value, "data:image/")
    {
        return None;
    }
    if starts_with_ci(value, "file://") {
        let mut rest = &value["file://".len()..];
        if starts_with_ci(rest, "localhost") {
            rest = &rest["localhost".len()..];
        }
        return Some(normalize_path(&percent_decode(strip_query(rest))));
    }
    if has_scheme(value) {
        return None; // javascript:, data:text/html, … are not images
    }
    let path = percent_decode(strip_query(value));
    if path.starts_with('/') {
        return Some(normalize_path(&path));
    }
    let doc = doc_path?;
    Some(normalize_path(&format!("{}/{path}", dirname(doc))))
}

/// Inline every image chunk whose content is a readable local file (resolved
/// by `local_image_path` against `doc_path`, read by `read_local_image_file`
/// with the same checks as the GUI: regular non-symlink file, extension
/// allowlist, size cap, content sniff). A chunk whose
/// file can't be read keeps its content unchanged, so the PPTX writer still
/// reports it as a local image that couldn't be read. Used by the headless
/// export (cli.rs), which has no renderer to inline figures the way
/// fileActions.ts `withEmbeddedLocalImages` does for the GUI.
pub(crate) fn embed_local_images<'a>(chunks: impl Iterator<Item = &'a mut Chunk>, doc_path: &str) {
    for chunk in chunks.filter(|c| c.is_image()) {
        let Some(path) = local_image_path(&chunk.content, Some(doc_path)) else {
            continue;
        };
        if let Ok(data_url) = read_local_image_file(&path) {
            chunk.content = data_url;
        }
    }
}

fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.get(..prefix.len()).is_some_and(|h| h.eq_ignore_ascii_case(prefix))
}

/// `^[a-z][a-z0-9+.-]*:` (case-insensitive).
fn has_scheme(s: &str) -> bool {
    let Some(colon) = s.find(':') else {
        return false;
    };
    let mut chars = s[..colon].chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

fn strip_query(s: &str) -> &str {
    s.split(['?', '#']).next().unwrap_or("")
}

/// `decodeURIComponent`, falling back to the input on a malformed escape or
/// invalid UTF-8 (a literal `%` in a real file name, e.g. `100%.png`).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = |j: usize| b.get(j).and_then(|c| (*c as char).to_digit(16));
            match (hex(i + 1), hex(i + 2)) {
                (Some(h), Some(l)) => out.push((h * 16 + l) as u8),
                _ => return s.to_string(),
            }
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// The folder part of `path` (`/` for a bare name or a root-level file).
fn dirname(path: &str) -> &str {
    match path.rfind(['/', '\\']) {
        Some(cut) if cut > 0 => &path[..cut],
        _ => "/",
    }
}

/// Collapse `.` and `..` segments; `..` never climbs above the root.
fn normalize_path(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            p => out.push(p),
        }
    }
    format!("/{}", out.join("/"))
}

/// Resolve remote (`http(s)://`) image-chunk URLs to inline data URLs by
/// fetching the bytes, so the (synchronous) writers can embed them. Image chunks
/// can hold a remote URL (some image models return a hosted URL rather than a
/// data URL — see `ai::extract_image_url`). On failure the content is cleared so
/// the writer skips it and reports it as a dropped image. Takes any chunk
/// iterator so both a `Deck` (PPTX) and a `Document` (RTF) can be resolved.
pub(crate) async fn resolve_remote_images<'a>(chunks: impl Iterator<Item = &'a mut Chunk>) {
    for chunk in chunks {
        if !chunk.is_image() {
            continue;
        }
        let url = chunk.content.trim();
        if url.starts_with("http://") || url.starts_with("https://") {
            // On failure the content is cleared → counted as a dropped image.
            chunk.content = fetch_as_data_url(url).await.unwrap_or_default();
        }
    }
}

async fn fetch_as_data_url(url: &str) -> AppResult<String> {
    // `net::safe_fetch` enforces http(s)-only, SSRF host filtering, per-hop
    // redirect re-validation, a size cap and a timeout (A4/A5).
    let bytes = crate::net::safe_fetch(url, MAX_IMAGE_BYTES, 30).await?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    // The mime here is cosmetic — `image_ext` re-sniffs the magic bytes on write.
    Ok(format!("data:image/png;base64,{b64}"))
}

/// Decode an image chunk's `content` (a `data:...;base64,` URL, or bare base64).
pub(crate) fn decode_image(content: &str) -> Option<Vec<u8>> {
    let b64 = match content.find("base64,") {
        Some(i) => &content[i + "base64,".len()..],
        None => content,
    };
    let b64 = b64.trim();
    if b64.is_empty() {
        return None; // e.g. a remote image whose fetch failed (content cleared)
    }
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// Detect file extension + content kind from magic bytes, limited to the raster
/// formats PowerPoint embeds reliably (PNG/JPEG/GIF/BMP). Returns `None` for
/// anything else (WEBP, SVG, unknown) so the caller skips it and warns, instead
/// of writing mismatched bytes under a `.png` name that opens as a broken image
/// (B5).
pub(crate) fn image_ext(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        Some(("png", "image/png"))
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("jpeg", "image/jpeg"))
    } else if bytes.starts_with(b"GIF8") {
        // GIF87a and GIF89a both begin "GIF8".
        Some(("gif", "image/gif"))
    } else if bytes.starts_with(&[0x42, 0x4D]) {
        Some(("bmp", "image/bmp"))
    } else {
        None
    }
}

/// Pixel dimensions for PNG / JPEG / GIF / BMP, used to preserve aspect ratio
/// on export.
pub(crate) fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    // PNG: 8-byte sig, then IHDR with width@16 height@20 (big-endian).
    if bytes.len() >= 24 && bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        if w > 0 && h > 0 {
            return Some((w, h));
        }
    }
    // JPEG: walk segment markers to a Start-Of-Frame (SOFn).
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let mut i = 2;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            // SOF0..SOF15 carry the frame size, excluding DHT/JPG/DAC/RST/markers.
            let is_sof = (0xC0..=0xCF).contains(&marker)
                && marker != 0xC4
                && marker != 0xC8
                && marker != 0xCC;
            if is_sof {
                let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
                if w > 0 && h > 0 {
                    return Some((w, h));
                }
                return None;
            }
            let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
            if len < 2 {
                break;
            }
            i += 2 + len;
        }
    }
    // GIF: logical-screen width@6 / height@8 (little-endian u16).
    if bytes.len() >= 10 && bytes.starts_with(b"GIF8") {
        let w = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
        let h = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
        if w > 0 && h > 0 {
            return Some((w, h));
        }
    }
    // BMP: BITMAPINFOHEADER width@18 / height@22 (little-endian i32; height may
    // be negative for a top-down bitmap).
    if bytes.len() >= 26 && bytes.starts_with(&[0x42, 0x4D]) {
        let w = i32::from_le_bytes([bytes[18], bytes[19], bytes[20], bytes[21]]);
        // `unsigned_abs` (not `abs`) so a crafted height of i32::MIN doesn't
        // overflow/panic on attacker-controlled image bytes.
        let h = i32::from_le_bytes([bytes[22], bytes[23], bytes[24], bytes[25]]).unsigned_abs();
        if w > 0 && h > 0 {
            return Some((w as u32, h));
        }
    }
    None
}

/// Fit an image inside a box (any unit — the caller picks EMU/twips/px),
/// preserving aspect ratio and centering it. Returns `(x, y, cx, cy)`.
pub(crate) fn fit(bytes: &[u8], box_x: i64, box_y: i64, box_cx: i64, box_cy: i64) -> (i64, i64, i64, i64) {
    let (iw, ih) = image_size(bytes).unwrap_or((16, 9));
    let (iw, ih) = (iw as i64, ih as i64);
    // Compare aspect ratios via cross-multiplication (avoid float).
    let (cx, cy) = if iw * box_cy > ih * box_cx {
        (box_cx, box_cx * ih / iw) // width-bound
    } else {
        (box_cy * iw / ih, box_cy) // height-bound
    };
    let x = box_x + (box_cx - cx) / 2;
    let y = box_y + (box_cy - cy) / 2;
    (x, y, cx, cy)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ----- B5: image format detection -----

    #[test]
    fn image_ext_recognizes_embeddable_formats() {
        assert_eq!(image_ext(&[0x89, 0x50, 0x4E, 0x47, 1, 2]), Some(("png", "image/png")));
        assert_eq!(image_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(("jpeg", "image/jpeg")));
        assert_eq!(image_ext(b"GIF89a..."), Some(("gif", "image/gif")));
        assert_eq!(image_ext(b"GIF87a..."), Some(("gif", "image/gif")));
        assert_eq!(image_ext(&[0x42, 0x4D, 1, 2]), Some(("bmp", "image/bmp")));
    }

    #[test]
    fn image_ext_skips_unsupported() {
        // WEBP (RIFF....WEBP), SVG-ish text, and junk are not embeddable.
        let webp = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
        assert_eq!(image_ext(&webp), None);
        assert_eq!(image_ext(b"<svg xmlns=..."), None);
        assert_eq!(image_ext(&[0, 1, 2, 3]), None);
    }

    #[test]
    fn image_size_parses_gif_and_bmp() {
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&4u16.to_le_bytes()); // width
        gif.extend_from_slice(&2u16.to_le_bytes()); // height
        assert_eq!(image_size(&gif), Some((4, 2)));

        let mut bmp = vec![0x42u8, 0x4D];
        bmp.extend_from_slice(&[0u8; 16]); // up to offset 18
        bmp.extend_from_slice(&4i32.to_le_bytes()); // width @18
        bmp.extend_from_slice(&2i32.to_le_bytes()); // height @22
        assert_eq!(image_size(&bmp), Some((4, 2)));
    }

    #[test]
    fn fit_preserves_aspect_within_box() {
        // 480x270 (16:9) PNG header bytes are enough for image_size.
        let mut png = vec![0x89, b'P', b'N', b'G', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        png.extend_from_slice(&480u32.to_be_bytes());
        png.extend_from_slice(&270u32.to_be_bytes());
        let (_, _, cx, cy) = fit(&png, 0, 0, 4_000_000, 4_000_000);
        // width-bound: cy/cx should be ~270/480
        assert!((cx as f64 * 270.0 / 480.0 - cy as f64).abs() < 2.0);
    }

    // ----- local image insertion (v1 "No.1" priority feature) -----

    /// A tiny valid 1x1 PNG (magic bytes + IHDR chunk header enough for the
    /// writer/format-sniffer; body doesn't need to be a complete valid image
    /// for this round-trip test, which only exercises read → base64 → data URL).
    fn tiny_png_bytes() -> Vec<u8> {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&[0, 0, 0, 0]); // IHDR length placeholder
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&1u32.to_be_bytes()); // width
        png.extend_from_slice(&1u32.to_be_bytes()); // height
        png
    }

    #[test]
    fn read_local_image_file_round_trips_a_valid_small_image() {
        let dir = std::env::temp_dir().join(format!("nf-imageio-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("photo.png");
        std::fs::write(&path, tiny_png_bytes()).unwrap();

        let data_url = read_local_image_file(path.to_str().unwrap()).unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"));
        let decoded = decode_image(&data_url).unwrap();
        assert_eq!(decoded, tiny_png_bytes());

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn read_local_image_file_rejects_oversized_file() {
        let dir = std::env::temp_dir().join(format!("nf-imageio-test-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("huge.png");
        // One byte over the cap is enough to trigger the rejection without
        // actually allocating/writing tens of megabytes for the test.
        let big = vec![0u8; MAX_IMAGE_BYTES + 1];
        std::fs::write(&path, &big).unwrap();

        let err = read_local_image_file(path.to_str().unwrap()).unwrap_err();
        match err {
            AppError::ImageTooLarge { limit_mb, .. } => {
                assert_eq!(limit_mb, (MAX_IMAGE_BYTES / (1024 * 1024)) as u64);
            }
            other => panic!("expected ImageTooLarge, got {other:?}"),
        }

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn read_local_image_file_rejects_disallowed_extension() {
        let dir = std::env::temp_dir().join(format!("nf-imageio-test-ext-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("script.exe");
        std::fs::write(&path, b"not an image").unwrap();

        let err = read_local_image_file(path.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, AppError::UnsupportedImage(_)));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    /// A fresh, unique temp dir per test (tests run in parallel in one pid).
    fn unique_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nf-imageio-{tag}-{}-{}",
            std::process::id(),
            crate::models::new_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn read_local_image_file_refuses_a_png_symlink_to_a_text_file() {
        let dir = unique_dir("symlink");
        let secret = dir.join("secret.txt");
        std::fs::write(&secret, b"api_key = hunter2\n").unwrap();
        let link = dir.join("figure.png");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        let err = read_local_image_file(link.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, AppError::UnsupportedImage(_)), "got {err:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn read_local_image_file_refuses_a_symlink_even_to_a_real_png() {
        // Symlinks are refused outright (not resolved and re-checked).
        let dir = unique_dir("symlink-png");
        let real = dir.join("real.png");
        std::fs::write(&real, tiny_png_bytes()).unwrap();
        let link = dir.join("alias.png");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        assert!(read_local_image_file(real.to_str().unwrap()).is_ok());
        let err = read_local_image_file(link.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, AppError::UnsupportedImage(_)), "got {err:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_local_image_file_refuses_a_non_image_path_without_touching_disk() {
        // A missing non-image path is UnsupportedImage, not an I/O "not found":
        // the extension check runs before any lstat, so the command can't be
        // used to probe whether arbitrary files exist.
        let dir = unique_dir("probe");
        let missing = dir.join("nope.txt");
        let err = read_local_image_file(missing.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, AppError::UnsupportedImage(_)), "got {err:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_local_image_file_refuses_a_png_file_containing_text() {
        let dir = unique_dir("text-png");
        let path = dir.join("notes.png");
        std::fs::write(&path, b"# my private notes\nnot an image at all\n").unwrap();

        let err = read_local_image_file(path.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, AppError::UnsupportedImage(_)), "got {err:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_local_image_file_refuses_a_directory_named_like_an_image() {
        let dir = unique_dir("dir-png");
        let path = dir.join("folder.png");
        std::fs::create_dir_all(&path).unwrap();

        let err = read_local_image_file(path.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, AppError::UnsupportedImage(_)), "got {err:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_local_image_file_takes_the_mime_from_the_content() {
        // A misnamed file (.jpg holding PNG bytes) is accepted, labelled by
        // what it actually is.
        let dir = unique_dir("misnamed");
        let path = dir.join("photo.jpg");
        std::fs::write(&path, tiny_png_bytes()).unwrap();

        let data_url = read_local_image_file(path.to_str().unwrap()).unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"), "got {data_url}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sniff_local_image_accepts_each_allowlisted_format_and_nothing_else() {
        let mut bmp = b"BM".to_vec();
        bmp.extend_from_slice(&[0u8; 12]); // file size, reserved, pixel offset
        bmp.extend_from_slice(&40u32.to_le_bytes()); // BITMAPINFOHEADER size
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0u8; 4]);
        webp.extend_from_slice(b"WEBPVP8 ");
        let accepted: &[(&[u8], &str)] = &[
            (&tiny_png_bytes(), "image/png"),
            (&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10], "image/jpeg"),
            (b"GIF87a\x01\x00\x01\x00", "image/gif"),
            (b"GIF89a\x01\x00\x01\x00", "image/gif"),
            (&webp, "image/webp"),
            (&bmp, "image/bmp"),
        ];
        for (bytes, mime) in accepted {
            assert_eq!(sniff_local_image(bytes), Some(*mime), "{bytes:?}");
        }
        let mut avi = b"RIFF".to_vec();
        avi.extend_from_slice(&[0u8; 4]);
        avi.extend_from_slice(b"AVI LIST");
        let refused: &[&[u8]] = &[
            b"",
            b"plain text",
            b"BM is how this note starts, but it is text",
            &avi,
            b"\x89PNG", // truncated signature
            b"GIF8 not a gif",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        ];
        for bytes in refused {
            assert_eq!(sniff_local_image(bytes), None, "{bytes:?}");
        }
    }

    // ----- document-referenced figures (CLI/MCP export) -----
    // Mirrors src/localImages.test.ts case for case: `local_image_path` is
    // the Rust twin of TS `resolveImageSource`'s "local" result (None for
    // every other kind).

    const DOC: &str = "/Users/me/研究/01_可視化/note.md";

    #[test]
    fn local_image_path_mirrors_resolve_image_source() {
        let cases: &[(&str, Option<&str>, Option<&str>)] = &[
            // remote and inline images are not local
            ("https://example.com/a.png", Some(DOC), None),
            ("http://example.com/a.png", None, None),
            ("data:image/png;base64,AAAA", Some(DOC), None),
            // bare relative path → the document's folder
            ("figures/fig1_ja.png", Some(DOC), Some("/Users/me/研究/01_可視化/figures/fig1_ja.png")),
            // ./ and ../ segments, clamped at the root
            ("./figures/a.png", Some(DOC), Some("/Users/me/研究/01_可視化/figures/a.png")),
            ("../shared/a.png", Some(DOC), Some("/Users/me/研究/shared/a.png")),
            ("../../../../../../a.png", Some(DOC), Some("/a.png")),
            // absolute path and file:// URL (case-insensitive, optional localhost)
            ("/Volumes/data/fig.png", Some(DOC), Some("/Volumes/data/fig.png")),
            ("file:///Volumes/data/fig.png", Some(DOC), Some("/Volumes/data/fig.png")),
            ("FILE://localhost/Volumes/data/fig.png", None, Some("/Volumes/data/fig.png")),
            // percent-decoding (CJK and spaces), after dropping ?query/#fragment
            ("figures/%E5%9B%B3%201.png", Some(DOC), Some("/Users/me/研究/01_可視化/figures/図 1.png")),
            ("file:///Users/me/%E5%9B%B3.png", None, Some("/Users/me/図.png")),
            // a malformed % sequence (or invalid UTF-8) stays verbatim
            ("figures/100%.png", Some(DOC), Some("/Users/me/研究/01_可視化/figures/100%.png")),
            ("figures/%+F.png", Some(DOC), Some("/Users/me/研究/01_可視化/figures/%+F.png")),
            ("figures/%FF.png", Some(DOC), Some("/Users/me/研究/01_可視化/figures/%FF.png")),
            ("figures/a.png?raw=true#top", Some(DOC), Some("/Users/me/研究/01_可視化/figures/a.png")),
            // a relative path needs a document folder; an absolute one doesn't
            ("figures/a.png", None, None),
            ("/abs/a.png", None, Some("/abs/a.png")),
            // empty, blank, or any other scheme → nothing
            ("", Some(DOC), None),
            ("   ", Some(DOC), None),
            ("javascript:alert(1)", Some(DOC), None),
            ("data:text/html,<b>x</b>", Some(DOC), None),
        ];
        for (src, doc, want) in cases {
            assert_eq!(
                local_image_path(src, *doc).as_deref(),
                *want,
                "src={src:?} doc={doc:?}"
            );
        }
    }

    fn figure_chunk(content: &str) -> Chunk {
        let mut c = Chunk::new_text(0, content);
        c.metadata.chunk_type = crate::models::CHUNK_TYPE_IMAGE.to_string();
        c
    }

    #[test]
    fn embed_local_images_inlines_readable_figures_and_leaves_the_rest() {
        let dir = std::env::temp_dir().join(format!("nf-imageio-embed-{}", crate::models::new_id()));
        std::fs::create_dir_all(dir.join("figures")).unwrap();
        std::fs::write(dir.join("figures/fig.png"), tiny_png_bytes()).unwrap();
        let doc_path = dir.join("note.aix");

        let bare_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA/fake";
        let mut chunks = vec![
            figure_chunk("figures/fig.png"),
            figure_chunk("figures/missing.png"),
            figure_chunk(bare_b64),
            Chunk::new_text(0, "figures/fig.png"), // not an image chunk
        ];
        embed_local_images(chunks.iter_mut(), doc_path.to_str().unwrap());

        assert_eq!(decode_image(&chunks[0].content), Some(tiny_png_bytes()));
        assert_eq!(chunks[1].content, "figures/missing.png", "unreadable stays as-is");
        assert_eq!(chunks[2].content, bare_b64, "bare base64 is never cleared");
        assert_eq!(chunks[3].content, "figures/fig.png", "text chunks are untouched");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
