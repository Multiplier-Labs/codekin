//! Hosted locations in the app window (desktop plan, Phase 4b).
//!
//! "This Mac" is the `main` window, which the supervisor keeps driving. A
//! hosted location gets its own window (a webview's data store is fixed when
//! it's created, D11), shown in place of `main` with the same frame; at most
//! one exists at a time (D10). Sign-in goes through the default browser and
//! comes back as a `codekin://auth` deep link (D9). Location windows load a
//! remote origin and get no IPC; only the bundled pages in them can call the
//! commands below.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::{CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::locations::{self, Handoff, Location, SchemeRequest};
use crate::{local_page, open_external, BackgroundState, MAIN};

pub(crate) const LOCATION_PREFIX: &str = "location-";
const MANAGER: &str = "locations";

static NEXT_LABEL: AtomicU32 = AtomicU32::new(1);

/// Which location is on screen and the sign-in in progress.
#[derive(Default)]
pub(crate) struct HostedState {
    /// The selected hosted location; `None` is This Mac.
    current: Mutex<Option<String>>,
    /// Label of the current location window (labels aren't reused: a
    /// destroyed window's label may not be free yet).
    window: Mutex<Option<String>>,
    pending: Mutex<Option<Handoff>>,
    /// The Location submenus of the app menu and the menu bar icon.
    menus: Mutex<Vec<Submenu<Wry>>>,
}

fn state(app: &AppHandle) -> tauri::State<'_, HostedState> {
    app.state::<HostedState>()
}

fn prefs_location(app: &AppHandle, id: &str) -> Option<Location> {
    let bg = app.state::<BackgroundState>();
    let prefs = bg.prefs.lock().unwrap();
    prefs.location(id).cloned()
}

fn current_location(app: &AppHandle) -> Option<Location> {
    let id = state(app).current.lock().unwrap().clone()?;
    prefs_location(app, &id)
}

fn location_window(app: &AppHandle) -> Option<WebviewWindow> {
    let label = state(app).window.lock().unwrap().clone()?;
    app.get_webview_window(&label)
}

/// The window the user is looking at: the location's, else This Mac's.
pub(crate) fn current_window(app: &AppHandle) -> Option<WebviewWindow> {
    location_window(app).or_else(|| app.get_webview_window(MAIN))
}

pub(crate) fn is_location_window(label: &str) -> bool {
    label.starts_with(LOCATION_PREFIX)
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

pub(crate) fn location_submenu(app: &AppHandle, id: &str) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_id(app, id, "Location", true)
}

/// Register a Location submenu to keep filled.
pub(crate) fn register_menu(app: &AppHandle, menu: Submenu<Wry>) {
    state(app).menus.lock().unwrap().push(menu);
}

pub(crate) fn refresh_menus(app: &AppHandle) {
    let current = state(app).current.lock().unwrap().clone();
    let locations = app
        .state::<BackgroundState>()
        .prefs
        .lock()
        .unwrap()
        .locations
        .clone();
    let menus = state(app).menus.lock().unwrap().clone();
    for menu in menus {
        let _ = fill_menu(app, &menu, &locations, current.as_deref());
    }
}

fn fill_menu(
    app: &AppHandle,
    menu: &Submenu<Wry>,
    locations: &[Location],
    current: Option<&str>,
) -> tauri::Result<()> {
    for item in menu.items()? {
        menu.remove(&item)?;
    }
    menu.append(&CheckMenuItem::with_id(
        app,
        "loc:this-mac",
        "This Mac",
        true,
        current.is_none(),
        None::<&str>,
    )?)?;
    for l in locations {
        menu.append(&CheckMenuItem::with_id(
            app,
            format!("loc:{}", l.id),
            &l.name,
            true,
            current == Some(l.id.as_str()),
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "loc_add",
        "Add Location…",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "loc_manage",
        "Manage Locations…",
        true,
        None::<&str>,
    )?)?;
    Ok(())
}

/// Menu events of the Location submenus. Returns false for other ids.
pub(crate) fn on_menu(app: &AppHandle, id: &str) -> bool {
    match id {
        "loc_add" => open_manager(app, "add"),
        "loc_manage" => open_manager(app, "manage"),
        _ => match id.strip_prefix("loc:") {
            Some("this-mac") => switch_to(app, None),
            Some(loc) => switch_to(app, Some(loc.to_string())),
            None => return false,
        },
    }
    true
}

// ---------------------------------------------------------------------------
// Switching
// ---------------------------------------------------------------------------

/// The frame of a window in logical units: (x, y, width, height).
fn frame(w: &WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let scale = w.scale_factor().ok()?;
    let pos = w.outer_position().ok()?.to_logical::<f64>(scale);
    let size = w.inner_size().ok()?.to_logical::<f64>(scale);
    Some((pos.x, pos.y, size.width, size.height))
}

fn save_last_location(app: &AppHandle, id: Option<String>) {
    let bg = app.state::<BackgroundState>();
    let mut prefs = bg.prefs.lock().unwrap();
    prefs.last_location = id;
    let _ = prefs.save(&bg.prefs_file);
}

/// Show `target` (`None` = This Mac). Runs on the main thread.
pub(crate) fn switch_to(app: &AppHandle, target: Option<String>) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || switch_now(&app2, target));
}

fn switch_now(app: &AppHandle, target: Option<String>) {
    let previous = current_window(app);
    let geometry = previous.as_ref().and_then(frame);
    let visible = previous
        .as_ref()
        .is_none_or(|w| w.is_visible().unwrap_or(true));
    let st = state(app);
    match target.and_then(|id| prefs_location(app, &id)) {
        None => {
            *st.current.lock().unwrap() = None;
            *st.pending.lock().unwrap() = None;
            if let Some(main) = app.get_webview_window(MAIN) {
                if location_window(app).is_some() {
                    if let Some((x, y, w, h)) = geometry {
                        let _ = main.set_position(tauri::LogicalPosition::new(x, y));
                        let _ = main.set_size(tauri::LogicalSize::new(w, h));
                    }
                }
                if visible {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
            close_location_window(app);
            save_last_location(app, None);
        }
        Some(location) => {
            let same = st.current.lock().unwrap().as_deref() == Some(location.id.as_str());
            if same {
                if let Some(w) = location_window(app) {
                    let _ = w.show();
                    let _ = w.set_focus();
                    return;
                }
            }
            close_location_window(app);
            *st.pending.lock().unwrap() = None;
            match build_location_window(app, &location, geometry, visible) {
                Ok(w) => {
                    *st.window.lock().unwrap() = Some(w.label().to_string());
                    *st.current.lock().unwrap() = Some(location.id.clone());
                    if let Some(main) = app.get_webview_window(MAIN) {
                        let _ = main.hide();
                    }
                    save_last_location(app, Some(location.id));
                }
                Err(_) => {
                    // Stay on (or fall back to) This Mac.
                    *st.current.lock().unwrap() = None;
                    if let Some(main) = app.get_webview_window(MAIN) {
                        let _ = main.show();
                    }
                }
            }
        }
    }
    refresh_menus(app);
}

fn close_location_window(app: &AppHandle) {
    let label = state(app).window.lock().unwrap().take();
    if let Some(w) = label.and_then(|l| app.get_webview_window(&l)) {
        // destroy(), not close(): closing a location window only hides it.
        let _ = w.destroy();
    }
}

fn webview_builder<'a>(
    app: &'a AppHandle,
    label: &str,
    location: &Location,
) -> tauri::Result<WebviewWindowBuilder<'a, Wry, AppHandle>> {
    let start = url::Url::parse(&format!("{}/", location.url)).map_err(tauri::Error::InvalidUrl)?;
    let version = app.package_info().version.to_string();
    Ok(
        WebviewWindowBuilder::new(app, label, WebviewUrl::External(start))
            .user_agent(&locations::user_agent(&version))
            // Its own cookies and storage, never shared with other relays or This Mac.
            .data_store_identifier(locations::data_store_id(&location.id)),
    )
}

fn build_location_window(
    app: &AppHandle,
    location: &Location,
    geometry: Option<(f64, f64, f64, f64)>,
    visible: bool,
) -> tauri::Result<WebviewWindow> {
    let label = format!(
        "{LOCATION_PREFIX}{}",
        NEXT_LABEL.fetch_add(1, Ordering::SeqCst)
    );
    let origin = location.url.clone();
    let nav_app = app.clone();
    let new_window_app = app.clone();
    let mut builder = webview_builder(app, &label, location)?
        .title(format!("Codekin — {}", location.name))
        .min_inner_size(640.0, 480.0)
        .visible(visible)
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if url.scheme() == locations::SCHEME {
                // Act after the navigation is refused, not inside the callback.
                let app = nav_app.clone();
                let url = url.clone();
                let _ = nav_app.run_on_main_thread(move || handle_page_request(&app, &url));
                return false;
            }
            if locations::location_navigation_allowed(url, &origin) {
                return true;
            }
            open_external(&nav_app, url);
            false
        })
        .on_new_window(move |url, _features| {
            open_external(&new_window_app, &url);
            NewWindowResponse::Deny
        });
    builder = match geometry {
        Some((x, y, w, h)) => builder.position(x, y).inner_size(w, h),
        None => builder.inner_size(1400.0, 900.0),
    };
    let w = builder.build()?;
    if visible {
        let _ = w.set_focus();
    }
    Ok(w)
}

/// Last-used location at launch. Call after the menus are registered.
pub(crate) fn restore(app: &AppHandle) {
    let last = app
        .state::<BackgroundState>()
        .prefs
        .lock()
        .unwrap()
        .last_location
        .clone();
    match last {
        Some(id) if prefs_location(app, &id).is_some() => switch_to(app, Some(id)),
        _ => {
            if let Some(main) = app.get_webview_window(MAIN) {
                let _ = main.show();
            }
            refresh_menus(app);
        }
    }
}

// ---------------------------------------------------------------------------
// Sign-in handoff (D9)
// ---------------------------------------------------------------------------

/// A `codekin:` navigation from the hosted page in a location window.
fn handle_page_request(app: &AppHandle, url: &url::Url) {
    match locations::classify(url) {
        SchemeRequest::SignIn => show_sign_in_page(app, None),
        SchemeRequest::StepUp => start_handoff(app),
        SchemeRequest::Auth => complete_handoff(app, url),
        SchemeRequest::Other => {}
    }
}

/// A deep link delivered by the OS (the relay's hand-back). Only `auth` is
/// acted on: an outside page can't start a browser sign-in by itself.
pub(crate) fn handle_deep_link(app: &AppHandle, url: &url::Url) {
    if locations::classify(url) == SchemeRequest::Auth {
        complete_handoff(app, url);
    } else if let Some(w) = current_window(app) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn navigate_location(app: &AppHandle, url: url::Url) {
    if let Some(w) = location_window(app) {
        let _ = w.navigate(url);
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn page(view: &str, pairs: &[(&str, &str)]) -> url::Url {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    q.append_pair("view", view);
    for (k, v) in pairs {
        q.append_pair(k, v);
    }
    local_page(&q.finish())
}

fn show_sign_in_page(app: &AppHandle, error: Option<&str>) {
    let Some(location) = current_location(app) else {
        return;
    };
    let mut pairs = vec![
        ("name", location.name.as_str()),
        ("origin", location.url.as_str()),
    ];
    if let Some(e) = error {
        pairs.push(("error", e));
    }
    navigate_location(app, page("signin", &pairs));
}

fn start_handoff(app: &AppHandle) {
    let Some(location) = current_location(app) else {
        return;
    };
    let handoff = Handoff::new(&location);
    let start = handoff.start_url();
    *state(app).pending.lock().unwrap() = Some(handoff);
    let _ = app.opener().open_url(start, None::<&str>);
    navigate_location(
        app,
        page(
            "waiting",
            &[
                ("name", location.name.as_str()),
                ("origin", location.url.as_str()),
            ],
        ),
    );
}

fn complete_handoff(app: &AppHandle, url: &url::Url) {
    let result = {
        let st = state(app);
        let mut pending = st.pending.lock().unwrap();
        locations::accept_callback(&mut pending, url, Instant::now())
    };
    match result {
        Ok(claim) => {
            let on_screen = state(app).current.lock().unwrap().clone();
            if on_screen.as_deref() != Some(claim.location_id.as_str()) {
                // Signed in from the browser while another location was shown.
                switch_now(app, Some(claim.location_id.clone()));
            }
            let action = claim.action();
            navigate_location(
                app,
                page(
                    "claim",
                    &[
                        ("action", action.as_str()),
                        ("code", claim.code.as_str()),
                        ("code_verifier", claim.verifier.as_str()),
                    ],
                ),
            );
        }
        Err(locations::CallbackError::Expired) => {
            show_sign_in_page(app, Some("That sign-in took too long. Try again."))
        }
        // A stale, forged or repeated link: nothing to do but show the app.
        Err(_) => {
            if let Some(w) = current_window(app) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Location manager window and removal
// ---------------------------------------------------------------------------

fn open_manager(app: &AppHandle, mode: &str) {
    let url = page("locations", &[("mode", mode)]);
    if let Some(w) = app.get_webview_window(MANAGER) {
        let _ = w.navigate(url);
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let path = format!("index.html?{}", url.query().unwrap_or_default());
    let opener = app.clone();
    let _ = WebviewWindowBuilder::new(app, MANAGER, WebviewUrl::App(path.into()))
        .title("Locations")
        .inner_size(560.0, 520.0)
        .min_inner_size(420.0, 360.0)
        .on_navigation(move |url| {
            let local = url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost");
            if !local {
                open_external(&opener, url);
            }
            local
        })
        .build();
}

/// Sign the location out on the relay and delete its data store. The relay
/// call runs in a hidden window on that store, so it also works on macOS
/// 12–13, where every location shares the default store.
fn forget(app: &AppHandle, location: Location) {
    let label = format!("signout-{}", NEXT_LABEL.fetch_add(1, Ordering::SeqCst));
    let built = webview_builder(app, &label, &location).and_then(|b| {
        b.visible(false)
            .on_navigation(|url| url.scheme() == "https" || url.scheme() == "http")
            .on_page_load(|w, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = w.eval(
                        "fetch('/api/auth/logout',{method:'POST',credentials:'include'}).catch(function(){})",
                    );
                }
            })
            .build()
    });
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        if let Ok(w) = built {
            let _ = w.destroy();
        }
        #[cfg(target_vendor = "apple")]
        {
            std::thread::sleep(Duration::from_secs(1));
            let id = locations::data_store_id(&location.id);
            tauri::async_runtime::spawn(async move {
                let _ = app.remove_data_store(id).await;
            });
        }
        #[cfg(not(target_vendor = "apple"))]
        let _ = (app, location);
    });
}

// ---------------------------------------------------------------------------
// Commands (bundled pages only)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocationList {
    locations: Vec<Location>,
    current: Option<String>,
}

#[tauri::command]
pub(crate) fn locations_list(app: AppHandle) -> LocationList {
    LocationList {
        locations: app
            .state::<BackgroundState>()
            .prefs
            .lock()
            .unwrap()
            .locations
            .clone(),
        current: state(&app).current.lock().unwrap().clone(),
    }
}

#[tauri::command]
pub(crate) async fn location_add(
    app: AppHandle,
    name: Option<String>,
    url: String,
) -> Result<Location, String> {
    let origin = locations::normalize_origin(&url).map_err(str::to_string)?;
    {
        let bg = app.state::<BackgroundState>();
        let prefs = bg.prefs.lock().unwrap();
        if let Some(existing) = prefs.locations.iter().find(|l| l.url == origin) {
            return Err(format!("{origin} is already saved as “{}”.", existing.name));
        }
    }
    let probe = origin.clone();
    let relay_name = tauri::async_runtime::spawn_blocking(move || {
        crate::http::relay_info(&probe, Duration::from_secs(10))
    })
    .await
    .map_err(|e| e.to_string())??;
    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| locations::default_name(&origin, &relay_name));
    let location = Location {
        id: locations::new_location_id(),
        name,
        url: origin,
    };
    {
        let bg = app.state::<BackgroundState>();
        let mut prefs = bg.prefs.lock().unwrap();
        prefs.locations.push(location.clone());
        prefs.save(&bg.prefs_file).map_err(|e| e.to_string())?;
    }
    switch_to(&app, Some(location.id.clone()));
    Ok(location)
}

#[tauri::command]
pub(crate) fn location_rename(app: AppHandle, id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Enter a name.".into());
    }
    {
        let bg = app.state::<BackgroundState>();
        let mut prefs = bg.prefs.lock().unwrap();
        let location = prefs
            .locations
            .iter_mut()
            .find(|l| l.id == id)
            .ok_or("That location no longer exists.")?;
        location.name = name.clone();
        prefs.save(&bg.prefs_file).map_err(|e| e.to_string())?;
    }
    if let Some(w) = location_window(&app) {
        if state(&app).current.lock().unwrap().as_deref() == Some(id.as_str()) {
            let _ = w.set_title(&format!("Codekin — {name}"));
        }
    }
    refresh_menus(&app);
    Ok(())
}

#[tauri::command]
pub(crate) fn location_remove(app: AppHandle, id: String) -> Result<(), String> {
    let removed = {
        let bg = app.state::<BackgroundState>();
        let mut prefs = bg.prefs.lock().unwrap();
        let Some(i) = prefs.locations.iter().position(|l| l.id == id) else {
            return Ok(());
        };
        let removed = prefs.locations.remove(i);
        if prefs.last_location.as_deref() == Some(id.as_str()) {
            prefs.last_location = None;
        }
        prefs.save(&bg.prefs_file).map_err(|e| e.to_string())?;
        removed
    };
    let was_current = state(&app).current.lock().unwrap().as_deref() == Some(id.as_str());
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if was_current {
            switch_now(&app2, None);
        } else {
            refresh_menus(&app2);
        }
        forget(&app2, removed);
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn location_switch(app: AppHandle, id: Option<String>) {
    switch_to(&app, id);
}

#[tauri::command]
pub(crate) fn location_sign_in(app: AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || start_handoff(&a));
}

/// "Open browser again": the same sign-in, so a link already on its way still counts.
#[tauri::command]
pub(crate) fn location_sign_in_reopen(app: AppHandle) {
    let start = state(&app)
        .pending
        .lock()
        .unwrap()
        .as_ref()
        .map(Handoff::start_url);
    match start {
        Some(url) => {
            let _ = app.opener().open_url(url, None::<&str>);
        }
        None => location_sign_in(app),
    }
}

#[tauri::command]
pub(crate) fn location_sign_in_cancel(app: AppHandle) {
    *state(&app).pending.lock().unwrap() = None;
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(location) = current_location(&a) {
            if let Ok(u) = url::Url::parse(&format!("{}/", location.url)) {
                navigate_location(&a, u);
            }
        }
    });
}
