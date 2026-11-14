/**
 * Messages between Canvas and a live preview (docs/CANVAS-SPEC.md §8).
 *
 * The preview proxy adds a small script to every page of the previewed app
 * (server/preview-proxy.ts). It says `ready`; Canvas answers `hello` from
 * its origin, and from then on the script reports the page's location,
 * console errors and picked elements, and takes pick/history/reload
 * requests. Everything it sends is the app's (and so possibly an agent's)
 * text: parsed defensively here, shown as text, never run.
 */

export type FromPreview =
  | { type: 'codekin-preview:ready' }
  | { type: 'codekin-preview:location'; path: string; title: string }
  | { type: 'codekin-preview:console'; level: 'error' | 'warn'; message: string; path: string }
  | { type: 'codekin-preview:picked'; picked: PickedElement }
  | { type: 'codekin-preview:pick-ended' }

export type ToPreview =
  | { type: 'codekin-preview:hello' }
  | { type: 'codekin-preview:pick'; on: boolean }
  | { type: 'codekin-preview:history'; go: -1 | 1 }
  | { type: 'codekin-preview:reload' }

export interface PickedElement {
  selector: string
  tag: string
  label: string
  text: string
  html: string
  rect: { x: number; y: number; width: number; height: number }
  path: string
  component?: { name?: string; source?: string }
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? (v.length > max ? `${v.slice(0, max)}…` : v) : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0)

/** A message from the preview frame, checked and clipped; null when it isn't one. */
export function parseFromPreview(data: unknown): FromPreview | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  switch (d.type) {
    case 'codekin-preview:ready': return { type: d.type }
    case 'codekin-preview:pick-ended': return { type: d.type }
    case 'codekin-preview:location': return { type: d.type, path: str(d.path, 2000) || '/', title: str(d.title, 300) }
    case 'codekin-preview:console':
      return { type: d.type, level: d.level === 'warn' ? 'warn' : 'error', message: str(d.message, 4000), path: str(d.path, 2000) }
    case 'codekin-preview:picked': {
      const rect = (typeof d.rect === 'object' && d.rect ? d.rect : {}) as Record<string, unknown>
      const comp = (typeof d.component === 'object' && d.component ? d.component : null) as Record<string, unknown> | null
      const component = comp && (str(comp.name, 200) || str(comp.source, 500))
        ? { ...(str(comp.name, 200) ? { name: str(comp.name, 200) } : {}), ...(str(comp.source, 500) ? { source: str(comp.source, 500) } : {}) }
        : undefined
      return {
        type: d.type,
        picked: {
          selector: str(d.selector, 1000), tag: str(d.tag, 50), label: str(d.label, 200), text: str(d.text, 300), html: str(d.html, 3000),
          rect: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
          path: str(d.path, 2000) || '/',
          ...(component ? { component } : {}),
        },
      }
    }
    default: return null
  }
}

/** The proxy's origin: the host the browser reaches Codekin by, on the preview's port. */
export function previewOrigin(proxyPort: number, location: { hostname: string }): string {
  const host = location.hostname.includes(':') && !location.hostname.startsWith('[') ? `[${location.hostname}]` : location.hostname
  return `http://${host}:${proxyPort}`
}

/** The entry URL (it admits the frame) opening `path` instead of the item's own. */
export function entryUrl(origin: string, entry: string, path?: string): string {
  const u = new URL(entry, origin)
  if (path) u.searchParams.set('to', path.startsWith('/') && !path.startsWith('//') ? path : `/${path.replace(/^\/+/, '')}`)
  return u.toString()
}

/** What the agent receives for a picked element, and the chip's label. */
export function pickedContext(p: PickedElement, port: number): { label: string; excerpt: string } {
  const lines = [
    `Element picked in the live preview (localhost:${port}${p.path}):`,
    `selector: ${p.selector}`,
    ...(p.component?.name || p.component?.source ? [`component: ${[p.component.name, p.component.source && `(${p.component.source})`].filter(Boolean).join(' ')}`] : []),
    ...(p.text ? [`text: ${p.text}`] : []),
    `size: ${p.rect.width}×${p.rect.height} at ${p.rect.x},${p.rect.y}`,
    'markup:',
    p.html,
  ]
  const name = p.component?.name ? `<${p.component.name}>` : p.label || p.tag
  const label = p.text ? `${name} “${p.text.length > 24 ? `${p.text.slice(0, 24)}…` : p.text}”` : name
  return { label, excerpt: lines.join('\n') }
}

export interface ConsoleEntry { level: 'error' | 'warn'; message: string; path: string; at: number }

/** Console errors (warnings left out unless there are no errors) as context for the agent. */
export function consoleContext(entries: ConsoleEntry[], port: number): { label: string; excerpt: string } {
  const errors = entries.filter(e => e.level === 'error')
  const chosen = (errors.length ? errors : entries).slice(-20)
  const what = errors.length ? 'error' : 'warning'
  return {
    label: `${chosen.length} console ${what}${chosen.length === 1 ? '' : 's'}`,
    excerpt: [`Browser console ${what}s from the live preview (localhost:${port}):`, ...chosen.map(e => `[${e.level} on ${e.path || '/'}] ${e.message}`)].join('\n\n'),
  }
}

/** The last lines of the dev server's output as context for the agent. */
export function serverLogContext(lines: string[], name: string): { label: string; excerpt: string } {
  const tail = lines.slice(-80)
  return { label: `${name} output (${tail.length} lines)`, excerpt: [`Dev server output (${name}), last ${tail.length} lines:`, ...tail].join('\n') }
}
