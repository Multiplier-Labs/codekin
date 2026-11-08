// @vitest-environment jsdom
/** Tests for Joe's messages in a session: attribution and one decision record across surfaces. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JoeChatMessage } from './JoeChatMessage'
import * as tasksApi from '../lib/tasksApi'
import type { JoeTask } from '../lib/tasksApi'

vi.mock('../lib/tasksApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tasksApi')>()),
  answerDecision: vi.fn(async () => ({})),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.clearAllMocks()
})

const snapshot = { id: 't1', title: 'Fix redirect', status: 'needs_decision', prUrl: null, decision: { question: 'Change the cookie domain?', recommendation: 'Yes', options: ['Yes', 'No'] } }

function liveTask(overrides: Partial<JoeTask>): JoeTask {
  return {
    id: 't1', repo: '/r', title: 'Fix redirect', detail: '', acceptance: '', priority: 'normal', source: 'joe', sourceRef: null,
    status: 'needs_decision', completionPolicy: 'pr', childId: null, childIds: [], prUrl: null, commit: null, verification: null,
    decision: { question: 'Change the cookie domain?', recommendation: 'Yes', options: ['Yes', 'No'], askedBy: 'joe', askedAt: 'now', answer: null, answeredAt: null },
    reviewNote: null, createdBy: 'joe', createdAt: 'now', updatedAt: 'now', closedAt: null, ...overrides,
  }
}

async function render(tasks: Record<string, JoeTask>, onTaskChanged = vi.fn()) {
  await act(async () => {
    root.render(
      <JoeChatMessage
        msg={{ type: 'joe', role: 'joe', milestone: 'decision', text: 'I need a decision.', task: snapshot }}
        fontSize={14}
        ctx={{ token: 'tok', agentName: 'Joe', tasks, onTaskChanged }}
      />,
    )
  })
  return onTaskChanged
}

describe('JoeChatMessage', () => {
  it('shows a remote image as a link instead of loading it', async () => {
    await act(async () => {
      root.render(<JoeChatMessage msg={{ type: 'joe', role: 'joe', text: 'see ![chart](https://attacker.example/?d=1)' }} fontSize={14} ctx={{ token: 'tok', agentName: 'Joe', tasks: {} }} />)
    })
    expect(container.querySelector('img')).toBeNull()
    const link = container.querySelector('a[href="https://attacker.example/?d=1"]')
    expect(link?.textContent).toBe('External image: chart (attacker.example)')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('attributes the user\'s request to Joe', async () => {
    await act(async () => {
      root.render(<JoeChatMessage msg={{ type: 'joe', role: 'to_joe', text: 'supervise this' }} fontSize={14} ctx={{ token: 'tok', agentName: 'Joe', tasks: {} }} />)
    })
    expect(container.textContent).toContain('You → Agent Joe')
  })

  it('answers the open decision from the conversation', async () => {
    const changed = await render({ t1: liveTask({}) })
    expect(container.textContent).toContain('Agent Joe')
    const yes = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Yes')!
    await act(async () => { yes.click() })
    expect(tasksApi.answerDecision).toHaveBeenCalledWith('tok', 't1', 'Yes')
    expect(changed).toHaveBeenCalled()
  })

  it('shows a decision answered elsewhere as answered, not as open', async () => {
    await render({ t1: liveTask({ status: 'in_progress', execution: 'queued', decision: { question: 'Change the cookie domain?', recommendation: 'Yes', options: ['Yes', 'No'], askedBy: 'joe', askedAt: 'now', answer: 'No', answeredAt: 'now' } }) })
    expect(Array.from(container.querySelectorAll('button')).some(b => b.textContent === 'Yes')).toBe(false)
    expect(container.textContent).toContain('Answered: No')
    expect(container.textContent).toContain('queued')
  })
})
