//! Hosted locations (desktop plan, Phase 4b): the saved relays, their URL
//! rules and the browser sign-in handoff (D9, state + PKCE). Pure functions
//! and plain data, so they're unit-tested on any host; lib.rs owns windows,
//! menus and the deep-link plugin.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

/// A saved hosted location. "This Mac" is implicit and never stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Location {
    pub id: String,
    pub name: String,
    /// The relay's origin (`https://host[:port]`), no path.
    pub url: String,
}

/// How long the browser sign-in may take before its deep link is refused.
pub const HANDOFF_TTL: Duration = Duration::from_secs(10 * 60);

pub const SCHEME: &str = "codekin";

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("OS random source");
    buf
}

pub fn new_location_id() -> String {
    random_bytes::<16>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The WebKit data store of a location (D11): stable per id, never shared.
pub fn data_store_id(location_id: &str) -> [u8; 16] {
    let digest = Sha256::digest(format!("codekin-location:{location_id}").as_bytes());
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest[..16]);
    id
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1")
}

/// Normalize what the user typed into a relay origin. `https://` only, except
/// plain `http://` on loopback for relay development. A bare host gets
/// `https://`. Paths other than `/`, queries, fragments and credentials are
/// refused rather than dropped: they mean the user pasted something else.
pub fn normalize_origin(input: &str) -> Result<String, &'static str> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Enter the address of a Codekin relay.");
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| "That isn't a valid address.")?;
    let host = url.host_str().ok_or("That isn't a valid address.")?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(host) => {}
        "http" => return Err("Use an https:// address."),
        _ => return Err("Use an https:// address."),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave the user name and password out of the address.");
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("Use the relay's address without a path, e.g. https://app.codekin.ai.");
    }
    Ok(url.origin().ascii_serialization())
}

/// The origin of a parsed URL, comparable with a stored location URL.
pub fn origin_of(url: &url::Url) -> String {
    url.origin().ascii_serialization()
}

/// `GET /api/relay/info` → the relay's display name, or `None` when the
/// answer isn't from a Codekin relay.
pub fn parse_relay_info(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    if v.get("app")?.as_str()? != "codekin-relay" {
        return None;
    }
    Some(
        v.get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
    )
}

/// A default name for a location: the relay's own name, else its host.
pub fn default_name(origin: &str, relay_name: &str) -> String {
    if !relay_name.is_empty() {
        return relay_name.to_string();
    }
    url::Url::parse(origin)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| origin.to_string())
}

/// What the location window may show: its own origin and the bundled pages.
pub fn location_navigation_allowed(url: &url::Url, origin: &str) -> bool {
    match url.scheme() {
        "tauri" => location_page_allowed(url),
        "http" | "https" if url.host_str() == Some("tauri.localhost") => location_page_allowed(url),
        "http" | "https" => origin_of(url) == origin,
        // about:blank and friends from the hosted page's own frames.
        "about" => true,
        _ => false,
    }
}

/// The location window's user agent: Safari's, so the hosted UI treats it as
/// the WebKit it is, plus `CodekinDesktop/<version>`, which is how the hosted
/// UI knows to hand sign-in to the shell instead of starting GitHub OAuth in
/// the webview.
pub fn user_agent(app_version: &str) -> String {
    #[cfg(target_os = "macos")]
    let platform = "Macintosh; Intel Mac OS X 10_15_7";
    #[cfg(not(target_os = "macos"))]
    let platform = "X11; Linux x86_64";
    format!(
        "Mozilla/5.0 ({platform}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 CodekinDesktop/{app_version}"
    )
}

/// Bundled pages a location window may show. Never the location manager:
/// a hosted page could navigate its own window there.
pub fn location_page_allowed(url: &url::Url) -> bool {
    let view = url
        .query_pairs()
        .find(|(k, _)| k == "view")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    matches!(view.as_str(), "signin" | "waiting" | "claim")
}

/// What a `codekin:` URL asks the shell to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchemeRequest {
    /// `codekin://sign-in`: the hosted UI is signed out; show the sign-in page.
    SignIn,
    /// `codekin://sign-in?reason=step_up`: re-verify through the browser now.
    StepUp,
    /// `codekin://auth?...`: the relay handing a sign-in back.
    Auth,
    Other,
}

pub fn classify(url: &url::Url) -> SchemeRequest {
    if url.scheme() != SCHEME {
        return SchemeRequest::Other;
    }
    match url.host_str() {
        Some("sign-in") => {
            if url
                .query_pairs()
                .any(|(k, v)| k == "reason" && v == "step_up")
            {
                SchemeRequest::StepUp
            } else {
                SchemeRequest::SignIn
            }
        }
        Some("auth") => SchemeRequest::Auth,
        _ => SchemeRequest::Other,
    }
}

/// RFC 7636 S256: base64url(sha256(verifier)), no padding.
pub fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// A browser sign-in in progress for one location.
#[derive(Debug, Clone)]
pub struct Handoff {
    pub location_id: String,
    pub origin: String,
    pub state: String,
    pub verifier: String,
    pub started: Instant,
}

impl Handoff {
    pub fn new(location: &Location) -> Handoff {
        Handoff {
            location_id: location.id.clone(),
            origin: location.url.clone(),
            state: URL_SAFE_NO_PAD.encode(random_bytes::<32>()),
            verifier: URL_SAFE_NO_PAD.encode(random_bytes::<32>()),
            started: Instant::now(),
        }
    }

    /// The relay page the default browser opens.
    pub fn start_url(&self) -> String {
        let q: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("state", &self.state)
            .append_pair("code_challenge", &code_challenge(&self.verifier))
            .append_pair("code_challenge_method", "S256")
            .finish();
        format!("{}/api/auth/desktop/start?{q}", self.origin)
    }
}

/// A validated hand-back, ready to be redeemed in the location's webview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub location_id: String,
    pub origin: String,
    pub code: String,
    pub verifier: String,
}

impl Claim {
    pub fn action(&self) -> String {
        format!("{}/api/auth/desktop/claim", self.origin)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallbackError {
    /// No sign-in is in progress (never started, cancelled or already used).
    NotPending,
    Malformed,
    StateMismatch,
    WrongRelay,
    Expired,
}

/// Check a `codekin://auth?relay=…&code=…&state=…` deep link against the
/// pending handoff. Success consumes it (single use); so does expiry. A link
/// that doesn't match leaves it in place, so a stray or forged link can't
/// cancel the user's real sign-in.
pub fn accept_callback(
    pending: &mut Option<Handoff>,
    url: &url::Url,
    now: Instant,
) -> Result<Claim, CallbackError> {
    let Some(handoff) = pending.as_ref() else {
        return Err(CallbackError::NotPending);
    };
    if classify(url) != SchemeRequest::Auth {
        return Err(CallbackError::Malformed);
    }
    let get = |key: &str| {
        url.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
            .filter(|v| !v.is_empty())
    };
    let (Some(relay), Some(code), Some(state)) = (get("relay"), get("code"), get("state")) else {
        return Err(CallbackError::Malformed);
    };
    if now.duration_since(handoff.started) > HANDOFF_TTL {
        *pending = None;
        return Err(CallbackError::Expired);
    }
    if state != handoff.state {
        return Err(CallbackError::StateMismatch);
    }
    let relay = url::Url::parse(&relay).map(|u| origin_of(&u)).ok();
    if relay.as_deref() != Some(handoff.origin.as_str()) {
        return Err(CallbackError::WrongRelay);
    }
    let handoff = pending.take().expect("checked above");
    Ok(Claim {
        location_id: handoff.location_id,
        origin: handoff.origin,
        code,
        verifier: handoff.verifier,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loc() -> Location {
        Location {
            id: "abc".into(),
            name: "Hosted".into(),
            url: "https://app.codekin.ai".into(),
        }
    }

    fn url(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    #[test]
    fn pkce_matches_rfc_7636_appendix_b() {
        assert_eq!(
            code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn handoff_values_are_43_char_base64url_and_fresh() {
        let a = Handoff::new(&loc());
        let b = Handoff::new(&loc());
        for v in [&a.state, &a.verifier] {
            assert_eq!(v.len(), 43);
            assert!(v
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        }
        assert_ne!(a.state, b.state);
        assert_ne!(a.verifier, b.verifier);
        let start = url(&a.start_url());
        assert_eq!(origin_of(&start), "https://app.codekin.ai");
        assert_eq!(start.path(), "/api/auth/desktop/start");
        let q: std::collections::HashMap<_, _> = start.query_pairs().into_owned().collect();
        assert_eq!(q["state"], a.state);
        assert_eq!(q["code_challenge"], code_challenge(&a.verifier));
        assert_eq!(q["code_challenge_method"], "S256");
        assert!(
            !a.start_url().contains(&a.verifier),
            "the verifier never leaves the shell"
        );
    }

    #[test]
    fn origins_are_normalized_and_strict() {
        assert_eq!(
            normalize_origin("app.codekin.ai").unwrap(),
            "https://app.codekin.ai"
        );
        assert_eq!(
            normalize_origin(" https://App.Codekin.ai/ ").unwrap(),
            "https://app.codekin.ai"
        );
        assert_eq!(
            normalize_origin("https://relay.example:8443").unwrap(),
            "https://relay.example:8443"
        );
        assert_eq!(
            normalize_origin("https://relay.example:443").unwrap(),
            "https://relay.example"
        );
        assert_eq!(
            normalize_origin("http://localhost:32360").unwrap(),
            "http://localhost:32360"
        );
        assert_eq!(
            normalize_origin("http://127.0.0.1:32360").unwrap(),
            "http://127.0.0.1:32360"
        );
        assert_eq!(
            normalize_origin("http://[::1]:32360").unwrap(),
            "http://[::1]:32360"
        );
        for bad in [
            "",
            "http://app.codekin.ai",
            "ftp://app.codekin.ai",
            "https://user:pw@app.codekin.ai",
            "https://user@app.codekin.ai",
            "https://app.codekin.ai/path",
            "https://app.codekin.ai/?x=1",
            "https://app.codekin.ai/#frag",
            "javascript:alert(1)",
            "https://",
        ] {
            assert!(normalize_origin(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn relay_info_must_name_the_relay_app() {
        assert_eq!(
            parse_relay_info(r#"{"app":"codekin-relay","version":"0.10.0","name":"Acme"}"#),
            Some("Acme".into())
        );
        assert_eq!(
            parse_relay_info(r#"{"app":"codekin-relay"}"#),
            Some(String::new())
        );
        assert_eq!(
            parse_relay_info(r#"{"app":"codekin","version":"0.10.0"}"#),
            None
        );
        assert_eq!(parse_relay_info("<html>"), None);
        assert_eq!(default_name("https://relay.example", ""), "relay.example");
        assert_eq!(default_name("https://relay.example", "Acme"), "Acme");
    }

    #[test]
    fn data_store_ids_are_stable_and_distinct() {
        assert_eq!(data_store_id("a"), data_store_id("a"));
        assert_ne!(data_store_id("a"), data_store_id("b"));
        assert_eq!(new_location_id().len(), 32);
        assert_ne!(new_location_id(), new_location_id());
    }

    #[test]
    fn navigation_is_limited_to_the_location_and_bundled_pages() {
        let o = "https://app.codekin.ai";
        assert!(location_navigation_allowed(
            &url("https://app.codekin.ai/settings"),
            o
        ));
        assert!(location_navigation_allowed(
            &url("tauri://localhost/index.html?view=signin"),
            o
        ));
        assert!(location_navigation_allowed(
            &url("http://tauri.localhost/index.html?view=claim"),
            o
        ));
        assert!(!location_navigation_allowed(
            &url("tauri://localhost/index.html?view=locations"),
            o
        ));
        assert!(!location_navigation_allowed(
            &url("tauri://localhost/index.html"),
            o
        ));
        assert!(!location_navigation_allowed(
            &url("https://github.com/login"),
            o
        ));
        assert!(!location_navigation_allowed(
            &url("http://app.codekin.ai/"),
            o
        ));
        assert!(!location_navigation_allowed(
            &url("https://evil.codekin.ai/"),
            o
        ));
        assert!(!location_navigation_allowed(
            &url("http://127.0.0.1:32352/"),
            o
        ));
        assert!(!location_navigation_allowed(&url("codekin://sign-in"), o));
    }

    #[test]
    fn scheme_requests_are_classified() {
        assert_eq!(classify(&url("codekin://sign-in")), SchemeRequest::SignIn);
        assert_eq!(
            classify(&url("codekin://sign-in?reason=step_up")),
            SchemeRequest::StepUp
        );
        assert_eq!(classify(&url("codekin://auth?code=x")), SchemeRequest::Auth);
        assert_eq!(classify(&url("codekin://other")), SchemeRequest::Other);
        assert_eq!(classify(&url("https://sign-in/")), SchemeRequest::Other);
    }

    fn callback(h: &Handoff, relay: &str, state: &str) -> url::Url {
        let q: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("relay", relay)
            .append_pair("code", "the-code")
            .append_pair("state", state)
            .finish();
        let _ = h;
        url(&format!("codekin://auth?{q}"))
    }

    #[test]
    fn callback_accepts_the_matching_link_once() {
        let h = Handoff::new(&loc());
        let mut pending = Some(h.clone());
        let link = callback(&h, "https://app.codekin.ai", &h.state);
        let claim = accept_callback(&mut pending, &link, Instant::now()).unwrap();
        assert_eq!(claim.code, "the-code");
        assert_eq!(claim.verifier, h.verifier);
        assert_eq!(claim.location_id, "abc");
        assert_eq!(
            claim.action(),
            "https://app.codekin.ai/api/auth/desktop/claim"
        );
        // Replay: the handoff is gone.
        assert_eq!(
            accept_callback(&mut pending, &link, Instant::now()),
            Err(CallbackError::NotPending)
        );
    }

    #[test]
    fn callback_refuses_mismatches_without_cancelling_the_real_sign_in() {
        let h = Handoff::new(&loc());
        let mut pending = Some(h.clone());
        let now = Instant::now();
        assert_eq!(
            accept_callback(
                &mut pending,
                &callback(&h, "https://app.codekin.ai", "forged"),
                now
            ),
            Err(CallbackError::StateMismatch)
        );
        assert_eq!(
            accept_callback(
                &mut pending,
                &callback(&h, "https://evil.example", &h.state),
                now
            ),
            Err(CallbackError::WrongRelay)
        );
        assert_eq!(
            accept_callback(&mut pending, &url("codekin://auth?code=x"), now),
            Err(CallbackError::Malformed)
        );
        assert_eq!(
            accept_callback(&mut pending, &url("codekin://sign-in"), now),
            Err(CallbackError::Malformed)
        );
        assert!(pending.is_some());
        // The genuine link still works afterwards.
        assert!(accept_callback(
            &mut pending,
            &callback(&h, "https://app.codekin.ai/", &h.state),
            now
        )
        .is_ok());
    }

    #[test]
    fn callback_expires_after_the_ttl() {
        let h = Handoff::new(&loc());
        let mut pending = Some(h.clone());
        let later = h.started + HANDOFF_TTL + Duration::from_secs(1);
        assert_eq!(
            accept_callback(
                &mut pending,
                &callback(&h, "https://app.codekin.ai", &h.state),
                later
            ),
            Err(CallbackError::Expired)
        );
        assert!(pending.is_none());
    }

    #[test]
    fn the_user_agent_carries_the_desktop_token() {
        let ua = user_agent("0.10.0");
        assert!(ua.starts_with("Mozilla/5.0 ("));
        assert!(ua.contains("AppleWebKit/605.1.15"));
        assert!(ua.ends_with(" CodekinDesktop/0.10.0"));
    }

    #[test]
    fn locations_serialize_plainly() {
        let json = serde_json::to_string(&loc()).unwrap();
        assert_eq!(
            json,
            r#"{"id":"abc","name":"Hosted","url":"https://app.codekin.ai"}"#
        );
    }
}
