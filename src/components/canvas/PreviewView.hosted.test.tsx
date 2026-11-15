/** PreviewView in the hosted web app: no frame (the proxy is out of reach), so a snapshot is how the page is seen. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PreviewApi } from '../../hooks/useCanvas'
import type { CanvasItem, PreviewState } from '../../types'

let PreviewView: typeof import('./PreviewView').PreviewView
beforeAll(async () => {
  vi.stubEnv('VITE_APP_MODE', 'hosted')
  vi.resetModules()
  PreviewView = (await import('./PreviewView')).PreviewView
})

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
})

const item: CanvasItem = { id: 'p1', kind: 'preview', title: 'web', source: { type: 'agent' }, latest: 1, revisions: [], createdAt: '', updatedAt: '' }

function api(state: PreviewState): PreviewApi {
  return {
    state: () => state, logs: () => [], configs: null, generation: 0,
    requestConfigs: vi.fn(), open: vi.fn(), launch: vi.fn(), stop: vi.fn(), restart: vi.fn(), requestLogs: vi.fn(),
    snapshot: vi.fn(), snapshotStatus: () => ({ busy: false }),
  }
}

function render(preview: PreviewApi) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(<PreviewView item={item} content={JSON.stringify({ port: 5173, path: '/' })} preview={preview} onAttach={vi.fn()} />) })
  return container
}

describe('PreviewView (hosted)', () => {
  const running: PreviewState = { itemId: 'p1', status: 'running', targetPort: 5173, managed: false, proxyPort: 40000, entry: '/__codekin/enter?k=abc&to=%2F', snapshots: true }

  it('shows no frame and no new-tab link, and offers a snapshot instead', () => {
    const preview = api(running)
    const el = render(preview)
    expect(el.querySelector('iframe')).toBeNull()
    expect(el.textContent).toContain('Take a snapshot to see the page here')
    const take = [...el.querySelectorAll('button')].find(b => b.textContent?.includes('Take a snapshot'))!
    act(() => { take.click() })
    expect(preview.snapshot).toHaveBeenCalledWith('p1', '/', 'full')
    expect(el.querySelector<HTMLButtonElement>('button[aria-label="Open in a new tab"]')!.disabled).toBe(true)
  })

  it('says what is missing when the machine has no browser for snapshots', () => {
    const el = render(api({ ...running, snapshots: false }))
    expect(el.textContent).toContain('need Chrome or Chromium installed there')
    expect([...el.querySelectorAll('button')].some(b => b.textContent?.includes('Take a snapshot'))).toBe(false)
  })
})
