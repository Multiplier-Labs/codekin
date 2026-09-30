/**
 * Typed client for the local Codekin REST API, used by the MCP server.
 *
 * Kept separate from the MCP wiring so every tool's request mapping is a
 * plain async method testable against a stub HTTP server. Auth and port come
 * from the environment Codekin already injects into every session
 * (CODEKIN_PORT, CODEKIN_AUTH_TOKEN) — the MCP server is spawned as a child
 * of the orchestrator's CLI process and inherits them.
 */

import type { CodingProvider } from './coding-process.js'

export interface CodekinApiOptions {
  baseUrl: string
  token: string
  fetchImpl?: typeof fetch
}

export interface SpawnChildInput {
  repo: string
  task: string
  branchName: string
  completionPolicy?: 'pr' | 'merge' | 'commit-only'
  useWorktree?: boolean
  timeoutMs?: number
  provider?: CodingProvider
  model?: string
  parentSessionId?: string
  taskId?: string
}

export interface CreateTaskApiInput {
  repo: string
  title: string
  detail?: string
  acceptance?: string
  priority?: 'high' | 'normal' | 'low'
  completionPolicy?: 'pr' | 'merge' | 'commit-only'
  source?: 'joe' | 'report' | 'incident' | 'maintenance'
  sourceRef?: string
  originSessionId?: string
  originRequestId?: string
  responsibilityId?: string
}

/** Why and on whose behalf an automation change is made — recorded in its audit trail. */
export interface AutomationChangeFields {
  reason: string
  idempotencyKey: string
  authorization?: string
  originSessionId?: string
  taskId?: string
}

export interface CreateAutomationApiInput extends AutomationChangeFields {
  repo: string
  kind: string
  cronExpression: string
  name?: string
  enabled?: boolean
  customPrompt?: string
  model?: string
  provider?: CodingProvider
}

export interface UpdateAutomationApiInput extends AutomationChangeFields {
  expectedRevision: number
  name?: string
  cronExpression?: string
  enabled?: boolean
  customPrompt?: string
  model?: string
  provider?: CodingProvider
}

export class CodekinApi {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: CodekinApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /** Read config from the env Codekin injects into agent sessions. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): CodekinApi {
    const port = env.CODEKIN_PORT
    const token = env.CODEKIN_AUTH_TOKEN || env.CODEKIN_TOKEN
    if (!port || !token) {
      throw new Error('CODEKIN_PORT and CODEKIN_AUTH_TOKEN must be set (they are injected into Codekin agent sessions)')
    }
    return new CodekinApi({ baseUrl: `http://127.0.0.1:${port}`, token })
  }

  private async request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Codekin API ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`)
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }

  // --- orchestrator children -----------------------------------------------

  spawnChild(input: SpawnChildInput): Promise<unknown> {
    return this.request('POST', '/api/orchestrator/children', input)
  }

  listChildren(): Promise<unknown> {
    return this.request('GET', '/api/orchestrator/children')
  }

  getChild(id: string): Promise<unknown> {
    return this.request('GET', `/api/orchestrator/children/${encodeURIComponent(id)}`)
  }

  getChildTranscript(id: string, limit = 10_000): Promise<unknown> {
    return this.request('GET', `/api/orchestrator/children/${encodeURIComponent(id)}/transcript?limit=${limit}`)
  }

  sendToChild(id: string, text: string): Promise<unknown> {
    return this.request('POST', `/api/orchestrator/children/${encodeURIComponent(id)}/input`, { text })
  }

  stopChild(id: string): Promise<unknown> {
    return this.request('POST', `/api/orchestrator/children/${encodeURIComponent(id)}/stop`)
  }

  resumeChild(id: string, instructions?: string): Promise<unknown> {
    return this.request('POST', `/api/orchestrator/children/${encodeURIComponent(id)}/resume`, instructions ? { instructions } : {})
  }

  closeChild(id: string, opts: { mode?: 'archive' | 'delete'; cancel?: boolean } = {}): Promise<unknown> {
    return this.request('POST', `/api/orchestrator/children/${encodeURIComponent(id)}/close`, opts)
  }

  // --- tasks ----------------------------------------------------------------

  listTasks(opts: { repo?: string; status?: string } = {}): Promise<unknown> {
    const params = new URLSearchParams()
    if (opts.repo) params.set('repo', opts.repo)
    if (opts.status) params.set('status', opts.status)
    const qs = params.toString()
    return this.request('GET', `/api/orchestrator/tasks${qs ? `?${qs}` : ''}`)
  }

  getTask(id: string): Promise<unknown> {
    return this.request('GET', `/api/orchestrator/tasks/${encodeURIComponent(id)}`)
  }

  createTask(input: CreateTaskApiInput): Promise<unknown> {
    const { repo, completionPolicy, source, sourceRef, originSessionId, originRequestId, responsibilityId, ...task } = input
    return this.request('POST', '/api/orchestrator/tasks', { repo, completionPolicy, source, sourceRef, originSessionId, originRequestId, responsibilityId, tasks: [task] })
  }

  updateTask(id: string, patch: { title?: string; detail?: string; acceptance?: string; priority?: string; status?: string; note?: string }): Promise<unknown> {
    return this.request('PATCH', `/api/orchestrator/tasks/${encodeURIComponent(id)}`, patch)
  }

  requestDecision(id: string, input: { question: string; recommendation?: string; options?: string[] }): Promise<unknown> {
    return this.request('POST', `/api/orchestrator/tasks/${encodeURIComponent(id)}/decision`, input)
  }

  // --- sessions -------------------------------------------------------------

  listSessions(opts: { source?: string; active?: boolean } = {}): Promise<unknown> {
    const params = new URLSearchParams({ view: 'summary' })
    if (opts.source) params.set('source', opts.source)
    if (opts.active) params.set('active', 'true')
    return this.request('GET', `/api/orchestrator/sessions?${params.toString()}`)
  }

  // --- repo maintenance ----------------------------------------------------

  listMaintenance(): Promise<unknown> {
    return this.request('GET', '/api/orchestrator/maintenance')
  }

  getMaintenancePlan(repo: string): Promise<unknown> {
    return this.request('GET', `/api/orchestrator/maintenance/plan?repo=${encodeURIComponent(repo)}`)
  }

  proposeResponsibility(input: { repo: string; name: string; scope?: string; automationIds: string[]; policy: string; maxActiveTasks?: number; requiredDecision?: string }): Promise<unknown> {
    return this.request('POST', '/api/orchestrator/maintenance/responsibilities', input)
  }

  removeResponsibility(id: string): Promise<unknown> {
    return this.request('POST', `/api/orchestrator/maintenance/responsibilities/${encodeURIComponent(id)}/remove`)
  }

  pauseMaintenance(repo: string): Promise<unknown> {
    return this.request('POST', '/api/orchestrator/maintenance/pause', { repo })
  }

  recordMaintenanceActivity(input: { repo: string; responsibilityId?: string; kind: 'finding' | 'check_ok' | 'action'; summary: string; ref?: string }): Promise<unknown> {
    return this.request('POST', '/api/orchestrator/maintenance/activity', input)
  }

  // --- Joe in repo sessions ------------------------------------------------

  replyInSession(sessionId: string, input: { text: string; requestId?: string; taskId?: string }): Promise<unknown> {
    return this.request('POST', `/api/orchestrator/sessions/${encodeURIComponent(sessionId)}/joe-reply`, input)
  }

  getSessionContext(sessionId: string, limit?: number): Promise<unknown> {
    return this.request('GET', `/api/orchestrator/sessions/${encodeURIComponent(sessionId)}/context${limit ? `?limit=${limit}` : ''}`)
  }

  takeOverSession(sessionId: string, input: { requestId: string; taskId?: string }): Promise<unknown> {
    return this.request('POST', `/api/orchestrator/sessions/${encodeURIComponent(sessionId)}/handover`, input)
  }

  sendToSession(sessionId: string, input: { text: string; controllerRevision: number }): Promise<unknown> {
    return this.request('POST', `/api/orchestrator/sessions/${encodeURIComponent(sessionId)}/instruct`, input)
  }

  // --- prompts (blocked sessions) ------------------------------------------

  pendingPrompts(): Promise<unknown> {
    return this.request('GET', '/api/orchestrator/sessions/pending-prompts')
  }

  respondToPrompt(sessionId: string, requestId: string, value: string | string[]): Promise<unknown> {
    return this.request('POST', `/api/orchestrator/sessions/${encodeURIComponent(sessionId)}/respond`, { requestId, value })
  }

  // --- runs (unified feed, loops, workflows) -------------------------------

  listRuns(opts: { engine?: 'workflow' | 'loop'; status?: string; limit?: number } = {}): Promise<unknown> {
    const params = new URLSearchParams()
    if (opts.engine) params.set('engine', opts.engine)
    if (opts.status) params.set('status', opts.status)
    if (opts.limit) params.set('limit', String(opts.limit))
    const qs = params.toString()
    return this.request('GET', `/api/runs${qs ? `?${qs}` : ''}`)
  }

  startLoop(input: { recipeId: string; repo: string; branch?: string; goal?: string }): Promise<unknown> {
    return this.request('POST', '/api/loops/runs', input)
  }

  abortRun(runId: string): Promise<unknown> {
    return this.request('POST', `/api/loops/runs/${encodeURIComponent(runId)}/cancel`)
  }

  triggerWorkflow(opts: { kind?: string; automationId?: string; input?: Record<string, unknown> }): Promise<unknown> {
    if (opts.automationId) return this.request('POST', `/api/orchestrator/automations/${encodeURIComponent(opts.automationId)}/trigger`)
    return this.request('POST', '/api/orchestrator/automations/runs', { kind: opts.kind, input: opts.input })
  }

  // --- workflow definitions and repo automations ---------------------------

  listWorkflows(repo?: string): Promise<unknown> {
    return this.request('GET', `/api/orchestrator/automations/workflows${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`)
  }

  getWorkflow(kind: string, repo?: string): Promise<unknown> {
    return this.request('GET', `/api/orchestrator/automations/workflows/${encodeURIComponent(kind)}${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`)
  }

  validateWorkflow(input: { content?: string; repo?: string; kind?: string; filename?: string }): Promise<unknown> {
    return this.request('POST', '/api/orchestrator/automations/workflows/validate', input)
  }

  listRepoAutomations(repo?: string): Promise<unknown> {
    return this.request('GET', `/api/orchestrator/automations${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`)
  }

  getRepoAutomation(id: string): Promise<unknown> {
    return this.request('GET', `/api/orchestrator/automations/${encodeURIComponent(id)}`)
  }

  createRepoAutomation(input: CreateAutomationApiInput): Promise<unknown> {
    return this.request('POST', '/api/orchestrator/automations', input)
  }

  updateRepoAutomation(id: string, input: UpdateAutomationApiInput): Promise<unknown> {
    return this.request('PATCH', `/api/orchestrator/automations/${encodeURIComponent(id)}`, input)
  }

  removeRepoAutomation(id: string, input: AutomationChangeFields & { expectedRevision: number }): Promise<unknown> {
    return this.request('POST', `/api/orchestrator/automations/${encodeURIComponent(id)}/remove`, input)
  }

  getAutomationHealth(id: string): Promise<unknown> {
    return this.request('GET', `/api/orchestrator/automations/${encodeURIComponent(id)}/health`)
  }

  getAutomationTriggerHistory(id: string, limit?: number): Promise<unknown> {
    return this.request('GET', `/api/orchestrator/automations/${encodeURIComponent(id)}/history${limit ? `?limit=${limit}` : ''}`)
  }

  getRepoActivity(): Promise<unknown> {
    return this.request('GET', '/api/workflows/repo-activity')
  }

  // --- deployments ----------------------------------------------------------

  listDeployments(): Promise<unknown> {
    return this.request('GET', '/api/deployments')
  }

  getDeploymentSamples(probeKey: string, limit?: number): Promise<unknown> {
    const params = new URLSearchParams({ probeKey })
    if (limit) params.set('limit', String(limit))
    return this.request('GET', `/api/deployments/samples?${params.toString()}`)
  }

  // --- trust ----------------------------------------------------------------

  getTrustLevel(opts: { action: string; category: string; severity?: string; repo?: string }): Promise<unknown> {
    const params = new URLSearchParams({ action: opts.action, category: opts.category })
    if (opts.severity) params.set('severity', opts.severity)
    if (opts.repo) params.set('repo', opts.repo)
    return this.request('GET', `/api/orchestrator/trust/level?${params.toString()}`)
  }

  recordTrustApproval(opts: { action: string; category: string; repo?: string }): Promise<unknown> {
    return this.request('POST', '/api/orchestrator/trust/approve', opts)
  }

  recordTrustRejection(opts: { action: string; category: string; repo?: string }): Promise<unknown> {
    return this.request('POST', '/api/orchestrator/trust/reject', opts)
  }

  // --- reports --------------------------------------------------------------

  listReports(opts: { repo?: string; since?: string } = {}): Promise<unknown> {
    const params = new URLSearchParams()
    if (opts.repo) params.set('repo', opts.repo)
    if (opts.since) params.set('since', opts.since)
    const qs = params.toString()
    return this.request('GET', `/api/orchestrator/reports${qs ? `?${qs}` : ''}`)
  }

  readReport(path: string): Promise<unknown> {
    return this.request('GET', `/api/orchestrator/reports/read?path=${encodeURIComponent(path)}`)
  }
}
