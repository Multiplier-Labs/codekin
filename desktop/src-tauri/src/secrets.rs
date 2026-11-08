//! The app binary as a Keychain helper for the bundled server
//! (docs/RELAY-HARDENING.md §5).
//!
//! `Codekin --codekin-secrets get|set|delete <service> <account>`
//!
//! The server (Node) can't use the Keychain itself, so it runs the app's own
//! executable in this mode. Using the app binary rather than a separate
//! helper means the item's access list is bound to the app's code signature
//! (no prompts on later reads) and nothing extra needs signing or bundling.
//! `main` checks for the flag before Tauri starts, so this never opens a window.
//!
//! - Secrets travel on stdin (`set`) and stdout (`get`), never in argv, so
//!   they don't show in `ps`.
//! - Only services under `ai.codekin.` are reachable: any local program can
//!   run this binary, and it must not become a general Keychain reader.
//! - Exit codes: 0 ok, 1 no such item, 2 bad usage, 3 store error or no
//!   Keychain on this platform.

use std::io::{Read, Write};

pub const FLAG: &str = "--codekin-secrets";
const SERVICE_PREFIX: &str = "ai.codekin.";
const MAX_SECRET_BYTES: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub enum Op {
    Get,
    Set,
    Delete,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Request<'a> {
    pub op: Op,
    pub service: &'a str,
    pub account: &'a str,
}

/// Whether the process was started in helper mode.
pub fn invoked(args: &[String]) -> bool {
    args.get(1).is_some_and(|a| a == FLAG)
}

/// Parse `<exe> --codekin-secrets <op> <service> <account>`.
pub fn parse(args: &[String]) -> Result<Request<'_>, String> {
    let [_, flag, op, service, account] = args else {
        return Err(format!("usage: {FLAG} get|set|delete <service> <account>"));
    };
    if flag != FLAG {
        return Err(format!("expected {FLAG}"));
    }
    let op = match op.as_str() {
        "get" => Op::Get,
        "set" => Op::Set,
        "delete" => Op::Delete,
        other => return Err(format!("unknown operation {other:?}")),
    };
    if !service.starts_with(SERVICE_PREFIX) || service.len() > 128 {
        return Err(format!("service must start with {SERVICE_PREFIX}"));
    }
    if account.is_empty()
        || account.len() > 128
        || !account
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("account must be 1-128 characters of [A-Za-z0-9._-]".into());
    }
    Ok(Request {
        op,
        service,
        account,
    })
}

/// Read the secret for `set` from stdin: one value, trailing newline dropped.
pub fn read_secret(mut input: impl Read) -> Result<String, String> {
    let mut buf = Vec::new();
    input
        .by_ref()
        .take(MAX_SECRET_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() > MAX_SECRET_BYTES {
        return Err("secret too long".into());
    }
    let text = String::from_utf8(buf).map_err(|_| "secret must be UTF-8".to_string())?;
    let secret = text.strip_suffix('\n').unwrap_or(&text);
    if secret.is_empty() {
        return Err("empty secret".into());
    }
    Ok(secret.to_string())
}

/// Run helper mode and return the process exit code.
pub fn run(args: &[String]) -> i32 {
    let req = match parse(args) {
        Ok(req) => req,
        Err(msg) => {
            eprintln!("{msg}");
            return 2;
        }
    };
    match req.op {
        Op::Get => match store::get(req.service, req.account) {
            Ok(Some(secret)) => {
                let mut out = std::io::stdout().lock();
                if out
                    .write_all(secret.as_bytes())
                    .and_then(|()| out.flush())
                    .is_err()
                {
                    return 3;
                }
                0
            }
            Ok(None) => 1,
            Err(e) => {
                eprintln!("{e}");
                3
            }
        },
        Op::Set => {
            let secret = match read_secret(std::io::stdin().lock()) {
                Ok(s) => s,
                Err(msg) => {
                    eprintln!("{msg}");
                    return 2;
                }
            };
            match store::set(req.service, req.account, &secret) {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("{e}");
                    3
                }
            }
        }
        Op::Delete => match store::delete(req.service, req.account) {
            Ok(true) => 0,
            Ok(false) => 1,
            Err(e) => {
                eprintln!("{e}");
                3
            }
        },
    }
}

#[cfg(target_os = "macos")]
mod store {
    use keyring::{Entry, Error};

    fn entry(service: &str, account: &str) -> Result<Entry, String> {
        Entry::new(service, account).map_err(|e| e.to_string())
    }

    pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
        match entry(service, account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set(service: &str, account: &str, secret: &str) -> Result<(), String> {
        entry(service, account)?
            .set_password(secret)
            .map_err(|e| e.to_string())
    }

    pub fn delete(service: &str, account: &str) -> Result<bool, String> {
        match entry(service, account)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(Error::NoEntry) => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod store {
    const UNSUPPORTED: &str = "no Keychain on this platform";

    pub fn get(_service: &str, _account: &str) -> Result<Option<String>, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn set(_service: &str, _account: &str, _secret: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn delete(_service: &str, _account: &str) -> Result<bool, String> {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(parts: &[&str]) -> Vec<String> {
        std::iter::once("Codekin")
            .chain(parts.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn detects_helper_mode() {
        assert!(invoked(&args(&[
            FLAG,
            "get",
            "ai.codekin.desktop.relay",
            "m1"
        ])));
        assert!(!invoked(&args(&[])));
        assert!(!invoked(&args(&["codekin://link"])));
    }

    #[test]
    fn parses_a_request() {
        let a = args(&[
            FLAG,
            "set",
            "ai.codekin.desktop.relay",
            "0e166371-5045-4237",
        ]);
        assert_eq!(
            parse(&a).unwrap(),
            Request {
                op: Op::Set,
                service: "ai.codekin.desktop.relay",
                account: "0e166371-5045-4237"
            }
        );
    }

    #[test]
    fn refuses_other_services_and_odd_accounts() {
        for bad in [
            args(&[FLAG, "get", "com.apple.safari", "x"]),
            args(&[FLAG, "get", "ai.codekin.x", ""]),
            args(&[FLAG, "get", "ai.codekin.x", "a b"]),
            args(&[FLAG, "dump", "ai.codekin.x", "a"]),
            args(&[FLAG, "get", "ai.codekin.x"]),
            args(&[FLAG, "get", "ai.codekin.x", "a", "extra"]),
        ] {
            assert!(parse(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn reads_a_secret_from_stdin() {
        assert_eq!(read_secret(&b"s3cret\n"[..]).unwrap(), "s3cret");
        assert_eq!(read_secret(&b"s3cret"[..]).unwrap(), "s3cret");
        assert!(read_secret(&b""[..]).is_err());
        assert!(read_secret(&b"\n"[..]).is_err());
        assert!(read_secret(&vec![b'x'; MAX_SECRET_BYTES + 1][..]).is_err());
    }
}
