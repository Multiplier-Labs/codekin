/** Tests for DiffPanel — verifies the pinned, folder-grouped file list, one file's diff at a time with J/K and previous/next, the filter, the inline discard confirmation and the per-view empty state. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { DiffPanel } from './DiffPanel.js'
import type { DiffFile, DiffView, WsClientMessage, WsServerMessage } from '../types'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

const file = (path: string, extra: Partial<DiffFile> = {}): DiffFile => ({
  path, status: 'modified', isBinary: false, additions: 1, deletions: 0,
  hunks: [{ header: '@@ -1,1 +1,2 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [
    { type: 'context', content: 'kept', oldLineNo: 1, newLineNo: 1 },
    { type: 'add', content: `added in ${path}`, newLineNo: 2 },
  ] }],
  ...extra,
})

function mount(view: DiffView = 'all') {
  const sent: WsClientMessage[] = []
  let deliver: (msg: WsServerMessage) => void = () => {}
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(
      <DiffPanel
        isOpen
        onClose={vi.fn()}
        send={(m) => { sent.push(m) }}
        onHandleMessage={(fn) => { deliver = fn }}
        onHandleToolDone={vi.fn()}
        onHandleTurnDone={vi.fn()}
        sessionId="s1"
        defaultView={view}
      />,
    )
  })
  const c = container
  const result = (files: DiffFile[]) => {
    const requestId = [...sent].reverse().find(m => m.type === 'get_diff' || m.type === 'discard_changes')
    act(() => {
      deliver({
        type: 'diff_result', files, branch: 'feat/x', scope: view, sessionId: 's1',
        requestId: requestId && 'requestId' in requestId ? requestId.requestId : undefined,
        summary: { filesChanged: files.length, insertions: files.length, deletions: 0, truncated: false },
      })
    })
  }
  return { c, sent, result }
}

const key = (k: string) => { act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) }) }
const buttonWith = (c: HTMLElement, text: string) => [...c.querySelectorAll('button')].find(b => b.textContent?.includes(text))
const diffBody = (c: HTMLElement) => c.querySelector('.diff-hunk-view')?.textContent ?? ''

describe('DiffPanel', () => {
  it('groups files by folder and shows one file at a time', () => {
    const { c, result } = mount()
    result([file('src/b.ts'), file('README.md'), file('src/a.ts')])

    const folders = [...c.querySelectorAll('[title$="/"]')].map(el => el.textContent)
    expect(folders).toEqual(['src/'])
    const rows = [...c.querySelectorAll('button[aria-current], button[title="README.md"], button[title^="src/"]')].map(b => b.getAttribute('title'))
    expect(rows).toEqual(['README.md', 'src/b.ts', 'src/a.ts'])

    expect(diffBody(c)).toContain('added in README.md')
    expect(diffBody(c)).not.toContain('added in src/b.ts')
    expect(c.textContent).toContain('1 / 3')
  })

  it('moves between files with J/K and the arrows, stopping at the ends', () => {
    const { c, result } = mount()
    result([file('a.ts'), file('b.ts')])

    key('k')
    expect(diffBody(c)).toContain('added in a.ts')
    key('j')
    expect(diffBody(c)).toContain('added in b.ts')
    key('j')
    expect(diffBody(c)).toContain('added in b.ts')
    expect((c.querySelector('[aria-label="Next file"]') as HTMLButtonElement).disabled).toBe(true)

    act(() => { (c.querySelector('[aria-label="Previous file"]') as HTMLButtonElement).click() })
    expect(diffBody(c)).toContain('added in a.ts')

    act(() => { (c.querySelector('button[title="b.ts"]') as HTMLButtonElement).click() })
    expect(diffBody(c)).toContain('added in b.ts')
  })

  it('ignores J/K while typing in the filter, which narrows the list only', () => {
    const { c, result } = mount()
    result([file('src/a.ts'), file('lib/b.ts')])

    const input = c.querySelector('input[aria-label="Filter files"]') as HTMLInputElement
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(input, 'SRC')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(c.querySelector('button[title="lib/b.ts"]')).toBeNull()
    expect(c.querySelector('button[title="src/a.ts"]')).not.toBeNull()

    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })) })
    expect(diffBody(c)).toContain('added in lib/b.ts')
  })

  it('confirms discard inline, naming new files that will be deleted', () => {
    const { c, sent, result } = mount('all')
    result([file('a.ts'), file('new.ts', { status: 'added' })])

    act(() => { buttonWith(c, 'Discard all')!.click() })
    const box = c.querySelector('[role="alertdialog"]')!
    expect(box.textContent).toContain('Discard all 2 files?')
    expect(box.textContent).toContain('Edits to 1 file are reverted and 1 new file, new.ts, is deleted.')
    expect(sent.some(m => m.type === 'discard_changes')).toBe(false)

    key('Escape')
    expect(c.querySelector('[role="alertdialog"]')).toBeNull()

    act(() => { buttonWith(c, 'Discard all')!.click() })
    act(() => { buttonWith(c.querySelector('[role="alertdialog"]') as HTMLElement, 'Discard 2 files')!.click() })
    expect(sent.at(-1)).toMatchObject({ type: 'discard_changes', scope: 'all' })
  })

  it('offers no discard in branch views', () => {
    const { c, result } = mount('branch')
    result([file('a.ts')])
    expect(buttonWith(c, 'Discard all')).toBeUndefined()
    expect(c.querySelector('[title="Discard this file\'s changes"]')).toBeNull()
  })

  it('says everything is committed when the uncommitted view is empty', () => {
    const { c, sent, result } = mount('all')
    result([])

    expect(c.textContent).toContain('No uncommitted changes')
    act(() => { buttonWith(c, 'Show all task changes')!.click() })
    expect(sent.at(-1)).toMatchObject({ type: 'get_diff', scope: 'branch' })
  })
})
