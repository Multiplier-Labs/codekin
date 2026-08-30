/**
 * REST API for Loops 2.0. Mounted at /api/loops/.
 *
 * Endpoints (docs/LOOPS-REWRITE-SPEC.md §9, Phase 1 surface):
 *   GET  /recipes                      — recipes visible to a repo (built-ins + repo overrides)
 *   POST /recipes/validate             — validate recipe markdown without saving it
 *   POST /runs/preflight               — resolve the exact effective run config before starting
 *   POST /runs                         — start a run { recipeId, repo, branch?, goal? }
 *   GET  /runs                         — list runs (state/repo/active/limit filters)
 *   GET  /runs/:id                     — run + stages + evaluations + interventions + event cursor
 *   GET  /runs/:id/events?after=<seq>  — resumable event stream (poll/gap-fetch)
 *   GET  /runs/:id/artifacts/:artifactId — artifact body with metadata headers
 *   POST /runs/:id/pause | /resume | /cancel
 *   POST /runs/:id/steer               — { instruction }
 *   POST /runs/:id/interventions/:interventionId/resolve — { choice, note? }
 *
 * All routes require the master Bearer token, mirroring the workflow router.
 * Live updates ride the shared WS channel as pings; the event log here is the
 * source of truth a client reconciles against after reconnecting.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { resolveRepoPathInRoot } from './config.js'
import {
  isValidRecipeId,
  listLoopRecipes,
  loadLoopRecipe,
  parseLoopRecipe,
  resolveAgentProvider,
  withOverrides,
  type RecipeOverrides,
} from './loop-recipe.js'
import { execFile } from 'child_process'
import type { LoopEngine } from './loop-engine.js'
import type { LoopRunState, LoopStore } from './loop-store.js'
import type { LoopArtifactStore } from './loop-artifacts.js'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

const STATES: readonly LoopRunState[] = [
  'created',
  'preflight',
  'planning',
  'executing',
  'evaluating',
  'reviewing',
  'awaiting_approval',
  'pausing',
  'paused',
  'canceling',
  'finalizing',
  'monitoring_ci',
  'recovering',
  'done',
]

interface StartRunBody {
  recipeId?: string
  repo?: string
  branch?: string
  baseBranch?: string
  goal?: string
  /** Wizard control-step overrides, applied to the recipe before it freezes. */
  overrides?: RecipeOverrides
}

/** loop/<recipeId>-<yyyymmdd-hhmmss> — a start without a branch name still lands somewhere sane. */
function defaultBranch(recipeId: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `loop/${recipeId}-${stamp}`
}

/** Resolve + validate the shared start/preflight inputs, applying any overrides. */
function resolveStart(body: StartRunBody):
  | { error: string }
  | { recipe: NonNullable<ReturnType<typeof loadLoopRecipe>>; repo: string; branch: string; baseBranch: string | null; goal: string } {
  const { recipeId, repo, branch, baseBranch, goal, overrides } = body
  if (typeof recipeId !== 'string' || !isValidRecipeId(recipeId)) {
    return { error: 'Missing or invalid recipeId (expected a lowercase slug matching a loop recipe)' }
  }
  if (!repo) return { error: 'Missing required field: repo' }
  const resolvedRepo = resolveRepoPathInRoot(repo)
  if (!resolvedRepo) return { error: 'Invalid repo: must be an existing directory under the configured repos root' }
  let recipe = loadLoopRecipe(recipeId, resolvedRepo)
  if (!recipe) return { error: `No loop recipe found for id: ${recipeId}` }
  if (overrides !== undefined) {
    if (typeof overrides !== 'object' || overrides === null) return { error: 'overrides must be an object' }
    try {
      recipe = withOverrides(recipe, overrides)
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Invalid overrides' }
    }
  }
  return {
    recipe,
    repo: resolvedRepo,
    branch: branch && branch.trim() ? branch.trim() : defaultBranch(recipeId),
    baseBranch: baseBranch && baseBranch.trim() ? baseBranch.trim() : null,
    goal: goal && goal.trim() ? goal.trim() : recipe.outcome,
  }
}

/**
 * Local branches of a repo plus the detected default — the wizard's
 * base-branch picker. Argv-only git, path constrained to the repos root.
 */
function listBranches(repoPath: string): Promise<{ branches: string[]; defaultBranch: string | null }> {
  const git = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile('git', args, { cwd: repoPath, timeout: 10_000 }, (err, stdout) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)))
        else resolve(stdout)
      })
    })
  return (async () => {
    const out = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    const branches = out.split('\n').map((b) => b.trim()).filter(Boolean)
    let def: string | null
    try {
      const head = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
      def = head.replace(/^origin\//, '') || null
    } catch {
      def = branches.find((b) => b === 'main') ?? branches.find((b) => b === 'master') ?? null
    }
    return { branches, defaultBranch: def }
  })()
}

export function createLoopRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  store: LoopStore,
  engine: LoopEngine,
  artifacts: LoopArtifactStore,
): Router {
  const router = Router()

  router.use((req: Request, res: Response, next: () => void) => {
    if (!verifyToken(extractToken(req))) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  })

  // -------------------------------------------------------------------------
  // Recipes
  // -------------------------------------------------------------------------

  router.get('/recipes', (req, res) => {
    const repoPath = req.query.repoPath as string | undefined
    const resolved = repoPath ? resolveRepoPathInRoot(repoPath) : undefined
    if (repoPath && !resolved) {
      return res.status(400).json({ error: 'Invalid repoPath: must be an existing directory under the configured repos root' })
    }
    res.json({ recipes: listLoopRecipes(resolved || undefined) })
  })

  /** Base-branch picker data for the wizard. */
  router.get('/branches', (req, res) => {
    const repoPath = req.query.repoPath as string | undefined
    const resolved = repoPath ? resolveRepoPathInRoot(repoPath) : undefined
    if (!resolved) {
      return res.status(400).json({ error: 'Invalid repoPath: must be an existing directory under the configured repos root' })
    }
    listBranches(resolved)
      .then((result) => res.json(result))
      .catch((err: unknown) => res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list branches' }))
  })

  router.post('/recipes/validate', (req: Request<Record<string, string>, unknown, { content?: string }>, res) => {
    const { content } = req.body
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'Missing required field: content (recipe markdown)' })
    }
    try {
      const recipe = parseLoopRecipe(content, 'recipe.md', 'repo')
      res.json({ valid: true, recipe })
    } catch (err) {
      res.json({ valid: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /** Show exactly what would run — the wizard's last screen — without spending anything. */
  router.post('/runs/preflight', (req: Request<Record<string, string>, unknown, StartRunBody>, res) => {
    const resolved = resolveStart(req.body)
    if ('error' in resolved) return res.status(400).json({ error: resolved.error })
    const provider = resolveAgentProvider(resolved.recipe.agent.provider)
    res.json({
      effective: {
        recipe: resolved.recipe,
        repo: resolved.repo,
        branch: resolved.branch,
        baseBranch: resolved.baseBranch,
        goal: resolved.goal,
        provider,
        model: resolved.recipe.agent.model ?? null,
      },
    })
  })

  router.post('/runs', async (req: Request<Record<string, string>, unknown, StartRunBody>, res) => {
    const resolved = resolveStart(req.body)
    if ('error' in resolved) return res.status(400).json({ error: resolved.error })
    try {
      const run = await engine.startRun({
        recipe: resolved.recipe,
        goal: resolved.goal,
        repo: resolved.repo,
        branch: resolved.branch,
        baseBranch: resolved.baseBranch,
        provider: resolveAgentProvider(resolved.recipe.agent.provider),
        model: resolved.recipe.agent.model ?? null,
      })
      res.json({ run })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to start run' })
    }
  })

  router.get('/runs', (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : undefined
    const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined
    const active = req.query.active === '1' || req.query.active === 'true'
    const limit = typeof req.query.limit === 'string' ? req.query.limit : undefined
    if (state && !STATES.includes(state as LoopRunState)) {
      return res.status(400).json({ error: `Invalid state: ${state}` })
    }
    const runs = store.listRuns({
      state: state as LoopRunState | undefined,
      repo,
      activeOnly: active || undefined,
      limit: limit ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500) : 50,
    })
    res.json({ runs })
  })

  router.get('/runs/:id', (req, res) => {
    const run = store.getRun(req.params.id)
    if (!run) return res.status(404).json({ error: 'Run not found' })
    const evaluations = store.listEvaluations(run.id)
    // Completion scorecard: every criterion in the frozen recipe with its
    // latest result — 'pending' means it has not been evaluated yet.
    const scorecard = run.recipe.evaluators.map((e) => {
      const last = evaluations.filter((ev) => ev.evaluatorId === e.id).at(-1)
      return {
        id: e.id,
        type: e.type,
        required: e.required,
        status: last?.status ?? ('pending' as const),
        summary: last?.summary ?? null,
        evidenceArtifactIds: last?.evidenceArtifactIds ?? [],
      }
    })
    res.json({
      run: {
        ...run,
        stages: store.listStages(run.id),
        evaluations,
        scorecard,
        interventions: store.listInterventions(run.id),
        artifacts: store.listArtifacts(run.id),
        lastSequence: store.lastSequence(run.id),
      },
    })
  })

  router.get('/runs/:id/events', (req, res) => {
    const run = store.getRun(req.params.id)
    if (!run) return res.status(404).json({ error: 'Run not found' })
    const after = typeof req.query.after === 'string' ? Math.max(0, parseInt(req.query.after, 10) || 0) : 0
    const limit = typeof req.query.limit === 'string' ? Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000) : 500
    const events = store.listEvents(run.id, after, limit)
    res.json({ events, lastSequence: store.lastSequence(run.id) })
  })

  router.get('/runs/:id/artifacts/:artifactId', (req, res) => {
    const artifact = store.getArtifact(req.params.artifactId)
    if (!artifact || artifact.runId !== req.params.id) return res.status(404).json({ error: 'Artifact not found' })
    const body = artifacts.get(artifact.contentHash)
    if (!body) return res.status(410).json({ error: 'Artifact body is no longer available' })
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('X-Artifact-Kind', artifact.kind)
    res.setHeader('X-Artifact-Label', encodeURIComponent(artifact.label))
    res.send(body)
  })

  // -------------------------------------------------------------------------
  // Controls — every one an auditable event in the run's log
  // -------------------------------------------------------------------------

  router.post('/runs/:id/pause', (req, res) => {
    if (!engine.pause(req.params.id)) return res.status(409).json({ error: 'Run not found or not pausable in its current state' })
    res.json({ success: true })
  })

  router.post('/runs/:id/resume', async (req, res) => {
    if (!(await engine.resume(req.params.id))) return res.status(409).json({ error: 'Run not found or not paused' })
    res.json({ success: true })
  })

  router.post('/runs/:id/cancel', (req, res) => {
    if (!engine.cancel(req.params.id)) return res.status(409).json({ error: 'Run not found or already finished' })
    res.json({ success: true })
  })

  router.post('/runs/:id/steer', (req: Request<{ id: string }, unknown, { instruction?: string; revisePlan?: boolean }>, res) => {
    const { instruction, revisePlan } = req.body
    if (typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({ error: 'Missing required field: instruction' })
    }
    if (!engine.steer(req.params.id, instruction.trim(), revisePlan === true)) {
      return res.status(409).json({ error: 'Run not found or already finished' })
    }
    res.json({ success: true })
  })

  /** Fork a run into a new one starting from its current worktree state. */
  router.post('/runs/:id/fork', async (req, res) => {
    const source = store.getRun(req.params.id)
    if (!source) return res.status(404).json({ error: 'Run not found' })
    try {
      const fork = await engine.forkRun(req.params.id)
      if (!fork) return res.status(409).json({ error: 'Run has no recoverable worktree to fork from' })
      res.json({ run: fork })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Fork failed' })
    }
  })

  // -------------------------------------------------------------------------
  // Lessons — reflection suggestions, approved by a human, never auto-applied
  // -------------------------------------------------------------------------

  router.get('/lessons', (req, res) => {
    const recipeId = typeof req.query.recipeId === 'string' ? req.query.recipeId : undefined
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    if (status && !['suggested', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: `Invalid status: ${status}` })
    }
    res.json({ lessons: store.listLessons(recipeId, status as 'suggested' | 'approved' | 'rejected' | undefined) })
  })

  router.post('/lessons/:lessonId/approve', (req, res) => {
    const lesson = store.resolveLesson(req.params.lessonId, 'approved')
    if (!lesson) return res.status(409).json({ error: 'Lesson not found or already resolved' })
    res.json({ lesson })
  })

  router.post('/lessons/:lessonId/reject', (req, res) => {
    const lesson = store.resolveLesson(req.params.lessonId, 'rejected')
    if (!lesson) return res.status(409).json({ error: 'Lesson not found or already resolved' })
    res.json({ lesson })
  })

  // -------------------------------------------------------------------------
  // Recipe-version stats — A/B comparison by content hash
  // -------------------------------------------------------------------------

  router.get('/recipes/:id/stats', (req, res) => {
    if (!isValidRecipeId(req.params.id)) return res.status(400).json({ error: 'Invalid recipe id' })
    const runs = store.listRuns({ limit: 500 }).filter((r) => r.recipeId === req.params.id)
    const byHash = new Map<string, typeof runs>()
    for (const run of runs) {
      const bucket = byHash.get(run.recipeHash) ?? []
      bucket.push(run)
      byHash.set(run.recipeHash, bucket)
    }
    const versions = [...byHash.entries()].map(([hash, group]) => {
      const done = group.filter((r) => r.state === 'done')
      const succeeded = done.filter((r) => r.outcome === 'completed' || r.outcome === 'completed_with_warnings')
      return {
        recipeHash: hash,
        runs: group.length,
        succeeded: succeeded.length,
        failed: done.filter((r) => r.outcome === 'failed').length,
        canceled: done.filter((r) => r.outcome === 'canceled').length,
        avgTurns: done.length ? done.reduce((sum, r) => sum + r.turnCount, 0) / done.length : null,
        avgCostUsd: done.length ? done.reduce((sum, r) => sum + r.costUsd, 0) / done.length : null,
        firstRunAt: group[group.length - 1]?.createdAt ?? null,
        lastRunAt: group[0]?.createdAt ?? null,
      }
    })
    versions.sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? ''))
    res.json({ recipeId: req.params.id, versions })
  })

  router.post(
    '/runs/:id/interventions/:interventionId/resolve',
    async (req: Request<{ id: string; interventionId: string }, unknown, { choice?: string; note?: string }>, res) => {
      const { choice, note } = req.body
      if (typeof choice !== 'string' || !choice.trim()) {
        return res.status(400).json({ error: 'Missing required field: choice' })
      }
      const intervention = store.getIntervention(req.params.interventionId)
      if (!intervention || intervention.runId !== req.params.id) {
        return res.status(404).json({ error: 'Intervention not found' })
      }
      const ok = await engine.resolveIntervention(req.params.interventionId, choice.trim(), typeof note === 'string' ? note : undefined)
      if (!ok) return res.status(409).json({ error: 'Intervention already resolved or the choice is not among its options' })
      res.json({ success: true })
    },
  )

  return router
}
