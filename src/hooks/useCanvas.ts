/**
 * Canvas state for the joined session (docs/CANVAS-SPEC.md): its items, the
 * content of the revision being shown, and the per-session open/selected
 * state, which is remembered in server prefs so switching sessions restores
 * it.
 *
 * Messages arrive through `handleMessage` (wired to the socket's raw
 * messages); requests go out through `send`, which the server scopes to the
 * joined session.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasItem, CanvasItemMeta, WsClientMessage, WsServerMessage } from '../types'
import { getPref, setPref, usePref } from '../lib/prefs'
import { shownRevision, trimSessionMap } from '../lib/canvas'

export interface CanvasContent {
  content: string
  encoding: 'utf8' | 'base64'
  mediaType: string
  meta?: CanvasItemMeta
}

/** What the panel shows for the selected item. */
export type CanvasView =
  | { state: 'empty' }
  | { state: 'loading'; item: CanvasItem; revision: number }
  | { state: 'error'; item: CanvasItem; revision: number; message: string }
  | { state: 'ready'; item: CanvasItem; revision: number; content: CanvasContent }

export interface CanvasApi {
  /** Items of the joined session, oldest first. */
  items: CanvasItem[]
  /** The joined session's item list has arrived (before that, `items` is empty, not known-empty). */
  loaded: boolean
  selected: CanvasItem | null
  view: CanvasView
  open: boolean
  /** Last failed request (opening a file, pinning…), for a notice. */
  notice: string | null
  dismissNotice: () => void
  setOpen: (open: boolean) => void
  toggle: () => void
  select: (itemId: string) => void
  /** Select the previous (-1) or next (1) item, wrapping around. */
  step: (dir: -1 | 1) => void
  /** Open a file from the session's folder (or an attached root) and show it. */
  openFile: (path: string, root?: string) => void
  /** Feed every server message here; returns true when it was a Canvas message. */
  handleMessage: (msg: WsServerMessage) => boolean
  /** Ask for the joined session's items (after joining or reconnecting). */
  refresh: () => void
  /** Open an item at a revision (a sent context chip); the latest when it is gone. */
  openAt: (itemId: string, revision: number) => void
  /** View a specific revision of the selected item; null follows the pinned or latest one. */
  showRevision: (revision: number | null) => void
  /** Pin the selected item at a revision (new ones then wait), or unpin with null. */
  pin: (revision: number | null) => void
  /** Delete an item and its revisions. */
  remove: (itemId: string) => void
  /**
   * The user is reading (scrolled into the item or has a selection). A new
   * revision arriving then waits behind the revision bar instead of
   * replacing the view.
   */
  setReading: (reading: boolean) => void
  /** Two revisions of the selected item being compared, or null. */
  compare: { from: number; to: number } | null
  setCompare: (compare: { from: number; to: number } | null) => void
  /** Content of one revision of the selected item (fetched while comparing). */
  revisionContent: (revision: number) => CanvasContent | 'loading' | { error: string }
}

const contentKey = (sessionId: string, itemId: string, revision: number) => `${sessionId}/${itemId}@${revision}`

function normalizePath(path: string): string {
  return path.replace(/^\.\/+/, '').replace(/\\/g, '/')
}

function updateSessionState(sessionId: string, patch: { open?: boolean; itemId?: string }) {
  const all = getPref('canvasSessions') ?? {}
  const current = all[sessionId] ?? {}
  if (Object.entries(patch).every(([k, v]) => current[k as keyof typeof current] === v)) return
  // Re-insert so the most recently touched sessions are kept when trimming.
  const rest = Object.fromEntries(Object.entries(all).filter(([k]) => k !== sessionId))
  setPref('canvasSessions', trimSessionMap({ ...rest, [sessionId]: { ...current, ...patch } }))
}

export interface CanvasOptions {
  /**
   * Asked when the agent publishes a new item: open Canvas on it? `first`
   * is true when the session had no agent items before (docs/CANVAS-SPEC.md §4).
   */
  shouldAutoOpen?: (first: boolean) => boolean
}

export function useCanvas(sessionId: string | null, send: (msg: WsClientMessage) => void, options: CanvasOptions = {}): CanvasApi {
  const [itemsBySession, setItemsBySession] = useState<Record<string, CanvasItem[]>>({})
  const [contents, setContents] = useState<Record<string, CanvasContent | undefined>>({})
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [notice, setNotice] = useState<string | null>(null)
  /** Revision the user chose (or a new one was held back from), per session/item. */
  const [viewRev, setViewRev] = useState<Record<string, number | undefined>>({})
  const [compare, setCompare] = useState<{ from: number; to: number } | null>(null)
  const readingRef = useRef(false)
  /** Latest revision seen per session/item, to notice new ones. */
  const seenLatest = useRef(new Map<string, number>())
  const sessionsPref = usePref('canvasSessions')
  // Latest values for the message handler, which is stable across renders.
  const itemsRef = useRef(itemsBySession)
  const optionsRef = useRef(options)
  useEffect(() => {
    itemsRef.current = itemsBySession
    optionsRef.current = options
  })

  /** Content requests in flight, so a revision is asked for once. */
  const inflight = useRef(new Set<string>())
  /** A file the user asked to open: shown as soon as its item appears. */
  const pendingOpen = useRef<{ sessionId: string; path: string; root?: string } | null>(null)

  const items = useMemo(() => (sessionId ? itemsBySession[sessionId] ?? [] : []), [itemsBySession, sessionId])
  const sessionState = sessionId ? sessionsPref?.[sessionId] : undefined
  const selected = items.find(i => i.id === sessionState?.itemId) ?? items.at(-1) ?? null
  const open = !!sessionId && !!sessionState?.open

  const itemKey = selected && sessionId ? `${sessionId}/${selected.id}` : null
  const chosen = itemKey ? viewRev[itemKey] : undefined
  const revision = selected
    ? chosen !== undefined && selected.revisions.some(r => r.n === chosen) ? chosen : shownRevision(selected)
    : 0
  const key = selected && sessionId ? contentKey(sessionId, selected.id, revision) : null

  // A new revision of the item being read waits instead of replacing the view.
  useEffect(() => {
    if (!selected || !itemKey) return
    const seen = seenLatest.current.get(itemKey)
    seenLatest.current.set(itemKey, selected.latest)
    if (seen !== undefined && selected.latest > seen && readingRef.current && selected.pinnedRevision === undefined && viewRev[itemKey] === undefined) {
      setViewRev(prev => ({ ...prev, [itemKey]: seen })) // eslint-disable-line react-hooks/set-state-in-effect -- holds the view when a revision arrives
    }
  }, [selected, itemKey, viewRev])

  // Comparing applies to the selected item only.
  useEffect(() => { setCompare(null) }, [itemKey]) // eslint-disable-line react-hooks/set-state-in-effect -- reset per item

  // Fetch the shown revision (and both compared ones) when Canvas is open and they aren't cached.
  useEffect(() => {
    if (!open || !selected || !sessionId) return
    const wanted = new Set([revision, ...(compare ? [compare.from, compare.to] : [])])
    for (const n of wanted) {
      const k = contentKey(sessionId, selected.id, n)
      if (contents[k] || errors[k] !== undefined || inflight.current.has(k)) continue
      inflight.current.add(k)
      send({ type: 'canvas_get', itemId: selected.id, revision: n })
    }
  }, [open, selected, sessionId, revision, compare, contents, errors, send])

  const shownContent = key ? contents[key] : undefined
  const shownError = key ? errors[key] : undefined
  const view: CanvasView = !selected
    ? { state: 'empty' }
    : shownContent
      ? { state: 'ready', item: selected, revision, content: shownContent }
      : shownError !== undefined
        ? { state: 'error', item: selected, revision, message: shownError }
        : { state: 'loading', item: selected, revision }

  const setOpen = useCallback((value: boolean) => {
    if (sessionId) updateSessionState(sessionId, { open: value })
  }, [sessionId])

  const toggle = useCallback(() => {
    if (sessionId) updateSessionState(sessionId, { open: !getPref('canvasSessions')?.[sessionId]?.open })
  }, [sessionId])

  const select = useCallback((itemId: string) => {
    if (sessionId) updateSessionState(sessionId, { itemId, open: true })
  }, [sessionId])

  const step = useCallback((dir: -1 | 1) => {
    if (!sessionId || items.length < 2 || !selected) return
    const index = items.findIndex(i => i.id === selected.id)
    const next = items[(index + dir + items.length) % items.length]
    updateSessionState(sessionId, { itemId: next.id })
  }, [sessionId, items, selected])

  const showFile = useCallback((list: CanvasItem[], sid: string, path: string, root?: string): boolean => {
    const match = list.find(i => i.source.type === 'file' && i.source.path === path && (i.source.root ?? undefined) === root)
    if (match) updateSessionState(sid, { itemId: match.id, open: true })
    return !!match
  }, [])

  const openFile = useCallback((rawPath: string, root?: string) => {
    if (!sessionId) return
    const path = normalizePath(rawPath)
    setNotice(null)
    // Already open: show it now; the server adds a revision only if the file changed.
    showFile(items, sessionId, path, root)
    pendingOpen.current = { sessionId, path, root }
    send({ type: 'canvas_open_file', path, ...(root ? { root } : {}) })
  }, [sessionId, items, send, showFile])

  const refresh = useCallback(() => {
    if (sessionId) send({ type: 'canvas_list' })
  }, [sessionId, send])

  const openAt = useCallback((itemId: string, n: number) => {
    if (!sessionId) return
    const item = items.find(i => i.id === itemId)
    if (!item) { setNotice('That Canvas item no longer exists.'); return }
    const shown = item.pinnedRevision ?? item.latest
    setViewRev(prev => ({ ...prev, [`${sessionId}/${itemId}`]: item.revisions.some(r => r.n === n) && n !== shown ? n : undefined }))
    updateSessionState(sessionId, { itemId, open: true })
  }, [sessionId, items])

  const showRevision = useCallback((n: number | null) => {
    if (!itemKey) return
    setViewRev(prev => ({ ...prev, [itemKey]: n ?? undefined }))
  }, [itemKey])

  const pin = useCallback((n: number | null) => {
    if (!selected || !itemKey) return
    send({ type: 'canvas_pin', itemId: selected.id, revision: n })
    // Pinned or unpinned, the view follows the pin from here.
    setViewRev(prev => ({ ...prev, [itemKey]: undefined }))
  }, [selected, itemKey, send])

  const remove = useCallback((itemId: string) => {
    send({ type: 'canvas_delete', itemId })
  }, [send])

  const setReading = useCallback((reading: boolean) => { readingRef.current = reading }, [])

  const revisionContent = useCallback((n: number): CanvasContent | 'loading' | { error: string } => {
    if (!selected || !sessionId) return 'loading'
    const k = contentKey(sessionId, selected.id, n)
    const error = errors[k]
    return contents[k] ?? (error !== undefined ? { error } : 'loading')
  }, [selected, sessionId, contents, errors])

  const handleMessage = useCallback((msg: WsServerMessage): boolean => {
    switch (msg.type) {
      case 'canvas_items': {
        setItemsBySession(prev => ({ ...prev, [msg.sessionId]: msg.items }))
        const pending = pendingOpen.current
        if (pending?.sessionId === msg.sessionId && showFile(msg.items, msg.sessionId, pending.path, pending.root)) {
          pendingOpen.current = null
        }
        return true
      }
      case 'canvas_item': {
        const k = contentKey(msg.sessionId, msg.item.id, msg.revision)
        const mediaType = msg.item.revisions.find(r => r.n === msg.revision)?.mediaType ?? ''
        setContents(prev => ({ ...prev, [k]: { content: msg.content, encoding: msg.encoding, mediaType, ...(msg.meta ? { meta: msg.meta } : {}) } }))
        inflight.current.delete(k)
        return true
      }
      case 'canvas_error': {
        // A content request's error names its revision; anything else is a notice.
        if (msg.sessionId && msg.itemId && msg.revision !== undefined) {
          const k = contentKey(msg.sessionId, msg.itemId, msg.revision)
          inflight.current.delete(k)
          setErrors(prev => ({ ...prev, [k]: msg.message }))
        } else {
          pendingOpen.current = null
          setNotice(msg.message)
        }
        return true
      }
      case 'canvas_event': {
        // The event arrives before the updated list, so the list still lacks this item.
        if (msg.action === 'created' && msg.by !== 'file') {
          const before = itemsRef.current[msg.sessionId] ?? []
          const first = !before.some(i => i.source.type !== 'file')
          if (optionsRef.current.shouldAutoOpen?.(first)) updateSessionState(msg.sessionId, { open: true, itemId: msg.itemId })
        }
        return true
      }
      default:
        return false
    }
  }, [showFile])

  // A new session starts without a stale notice.
  useEffect(() => { setNotice(null) }, [sessionId]) // eslint-disable-line react-hooks/set-state-in-effect -- reset per session

  return {
    items, loaded: !!sessionId && sessionId in itemsBySession, selected, view, open, notice,
    dismissNotice: () => { setNotice(null) },
    setOpen, toggle, select, step, openFile, handleMessage, refresh,
    openAt, showRevision, pin, remove, setReading, compare, setCompare, revisionContent,
  }
}
