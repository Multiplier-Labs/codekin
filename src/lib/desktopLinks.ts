/**
 * Links in the desktop app open in the default browser.
 *
 * The app's web view doesn't open `target="_blank"` links (WebKit doesn't
 * ask for a new window when the link has `rel="noopener"`), so a click on a
 * link to another site did nothing. The app does see every navigation of the
 * page, and opens any to another origin in the default browser, cancelling
 * it (desktop/src-tauri: `on_navigation`). So in the desktop app, a click on
 * a cross-origin link becomes a navigation of the page itself, which the app
 * turns into "open in browser".
 */

/** The user-agent token the desktop app sets on its windows. */
const DESKTOP_UA_TOKEN = 'CodekinDesktop/'

export function isDesktopWebView(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return userAgent.includes(DESKTOP_UA_TOKEN)
}

/** The URL a click should hand to the desktop app, or null to leave the click alone. */
export function externalLinkTarget(event: Pick<MouseEvent, 'defaultPrevented' | 'button' | 'target'>, pageOrigin: string, baseUrl: string): string | null {
  if (event.defaultPrevented || event.button !== 0) return null
  const start = event.target as Element | null
  const anchor = typeof start?.closest === 'function' ? start.closest('a[href]') : null
  if (!anchor) return null
  const href = anchor.getAttribute('href')
  if (!href) return null
  let url: URL
  try { url = new URL(href, baseUrl) } catch { return null }
  if (url.protocol === 'mailto:') return url.href
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // Same-origin links are the app's own: leave them to it.
  return url.origin === pageOrigin ? null : url.href
}

/** In the desktop app, send clicks on links to other sites to the default browser. */
export function installDesktopLinkHandler(win: Window = window): void {
  if (!isDesktopWebView(win.navigator.userAgent)) return
  win.document.addEventListener('click', event => {
    const url = externalLinkTarget(event, win.location.origin, win.document.baseURI)
    if (!url) return
    event.preventDefault()
    // The app refuses this navigation and opens the URL in the default browser.
    win.location.assign(url)
  }, true)
}
