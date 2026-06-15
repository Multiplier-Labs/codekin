/**
 * Tests for orchestrator-learning — the self-improving memory layer:
 * candidate extraction, deduplication, aging/decay, finding-outcome pattern
 * learning, the user skill model, and decision history.
 *
 * orchestrator-manager is mocked to point ORCHESTRATOR_DIR at a real temp
 * directory (so skill-profile.json and journal compaction have somewhere to
 * write), and OrchestratorMemory uses an in-memory SQLite DB per test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'

const ORCH_DIR = '/tmp/codekin-orch-learning-test'

vi.mock('./orchestrator-manager.js', () => ({
  ORCHESTRATOR_DIR: '/tmp/codekin-orch-learning-test',
}))

import { OrchestratorMemory } from './orchestrator-memory.js'
import {
  extractMemoryCandidates,
  findDuplicate,
  smartUpsert,
  runAgingCycle,
  recordFindingOutcome,
  getTriageRecommendation,
  loadSkillProfile,
  saveSkillProfile,
  updateSkillLevel,
  getGuidanceStyle,
  recordDecision,
  assessDecisionOutcome,
  getPendingOutcomeAssessments,
  type MemoryCandidate,
  type FindingOutcome,
  type SkillLevel,
  type DecisionRecord,
} from './orchestrator-learning.js'

const JOURNAL_DIR = join(ORCH_DIR, 'journal')

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

function makeOutcome(overrides: Partial<FindingOutcome> = {}): FindingOutcome {
  return {
    findingId: 'f-1',
    repo: '/repos/codekin',
    category: 'security',
    severity: 'high',
    action: 'implemented',
    reason: 'worth fixing',
    sessionId: null,
    outcome: 'success',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe('orchestrator-learning', () => {
  let mem: OrchestratorMemory

  beforeEach(() => {
    // Fresh temp dir each test; remove any leftover skill profile / journals.
    rmSync(ORCH_DIR, { recursive: true, force: true })
    mkdirSync(ORCH_DIR, { recursive: true })
    mem = new OrchestratorMemory(':memory:')
  })

  afterEach(() => {
    mem.close()
    rmSync(ORCH_DIR, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // extractMemoryCandidates
  // -------------------------------------------------------------------------

  describe('extractMemoryCandidates', () => {
    it('extracts a user_preference from a stated preference', () => {
      const out = extractMemoryCandidates('I prefer dark mode everywhere', '', null)
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({
        memoryType: 'user_preference',
        title: 'User preference',
        confidence: 0.9,
      })
    })

    it('extracts a background signal when the user describes their role', () => {
      const out = extractMemoryCandidates("I'm a senior backend engineer", '', null)
      expect(out).toHaveLength(1)
      expect(out[0].title).toBe('User background')
      expect(out[0].tags).toContain('skill-signal')
    })

    it('extracts an explicit remember request scoped to the current repo', () => {
      const out = extractMemoryCandidates('Please remember that I use tabs', '', '/repos/codekin')
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({
        title: 'User asked to remember',
        scope: '/repos/codekin',
        confidence: 1.0,
      })
    })

    it('extracts a decision candidate from a decision phrase', () => {
      const out = extractMemoryCandidates("Let's go with Postgres", 'Postgres is a solid choice', '/repos/codekin')
      expect(out).toHaveLength(1)
      expect(out[0].memoryType).toBe('decision')
      expect(out[0].content).toContain('Postgres')
    })

    it('extracts repo_context from a long assistant response that describes the project', () => {
      const longResponse =
        'This project uses TypeScript with a Vite build and a Node WebSocket server. ' +
        'It is organised into a React frontend and a server package that talk over a shared protocol. '.repeat(2)
      const out = extractMemoryCandidates('', longResponse, '/repos/codekin')
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({
        memoryType: 'repo_context',
        scope: '/repos/codekin',
      })
      expect(out[0].title).toContain('codekin')
    })

    it('does not extract repo_context when there is no current repo', () => {
      const longResponse = 'This project uses TypeScript. '.repeat(20)
      const out = extractMemoryCandidates('', longResponse, null)
      expect(out).toHaveLength(0)
    })

    it('returns nothing for a neutral message', () => {
      expect(extractMemoryCandidates('what time is it', 'It is noon', null)).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // findDuplicate / smartUpsert
  // -------------------------------------------------------------------------

  describe('deduplication', () => {
    const candidate: MemoryCandidate = {
      memoryType: 'user_preference',
      title: 'User preference',
      content: 'deployment configuration always uses kubernetes manifests reliably',
      scope: null,
      tags: ['preference'],
      confidence: 0.9,
    }

    it('inserts a brand-new candidate', () => {
      const res = smartUpsert(mem, candidate)
      expect(res.action).toBe('inserted')
      expect(mem.get(res.id)).not.toBeNull()
    })

    it('finds an existing item as a duplicate of an identical candidate', () => {
      smartUpsert(mem, candidate)
      const dup = findDuplicate(mem, candidate)
      expect(dup).not.toBeNull()
      expect(dup?.memoryType).toBe('user_preference')
    })

    it('skips an identical candidate with equal-or-lower confidence', () => {
      smartUpsert(mem, candidate)
      const res = smartUpsert(mem, candidate)
      expect(res.action).toBe('skipped')
    })

    it('updates an existing item when the new candidate is more confident', () => {
      const first = smartUpsert(mem, candidate)
      const res = smartUpsert(mem, { ...candidate, confidence: 0.99 })
      expect(res.action).toBe('updated')
      expect(res.id).toBe(first.id)
      expect(mem.get(res.id)?.confidence).toBeCloseTo(0.99)
    })

    it('does not treat a different memory type as a duplicate', () => {
      smartUpsert(mem, candidate)
      const dup = findDuplicate(mem, { ...candidate, memoryType: 'decision' })
      expect(dup).toBeNull()
    })

    it('returns null when the candidate has no usable search terms', () => {
      const dup = findDuplicate(mem, { ...candidate, title: 'a', content: 'b c' })
      expect(dup).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // runAgingCycle
  // -------------------------------------------------------------------------

  describe('runAgingCycle', () => {
    it('expires items past their TTL', () => {
      mem.upsert({
        memoryType: 'journal',
        scope: null,
        title: 'stale',
        content: 'old entry',
        sourceRef: null,
        confidence: 0.8,
        expiresAt: isoDaysAgo(1),
        isPinned: false,
        tags: [],
      })
      const { expired } = runAgingCycle(mem)
      expect(expired).toBeGreaterThanOrEqual(1)
    })

    it('decays confidence of old, non-pinned, un-accessed items', () => {
      const id = mem.upsert({
        memoryType: 'decision',
        scope: null,
        title: 'old decision',
        content: 'decided something a while ago',
        sourceRef: null,
        confidence: 0.8,
        expiresAt: null,
        isPinned: false,
        tags: [],
      })
      // Force updated_at into the past so the decay branch applies.
      ;(mem as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
        .prepare('UPDATE memory_items SET updated_at = ? WHERE id = ?')
        .run(isoDaysAgo(45), id)

      const { decayed } = runAgingCycle(mem)
      expect(decayed).toBeGreaterThanOrEqual(1)
      expect(mem.get(id)!.confidence).toBeLessThan(0.8)
    })

    it('compacts journal files older than 30 days into a monthly summary', () => {
      mkdirSync(JOURNAL_DIR, { recursive: true })
      writeFileSync(join(JOURNAL_DIR, '2020-01-15.md'), 'entry one', 'utf-8')
      writeFileSync(join(JOURNAL_DIR, '2020-01-20.md'), 'entry two', 'utf-8')

      const { compacted } = runAgingCycle(mem)
      expect(compacted).toBe(2)
      const summary = join(JOURNAL_DIR, '2020-01-summary.md')
      expect(existsSync(summary)).toBe(true)
      expect(readFileSync(summary, 'utf-8')).toContain('Journal Summary: 2020-01')
    })

    it('returns zero compactions when no journal directory exists', () => {
      const { compacted } = runAgingCycle(mem)
      expect(compacted).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Finding outcomes + triage recommendation
  // -------------------------------------------------------------------------

  describe('finding-outcome learning', () => {
    it('records a finding outcome retrievable as a finding_outcome memory', () => {
      recordFindingOutcome(mem, makeOutcome())
      const items = mem.list({ memoryType: 'finding_outcome' })
      expect(items).toHaveLength(1)
      expect(items[0].title).toContain('security')
    })

    it('returns "unknown" with no historical data', () => {
      const rec = getTriageRecommendation(mem, 'security', 'high', '/repos/codekin')
      expect(rec.action).toBe('unknown')
      expect(rec.confidence).toBe(0)
    })

    it('recommends "implement" when similar findings were usually implemented successfully', () => {
      for (let i = 0; i < 4; i++) {
        recordFindingOutcome(mem, makeOutcome({ findingId: `f-${i}`, action: 'implemented', outcome: 'success' }))
      }
      const rec = getTriageRecommendation(mem, 'security', 'high', '/repos/codekin')
      expect(rec.action).toBe('implement')
      expect(rec.confidence).toBeGreaterThan(0)
    })

    it('recommends "skip" when similar findings were usually skipped', () => {
      for (let i = 0; i < 4; i++) {
        recordFindingOutcome(mem, makeOutcome({ findingId: `f-${i}`, action: 'skipped', outcome: null }))
      }
      const rec = getTriageRecommendation(mem, 'security', 'high', '/repos/codekin')
      expect(rec.action).toBe('skip')
    })

    it('returns "unknown" for a genuinely mixed history', () => {
      recordFindingOutcome(mem, makeOutcome({ findingId: 'a', action: 'implemented', outcome: 'success' }))
      recordFindingOutcome(mem, makeOutcome({ findingId: 'b', action: 'skipped', outcome: null }))
      recordFindingOutcome(mem, makeOutcome({ findingId: 'c', action: 'deferred', outcome: 'pending' }))
      const rec = getTriageRecommendation(mem, 'security', 'high', '/repos/codekin')
      expect(rec.action).toBe('unknown')
      expect(rec.confidence).toBeCloseTo(0.3)
    })
  })

  // -------------------------------------------------------------------------
  // Skill model
  // -------------------------------------------------------------------------

  describe('skill model', () => {
    it('returns an empty profile when none has been saved', () => {
      expect(loadSkillProfile()).toEqual([])
    })

    it('round-trips a profile through save + load', () => {
      const profile: SkillLevel[] = [
        { domain: 'typescript', level: 'advanced', confidence: 0.7, signals: ['x'], lastUpdated: 'now' },
      ]
      saveSkillProfile(profile)
      expect(loadSkillProfile()).toEqual(profile)
    })

    it('creates a new domain entry on first signal', () => {
      const skill = updateSkillLevel('devops', 'configured CI alone', 'intermediate')
      expect(skill).toMatchObject({ domain: 'devops', level: 'intermediate', confidence: 0.5 })
      expect(skill.signals).toEqual(['configured CI alone'])
    })

    it('increases confidence when the same level is observed again', () => {
      updateSkillLevel('devops', 's1', 'intermediate')
      const again = updateSkillLevel('devops', 's2', 'intermediate')
      expect(again.confidence).toBeCloseTo(0.6)
      expect(again.signals).toEqual(['s1', 's2'])
    })

    it('promotes a domain once enough higher-level evidence accrues', () => {
      updateSkillLevel('rust', 's1', 'beginner') // confidence 0.5
      updateSkillLevel('rust', 's2', 'advanced') // 0.5 + 0.15 = 0.65, no promotion yet
      const promoted = updateSkillLevel('rust', 's3', 'advanced') // 0.65 + 0.15 >= 0.7 -> promote
      expect(promoted.level).toBe('advanced')
      expect(promoted.confidence).toBeCloseTo(0.6)
    })

    it('caps stored signals at 20', () => {
      for (let i = 0; i < 25; i++) updateSkillLevel('python', `s${i}`, 'intermediate')
      const profile = loadSkillProfile()
      const python = profile.find(s => s.domain === 'python')!
      expect(python.signals).toHaveLength(20)
      expect(python.signals[0]).toBe('s5')
    })
  })

  describe('getGuidanceStyle', () => {
    it('defaults to collaborative/moderate with no profile', () => {
      expect(getGuidanceStyle()).toMatchObject({ tone: 'collaborative', explainLevel: 'moderate' })
    })

    it('returns tutorial/detailed for a beginner-heavy profile', () => {
      saveSkillProfile([{ domain: 'go', level: 'beginner', confidence: 0.5, signals: [], lastUpdated: 'now' }])
      expect(getGuidanceStyle()).toMatchObject({ tone: 'tutorial', explainLevel: 'detailed' })
    })

    it('returns collaborative for an intermediate profile', () => {
      saveSkillProfile([{ domain: 'go', level: 'intermediate', confidence: 0.5, signals: [], lastUpdated: 'now' }])
      expect(getGuidanceStyle().tone).toBe('collaborative')
    })

    it('returns concise/minimal for an expert profile', () => {
      saveSkillProfile([{ domain: 'go', level: 'expert', confidence: 0.9, signals: [], lastUpdated: 'now' }])
      expect(getGuidanceStyle()).toMatchObject({ tone: 'concise', explainLevel: 'minimal' })
    })
  })

  // -------------------------------------------------------------------------
  // Decision history
  // -------------------------------------------------------------------------

  describe('decision history', () => {
    function baseDecision(overrides: Partial<DecisionRecord> = {}) {
      return {
        decision: 'use a worktree per session',
        rationale: 'isolation',
        repo: '/repos/codekin',
        relatedFinding: null,
        expectedOutcome: 'fewer collisions',
        ...overrides,
      }
    }

    it('records a decision as a decision memory', () => {
      const id = recordDecision(mem, baseDecision())
      const item = mem.get(id)
      expect(item?.memoryType).toBe('decision')
      const parsed = JSON.parse(item!.content) as DecisionRecord
      expect(parsed.actualOutcome).toBeNull()
      expect(parsed.decision).toBe('use a worktree per session')
    })

    it('assesses the outcome of an existing decision', () => {
      const id = recordDecision(mem, baseDecision())
      expect(assessDecisionOutcome(mem, id, 'worked well')).toBe(true)
      const parsed = JSON.parse(mem.get(id)!.content) as DecisionRecord
      expect(parsed.actualOutcome).toBe('worked well')
      expect(parsed.outcomeAssessedAt).not.toBeNull()
    })

    it('returns false when assessing a missing decision', () => {
      expect(assessDecisionOutcome(mem, 'does-not-exist', 'x')).toBe(false)
    })

    it('returns false when the id is not a decision', () => {
      const id = mem.upsert({
        memoryType: 'journal',
        scope: null,
        title: 'note',
        content: 'not a decision',
        sourceRef: null,
        confidence: 0.5,
        expiresAt: null,
        isPinned: false,
        tags: [],
      })
      expect(assessDecisionOutcome(mem, id, 'x')).toBe(false)
    })

    it('lists decisions older than 7 days with no outcome as pending', () => {
      const oldRecord: DecisionRecord = {
        id: 'decision-old',
        decision: 'old call',
        rationale: 'r',
        repo: null,
        relatedFinding: null,
        expectedOutcome: 'e',
        actualOutcome: null,
        outcomeAssessedAt: null,
        timestamp: isoDaysAgo(10),
      }
      mem.upsert({
        memoryType: 'decision',
        scope: null,
        title: 'Decision: old call',
        content: JSON.stringify(oldRecord),
        sourceRef: null,
        confidence: 0.8,
        expiresAt: null,
        isPinned: false,
        tags: ['decision'],
      })

      const pending = getPendingOutcomeAssessments(mem)
      expect(pending.map(d => d.id)).toContain('decision-old')
    })

    it('does not list a freshly recorded decision as pending', () => {
      recordDecision(mem, baseDecision())
      expect(getPendingOutcomeAssessments(mem)).toHaveLength(0)
    })
  })
})
