import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./config.js', () => ({
  resolveRepoPathInRoot: (p: string) => (existsSync(p) ? p : null),
}))

import { LoopStore } from './loop-store.js'
import { LoopArtifactStore } from './loop-artifacts.js'
import { parseLoopRecipe } from './loop-recipe.js'
import { createLoopRouter } from './loop-routes.js'
import type { LoopEngine } from './loop-engine.js'

const RECIPE_MD = `---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata: { id: my-loop, name: My Loop }
agent: { provider: auto }
evaluators:
  - { id: tests, type: command, command: npm test }
budgets: { turns: 5, costUsd: 2 }
---
Achieve the outcome.
`

const recipe = parseLoopRecipe(RECIPE_MD, '/x/my-loop.md', 'repo')

const engine = {
  startRun: vi.fn(async (input: { recipe: typeof recipe; goal: string; repo: string; branch: string; provider: string }) =>
    store.createRun({ recipe: input.recipe, goal: input.goal, repo: input.repo, branch: input.branch, provider: 'claude' }),
  ),
  pause: vi.fn(() => true),
  resume: vi.fn(async () => true),
  cancel: vi.fn(() => false),
  steer: vi.fn(() => true),
  resolveIntervention: vi.fn(async () => true),
  forkRun: vi.fn(async () => null),
} as unknown as LoopEngine

let server: Server
let baseUrl = ''
let store: LoopStore
let artifacts: LoopArtifactStore
let repoDir: string
let tmpRoot: string

const auth = { Authorization: 'Bearer tok' }
const jsonHeaders = { ...auth, 'Content-Type': 'application/json' }

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'codekin-loop-routes-'))
  repoDir = join(tmpRoot, 'repo')
  mkdirSync(join(repoDir, '.codekin', 'loops'), { recursive: true })
  writeFileSync(join(repoDir, '.codekin', 'loops', 'my-loop.md'), RECIPE_MD)

  store = new LoopStore(':memory:')
  artifacts = new LoopArtifactStore(join(tmpRoot, 'artifacts'))
  const app = express()
  app.use(express.json())
  app.use(
    '/api/loops',
    createLoopRouter(
      (token) => token === 'tok',
      (req) => {
        const h = req.headers.authorization
        return h?.startsWith('Bearer ') ? h.slice(7) : undefined
      },
      store,
      engine,
      artifacts,
    ),
  )
  server = app.listen(0)
  await new Promise<void>((res) => server.once('listening', () => res()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/loops`
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
  store.close()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('auth', () => {
  it('rejects without the master token', async () => {
    const res = await fetch(`${baseUrl}/recipes`)
    expect(res.status).toBe(401)
  })
})

describe('recipes', () => {
  it('lists repo recipes for a repoPath', async () => {
    const res = await fetch(`${baseUrl}/recipes?repoPath=${encodeURIComponent(repoDir)}`, { headers: auth })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.recipes.some((r: { id: string }) => r.id === 'my-loop')).toBe(true)
  })

  it('validate returns the parsed recipe or a structured error', async () => {
    const ok = await fetch(`${baseUrl}/recipes/validate`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ content: RECIPE_MD }) })
    const okBody = await ok.json()
    expect(okBody.valid).toBe(true)
    expect(okBody.recipe.id).toBe('my-loop')

    const bad = await fetch(`${baseUrl}/recipes/validate`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ content: RECIPE_MD.replace('{ turns: 5, costUsd: 2 }', '{ turns: 5, costUsd: 2, tokens: 3 }') }),
    })
    const badBody = await bad.json()
    expect(badBody.valid).toBe(false)
    expect(badBody.error).toContain('unknown field budgets.tokens')
  })
})

describe('preflight and start', () => {
  it('preflight resolves the effective config, default branch, and provider', async () => {
    const res = await fetch(`${baseUrl}/runs/preflight`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ recipeId: 'my-loop', repo: repoDir }),
    })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.effective.provider).toBe('claude') // auto resolved
    expect(body.effective.branch).toMatch(/^loop\/my-loop-\d{14}$/)
    expect(body.effective.goal).toBe('Achieve the outcome.')
    expect(body.effective.recipe.contentHash).toBe(recipe.contentHash)
  })

  it('start validates inputs and delegates to the engine', async () => {
    const bad = await fetch(`${baseUrl}/runs`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ recipeId: 'Nope!' }) })
    expect(bad.status).toBe(400)

    const missing = await fetch(`${baseUrl}/runs`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ recipeId: 'unknown-recipe', repo: repoDir }),
    })
    expect(missing.status).toBe(400)
    expect((await missing.json()).error).toContain('No loop recipe')

    const res = await fetch(`${baseUrl}/runs`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ recipeId: 'my-loop', repo: repoDir, branch: 'loop/custom', goal: 'Custom goal' }),
    })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.run.branch).toBe('loop/custom')
    expect(body.run.goal).toBe('Custom goal')
    expect(engine.startRun).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude', branch: 'loop/custom' }))
  })
})

describe('runs and events', () => {
  it('run detail includes stages, evaluations, interventions, and the event cursor', async () => {
    const run = store.createRun({ recipe, goal: 'g', repo: repoDir, branch: 'b', provider: 'claude' })
    const stage = store.createStage(run.id, 'evaluate')
    store.addEvaluation({
      runId: run.id,
      stageId: stage.id,
      evaluatorId: 'tests',
      status: 'pass',
      classification: null,
      summary: 'ok',
      fingerprint: null,
      retryable: false,
      durationMs: 3,
      costUsd: null,
      evidenceArtifactIds: [],
    })
    store.appendEvent({ runId: run.id, type: 'state_changed' })

    const res = await fetch(`${baseUrl}/runs/${run.id}`, { headers: auth })
    const body = await res.json()
    expect(body.run.stages).toHaveLength(1)
    expect(body.run.evaluations).toHaveLength(1)
    expect(body.run.lastSequence).toBe(1)
  })

  it('events stream resumes after a sequence cursor', async () => {
    const run = store.createRun({ recipe, goal: 'g', repo: repoDir, branch: 'b2', provider: 'claude' })
    for (const t of ['a', 'b', 'c']) store.appendEvent({ runId: run.id, type: t })
    const res = await fetch(`${baseUrl}/runs/${run.id}/events?after=1`, { headers: auth })
    const body = await res.json()
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(['b', 'c'])
    expect(body.lastSequence).toBe(3)
  })

  it('rejects an invalid state filter', async () => {
    const res = await fetch(`${baseUrl}/runs?state=exploding`, { headers: auth })
    expect(res.status).toBe(400)
  })

  it('serves artifact bodies scoped to their run', async () => {
    const run = store.createRun({ recipe, goal: 'g', repo: repoDir, branch: 'b3', provider: 'claude' })
    const hash = artifacts.put('evaluator output here')
    const artifact = store.addArtifact({ runId: run.id, kind: 'log', label: 'npm test', contentHash: hash, sizeBytes: 21 })

    const res = await fetch(`${baseUrl}/runs/${run.id}/artifacts/${artifact.id}`, { headers: auth })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('evaluator output here')
    expect(res.headers.get('x-artifact-kind')).toBe('log')

    const cross = await fetch(`${baseUrl}/runs/some-other-run/artifacts/${artifact.id}`, { headers: auth })
    expect(cross.status).toBe(404)
  })
})

describe('branches and overrides', () => {
  it('lists local branches with the detected default', async () => {
    const { execFileSync } = await import('child_process')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir })
    git('init', '-b', 'main')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init')
    git('branch', 'develop')

    const res = await fetch(`${baseUrl}/branches?repoPath=${encodeURIComponent(repoDir)}`, { headers: auth })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.branches.sort()).toEqual(['develop', 'main'])
    expect(body.defaultBranch).toBe('main') // no origin — falls back to well-known names

    const bad = await fetch(`${baseUrl}/branches?repoPath=${encodeURIComponent(join(tmpRoot, 'nope'))}`, { headers: auth })
    expect(bad.status).toBe(400)
  })

  it('preflight applies control-step overrides to the frozen recipe', async () => {
    const res = await fetch(`${baseUrl}/runs/preflight`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        recipeId: 'my-loop',
        repo: repoDir,
        baseBranch: 'develop',
        overrides: { mode: 'guided', budgets: { turns: 9 }, planRequired: true },
      }),
    })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.effective.recipe.policy.mode).toBe('guided')
    expect(body.effective.recipe.budgets.turns).toBe(9)
    expect(body.effective.recipe.plan.required).toBe(true)
    expect(body.effective.baseBranch).toBe('develop')
    expect(body.effective.recipe.contentHash).not.toBe(recipe.contentHash)

    const bad = await fetch(`${baseUrl}/runs/preflight`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ recipeId: 'my-loop', repo: repoDir, overrides: { budgets: { turns: -2 } } }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('lessons, stats, fork', () => {
  it('lists and resolves lessons over REST', async () => {
    const run = store.createRun({ recipe, goal: 'g', repo: repoDir, branch: 'lb', provider: 'claude' })
    const lesson = store.addLesson({ recipeId: 'my-loop', sourceRunId: run.id, kind: 'budget', text: 'Raise the cap.' })

    const list = await fetch(`${baseUrl}/lessons?recipeId=my-loop&status=suggested`, { headers: auth })
    expect(((await list.json()) as { lessons: unknown[] }).lessons).toHaveLength(1)

    const approve = await fetch(`${baseUrl}/lessons/${lesson.id}/approve`, { method: 'POST', headers: auth })
    expect(approve.status).toBe(200)
    const again = await fetch(`${baseUrl}/lessons/${lesson.id}/reject`, { method: 'POST', headers: auth })
    expect(again.status).toBe(409)
  })

  it('recipe stats group runs by frozen recipe hash', async () => {
    const runA = store.createRun({ recipe, goal: 'g', repo: repoDir, branch: 's1', provider: 'claude' })
    store.patchRun(runA.id, { state: 'done', outcome: 'completed', turnCount: 4, costUsd: 2 })
    const altered = { ...recipe, contentHash: 'f'.repeat(64) }
    const runB = store.createRun({ recipe: altered, goal: 'g', repo: repoDir, branch: 's2', provider: 'claude' })
    store.patchRun(runB.id, { state: 'done', outcome: 'failed' })

    const res = await fetch(`${baseUrl}/recipes/my-loop/stats`, { headers: auth })
    const body = (await res.json()) as { versions: Array<{ recipeHash: string; runs: number; succeeded: number; failed: number; avgTurns: number | null }> }
    expect(body.versions.length).toBeGreaterThanOrEqual(2)
    const original = body.versions.find((v) => v.recipeHash === recipe.contentHash)!
    const alteredStats = body.versions.find((v) => v.recipeHash === 'f'.repeat(64))!
    expect(original.succeeded).toBeGreaterThanOrEqual(1)
    expect(alteredStats.failed).toBe(1)
  })

  it('fork delegates to the engine and 404s on unknown runs', async () => {
    const missing = await fetch(`${baseUrl}/runs/nope/fork`, { method: 'POST', headers: auth })
    expect(missing.status).toBe(404)

    const run = store.createRun({ recipe, goal: 'g', repo: repoDir, branch: 'fk', provider: 'claude' })
    const forked = store.createRun({ recipe, goal: 'g', repo: repoDir, branch: 'fk-fork', provider: 'claude' })
    ;(engine.forkRun as ReturnType<typeof vi.fn>).mockResolvedValueOnce(forked)
    const res = await fetch(`${baseUrl}/runs/${run.id}/fork`, { method: 'POST', headers: auth })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { run: { id: string } }).run.id).toBe(forked.id)
  })
})

describe('controls', () => {
  it('pause/resume/steer succeed; cancel maps a refusal to 409', async () => {
    expect((await fetch(`${baseUrl}/runs/r/pause`, { method: 'POST', headers: auth })).status).toBe(200)
    expect((await fetch(`${baseUrl}/runs/r/resume`, { method: 'POST', headers: auth })).status).toBe(200)
    expect((await fetch(`${baseUrl}/runs/r/cancel`, { method: 'POST', headers: auth })).status).toBe(409)

    const noInstruction = await fetch(`${baseUrl}/runs/r/steer`, { method: 'POST', headers: jsonHeaders, body: '{}' })
    expect(noInstruction.status).toBe(400)
    const steer = await fetch(`${baseUrl}/runs/r/steer`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ instruction: 'go left' }),
    })
    expect(steer.status).toBe(200)
    expect(engine.steer).toHaveBeenCalledWith('r', 'go left', false)
  })

  it('resolving an intervention checks run scoping and choice presence', async () => {
    const run = store.createRun({ recipe, goal: 'g', repo: repoDir, branch: 'b4', provider: 'claude' })
    const iv = store.createIntervention({ runId: run.id, kind: 'approval', purpose: 'escalation', title: 'T', options: ['continue', 'stop'] })

    const noChoice = await fetch(`${baseUrl}/runs/${run.id}/interventions/${iv.id}/resolve`, { method: 'POST', headers: jsonHeaders, body: '{}' })
    expect(noChoice.status).toBe(400)

    const wrongRun = await fetch(`${baseUrl}/runs/not-this-run/interventions/${iv.id}/resolve`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ choice: 'continue' }),
    })
    expect(wrongRun.status).toBe(404)

    const ok = await fetch(`${baseUrl}/runs/${run.id}/interventions/${iv.id}/resolve`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ choice: 'continue', note: 'carefully' }),
    })
    expect(ok.status).toBe(200)
    expect(engine.resolveIntervention).toHaveBeenCalledWith(iv.id, 'continue', 'carefully')
  })
})
