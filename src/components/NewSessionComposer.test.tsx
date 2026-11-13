/**
 * Tests for NewSessionComposer — the draft screen: the place chip and its
 * picker, the hint line, recent places, the worktree control only for git
 * places, Skip being Claude-only, and Send handing back text and files.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('../lib/ccApi', () => ({
  browseDirs: vi.fn(async () => ({ path: '/home/sam', dirs: [], roots: ['/home/sam'], home: '/home/sam' })),
  getScratchRoot: vi.fn(async () => ({ path: '', effective: '/home/sam/codekin/scratch' })),
  getNativeFolderPickerAvailable: vi.fn(async () => false),
  pickFolderNative: vi.fn(),
}))

import { NewSessionComposer } from './NewSessionComposer.js'
import { NEW_SCRATCH, placeFromPath } from '../lib/places'

type Props = ComponentProps<typeof NewSessionComposer>

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

function props(over: Partial<Props> = {}): Props {
  return {
    token: 'tok', groups: [], isMobile: false, disabled: false,
    place: NEW_SCRATCH, onPlaceChange: vi.fn(), recent: [], home: '/home/sam', scratchRoot: '/home/sam/codekin/scratch',
    initialText: '', onTextChange: vi.fn(), resetKey: 0,
    provider: 'claude', onProviderChange: vi.fn(),
    currentModel: null, onModelChange: vi.fn(), currentEffort: null, onEffortChange: vi.fn(), availableModels: [],
    permissionMode: 'acceptEdits', onPermissionModeChange: vi.fn(),
    useWorktree: true, onWorktreeChange: vi.fn(),
    progress: null, error: null, onSend: vi.fn(),
    ...over,
  }
}

function render(p: Props) {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<NewSessionComposer {...p} />)
  })
  return container
}

function text(): string {
  return container!.textContent ?? ''
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => {
  if (root) act(() => { root!.unmount() })
  container?.remove()
  root = null
  container = null
})

describe('NewSessionComposer', () => {
  it('asks what we are working on and says a scratch folder is created on send', () => {
    render(props())
    expect(container!.querySelector('h1')!.textContent).toBe('What are we working on?')
    expect(text()).toContain('Creates ~/codekin/scratch/… when you send. Git is optional: connect a repo later or never.')
    expect(container!.querySelector('textarea')!.getAttribute('placeholder')).toBe('Describe a task, paste an error, or drop files…')
  })

  it('opens the place picker from the chip', async () => {
    render(props())
    const chip = container!.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement
    expect(chip.textContent).toContain('Scratch folder')
    act(() => { chip.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(container!.querySelector('[role="dialog"][aria-label="Where should this session run?"]')).not.toBeNull()
  })

  it('offers recent places as one-click chips, without the current one', () => {
    const notes = placeFromPath('/home/sam/notes', false, '/home/sam')
    const onPlaceChange = vi.fn()
    render(props({ recent: [NEW_SCRATCH, notes], onPlaceChange }))
    const chips = Array.from(container!.querySelectorAll('button')).filter(b => b.textContent === '~/notes')
    expect(chips).toHaveLength(1)
    act(() => { chips[0].click() })
    expect(onPlaceChange).toHaveBeenCalledWith(notes)
  })

  it('shows the worktree control only for git places', () => {
    render(props({ place: placeFromPath('/home/sam/notes', false, '/home/sam') }))
    expect(text()).not.toMatch(/Worktree/)
    expect(text()).toContain('Runs in ~/notes. Not a git repo, so there are no worktrees.')
    act(() => { root!.unmount() })
    root = null
    container!.remove()
    render(props({ place: placeFromPath('/home/sam/site', true, '/home/sam') }))
    expect(text()).toContain('Worktree')
    expect(text()).toContain('Runs in ~/site, on a fresh worktree.')
  })

  it('hides the worktree control for a folder inside a repository', () => {
    render(props({ place: placeFromPath('/home/sam/site/src', true, '/home/sam', '/home/sam/site'), useWorktree: true }))
    expect(text()).not.toMatch(/Worktree/)
    expect(text()).toContain('inside ~/site, on the checked-out branch')
  })

  it('shows progress instead of the hint, and errors inline', () => {
    render(props({ progress: 'Cloning acme-co/web-app…', error: 'Repository not found' }))
    expect(text()).toContain('Cloning acme-co/web-app…')
    expect(container!.querySelector('[role="alert"]')!.textContent).toBe('Repository not found')
  })

  it('sends the typed text', () => {
    const onSend = vi.fn()
    render(props({ onSend, initialText: 'Write a parser' }))
    const textarea = container!.querySelector('textarea')!
    act(() => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onSend).toHaveBeenCalledWith('Write a parser', [])
  })
})

describe('NewSessionComposer on touch', () => {
  it('folds place, model and mode into one Options button with a bottom sheet', () => {
    render(props({ isMobile: true, availableModels: [{ id: 'claude-opus-5', label: 'Opus 5' }], currentModel: 'claude-opus-5' }))
    const options = container!.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement
    expect(options.textContent).toBe('Scratch folder · Opus 5 · Auto accept edits')
    // The desktop chips are not in the toolbar.
    expect(container!.querySelector('[title="Where this session runs"]')).toBeNull()
    act(() => { options.click() })
    const sheet = document.querySelector('[role="dialog"][aria-label="Session options"]')!
    expect(sheet.textContent).toContain('Place')
    expect(sheet.textContent).toContain('Agent')
    expect(sheet.textContent).toContain('Permission mode')
    expect(sheet.textContent).not.toContain('Work in a worktree')
  })

  it('offers the worktree switch for git places and opens the picker as a screen', async () => {
    render(props({ isMobile: true, place: placeFromPath('/home/sam/site', true, '/home/sam') }))
    act(() => { (container!.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement).click() })
    const sheet = document.querySelector('[role="dialog"][aria-label="Session options"]')!
    expect(sheet.textContent).toContain('Work in a worktree')
    const placeRow = [...sheet.querySelectorAll('button')].find(b => b.textContent?.includes('~/site'))!
    act(() => { placeRow.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(document.querySelector('[role="dialog"][aria-label="Session options"]')).toBeNull()
    expect(document.querySelector('[role="dialog"][aria-label="Where should this session run?"]')).not.toBeNull()
  })

  it('shows recent places above the composer', () => {
    render(props({ isMobile: true, recent: [placeFromPath('/home/sam/notes', false, '/home/sam')] }))
    const recent = [...container!.querySelectorAll('button')].find(b => b.textContent === '~/notes')!
    const textarea = container!.querySelector('textarea')!
    expect(recent.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
