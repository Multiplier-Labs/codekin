/** Tests for PreviewView: status instead of a stale page, the framed app once running, controls by who started the server. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { PreviewView } from './PreviewView'
import type { PreviewApi } from '../../hooks/useCanvas'
import type { CanvasItem, PreviewState } from '../../types'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null
afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
})

const item: CanvasItem = { id: 'p1', kind: 'preview', title: 'web', source: { type: 'launch', config: 'web' }, latest: 1, revisions: [], createdAt: '', updatedAt: '' }

function api(state?: PreviewState, logs: string[] = []): PreviewApi {
  return {
    state: () => state, logs: () => logs, configs: null,
    requestConfigs: vi.fn(), open: vi.fn(), launch: vi.fn(), stop: vi.fn(), restart: vi.fn(), requestLogs: vi.fn(),
  }
}

function render(preview: PreviewApi, content = JSON.stringify({ port: 5173, path: '/', config: 'web' })) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(<PreviewView item={item} content={content} preview={preview} onAttach={vi.fn()} />) })
  return container
}

describe('PreviewView', () => {
  it('opens the preview on mount', () => {
    const preview = api()
    render(preview)
    expect(preview.open).toHaveBeenCalledWith('p1')
  })

  it('shows the status, not a frame, while the server is not running, and offers to start its configuration', () => {
    const preview = api({ itemId: 'p1', status: 'stopped', targetPort: 5173, managed: false, config: 'web', proxyPort: 40000, entry: '/__codekin/enter?k=a&to=%2F' })
    const el = render(preview)
    expect(el.querySelector('iframe')).toBeNull()
    expect(el.textContent).toContain('Nothing answers on port 5173')
    const start = [...el.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Start' && b.className.includes('bg-primary-fill'))!
    act(() => { start.click() })
    expect(preview.launch).toHaveBeenCalledWith('web')
  })

  it('shows a crash with the last output', () => {
    const el = render(api({ itemId: 'p1', status: 'crashed', targetPort: 5173, managed: false, config: 'web', exitCode: 1, error: '"web" exited with code 1.' }, ['Error: EADDRINUSE']))
    expect(el.textContent).toContain('web stopped unexpectedly')
    expect(el.textContent).toContain('EADDRINUSE')
    expect(el.textContent).toContain('Start again')
  })

  it('frames the app through the proxy entry URL once it runs, with Stop and Restart for a server Codekin started', () => {
    const preview = api({ itemId: 'p1', status: 'running', targetPort: 5173, managed: true, config: 'web', command: 'npm run dev', proxyPort: 40000, entry: '/__codekin/enter?k=abc&to=%2F' })
    const el = render(preview, JSON.stringify({ port: 5173, path: '/settings', config: 'web' }))
    const frame = el.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe('http://localhost:40000/__codekin/enter?k=abc&to=%2Fsettings')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation')
    act(() => { (el.querySelector('[aria-label="Stop server"]') as HTMLButtonElement).click() })
    expect(preview.stop).toHaveBeenCalledWith('p1')
    expect(el.querySelector('[aria-label="Restart server"]')).not.toBeNull()
  })

  it('has no Stop for a server the agent started', () => {
    const el = render(api({ itemId: 'p1', status: 'running', targetPort: 5173, managed: false, proxyPort: 40000, entry: '/__codekin/enter?k=abc&to=%2F' }), JSON.stringify({ port: 5173, path: '/' }))
    expect(el.querySelector('iframe')).not.toBeNull()
    expect(el.querySelector('[aria-label="Stop server"]')).toBeNull()
  })
})
