/** Tests for the loop template loader — parsing, validation, built-ins, repo overrides. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseLoopTemplate,
  loadBuiltinLoops,
  loadLoopTemplate,
  listLoopTemplates,
  discoverRepoLoops,
  buildGoalRunInput,
} from './loop-loader.js'

const VALID = `---
kind: ci-autorepair
name: CI Autorepair
maker:
  provider: claude
checker:
  provider: opencode
  model: gpt-x
verify:
  - npm test
  - npm run lint
readonly:
  - .github/workflows/**
maxTurns: 12
maxCostUsd: 5
completionPolicy: pr
---
Fix the failing CI checks.`

describe('parseLoopTemplate', () => {
  it('parses a full template into a validated spec', () => {
    const t = parseLoopTemplate(VALID, 'x.md', 'builtin')
    expect(t.kind).toBe('ci-autorepair')
    expect(t.name).toBe('CI Autorepair')
    expect(t.goal).toBe('Fix the failing CI checks.')
    expect(t.source).toBe('builtin')
    expect(t.spec.maker).toEqual({ provider: 'claude' })
    expect(t.spec.checker).toEqual({ provider: 'opencode', model: 'gpt-x' })
    expect(t.spec.verify).toEqual(['npm test', 'npm run lint'])
    expect(t.spec.readonly).toEqual(['.github/workflows/**'])
    expect(t.spec.maxTurns).toBe(12)
    expect(t.spec.completionPolicy).toBe('pr')
  })

  it('treats an omitted checker as a single-provider loop', () => {
    const md = `---
kind: coverage-increase
name: Coverage
maker:
  provider: claude
verify:
  - npm test
maxTurns: 8
maxCostUsd: 3
---
Add tests.`
    const t = parseLoopTemplate(md, 'x.md', 'repo')
    expect(t.spec.checker).toBeNull()
    expect(t.spec.completionPolicy).toBe('pr') // defaulted
  })

  it('accepts a custom (non-built-in) kind — kinds are an open set', () => {
    const md = VALID.replace('kind: ci-autorepair', 'kind: flaky-e2e.quarantine')
    const t = parseLoopTemplate(md, 'x.md', 'repo')
    expect(t.kind).toBe('flaky-e2e.quarantine')
  })

  it('rejects a kind that is not a safe slug', () => {
    for (const bad of ['kind: World Domination', 'kind: UPPER', 'kind: ../escape', `kind: ${'x'.repeat(65)}`]) {
      const md = VALID.replace('kind: ci-autorepair', bad)
      expect(() => parseLoopTemplate(md, 'x.md', 'builtin')).toThrow(/kind must be a lowercase slug/)
    }
  })

  it('rejects an unknown provider', () => {
    const md = VALID.replace('provider: claude', 'provider: skynet')
    expect(() => parseLoopTemplate(md, 'x.md', 'builtin')).toThrow(/maker.provider must be one of/)
  })

  it('rejects an empty verify list', () => {
    const md = VALID.replace('verify:\n  - npm test\n  - npm run lint', 'verify: []')
    expect(() => parseLoopTemplate(md, 'x.md', 'builtin')).toThrow(/at least one command/)
  })

  it('rejects a non-positive budget', () => {
    const md = VALID.replace('maxTurns: 12', 'maxTurns: 0')
    expect(() => parseLoopTemplate(md, 'x.md', 'builtin')).toThrow(/maxTurns must be a positive number/)
  })

  it('rejects an invalid completion policy', () => {
    const md = VALID.replace('completionPolicy: pr', 'completionPolicy: yolo')
    expect(() => parseLoopTemplate(md, 'x.md', 'builtin')).toThrow(/completionPolicy must be one of/)
  })

  it('rejects a file with no frontmatter', () => {
    expect(() => parseLoopTemplate('just a body', 'x.md', 'builtin')).toThrow(/no YAML frontmatter/)
  })

  it('rejects an empty goal body', () => {
    const md = VALID.replace('Fix the failing CI checks.', '   ')
    expect(() => parseLoopTemplate(md, 'x.md', 'builtin')).toThrow(/body \(goal text\) is empty/)
  })
})

describe('built-in templates', () => {
  it('ships and parses all three built-in loops', () => {
    const loops = loadBuiltinLoops(true)
    const kinds = loops.map((l) => l.kind).sort()
    expect(kinds).toEqual(['ci-autorepair', 'coverage-increase', 'dependency-upgrade'])
    for (const l of loops) {
      expect(l.spec.verify.length).toBeGreaterThan(0)
      expect(l.goal.length).toBeGreaterThan(0)
      expect(l.source).toBe('builtin')
    }
  })

  it('listLoopTemplates returns the built-in kinds', () => {
    const infos = listLoopTemplates()
    expect(infos.map((i) => i.kind).sort()).toEqual(['ci-autorepair', 'coverage-increase', 'dependency-upgrade'])
    expect(infos.every((i) => i.source === 'builtin')).toBe(true)
  })

  it('loadLoopTemplate resolves a built-in by kind', () => {
    const t = loadLoopTemplate('dependency-upgrade')
    expect(t?.kind).toBe('dependency-upgrade')
    expect(t?.spec.verify).toContain('npm run build')
  })
})

describe('repo overrides', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loop-repo-'))
    mkdirSync(join(repo, '.codekin', 'loops'), { recursive: true })
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('a repo template overrides the built-in of the same kind', () => {
    const override = VALID.replace('maxTurns: 12', 'maxTurns: 99')
    writeFileSync(join(repo, '.codekin', 'loops', 'ci-autorepair.md'), override)

    const repoLoops = discoverRepoLoops(repo)
    expect(repoLoops).toHaveLength(1)
    expect(repoLoops[0].source).toBe('repo')

    const resolved = loadLoopTemplate('ci-autorepair', repo)
    expect(resolved?.source).toBe('repo')
    expect(resolved?.spec.maxTurns).toBe(99)
  })

  it('falls back to the built-in when no repo override exists', () => {
    const resolved = loadLoopTemplate('ci-autorepair', repo)
    expect(resolved?.source).toBe('builtin')
  })
})

describe('buildGoalRunInput', () => {
  const template = parseLoopTemplate(VALID, 'x.md', 'builtin')

  it('maps a template into a CreateGoalRunInput with runtime repo/branch', () => {
    const input = buildGoalRunInput(template, { repo: '/repo', branch: 'fix/ci' })
    expect(input).toEqual({
      kind: 'ci-autorepair',
      goal: 'Fix the failing CI checks.',
      spec: template.spec,
      repo: '/repo',
      branch: 'fix/ci',
    })
  })

  it('uses an explicit goal override when provided', () => {
    const input = buildGoalRunInput(template, { repo: '/repo', branch: 'fix/ci', goal: 'job `build` failed: tsc error' })
    expect(input.goal).toBe('job `build` failed: tsc error')
  })

  it('falls back to the template goal when the override is blank', () => {
    const input = buildGoalRunInput(template, { repo: '/repo', branch: 'fix/ci', goal: '   ' })
    expect(input.goal).toBe('Fix the failing CI checks.')
  })
})
