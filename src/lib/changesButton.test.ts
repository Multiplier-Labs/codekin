/** Tests for changesButtonState — the Changes button shows for uncommitted files, branch commits or a live edit, with a count and a readable tooltip. */
import { describe, it, expect } from 'vitest'
import { changesButtonState } from './changesButton'

describe('changesButtonState', () => {
  it('stays hidden with nothing to review', () => {
    expect(changesButtonState(false, null)).toEqual({ show: false, count: 0, detail: '' })
    expect(changesButtonState(false, { uncommittedFiles: 0, branchCommits: 0 }).show).toBe(false)
    expect(changesButtonState(false, { uncommittedFiles: 0, branchCommits: null }).show).toBe(false)
  })

  it('shows for committed work with a clean tree — the case the old button missed', () => {
    expect(changesButtonState(false, { uncommittedFiles: 0, branchCommits: 3 })).toEqual({
      show: true, count: 3, detail: '3 commits on this branch',
    })
  })

  it('prefers the uncommitted file count and describes both', () => {
    expect(changesButtonState(false, { uncommittedFiles: 1, branchCommits: 2 })).toEqual({
      show: true, count: 1, detail: '1 file with uncommitted changes, 2 commits on this branch',
    })
  })

  it('still shows right after a live edit before the summary arrives', () => {
    expect(changesButtonState(true, null)).toEqual({ show: true, count: 0, detail: '' })
  })
})
