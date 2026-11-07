//! App updates (desktop plan D3, Phase 3a): `tauri-plugin-updater` with a
//! signed `.app.tar.gz` referenced by `latest.json` on the `desktop-channel`
//! GitHub release.
//!
//! Order matters: download and verify first (a failure leaves everything
//! running), then confirm with the user if sessions are running, then stop the
//! owned server through the supervisor and wait for its process group to be
//! gone (failed cleanup blocks the install), then install and relaunch. An
//! update never touches an attached service.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::supervisor::{Connection, Ctl};
use crate::{http, AppState};

/// First check this long after launch, then every day.
const FIRST_CHECK: Duration = Duration::from_secs(20);
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const STOP_TIMEOUT: Duration = Duration::from_secs(40);

static IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Background checks: shortly after launch, then daily. Release builds only.
pub fn schedule(app: &AppHandle) {
    if cfg!(debug_assertions) || std::env::var_os("CODEKIN_DISABLE_UPDATES").is_some() {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("updater".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK);
            loop {
                check(&app, false);
                std::thread::sleep(CHECK_EVERY);
            }
        });
}

/// "Check for Updates…" from the menu: always reports the outcome.
pub fn check_now(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || check(&app, true));
}

fn message(app: &AppHandle, title: &str, text: String, kind: MessageDialogKind) {
    app.dialog()
        .message(text)
        .title(title)
        .kind(kind)
        .buttons(MessageDialogButtons::Ok)
        .blocking_show();
}

/// Check, offer, and install. Runs on its own thread (dialogs block).
fn check(app: &AppHandle, interactive: bool) {
    if IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return;
    }
    let outcome = run(app, interactive);
    IN_PROGRESS.store(false, Ordering::SeqCst);
    if let Err(text) = outcome {
        if interactive {
            message(app, "Codekin update", text, MessageDialogKind::Error);
        } else {
            eprintln!("[updater] {text}");
        }
    }
}

fn run(app: &AppHandle, interactive: bool) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|e| format!("Updates aren't configured in this build ({e})."))?;
    let update = tauri::async_runtime::block_on(updater.check())
        .map_err(|e| format!("Couldn't check for updates: {e}"))?;
    let Some(update) = update else {
        if interactive {
            let version = app.package_info().version.to_string();
            message(
                app,
                "Codekin is up to date",
                format!("You have the latest version, {version}."),
                MessageDialogKind::Info,
            );
        }
        return Ok(());
    };

    let install = app
        .dialog()
        .message(format!(
            "Codekin {} is available. You have {}.{}",
            update.version,
            update.current_version,
            update
                .body
                .as_deref()
                .map(|b| format!("\n\n{}", b.trim()))
                .unwrap_or_default()
        ))
        .title("Update available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install and Relaunch".into(),
            "Later".into(),
        ))
        .blocking_show();
    if !install {
        return Ok(());
    }

    // 1. Download and verify while everything keeps running.
    let bytes = tauri::async_runtime::block_on(update.download(|_, _| {}, || {})).map_err(|e| {
        format!("The update couldn't be downloaded or verified, so nothing was changed: {e}")
    })?;

    // 2. Confirm interrupting running sessions (owned server only; unknown counts as running).
    let state = app.state::<AppState>();
    if let Connection::Owned { host, port, .. } = state.shared.connection() {
        let token = state
            .shared
            .token
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_default();
        let active = http::active_sessions(&host, port, &token, Duration::from_secs(2));
        if active != Some(0) && !crate::confirm_stop(app, active, "Install update") {
            return Ok(());
        }
    }

    // 3. Stop the owned server (no automatic restart) and wait for its group to be gone.
    let (tx, rx) = mpsc::channel();
    *state.shared.update_stopped.lock().unwrap() = Some(tx);
    state.send(Ctl::StopForUpdate);
    let clean = rx.recv_timeout(STOP_TIMEOUT).unwrap_or(false);
    if !clean {
        message(
            app,
            "Update not installed",
            "Codekin's server processes couldn't be stopped, so the update wasn't installed. Codekin will restart; try again, or quit and reopen it first.".into(),
            MessageDialogKind::Warning,
        );
        relaunch(app);
    }

    // 4. Install, then relaunch into the new version.
    if let Err(e) = update.install(&bytes) {
        message(app, "Update failed", format!("The update couldn't be installed: {e}. Codekin will restart on the current version."), MessageDialogKind::Error);
    }
    relaunch(app)
}

fn relaunch(app: &AppHandle) -> ! {
    app.state::<AppState>()
        .exit_ready
        .store(true, Ordering::SeqCst);
    app.restart()
}
