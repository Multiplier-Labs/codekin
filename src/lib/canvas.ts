/**
 * Shared Canvas helpers for the frontend (docs/CANVAS-SPEC.md): which files
 * can open in Canvas, the chat column's size limits, and the keyboard
 * shortcuts that toggle Canvas and step between items.
 */

import type { CanvasItem, CanvasItemKind } from '../types'

/** Below this window width, Canvas replaces the chat instead of sitting beside it. */
export const CANVAS_SIDE_BY_SIDE_MIN = 1101

/** The chat column beside an open Canvas. */
export const CANVAS_CHAT_WIDTH = { min: 360, max: 560, default: 440 } as const

/** Mirrors server/canvas-store.ts canvasTypeForFile: which files Canvas can show. */
export function canvasKindForPath(path: string): CanvasItemKind | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.vl.json') || lower.endsWith('.vegalite.json')) return 'chart'
  const ext = /\.[^./\\]+$/.exec(path)?.[0].toLowerCase()
  switch (ext) {
    case '.md': case '.markdown': case '.mdx': return 'markdown'
    case '.csv': case '.tsv': return 'table'
    case '.mmd': case '.mermaid': return 'diagram'
    case '.png': case '.jpg': case '.jpeg': case '.gif': case '.webp': case '.svg': return 'image'
    case '.html': case '.htm': return 'html'
    default: return null
  }
}

export function clampChatWidth(width: number): number {
  return Math.round(Math.max(CANVAS_CHAT_WIDTH.min, Math.min(CANVAS_CHAT_WIDTH.max, width)))
}

/** The revision the user sees: the pinned one while pinned, else the latest. */
export function shownRevision(item: CanvasItem): number {
  return item.pinnedRevision ?? item.latest
}

/** "agent", "you" or the MCP server: who made an item. */
export function sourceLabel(item: CanvasItem): string {
  switch (item.source.type) {
    case 'agent': return 'Agent'
    case 'file': return 'You'
    case 'mcp': return item.source.server
  }
}

/**
 * A readable name for Codekin's Canvas MCP tools, however a harness reports
 * them (mcp__codekin_canvas__canvas_show, codekin_canvas__canvas_show, or
 * bare canvas_show); other tool names come back unchanged.
 */
export function displayToolName(name: string): string {
  const m = /^(?:mcp__codekin_canvas__|codekin_canvas(?:__|\.))?canvas_(show|update|list)$/.exec(name)
  if (!m) return name
  return { show: 'Canvas: show', update: 'Canvas: update', list: 'Canvas: list' }[m[1] as 'show' | 'update' | 'list']
}

/** Short relative time: "just now", "4 min ago", "3 h ago", "2 d ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (!Number.isFinite(s) || s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

/** ⌘\ / Ctrl+\ toggles Canvas. */
export function isCanvasToggleKey(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === '\\'
}

/**
 * ⌥⌘[ / ⌥⌘] (Ctrl+Alt+[ / ] elsewhere) step between items: -1, 1, or 0 for
 * any other key. Matched on the physical key (`code`) and ignored in text
 * fields, so typing a bracket with AltGr (reported as Ctrl+Alt) never
 * switches items. ⌘⇧[ / ⌘⇧] are left to the browser, which switches tabs.
 */
export function canvasStepFromKey(
  e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'target'>,
  isMac: boolean,
): -1 | 0 | 1 {
  const chord = isMac ? e.metaKey && e.altKey && !e.ctrlKey : e.ctrlKey && e.altKey && !e.metaKey
  if (!chord || e.shiftKey || isEditable(e.target)) return 0
  if (e.code === 'BracketLeft') return -1
  if (e.code === 'BracketRight') return 1
  return 0
}

/** Keep only the most recent per-session entries of a pref map. */
export function trimSessionMap<T>(map: Record<string, T>, keep = 100): Record<string, T> {
  const keys = Object.keys(map)
  return keys.length <= keep ? map : Object.fromEntries(keys.slice(keys.length - keep).map(k => [k, map[k]]))
}
