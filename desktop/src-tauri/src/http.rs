//! Minimal local HTTP probes: `/api/ping` for attach-mode liveness and
//! `/api/health` for the active-session count before Quit / Restart.
//! Never follows redirects, so the token can't be sent anywhere else.

use crate::protocol::server_origin;
use std::io;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

/// Result of an `/api/ping` probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ping {
    Codekin {
        version: String,
    },
    /// Something answered, but not as Codekin.
    Foreign,
    /// Nothing is listening: the only result that may lead to a takeover.
    Refused,
    /// Timeout or another failure: never evidence that the port is free.
    Failed,
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into()
}

fn connect_refused(host: &str, port: u16, timeout: Duration) -> Option<bool> {
    let addr: SocketAddr = (host, port).to_socket_addrs().ok()?.next()?;
    match TcpStream::connect_timeout(&addr, timeout) {
        Ok(_) => Some(false),
        Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => Some(true),
        Err(_) => Some(false),
    }
}

pub fn ping(host: &str, port: u16, timeout: Duration) -> Ping {
    // A plain connect first: it tells "refused" apart from everything else
    // without depending on how the HTTP client reports connection errors.
    match connect_refused(host, port, timeout) {
        Some(true) => return Ping::Refused,
        None => return Ping::Failed,
        Some(false) => {}
    }
    let url = format!("{}/api/ping", server_origin(host, port));
    let Ok(mut res) = agent(timeout).get(&url).call() else {
        return Ping::Failed;
    };
    if res.status().as_u16() != 200 {
        return Ping::Foreign;
    }
    let Ok(body) = res.body_mut().read_to_string() else {
        return Ping::Failed;
    };
    parse_ping(&body)
}

pub fn parse_ping(body: &str) -> Ping {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return Ping::Foreign;
    };
    match (
        v.get("app").and_then(|a| a.as_str()),
        v.get("version").and_then(|a| a.as_str()),
    ) {
        (Some("codekin"), Some(version)) => Ping::Codekin {
            version: version.to_string(),
        },
        _ => Ping::Foreign,
    }
}

/// Active sessions on the server, or `None` when health can't be read
/// (treated as "unknown": the caller still confirms).
pub fn active_sessions(host: &str, port: u16, token: &str, timeout: Duration) -> Option<u64> {
    let url = format!("{}/api/health", server_origin(host, port));
    let mut res = agent(timeout)
        .get(&url)
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .ok()?;
    if res.status().as_u16() != 200 {
        return None;
    }
    let body = res.body_mut().read_to_string().ok()?;
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()?
        .get("claudeSessions")?
        .as_u64()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// One-shot HTTP server answering every request with `response`; returns its port.
    fn serve(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming().take(4) {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf);
                let _ = s.write_all(response.as_bytes());
            }
        });
        port
    }

    fn json(status: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    #[test]
    fn classifies_ping_bodies() {
        assert_eq!(
            parse_ping(r#"{"app":"codekin","version":"1.2.3"}"#),
            Ping::Codekin {
                version: "1.2.3".into()
            }
        );
        assert_eq!(parse_ping(r#"{"app":"other"}"#), Ping::Foreign);
        assert_eq!(parse_ping("<html>"), Ping::Foreign);
    }

    #[test]
    fn pings_a_live_server() {
        let port = serve(Box::leak(
            json("200 OK", r#"{"app":"codekin","version":"9.9.9"}"#).into_boxed_str(),
        ));
        assert_eq!(
            ping("127.0.0.1", port, Duration::from_secs(2)),
            Ping::Codekin {
                version: "9.9.9".into()
            }
        );
    }

    #[test]
    fn a_401_ping_is_foreign_and_redirects_are_not_followed() {
        let port = serve(Box::leak(json("401 Unauthorized", "{}").into_boxed_str()));
        assert_eq!(
            ping("127.0.0.1", port, Duration::from_secs(2)),
            Ping::Foreign
        );
        let port = serve("HTTP/1.1 302 Found\r\nLocation: http://example.com/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert_eq!(
            ping("127.0.0.1", port, Duration::from_secs(2)),
            Ping::Foreign
        );
    }

    #[test]
    fn a_closed_port_is_refused() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert_eq!(
            ping("127.0.0.1", port, Duration::from_secs(2)),
            Ping::Refused
        );
    }

    #[test]
    fn a_silent_server_is_failed_not_refused() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Accepts (backlog) but never answers.
        let res = ping("127.0.0.1", port, Duration::from_millis(300));
        drop(listener);
        assert_eq!(res, Ping::Failed);
    }

    #[test]
    fn reads_the_active_session_count() {
        let port = serve(Box::leak(
            json("200 OK", r#"{"status":"ok","claudeSessions":2}"#).into_boxed_str(),
        ));
        assert_eq!(
            active_sessions("127.0.0.1", port, "t", Duration::from_secs(2)),
            Some(2)
        );
        let port = serve(Box::leak(json("401 Unauthorized", "{}").into_boxed_str()));
        assert_eq!(
            active_sessions("127.0.0.1", port, "t", Duration::from_secs(2)),
            None
        );
    }
}
