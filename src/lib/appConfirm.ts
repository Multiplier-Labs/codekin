/**
 * Helpers for confirming what an MCP App asks to do (AppConfirmDialog).
 */

/** How long the approve button ignores clicks and keys after a request appears. */
export const ARM_MS = 600

/** Control, zero-width and direction-override characters: never shown. */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** What is shown: the text without characters that hide or reorder it. */
export function visibleText(text: string): string {
  return text.replace(HIDDEN, '')
}

/** A link's host as the browser will resolve it, or null when it isn't an http(s) URL. */
export function linkHost(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : null
  } catch {
    return null
  }
}
