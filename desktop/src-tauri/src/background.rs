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

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Preferences the shell owns (the server's settings live in the server).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub keep_awake: bool,
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
        Prefs { keep_awake: true }.save(&file).unwrap();
        assert!(std::fs::read_to_string(&file)
            .unwrap()
            .contains("\"keepAwake\": true"));
        assert_eq!(Prefs::load(&file), Prefs { keep_awake: true });
        std::fs::write(&file, "{not json").unwrap();
        assert_eq!(Prefs::load(&file), Prefs::default());
        std::fs::write(&file, "{\"unknown\": 1}").unwrap();
        assert_eq!(Prefs::load(&file), Prefs::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keep_awake_holds_one_child_with_the_wait_flag() {
        // A stand-in for caffeinate that records its arguments and stays alive.
        let dir = tempdir();
        let fake = dir.join("caffeinate");
        let args_file = dir.join("args");
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\necho \"$@\" >> {}\nexec sleep 30\n",
                args_file.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        // Wait until the fake has recorded `n` starts (it writes after exec).
        let wait_for_starts = |n: usize| -> String {
            for _ in 0..100 {
                let args = std::fs::read_to_string(&args_file).unwrap_or_default();
                if args.lines().count() >= n {
                    return args;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            panic!("fake caffeinate did not start {n} time(s)");
        };

        let ka = KeepAwake::with_program(&fake);
        assert!(!ka.is_active());
        assert!(ka.set(true));
        assert!(ka.is_active());
        let args = wait_for_starts(1);
        assert_eq!(
            args.lines().next().unwrap(),
            format!("-i -w {}", std::process::id())
        );
        // Enabling again replaces the child rather than stacking a second one.
        assert!(ka.set(true));
        wait_for_starts(2);
        assert!(ka.is_active());
        assert!(!ka.set(false));
        assert!(!ka.is_active());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_program_reports_not_held() {
        let ka = KeepAwake::with_program("/nonexistent/caffeinate");
        assert!(!ka.set(true));
        assert!(!ka.is_active());
    }
}
