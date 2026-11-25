//! Files the page saves (Canvas "Download", recovery codes) go to the
//! Downloads folder.
//!
//! Without a download handler, the web view cancels every download, so a
//! click on a `<a download>` link did nothing. Only files the page made itself
//! (`blob:` and `data:` URLs) are saved; a link to a file on a server still
//! does nothing. The file keeps the name the page gave it, with " (1)", " (2)"…
//! added when one by that name is already there (wry picks the path).

use tauri::webview::DownloadEvent;
use tauri::{Runtime, Webview};

/// Whether a download from `url` may be saved.
pub fn download_allowed(url: &url::Url) -> bool {
    matches!(url.scheme(), "blob" | "data")
}

/// The `on_download` handler for every window that shows the web app.
pub fn on_download<R: Runtime>(_webview: Webview<R>, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, .. } => download_allowed(&url),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(s: &str) -> bool {
        download_allowed(&url::Url::parse(s).unwrap())
    }

    #[test]
    fn saves_files_the_page_made() {
        assert!(allowed(
            "blob:https://app.example.com/0b6c7f4e-1d1a-4f0e-9c1e-5b7d1c2a3e4f"
        ));
        assert!(allowed(
            "blob:http://127.0.0.1:32352/0b6c7f4e-1d1a-4f0e-9c1e-5b7d1c2a3e4f"
        ));
        assert!(allowed("data:text/csv;base64,YSxiCg=="));
    }

    #[test]
    fn refuses_files_from_servers() {
        assert!(!allowed("https://example.com/file.zip"));
        assert!(!allowed("http://127.0.0.1:32352/api/file"));
        assert!(!allowed("file:///etc/passwd"));
    }
}
