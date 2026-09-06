//! Shared image plumbing for exporters (PPTX, RTF) and for user-inserted local
//! images: decode an image chunk's data-URL content, sniff its format from
//! magic bytes, read pixel dimensions, aspect-fit it into a box, resolve
//! remote image URLs to inline data URLs, and read a caller-picked local image
//! file into an inline data URL. Pure helpers except `resolve_remote_images`
//! (network) and `read_local_image_file` (disk), which do the I/O the rest of
//! this module doesn't need.

use crate::error::{AppError, AppResult};
use crate::models::Chunk;
use base64::Engine;
use std::path::Path;

/// Upper bound on a single fetched remote image (A4), and on a single local
/// image file picked via the file dialog: a hostile or accidentally huge
/// source can't exhaust memory during export or on insertion.
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

/// Extensions accepted for a user-picked local image file (case-insensitive).
/// Broader than `image_ext`'s export-embeddable set (adds `webp`) since a
/// user's own picture may be a format the PPTX/RTF writers can't embed but the
/// in-app `<img>` preview renders fine.
const LOCAL_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}

/// Read a user-picked local image file (from the file-picker dialog, never an
/// arbitrary renderer-supplied path — see `commands::read_local_image`) and
/// return it as an inline `data:<mime>;base64,...` URL for a local-image chunk.
///
/// Rejects an unrecognised extension and a file over `MAX_IMAGE_BYTES` before
/// reading the full contents, so a hostile or mistaken huge/wrong-type path
/// can't be read into memory at all.
pub fn read_local_image_file(path: &str) -> AppResult<String> {
    let p = Path::new(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !LOCAL_IMAGE_EXTS.iter().any(|a| *a == ext) {
        return Err(AppError::UnsupportedImage(
            p.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(path)
                .to_string(),
        ));
    }

    let meta = std::fs::metadata(p)?;
    if meta.len() > MAX_IMAGE_BYTES as u64 {
        return Err(AppError::ImageTooLarge {
            name: p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(path)
                .to_string(),
            size_mb: meta.len() as f64 / (1024.0 * 1024.0),
            limit_mb: (MAX_IMAGE_BYTES / (1024 * 1024)) as u64,
        });
    }

    let bytes = std::fs::read(p)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{b64}", mime_for_ext(&ext)))
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
}
