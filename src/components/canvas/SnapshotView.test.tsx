/** Tests for SnapshotView: where and how the snapshot was taken, its console record, and sending errors to the agent. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SnapshotView } from './SnapshotView'
import type { CanvasItem, SnapshotMeta } from '../../types'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
})

const item: CanvasItem = {
  id: 's1', kind: 'image', title: 'Snapshot: web', source: { type: 'snapshot', preview: 'p1' }, latest: 1,
  revisions: [{ n: 1, createdAt: '2026-11-15T08:00:00.000Z', size: 10, mediaType: 'image/png' }], createdAt: '', updatedAt: '',
}

function render(meta: SnapshotMeta, onAttach = vi.fn()) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(<SnapshotView item={item} revision={1} src="data:image/png;base64,AA==" meta={meta} onAttach={onAttach} />) })
  return container
}

describe('SnapshotView', () => {
  it('shows where it was taken, opens the console when there are errors, and sends them to the agent', () => {
    const onAttach = vi.fn()
    const el = render({
      path: '/settings', title: 'Settings', port: 5173, viewport: 'phone',
      console: [{ level: 'error', message: 'TypeError: x is undefined', path: '/settings', at: 1 }, { level: 'warn', message: 'slow', path: '/settings', at: 2 }],
    }, onAttach)
    expect(el.textContent).toContain('localhost:5173/settings')
    expect(el.textContent).toContain('Phone, 390 px')
    expect(el.textContent).toContain('1 error, 1 warning')
    expect(el.textContent).toContain('TypeError: x is undefined')
    expect(el.querySelector('img')!.getAttribute('width')).toBe('390')
    const send = [...el.querySelectorAll('button')].find(b => b.textContent?.includes('Send errors to agent'))!
    act(() => { send.click() })
    expect(onAttach).toHaveBeenCalledWith('console', expect.stringContaining('TypeError: x is undefined'), '1 console error', true)
  })

  it('says when the page could reach only this machine', () => {
    const el = render({ path: '/', title: '', port: 5173, viewport: 'full', console: [], restricted: true, blocked: 3 })
    expect(el.textContent).toContain('No console errors')
    expect(el.textContent).toContain('3 requests elsewhere (fonts, CDNs, APIs) were blocked')
  })
})
