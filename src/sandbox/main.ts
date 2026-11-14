/**
 * The Canvas sandbox page (docs/CANVAS-SPEC.md §8).
 *
 * Served on its own origin, never Codekin's, and framed by Codekin's Canvas.
 * It holds no credentials and does nothing until its parent posts content:
 *
 * - `chart`: a Vega-Lite spec, rendered with Vega's expression interpreter
 *   (no eval) and no actions menu. Brush and point selections are reported
 *   back so the user can ask the agent about them.
 * - `html`: a self-contained page, rendered in a nested frame with an opaque
 *   origin and a CSP that allows no network at all.
 */

import embed, { type Result } from 'vega-embed'
import { expressionInterpreter } from 'vega-interpreter'
import { HTML_ARTIFACT_CSP, type FromSandbox, type ToSandbox } from '../lib/sandboxProtocol'

const root = document.getElementById('root')!
let parentOrigin: string | null = null
let current: Result | null = null

function post(msg: FromSandbox) {
  // Before the first render we don't know the parent's origin; "ready" carries nothing.
  window.parent.postMessage(msg, msg.type === 'codekin-sandbox:ready' || !parentOrigin ? '*' : parentOrigin)
}

type Json = Record<string, unknown>

/** Names of Vega-Lite selection parameters anywhere in the spec. */
function selectionParams(spec: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(spec)) { spec.forEach(s => selectionParams(s, out)); return out }
  if (typeof spec !== 'object' || spec === null) return out
  const s = spec as Json
  if (Array.isArray(s.params)) {
    for (const p of s.params as Json[]) if (p.select && typeof p.name === 'string') out.add(p.name)
  }
  for (const key of ['layer', 'hconcat', 'vconcat', 'concat', 'spec']) if (s[key]) selectionParams(s[key], out)
  return out
}

const fmt = (v: unknown) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v))

/** Inline data rows matching a selection value ({ field: [min, max] } or { field: [values] }). */
function selectedRows(spec: Json, value: Json, interval: boolean): Json[] | null {
  const rows = (spec.data as { values?: unknown } | undefined)?.values
  if (!Array.isArray(rows)) return null
  const fields = Object.entries(value).filter(([, v]) => Array.isArray(v)) as Array<[string, unknown[]]>
  if (!fields.length) return null
  return (rows as Json[]).filter(row => fields.every(([f, v]) => {
    const x = row[f]
    if (interval && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && typeof x === 'number') {
      return x >= Math.min(v[0], v[1]) && x <= Math.max(v[0], v[1])
    }
    return v.some(w => String(w) === String(x))
  }))
}

async function renderChart(id: string, content: string, scheme: 'light' | 'dark') {
  let spec: Json
  try {
    spec = JSON.parse(content) as Json
  } catch {
    throw new Error('The chart spec is not valid JSON.')
  }
  if (typeof spec !== 'object' || Array.isArray(spec)) throw new Error('The chart spec must be a JSON object.')
  // Fill the frame unless the spec sizes itself.
  const sized: Json = { width: 'container', autosize: { type: 'fit', contains: 'padding' }, ...spec }
  const host = document.createElement('div')
  host.className = 'chart'
  root.replaceChildren(host)
  current?.finalize()
  current = await embed(host, sized as never, {
    actions: false,
    renderer: 'svg',
    ast: true,
    expr: expressionInterpreter,
    theme: scheme === 'dark' ? 'dark' : undefined,
    config: { background: 'transparent' },
  })
  const view = current.view
  for (const name of selectionParams(spec)) {
    view.addSignalListener(name, (_signal: string, value: unknown) => {
      const v = (typeof value === 'object' && value !== null ? value : {}) as Json
      const entries = Object.entries(v).filter(([k]) => !k.startsWith('vl') && !k.startsWith('_'))
      if (!entries.length) { post({ type: 'codekin-sandbox:selection-cleared', id }); return }
      const interval = entries.every(([, x]) => Array.isArray(x) && x.length === 2 && typeof x[0] === 'number')
      const rows = selectedRows(spec, Object.fromEntries(entries), interval)
      const label = interval
        ? entries.map(([f, x]) => `${f} ${fmt((x as unknown[])[0])}–${fmt((x as unknown[])[1])}`).join(', ')
        : `${rows?.length ?? entries.reduce((n, [, x]) => n + (Array.isArray(x) ? x.length : 1), 0)} selected`
      const rawTitle = typeof spec.title === 'string' ? spec.title : (spec.title as Json | undefined)?.text
      const title = typeof rawTitle === 'string' ? rawTitle : undefined
      const excerpt = [
        `Chart selection${title ? ` in "${title}"` : ''} (${name}): ${JSON.stringify(Object.fromEntries(entries))}`,
        rows ? `Selected data rows (${rows.length}):\n${JSON.stringify(rows.slice(0, 50), null, 1)}${rows.length > 50 ? '\n…' : ''}` : '',
      ].filter(Boolean).join('\n')
      post({ type: 'codekin-sandbox:selection', id, label, excerpt })
    })
  }
}

function renderHtml(content: string) {
  current?.finalize()
  current = null
  const frame = document.createElement('iframe')
  // Scripts only: an opaque origin, no forms, popups or navigation of Codekin.
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.title = 'HTML artifact'
  frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${HTML_ARTIFACT_CSP}">${content}`
  root.replaceChildren(frame)
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return
  const msg = event.data as ToSandbox | null
  if (msg?.type !== 'codekin-sandbox:render' || typeof msg.content !== 'string' || typeof msg.id !== 'string') return
  parentOrigin = event.origin
  document.documentElement.dataset.scheme = msg.scheme === 'dark' ? 'dark' : 'light'
  const done = () => { post({ type: 'codekin-sandbox:rendered', id: msg.id }) }
  const fail = (err: unknown) => { post({ type: 'codekin-sandbox:error', id: msg.id, message: err instanceof Error ? err.message : String(err) }) }
  try {
    if (msg.kind === 'chart') void renderChart(msg.id, msg.content, msg.scheme).then(done, fail)
    else if (msg.kind === 'html') { renderHtml(msg.content); done() }
    else fail(new Error('Unknown content kind.'))
  } catch (err) {
    fail(err)
  }
})

post({ type: 'codekin-sandbox:ready' })
