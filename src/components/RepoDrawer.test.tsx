/**
 * Tests for RepoDrawer — the drawer is a flex sibling of the transcript, so the
 * regression guarded here is it rendering without a width and collapsing to
 * nothing when the sidebar deep-links a tab.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { RepoDrawer, type RepoDrawerProps } from './RepoDrawer.js'

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

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  if (activeRoot) act(() => activeRoot!.unmount())
  activeContainer?.remove()
  activeRoot = null
  activeContainer = null
})

const baseProps: RepoDrawerProps = {
  token: 't',
  workingDir: '/srv/repos/codekin',
  repoName: 'codekin',
  open: true,
  onClose: () => {},
  docsFiles: [{ path: 'README.md', pinned: false }],
  docsLoading: false,
  starredDocs: [],
  onSelectDoc: () => {},
  archiveRefreshKey: 0,
  onViewArchivedSession: () => {},
  onNewSessionFromArchive: () => {},
  fontSize: 14,
}

function panelOf(container: HTMLElement): HTMLElement {
  const panel = container.querySelector<HTMLElement>('.\\@container')
  if (!panel) throw new Error('drawer panel not found')
  return panel
}

describe('RepoDrawer', () => {
  it('renders nothing when closed', () => {
    const container = render(<RepoDrawer {...baseProps} open={false} />)
    expect(container.textContent).toBe('')
  })

  it('gives the panel an explicit width so it cannot collapse beside the transcript', () => {
    const container = render(<RepoDrawer {...baseProps} initialTab="docs" />)
    const panel = panelOf(container)
    expect(parseInt(panel.style.width, 10)).toBeGreaterThanOrEqual(240)
    expect(panel.className).toContain('flex-shrink-0')
  })

  it('restores a persisted width, clamped to the allowed range', () => {
    localStorage.setItem('codekin-repo-drawer-width', '9999')
    const container = render(<RepoDrawer {...baseProps} />)
    expect(parseInt(panelOf(container).style.width, 10)).toBe(600)
  })

  it('opens on the deep-linked tab from the sidebar menu', () => {
    const container = render(<RepoDrawer {...baseProps} initialTab="approvals" />)
    const selected = container.querySelector('[role="tab"][aria-selected="true"]')
    expect(selected?.id).toBe('repo-drawer-tab-approvals')
  })

  it('takes over the viewport on mobile instead of docking', () => {
    const container = render(<RepoDrawer {...baseProps} isMobile />)
    expect(container.firstElementChild?.className).toContain('fixed')
    expect(panelOf(container).style.width).toBe('')
  })
})
