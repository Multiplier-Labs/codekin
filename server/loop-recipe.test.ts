import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseLoopRecipe,
  parseDurationMs,
  resolveAgentProvider,
  resolveRubricProvider,
  loadBuiltinRecipes,
  loadLoopRecipe,
  listLoopRecipes,
  discoverRepoRecipes,
  isValidRecipeId,
} from './loop-recipe.js'

const VALID = `---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata:
  id: ci-repair
  name: Repair failing CI
  description: Diagnose and repair the current branch.
agent:
  provider: auto
workspace:
  strategy: worktree
  protectedPaths: [".github/workflows/**"]
evaluators:
  - id: tests
    type: command
    command: npm test
    timeout: 10m
    retry: { maxAttempts: 2 }
  - id: lint
    type: command
    command: ["npm", "run", "lint"]
  - id: review
    type: rubric
    provider: different-from-maker
    instructions: Watch for weakened tests.
budgets:
  turns: 12
  costUsd: 5
  wallTime: 45m
policy:
  mode: guarded
completion:
  action: pull-request
---
The CI checks are failing on this branch. Diagnose and fix the root cause.
`

function parse(content: string) {
  return parseLoopRecipe(content, '/x/recipe.md', 'builtin')
}

/** VALID with one literal replacement applied. */
function mutate(from: string, to: string) {
  return parse(VALID.replace(from, to))
}

describe('parseLoopRecipe', () => {
  it('parses a full valid recipe with defaults applied', () => {
    const r = parse(VALID)
    expect(r.id).toBe('ci-repair')
    expect(r.name).toBe('Repair failing CI')
    expect(r.agent.provider).toBe('auto')
    expect(r.workspace.protectedPaths).toEqual(['.github/workflows/**'])
    expect(r.evaluators).toHaveLength(3)
    expect(r.evaluators[0]).toMatchObject({ id: 'tests', type: 'command', timeoutMs: 600_000, required: true, retryMaxAttempts: 2 })
    expect(r.evaluators[1]).toMatchObject({ command: ['npm', 'run', 'lint'], retryMaxAttempts: 1 })
    expect(r.evaluators[2]).toMatchObject({ type: 'rubric', provider: 'different-from-maker' })
    expect(r.budgets).toEqual({ turns: 12, costUsd: 5, wallTimeMs: 45 * 60_000, noProgressAttempts: 3 })
    expect(r.policy.mode).toBe('guarded')
    expect(r.completion.action).toBe('pull-request')
    expect(r.outcome).toContain('CI checks are failing')
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('applies section defaults when workspace/policy/completion are omitted', () => {
    const minimal = `---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata: { id: mini, name: Mini }
agent: { provider: claude }
evaluators:
  - { id: t, type: command, command: npm test }
budgets: { turns: 5, costUsd: 2 }
---
Do the thing.
`
    const r = parse(minimal)
    expect(r.workspace).toEqual({ strategy: 'worktree', protectedPaths: [] })
    expect(r.policy.mode).toBe('guarded')
    expect(r.completion.action).toBe('pull-request')
    expect(r.budgets.wallTimeMs).toBeUndefined()
  })

  it('content hash is stable across sources and changes with content', () => {
    const a = parseLoopRecipe(VALID, '/a.md', 'builtin')
    const b = parseLoopRecipe(VALID, '/b.md', 'repo')
    expect(a.contentHash).toBe(b.contentHash)
    const c = mutate('turns: 12', 'turns: 13')
    expect(c.contentHash).not.toBe(a.contentHash)
  })

  it('rejects unknown fields at every level', () => {
    expect(() => mutate('policy:', 'surprise: 1\npolicy:')).toThrow(/unknown field recipe\.surprise/)
    expect(() => mutate('provider: auto', 'provider: auto\n  fancy: yes')).toThrow(/unknown field agent\.fancy/)
    expect(() => mutate('turns: 12', 'turns: 12\n  tokens: 5')).toThrow(/unknown field budgets\.tokens/)
  })

  it('rejects wrong apiVersion, kind, and malformed ids', () => {
    expect(() => mutate('codekin.dev/v2', 'codekin.dev/v1')).toThrow(/apiVersion/)
    expect(() => mutate('kind: LoopRecipe', 'kind: Recipe')).toThrow(/kind/)
    expect(() => mutate('id: ci-repair', 'id: "Bad Id!"')).toThrow(/metadata\.id/)
  })

  it('rejects unknown evaluator types', () => {
    expect(() => mutate('type: rubric', 'type: vibes')).toThrow(/not a known evaluator type/)
  })

  it('parses every Phase 3 evaluator type with defaults and validates composite refs', () => {
    const md = `---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata: { id: full, name: Full }
agent: { provider: claude }
evaluators:
  - { id: tests, type: test-report, command: npx vitest run, parser: vitest }
  - { id: scope, type: diff-policy, maxChangedLines: 500, forbidPaths: ["dist/**"] }
  - { id: report, type: artifact, path: "reports/out.md", minBytes: 10 }
  - { id: signoff, type: human, title: "Does the output read well?" }
  - { id: checks, type: ci, checks: ["test-and-lint"], timeout: 30m }
  - { id: gate, type: composite, op: all, of: [tests, scope] }
budgets: { turns: 5, costUsd: 2 }
---
Goal.
`
    const r = parse(md)
    expect(r.evaluators.map((e) => e.type)).toEqual(['test-report', 'diff-policy', 'artifact', 'human', 'ci', 'composite'])
    expect(r.evaluators[0]).toMatchObject({ parser: 'vitest', timeoutMs: 600_000, retryMaxAttempts: 1 })
    expect(r.evaluators[1]).toMatchObject({ noTestWeakening: true, secretScan: true, maxChangedFiles: undefined })
    expect(r.evaluators[4]).toMatchObject({ timeoutMs: 30 * 60_000 })

    expect(() => parse(md.replace('of: [tests, scope]', 'of: [nope]'))).toThrow(/unknown evaluator "nope"/)
    expect(() => parse(md.replace('of: [tests, scope]', 'of: [gate]'))).toThrow(/cannot reference itself/)
    expect(() => parse(md.replace('parser: vitest', 'parser: junit-xml'))).toThrow(/reportPath is required/)
    expect(() => parse(md.replace('path: "reports/out.md"', 'path: "../escape.md"'))).toThrow(/relative path/)
  })

  it('requires at least one required command evaluator as the deterministic gate', () => {
    const noCommand = `---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata: { id: r, name: R }
agent: { provider: claude }
evaluators:
  - { id: rev, type: rubric, provider: codex }
budgets: { turns: 5, costUsd: 2 }
---
Goal.
`
    expect(() => parse(noCommand)).toThrow(/deterministic gate/)
    expect(() => mutate('command: npm test\n    timeout: 10m', 'command: npm test\n    required: false\n    timeout: 10m')).not.toThrow()
  })

  it('rejects duplicate evaluator ids and empty bodies', () => {
    expect(() => mutate('id: lint', 'id: tests')).toThrow(/duplicate evaluator id/)
    expect(() => parse(VALID.replace(/---\nThe CI checks[\s\S]*$/, '---\n'))).toThrow(/outcome prompt/)
  })
})

describe('parseDurationMs', () => {
  it('parses seconds, minutes, hours, and bare minutes', () => {
    expect(parseDurationMs('90s', 'f', '/x')).toBe(90_000)
    expect(parseDurationMs('10m', 'f', '/x')).toBe(600_000)
    expect(parseDurationMs('2h', 'f', '/x')).toBe(7_200_000)
    expect(parseDurationMs(45, 'f', '/x')).toBe(45 * 60_000)
  })

  it('rejects garbage', () => {
    expect(() => parseDurationMs('soon', 'f', '/x')).toThrow(/duration/)
    expect(() => parseDurationMs('-5m', 'f', '/x')).toThrow(/duration/)
  })
})

describe('provider resolution', () => {
  it('auto resolves to claude; explicit providers pass through', () => {
    expect(resolveAgentProvider('auto')).toBe('claude')
    expect(resolveAgentProvider('codex')).toBe('codex')
  })

  it('different-from-maker never grades its own work', () => {
    expect(resolveRubricProvider('different-from-maker', 'claude')).toBe('codex')
    expect(resolveRubricProvider('different-from-maker', 'codex')).toBe('claude')
    expect(resolveRubricProvider('different-from-maker', 'opencode')).toBe('claude')
    expect(resolveRubricProvider('opencode', 'claude')).toBe('opencode')
  })
})

describe('file discovery', () => {
  it('repo recipes override built-ins of the same id and list correctly', () => {
    const root = mkdtempSync(join(tmpdir(), 'codekin-recipes-'))
    try {
      const dir = join(root, '.codekin', 'loops')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'custom.md'), VALID.replace('id: ci-repair', 'id: my-loop').replace('name: Repair failing CI', 'name: Mine'))
      writeFileSync(join(dir, 'broken.md'), '---\nnot: a recipe\n---\nbody')

      const found = discoverRepoRecipes(root)
      expect(found.map((r) => r.id)).toEqual(['my-loop'])
      expect(loadLoopRecipe('my-loop', root)?.name).toBe('Mine')
      expect(loadLoopRecipe('my-loop')).toBeNull()

      const infos = listLoopRecipes(root)
      expect(infos.find((i) => i.id === 'my-loop')?.source).toBe('repo')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('withOverrides', () => {
  it('applies mode/budget/plan overrides and recomputes the hash', async () => {
    const { withOverrides } = await import('./loop-recipe.js')
    const base = parse(VALID)
    const next = withOverrides(base, {
      mode: 'guided',
      budgets: { turns: 20, wallTimeMinutes: 30 },
      planRequired: true,
    })
    expect(next.policy.mode).toBe('guided')
    expect(next.budgets).toEqual({ turns: 20, costUsd: 5, wallTimeMs: 30 * 60_000, noProgressAttempts: 3 })
    expect(next.plan.required).toBe(true)
    expect(next.contentHash).not.toBe(base.contentHash)
    // No overrides that change anything → same hash as a no-op application.
    expect(withOverrides(base, {}).contentHash).toBe(base.contentHash)
    // Base is untouched.
    expect(base.policy.mode).toBe('guarded')
  })

  it('rejects invalid override values', async () => {
    const { withOverrides } = await import('./loop-recipe.js')
    const base = parse(VALID)
    expect(() => withOverrides(base, { mode: 'yolo' as never })).toThrow(/Invalid mode/)
    expect(() => withOverrides(base, { budgets: { turns: -1 } })).toThrow(/positive number/)
  })
})

describe('built-in recipes', () => {
  it('every shipped recipe parses under strict validation', () => {
    const recipes = loadBuiltinRecipes(true) // strict: any parse error throws
    expect(recipes.map((r) => r.id).sort()).toEqual(['ci-autorepair', 'coverage-increase', 'dependency-upgrade'])
    for (const r of recipes) {
      expect(r.evaluators.some((e) => e.type === 'command' && e.required)).toBe(true)
      expect(r.completion.action).toBe('pull-request')
    }
  })
})

describe('isValidRecipeId', () => {
  it('accepts slugs, rejects everything else', () => {
    expect(isValidRecipeId('ci-repair')).toBe(true)
    expect(isValidRecipeId('a.b_c-1')).toBe(true)
    expect(isValidRecipeId('Nope')).toBe(false)
    expect(isValidRecipeId('-lead')).toBe(false)
    expect(isValidRecipeId('')).toBe(false)
    expect(isValidRecipeId(42)).toBe(false)
  })
})
