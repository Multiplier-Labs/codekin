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

  it('creates the session with the provider chosen from the menu', () => {
    const onNewSession = vi.fn()
    const container = render(<RepoSection {...props({ onNewSession })} />)
    click(findButton(container, 'New session'))
    click(findButton(container, 'Claude Code'))
    expect(onNewSession).toHaveBeenCalledWith('claude')
  })
})
