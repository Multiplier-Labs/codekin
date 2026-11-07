//! The launcher contract, as seen from the shell (docs/DESKTOP-APP-TAURI-PLAN.md,
//! "Launcher contract (implemented)"). Pure functions with no Tauri or process
//! dependencies, so they're unit-tested on any host.

use serde::Deserialize;
use std::time::Duration;

/// Prefix of event lines on the launcher's stdout.
pub const EVENT_PREFIX: &str = "@@codekin ";

/// One launcher event. Unknown event names parse as `Unknown`, so a newer
/// launcher can't crash an older shell.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Started {
        port: u16,
        host: String,
        version: String,
    },
    Attach {
        port: u16,
        host: String,
        version: String,
    },
    ConfigError {
        reason: Option<String>,
        source: Option<String>,
    },
    AuthError {
        port: u16,
        source: Option<String>,
    },
    PortConflict {
        port: u16,
    },
    Unresponsive {
        port: u16,
    },
    BindFailed {
        port: u16,
        reason: Option<String>,
    },
    DataInUse {
        dir: Option<String>,
    },
    DataNewer {
        dir: Option<String>,
        #[serde(rename = "writerVersion")]
        writer_version: Option<String>,
        version: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

/// Parse a stdout line. Returns `None` for ordinary log output.
pub fn parse_event_line(line: &str) -> Option<Event> {
    let json = line.strip_prefix(EVENT_PREFIX)?;
    serde_json::from_str(json.trim_end()).ok()
}

/// The credential handed over on fd 3.
#[derive(Clone, Deserialize)]
pub struct Credential {
    pub token: String,
    pub source: String,
}

// Never print the token, even in debug output.
impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("token", &"<redacted>")
            .field("source", &self.source)
            .finish()
    }
}

pub fn parse_credential(raw: &str) -> Option<Credential> {
    let c: Credential = serde_json::from_str(raw.trim()).ok()?;
    if c.token.is_empty() {
        None
    } else {
        Some(c)
    }
}

/// Host part of a URL, bracketing IPv6 literals.
fn url_host(host: &str) -> String {
    if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

/// The server origin, e.g. `http://127.0.0.1:32352`.
pub fn server_origin(host: &str, port: u16) -> String {
    format!("http://{}:{port}", url_host(host))
}

/// The URL the main window loads: the token goes in the fragment, which is
/// never sent to the server or written to access logs, and which the
/// frontend strips after storing it.
pub fn app_url(host: &str, port: u16, token: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(token.as_bytes()).collect();
    format!("{}/#token={encoded}", server_origin(host, port))
}

/// Whether the main window may navigate to `url` itself: the app's own pages
/// (the splash and error views) and the local server origin. Everything else
/// opens in the default browser.
pub fn is_allowed_navigation(url: &url::Url, server: Option<(&str, u16)>) -> bool {
    match url.scheme() {
        // Tauri's own asset protocol (macOS / Linux) and its Windows form.
        "tauri" => return true,
        "http" | "https" if url.host_str() == Some("tauri.localhost") => return true,
        _ => {}
    }
    let Some((host, port)) = server else {
        return false;
    };
    if url.scheme() != "http" || url.port_or_known_default() != Some(port) {
        return false;
    }
    let Some(h) = url.host_str() else {
        return false;
    };
    let h = h.trim_start_matches('[').trim_end_matches(']');
    h == host || (is_loopback(h) && is_loopback(host))
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// Delay before restart attempt `n` (0-based) after a crash: 1 s, 2 s, 5 s, then every 10 s.
pub fn restart_backoff(attempt: u32) -> Duration {
    Duration::from_secs(match attempt {
        0 => 1,
        1 => 2,
        2 => 5,
        _ => 10,
    })
}

/// Human-readable explanation for an outcome that stops the startup flow,
/// shown in the error view. `None` for `Started` / `Attach`.
pub fn explain(event: &Event) -> Option<(&'static str, String)> {
    Some(match event {
        Event::Started { .. } | Event::Attach { .. } => return None,
        Event::ConfigError { reason, .. } => (
            "config_error",
            format!(
                "Codekin's configuration in ~/.config/codekin can't be used: {}.",
                reason.as_deref().unwrap_or("unknown problem")
            ),
        ),
        Event::AuthError { port, source } => (
            "auth_error",
            format!(
                "A Codekin server on port {port} rejected this Mac's credential ({}). Fix AUTH_TOKEN / AUTH_TOKEN_FILE in ~/.config/codekin/env, or stop that server.",
                source.as_deref().unwrap_or("unknown source")
            ),
        ),
        Event::PortConflict { port } => (
            "port_conflict",
            format!(
                "Port {port} is used by another program, or by an older Codekin service without /api/ping. Upgrade or stop it (codekin stop), or set another PORT in ~/.config/codekin/env."
            ),
        ),
        Event::Unresponsive { port } => (
            "unresponsive",
            format!("Something on port {port} isn't answering. It may be busy or stuck."),
        ),
        Event::BindFailed { port, .. } => (
            "bind_failed",
            format!("Another program took port {port} while Codekin was starting."),
        ),
        Event::DataInUse { dir } => (
            "data_in_use",
            format!(
                "Another Codekin server is using {}. Quit it (codekin stop), or let this app attach to it.",
                dir.as_deref().unwrap_or("the data directory")
            ),
        ),
        Event::DataNewer { dir, writer_version, version } => (
            "data_newer",
            format!(
                "{} was last used by Codekin {}, newer than this app ({}). Update the app; downgrades aren't supported.",
                dir.as_deref().unwrap_or("The data directory"),
                writer_version.as_deref().unwrap_or("?"),
                version.as_deref().unwrap_or("?")
            ),
        ),
        Event::Unknown => ("unknown", "The server launcher reported something this app doesn't understand. Update the app.".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_and_ignores_log_lines() {
        assert_eq!(
            parse_event_line(
                r#"@@codekin {"event":"started","port":32352,"host":"127.0.0.1","version":"0.9.9","pathSource":"login-shell"}"#
            ),
            Some(Event::Started {
                port: 32352,
                host: "127.0.0.1".into(),
                version: "0.9.9".into()
            })
        );
        assert_eq!(
            parse_event_line("@@codekin {\"event\":\"data_newer\",\"port\":1,\"host\":\"h\",\"dir\":\"/d\",\"writerVersion\":\"2.0.0\",\"version\":\"1.0.0\"}\n"),
            Some(Event::DataNewer { dir: Some("/d".into()), writer_version: Some("2.0.0".into()), version: Some("1.0.0".into()) })
        );
        assert_eq!(
            parse_event_line(r#"@@codekin {"event":"from_the_future","port":1}"#),
            Some(Event::Unknown)
        );
        assert_eq!(
            parse_event_line("Codekin WebSocket server listening on 127.0.0.1:32352"),
            None
        );
        assert_eq!(parse_event_line("@@codekin not json"), None);
    }

    #[test]
    fn credential_is_parsed_and_never_debug_printed() {
        let c =
            parse_credential("{\"token\":\"s3cret\",\"source\":\"AUTH_TOKEN_FILE\"}\n").unwrap();
        assert_eq!(c.token, "s3cret");
        assert!(!format!("{c:?}").contains("s3cret"));
        assert!(parse_credential(r#"{"token":"","source":"x"}"#).is_none());
        assert!(parse_credential("").is_none());
    }

    #[test]
    fn app_url_puts_the_token_in_the_fragment() {
        assert_eq!(
            app_url("127.0.0.1", 32352, "a+b/c"),
            "http://127.0.0.1:32352/#token=a%2Bb%2Fc"
        );
        assert_eq!(server_origin("::1", 1), "http://[::1]:1");
    }

    #[test]
    fn navigation_is_limited_to_the_app_and_the_local_server() {
        let ok = |u: &str, s| is_allowed_navigation(&url::Url::parse(u).unwrap(), s);
        let server = Some(("127.0.0.1", 32352));
        assert!(ok("tauri://localhost/index.html", None));
        assert!(ok("http://tauri.localhost/index.html", None));
        assert!(ok("http://127.0.0.1:32352/sessions", server));
        assert!(ok("http://localhost:32352/", server));
        assert!(!ok("http://127.0.0.1:32353/", server));
        assert!(!ok("https://127.0.0.1:32352/", server));
        assert!(!ok("https://github.com/Multiplier-Labs/codekin", server));
        assert!(!ok("http://127.0.0.1:32352/", None));
        assert!(!ok("http://evil.example:32352/", server));
        // A LAN bind host doesn't make loopback names equivalent, and vice versa.
        assert!(ok(
            "http://192.168.1.5:32352/",
            Some(("192.168.1.5", 32352))
        ));
        assert!(!ok("http://localhost:32352/", Some(("192.168.1.5", 32352))));
    }

    #[test]
    fn backoff_follows_the_plan() {
        let secs: Vec<u64> = (0..6).map(|n| restart_backoff(n).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 5, 10, 10, 10]);
    }

    #[test]
    fn every_blocking_outcome_has_an_explanation() {
        assert!(explain(&Event::Started {
            port: 1,
            host: "h".into(),
            version: "v".into()
        })
        .is_none());
        let (code, text) = explain(&Event::PortConflict { port: 4000 }).unwrap();
        assert_eq!(code, "port_conflict");
        assert!(text.contains("4000"));
        assert_eq!(
            explain(&Event::DataInUse { dir: None }).unwrap().0,
            "data_in_use"
        );
    }
}
