//! First-run choice (desktop plan, "First-run choice"): run agents on this
//! Mac, or use Codekin on the web. Shown on first launch before anything
//! starts, and again from Codekin → Welcome…. The window holds a bundled page
//! only, so it may call the commands below.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::background::StartMode;
use crate::{hosted, locations, open_external, AppState, BackgroundState, MAIN};

const WELCOME: &str = "welcome";

/// The first-run question hasn't been answered yet.
pub(crate) fn needed(app: &AppHandle) -> bool {
    app.try_state::<BackgroundState>()
        .is_some_and(|bg| bg.prefs.lock().unwrap().start_mode.is_none())
}

pub(crate) fn open(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WELCOME) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let opener = app.clone();
    let _ = WebviewWindowBuilder::new(
        app,
        WELCOME,
        WebviewUrl::App("index.html?view=welcome".into()),
    )
    .title("Welcome to Codekin")
    .inner_size(560.0, 560.0)
    .min_inner_size(440.0, 440.0)
    .on_navigation(move |url| {
        let local = url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost");
        if !local {
            open_external(&opener, url);
        }
        local
    })
    .build();
}

fn close(app: &AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = a.get_webview_window(WELCOME) {
            let _ = w.close();
        }
    });
}

fn set_mode(app: &AppHandle, mode: StartMode) -> Result<(), String> {
    let bg = app.state::<BackgroundState>();
    let mut prefs = bg.prefs.lock().unwrap();
    prefs.start_mode = Some(mode);
    prefs.save(&bg.prefs_file).map_err(|e| e.to_string())
}

/// "Run agents on this Mac": start the server and show This Mac. The page
/// then offers remote access as an optional second step.
#[tauri::command]
pub(crate) fn welcome_local(app: AppHandle) -> Result<(), String> {
    set_mode(&app, StartMode::Local)?;
    hosted::open_this_mac(&app);
    Ok(())
}

/// "Connect to Codekin on the web": check and save the relay (or reuse it if
/// already saved), open it, and start the browser sign-in for a new one. The
/// local server is not started.
#[tauri::command]
pub(crate) async fn welcome_web(app: AppHandle, url: String) -> Result<(), String> {
    let origin = locations::normalize_origin(&url).map_err(str::to_string)?;
    let (location, new) = match hosted::saved_location_for(&app, &origin) {
        Some(existing) => (existing, false),
        None => (hosted::save_new_location(&app, None, origin).await?, true),
    };
    set_mode(&app, StartMode::Web)?;
    hosted::open_location(&app, location.id, new);
    close(&app);
    Ok(())
}

/// The optional second step: open Settings → Remote access in the local UI
/// once the server is up (the route is `/settings/remote`).
#[tauri::command]
pub(crate) fn welcome_open_remote_access(app: AppHandle) {
    close(&app);
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(60);
        while app
            .state::<AppState>()
            .shared
            .connection()
            .server()
            .is_none()
        {
            if Instant::now() > deadline {
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        // Give the UI a moment to load after the server answers.
        std::thread::sleep(Duration::from_secs(2));
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(main) = a.get_webview_window(MAIN) {
                let _ = main.eval(
                    "history.pushState(null,'','/settings/remote');window.dispatchEvent(new PopStateEvent('popstate'))",
                );
                let _ = main.show();
                let _ = main.set_focus();
            }
        });
    });
}

#[tauri::command]
pub(crate) fn welcome_close(app: AppHandle) {
    close(&app);
}
