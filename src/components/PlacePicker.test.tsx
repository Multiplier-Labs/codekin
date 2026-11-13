/**
 * Tests for PlacePicker — mounted behaviour the pure model can't cover:
 * focus starts in the search input, keys drive views and picks, the folder
 * browser lists through the server, and the native dialog is preferred when
 * the machine offers it.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const api = vi.hoisted(() => ({
  browseDirs: vi.fn(),
  getNativeFolderPickerAvailable: vi.fn(),
  pickFolderNative: vi.fn(),
}))
vi.mock('../lib/ccApi', () => api)

import { PlacePicker } from './PlacePicker.js'
import { NEW_SCRATCH, type DraftPlace } from '../lib/places'
import type { RepoGroup } from '../hooks/useRepos'

const HOME = '/home/sam'
const GROUPS: RepoGroup[] = [{
  owner: 'acme-co', source: 'github', repos: [{
    id: 'api', name: 'api', owner: 'acme-co', path: `${HOME}/repos/acme-co/api`, workingDir: `${HOME}/repos/acme-co/api`,
    cloned: true, description: '', url: '', skills: [], modules: [], tags: [],
  }],
}]

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

function listing(path: string, dirs: string[] = [], git = false) {
  return { path, dirs, gitDirs: [], git, roots: [HOME, `${HOME}/repos`], home: HOME }
}

async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

async function mount(props: { onPick?: (p: DraftPlace) => void; onClose?: () => void } = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  const onPick = props.onPick ?? vi.fn()
  const onClose = props.onClose ?? vi.fn()
  act(() => {
    root = createRoot(container!)
    root.render(
      <PlacePicker token="tok" groups={GROUPS} recent={[]} current={NEW_SCRATCH} onPick={onPick} onClose={onClose} />,
    )
  })
  await flush()
  return { onPick, onClose, input: container.querySelector('input')! }
}

function key(input: HTMLInputElement, k: string) {
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
}

function rowLabels(): string[] {
  return Array.from(container!.querySelectorAll('[role="option"]')).map(el => el.textContent ?? '')
}

beforeEach(() => {
  api.browseDirs.mockReset().mockImplementation(async (_t: string, p?: string) => listing(p ?? HOME, p ? [] : ['notes', 'site']))
  api.getNativeFolderPickerAvailable.mockReset().mockResolvedValue(false)
  api.pickFolderNative.mockReset()
})

afterEach(() => {
  if (root) act(() => { root!.unmount() })
  container?.remove()
  root = null
  container = null
})

describe('PlacePicker', () => {
  it('is a labelled dialog with focus in the search input', async () => {
    const { input } = await mount()
    expect(container!.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Where should this session run?')
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-activedescendant')).toBe(container!.querySelector('[role="option"]')!.id)
  })

  it('marks the current place and picks a highlighted row with Enter', async () => {
    const { input, onPick } = await mount()
    expect(rowLabels()[0]).toContain('Scratch folder')
    expect(container!.querySelector('[aria-label="current place"]')).not.toBeNull()
    key(input, 'Enter')
    expect(onPick).toHaveBeenCalledWith(NEW_SCRATCH)
  })

  it('opens an owner with → and goes back with ←', async () => {
    const { input } = await mount()
    key(input, 'ArrowDown')
    key(input, 'ArrowDown')
    key(input, 'ArrowRight')
    expect(rowLabels()).toEqual(['acme-co', 'api'])
    key(input, 'ArrowLeft')
    expect(rowLabels()[0]).toContain('Scratch folder')
  })

  it('browses folders when no native dialog is available, and uses one', async () => {
    const { input, onPick } = await mount()
    key(input, 'ArrowDown')
    key(input, 'Enter') // Choose a folder on this machine…
    await flush()
    expect(rowLabels()).toEqual(['Choose a folder', 'Use ~', 'notes', 'site'])
    key(input, 'Enter') // highlight starts on "Use ~"
    expect(onPick).toHaveBeenCalledWith({ kind: 'folder', path: HOME, git: false, label: '~' })
  })

  it('prefers the native folder dialog when the machine offers it', async () => {
    api.getNativeFolderPickerAvailable.mockResolvedValue(true)
    api.pickFolderNative.mockResolvedValue(`${HOME}/site`)
    api.browseDirs.mockImplementation(async (_t: string, p?: string) => listing(p ?? HOME, [], p === `${HOME}/site`))
    const { input, onPick } = await mount()
    key(input, 'ArrowDown')
    key(input, 'Enter')
    await flush()
    expect(api.pickFolderNative).toHaveBeenCalled()
    expect(onPick).toHaveBeenCalledWith({ kind: 'folder', path: `${HOME}/site`, git: true, label: '~/site' })
  })

  it('closes on Escape', async () => {
    const { input, onClose } = await mount()
    key(input, 'Escape')
    expect(onClose).toHaveBeenCalled()
  })
})
