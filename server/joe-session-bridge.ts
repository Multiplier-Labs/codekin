/**
 * Agent Joe inside repo sessions
 * (docs/JOE-REPO-COLLABORATION-MAINTENANCE-SPEC.md §3–§5).
 *
 * One composer, two recipients: ordinary messages go to the session's coding
 * agent; an `@Joe` message is recorded in the session's transcript, attributed
 * to Joe, and delivered to Joe as a durable notification carrying the repo,
 * the session, recent conversation and linked tasks. Joe answers into the same
 * conversation with `reply_in_session`. Joe's exchanges live in the Codekin
 * transcript only — they never reach the coding agent's context.
 *
 * Execution ownership: a session has one controller. Handing over to Joe (by
 * the user, or by Joe acting on an explicit @Joe request) and taking back
 * control each bump the controller revision; Joe's instructions carry the
 * revision they were issued under, so a queued instruction from before a
 * take-back is refused rather than delivered.
 */

import { randomUUID } from 'crypto'
import type { SessionManager } from './session-manager.js'
import type { Session, SessionController, WsServerMessage } from './types.js'
import type { OrchestratorTaskService, TaskMilestone } from './orchestrator-tasks.js'
import type { Task } from './task-store.js'

export class JoeBridgeError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 503) {
    super(message)
    this.name = 'JoeBridgeError'
  }
}

export type JoeMessage = Extract<WsServerMessage, { type: 'joe_message' }>

export interface JoeSessionBridgeDeps {
  sessions: SessionManager
  tasks: OrchestratorTaskService
  /** Deliver a notification to Joe through the durable outbox. */
  notifyJoe: (args: { label: string; title: string; body: string }) => boolean
  /** Make sure Joe's process is up; returns why not when it cannot be started. */
  ensureJoe: () => string | null
  agentName: () => string
}

/** Characters of recent conversation included with an @Joe request. */
const REQUEST_CONTEXT_CHARS = 6000
/** An @Joe request older than this cannot authorize a handover. */
const HANDOVER_REQUEST_TTL_MS = 24 * 60 * 60_000

/** The controller a session has when none was ever set. */
export function effectiveController(session: Pick<Session, 'controller' | 'source' | 'created'>): SessionController {
  return session.controller ?? { owner: session.source === 'agent' ? 'joe' : 'user', revision: 0, since: session.created }
}

export class JoeSessionBridge {
  constructor(private readonly deps: JoeSessionBridgeDeps) {}

  private requireSession(sessionId: string): Session {
    const session = this.deps.sessions.get(sessionId)
    if (!session) throw new JoeBridgeError('Session not found', 404)
    if (session.source === 'orchestrator') throw new JoeBridgeError('That is Joe\'s own session', 400)
    return session
  }

  private post(session: Session, msg: Omit<JoeMessage, 'type' | 'id' | 'ts'>): JoeMessage {
    const full: JoeMessage = { type: 'joe_message', id: randomUUID(), ts: new Date().toISOString(), ...msg }
    this.deps.sessions.addToHistory(session, full)
    this.deps.sessions.broadcast(session, full)
    return full
  }

  private repoOf(session: Session): string {
    return session.groupDir ?? session.workingDir
  }

  // -------------------------------------------------------------------------
  // Conversation
  // -------------------------------------------------------------------------

  /** The user addressed Joe in a repo session. */
  askJoe(sessionId: string, rawText: string): { requestId: string } {
    const session = this.requireSession(sessionId)
    const text = rawText.trim()
    if (!text) throw new JoeBridgeError('Say what you want Joe to do', 400)
    const requestId = randomUUID()
    this.post(session, { role: 'to_joe', text, requestId })

    const unavailable = this.deps.ensureJoe()
    if (unavailable) {
      this.post(session, { role: 'joe', text: unavailable, requestId, notice: true })
      return { requestId }
    }

    const tasks = this.deps.tasks.list({ originSessionId: session.id }).tasks
      .filter(t => t.status !== 'done' && t.status !== 'dismissed')
    const controller = effectiveController(session)
    const body = [
      `Repo: ${this.repoOf(session)}`,
      `Session: ${session.id} (${session.name})${session.worktreeBranch ? ` on branch ${session.worktreeBranch}` : ''}`,
      `Request id: ${requestId}`,
      controller.owner === 'joe' ? `You currently control this session's execution (controller revision ${controller.revision}).` : null,
      tasks.length
        ? `Linked tasks:\n${tasks.map(t => `- ${t.id} [${t.status}${t.execution !== 'idle' ? `, ${t.execution}` : ''}] ${t.title}`).join('\n')}`
        : null,
      '',
      'The user wrote:',
      text,
      '',
      'Recent conversation in that session:',
      this.transcript(session, REQUEST_CONTEXT_CHARS) || '(nothing yet)',
      '',
      `Answer with reply_in_session (sessionId ${session.id}, requestId ${requestId}) — your reply appears in that conversation, attributed to you. The coding agent does not see it.`,
      'For execution work, create_task with originSessionId and originRequestId so its updates reach this session. Do not ask for details already agreed above; get_session_context reads more of the session if you need it.',
    ].filter((l): l is string => l !== null).join('\n')

    this.deps.notifyJoe({ label: 'Session Request', title: `@${this.deps.agentName()} in ${session.name}`, body })
    return { requestId }
  }

  /** Joe answers in a repo session's conversation. */
  reply(sessionId: string, text: string, opts: { requestId?: string; taskId?: string } = {}): JoeMessage {
    const session = this.requireSession(sessionId)
    if (!text.trim()) throw new JoeBridgeError('Empty reply', 400)
    let task: JoeMessage['task']
    if (opts.taskId) {
      const found = this.deps.tasks.get(opts.taskId)
      if (!found) throw new JoeBridgeError('Task not found', 404)
      task = taskSummary(found)
    }
    return this.post(session, { role: 'joe', text: text.trim(), requestId: opts.requestId, task })
  }

  /** Post a task milestone into the conversation the task came from. */
  postMilestone(task: Task, milestone: TaskMilestone): void {
    if (!task.originSessionId) return
    const session = this.deps.sessions.get(task.originSessionId)
    // Archived or deleted origins: Tasks remains the durable destination.
    if (!session || session.archivedAt) return
    this.post(session, { role: 'joe', milestone, text: milestoneText(task, milestone), requestId: task.originRequestId ?? undefined, task: taskSummary(task) })
  }

  /** Recent conversation for Joe (get_session_context). */
  context(sessionId: string, limit = 10_000): { sessionId: string; name: string; repo: string; branch: string | null; controller: SessionController; transcript: string; tasks: { id: string; title: string; status: string }[] } {
    const session = this.requireSession(sessionId)
    return {
      sessionId: session.id,
      name: session.name,
      repo: this.repoOf(session),
      branch: session.worktreeBranch ?? null,
      controller: effectiveController(session),
      transcript: this.transcript(session, Math.min(Math.max(limit, 500), 50_000)),
      tasks: this.deps.tasks.list({ originSessionId: session.id }).tasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
    }
  }

  private transcript(session: Session, maxChars: number): string {
    const lines: string[] = []
    let assistant = ''
    const flush = () => {
      if (assistant.trim()) lines.push(`Agent: ${assistant.trim()}`)
      assistant = ''
    }
    for (const msg of session.outputHistory) {
      if (msg.type === 'output') {
        assistant += msg.data
        continue
      }
      if (msg.type === 'user_echo') { flush(); lines.push(`User: ${msg.text}`) }
      else if (msg.type === 'joe_message') { flush(); lines.push(`${msg.role === 'to_joe' ? `User → ${this.deps.agentName()}` : this.deps.agentName()}: ${msg.text}`) }
      else if (msg.type === 'result') flush()
    }
    flush()
    const text = lines.join('\n')
    return text.length > maxChars ? `…${text.slice(-maxChars)}` : text
  }

  // -------------------------------------------------------------------------
  // Execution ownership
  // -------------------------------------------------------------------------

  controllerOf(sessionId: string): SessionController {
    return effectiveController(this.requireSession(sessionId))
  }

  /**
   * Hand a session's execution to Joe. The user may do it directly; Joe only
   * on an explicit @Joe request from that session (the request authorizes it).
   */
  handOver(sessionId: string, opts: { actor: 'user' | 'joe'; requestId?: string; taskId?: string }): SessionController {
    const session = this.requireSession(sessionId)
    if (session.archivedAt) throw new JoeBridgeError('The session is archived', 409)
    if (opts.actor === 'joe') {
      if (!opts.requestId || !this.hasRecentRequest(session, opts.requestId)) {
        throw new JoeBridgeError('Taking over needs the user\'s explicit @Joe request in that session — pass its requestId', 403)
      }
    }
    if (opts.taskId && !this.deps.tasks.get(opts.taskId)) throw new JoeBridgeError('Task not found', 404)
    const current = effectiveController(session)
    if (current.owner === 'joe') return current
    const next: SessionController = { owner: 'joe', revision: current.revision + 1, taskId: opts.taskId, since: new Date().toISOString() }
    this.setController(session, next, `${this.deps.agentName()} is now coordinating this session${opts.taskId ? ' for its task' : ''}.`)
    this.deps.notifyJoe({
      label: 'Session Handed Over',
      title: `You now control session ${session.name}`,
      body: [
        `Session: ${session.id} in ${this.repoOf(session)}`,
        `Controller revision: ${next.revision} — pass it to send_to_session.`,
        opts.taskId ? `Task: ${opts.taskId}` : null,
        'Drive the work through to its result. If the user takes back control, your instructions are refused.',
      ].filter((l): l is string => l !== null).join('\n'),
    })
    return next
  }

  /** The user takes execution back; later Joe instructions are fenced. */
  takeBack(sessionId: string): SessionController {
    const session = this.requireSession(sessionId)
    const current = effectiveController(session)
    if (current.owner === 'user') return current
    const next: SessionController = { owner: 'user', revision: current.revision + 1, since: new Date().toISOString() }
    this.setController(session, next, `You took back control. ${this.deps.agentName()} will no longer instruct this session; its tasks and history remain.`)
    this.deps.notifyJoe({
      label: 'Control Taken Back',
      title: `The user took back control of session ${session.name}`,
      body: `Session: ${session.id}\nDo not send it further instructions. Its task stays on your list; ask in the session if you need to know what next.`,
    })
    return next
  }

  /** Joe instructs a session it controls. */
  sendAsController(sessionId: string, text: string, revision: number): void {
    const session = this.requireSession(sessionId)
    const current = effectiveController(session)
    if (current.owner !== 'joe') throw new JoeBridgeError('The user has control of this session — ask in the conversation instead', 409)
    if (revision !== current.revision) {
      throw new JoeBridgeError(`Control changed since this instruction was issued (revision ${current.revision}, instruction had ${revision})`, 409)
    }
    if (session.pendingToolApprovals.size > 0 || session.pendingControlRequests.size > 0) {
      throw new JoeBridgeError('The session is waiting on a prompt — answer it with respond_to_prompt first', 409)
    }
    if (!text.trim()) throw new JoeBridgeError('Empty instruction', 400)
    this.post(session, { role: 'joe', text: text.trim(), instruction: true })
    this.deps.sessions.sendInput(sessionId, text.trim())
  }

  private setController(session: Session, controller: SessionController, notice: string): void {
    session.controller = controller
    this.deps.sessions.persistToDisk()
    this.post(session, { role: 'joe', text: notice, notice: true })
    this.deps.sessions.notifySessionsUpdated()
  }

  private hasRecentRequest(session: Session, requestId: string): boolean {
    const cutoff = Date.now() - HANDOVER_REQUEST_TTL_MS
    return session.outputHistory.some(m =>
      m.type === 'joe_message' && m.role === 'to_joe' && m.requestId === requestId && new Date(m.ts).getTime() >= cutoff)
  }
}

function taskSummary(task: Task): NonNullable<JoeMessage['task']> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    prUrl: task.prUrl,
    decision: task.decision && task.decision.answer === null
      ? { question: task.decision.question, recommendation: task.decision.recommendation, options: task.decision.options }
      : null,
  }
}

function milestoneText(task: Task, milestone: TaskMilestone): string {
  switch (milestone) {
    case 'accepted': return `Task created: ${task.title}. I'll post here when it needs you or is ready.`
    case 'decision': return `I need a decision on "${task.title}": ${task.decision?.question ?? ''}`.trim()
    case 'blocked': return `"${task.title}" is blocked: ${task.decision?.question ?? 'the attempt ended without verified work.'}`
    case 'review': return `"${task.title}" is ready for review${task.prUrl ? ` — ${task.prUrl}` : ''}.`
  }
}
