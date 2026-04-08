/**
 * Prompt routing and tool approval logic extracted from SessionManager.
 *
 * Handles:
 * - Tool approval requests (PreToolUse hook path)
 * - Control request handling (abort/interrupt/auth via control_request path)
 * - Pending prompt tracking (pendingToolApprovals, pendingControlRequests)
 * - Auto-approval resolution (registry, session allowedTools, headless)
 * - Prompt UI message construction and broadcast
 */

import { randomUUID } from 'crypto'
import { ApprovalManager } from './approval-manager.js'
import type { ClaudeProcess } from './claude-process.js'
import type { PromptQuestion, Session, WsServerMessage } from './types.js'

/** Dependencies injected by SessionManager so PromptRouter can interact with session state. */
export interface PromptRouterDeps {
  getSession(id: string): Session | undefined
  allSessions(): Iterable<Session>
  broadcast(session: Session, msg: WsServerMessage): void
  addToHistory(session: Session, msg: WsServerMessage): void
  globalBroadcast(msg: WsServerMessage): void
  approvalManager: ApprovalManager
  promptListeners: Array<(sessionId: string, promptType: 'permission' | 'question', toolName: string | undefined, requestId: string | undefined) => void>
}

export class PromptRouter {
  private deps: PromptRouterDeps

  constructor(deps: PromptRouterDeps) {
    this.deps = deps
  }

  // ---------------------------------------------------------------------------
  // Pending prompts query
  // ---------------------------------------------------------------------------

  /** Get all sessions that have pending prompts (waiting for approval or answer). */
  getPendingPrompts(): Array<{
    sessionId: string
    sessionName: string
    source: string
    prompts: Array<{ requestId: string; promptType: 'permission' | 'question'; toolName: string; toolInput: Record<string, unknown> }>
  }> {
    const results: Array<{
      sessionId: string
      sessionName: string
      source: string
      prompts: Array<{ requestId: string; promptType: 'permission' | 'question'; toolName: string; toolInput: Record<string, unknown> }>
    }> = []

    for (const session of this.deps.allSessions()) {
      const prompts: Array<{ requestId: string; promptType: 'permission' | 'question'; toolName: string; toolInput: Record<string, unknown> }> = []

      for (const [reqId, pending] of session.pendingToolApprovals) {
        prompts.push({
          requestId: reqId,
          promptType: pending.toolName === 'AskUserQuestion' ? 'question' : 'permission',
          toolName: pending.toolName,
          toolInput: pending.toolInput,
        })
      }
      for (const [reqId, pending] of session.pendingControlRequests) {
        prompts.push({
          requestId: reqId,
          promptType: pending.toolName === 'AskUserQuestion' ? 'question' : 'permission',
          toolName: pending.toolName,
          toolInput: pending.toolInput,
        })
      }

      if (prompts.length > 0) {
        results.push({ sessionId: session.id, sessionName: session.name, source: session.source, prompts })
      }
    }
    return results
  }

  // ---------------------------------------------------------------------------
  // Event handlers (wired by SessionManager in wireClaudeEvents)
  // ---------------------------------------------------------------------------

  /** Handle a Claude process 'prompt' event. */
  onPromptEvent(
    session: Session,
    promptType: 'permission' | 'question',
    question: string,
    options: Array<{ label: string; value: string; description?: string }>,
    multiSelect: boolean | undefined,
    toolName: string | undefined,
    toolInput: Record<string, unknown> | undefined,
    requestId: string | undefined,
    questions: PromptQuestion[] | undefined,
  ): void {
    const promptMsg: WsServerMessage = {
      type: 'prompt',
      promptType,
      question,
      options,
      multiSelect,
      toolName,
      toolInput,
      requestId,
      ...(questions ? { questions } : {}),
    }
    if (requestId) {
      session.pendingControlRequests.set(requestId, { requestId, toolName: 'AskUserQuestion', toolInput: toolInput || {}, promptMsg })
    }
    this.deps.broadcast(session, promptMsg)

    // Notify prompt listeners (orchestrator, child monitor, etc.)
    for (const listener of this.deps.promptListeners) {
      try { listener(session.id, promptType, toolName, requestId) } catch { /* listener error */ }
    }
  }

  /** Handle a Claude process 'control_request' event. */
  onControlRequestEvent(
    cp: ClaudeProcess,
    session: Session,
    sessionId: string,
    requestId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): void {
    if (typeof requestId !== 'string' || !/^[\w-]{1,64}$/.test(requestId)) {
      console.warn(`[control_request] Rejected invalid requestId: ${JSON.stringify(requestId)}`)
      return
    }
    console.log(`[control_request] session=${sessionId} tool=${toolName} requestId=${requestId}`)

    if (this.resolveAutoApproval(session, toolName, toolInput) !== 'prompt') {
      console.log(`[control_request] auto-approved: ${toolName}`)
      cp.sendControlResponse(requestId, 'allow')
      return
    }

    // Prevent double-gating: if a PreToolUse hook is already handling approval
    // for this tool, auto-approve the control_request to avoid duplicate entries.
    for (const pending of session.pendingToolApprovals.values()) {
      if (pending.toolName === toolName) {
        console.log(`[control_request] auto-approving ${toolName} (PreToolUse hook already handling approval)`)
        cp.sendControlResponse(requestId, 'allow')
        return
      }
    }

    const question = this.summarizeToolPermission(toolName, toolInput)
    const neverAutoApprove = ApprovalManager.NEVER_AUTO_APPROVE_TOOLS.has(toolName)
    const options = [
      { label: 'Allow', value: 'allow' },
      ...(!neverAutoApprove ? [{ label: 'Always Allow', value: 'always_allow' }] : []),
      { label: 'Deny', value: 'deny' },
    ]
    const promptMsg: WsServerMessage = {
      type: 'prompt',
      promptType: 'permission',
      question,
      options,
      toolName,
      toolInput,
      requestId,
    }
    session.pendingControlRequests.set(requestId, { requestId, toolName, toolInput, promptMsg })

    if (session.clients.size > 0) {
      this.deps.broadcast(session, promptMsg)
    } else {
      console.log(`[control_request] no clients connected, waiting for client to join: ${toolName}`)
      this.deps.globalBroadcast({
        ...promptMsg,
        sessionId,
        sessionName: session.name,
      })
    }

    // Notify prompt listeners (orchestrator, child monitor, etc.)
    for (const listener of this.deps.promptListeners) {
      try { listener(sessionId, 'permission', toolName, requestId) } catch { /* listener error */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Prompt response routing
  // ---------------------------------------------------------------------------

  /**
   * Route a user's prompt response to the correct handler: pending tool approval
   * (from PermissionRequest hook), pending control request (from control_request
   * fallback path), or plain message fallback.
   */
  sendPromptResponse(sessionId: string, value: string | string[], requestId?: string): void {
    const session = this.deps.getSession(sessionId)
    if (!session) return
    session._lastActivityAt = Date.now()

    // Check for pending tool approval from PreToolUse hook
    if (!requestId) {
      const totalPending = session.pendingToolApprovals.size + session.pendingControlRequests.size
      if (totalPending === 1) {
        // Exactly one pending prompt — safe to infer the target
        const soleApproval = session.pendingToolApprovals.size === 1
          ? session.pendingToolApprovals.values().next().value
          : undefined
        if (soleApproval) {
          console.warn(`[prompt_response] no requestId, routing to sole pending tool approval: ${soleApproval.toolName}`)
          this.resolveToolApproval(session, soleApproval, value)
          return
        }
        const soleControl = session.pendingControlRequests.size === 1
          ? session.pendingControlRequests.values().next().value
          : undefined
        if (soleControl) {
          console.warn(`[prompt_response] no requestId, routing to sole pending control request: ${soleControl.toolName}`)
          requestId = soleControl.requestId
        }
      } else if (totalPending > 1) {
        console.warn(`[prompt_response] no requestId with ${totalPending} pending prompts — rejecting to prevent misrouted response`)
        this.deps.broadcast(session, {
          type: 'system_message',
          subtype: 'error',
          text: 'Prompt response could not be routed: multiple prompts pending. Please refresh and try again.',
        })
        return
      } else {
        console.warn(`[prompt_response] no requestId, no pending prompts — forwarding as user message`)
      }
    }
    const approval = requestId ? session.pendingToolApprovals.get(requestId) : undefined
    if (approval) {
      this.resolveToolApproval(session, approval, value)
      return
    }

    if (!session.claudeProcess?.isAlive()) return

    // Find matching pending control request
    const pending = requestId ? session.pendingControlRequests.get(requestId) : undefined

    if (pending) {
      session.pendingControlRequests.delete(pending.requestId)
      // Dismiss prompt on all other clients viewing this session
      this.deps.broadcast(session, { type: 'prompt_dismiss', requestId: pending.requestId })

      if (pending.toolName === 'AskUserQuestion') {
        this.handleAskUserQuestion(session, pending, value)
      } else {
        this.sendControlResponseForRequest(session, pending, value)
      }
    } else {
      // Fallback: no pending control request, send as plain user message
      const answer = Array.isArray(value) ? value.join(', ') : value
      session.claudeProcess.sendMessage(answer)
    }
  }

  // ---------------------------------------------------------------------------
  // Tool approval (PreToolUse hook path)
  // ---------------------------------------------------------------------------

  /**
   * Called by the PermissionRequest hook HTTP endpoint. Sends a prompt to clients
   * and returns a Promise that resolves when the user approves/denies.
   */
  requestToolApproval(sessionId: string, toolName: string, toolInput: Record<string, unknown>): Promise<{ allow: boolean; always: boolean; answer?: string }> {
    const session = this.deps.getSession(sessionId)
    if (!session) {
      console.log(`[tool-approval] session not found: ${sessionId}`)
      return Promise.resolve({ allow: false, always: false })
    }

    const autoResult = this.resolveAutoApproval(session, toolName, toolInput)
    if (autoResult === 'registry') {
      console.log(`[tool-approval] auto-approved (registry): ${toolName}`)
      return Promise.resolve({ allow: true, always: true })
    }
    if (autoResult === 'session') {
      console.log(`[tool-approval] auto-approved (session allowedTools): ${toolName}`)
      return Promise.resolve({ allow: true, always: false })
    }
    if (autoResult === 'headless') {
      console.log(`[tool-approval] auto-approved (headless ${session.source}): ${toolName}`)
      return Promise.resolve({ allow: true, always: false })
    }

    console.log(`[tool-approval] requesting approval: session=${sessionId} tool=${toolName} clients=${session.clients.size}`)

    // ExitPlanMode: route through PlanManager state machine for plan-specific
    // approval UI. The hook blocks until we resolve the promise.
    if (toolName === 'ExitPlanMode') {
      return this.handleExitPlanModeApproval(session, sessionId)
    }

    // Prevent double-gating: if a control_request already created a pending
    // entry for this tool, auto-approve the control_request and let the hook
    // take over as the sole approval gate.
    for (const [reqId, pending] of session.pendingControlRequests) {
      if (pending.toolName === toolName) {
        console.log(`[tool-approval] auto-approving control_request for ${toolName} (PreToolUse hook taking over)`)
        session.claudeProcess?.sendControlResponse(reqId, 'allow')
        session.pendingControlRequests.delete(reqId)
        this.deps.broadcast(session, { type: 'prompt_dismiss', requestId: reqId })
        break
      }
    }

    // AskUserQuestion: show a question prompt and collect the answer text,
    // rather than a permission prompt with Allow/Deny buttons.
    const isQuestion = toolName === 'AskUserQuestion'

    return new Promise<{ allow: boolean; always: boolean; answer?: string }>((resolve) => {
      // Holder lets wrappedResolve reference the timeout before it's assigned
      const timer: { id: ReturnType<typeof setTimeout> | null } = { id: null }

      const wrappedResolve = (result: { allow: boolean; always: boolean; answer?: string }) => {
        if (timer.id) clearTimeout(timer.id)
        resolve(result)
      }

      const approvalRequestId = randomUUID()

      // Timeout to prevent leaked promises if client disconnects after prompt is sent
      timer.id = setTimeout(() => {
        if (session.pendingToolApprovals.has(approvalRequestId)) {
          console.log(`[tool-approval] timed out for ${toolName}`)
          session.pendingToolApprovals.delete(approvalRequestId)
          // Dismiss the stale prompt in all clients so they don't inject
          // "allow"/"deny" as plain text after the timeout
          this.deps.broadcast(session, { type: 'prompt_dismiss', requestId: approvalRequestId })
          resolve({ allow: false, always: false })
        }
      }, 300_000) // 5 min for all approval types

      let promptMsg: WsServerMessage
      if (isQuestion) {
        // AskUserQuestion: extract structured questions from toolInput.questions
        const rawQuestions = toolInput.questions as Array<{ question: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean; header?: string }> | undefined
        const structuredQuestions = Array.isArray(rawQuestions)
          ? rawQuestions.map(q => ({
            question: q.question,
            header: q.header,
            multiSelect: q.multiSelect ?? false,
            options: (q.options || []).map((opt: { label: string; value?: string; description?: string }) => ({
              label: opt.label,
              value: opt.value ?? opt.label,
              description: opt.description,
            })),
          }))
          : undefined
        const firstQ = structuredQuestions?.[0]
        promptMsg = {
          type: 'prompt',
          promptType: 'question',
          question: firstQ?.question || 'Answer the question',
          options: firstQ?.options || [],
          multiSelect: firstQ?.multiSelect,
          toolName,
          toolInput,
          requestId: approvalRequestId,
          ...(structuredQuestions ? { questions: structuredQuestions } : {}),
        }
      } else {
        const question = this.summarizeToolPermission(toolName, toolInput)
        const approvePattern = this.deps.approvalManager.derivePattern(toolName, toolInput)
        const neverAutoApprove = ApprovalManager.NEVER_AUTO_APPROVE_TOOLS.has(toolName)
        const options = [
          { label: 'Allow', value: 'allow' },
          ...(!neverAutoApprove ? [{ label: 'Always Allow', value: 'always_allow' }] : []),
          { label: 'Deny', value: 'deny' },
        ]
        promptMsg = {
          type: 'prompt',
          promptType: 'permission',
          question,
          options,
          toolName,
          toolInput,
          requestId: approvalRequestId,
          ...(approvePattern ? { approvePattern } : {}),
        }
      }

      session.pendingToolApprovals.set(approvalRequestId, { resolve: wrappedResolve, toolName, toolInput, requestId: approvalRequestId, promptMsg })

      if (session.clients.size > 0) {
        this.deps.broadcast(session, promptMsg)
      } else {
        // No clients connected — DON'T auto-deny. Instead, wait for a client
        // to join this session (the prompt will be re-broadcast in join()).
        console.log(`[tool-approval] no clients connected, waiting for client to join (timeout 300s): ${toolName}`)
        this.deps.globalBroadcast({
          ...promptMsg,
          sessionId,
          sessionName: session.name,
        })
      }

      // Notify prompt listeners (orchestrator, child monitor, etc.)
      for (const listener of this.deps.promptListeners) {
        try { listener(sessionId, isQuestion ? 'question' : 'permission', toolName, approvalRequestId) } catch { /* listener error */ }
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Decode the allow/deny/always/pattern intent from a prompt response value. */
  private decodeApprovalValue(value: string | string[]): { isDeny: boolean; isAlwaysAllow: boolean; isApprovePattern: boolean } {
    const first = Array.isArray(value) ? value[0] : value
    return {
      isDeny: first === 'deny',
      isAlwaysAllow: first === 'always_allow',
      isApprovePattern: first === 'approve_pattern',
    }
  }

  /** Resolve a pending PreToolUse hook approval and update auto-approval registries. */
  private resolveToolApproval(
    session: Session,
    approval: { resolve: (r: { allow: boolean; always: boolean; answer?: string }) => void; toolName: string; toolInput: Record<string, unknown>; requestId: string },
    value: string | string[],
  ): void {
    // AskUserQuestion: the value IS the user's answer, not a permission decision
    if (approval.toolName === 'AskUserQuestion') {
      const answer = Array.isArray(value) ? value.join(', ') : value
      console.log(`[tool-approval] resolving AskUserQuestion: answer=${answer.slice(0, 100)}`)
      approval.resolve({ allow: true, always: false, answer })
      session.pendingToolApprovals.delete(approval.requestId)
      this.deps.broadcast(session, { type: 'prompt_dismiss', requestId: approval.requestId })
      return
    }

    // ExitPlanMode: route through PlanManager for state tracking.
    if (approval.toolName === 'ExitPlanMode') {
      const first = Array.isArray(value) ? value[0] : value
      const isDeny = first === 'deny'
      if (isDeny) {
        const feedback = Array.isArray(value) && value.length > 1 ? value[1] : undefined
        const reason = session.planManager.deny(approval.requestId, feedback)
        console.log(`[plan-approval] denied: ${reason}`)
        approval.resolve({ allow: false, always: false, answer: reason || undefined })
      } else {
        session.planManager.approve(approval.requestId)
        console.log(`[plan-approval] approved`)
        approval.resolve({ allow: true, always: false })
      }
      session.pendingToolApprovals.delete(approval.requestId)
      this.deps.broadcast(session, { type: 'prompt_dismiss', requestId: approval.requestId })
      return
    }

    const { isDeny, isAlwaysAllow, isApprovePattern } = this.decodeApprovalValue(value)

    if (isAlwaysAllow && !isDeny) {
      this.deps.approvalManager.saveAlwaysAllow(session.groupDir ?? session.workingDir, approval.toolName, approval.toolInput)
    }
    if (isApprovePattern && !isDeny) {
      this.deps.approvalManager.savePatternApproval(session.groupDir ?? session.workingDir, approval.toolName, approval.toolInput)
    }

    console.log(`[tool-approval] resolving: allow=${!isDeny} always=${isAlwaysAllow} pattern=${isApprovePattern} tool=${approval.toolName}`)
    approval.resolve({ allow: !isDeny, always: isAlwaysAllow || isApprovePattern })
    session.pendingToolApprovals.delete(approval.requestId)
    this.deps.broadcast(session, { type: 'prompt_dismiss', requestId: approval.requestId })
  }

  /**
   * Handle ExitPlanMode approval through PlanManager.
   */
  private handleExitPlanModeApproval(session: Session, sessionId: string): Promise<{ allow: boolean; always: boolean; answer?: string }> {
    const reviewId = session.planManager.onExitPlanModeRequested()
    if (!reviewId) {
      console.log(`[plan-approval] ExitPlanMode but PlanManager not in planning state, allowing`)
      return Promise.resolve({ allow: true, always: false })
    }

    return new Promise<{ allow: boolean; always: boolean; answer?: string }>((resolve) => {
      const timer: { id: ReturnType<typeof setTimeout> | null } = { id: null }

      const wrappedResolve = (result: { allow: boolean; always: boolean; answer?: string }) => {
        if (timer.id) clearTimeout(timer.id)
        resolve(result)
      }

      // Timeout: auto-deny after 5 minutes to prevent leaked promises
      timer.id = setTimeout(() => {
        if (session.pendingToolApprovals.has(reviewId)) {
          console.log(`[plan-approval] timed out, auto-denying`)
          session.pendingToolApprovals.delete(reviewId)
          session.planManager.deny(reviewId)
          this.deps.broadcast(session, { type: 'prompt_dismiss', requestId: reviewId })
          resolve({ allow: false, always: false })
        }
      }, 300_000)

      const promptMsg: WsServerMessage = {
        type: 'prompt',
        promptType: 'permission',
        question: 'Approve plan and start implementation?',
        options: [
          { label: 'Approve', value: 'allow' },
          { label: 'Reject', value: 'deny' },
        ],
        toolName: 'ExitPlanMode',
        requestId: reviewId,
      }

      session.pendingToolApprovals.set(reviewId, {
        resolve: wrappedResolve,
        toolName: 'ExitPlanMode',
        toolInput: {},
        requestId: reviewId,
        promptMsg,
      })

      this.deps.broadcast(session, promptMsg)

      if (session.clients.size === 0) {
        this.deps.globalBroadcast({ ...promptMsg, sessionId, sessionName: session.name })
      }

      for (const listener of this.deps.promptListeners) {
        try { listener(sessionId, 'permission', 'ExitPlanMode', reviewId) } catch { /* listener error */ }
      }
    })
  }

  /**
   * Send an AskUserQuestion control response, mapping the user's answer(s) into
   * the structured answers map the tool expects.
   */
  private handleAskUserQuestion(
    session: Session,
    pending: { requestId: string; toolInput: Record<string, unknown> },
    value: string | string[],
  ): void {
    const questions = pending.toolInput?.questions as Array<{ question: string }> | undefined
    const updatedInput: Record<string, unknown> = { ...pending.toolInput }

    let answers: Record<string, string> = {}
    if (typeof value === 'string') {
      // Try parsing as JSON answers map (multi-question flow)
      try {
        const parsed = JSON.parse(value)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          answers = parsed as Record<string, string>
        } else if (Array.isArray(questions) && questions.length > 0) {
          answers[questions[0].question] = value
        }
      } catch {
        // Plain string answer — map to first question
        if (Array.isArray(questions) && questions.length > 0) {
          answers[questions[0].question] = value
        }
      }
    } else if (Array.isArray(value) && Array.isArray(questions) && questions.length > 0) {
      // Array of answers — map to first question (multi-select single question)
      answers[questions[0].question] = value.join(', ')
    }

    updatedInput.answers = answers
    session.claudeProcess!.sendControlResponse(pending.requestId, 'allow', updatedInput)
  }

  /** Send a permission control response (allow/always_allow/approve_pattern/deny). */
  private sendControlResponseForRequest(
    session: Session,
    pending: { requestId: string; toolName: string; toolInput: Record<string, unknown> },
    value: string | string[],
  ): void {
    const { isDeny, isAlwaysAllow, isApprovePattern } = this.decodeApprovalValue(value)

    if (isAlwaysAllow) {
      this.deps.approvalManager.saveAlwaysAllow(session.groupDir ?? session.workingDir, pending.toolName, pending.toolInput)
    }
    if (isApprovePattern) {
      this.deps.approvalManager.savePatternApproval(session.groupDir ?? session.workingDir, pending.toolName, pending.toolInput)
    }

    const behavior = isDeny ? 'deny' : 'allow'
    session.claudeProcess!.sendControlResponse(pending.requestId, behavior)
  }

  /**
   * Check if a tool invocation can be auto-approved without prompting the user.
   * Returns 'registry' if matched by auto-approval rules, 'session' if matched
   * by the session's allowedTools list, 'headless' if the session has no clients
   * and is a non-interactive source, or 'prompt' if the user needs to decide.
   */
  resolveAutoApproval(session: Session, toolName: string, toolInput: Record<string, unknown>): 'registry' | 'session' | 'headless' | 'prompt' {
    if (this.deps.approvalManager.checkAutoApproval(session.groupDir ?? session.workingDir, toolName, toolInput)) {
      return 'registry'
    }
    if (session.allowedTools && this.matchesAllowedTools(session.allowedTools, toolName, toolInput)) {
      return 'session'
    }
    if (session.clients.size === 0 && (session.source === 'webhook' || session.source === 'workflow' || session.source === 'stepflow' || session.source === 'orchestrator')) {
      return 'headless'
    }
    return 'prompt'
  }

  /**
   * Check if a tool invocation matches any of the session's allowedTools patterns.
   * Patterns follow Claude CLI format: 'ToolName' or 'ToolName(prefix:*)'.
   */
  private matchesAllowedTools(allowedTools: string[], toolName: string, toolInput: Record<string, unknown>): boolean {
    for (const pattern of allowedTools) {
      // Simple tool name match: 'WebFetch', 'Read', etc.
      if (pattern === toolName) return true

      // Parameterized match: 'Bash(curl:*)' → toolName=Bash, command starts with 'curl'
      const match = pattern.match(/^(\w+)\(([^:]+):\*\)$/)
      if (match) {
        const [, patternTool, prefix] = match
        if (patternTool !== toolName) continue
        // For Bash, check command prefix
        if (toolName === 'Bash') {
          const cmd = String(toolInput.command || '').trimStart()
          if (cmd === prefix || cmd.startsWith(prefix + ' ')) return true
        }
      }
    }
    return false
  }

  /** Build a human-readable prompt string for a tool permission dialog. */
  summarizeToolPermission(toolName: string, toolInput: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash': {
        const cmd = String(toolInput.command || '')
        const firstLine = cmd.split('\n')[0]
        const display = firstLine.length < cmd.length ? `${firstLine}...` : cmd
        return `Allow Bash? \`$ ${display}\``
      }
      case 'Task':
        return `Allow Task? ${String(toolInput.description || toolName)}`
      case 'Read': {
        const filePath = String(toolInput.file_path || '')
        return `Allow Read? \`${filePath}\``
      }
      default:
        return `Allow ${toolName}?`
    }
  }
}
