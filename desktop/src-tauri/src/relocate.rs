//! Move to Applications (desktop plan Phase 3a, "App translocation").
//!
//! A quarantined app opened from Downloads runs from a random read-only path
//! (App Translocation), and the harness MCP configs the server writes would
//! record that path. Before the server starts, the shell offers to copy itself
//! to /Applications (or ~/Applications when /Applications isn't writable) and
//! reopen from there.
//!
//! The copy is made with `ditto`, and the quarantine attribute is removed from
//! the copy only: the user already opened this build, and without that step
//! macOS would translocate the moved copy again (the same approach as the
//! widely used LetsMove library).

use std::path::{Path, PathBuf};

/// The `.app` bundle containing `exe` (`…/Codekin.app/Contents/MacOS/codekin-desktop`).
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

/// Whether the bundle should be offered a move: anywhere outside an
/// Applications folder, including translocated paths.
pub fn should_offer_move(bundle: &Path, home: &Path) -> bool {
    let in_apps = bundle.parent() == Some(Path::new("/Applications"))
        || bundle.parent() == Some(home.join("Applications").as_path());
    !in_apps
}

/// Where the copy goes: /Applications when writable, else ~/Applications.
pub fn destination(bundle_name: &std::ffi::OsStr, home: &Path, system_writable: bool) -> PathBuf {
    let dir = if system_writable {
        PathBuf::from("/Applications")
    } else {
        home.join("Applications")
    };
    dir.join(bundle_name)
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".codekin-write-test-{}", std::process::id()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
}

/// Copy the bundle into an Applications folder. Refuses to overwrite an
/// existing copy (the user may have a different version there).
pub fn copy_to_applications(bundle: &Path, home: &Path) -> Result<PathBuf, String> {
    let name = bundle.file_name().ok_or("invalid bundle path")?;
    let dest = destination(name, home, writable(Path::new("/Applications")));
    if dest.exists() {
        return Err(format!(
            "{} already exists. Open that copy, or remove it first.",
            dest.display()
        ));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    let status = std::process::Command::new("/usr/bin/ditto")
        .arg(bundle)
        .arg(&dest)
        .status()
        .map_err(|e| format!("Couldn't run ditto: {e}"))?;
    if !status.success() {
        let _ = std::fs::remove_dir_all(&dest);
        return Err(format!("Copying to {} failed.", dest.display()));
    }
    let _ = std::process::Command::new("/usr/bin/xattr")
        .args(["-dr", "com.apple.quarantine"])
        .arg(&dest)
        .status();
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_bundle_of_the_executable() {
        assert_eq!(
            bundle_of(Path::new(
                "/Users/a/Downloads/Codekin.app/Contents/MacOS/codekin-desktop"
            )),
            Some(PathBuf::from("/Users/a/Downloads/Codekin.app"))
        );
        assert_eq!(
            bundle_of(Path::new("/srv/target/debug/codekin-desktop")),
            None
        );
    }

    #[test]
    fn offers_a_move_outside_applications_folders() {
        let home = Path::new("/Users/a");
        assert!(!should_offer_move(
            Path::new("/Applications/Codekin.app"),
            home
        ));
        assert!(!should_offer_move(
            Path::new("/Users/a/Applications/Codekin.app"),
            home
        ));
        assert!(should_offer_move(
            Path::new("/Users/a/Downloads/Codekin.app"),
            home
        ));
        assert!(should_offer_move(
            Path::new("/private/var/folders/xy/T/AppTranslocation/1234/d/Codekin.app"),
            home
        ));
        // Nested inside Applications is still not "in" it.
        assert!(should_offer_move(
            Path::new("/Applications/Tools/Codekin.app"),
            home
        ));
    }

    #[test]
    fn falls_back_to_the_user_applications_folder() {
        let home = Path::new("/Users/a");
        let name = std::ffi::OsStr::new("Codekin.app");
        assert_eq!(
            destination(name, home, true),
            PathBuf::from("/Applications/Codekin.app")
        );
        assert_eq!(
            destination(name, home, false),
            PathBuf::from("/Users/a/Applications/Codekin.app")
        );
    }
}
