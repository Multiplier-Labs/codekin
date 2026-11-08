//! Codekin desktop shell (docs/DESKTOP-APP-TAURI-PLAN.md).
//!
//! The shell spawns, watches and stops one process, the bundled
//! `codekin app-server` launcher (D1), and shows the server's own UI in the
//! main window. The pieces:
//! - `protocol`: the launcher's event/credential contract (pure)
//! - `launcher`: process spawning, lifetime/credential pipes, group cleanup
//! - `http`: `/api/ping` and session-count probes
//! - `supervisor`: the startup / attach / restart / quit state machine
//! - `background`: shell preferences and Keep Mac awake
//! - `updater`: signed app updates; `relocate`: move to Applications
//! - `locations` (pure) and `hosted`: hosted locations, their windows and the
//!   browser sign-in handoff (Phase 4b)
//! - `welcome`: the first-run choice between local agents and the web app
//! - this file: window, menus (app + menu bar icon), navigation guard,
//!   splash commands, Quit flow, the deferred local server start

pub mod background;
mod hosted;
pub mod http;
pub mod launcher;
pub mod locations;
pub mod protocol;
pub mod relocate;
pub mod secrets;
pub mod supervisor;
pub mod updater;
mod welcome;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use background::{KeepAwake, Launch, Prefs};
use supervisor::{Connection, Ctl, Shared, Supervisor, Ui, View};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

pub(crate) const MAIN: &str = "main";

/// App-wide state managed by Tauri.
pub(crate) struct AppState {
    pub(crate) shared: Arc<Shared>,
    ctl: Mutex<Sender<Ctl>>,
    log: PathBuf,
    /// Set once the supervisor has stopped everything: the next exit request proceeds.
    pub(crate) exit_ready: Arc<AtomicBool>,
    /// A Quit is already in progress (ignore repeated Cmd-Q).
    quitting: AtomicBool,
}

/// Menu bar icon items whose state changes, and the shell's own preferences.
pub(crate) struct BackgroundState {
    pub(crate) prefs_file: PathBuf,
    pub(crate) prefs: Mutex<Prefs>,
    keep_awake: KeepAwake,
    tray_restart: MenuItem<tauri::Wry>,
    tray_keep_awake: CheckMenuItem<tauri::Wry>,
    tray_login: CheckMenuItem<tauri::Wry>,
}

impl AppState {
    pub(crate) fn send(&self, c: Ctl) {
        let _ = self.ctl.lock().unwrap().send(c);
    }
}

/// The bundled server, started at launch in local mode and on first use of
/// This Mac otherwise (a web-only Mac never runs it).
pub(crate) struct LocalServer {
    run: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    started: AtomicBool,
    /// Set once the move-to-Applications check is over: the server must not
    /// start from a translocated path (its MCP configs would record it).
    relocation_done: Arc<(Mutex<bool>, Condvar)>,
}

/// Whether the bundled server has been started (it may have stopped since).
pub(crate) fn local_server_started(app: &AppHandle) -> bool {
    app.try_state::<LocalServer>()
        .is_some_and(|s| s.started.load(Ordering::SeqCst))
}

/// Start the bundled server unless it already was. Any thread.
pub(crate) fn ensure_local_server(app: &AppHandle) {
    let Some(server) = app.try_state::<LocalServer>() else {
        return;
    };
    let Some(run) = server.run.lock().unwrap().take() else {
        return;
    };
    server.started.store(true, Ordering::SeqCst);
    let gate = server.relocation_done.clone();
    let _ = std::thread::Builder::new()
        .name("supervisor".into())
        .spawn(move || {
            let (done, cv) = &*gate;
            let mut ready = done.lock().unwrap();
            while !*ready {
                ready = cv.wait(ready).unwrap();
            }
            drop(ready);
            run()
        });
    // Keep Mac awake only matters while this Mac serves sessions.
    if let Some(bg) = app.try_state::<BackgroundState>() {
        if bg.prefs.lock().unwrap().keep_awake && background::keep_awake_supported() {
            let held = bg.keep_awake.set(true);
            let _ = bg.tray_keep_awake.set_checked(held);
        }
    }
    let a = app.clone();
    let _ = app.run_on_main_thread(move || update_menu(&a));
}

/// The URL of a bundled page (splash / error view) with a query string.
pub(crate) fn local_page(query: &str) -> url::Url {
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
    // No server ever ran (web only): nothing to stop or confirm.
    if !local_server_started(app) {
        state.exit_ready.store(true, Ordering::SeqCst);
        app.exit(0);
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
pub(crate) fn confirm_stop(app: &AppHandle, active: Option<u64>, action: &str) -> bool {
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

/// Show the window of the location on screen (This Mac or a hosted one), or
/// the welcome screen while the first-run choice is still open.
fn show_main(app: &AppHandle) {
    if welcome::needed(app) {
        welcome::open(app);
        return;
    }
    if let Some(w) = hosted::current_window(app) {
        // This Mac on screen needs its server; a hosted location doesn't.
        if w.label() == MAIN {
            ensure_local_server(app);
        }
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub(crate) fn open_external(app: &AppHandle, url: &url::Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

fn build_window(app: &AppHandle, shared: Arc<Shared>) -> tauri::Result<WebviewWindow> {
    let opener = app.clone();
    let new_window_opener = app.clone();
    WebviewWindowBuilder::new(
        app,
        MAIN,
        WebviewUrl::App("index.html?view=status&status=starting".into()),
    )
    .title("Codekin")
    .inner_size(1400.0, 900.0)
    .min_inner_size(640.0, 480.0)
    // Shown by hosted::restore, unless the last-used location is a hosted one.
    .visible(false)
    // Required: otherwise Tauri swallows file drops and composer attachments break.
    .disable_drag_drop_handler()
    .on_navigation(move |url| {
        let server = shared.connection().server();
        let allowed =
            protocol::is_allowed_navigation(url, server.as_ref().map(|(h, p)| (h.as_str(), *p)));
        if !allowed {
            // External links open in the default browser.
            open_external(&opener, url);
        }
        allowed
    })
    // `target=_blank` links and window.open: never a second app window; the
    // default browser instead (e.g. "Open app.codekin.ai" while pairing).
    .on_new_window(move |url, _features| {
        open_external(&new_window_opener, &url);
        NewWindowResponse::Deny
    })
    .build()
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let restart = MenuItem::with_id(app, "restart_server", "Restart Server", false, None::<&str>)?;
    let logs = MenuItem::with_id(app, "show_logs", "Show Logs", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Codekin", true, Some("CmdOrCtrl+Q"))?;
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let check_updates = MenuItem::with_id(
        app,
        "check_updates",
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let welcome = MenuItem::with_id(app, "welcome", "Welcome…", true, None::<&str>)?;
    let app_menu = Submenu::with_items(
        app,
        "Codekin",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Codekin"), None)?,
            &check_updates,
            &welcome,
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
    // Filled in setup, once the saved locations are loaded.
    let location = hosted::location_submenu(app, "location_menu")?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &location, &window])
}

/// The menu bar icon (`tray-icon`): open, Keep Mac awake, Open at login,
/// Restart Server, Show Logs, Quit. Its items share the app menu's handlers.
fn build_tray(app: &AppHandle, prefs: &Prefs) -> tauri::Result<BackgroundState> {
    let restart = MenuItem::with_id(app, "restart_server", "Restart Server", false, None::<&str>)?;
    let keep_awake = CheckMenuItem::with_id(
        app,
        "keep_awake",
        "Keep Mac Awake",
        background::keep_awake_supported(),
        prefs.keep_awake,
        None::<&str>,
    )?;
    // Menus have no tooltips on macOS: say what keep-awake can't do in the menu itself.
    let keep_awake_note = MenuItem::with_id(
        app,
        "keep_awake_note",
        "  Sleeps anyway with the lid closed on battery",
        false,
        None::<&str>,
    )?;
    let login_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(
        app,
        "open_at_login",
        "Open at Login",
        true,
        login_enabled,
        None::<&str>,
    )?;
    let location = hosted::location_submenu(app, "tray_location_menu")?;
    hosted::register_menu(app, location.clone());
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open Codekin", true, None::<&str>)?,
            &location,
            &PredefinedMenuItem::separator(app)?,
            &keep_awake,
            &keep_awake_note,
            &login,
            &PredefinedMenuItem::separator(app)?,
            &restart,
            &MenuItem::with_id(app, "show_logs", "Show Logs", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit Codekin", true, None::<&str>)?,
        ],
    )?;
    let icon = Image::from_bytes(include_bytes!("../icons/tray@2x.png"))?;
    TrayIconBuilder::with_id("codekin")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Codekin")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)?;
    Ok(BackgroundState {
        prefs_file: PathBuf::new(),
        prefs: Mutex::new(prefs.clone()),
        keep_awake: KeepAwake::default(),
        tray_restart: restart,
        tray_keep_awake: keep_awake,
        tray_login: login,
    })
}

fn toggle_keep_awake(app: &AppHandle) {
    let bg = app.state::<BackgroundState>();
    let wanted = bg.tray_keep_awake.is_checked().unwrap_or(false);
    let held = bg.keep_awake.set(wanted);
    let _ = bg.tray_keep_awake.set_checked(held);
    let mut prefs = bg.prefs.lock().unwrap();
    prefs.keep_awake = held;
    let _ = prefs.save(&bg.prefs_file);
}

fn toggle_open_at_login(app: &AppHandle) {
    let bg = app.state::<BackgroundState>();
    let autolaunch = app.autolaunch();
    let wanted = bg.tray_login.is_checked().unwrap_or(false);
    let _ = if wanted {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    // Show what the OS actually has, whether or not the change worked.
    let _ = bg
        .tray_login
        .set_checked(autolaunch.is_enabled().unwrap_or(false));
}

/// Restart Server is available only for an owned server, Keep Mac Awake only
/// once the server has been started.
fn update_menu(app: &AppHandle) {
    let owned = matches!(
        app.state::<AppState>().shared.connection(),
        Connection::Owned { .. }
    );
    if let Some(bg) = app.try_state::<BackgroundState>() {
        let _ = bg.tray_restart.set_enabled(owned);
        let _ = bg
            .tray_keep_awake
            .set_enabled(background::keep_awake_supported() && local_server_started(app));
    }
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
    if hosted::on_menu(app, id) {
        return;
    }
    match id {
        "quit" => request_quit(app),
        "open" => show_main(app),
        "keep_awake" => toggle_keep_awake(app),
        "open_at_login" => toggle_open_at_login(app),
        "check_updates" => updater::check_now(app),
        "welcome" => welcome::open(app),
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

/// Offer to move a bundle running outside an Applications folder. Returns
/// true when the app moved and is relaunching from the new location (the
/// caller must not start a server). Release builds on macOS only; set
/// CODEKIN_SKIP_MOVE_CHECK=1 to skip (CI launches the build output directly).
fn offer_move_to_applications(app: &AppHandle) -> bool {
    if !cfg!(target_os = "macos")
        || cfg!(debug_assertions)
        || std::env::var_os("CODEKIN_SKIP_MOVE_CHECK").is_some()
    {
        return false;
    }
    let (Ok(exe), Ok(home)) = (std::env::current_exe(), app.path().home_dir()) else {
        return false;
    };
    let Some(bundle) = relocate::bundle_of(&exe) else {
        return false;
    };
    if !relocate::should_offer_move(&bundle, &home) {
        return false;
    }
    let translocated = bundle.to_string_lossy().contains("/AppTranslocation/");
    let move_it = app
        .dialog()
        .message(if translocated {
            "Codekin is running from a temporary read-only location. Move it to your Applications folder so updates and agent tools keep working?"
        } else {
            "Move Codekin to your Applications folder? Updates and agent tools work best from there."
        })
        .title("Move to Applications")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Move to Applications".into(), "Not Now".into()))
        .blocking_show();
    if !move_it {
        return false;
    }
    match relocate::copy_to_applications(&bundle, &home) {
        Ok(dest) => {
            if std::process::Command::new("/usr/bin/open")
                .arg("-n")
                .arg(&dest)
                .status()
                .is_ok_and(|s| s.success())
            {
                app.state::<AppState>()
                    .exit_ready
                    .store(true, Ordering::SeqCst);
                app.exit(0);
                return true;
            }
            false
        }
        Err(text) => {
            app.dialog()
                .message(format!(
                    "{text} Codekin keeps running from its current location."
                ))
                .title("Couldn't move Codekin")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::Ok)
                .blocking_show();
            false
        }
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
        // With its deep-link feature it also forwards `codekin://` links that
        // reach a second instance (Linux / Windows) to the deep-link plugin.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // A LaunchAgent, not an AppleScript login item: no Automation permission prompt.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            retry,
            show_logs,
            quit,
            hosted::locations_list,
            hosted::location_add,
            hosted::location_rename,
            hosted::location_remove,
            hosted::location_switch,
            hosted::location_sign_in,
            hosted::location_sign_in_reopen,
            hosted::location_sign_in_cancel,
            welcome::welcome_local,
            welcome::welcome_web,
            welcome::welcome_open_remote_access,
            welcome::welcome_close,
        ])
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
                app.manage(hosted::HostedState::default());
                if let Some(menu) = handle
                    .menu()
                    .and_then(|m| m.get("location_menu"))
                    .and_then(|i| i.as_submenu().cloned())
                {
                    hosted::register_menu(&handle, menu);
                }

                // Menu bar icon and the shell's preferences (Keep Mac awake survives restarts).
                let prefs_file = handle.path().app_config_dir()?.join("prefs.json");
                let existing = handle
                    .path()
                    .home_dir()
                    .is_ok_and(|home| background::is_existing_install(&prefs_file, &home));
                let mut prefs = Prefs::load(&prefs_file);
                let plan = prefs.launch_plan(existing);
                if prefs.start_mode.is_none() && plan == Launch::Local {
                    // An install from before the welcome screen: it was local all along.
                    prefs.start_mode = Some(background::StartMode::Local);
                    let _ = prefs.save(&prefs_file);
                }
                let mut bg = build_tray(&handle, &prefs)?;
                bg.prefs_file = prefs_file;
                app.manage(bg);

                let payload = payload_dir(&handle);
                let spec = launcher::LaunchSpec {
                    node: sidecar_node(),
                    cli: payload.join("bin").join("codekin.mjs"),
                    log,
                    env: secret_helper_env(),
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
                let relocation_done = Arc::new((Mutex::new(false), Condvar::new()));
                app.manage(LocalServer {
                    run: Mutex::new(Some(Box::new(move || supervisor.run()))),
                    started: AtomicBool::new(false),
                    relocation_done: relocation_done.clone(),
                });

                // Once per launch, whichever way the app is used. If the app
                // moves it relaunches from Applications, and nothing here starts.
                let relocate_app = handle.clone();
                std::thread::Builder::new()
                    .name("relocate".into())
                    .spawn(move || {
                        if offer_move_to_applications(&relocate_app) {
                            return;
                        }
                        let (done, cv) = &*relocation_done;
                        *done.lock().unwrap() = true;
                        cv.notify_all();
                    })?;

                // First run asks; local starts the server; web opens the
                // location and leaves the server for when This Mac is chosen.
                match plan {
                    Launch::Welcome => welcome::open(&handle),
                    Launch::Local => ensure_local_server(&handle),
                    Launch::Web(_) => {}
                }
                // Hosted locations: reopen the last one, and take the relay's
                // sign-in hand-back, whether it launched the app or arrived later.
                hosted::restore(&handle, plan == Launch::Welcome);
                update_menu(&handle);
                {
                    use tauri_plugin_deep_link::DeepLinkExt;
                    let links = handle.clone();
                    handle.deep_link().on_open_url(move |event| {
                        for url in event.urls() {
                            hosted::handle_deep_link(&links, &url);
                        }
                    });
                    if let Ok(Some(urls)) = handle.deep_link().get_current() {
                        for url in urls {
                            hosted::handle_deep_link(&handle, &url);
                        }
                    }
                }
                updater::schedule(&handle);
                Ok(())
            }
        })
        .on_window_event(|window, event| {
            // Closing the window (or Cmd-W) hides it: the server and phone sessions keep running.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN || hosted::is_location_window(window.label()) {
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

/// Point the bundled server at this executable as its Keychain helper
/// (src/secrets.rs), so the relay machine secret never sits in a file.
/// macOS only: elsewhere the server keeps the 0600 file.
fn secret_helper_env() -> Vec<(String, String)> {
    if !cfg!(target_os = "macos") {
        return vec![];
    }
    match std::env::current_exe() {
        Ok(exe) => vec![(
            "CODEKIN_SECRET_HELPER".to_string(),
            exe.to_string_lossy().into_owned(),
        )],
        Err(_) => vec![],
    }
}
