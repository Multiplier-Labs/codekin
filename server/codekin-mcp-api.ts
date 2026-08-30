/**
 * Typed client for the local Codekin REST API, used by the MCP server.
 *
 * Kept separate from the MCP wiring so every tool's request mapping is a
 * plain async method testable against a stub HTTP server. Auth and port come
 * from the environment Codekin already injects into every session
 * (CODEKIN_PORT, CODEKIN_AUTH_TOKEN) — the MCP server is spawned as a child
 * of the orchestrator's CLI process and inherits them.
 */

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
  deployAfter?: boolean
  model?: string
  parentSessionId?: string
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

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
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

  // --- prompts (blocked sessions) ------------------------------------------

  pendingPrompts(): Promise<unknown> {
    return this.request('GET', '/api/orchestrator/sessions/pending-prompts')
  }

  respondToPrompt(sessionId: string, requestId: string, value: string): Promise<unknown> {
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

  startLoop(input: { kind: string; repo: string; branch: string; goal?: string }): Promise<unknown> {
    return this.request('POST', '/api/goal-runs/runs', input)
  }

  abortRun(runId: string): Promise<unknown> {
    return this.request('POST', `/api/goal-runs/runs/${encodeURIComponent(runId)}/abort`)
  }

  triggerWorkflow(kind: string, input?: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', '/api/workflows/runs', { kind, input })
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

  listReports(): Promise<unknown> {
    return this.request('GET', '/api/orchestrator/reports')
  }

  readReport(path: string): Promise<unknown> {
    return this.request('GET', `/api/orchestrator/reports/read?path=${encodeURIComponent(path)}`)
  }
}
