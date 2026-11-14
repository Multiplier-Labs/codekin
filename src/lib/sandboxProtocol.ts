/**
 * Messages between Codekin and the Canvas sandbox page (docs/CANVAS-SPEC.md
 * §8). The sandbox runs on its own origin; Codekin posts content to render
 * and gets back status and the user's selections. Both sides treat what they
 * receive as untrusted data.
 */

export type SandboxKind = 'chart' | 'html'

export type ToSandbox =
  | { type: 'codekin-sandbox:render'; id: string; kind: SandboxKind; content: string; scheme: 'light' | 'dark' }

export type FromSandbox =
  | { type: 'codekin-sandbox:ready' }
  | { type: 'codekin-sandbox:rendered'; id: string }
  | { type: 'codekin-sandbox:error'; id: string; message: string }
  /** A chart selection (brush or points): a short label and what the agent should read. */
  | { type: 'codekin-sandbox:selection'; id: string; label: string; excerpt: string }
  | { type: 'codekin-sandbox:selection-cleared'; id: string }

const MAX_TEXT = 8000

/** Validate a message from the sandbox; anything unexpected is dropped. */
export function parseFromSandbox(data: unknown): FromSandbox | null {
  if (typeof data !== 'object' || data === null) return null
  const m = data as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : null)
  switch (m.type) {
    case 'codekin-sandbox:ready':
      return { type: m.type }
    case 'codekin-sandbox:rendered':
    case 'codekin-sandbox:selection-cleared': {
      const id = str(m.id)
      return id ? { type: m.type, id } : null
    }
    case 'codekin-sandbox:error': {
      const id = str(m.id)
      const message = str(m.message)
      return id && message !== null ? { type: m.type, id, message } : null
    }
    case 'codekin-sandbox:selection': {
      const id = str(m.id)
      const label = str(m.label)
      const excerpt = str(m.excerpt)
      return id && label && excerpt ? { type: m.type, id, label: label.slice(0, 120), excerpt } : null
    }
    default:
      return null
  }
}

/**
 * The CSP an HTML artifact runs under, on top of the sandbox page's own: no
 * network at all, so a page can only show what it carries inline.
 */
export const HTML_ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:"
