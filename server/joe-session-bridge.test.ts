/** Tests for JoeSessionBridge — @Joe requests, replies, milestones and execution handover. */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { JoeSessionBridge, JoeBridgeError } from './joe-session-bridge.js'
import { OrchestratorTaskService } from './orchestrator-tasks.js'
import { TaskStore } from './task-store.js'
import type { SessionManager } from './session-manager.js'
import type { Session, WsServerMessage } from './types.js'

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'fix login',
    workingDir: '/repos/app/.worktrees/s1',
    groupDir: '/repos/app',
    worktreeBranch: 'fix/login',
    created: '2026-09-30T09:00:00Z',
    source: 'manual',
    outputHistory: [],
    pendingToolApprovals: new Map(),
    pendingControlRequests: new Map(),
    ...overrides,
  } as Session
}

describe('JoeSessionBridge', () => {
  let session: Session
  let sessions: Map<string, Session>
  let notes: { label: string; title: string; body: string }[]
  let sent: { id: string; text: string }[]
  let joeUnavailable: string | null
  let tasks: OrchestratorTaskService
  let bridge: JoeSessionBridge

  beforeEach(() => {
    session = fakeSession({
      outputHistory: [
        { type: 'user_echo', text: 'The login redirect loops' },
        { type: 'output', data: 'I found the bug in ' },
        { type: 'output', data: 'auth.ts.' },
        { type: 'result' },
      ] as WsServerMessage[],
    })
    sessions = new Map([[session.id, session]])
    notes = []
    sent = []
    joeUnavailable = null
    const manager = {
      get: (id: string) => sessions.get(id),
      addToHistory: (s: Session, msg: WsServerMessage) => { s.outputHistory.push(msg) },
      broadcast: vi.fn(),
      persistToDisk: vi.fn(),
      notifySessionsUpdated: vi.fn(),
      sendInput: (id: string, text: string) => { sent.push({ id, text }) },
    } as unknown as SessionManager
    let postMilestone: ((...args: Parameters<JoeSessionBridge['postMilestone']>) => void) | null = null
    tasks = new OrchestratorTaskService({
      store: new TaskStore(':memory:'),
      notify: () => true,
      onMilestone: (task, milestone) => postMilestone?.(task, milestone),
    })
    bridge = new JoeSessionBridge({
      sessions: manager,
      tasks,
      notifyJoe: (args) => { notes.push(args); return true },
      ensureJoe: () => joeUnavailable,
      agentName: () => 'Joe',
    })
    postMilestone = (task, milestone) => bridge.postMilestone(task, milestone)
  })

  const joeMessages = () => session.outputHistory.filter((m): m is Extract<WsServerMessage, { type: 'joe_message' }> => m.type === 'joe_message')

  it('records an @Joe request in the session and hands Joe the context', () => {
    const { requestId } = bridge.askJoe('s1', 'supervise this fix through to a verified PR')
    expect(joeMessages()).toEqual([expect.objectContaining({ role: 'to_joe', text: 'supervise this fix through to a verified PR', requestId })])
    expect(notes).toHaveLength(1)
    expect(notes[0].label).toBe('Session Request')
    expect(notes[0].body).toContain('Repo: /repos/app')
    expect(notes[0].body).toContain(`Request id: ${requestId}`)
    expect(notes[0].body).toContain('User: The login redirect loops')
    expect(notes[0].body).toContain('Agent: I found the bug in auth.ts.')
    // Nothing reaches the coding agent.
    expect(sent).toEqual([])
  })

  it('tells the user in the session when Joe cannot be reached', () => {
    joeUnavailable = 'Agent Joe needs an agent before it can help — choose one in Tasks.'
    bridge.askJoe('s1', 'what are you monitoring here?')
    expect(joeMessages().at(-1)).toMatchObject({ role: 'joe', notice: true, text: expect.stringContaining('choose one in Tasks') })
    expect(notes).toHaveLength(0)
  })

  it('posts Joe replies and task milestones into the originating conversation', () => {
    const { requestId } = bridge.askJoe('s1', 'turn the findings into tasks')
    bridge.reply('s1', 'Two tasks created.', { requestId })
    const [task] = tasks.create([{ repo: '/repos/app', title: 'Fix redirect', createdBy: 'joe', originSessionId: 's1', originRequestId: requestId }])
    tasks.requestDecision(task.id, { question: 'Change the cookie domain?', options: ['Yes', 'No'] })

    const posted = joeMessages().filter(m => m.role === 'joe')
    expect(posted.map(m => m.milestone ?? 'reply')).toEqual(['reply', 'accepted', 'decision'])
    expect(posted[2].task).toMatchObject({ id: task.id, decision: { question: 'Change the cookie domain?', options: ['Yes', 'No'] } })
  })

  it('does not post milestones into archived or unknown sessions', () => {
    session.archivedAt = '2026-09-30T10:00:00Z'
    tasks.create([{ repo: '/repos/app', title: 'Fix redirect', createdBy: 'joe', originSessionId: 's1' }])
    tasks.create([{ repo: '/repos/app', title: 'Other', createdBy: 'joe', originSessionId: 'gone' }])
    expect(joeMessages()).toHaveLength(0)
  })

  describe('execution handover', () => {
    it('lets Joe take over only on an explicit request from that session', () => {
      expect(() => bridge.handOver('s1', { actor: 'joe', requestId: 'made-up' })).toThrow(JoeBridgeError)
      const { requestId } = bridge.askJoe('s1', 'hand this over to you')
      const controller = bridge.handOver('s1', { actor: 'joe', requestId })
      expect(controller).toMatchObject({ owner: 'joe', revision: 1 })
      expect(notes.at(-1)?.label).toBe('Session Handed Over')
    })

    it('fences instructions issued before the user took back control', () => {
      const { revision } = bridge.handOver('s1', { actor: 'user' })
      bridge.sendAsController('s1', 'Run the auth tests', revision)
      expect(sent).toEqual([{ id: 's1', text: 'Run the auth tests' }])
      expect(joeMessages().at(-1)).toMatchObject({ role: 'joe', instruction: true })

      bridge.takeBack('s1')
      expect(() => bridge.sendAsController('s1', 'Push the branch', revision)).toThrow(/user has control/)

      // Handing over again does not revive the old revision.
      const again = bridge.handOver('s1', { actor: 'user' })
      expect(again.revision).toBe(revision + 2)
      expect(() => bridge.sendAsController('s1', 'Push the branch', revision)).toThrow(/Control changed/)
      expect(sent).toHaveLength(1)
    })

    it('treats Joe\'s own children as Joe-controlled until the user takes them back', () => {
      sessions.set('c1', fakeSession({ id: 'c1', source: 'agent' }))
      expect(bridge.controllerOf('c1').owner).toBe('joe')
      expect(bridge.takeBack('c1')).toMatchObject({ owner: 'user', revision: 1 })
    })

    it('refuses instructions while the session waits on a prompt', () => {
      const { revision } = bridge.handOver('s1', { actor: 'user' })
      session.pendingToolApprovals.set('r1', {} as never)
      expect(() => bridge.sendAsController('s1', 'continue', revision)).toThrow(/waiting on a prompt/)
    })
  })

  it('refuses to treat Joe\'s own session as a repo session', () => {
    sessions.set('joe', fakeSession({ id: 'joe', source: 'orchestrator' }))
    expect(() => bridge.askJoe('joe', 'hi')).toThrow(JoeBridgeError)
  })
})
