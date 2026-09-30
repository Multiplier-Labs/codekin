// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JoeTasksView } from './JoeTasksView'
import * as tasksApi from '../lib/tasksApi'
import type { JoeTask, TaskList, TaskStatus } from '../lib/tasksApi'

vi.mock('../lib/tasksApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tasksApi')>()
  return {
    ...actual,
    answerDecision: vi.fn(async () => ({})),
    acceptTask: vi.fn(async () => ({})),
    requestChanges: vi.fn(async () => ({})),
    setTaskStatus: vi.fn(async () => ({})),
    startTask: vi.fn(async () => ({})),
    delegateTasks: vi.fn(async () => []),
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function task(status: TaskStatus, overrides: Partial<JoeTask> = {}): JoeTask {
  return {
    id: `t-${status}`, repo: '/repos/app', title: `Task ${status}`, detail: '', acceptance: '', priority: 'normal',
    source: 'user', sourceRef: null, status, completionPolicy: 'pr', childId: null, childIds: [], prUrl: null,
    commit: null, verification: null, decision: null, reviewNote: null, createdBy: 'user',
    createdAt: '2026-09-30T10:00:00Z', updatedAt: '2026-09-30T10:00:00Z', closedAt: null, ...overrides,
  }
}

function list(tasks: JoeTask[]): TaskList {
  const counts = { todo: 0, in_progress: 0, needs_decision: 0, in_review: 0, done: 0, dismissed: 0 }
  for (const t of tasks) counts[t.status]++
  return { tasks, counts }
}

let root: Root
let container: HTMLDivElement
const onChanged = vi.fn()
const onOpenSession = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
})

async function render(data: TaskList | null) {
  await act(async () => {
    root.render(
      <JoeTasksView
        token="tok" data={data} error={null} repos={[]} repoFilter="" onRepoFilterChange={() => {}}
        onChanged={onChanged} onOpenSession={onOpenSession}
      />,
    )
  })
}

const button = (label: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim().startsWith(label))
const sectionTitles = () => Array.from(container.querySelectorAll('section')).map(s => s.getAttribute('aria-label'))

describe('JoeTasksView', () => {
  it('invites delegation when there are no tasks', async () => {
    await render(list([]))
    expect(container.textContent).toContain('No tasks yet')
  })

  it('orders sections by what needs the user first', async () => {
    await render(list([task('todo'), task('in_progress'), task('in_review'), task('needs_decision', { decision: null })]))
    expect(sectionTitles()).toEqual(['Needs your decision', 'Ready for review', 'Running', 'To do'])
  })

  it('keeps queued work apart from running work', async () => {
    await render(list([
      task('in_progress', { id: 'live', execution: 'running' }),
      task('in_progress', { id: 'answered', title: 'Answered, waiting for Joe', execution: 'queued' }),
      task('todo', { id: 'start-requested', title: 'Start requested', execution: 'queued' }),
      task('todo', { id: 'idle', execution: 'idle' }),
    ]))
    expect(sectionTitles()).toEqual(['Running', 'Queued', 'To do'])
    const queued = container.querySelector('section[aria-label="Queued"]')!
    expect(queued.textContent).toContain('Answered, waiting for Joe')
    expect(queued.textContent).toContain('Start requested')
    // A queued start cannot be started twice.
    expect(Array.from(queued.querySelectorAll('button')).some(b => b.textContent === 'Start')).toBe(false)
  })

  it('answers a decision with a one-click option or free text', async () => {
    const decision = { question: 'Change the public API?', recommendation: 'Add an overload', options: ['Change it', 'Add overload'], askedBy: 'joe' as const, askedAt: 'now', answer: null, answeredAt: null }
    await render(list([task('needs_decision', { decision })]))
    expect(container.textContent).toContain('Recommendation: Add an overload')

    await act(async () => { button('Add overload')!.click() })
    expect(tasksApi.answerDecision).toHaveBeenCalledWith('tok', 't-needs_decision', 'Add overload')
    expect(onChanged).toHaveBeenCalled()

    const input = container.querySelector('input[aria-label^="Answer for"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Keep it backwards compatible')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.form!.requestSubmit() })
    expect(tasksApi.answerDecision).toHaveBeenLastCalledWith('tok', 't-needs_decision', 'Keep it backwards compatible')
  })

  it('shows review evidence and accepts', async () => {
    await render(list([task('in_review', {
      prUrl: 'https://github.com/o/r/pull/7', commit: 'abc123def4567890', childId: 'child-1', childIds: ['child-1'],
      verification: { state: 'verified', commit: 'abc123def4567890', prUrl: 'https://github.com/o/r/pull/7', detail: 'pull request is open at the branch HEAD', checkedAt: 'now' },
    })]))
    expect(container.querySelector('a[href="https://github.com/o/r/pull/7"]')).not.toBeNull()
    expect(container.textContent).toContain('abc123def456')
    expect(container.textContent).toContain('open at the branch HEAD')

    await act(async () => { button('Accept')!.click() })
    expect(tasksApi.acceptTask).toHaveBeenCalledWith('tok', 't-in_review')

    await act(async () => { button('Session')!.click() })
    expect(onOpenSession).toHaveBeenCalledWith('child-1')
  })

  it('starts or dismisses a to-do task and reopens a closed one', async () => {
    await render(list([task('todo'), task('done')]))
    await act(async () => { button('Start')!.click() })
    expect(tasksApi.startTask).toHaveBeenCalledWith('tok', 't-todo')
    await act(async () => { button('Dismiss')!.click() })
    expect(tasksApi.setTaskStatus).toHaveBeenCalledWith('tok', 't-todo', 'dismissed')
    await act(async () => { button('Reopen')!.click() })
    expect(tasksApi.setTaskStatus).toHaveBeenCalledWith('tok', 't-done', 'todo')
  })

  it('surfaces action failures', async () => {
    vi.mocked(tasksApi.acceptTask).mockRejectedValueOnce(new Error('Only tasks ready for review can be accepted'))
    await render(list([task('in_review')]))
    await act(async () => { button('Accept')!.click() })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Only tasks ready for review')
  })

  it('delegates one task per line from the dialog', async () => {
    await render(list([task('todo')]))
    await act(async () => { button('New task')!.click() })
    const dialog = container.querySelector('[role="dialog"]')!
    const textarea = dialog.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, '- Fix login\n- Bump lodash')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = Array.from(dialog.querySelectorAll('button[type="submit"]'))[0] as HTMLButtonElement
    expect(submit.textContent).toContain('Delegate 2 tasks')
    await act(async () => { submit.click() })
    expect(tasksApi.delegateTasks).toHaveBeenCalledWith('tok', {
      repo: '/repos/app', tasks: [{ title: 'Fix login' }, { title: 'Bump lodash' }], acceptance: undefined, completionPolicy: 'pr',
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(onChanged).toHaveBeenCalled()
  })
})
