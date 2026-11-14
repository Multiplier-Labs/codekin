/** Tests for the Canvas helpers: supported files, shortcuts, sizes and labels. */
import { describe, it, expect } from 'vitest'
import { canvasKindForPath, canvasStepFromKey, clampChatWidth, displayToolName, isCanvasToggleKey, relativeTime, shownRevision, trimSessionMap } from './canvas'
import type { CanvasItem } from '../types'

const key = (over: Partial<KeyboardEvent> & { target?: unknown } = {}) =>
  ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, ...over }) as unknown as KeyboardEvent

describe('canvasKindForPath', () => {
  it('matches the server: Markdown, CSV/TSV, Mermaid and images', () => {
    expect(canvasKindForPath('docs/PLAN.MD')).toBe('markdown')
    expect(canvasKindForPath('a/b.tsv')).toBe('table')
    expect(canvasKindForPath('arch.mermaid')).toBe('diagram')
    expect(canvasKindForPath('shot.webp')).toBe('image')
    expect(canvasKindForPath('data.json')).toBeNull()
    expect(canvasKindForPath('Makefile')).toBeNull()
    expect(canvasKindForPath('dir.md/file')).toBeNull()
  })
})

describe('shortcuts', () => {
  it('toggles Canvas on Cmd/Ctrl+\\ only', () => {
    expect(isCanvasToggleKey(key({ key: '\\', metaKey: true }))).toBe(true)
    expect(isCanvasToggleKey(key({ key: '\\', ctrlKey: true }))).toBe(true)
    expect(isCanvasToggleKey(key({ key: '\\' }))).toBe(false)
    expect(isCanvasToggleKey(key({ key: '\\', ctrlKey: true, altKey: true }))).toBe(false)
  })

  it('steps with ⌥⌘[ / ⌥⌘] on macOS and Ctrl+Alt elsewhere, by physical key', () => {
    expect(canvasStepFromKey(key({ code: 'BracketLeft', metaKey: true, altKey: true }), true)).toBe(-1)
    expect(canvasStepFromKey(key({ code: 'BracketRight', metaKey: true, altKey: true }), true)).toBe(1)
    expect(canvasStepFromKey(key({ code: 'BracketRight', ctrlKey: true, altKey: true }), false)).toBe(1)
    // Browser tab switching stays the browser's.
    expect(canvasStepFromKey(key({ code: 'BracketRight', metaKey: true, shiftKey: true }), true)).toBe(0)
    expect(canvasStepFromKey(key({ code: 'BracketRight', ctrlKey: true, altKey: true }), true)).toBe(0)
  })

  it('never steps while typing, so AltGr brackets in a text field are safe', () => {
    const textarea = { tagName: 'TEXTAREA', isContentEditable: false }
    expect(canvasStepFromKey(key({ code: 'BracketLeft', ctrlKey: true, altKey: true, target: textarea }), false)).toBe(0)
    // AltGr+8 types "[" on German layouts: the physical key is Digit8.
    expect(canvasStepFromKey(key({ key: '[', code: 'Digit8', ctrlKey: true, altKey: true }), false)).toBe(0)
  })
})

describe('helpers', () => {
  it('clamps the chat column', () => {
    expect(clampChatWidth(100)).toBe(360)
    expect(clampChatWidth(440.4)).toBe(440)
    expect(clampChatWidth(9000)).toBe(560)
  })

  it('shows the pinned revision while pinned', () => {
    const item = { latest: 4 } as CanvasItem
    expect(shownRevision(item)).toBe(4)
    expect(shownRevision({ ...item, pinnedRevision: 2 })).toBe(2)
  })

  it('formats relative times', () => {
    const now = Date.parse('2026-11-14T12:00:00Z')
    expect(relativeTime('2026-11-14T11:59:40Z', now)).toBe('just now')
    expect(relativeTime('2026-11-14T11:56:00Z', now)).toBe('4 min ago')
    expect(relativeTime('2026-11-14T09:00:00Z', now)).toBe('3 h ago')
    expect(relativeTime('2026-11-12T12:00:00Z', now)).toBe('2 d ago')
  })

  it('keeps only the most recent session entries', () => {
    const map = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`s${i}`, i]))
    expect(Object.keys(trimSessionMap(map, 3))).toEqual(['s2', 's3', 's4'])
    expect(trimSessionMap(map, 10)).toBe(map)
  })
})

describe('displayToolName', () => {
  it('names the Canvas tools for every harness, and leaves others alone', () => {
    expect(displayToolName('mcp__codekin_canvas__canvas_show')).toBe('Canvas: show')
    expect(displayToolName('codekin_canvas__canvas_update')).toBe('Canvas: update')
    expect(displayToolName('canvas_list')).toBe('Canvas: list')
    expect(displayToolName('mcp__other__canvas_show')).toBe('mcp__other__canvas_show')
    expect(displayToolName('Bash')).toBe('Bash')
  })
})
