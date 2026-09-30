/** Tests for PrStatusCard — verifies PR state and checks, local-vs-checked warnings, unknown states never shown as passing, stale results and the multi-PR picker. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { PrStatusCard } from './PrStatusCard.js'
import type { PrStatus, PullRequestInfo } from '../../types'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

function render(status: PrStatus | null, narrow = false): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<PrStatusCard status={status} narrow={narrow} />)
  })
  return container
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

const pull = (extra: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  number: 12, title: 'Add login', url: 'https://github.com/o/r/pull/12', state: 'OPEN', isDraft: false,
  baseRefName: 'main', headRefName: 'feat/login', headRefOid: 'abc', isCrossRepository: false,
  updatedAt: '2026-09-29T10:00:00Z', checks: { total: 4, passed: 2, failed: 1, pending: 1, skipped: 0, failing: ['test'] },
  ahead: 0, behind: 0, ...extra,
})
const found = (pulls: PullRequestInfo[], extra: Partial<PrStatus> = {}): PrStatus => ({
  state: 'found', branch: 'feat/login', pulls, dirty: false, fetchedAt: new Date().toISOString(), ...extra,
})

describe('PrStatusCard', () => {
  it('shows the PR, its state, checks and a GitHub link, without repeating the branch', () => {
    const c = render(found([pull({ reviewDecision: 'APPROVED' })]))

    expect(c.textContent).toContain('#12 Add login')
    expect(c.textContent).toContain('open')
    expect(c.textContent).not.toContain('feat/login')
    expect(c.textContent).toContain('2 passed')
    expect(c.textContent).toContain('1 failed')
    expect(c.textContent).toContain('checked just now')
    expect(c.textContent).toContain('Failing: test')
    expect(c.textContent).toContain('approved')
    expect(c.querySelector('a')?.getAttribute('href')).toBe('https://github.com/o/r/pull/12')
    expect(c.textContent).not.toContain('not pushed')
  })

  it('labels drafts and merged PRs', () => {
    expect(render(found([pull({ isDraft: true })])).textContent).toContain('draft')
    act(() => root!.unmount()); container!.remove(); root = null
    expect(render(found([pull({ state: 'MERGED' })])).textContent).toContain('merged')
  })

  it('warns when local work is not what the checks ran on', () => {
    const c = render(found([pull({ ahead: 2, behind: 1, isCrossRepository: true, headOwner: 'someone' })], { dirty: true }))

    expect(c.textContent).toContain('2 local commits not pushed')
    expect(c.textContent).toContain('The PR has 1 commit not in this checkout')
    expect(c.textContent).toContain('Uncommitted local edits are not checked')
    expect(c.textContent).toContain('From fork someone')
  })

  it('says when the PR head cannot be compared', () => {
    expect(render(found([pull({ ahead: null, behind: null })])).textContent).toContain('not fetched here')
  })

  it('shows unknown states as unknown, never as passing', () => {
    const c = render({ state: 'unauthenticated', message: 'The GitHub CLI is not signed in.', pulls: [], dirty: false, fetchedAt: '' })

    expect(c.textContent).toContain('Pull request status unknown: The GitHub CLI is not signed in.')
    expect(c.querySelector('svg.tabler-icon-circle-check')).toBeNull()
  })

  it('shows a plain note when there is no PR', () => {
    const c = render({ state: 'none', message: 'No pull request found for feat/login.', pulls: [], dirty: false, fetchedAt: '' })

    expect(c.textContent).toContain('No pull request found for feat/login.')
    expect(c.textContent).not.toContain('unknown')
  })

  it('marks a stale result', () => {
    expect(render(found([pull()], { staleReason: 'Could not refresh: GitHub rate limit reached.' })).textContent)
      .toContain('Could not refresh: GitHub rate limit reached.')
  })

  it('summarises passing checks in words', () => {
    const c = render(found([pull({ checks: { total: 2, passed: 2, failed: 0, pending: 0, skipped: 0, failing: [] } })]))
    expect(c.textContent).toContain('2 checks passed')
  })

  it('puts the title on its own line when narrow', () => {
    const c = render(found([pull({ state: 'MERGED' })]), true)
    const lines = [...c.firstElementChild!.children].map(el => el.textContent)
    expect(lines[0]).toContain('#12')
    expect(lines[0]).toContain('merged')
    expect(lines[1]).toBe('Add login')
  })

  it('offers a picker when several PRs match and has no refresh of its own', () => {
    const c = render(found([pull(), pull({ number: 9, title: 'Old attempt', state: 'CLOSED' })]))

    const select = c.querySelector('select')!
    expect([...select.options].map(o => o.textContent)).toEqual(['#12 Add login (open)', '#9 Old attempt (closed)'])
    act(() => {
      select.value = '1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(c.querySelector('a')?.getAttribute('href')).toBe('https://github.com/o/r/pull/12')
    expect(c.textContent).toContain('closed')

    expect(c.querySelector('button[title="Refresh pull request status"]')).toBeNull()
  })

  it('renders nothing before the first lookup', () => {
    expect(render(null).textContent).toBe('')
  })
})
