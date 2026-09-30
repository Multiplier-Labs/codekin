import { describe, expect, it } from 'vitest'
import { attentionCount, parseTaskLines, repoName } from './tasksApi'

describe('parseTaskLines', () => {
  it('makes one task per non-empty line and strips list markers', () => {
    expect(parseTaskLines('- Fix login\n\n  2) Bump lodash  \n* Add docs\n• Tidy\n3. Last')).toEqual([
      { title: 'Fix login' }, { title: 'Bump lodash' }, { title: 'Add docs' }, { title: 'Tidy' }, { title: 'Last' },
    ])
  })

  it('caps titles at 300 characters', () => {
    expect(parseTaskLines('x'.repeat(400))[0].title).toHaveLength(300)
  })
})

describe('helpers', () => {
  it('counts decisions and reviews as waiting on the user', () => {
    expect(attentionCount({ todo: 4, in_progress: 2, needs_decision: 1, in_review: 2, done: 9, dismissed: 1 })).toBe(3)
    expect(attentionCount(null)).toBe(0)
  })

  it('shows the last path segment of a repo', () => {
    expect(repoName('/srv/repos/org/app/')).toBe('app')
  })
})
