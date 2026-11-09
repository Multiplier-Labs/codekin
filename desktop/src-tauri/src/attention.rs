//! Sessions that need you, from the page's title (`useAttentionNotifications`
//! in the web app puts the count in front: `(2) Codekin`).
//!
//! The shell gives the page no new powers for this: it only reads the title
//! it can already see.
//! - The Dock badge shows the count of the window on screen.
//! - When that count goes up while Codekin isn't the app you're using, one
//!   macOS notification, without sound. A click brings Codekin forward.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

/// Last count seen per window label.
#[derive(Default)]
pub struct AttentionState {
    counts: Mutex<HashMap<String, u32>>,
}

/// The count at the front of a title, `(N) …`; 0 when there is none.
pub fn title_count(title: &str) -> u32 {
    let Some(rest) = title.strip_prefix('(') else {
        return 0;
    };
    let Some((digits, after)) = rest.split_once(')') else {
        return 0;
    };
    if !after.starts_with(' ') || digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return 0;
    }
    digits.parse().unwrap_or(0)
}

/// What to do for a new count: the badge to show, and whether to notify.
pub fn react(previous: u32, count: u32, app_focused: bool) -> (Option<i64>, bool) {
    let badge = (count > 0).then_some(i64::from(count));
    (badge, count > previous && !app_focused)
}

/// The notification text for `count` sessions waiting.
pub fn message(count: u32) -> (String, String) {
    if count == 1 {
        (
            "A session is waiting for you".into(),
            "Open Codekin to continue.".into(),
        )
    } else {
        (
            format!("{count} sessions are waiting for you"),
            "Open Codekin to see which.".into(),
        )
    }
}

/// Called from `on_document_title_changed` of every Codekin window.
pub fn on_title<R: Runtime>(window: &WebviewWindow<R>, title: &str) {
    let app: AppHandle<R> = window.app_handle().clone();
    let count = title_count(title);
    let previous = {
        let state = app.state::<AttentionState>();
        let mut counts = state.counts.lock().unwrap();
        counts
            .insert(window.label().to_string(), count)
            .unwrap_or(0)
    };
    // Only the window on screen speaks for the app (a hidden one may still run).
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let app_focused = app
        .webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false));
    let (badge, notify) = react(previous, count, app_focused);
    let _ = window.set_badge_count(badge);
    if notify {
        let (title, body) = message(count);
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_count_in_front_of_the_title() {
        assert_eq!(title_count("(2) Codekin"), 2);
        assert_eq!(title_count("(12) [STAGING] Codekin"), 12);
        assert_eq!(title_count("Codekin"), 0);
        assert_eq!(title_count("(beta) Codekin"), 0);
        assert_eq!(title_count("(3)Codekin"), 0);
        assert_eq!(title_count("()  Codekin"), 0);
    }

    #[test]
    fn badges_the_count_and_notifies_only_on_a_rise_while_elsewhere() {
        assert_eq!(react(0, 2, false), (Some(2), true));
        assert_eq!(react(0, 2, true), (Some(2), false));
        assert_eq!(react(2, 2, false), (Some(2), false));
        assert_eq!(react(3, 1, false), (Some(1), false));
        assert_eq!(react(1, 0, false), (None, false));
    }

    #[test]
    fn says_how_many() {
        assert_eq!(message(1).0, "A session is waiting for you");
        assert_eq!(message(3).0, "3 sessions are waiting for you");
    }
}
