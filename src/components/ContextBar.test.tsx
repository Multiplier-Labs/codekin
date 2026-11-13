/**
 * Tests for ContextBar — the session's place, attached folders with detach,
 * and + Attach through the place picker (scratch row hidden).
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const HOME = '/home/sam'
const api = vi.hoisted(() => ({
  browseDirs: vi.fn(async () => ({ path: '/home/sam', dirs: [], gitDirs: [], git: false, roots: ['/home/sam'], home: '/home/sam' })),
  getNativeFolderPickerAvailable: vi.fn(async () => false),
  pickFolderNative: vi.fn(),
}))
vi.mock('../lib/ccApi', () => api)

import { ContextBar } from './ContextBar.js'
import type { AttachedPlace } from '../types'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
})

async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

async function mount(opts: { attached?: AttachedPlace[]; onAttach?: () => Promise<void>; onDetach?: (p: string) => Promise<void> } = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  const onAttach = vi.fn(opts.onAttach ?? (async () => {}))
  const onDetach = vi.fn(opts.onDetach ?? (async () => {}))
  act(() => {
    root = createRoot(container!)
    root.render(
      <ContextBar
        token="tok"
        path={`${HOME}/codekin/scratch/brisk-otter`}
        place={{ kind: 'scratch', git: false }}
        attached={opts.attached ?? []}
        groups={[]}
        recent={[]}
        onAttach={onAttach}
        onDetach={onDetach}
      />,
    )
  })
  await flush()
  return { onAttach, onDetach }
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container!.querySelectorAll('button')].find(b => b.textContent?.includes(label) || b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined
}

describe('ContextBar', () => {
  it('shows the session place and each attached folder', async () => {
    await mount({ attached: [
      { path: `${HOME}/notes`, place: { kind: 'folder', git: false } },
      { path: `${HOME}/repos/acme-co`, place: { kind: 'org', git: false, owner: 'acme-co' } },
    ] })
    const text = container!.textContent ?? ''
    expect(text).toContain('scratch/brisk-otter')
    expect(text).toContain('~/notes')
    expect(text).toContain('acme-co')
    expect(text).toContain('Attach folder, repo or org')
  })

  it('detaches a folder with its × button', async () => {
    const { onDetach } = await mount({ attached: [{ path: `${HOME}/notes`, place: { kind: 'folder', git: false } }] })
    await act(async () => { button('Detach ~/notes')!.click() })
    expect(onDetach).toHaveBeenCalledWith(`${HOME}/notes`)
  })

  it('opens the picker without a scratch row', async () => {
    await mount()
    await act(async () => { button('Attach folder, repo or org')!.click() })
    await flush()
    const text = container!.textContent ?? ''
    expect(text).toContain('Choose a folder on this machine')
    expect(text).not.toContain('Scratch folder')
  })

  it('shows why a change failed', async () => {
    await mount({ onDetach: async () => { throw new Error('That folder is not attached to this session') }, attached: [{ path: `${HOME}/notes`, place: { kind: 'folder', git: false } }] })
    await act(async () => { button('Detach ~/notes')!.click() })
    await flush()
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe('That folder is not attached to this session')
  })
})
