//! Network-fetch safety for URLs that originate in user content — document image
//! URLs embedded for PPTX export, and Draft reference URLs. Both guarantees below
//! are applied to *every* such fetch through the single `safe_fetch` entry point,
//! so neither caller can forget one:
//!
//!   * SSRF defence (A5) — the destination host must not resolve to a loopback,
//!     private, link-local, unspecified, CGNAT, or cloud-metadata address. We
//!     follow redirects MANUALLY (reqwest redirects are disabled) and re-validate
//!     every hop, so a public URL can't 30x-bounce us onto an internal one.
//!   * Resource bound (A4) — only `http(s)` is allowed; an over-large advertised
//!     `Content-Length` is rejected up front; the body is then streamed and
//!     aborted the moment it exceeds `max_bytes`; and a request timeout caps
//!     hangs. So a hostile or accidentally-huge URL can't exhaust memory or wedge
//!     the UI.

use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

const USER_AGENT: &str = "NurumayuFacet/1.3 (+https://github.com/kumeS/NurumayuFacet)";
const MAX_REDIRECTS: usize = 5;

/// Classify a *resolved* IP as one we must never fetch from when following a
/// user/document-supplied URL. Pure and deterministic, so it is unit-tested
/// directly; `is_blocked_host` resolves names and delegates here.
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()        // 127.0.0.0/8
                || v4.is_private()  // 10/8, 172.16/12, 192.168/16
                || v4.is_link_local() // 169.254.0.0/16 (incl. 169.254.169.254 metadata)
                || v4.is_broadcast()
                || v4.is_unspecified() // 0.0.0.0
                || v4.is_multicast()
                || o[0] == 0                                // 0.0.0.0/8 "this network"
                || (o[0] == 100 && (64..=127).contains(&o[1])) // 100.64.0.0/10 CGNAT
        }
        IpAddr::V6(v6) => {
            // IPv4-mapped (::ffff:a.b.c.d) must be classified as its IPv4 self.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_blocked_ip(IpAddr::V4(v4));
            }
            let seg0 = v6.segments()[0];
            v6.is_loopback()        // ::1
                || v6.is_unspecified() // ::
                || v6.is_multicast() // ff00::/8
                || (seg0 & 0xfe00) == 0xfc00 // fc00::/7 unique-local
                || (seg0 & 0xffc0) == 0xfe80 // fe80::/10 link-local
        }
    }
}

/// True if `host` (an authority component — a hostname or an IP literal, with or
/// without IPv6 brackets) must not be fetched from. Hostnames are resolved via
/// DNS and blocked if *any* resolved address is internal, or if resolution fails
/// (fail closed).
pub fn is_blocked_host(host: &str) -> bool {
    let trimmed = host.trim();
    // Accept "[::1]" as well as "::1".
    let literal = trimmed.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = literal.parse::<IpAddr>() {
        return is_blocked_ip(ip);
    }
    // A bare hostname → resolve. Port 0 is irrelevant; we only inspect the IPs.
    match (trimmed, 0u16).to_socket_addrs() {
        Ok(addrs) => {
            let mut any = false;
            for a in addrs {
                any = true;
                if is_blocked_ip(a.ip()) {
                    return true;
                }
            }
            !any // resolved to nothing → block
        }
        Err(_) => true, // resolution failed → block
    }
}

fn guard_url(url: &reqwest::Url) -> AppResult<()> {
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(AppError::Network(format!(
                "Refusing to fetch a non-http(s) URL (scheme '{other}')."
            )))
        }
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppError::Network("URL has no host.".into()))?;
    if is_blocked_host(host) {
        return Err(AppError::Network(
            "Refusing to fetch from a private, loopback, link-local, or metadata address."
                .into(),
        ));
    }
    Ok(())
}

/// Fetch a URL's bytes with SSRF and size/timeout protection. Follows up to
/// `MAX_REDIRECTS` redirects, re-validating each hop's host. Returns the body
/// bytes, or a `Network` error if the URL is disallowed, too large, or fails.
pub async fn safe_fetch(url: &str, max_bytes: usize, timeout_secs: u64) -> AppResult<Vec<u8>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .redirect(reqwest::redirect::Policy::none()) // we follow + re-validate manually
        .user_agent(USER_AGENT)
        .build()?;

    let mut current = reqwest::Url::parse(url)
        .map_err(|e| AppError::Network(format!("Invalid URL: {e}")))?;

    for _ in 0..=MAX_REDIRECTS {
        guard_url(&current)?;
        let resp = client.get(current.clone()).send().await?;
        let status = resp.status();

        if status.is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| AppError::Network("Redirect without a Location header.".into()))?;
            // Resolve relative redirects against the current URL, then re-check.
            current = current
                .join(location)
                .map_err(|e| AppError::Network(format!("Invalid redirect target: {e}")))?;
            continue;
        }
        if !status.is_success() {
            return Err(AppError::Network(format!(
                "Could not fetch URL (HTTP {}).",
                status.as_u16()
            )));
        }
        if let Some(len) = resp.content_length() {
            if len as usize > max_bytes {
                return Err(AppError::Network(format!(
                    "Resource is too large ({len} bytes; the limit is {max_bytes})."
                )));
            }
        }

        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if buf.len() + chunk.len() > max_bytes {
                return Err(AppError::Network(format!(
                    "Resource exceeded the {max_bytes}-byte limit and was aborted."
                )));
            }
            buf.extend_from_slice(&chunk);
        }
        return Ok(buf);
    }

    Err(AppError::Network("Too many redirects.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn blocks_internal_ipv4() {
        for s in [
            "127.0.0.1",
            "127.1.2.3",
            "10.0.0.1",
            "172.16.5.9",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254", // cloud metadata
            "0.0.0.0",
            "100.64.0.1", // CGNAT
            "255.255.255.255",
        ] {
            assert!(is_blocked_ip(ip(s)), "{s} should be blocked");
        }
    }

    #[test]
    fn allows_public_ipv4() {
        for s in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1"] {
            assert!(!is_blocked_ip(ip(s)), "{s} should be allowed");
        }
    }

    #[test]
    fn blocks_internal_ipv6() {
        for s in ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1"] {
            assert!(is_blocked_ip(ip(s)), "{s} should be blocked");
        }
    }

    #[test]
    fn allows_public_ipv6() {
        for s in ["2606:2800:220:1:248:1893:25c8:1946", "2001:4860:4860::8888"] {
            assert!(!is_blocked_ip(ip(s)), "{s} should be allowed");
        }
    }

    #[test]
    fn host_literals_are_classified_without_dns() {
        assert!(is_blocked_host("127.0.0.1"));
        assert!(is_blocked_host("[::1]"));
        assert!(is_blocked_host("169.254.169.254"));
        assert!(!is_blocked_host("8.8.8.8"));
        assert!(!is_blocked_host("93.184.216.34"));
    }
}
