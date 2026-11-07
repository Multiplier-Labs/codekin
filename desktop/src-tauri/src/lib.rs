//! Codekin desktop shell (docs/DESKTOP-APP-TAURI-PLAN.md).
//!
//! The shell spawns, watches and stops one process, the bundled
//! `codekin app-server` launcher (D1), and shows the server's own UI in the
//! main window. The pieces:
//! - `protocol`: the launcher's event/credential contract (pure)
//! - `launcher`: process spawning, lifetime/credential pipes, group cleanup
//! - `http`: `/api/ping` and session-count probes
//! - `supervisor`: the startup / attach / restart / quit state machine
//! - this file: window, menu, navigation guard, splash commands, Quit flow

pub mod http;
pub mod launcher;
pub mod protocol;
pub mod supervisor;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use supervisor::{Connection, Ctl, Shared, Supervisor, Ui, View};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";

/// App-wide state managed by Tauri.
struct AppState {
    shared: Arc<Shared>,
    ctl: Mutex<Sender<Ctl>>,
    log: PathBuf,
    /// Set once the supervisor has stopped everything: the next exit request proceeds.
    exit_ready: Arc<AtomicBool>,
    /// A Quit is already in progress (ignore repeated Cmd-Q).
    quitting: AtomicBool,
}

impl AppState {
    fn send(&self, c: Ctl) {
        let _ = self.ctl.lock().unwrap().send(c);
    }
}

/// The URL of a bundled page (splash / error view) with a query string.
fn local_page(query: &str) -> url::Url {
    #[cfg(windows)]
    let base = "http://tauri.localhost/index.html";
    #[cfg(not(windows))]
    let base = "tauri://localhost/index.html";
    let mut u = url::Url::parse(base).expect("static URL");
    u.set_query(Some(query));
    u
}

fn view_url(view: &View) -> url::Url {
    match view {
        View::App { url } => {
            url::Url::parse(url).unwrap_or_else(|_| local_page("view=error&code=bad_url"))
        }
        View::Status(status) => local_page(&format!("view=status&status={status}")),
        View::Error { code, message } => {
            let q: String = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("view", "error")
                .append_pair("code", code)
                .append_pair("message", message)
                .finish();
            local_page(&q)
        }
    }
}

/// Supervisor → window bridge.
struct TauriUi {
    app: AppHandle,
    exit_ready: Arc<AtomicBool>,
}

impl Ui for TauriUi {
    fn show(&self, view: View) {
        let url = view_url(&view);
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            if let Some(w) = app.get_webview_window(MAIN) {
                let _ = w.navigate(url);
            }
            update_menu(&app);
        });
    }

    fn exit(&self) {
        self.exit_ready.store(true, Ordering::SeqCst);
        self.app.exit(0);
    }
}

// ---------------------------------------------------------------------------
// Splash / error view commands (only the bundled pages can call these: the
// server origin is remote and gets no IPC access).
// ---------------------------------------------------------------------------

#[tauri::command]
fn retry(state: tauri::State<'_, AppState>) {
    state.send(Ctl::Retry);
}

#[tauri::command]
fn show_logs(app: AppHandle, state: tauri::State<'_, AppState>) {
    reveal_logs(&app, &state.log);
}

#[tauri::command]
fn quit(app: AppHandle) {
    request_quit(&app);
}

fn reveal_logs(app: &AppHandle, log: &std::path::Path) {
    let target = if log.exists() {
        log.to_path_buf()
    } else {
        log.parent().map(|p| p.to_path_buf()).unwrap_or_default()
    };
    let _ = app.opener().reveal_item_in_dir(target);
}

// ---------------------------------------------------------------------------
// Quit / Restart flows
// ---------------------------------------------------------------------------

/// Quit Codekin. With an owned server, confirm first when sessions are
/// running (or unknown), then let the supervisor stop it before exiting. In
/// attach mode Quit only closes the app; the service keeps running.
fn request_quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
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
            if active != Some(0) && !confirm_stop(&app, active, "Quit Codekin") {
                state.quitting.store(false, Ordering::SeqCst);
                return;
            }
        }
        state.send(Ctl::Quit);
    });
}

fn request_restart(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let Connection::Owned { host, port, .. } = state.shared.connection() else {
            return;
        };
        let token = state
            .shared
            .token
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_default();
        let active = http::active_sessions(&host, port, &token, Duration::from_secs(2));
        if active != Some(0) && !confirm_stop(&app, active, "Restart server") {
            return;
        }
        state.send(Ctl::RestartServer);
    });
}

/// Native confirmation before stopping running sessions. Blocking: call off the main thread.
fn confirm_stop(app: &AppHandle, active: Option<u64>, action: &str) -> bool {
    let detail = match active {
        Some(1) => "1 session is running. It will be stopped and can be resumed after Codekin starts again.".to_string(),
        Some(n) => format!("{n} sessions are running. They will be stopped and can be resumed after Codekin starts again."),
        None => "Codekin couldn't check for running sessions. Any that are running will be stopped.".to_string(),
    };
    app.dialog()
        .message(detail)
        .title(action)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            action.to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show()
}

// ---------------------------------------------------------------------------
// Window and menu
// ---------------------------------------------------------------------------

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_window(app: &AppHandle, shared: Arc<Shared>) -> tauri::Result<WebviewWindow> {
    let opener = app.clone();
    WebviewWindowBuilder::new(
        app,
        MAIN,
        WebviewUrl::App("index.html?view=status&status=starting".into()),
    )
    .title("Codekin")
    .inner_size(1400.0, 900.0)
    .min_inner_size(640.0, 480.0)
    // Required: otherwise Tauri swallows file drops and composer attachments break.
    .disable_drag_drop_handler()
    .on_navigation(move |url| {
        let server = shared.connection().server();
        let allowed =
            protocol::is_allowed_navigation(url, server.as_ref().map(|(h, p)| (h.as_str(), *p)));
        if !allowed && matches!(url.scheme(), "http" | "https" | "mailto") {
            // External links open in the default browser.
            let _ = opener.opener().open_url(url.as_str(), None::<&str>);
        }
        allowed
    })
    .build()
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let restart = MenuItem::with_id(app, "restart_server", "Restart Server", false, None::<&str>)?;
    let logs = MenuItem::with_id(app, "show_logs", "Show Logs", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Codekin", true, Some("CmdOrCtrl+Q"))?;
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let app_menu = Submenu::with_items(
        app,
        "Codekin",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Codekin"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &restart,
            &logs,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    // The webview needs these for copy / paste / undo in text fields.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&reload, &PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

/// Restart Server is available only for an owned server.
fn update_menu(app: &AppHandle) {
    let owned = matches!(
        app.state::<AppState>().shared.connection(),
        Connection::Owned { .. }
    );
    if let Some(menu) = app.menu() {
        if let Some(item) = menu
            .get("restart_server")
            .and_then(|k| k.as_menuitem().cloned())
        {
            let _ = item.set_enabled(owned);
        }
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "quit" => request_quit(app),
        "restart_server" => request_restart(app),
        "show_logs" => reveal_logs(app, &app.state::<AppState>().log),
        "reload" => {
            if let Some(w) = app.get_webview_window(MAIN) {
                let _ = w.eval("location.reload()");
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn log_path(app: &AppHandle) -> PathBuf {
    #[cfg(target_os = "macos")]
    if let Ok(home) = app.path().home_dir() {
        return home.join("Library/Logs/Codekin/server.log");
    }
    app.path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("server.log")
}

/// The bundled Node: Tauri places the `externalBin` sidecar next to the app executable.
fn sidecar_node() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent()
        .map(|d| d.join("node"))
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn payload_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .resource_dir()
        .unwrap_or_default()
        .join("codekin")
}

fn bundled_version(payload: &std::path::Path) -> String {
    std::fs::read_to_string(payload.join("package.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("version")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared = Arc::new(Shared::default());
    let exit_ready = Arc::new(AtomicBool::new(false));
    let (ctl_tx, ctl_rx) = mpsc::channel::<Ctl>();
    let ctl_rx = Mutex::new(Some(ctl_rx));

    let app = tauri::Builder::default()
        // First: a second launch focuses the existing window instead of starting another supervisor.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![retry, show_logs, quit])
        .menu(build_menu)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .setup({
            let shared = shared.clone();
            let exit_ready = exit_ready.clone();
            move |app| {
                let handle = app.handle().clone();
                let log = log_path(&handle);
                app.manage(AppState {
                    shared: shared.clone(),
                    ctl: Mutex::new(ctl_tx),
                    log: log.clone(),
                    exit_ready: exit_ready.clone(),
                    quitting: AtomicBool::new(false),
                });
                build_window(&handle, shared.clone())?;

                let payload = payload_dir(&handle);
                let spec = launcher::LaunchSpec {
                    node: sidecar_node(),
                    cli: payload.join("bin").join("codekin.mjs"),
                    log,
                    env: vec![],
                };
                let supervisor = Supervisor {
                    spec,
                    bundled_version: bundled_version(&payload),
                    ui: TauriUi {
                        app: handle.clone(),
                        exit_ready,
                    },
                    shared,
                    ctl: ctl_rx.lock().unwrap().take().expect("setup runs once"),
                };
                std::thread::Builder::new()
                    .name("supervisor".into())
                    .spawn(move || supervisor.run())?;
                Ok(())
            }
        })
        .on_window_event(|window, event| {
            // Closing the window (or Cmd-W) hides it: the server and phone sessions keep running.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Codekin app");

    app.run(|app, event| match event {
        // Any exit path (menu, Dock "Quit", logout) goes through the Quit
        // flow so an owned server shuts down gracefully first.
        RunEvent::ExitRequested { api, .. }
            if !app.state::<AppState>().exit_ready.load(Ordering::SeqCst) =>
        {
            api.prevent_exit();
            request_quit(app);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        _ => {}
    });
}
