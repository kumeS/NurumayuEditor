//! Guarded outbound GET for two kinds of traffic:
//!
//!   * URLs that originate in user content — document image URLs embedded for
//!     PPTX export, Draft reference URLs, and DOI/arXiv lookups — via
//!     `safe_fetch` (no credentials);
//!   * one fixed, operator-configured URL, the OpenRouter model list
//!     (`openrouter_models::OPENROUTER_MODELS_URL`), via `safe_fetch_bearer`,
//!     which adds the user's API key as a bearer token.
//!
//! Both entry points share `safe_fetch_inner`, so every guarantee below applies
//! to every fetch and neither caller can forget one:
//!
//!   * SSRF defence (A5) — the destination host must not resolve to a loopback,
//!     private, link-local, unspecified, CGNAT, or cloud-metadata address. We
//!     follow redirects MANUALLY (reqwest redirects are disabled) and re-validate
//!     every hop, so a public URL can't 30x-bounce us onto an internal one.
//!     Known limit: a VPN / split-DNS resolver that maps a public name (e.g.
//!     openrouter.ai) to a private address is refused too (fail closed); the
//!     LLM calls in `ai.rs` do not go through this guard.
//!   * Resource bound (A4) — only `http(s)` is allowed; an over-large advertised
//!     `Content-Length` is rejected up front; the body is then streamed and
//!     aborted the moment it exceeds `max_bytes`; and a request timeout caps
//!     hangs. So a hostile or accidentally-huge URL can't exhaust memory or wedge
//!     the UI.
//!   * Credential scoping — the bearer token is attached per request, never as
//!     a client default header, and only while the current hop has the same
//!     scheme, host and port as the starting URL AND that scheme is https
//!     (`bearer_allowed`). A redirect to another origin, or a downgrade to
//!     http, drops it. The header value is marked sensitive, and no error
//!     message built here contains it.
//!
//! `safe_fetch`'s error text is a compatibility surface for its callers: every
//! message is exactly what it was before the bearer path existed, including a
//! DNS failure reported as the blocked-address message (fail closed). Only the
//! bearer path exposes the typed `FetchFailure` so its caller can tell
//! "offline" from "blocked" from an HTTP status. No retry happens here.

use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const USER_AGENT: &str = "NurumayuEditor/1.3 (+https://github.com/kumeS/NurumayuEditor)";
const MAX_REDIRECTS: usize = 5;
const BLOCKED_HOST_MESSAGE: &str =
    "Refusing to fetch from a private, loopback, link-local, or metadata address.";

// ----- "zero external transmission" visibility (開発.txt Stage 2, item 2-2) --
//
// Process-wide counters for every fetch made through this module: reference /
// image / citation-lookup fetches (`safe_fetch`) and the OpenRouter model list
// (`safe_fetch_bearer`). NOTE for future readers: 開発.txt's Stage 2 text
// frames `net.rs` as the sole outbound chokepoint for the whole app — that is
// NOT quite accurate. The actual LLM API calls (OpenRouter chat/streaming/
// image-generation) in `ai.rs` construct their own `reqwest::Client` and never
// touch this module. Those calls are counted separately in `ai.rs` (see its
// `ai_call_stats()`); the frontend combines both via
// `commands::get_network_stats`. The model-list fetch is deliberately counted
// here, as a fetch, not as an AI call.
static FETCH_CALLS: AtomicU64 = AtomicU64::new(0);
static FETCH_BYTES: AtomicU64 = AtomicU64::new(0);

/// Current fetch traffic (reference / image / citation lookups and the
/// OpenRouter model list): `(calls, bytes)`. A "call" is every invocation of
/// `safe_fetch` / `safe_fetch_bearer` (successful or not — an attempted fetch
/// still left the machine); "bytes" counts only bytes returned on success.
pub fn stats() -> (u64, u64) {
    (FETCH_CALLS.load(Ordering::Relaxed), FETCH_BYTES.load(Ordering::Relaxed))
}

/// Test-only. The fetch counters are process-global and `cargo test` runs
/// tests in parallel, so every test that bumps them (any `safe_fetch*` call)
/// or reads them for an exact comparison must hold this guard, across
/// modules: net.rs, commands.rs, rag.rs, openrouter_models.rs and ai.rs
/// (whose `net_test_guard` returns this guard; it also covers `AI_CALLS`).
/// Not re-entrant: take it once, at the top of a test.
#[cfg(test)]
static COUNTER_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn network_counter_test_guard() -> std::sync::MutexGuard<'static, ()> {
    COUNTER_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Why a guarded fetch failed. `safe_fetch` renders it with the historical
/// messages (`into_app_error`); the bearer caller maps it itself.
///
/// Deliberately holds no credential: `Refused` messages are fixed text or
/// URL-parse errors, and `Transport` wraps reqwest's error, whose text names
/// the URL (never a header).
#[derive(Debug)]
pub enum FetchFailure {
    /// Refused before or between requests (bad URL, non-http(s) scheme, no
    /// host, bad redirect, too many redirects, unsendable key). The string is
    /// the complete user-facing message.
    Refused(String),
    /// The host resolved to a private/loopback/metadata address.
    Blocked(String),
    /// The host name did not resolve (offline, DNS down, typo).
    Unresolved,
    /// The server answered with a non-success, non-redirect status.
    Status(u16),
    /// The advertised or streamed body exceeded `max_bytes`.
    TooLarge(String),
    /// Connect / TLS / timeout / body-read error from reqwest.
    Transport(reqwest::Error),
}

impl FetchFailure {
    /// The exact `AppError` `safe_fetch` has always returned for this failure.
    pub fn into_app_error(self) -> AppError {
        match self {
            FetchFailure::Refused(m) | FetchFailure::Blocked(m) | FetchFailure::TooLarge(m) => {
                AppError::Network(m)
            }
            // Fail closed with the same text as a blocked host (see module doc).
            FetchFailure::Unresolved => AppError::Network(BLOCKED_HOST_MESSAGE.into()),
            FetchFailure::Status(code) => {
                AppError::Network(format!("Could not fetch URL (HTTP {code})."))
            }
            FetchFailure::Transport(e) => AppError::from(e),
        }
    }
}

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

/// Result of checking a host before fetching from it.
#[derive(Debug, PartialEq, Eq)]
enum HostClass {
    Allowed,
    /// An IP literal, or a name resolving to *any* internal address.
    Blocked,
    /// A name that did not resolve, or resolved to no address at all.
    Unresolved,
}

fn classify_host(host: &str) -> HostClass {
    let trimmed = host.trim();
    // Accept "[::1]" as well as "::1".
    let literal = trimmed.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = literal.parse::<IpAddr>() {
        return if is_blocked_ip(ip) { HostClass::Blocked } else { HostClass::Allowed };
    }
    // A bare hostname → resolve. Port 0 is irrelevant; we only inspect the IPs.
    match (trimmed, 0u16).to_socket_addrs() {
        Ok(addrs) => {
            let mut any = false;
            for a in addrs {
                any = true;
                if is_blocked_ip(a.ip()) {
                    return HostClass::Blocked;
                }
            }
            if any { HostClass::Allowed } else { HostClass::Unresolved }
        }
        Err(_) => HostClass::Unresolved,
    }
}

/// True if `host` (an authority component — a hostname or an IP literal, with or
/// without IPv6 brackets) must not be fetched from. Hostnames are resolved via
/// DNS and blocked if *any* resolved address is internal, or if resolution fails
/// (fail closed). `guard_url` uses the finer `classify_host` directly; this
/// bool form is the unit-tested summary of the same rule.
#[cfg_attr(not(test), allow(dead_code))]
pub fn is_blocked_host(host: &str) -> bool {
    classify_host(host) != HostClass::Allowed
}

fn guard_url(url: &reqwest::Url) -> Result<(), FetchFailure> {
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(FetchFailure::Refused(format!(
                "Refusing to fetch a non-http(s) URL (scheme '{other}')."
            )))
        }
    }
    let host = url
        .host_str()
        .ok_or_else(|| FetchFailure::Refused("URL has no host.".into()))?;
    match classify_host(host) {
        HostClass::Allowed => Ok(()),
        HostClass::Blocked => Err(FetchFailure::Blocked(BLOCKED_HOST_MESSAGE.into())),
        HostClass::Unresolved => Err(FetchFailure::Unresolved),
    }
}

/// Same origin in the web sense: scheme, host and (effective) port all equal.
pub(crate) fn same_origin(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// May the bearer token started at `initial` ride the request to `current`?
/// Only over https, and only to the starting origin.
pub(crate) fn bearer_allowed(initial: &reqwest::Url, current: &reqwest::Url) -> bool {
    initial.scheme() == "https" && same_origin(initial, current)
}

/// The shared guarded GET. Counts the attempt first (even a refused one), then
/// validates every hop, attaching `bearer` only where `bearer_allowed`.
async fn safe_fetch_inner(
    url: &str,
    max_bytes: usize,
    timeout_secs: u64,
    bearer: Option<&str>,
) -> Result<Vec<u8>, FetchFailure> {
    // Count the attempt regardless of outcome — a blocked/failed fetch still
    // means we tried to leave the machine; bytes are only added on success below.
    FETCH_CALLS.fetch_add(1, Ordering::Relaxed);

    // Build the credential header before any I/O, so an unsendable key fails
    // without a request. The message never includes the key.
    let auth = match bearer {
        Some(key) => {
            let mut value = reqwest::header::HeaderValue::from_str(&format!("Bearer {key}"))
                .map_err(|_| {
                    FetchFailure::Refused(
                        "The saved API key contains characters that cannot be sent. \
                         Re-enter the key in Settings."
                            .into(),
                    )
                })?;
            value.set_sensitive(true);
            Some(value)
        }
        None => None,
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .redirect(reqwest::redirect::Policy::none()) // we follow + re-validate manually
        .user_agent(USER_AGENT)
        .build()
        .map_err(FetchFailure::Transport)?;

    let initial = reqwest::Url::parse(url)
        .map_err(|e| FetchFailure::Refused(format!("Invalid URL: {e}")))?;
    let mut current = initial.clone();

    for _ in 0..=MAX_REDIRECTS {
        guard_url(&current)?;
        let mut request = client.get(current.clone());
        if let Some(value) = &auth {
            if bearer_allowed(&initial, &current) {
                request = request.header(reqwest::header::AUTHORIZATION, value.clone());
            }
        }
        let resp = request.send().await.map_err(FetchFailure::Transport)?;
        let status = resp.status();

        if status.is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    FetchFailure::Refused("Redirect without a Location header.".into())
                })?;
            // Resolve relative redirects against the current URL, then re-check.
            current = current
                .join(location)
                .map_err(|e| FetchFailure::Refused(format!("Invalid redirect target: {e}")))?;
            continue;
        }
        if !status.is_success() {
            return Err(FetchFailure::Status(status.as_u16()));
        }
        if let Some(len) = resp.content_length() {
            if len as usize > max_bytes {
                return Err(FetchFailure::TooLarge(format!(
                    "Resource is too large ({len} bytes; the limit is {max_bytes})."
                )));
            }
        }

        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(FetchFailure::Transport)?;
            if buf.len() + chunk.len() > max_bytes {
                return Err(FetchFailure::TooLarge(format!(
                    "Resource exceeded the {max_bytes}-byte limit and was aborted."
                )));
            }
            buf.extend_from_slice(&chunk);
        }
        FETCH_BYTES.fetch_add(buf.len() as u64, Ordering::Relaxed);
        return Ok(buf);
    }

    Err(FetchFailure::Refused("Too many redirects.".into()))
}

/// Fetch a URL's bytes with SSRF and size/timeout protection. Follows up to
/// `MAX_REDIRECTS` redirects, re-validating each hop's host. Returns the body
/// bytes, or a `Network` error if the URL is disallowed, too large, or fails.
/// Sends no credentials.
pub async fn safe_fetch(url: &str, max_bytes: usize, timeout_secs: u64) -> AppResult<Vec<u8>> {
    safe_fetch_inner(url, max_bytes, timeout_secs, None)
        .await
        .map_err(FetchFailure::into_app_error)
}

/// `safe_fetch` plus `Authorization: Bearer <bearer>` on same-origin https
/// hops only (see `bearer_allowed`). For operator-fixed URLs only — the one
/// caller passes the `OPENROUTER_MODELS_URL` constant, never a caller-supplied
/// string. Returns the typed failure so the caller can word 401/429/5xx/offline
/// distinctly.
pub(crate) async fn safe_fetch_bearer(
    url: &str,
    max_bytes: usize,
    timeout_secs: u64,
    bearer: &str,
) -> Result<Vec<u8>, FetchFailure> {
    safe_fetch_inner(url, max_bytes, timeout_secs, Some(bearer)).await
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

    // NOTE: there's no local mock-HTTP-server crate in this workspace (and the
    // task/rules forbid adding a new dependency just for this), so a genuine
    // "byte count increments on a real successful fetch" integration test isn't
    // practical here. What IS practical and non-vacuous without any network
    // mocking: `safe_fetch` must count the ATTEMPT even when the fetch is
    // rejected before ever reaching the wire (blocked host) — this exercises
    // the exact `FETCH_CALLS.fetch_add` line this change adds, using only the
    // existing SSRF guard (no network I/O, no new dependency). A dedicated
    // Runtime (built from the existing `rt` feature) avoids needing the
    // `macros` feature just for `#[tokio::test]`.
    //
    // `calls_after` uses `>=`, not `==`: `FETCH_CALLS` is a process-wide static.
    // Every known fetch test now holds `network_counter_test_guard`, but `>=`
    // is kept as a tolerance for a future unguarded one; it still catches the
    // real regression (the counter not advancing at all).
    #[test]
    fn safe_fetch_counts_the_call_even_when_blocked() {
        let _g = network_counter_test_guard();
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let (calls_before, bytes_before) = stats();

        let result = rt.block_on(safe_fetch("http://127.0.0.1:9/", 1024, 1));

        assert!(result.is_err(), "loopback fetch must be refused by the SSRF guard");
        let (calls_after, bytes_after) = stats();
        // The attempt is counted regardless of outcome.
        assert!(
            calls_after >= calls_before + 1,
            "expected calls to advance by at least 1 (before={calls_before}, after={calls_after})"
        );
        // A failed fetch never adds to the byte counter.
        assert_eq!(bytes_after, bytes_before);
    }

    // Regression guards for the safe_fetch_inner refactor: the reference /
    // image callers (fileio, pptx, citations) and their tests depend on these
    // exact messages, so they are pinned with full equality, not `contains`.
    #[test]
    fn safe_fetch_keeps_its_public_error_text() {
        let _g = network_counter_test_guard();
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let err = |url: &str| rt.block_on(safe_fetch(url, 1024, 1)).unwrap_err().to_string();

        assert_eq!(
            err("file:///etc/passwd"),
            "Network / API error: Refusing to fetch a non-http(s) URL (scheme 'file')."
        );
        assert_eq!(
            err("http://127.0.0.1:9/"),
            "Network / API error: Refusing to fetch from a private, loopback, link-local, or metadata address."
        );
        assert!(
            err("not a url").starts_with("Network / API error: Invalid URL: "),
            "invalid-URL prefix changed"
        );
        // DNS failure keeps the historical (fail-closed) blocked-host text on
        // this path; only the bearer/catalog path tells the two apart.
        assert_eq!(
            err("http://nurumayu-test-host.invalid/"),
            "Network / API error: Refusing to fetch from a private, loopback, link-local, or metadata address."
        );
    }

    fn u(s: &str) -> reqwest::Url {
        reqwest::Url::parse(s).unwrap()
    }

    #[test]
    fn same_origin_compares_scheme_host_and_port() {
        assert!(same_origin(&u("https://openrouter.ai/api/v1/models"), &u("https://openrouter.ai/x")));
        // An explicit default port is the same origin.
        assert!(same_origin(&u("https://openrouter.ai/a"), &u("https://openrouter.ai:443/b")));
        assert!(!same_origin(&u("https://openrouter.ai/a"), &u("https://example.com/a")));
        assert!(!same_origin(&u("https://openrouter.ai/a"), &u("https://api.openrouter.ai/a")));
        assert!(!same_origin(&u("https://openrouter.ai/a"), &u("http://openrouter.ai/a")));
        assert!(!same_origin(&u("https://openrouter.ai/a"), &u("https://openrouter.ai:8443/a")));
    }

    #[test]
    fn bearer_is_sent_only_to_the_original_https_origin() {
        let origin = u("https://openrouter.ai/api/v1/models");
        assert!(bearer_allowed(&origin, &u("https://openrouter.ai/redirected")));
        assert!(!bearer_allowed(&origin, &u("https://example.com/models")));
        // Same host, downgraded to http: never carry the key in cleartext.
        assert!(!bearer_allowed(&origin, &u("http://openrouter.ai/api/v1/models")));
        // An http start never carries a bearer, even to itself.
        let plain = u("http://openrouter.ai/api/v1/models");
        assert!(!bearer_allowed(&plain, &plain));
    }

    #[test]
    fn host_classification_separates_blocked_from_unresolved() {
        assert_eq!(classify_host("127.0.0.1"), HostClass::Blocked);
        assert_eq!(classify_host("[::1]"), HostClass::Blocked);
        assert_eq!(classify_host("8.8.8.8"), HostClass::Allowed);
        assert_eq!(classify_host("nurumayu-test-host.invalid"), HostClass::Unresolved);
        // The public bool keeps failing closed on both.
        assert!(is_blocked_host("nurumayu-test-host.invalid"));
    }

    #[test]
    fn bearer_fetch_reports_blocked_and_unresolved_separately() {
        let _g = network_counter_test_guard();
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let blocked = rt.block_on(safe_fetch_bearer("https://127.0.0.1:9/", 1024, 1, "k"));
        assert!(matches!(blocked, Err(FetchFailure::Blocked(_))), "got {blocked:?}");
        let unresolved =
            rt.block_on(safe_fetch_bearer("https://nurumayu-test-host.invalid/", 1024, 1, "k"));
        assert!(matches!(unresolved, Err(FetchFailure::Unresolved)), "got {unresolved:?}");
    }

    // A key that cannot be an HTTP header value must fail BEFORE any request,
    // and the error must not echo the key.
    #[test]
    fn an_unsendable_key_fails_without_echoing_it() {
        let _g = network_counter_test_guard();
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let res = rt.block_on(safe_fetch_bearer(
            "https://openrouter.ai/api/v1/models",
            1024,
            1,
            "sk-or-SENTINEL-SECRET\nX-Injected: 1",
        ));
        let failure = res.expect_err("a newline in the key must be refused");
        assert!(matches!(failure, FetchFailure::Refused(_)), "got {failure:?}");
        assert!(!format!("{failure:?}").contains("SENTINEL"));
        assert!(!failure.into_app_error().to_string().contains("SENTINEL"));
    }

    #[test]
    fn stats_getter_reflects_the_shared_counters() {
        // Pure sanity check on the getter itself: two independent reads without
        // an intervening fetch must be stable (no accidental increment-on-read),
        // and the tuple order is (calls, bytes) as documented. Holds the
        // counter guard, which excludes every guarded fetch test (see
        // `network_counter_test_guard` for the modules that take it).
        let _g = network_counter_test_guard();
        let a = stats();
        let b = stats();
        assert_eq!(a, b);
    }
}
