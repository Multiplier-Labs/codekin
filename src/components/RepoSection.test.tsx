/**
 * Tests for RepoSection — covers the per-repo "New session" affordance, which
 * is hover-revealed but must stay in the DOM (and reachable by keyboard focus
 * and on touch) for every repo, not just the active one.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { RepoSection, type RepoSectionProps, type RepoNode } from './RepoSection.js'
import type { Session } from '../types.js'
import { PROVIDERS } from '../types.js'

let activeRoot: ReturnType<typeof createRoot> | null = null
let activeContainer: HTMLElement | null = null

function render(ui: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    activeRoot = createRoot(container)
    activeRoot.render(ui)
  })
  activeContainer = container
  return container
}

afterEach(() => {
  if (activeRoot) act(() => activeRoot!.unmount())
  activeContainer?.remove()
  activeRoot = null
  activeContainer = null
})

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
  if (!btn) throw new Error(`button "${label}" not found`)
  return btn
}

const session: Session = {
  id: 'abc12345',
  name: 'fix sidebar',
  workingDir: '/srv/repos/codekin',
  created: new Date().toISOString(),
  active: true,
} as Session

const node: RepoNode = {
  workingDir: '/srv/repos/codekin',
  displayName: 'codekin',
  sessions: [session],
  hasWaiting: false,
  hasActive: false,
  hasTentative: false,
}

function props(overrides: Partial<RepoSectionProps> = {}): RepoSectionProps {
  return {
    node,
    isActive: true,
    activeSessionId: null,
    waitingSessions: {},
    tentativeQueues: {},
    onSelectSession: () => {},
    onDeleteSession: () => {},
    onRenameSession: () => {},
    onSelectRepo: () => {},
    onDeleteRepo: () => {},
    onOpenDrawer: () => {},
    ...overrides,
  }
}

describe('RepoSection', () => {
  it('offers "New session" for a repo that is not the active one', () => {
    const onNewSession = vi.fn()
    const container = render(<RepoSection {...props({ isActive: false, onNewSession })} />)
    // Expand the collapsed section, then the row is present.
    click(container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!)
    expect(findButton(container, 'New session')).toBeTruthy()
  })

  it('reveals the row by hovering the section, via the shared reveal contract', () => {
    const container = render(<RepoSection {...props({ onNewSession: vi.fn() })} />)
    expect(container.querySelector('.section-reveal')).toBeTruthy()
    expect(findButton(container, 'New session').className).toContain('section-reveal-target')
  })

  it('does not hide the row with an unconditional opacity utility', () => {
    // Hiding is gated behind `@media (hover: hover)` in the stylesheet, so a
    // touch device never gets a control it cannot reach.
    const container = render(<RepoSection {...props({ onNewSession: vi.fn() })} />)
    expect(findButton(container, 'New session').className).not.toContain('opacity-0')
  })

  it('renames the repo-level destructive action to what it actually does', () => {
    const onDeleteRepo = vi.fn()
    const container = render(<RepoSection {...props({ onDeleteRepo })} />)
    click(container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!)
    click(findButton(container, 'Close sessions'))
    expect(onDeleteRepo).toHaveBeenCalledWith('/srv/repos/codekin')
  })

  it('marks the harness on every session row, Claude included', () => {
    const sessions: Session[] = [
      { ...session, id: 'a1', provider: 'claude' } as Session,
      { ...session, id: 'b2', provider: 'codex' } as Session,
      { ...session, id: 'c3', provider: 'opencode' } as Session,
      // Sessions created before the provider field existed default to Claude.
      { ...session, id: 'd4', provider: undefined } as Session,
    ]
    const container = render(<RepoSection {...props({ node: { ...node, sessions } })} />)
    const marks = [...container.querySelectorAll('[title$="session"]')].map(el => el.textContent?.trim())
    expect(marks).toEqual(['Claude', 'Codex', 'OpenCode', 'Claude'])
  })

  it('spells the marks from PROVIDERS rather than a second list', () => {
    const container = render(<RepoSection {...props({ node: { ...node, sessions: [{ ...session, provider: 'opencode' } as Session] } })} />)
    const mark = container.querySelector('[title="OpenCode session"]')
    expect(mark?.textContent).toContain(PROVIDERS.find(p => p.id === 'opencode')!.label)
  })

  it('names the pinned model in the row tooltip when the session has one', () => {
    const pinned = { ...session, provider: 'codex', model: 'gpt-5.6-sol' } as Session
    const container = render(<RepoSection {...props({ node: { ...node, sessions: [pinned] } })} />)
    expect(container.querySelector('[title="Codex session · gpt-5.6-sol"]')).toBeTruthy()
  })

  it('gives the title a line to itself, with the metadata on a second line', () => {
    const container = render(<RepoSection {...props()} />)
    const mark = container.querySelector('[title$="session"]')!
    const metaLine = mark.parentElement!
    const row = metaLine.parentElement!

    // Line one holds the title and the overflow menu, and nothing else — the
    // title truncating at 60% while metadata rendered whole is what this
    // layout exists to fix.
    const titleLine = row.firstElementChild!
    expect(titleLine).not.toBe(metaLine)
    expect(titleLine.querySelector('.min-w-0 .truncate')?.textContent).toBe('fix sidebar')
    expect(titleLine.textContent).not.toContain('Claude')

    // Line two carries the harness and the age, and does not truncate.
    expect(metaLine.textContent).toContain('Claude')
    expect(metaLine.textContent).toContain('0s')
    expect(metaLine.querySelector('.truncate')).toBeNull()
  })

  it('keeps the worktree a glyph on the meta line, never a spelled-out name', () => {
    // Spelling the branch out is what pushed the metadata over one line in the
    // first place; the name stays in the tooltip.
    const onWorktree = { ...session, worktreePath: '/srv/repos/codekin-wt-c4121d7c' } as Session
    const container = render(<RepoSection {...props({ node: { ...node, sessions: [onWorktree] } })} />)
    const glyph = container.querySelector('[title^="In a worktree"]')!
    expect(glyph.textContent).toBe('')
    expect(glyph.querySelector('svg')).toBeTruthy()
    // On the meta line, beside the harness — not up on the title line.
    expect(glyph.parentElement).toBe(container.querySelector('[title$="session"]')!.parentElement)
  })

  it('creates the session with the provider chosen from the menu', () => {
    const onNewSession = vi.fn()
    const container = render(<RepoSection {...props({ onNewSession })} />)
    click(findButton(container, 'New session'))
    click(findButton(container, 'Claude'))
    expect(onNewSession).toHaveBeenCalledWith('claude')
  })
})
