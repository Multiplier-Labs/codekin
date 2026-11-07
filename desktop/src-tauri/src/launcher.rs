//! Spawning and stopping the server launcher (`codekin app-server`), per D8:
//! `std::process::Command` with its own process group, stdin as the lifetime
//! pipe (EOF = the shell died) and fd 3 as the private credential pipe.
//! No Tauri dependencies; the process tests run on any Unix host.

use crate::protocol::{parse_credential, parse_event_line, Credential, Event};
use command_fds::{CommandFdExt, FdMapping};
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

/// How to start the launcher.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    /// The bundled Node binary (the sidecar).
    pub node: PathBuf,
    /// `<payload>/bin/codekin.mjs`.
    pub cli: PathBuf,
    /// Server log; launcher stdout (minus event lines) and stderr are appended.
    pub log: PathBuf,
    /// Extra environment for the launcher (tests use this to isolate HOME).
    pub env: Vec<(String, String)>,
}

/// A running launcher process. Dropping it does **not** stop the process:
/// call [`Launcher::shutdown`] (or let the lifetime pipe close with the shell).
pub struct Launcher {
    child: Child,
    /// Held open for the launcher's lifetime: closing it tells the launcher to shut down.
    stdin: Option<ChildStdin>,
    events: Receiver<Event>,
    credential: Receiver<Option<Credential>>,
}

/// Result of [`Launcher::first_event`].
#[derive(Debug)]
pub enum FirstEvent {
    Event(Event),
    /// The launcher exited without reporting anything.
    Exited,
    TimedOut,
}

impl Launcher {
    pub fn spawn(spec: &LaunchSpec) -> io::Result<Launcher> {
        if let Some(dir) = spec.log.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&spec.log)?;
        let (cred_read, cred_write) = io::pipe()?;

        let mut cmd = Command::new(&spec.node);
        cmd.arg(&spec.cli)
            .args(["app-server", "--credential-fd=3", "--lifetime-stdin"])
            .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log.try_clone()?))
            // Own process group, so shutdown can reap every descendant (D8).
            .process_group(0);
        cmd.fd_mappings(vec![FdMapping {
            parent_fd: OwnedFd::from(cred_write),
            child_fd: 3,
        }])
        .map_err(|e| io::Error::other(e.to_string()))?;
        let mut child = cmd.spawn()?;
        // The Command holds the parent's copy of the credential pipe's write end;
        // drop it so the reader sees EOF once the launcher closes fd 3 or exits.
        drop(cmd);

        let (cred_tx, credential) = mpsc::channel();
        thread::spawn(move || {
            let mut raw = String::new();
            let mut reader = cred_read;
            let ok = reader.read_to_string(&mut raw).is_ok();
            let _ = cred_tx.send(if ok { parse_credential(&raw) } else { None });
        });

        let stdout = child.stdout.take().expect("stdout is piped");
        let (event_tx, events) = mpsc::channel();
        thread::spawn(move || forward_stdout(stdout, log, event_tx));

        Ok(Launcher {
            stdin: child.stdin.take(),
            child,
            events,
            credential,
        })
    }

    pub fn pid(&self) -> i32 {
        self.child.id() as i32
    }

    /// Wait for the first event line.
    pub fn first_event(&mut self, timeout: Duration) -> FirstEvent {
        match self.events.recv_timeout(timeout) {
            Ok(event) => FirstEvent::Event(event),
            Err(RecvTimeoutError::Timeout) => FirstEvent::TimedOut,
            Err(RecvTimeoutError::Disconnected) => FirstEvent::Exited,
        }
    }

    /// The credential from fd 3. The launcher writes it before any outcome
    /// event, so after the first event this returns almost at once.
    pub fn credential(&self, timeout: Duration) -> Option<Credential> {
        self.credential.recv_timeout(timeout).ok().flatten()
    }

    /// Whether the launcher process has exited (reaping it if so).
    pub fn has_exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)) | Err(_))
    }

    /// Wait for a launcher that is expected to exit on its own (attach and
    /// error outcomes), then clean up its process group.
    pub fn finish(mut self, timeout: Duration) -> bool {
        let pgid = self.pid();
        let exited = wait_exit(&mut self.child, timeout);
        if !exited {
            kill_group(pgid, libc::SIGKILL);
            let _ = self.child.wait();
        }
        drop(self.stdin.take());
        reap_group(pgid, Duration::from_secs(2))
    }

    /// Stop an owned server: SIGTERM to the launcher PID only, so
    /// `gracefulShutdown` can stop sessions and persist state; after `grace`,
    /// SIGKILL the whole group. Then kill anything left in the group even if
    /// the launcher already exited. Returns true when the group is empty.
    pub fn shutdown(mut self, grace: Duration) -> bool {
        let pid = self.pid();
        if !self.has_exited() {
            // SAFETY: signalling our own child, which we haven't reaped.
            unsafe { libc::kill(pid, libc::SIGTERM) };
            if !wait_exit(&mut self.child, grace) {
                kill_group(pid, libc::SIGKILL);
                let _ = self.child.wait();
            }
        }
        drop(self.stdin.take());
        reap_group(pid, Duration::from_secs(2))
    }

    /// After a crash: clean up whatever the dead launcher left in its group.
    pub fn cleanup_after_exit(mut self) -> bool {
        let pid = self.pid();
        let _ = self.child.wait();
        drop(self.stdin.take());
        reap_group(pid, Duration::from_secs(2))
    }
}

/// Copy launcher stdout to the log, forwarding event lines to the channel instead.
fn forward_stdout(stdout: impl Read, mut log: File, events: mpsc::Sender<Event>) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        match parse_event_line(&line) {
            Some(event) => {
                let _ = events.send(event);
            }
            None => {
                let _ = writeln!(log, "{line}");
            }
        }
    }
}

fn wait_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return true,
            Ok(None) if Instant::now() >= deadline => return false,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn kill_group(pgid: i32, signal: libc::c_int) {
    if pgid > 1 {
        // SAFETY: plain syscall; a negative/1 pgid is excluded above.
        unsafe { libc::killpg(pgid, signal) };
    }
}

/// Whether any process is still in group `pgid`.
pub fn group_alive(pgid: i32) -> bool {
    // SAFETY: signal 0 only checks for existence.
    pgid > 1 && unsafe { libc::killpg(pgid, 0) } == 0
}

/// SIGKILL the group until it's empty or `timeout` passes. True when empty.
fn reap_group(pgid: i32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while group_alive(pgid) {
        if Instant::now() >= deadline {
            return false;
        }
        kill_group(pgid, libc::SIGKILL);
        thread::sleep(Duration::from_millis(50));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A fake `node` that runs the given shell script as the "launcher".
    fn fake(dir: &std::path::Path, script: &str) -> LaunchSpec {
        let node = dir.join("node");
        std::fs::write(
            &node,
            format!("#!/bin/sh\n# args: cli app-server ...\n{script}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        LaunchSpec {
            node,
            cli: dir.join("codekin.mjs"),
            log: dir.join("logs/server.log"),
            env: vec![],
        }
    }

    fn tempdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "codekin-launcher-test-{}-{}",
            std::process::id(),
            rand_suffix()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    #[test]
    fn reads_credential_and_event_and_logs_the_rest() {
        let dir = tempdir();
        let spec = fake(
            &dir,
            r#"echo "booting"
printf '{"token":"tok","source":"AUTH_TOKEN"}\n' >&3
exec 3>&-
echo '@@codekin {"event":"attach","port":4000,"host":"127.0.0.1","version":"1.0.0"}'
echo "warn" >&2"#,
        );
        let mut l = Launcher::spawn(&spec).unwrap();
        match l.first_event(Duration::from_secs(5)) {
            FirstEvent::Event(Event::Attach { port, .. }) => assert_eq!(port, 4000),
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(l.credential(Duration::from_secs(5)).unwrap().token, "tok");
        assert!(l.finish(Duration::from_secs(5)));
        let log = std::fs::read_to_string(&spec.log).unwrap();
        assert!(log.contains("booting") && log.contains("warn"));
        assert!(!log.contains("@@codekin") && !log.contains("tok"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn exiting_without_an_event_is_reported() {
        let dir = tempdir();
        let mut l = Launcher::spawn(&fake(&dir, "exit 3")).unwrap();
        assert!(matches!(
            l.first_event(Duration::from_secs(5)),
            FirstEvent::Exited
        ));
        assert!(l.credential(Duration::from_secs(2)).is_none());
        assert!(l.finish(Duration::from_secs(2)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stdin_eof_reaches_the_launcher() {
        // The launcher exits when its stdin closes: dropping the shell's end must cause that.
        let dir = tempdir();
        let marker = dir.join("eof");
        let spec = fake(&dir, &format!("cat >/dev/null; touch {}", marker.display()));
        let mut l = Launcher::spawn(&spec).unwrap();
        drop(l.stdin.take());
        assert!(
            wait_exit(&mut l.child, Duration::from_secs(5)),
            "launcher saw EOF and exited"
        );
        assert!(marker.exists());
        assert!(l.cleanup_after_exit());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn shutdown_sigterms_the_launcher_then_reaps_its_group() {
        let dir = tempdir();
        let marker = dir.join("graceful");
        // Launcher: a background grandchild in the same group, and a TERM trap.
        let spec = fake(
            &dir,
            &format!(
                "sleep 300 &\ntrap 'touch {}; exit 0' TERM\necho '@@codekin {{\"event\":\"started\",\"port\":1,\"host\":\"h\",\"version\":\"v\"}}'\nwhile :; do sleep 0.1; done",
                marker.display()
            ),
        );
        let mut l = Launcher::spawn(&spec).unwrap();
        assert!(matches!(
            l.first_event(Duration::from_secs(5)),
            FirstEvent::Event(Event::Started { .. })
        ));
        let pid = l.pid();
        assert!(group_alive(pid));
        assert!(l.shutdown(Duration::from_secs(5)));
        assert!(marker.exists(), "launcher got SIGTERM first");
        assert!(!group_alive(pid), "the background sleep was reaped too");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn shutdown_escalates_when_sigterm_is_ignored() {
        let dir = tempdir();
        let spec = fake(&dir, "trap '' TERM\nwhile :; do sleep 0.1; done");
        let l = Launcher::spawn(&spec).unwrap();
        let pid = l.pid();
        thread::sleep(Duration::from_millis(200));
        let started = Instant::now();
        assert!(l.shutdown(Duration::from_millis(500)));
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(!group_alive(pid));
        let _ = std::fs::remove_dir_all(dir);
    }
}
