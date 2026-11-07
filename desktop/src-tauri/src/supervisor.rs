//! The server supervisor: runs the launcher flow, owns or attaches to a
//! server, restarts a crashed owned server, and performs Quit / Restart
//! (docs/DESKTOP-APP-TAURI-PLAN.md, "Startup flow (shell)" and "Server lifecycle").
//!
//! It runs on its own thread and talks to the UI only through
//! [`Ui`], so the state machine stays independent of Tauri.

use crate::http::{self, Ping};
use crate::launcher::{FirstEvent, LaunchSpec, Launcher};
use crate::protocol::{explain, restart_backoff, Event};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const FIRST_EVENT_TIMEOUT: Duration = Duration::from_secs(45);
const CREDENTIAL_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(15);
const ATTACH_POLL: Duration = Duration::from_secs(3);
const PING_TIMEOUT: Duration = Duration::from_secs(2);
/// An owned server that ran this long resets the crash backoff.
const HEALTHY_RUN: Duration = Duration::from_secs(60);

/// What the UI is told to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum View {
    /// Splash with a status line (`starting`, `restarting`, `reconnecting`).
    Status(&'static str),
    /// The Codekin UI at this URL.
    App { url: String },
    /// Error view with recovery text, Show logs and Retry.
    Error { code: String, message: String },
}

/// The server the app is connected to, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Connection {
    None,
    Owned {
        host: String,
        port: u16,
        version: String,
    },
    Attached {
        host: String,
        port: u16,
        version: String,
    },
}

impl Connection {
    pub fn server(&self) -> Option<(String, u16)> {
        match self {
            Connection::Owned { host, port, .. } | Connection::Attached { host, port, .. } => {
                Some((host.clone(), *port))
            }
            Connection::None => None,
        }
    }
}

/// Requests from the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ctl {
    Retry,
    RestartServer,
    /// Stop an owned server (if any) and exit the app.
    Quit,
}

pub trait Ui: Send + 'static {
    fn show(&self, view: View);
    /// Called once the supervisor has finished stopping: exit the process.
    fn exit(&self);
}

/// Shared, read-mostly state for the UI thread (navigation guard, Quit flow).
#[derive(Default)]
pub struct Shared {
    pub connection: Mutex<Option<Connection>>,
    pub token: Mutex<Option<String>>,
}

impl Shared {
    pub fn connection(&self) -> Connection {
        self.connection
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(Connection::None)
    }
    fn set(&self, c: Connection, token: Option<String>) {
        *self.connection.lock().unwrap() = Some(c);
        *self.token.lock().unwrap() = token;
    }
}

pub struct Supervisor<U: Ui> {
    pub spec: LaunchSpec,
    /// Version of the bundled server (payload package.json).
    pub bundled_version: String,
    pub ui: U,
    pub shared: Arc<Shared>,
    pub ctl: Receiver<Ctl>,
}

/// How a phase of the loop ended.
enum Next {
    Relaunch,
    RelaunchAfter(Duration),
    Exit,
}

impl<U: Ui> Supervisor<U> {
    pub fn run(mut self) {
        let mut crash_attempt: u32 = 0;
        let mut delay = Duration::ZERO;
        loop {
            if !delay.is_zero() {
                if let Some(Ctl::Quit) = self.wait_ctl(delay) {
                    break;
                }
            }
            self.ui.show(View::Status(if crash_attempt > 0 {
                "restarting"
            } else {
                "starting"
            }));
            match self.launch_once(&mut crash_attempt) {
                Next::Relaunch => delay = Duration::ZERO,
                Next::RelaunchAfter(d) => delay = d,
                Next::Exit => break,
            }
        }
        self.shared.set(Connection::None, None);
        self.ui.exit();
    }

    /// Wait up to `d` for a control message.
    fn wait_ctl(&self, d: Duration) -> Option<Ctl> {
        self.ctl.recv_timeout(d).ok()
    }

    fn launch_once(&mut self, crash_attempt: &mut u32) -> Next {
        let mut launcher = match Launcher::spawn(&self.spec) {
            Ok(l) => l,
            Err(e) => {
                return self.fail(
                    "spawn_failed",
                    format!("Couldn't start the bundled server: {e}."),
                )
            }
        };
        let first = launcher.first_event(FIRST_EVENT_TIMEOUT);
        let credential = launcher.credential(CREDENTIAL_TIMEOUT);
        match first {
            FirstEvent::Event(Event::Started {
                host,
                port,
                version,
            }) => {
                let Some(cred) = credential else {
                    launcher.shutdown(SHUTDOWN_GRACE);
                    return self.fail(
                        "no_credential",
                        "The server started but didn't hand over its credential.".into(),
                    );
                };
                self.shared.set(
                    Connection::Owned {
                        host: host.clone(),
                        port,
                        version,
                    },
                    Some(cred.token.clone()),
                );
                self.ui.show(View::App {
                    url: crate::protocol::app_url(&host, port, &cred.token),
                });
                self.supervise_owned(launcher, crash_attempt)
            }
            FirstEvent::Event(Event::Attach {
                host,
                port,
                version,
            }) => {
                launcher.finish(Duration::from_secs(5));
                let Some(cred) = credential else {
                    return self.fail(
                        "no_credential",
                        "Couldn't read the credential for the running server.".into(),
                    );
                };
                *crash_attempt = 0;
                self.shared.set(
                    Connection::Attached {
                        host: host.clone(),
                        port,
                        version: version.clone(),
                    },
                    Some(cred.token.clone()),
                );
                let url = crate::protocol::app_url(&host, port, &cred.token);
                self.ui.show(View::App { url: url.clone() });
                self.supervise_attached(&host, port, &version, &url)
            }
            FirstEvent::Event(other) => {
                launcher.finish(Duration::from_secs(5));
                let (code, message) = explain(&other).unwrap_or(("unknown", String::new()));
                self.fail(code, message)
            }
            FirstEvent::Exited => {
                launcher.finish(Duration::from_secs(5));
                self.fail(
                    "exited",
                    "The bundled server exited without reporting why. See the logs.".into(),
                )
            }
            FirstEvent::TimedOut => {
                // Stop and reap the stuck launcher before Retry can start another one.
                launcher.shutdown(SHUTDOWN_GRACE);
                self.fail(
                    "timeout",
                    "The bundled server didn't start in time. See the logs.".into(),
                )
            }
        }
    }

    /// Show an error view and wait for Retry or Quit.
    fn fail(&mut self, code: &str, message: String) -> Next {
        self.shared.set(Connection::None, None);
        self.ui.show(View::Error {
            code: code.to_string(),
            message,
        });
        match self.ctl.recv() {
            Ok(Ctl::Retry) | Ok(Ctl::RestartServer) => Next::Relaunch,
            Ok(Ctl::Quit) | Err(_) => Next::Exit,
        }
    }

    fn supervise_owned(&mut self, mut launcher: Launcher, crash_attempt: &mut u32) -> Next {
        let since = Instant::now();
        loop {
            match self.ctl.recv_timeout(Duration::from_millis(250)) {
                Ok(Ctl::Quit) | Err(RecvTimeoutError::Disconnected) => {
                    self.shared.set(Connection::None, None);
                    launcher.shutdown(SHUTDOWN_GRACE);
                    return Next::Exit;
                }
                Ok(Ctl::RestartServer) | Ok(Ctl::Retry) => {
                    self.shared.set(Connection::None, None);
                    *crash_attempt = 0;
                    self.ui.show(View::Status("restarting"));
                    if !launcher.shutdown(SHUTDOWN_GRACE) {
                        return self.fail(
                            "cleanup_failed",
                            "The old server's processes couldn't be stopped.".into(),
                        );
                    }
                    return Next::Relaunch;
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
            if launcher.has_exited() {
                // Crash: clean up the old group first, then restart with backoff.
                // The relaunch re-runs the full probe / lock flow, so a service
                // that started meanwhile is attached to instead.
                self.shared.set(Connection::None, None);
                if !launcher.cleanup_after_exit() {
                    return self.fail(
                        "cleanup_failed",
                        "The crashed server left processes that couldn't be stopped.".into(),
                    );
                }
                if since.elapsed() >= HEALTHY_RUN {
                    *crash_attempt = 0;
                }
                let delay = restart_backoff(*crash_attempt);
                *crash_attempt += 1;
                self.ui.show(View::Status("restarting"));
                return Next::RelaunchAfter(delay);
            }
        }
    }

    fn supervise_attached(&mut self, host: &str, port: u16, version: &str, url: &str) -> Next {
        let mut failures = 0u32;
        let mut reconnecting = false;
        loop {
            match self.ctl.recv_timeout(ATTACH_POLL) {
                Ok(Ctl::Quit) | Err(RecvTimeoutError::Disconnected) => return Next::Exit, // the service keeps running
                Ok(Ctl::Retry) => return Next::Relaunch,
                Ok(Ctl::RestartServer) => {} // not ours to restart; the menu item is disabled
                Err(RecvTimeoutError::Timeout) => {}
            }
            match http::ping(host, port, PING_TIMEOUT) {
                Ping::Codekin { .. } => {
                    failures = 0;
                    if reconnecting {
                        reconnecting = false;
                        self.ui.show(View::App {
                            url: url.to_string(),
                        });
                    }
                }
                Ping::Refused if failures + 1 >= 3 => {
                    // The service is gone. Take over only at the same version;
                    // the relaunch still has to win the data-directory lock.
                    if version == self.bundled_version {
                        return Next::Relaunch;
                    }
                    return self.fail(
                        "service_stopped",
                        format!(
                            "The Codekin service this app was using ({version}) stopped. This app bundles {}; start the service again, or update one of them so the versions match, then Retry.",
                            self.bundled_version
                        ),
                    );
                }
                // Timeouts and HTTP errors never trigger a takeover.
                Ping::Refused | Ping::Failed | Ping::Foreign => {
                    failures += 1;
                    if failures >= 3 && !reconnecting {
                        reconnecting = true;
                        self.ui.show(View::Status("reconnecting"));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::mpsc;

    #[derive(Clone, Default)]
    struct Recorder {
        views: Arc<Mutex<Vec<View>>>,
        exited: Arc<Mutex<bool>>,
    }
    impl Ui for Recorder {
        fn show(&self, view: View) {
            self.views.lock().unwrap().push(view);
        }
        fn exit(&self) {
            *self.exited.lock().unwrap() = true;
        }
    }

    fn fake_spec(script: &str) -> (LaunchSpec, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "codekin-supervisor-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let node = dir.join("node");
        std::fs::write(&node, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        (
            LaunchSpec {
                node,
                cli: dir.join("cli"),
                log: dir.join("server.log"),
                env: vec![],
            },
            dir,
        )
    }

    fn wait_for(rec: &Recorder, pred: impl Fn(&[View]) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if pred(&rec.views.lock().unwrap()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out; views: {:?}", rec.views.lock().unwrap());
    }

    fn start(
        script: &str,
    ) -> (
        Recorder,
        mpsc::Sender<Ctl>,
        Arc<Shared>,
        std::thread::JoinHandle<()>,
        PathBuf,
    ) {
        let (spec, dir) = fake_spec(script);
        let rec = Recorder::default();
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Shared::default());
        let sup = Supervisor {
            spec,
            bundled_version: "1.0.0".into(),
            ui: rec.clone(),
            shared: shared.clone(),
            ctl: rx,
        };
        let handle = std::thread::spawn(move || sup.run());
        (rec, tx, shared, handle, dir)
    }

    const CRED: &str = r#"printf '{"token":"tok","source":"AUTH_TOKEN"}\n' >&3; exec 3>&-"#;

    #[test]
    fn owned_server_is_shown_then_stopped_on_quit() {
        let script = format!(
            "{CRED}\necho '@@codekin {{\"event\":\"started\",\"port\":4321,\"host\":\"127.0.0.1\",\"version\":\"1.0.0\"}}'\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done"
        );
        let (rec, tx, shared, handle, dir) = start(&script);
        wait_for(&rec, |v| v.iter().any(|v| matches!(v, View::App { .. })));
        assert!(matches!(
            shared.connection(),
            Connection::Owned { port: 4321, .. }
        ));
        assert!(rec.views.lock().unwrap().contains(&View::App {
            url: "http://127.0.0.1:4321/#token=tok".into()
        }));
        tx.send(Ctl::Quit).unwrap();
        handle.join().unwrap();
        assert!(*rec.exited.lock().unwrap());
        assert_eq!(shared.connection(), Connection::None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_blocking_outcome_shows_the_error_view_and_retry_relaunches() {
        let script = format!("{CRED}\necho '@@codekin {{\"event\":\"port_conflict\",\"port\":4000,\"host\":\"127.0.0.1\"}}'\nexit 4");
        let (rec, tx, _shared, handle, dir) = start(&script);
        wait_for(&rec, |v| {
            v.iter()
                .filter(|v| matches!(v, View::Error { code, .. } if code == "port_conflict"))
                .count()
                == 1
        });
        tx.send(Ctl::Retry).unwrap();
        wait_for(&rec, |v| {
            v.iter().filter(|v| matches!(v, View::Error { .. })).count() == 2
        });
        tx.send(Ctl::Quit).unwrap();
        handle.join().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_crashed_owned_server_is_restarted() {
        // Starts, then crashes; the second launch keeps running.
        let marker = std::env::temp_dir().join(format!("codekin-sup-crash-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let script = format!(
            "{CRED}\necho '@@codekin {{\"event\":\"started\",\"port\":1,\"host\":\"127.0.0.1\",\"version\":\"1.0.0\"}}'\nif [ ! -e {m} ]; then touch {m}; exit 1; fi\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done",
            m = marker.display()
        );
        let (rec, tx, _shared, handle, dir) = start(&script);
        wait_for(&rec, |v| {
            v.iter().filter(|v| matches!(v, View::App { .. })).count() == 2
        });
        assert!(rec
            .views
            .lock()
            .unwrap()
            .contains(&View::Status("restarting")));
        tx.send(Ctl::Quit).unwrap();
        handle.join().unwrap();
        let _ = std::fs::remove_file(marker);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_launcher_that_exits_silently_is_an_error() {
        let (rec, tx, _shared, handle, dir) = start("exit 1");
        wait_for(&rec, |v| {
            v.iter()
                .any(|v| matches!(v, View::Error { code, .. } if code == "exited"))
        });
        tx.send(Ctl::Quit).unwrap();
        handle.join().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
