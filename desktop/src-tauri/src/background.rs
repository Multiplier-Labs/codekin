//! Running in the background (desktop plan Phase 2): app preferences, and
//! "Keep Mac awake".
//!
//! Keep awake runs `/usr/bin/caffeinate -i -w <app pid>`: it holds the same
//! idle-system-sleep assertion as `IOPMAssertionCreateWithName`, needs no
//! FFI, and ends by itself when the app exits (`-w`), even after a crash, so
//! an assertion can never outlive Codekin. It can't stop sleep when the lid
//! closes on battery; the menu says so.
//!
//! App Nap is opted out of statically with `NSAppSleepDisabled` in Info.plist.

use crate::locations::Location;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Preferences the shell owns (the server's settings live in the server).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub keep_awake: bool,
    /// Saved hosted locations (Phase 4b). "This Mac" is implicit.
    pub locations: Vec<Location>,
    /// The location shown at launch; `None` is This Mac.
    pub last_location: Option<String>,
}

impl Prefs {
    pub fn location(&self, id: &str) -> Option<&Location> {
        self.locations.iter().find(|l| l.id == id)
    }
}

impl Prefs {
    pub fn load(file: &Path) -> Prefs {
        std::fs::read_to_string(file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, file: &Path) -> std::io::Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = file.with_extension("json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_string_pretty(self).unwrap_or_default() + "\n",
        )?;
        std::fs::rename(tmp, file)
    }
}

/// Whether this platform supports keep-awake.
pub fn keep_awake_supported() -> bool {
    cfg!(target_os = "macos") && Path::new(CAFFEINATE).exists()
}

const CAFFEINATE: &str = "/usr/bin/caffeinate";

/// The idle-sleep assertion, held by a `caffeinate` child while enabled.
pub struct KeepAwake {
    program: PathBuf,
    child: Mutex<Option<Child>>,
}

impl Default for KeepAwake {
    fn default() -> Self {
        KeepAwake::with_program(CAFFEINATE)
    }
}

impl KeepAwake {
    /// For tests: run another program with the same arguments.
    pub fn with_program(program: impl Into<PathBuf>) -> Self {
        KeepAwake {
            program: program.into(),
            child: Mutex::new(None),
        }
    }

    /// PID of the assertion-holding child, if any.
    pub fn pid(&self) -> Option<u32> {
        self.child.lock().unwrap().as_ref().map(|c| c.id())
    }

    pub fn is_active(&self) -> bool {
        let mut guard = self.child.lock().unwrap();
        match guard.as_mut().map(|c| c.try_wait()) {
            Some(Ok(None)) => true,
            Some(_) => {
                *guard = None;
                false
            }
            None => false,
        }
    }

    /// Hold or release the assertion. Returns whether it is now held.
    pub fn set(&self, enabled: bool) -> bool {
        let mut guard = self.child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if !enabled {
            return false;
        }
        // -i: prevent idle system sleep; -w: until this process exits.
        let spawned = Command::new(&self.program)
            .args(["-i", "-w", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match spawned {
            Ok(child) => {
                *guard = Some(child);
                true
            }
            Err(_) => false,
        }
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn tempdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "codekin-bg-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn prefs_round_trip_and_tolerate_garbage() {
        let dir = tempdir();
        let file = dir.join("nested/prefs.json");
        assert_eq!(Prefs::load(&file), Prefs::default());
        let on = Prefs {
            keep_awake: true,
            ..Prefs::default()
        };
        on.save(&file).unwrap();
        assert!(std::fs::read_to_string(&file)
            .unwrap()
            .contains("\"keepAwake\": true"));
        assert_eq!(Prefs::load(&file), on);
        std::fs::write(&file, "{not json").unwrap();
        assert_eq!(Prefs::load(&file), Prefs::default());
        std::fs::write(&file, "{\"unknown\": 1}").unwrap();
        assert_eq!(Prefs::load(&file), Prefs::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn prefs_from_before_locations_still_load() {
        let old: Prefs = serde_json::from_str(r#"{"keepAwake": true}"#).unwrap();
        assert!(old.keep_awake);
        assert!(old.locations.is_empty());
        assert_eq!(old.last_location, None);
        let with: Prefs = serde_json::from_str(
            r#"{"keepAwake":false,"locations":[{"id":"a","name":"Acme","url":"https://relay.acme.dev"}],"lastLocation":"a"}"#,
        )
        .unwrap();
        assert_eq!(with.location("a").unwrap().name, "Acme");
        assert_eq!(with.last_location.as_deref(), Some("a"));
        assert!(with.location("b").is_none());
    }

    /// The command line of a running process, via `ps` (works on Linux and macOS).
    fn command_line(pid: u32) -> Option<String> {
        let out = Command::new("ps")
            .args(["-o", "args=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    fn alive(pid: u32) -> bool {
        // SAFETY: signal 0 only checks for existence.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[test]
    fn keep_awake_holds_one_child_with_the_wait_flag() {
        // A stand-in for caffeinate that stays alive under its own name and arguments.
        let dir = tempdir();
        let fake = dir.join("caffeinate");
        std::fs::write(&fake, "#!/bin/sh\nwhile :; do sleep 1; done\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let ka = KeepAwake::with_program(&fake);
        assert!(!ka.is_active());
        assert!(ka.set(true));
        assert!(ka.is_active());
        let first = ka.pid().unwrap();
        let args = command_line(first).expect("child is running");
        assert!(
            args.ends_with(&format!("-i -w {}", std::process::id())),
            "args: {args}"
        );

        // Enabling again replaces the child rather than stacking a second one.
        assert!(ka.set(true));
        let second = ka.pid().unwrap();
        assert_ne!(first, second);
        assert!(!alive(first), "the first child was killed and reaped");
        assert!(ka.is_active());

        assert!(!ka.set(false));
        assert!(!ka.is_active());
        assert!(ka.pid().is_none());
        assert!(!alive(second));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_program_reports_not_held() {
        let ka = KeepAwake::with_program("/nonexistent/caffeinate");
        assert!(!ka.set(true));
        assert!(!ka.is_active());
    }
}
