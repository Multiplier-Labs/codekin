/**
 * Orchestrator self-improving memory — extraction, deduplication, aging,
 * pattern learning, and user skill modeling.
 *
 * This module adds the intelligence layer on top of OrchestratorMemory:
 * - Extracts memory candidates from session interactions
 * - Deduplicates against existing memories using FTS similarity
 * - Ages and decays stale items on a schedule
 * - Tracks finding outcomes to improve future triage
 * - Maintains a user skill model that adapts guidance
 * - Records decisions with outcome tracking
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { OrchestratorMemory, type MemoryType, type MemoryItem } from './orchestrator-memory.js'
import { ORCHESTRATOR_DIR } from './orchestrator-manager.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A candidate extracted from a session interaction. */
export interface MemoryCandidate {
  memoryType: MemoryType
  title: string
  content: string
  scope: string | null
  tags: string[]
  confidence: number
}

/** Finding outcome — tracks what happened when a finding was acted on or skipped. */
export interface FindingOutcome {
  findingId: string
  repo: string
  category: string        // report category: security, code-review, etc.
  severity: string        // low, medium, high, critical
  action: 'implemented' | 'skipped' | 'deferred'
  reason: string          // why this action was taken
  sessionId: string | null // child session that implemented it, if any
  outcome: 'success' | 'failure' | 'pending' | null  // result of implementation
  timestamp: string
}

/** User skill assessment per domain. */
export interface SkillLevel {
  domain: string          // e.g., 'typescript', 'devops', 'testing', 'security'
  level: 'beginner' | 'intermediate' | 'advanced' | 'expert'
  confidence: number      // how sure we are about this assessment
  signals: string[]       // evidence supporting the assessment
  lastUpdated: string
}

/** A decision record with outcome tracking. */
export interface DecisionRecord {
  id: string
  decision: string        // what was decided
  rationale: string       // why
  repo: string | null
  relatedFinding: string | null  // finding ID if this was a triage decision
  expectedOutcome: string
  actualOutcome: string | null
  outcomeAssessedAt: string | null
  timestamp: string
}

// ---------------------------------------------------------------------------
// Default TTLs (in days)
// ---------------------------------------------------------------------------

const TTL_DAYS: Record<MemoryType, number | null> = {
  user_preference: null,     // permanent (pinned)
  repo_context: null,        // permanent until repo removed
  decision: 90,
  finding_outcome: 180,
  session_summary: 60,
  journal: 30,
}

// ---------------------------------------------------------------------------
// Memory Extraction
// ---------------------------------------------------------------------------

/**
 * Extract memory candidates from an interaction transcript.
 *
 * This is a rule-based extractor that looks for patterns indicating
 * durable information worth remembering. In future, this could be
 * enhanced with an LLM call for richer extraction.
 */
export function extractMemoryCandidates(
  userMessage: string,
  assistantResponse: string,
  currentRepo: string | null,
): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = []

  // Pattern 1: User states a preference ("I prefer...", "always use...", "don't...")
  const prefPatterns = [
    /\bi\s+prefer\b/i,
    /\balways\s+(use|do|run|make)\b/i,
    /\bdon'?t\s+(ever|always)\b/i,
    /\bnever\s+(do|use|run|make)\b/i,
    /\bplease\s+always\b/i,
    /\bmy\s+preference\s+is\b/i,
  ]
  for (const pat of prefPatterns) {
    if (pat.test(userMessage)) {
      candidates.push({
        memoryType: 'user_preference',
        title: 'User preference',
        content: userMessage.slice(0, 500),
        scope: null,
        tags: ['preference', 'user-stated'],
        confidence: 0.9,
      })
      break
    }
  }

  // Pattern 2: User describes their role or expertise
  const rolePatterns = [
    /\bi(?:'m| am)\s+a\s+(senior|junior|lead|staff|principal|intern)?\s*\w*/i,
    /\bmy\s+role\s+is\b/i,
    /\bi\s+work\s+(?:as|on|in|with)\b/i,
    /\bi(?:'ve| have)\s+been\s+(?:doing|working|coding|programming)\b/i,
    /\bfirst\s+time\s+(?:using|working|touching|doing)\b/i,
    /\bnew\s+to\s+(?:this|react|go|python|typescript|rust|devops)\b/i,
  ]
  for (const pat of rolePatterns) {
    if (pat.test(userMessage)) {
      candidates.push({
        memoryType: 'user_preference',
        title: 'User background',
        content: userMessage.slice(0, 500),
        scope: null,
        tags: ['background', 'skill-signal'],
        confidence: 0.7,
      })
      break
    }
  }

  // Pattern 3: Explicit "remember" requests
  if (/\bremember\s+(?:that|this|to)\b/i.test(userMessage)) {
    candidates.push({
      memoryType: 'user_preference',
      title: 'User asked to remember',
      content: userMessage.slice(0, 500),
      scope: currentRepo,
      tags: ['explicit-remember'],
      confidence: 1.0,
    })
  }

  // Pattern 4: Decision made ("let's go with...", "decided to...")
  const decisionPatterns = [
    /\blet'?s?\s+(?:go\s+with|use|do|pick|choose)\b/i,
    /\bdecided?\s+(?:to|on|that)\b/i,
    /\bwe(?:'ll| will)\s+(?:go|use|do)\b/i,
    /\bsounds?\s+good\b/i,
    /\byes,?\s+(?:go\s+ahead|do\s+it|proceed|let's)\b/i,
  ]
  for (const pat of decisionPatterns) {
    if (pat.test(userMessage)) {
      candidates.push({
        memoryType: 'decision',
        title: 'Decision',
        content: `User: ${userMessage.slice(0, 250)}\nContext: ${assistantResponse.slice(0, 250)}`,
        scope: currentRepo,
        tags: ['decision'],
        confidence: 0.7,
      })
      break
    }
  }

  // Pattern 5: Repo-specific context from assistant responses
  if (currentRepo && assistantResponse.length > 200) {
    const repoSignals = [
      /\bthis\s+(?:repo|repository|project|codebase)\s+(?:is|uses|has|was)\b/i,
      /\bthe\s+(?:main|primary)\s+(?:stack|framework|language)\b/i,
      /\barchitecture\s+(?:is|uses|follows)\b/i,
    ]
    for (const pat of repoSignals) {
      if (pat.test(assistantResponse)) {
        candidates.push({
          memoryType: 'repo_context',
          title: `Repo context: ${currentRepo.split('/').pop()}`,
          content: assistantResponse.slice(0, 500),
          scope: currentRepo,
          tags: ['repo-context', 'auto-extracted'],
          confidence: 0.6,
        })
        break
      }
    }
  }

  return candidates
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Check if a candidate is a duplicate of an existing memory item.
 * Uses FTS search to find similar items, then compares content overlap.
 */
export function findDuplicate(
  memory: OrchestratorMemory,
  candidate: MemoryCandidate,
  threshold = 0.85,
): MemoryItem | null {
  // Search for similar items by title/content keywords
  const searchTerms = (candidate.title + ' ' + candidate.content)
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 5)
    .join(' ')

  if (!searchTerms) return null

  try {
    const similar = memory.search(searchTerms, 5)

    for (const item of similar) {
      // Same type and scope
      if (item.memoryType !== candidate.memoryType) continue
      if (item.scope !== candidate.scope) continue

      // Simple content overlap check
      const similarity = computeOverlap(item.content, candidate.content)
      if (similarity >= threshold) return item
    }
  } catch {
    // FTS query may fail on unusual input — not a problem
  }

  return null
}

/** Compute word-level Jaccard similarity between two texts. */
function computeOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  if (wordsA.size === 0 || wordsB.size === 0) return 0

  let intersection = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++
  }

  return intersection / (wordsA.size + wordsB.size - intersection)
}

/**
 * Smart upsert: insert candidate if no duplicate exists, update if similar.
 * Returns the memory item ID and whether it was new or updated.
 */
export function smartUpsert(
  memory: OrchestratorMemory,
  candidate: MemoryCandidate,
  sourceRef: string | null = null,
): { id: string; action: 'inserted' | 'updated' | 'skipped' } {
  const duplicate = findDuplicate(memory, candidate)

  if (duplicate) {
    // If the new candidate has higher confidence, update
    if (candidate.confidence > duplicate.confidence) {
      const id = memory.upsert({
        id: duplicate.id,
        ...candidate,
        sourceRef,
        isPinned: duplicate.isPinned,
        expiresAt: duplicate.expiresAt,
      })
      return { id, action: 'updated' }
    }
    return { id: duplicate.id, action: 'skipped' }
  }

  // Compute expiry based on type
  const ttlDays = TTL_DAYS[candidate.memoryType]
  const expiresAt = ttlDays
    ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
    : null

  const id = memory.upsert({
    ...candidate,
    sourceRef,
    isPinned: candidate.memoryType === 'user_preference',
    expiresAt,
  })
  return { id, action: 'inserted' }
}

// ---------------------------------------------------------------------------
// Aging & Decay
// ---------------------------------------------------------------------------

/**
 * Run the aging/decay cycle:
 * 1. Expire items past their TTL
 * 2. Compact old journal entries into monthly summaries
 * 3. Decay confidence of items that haven't been accessed recently
 */
export function runAgingCycle(memory: OrchestratorMemory): {
  expired: number
  compacted: number
  decayed: number
} {
  // 1. Expire stale items
  const expired = memory.expireStale()

  // 2. Compact old journal entries (older than 30 days) into monthly summaries
  const compacted = compactOldJournals()

  // 3. Decay confidence of old, non-pinned items that haven't been updated
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const oldItems = memory.list({ limit: 100 })
    .filter(item =>
      !item.isPinned &&
      item.updatedAt < thirtyDaysAgo &&
      item.confidence > 0.3
    )

  let decayed = 0
  for (const item of oldItems) {
    const newConfidence = Math.max(0.3, item.confidence * 0.95) // 5% decay
    if (newConfidence < item.confidence) {
      memory.upsert({
        id: item.id,
        memoryType: item.memoryType,
        scope: item.scope,
        title: item.title,
        content: item.content,
        sourceRef: item.sourceRef,
        confidence: newConfidence,
        expiresAt: item.expiresAt,
        isPinned: item.isPinned,
        tags: item.tags,
      })
      decayed++
    }
  }

  return { expired, compacted, decayed }
}

/** Compact journal entries older than 30 days into monthly summary files. */
function compactOldJournals(): number {
  const journalDir = join(ORCHESTRATOR_DIR, 'journal')
  if (!existsSync(journalDir)) return 0

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const cutoffDate = thirtyDaysAgo.toISOString().slice(0, 10)

  let files: string[]
  try {
    files = readdirSync(journalDir).filter(f => f.endsWith('.md'))
  } catch {
    return 0
  }

  // Group old files by month
  const monthGroups = new Map<string, string[]>()
  for (const file of files) {
    const dateMatch = file.match(/^(\d{4}-\d{2})-\d{2}\.md$/)
    if (!dateMatch) continue
    const fileDate = file.replace('.md', '')
    if (fileDate >= cutoffDate) continue  // not old enough

    const month = dateMatch[1]
    const group = monthGroups.get(month) ?? []
    group.push(file)
    monthGroups.set(month, group)
  }

  // Compact each month into a summary file
  let compacted = 0
  for (const [month, monthFiles] of monthGroups) {
    const summaryFile = join(journalDir, `${month}-summary.md`)
    if (existsSync(summaryFile)) continue // already compacted

    const contents: string[] = [`# Journal Summary: ${month}\n`]
    for (const file of monthFiles.sort()) {
      const filePath = join(journalDir, file)
      try {
        const content = readFileSync(filePath, 'utf-8')
        contents.push(`## ${file.replace('.md', '')}\n${content}\n`)
      } catch {
        continue
      }
    }

    writeFileSync(summaryFile, contents.join('\n'), 'utf-8')
    compacted += monthFiles.length
    // Note: we don't delete originals — the orchestrator can do that if it wants
  }

  return compacted
}

// ---------------------------------------------------------------------------
// Pattern Learning — Finding Outcomes
// ---------------------------------------------------------------------------

/**
 * Record the outcome of a finding triage decision.
 */
export function recordFindingOutcome(
  memory: OrchestratorMemory,
  outcome: FindingOutcome,
): string {
  return memory.upsert({
    memoryType: 'finding_outcome',
    title: `${outcome.action}: ${outcome.category} finding in ${outcome.repo.split('/').pop()}`,
    content: JSON.stringify(outcome),
    scope: outcome.repo,
    sourceRef: outcome.sessionId,
    confidence: 0.9,
    isPinned: false,
    expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
    tags: [outcome.category, outcome.severity, outcome.action],
  })
}

/**
 * Analyze past finding outcomes to compute a triage recommendation.
 * Returns the likely action and confidence based on historical patterns.
 */
export function getTriageRecommendation(
  memory: OrchestratorMemory,
  category: string,
  severity: string,
  repo: string | null,
): { action: 'implement' | 'skip' | 'defer' | 'unknown'; confidence: number; reason: string } {
  // Get all finding outcomes for this category, prefer repo-specific matches
  const allOutcomes = memory.list({ memoryType: 'finding_outcome', limit: 50 })
    .map(item => {
      try { return JSON.parse(item.content) as FindingOutcome } catch { return null }
    })
    .filter((o): o is FindingOutcome => o !== null)
    .filter(o => o.category === category)

  // Prefer repo-specific outcomes if available
  const repoSpecific = repo ? allOutcomes.filter(o => o.repo === repo) : []
  const outcomes = repoSpecific.length >= 2 ? repoSpecific : allOutcomes

  if (outcomes.length < 3) {
    return { action: 'unknown', confidence: 0, reason: 'Not enough historical data' }
  }

  // Filter to matching severity
  const bySeverity = outcomes.filter(o => o.severity === severity)
  const pool = bySeverity.length >= 2 ? bySeverity : outcomes

  // Count actions
  const counts = { implemented: 0, skipped: 0, deferred: 0 }
  for (const o of pool) {
    counts[o.action]++
  }

  const total = pool.length
  const implementRate = counts.implemented / total
  const skipRate = counts.skipped / total

  // Also factor in success rate of implementations
  const implementations = pool.filter(o => o.action === 'implemented')
  const successRate = implementations.length > 0
    ? implementations.filter(o => o.outcome === 'success').length / implementations.length
    : 0

  if (implementRate > 0.6 && successRate > 0.5) {
    return {
      action: 'implement',
      confidence: Math.min(0.9, implementRate * successRate),
      reason: `${Math.round(implementRate * 100)}% of similar findings were implemented (${Math.round(successRate * 100)}% success rate)`,
    }
  }

  if (skipRate > 0.6) {
    return {
      action: 'skip',
      confidence: Math.min(0.85, skipRate),
      reason: `${Math.round(skipRate * 100)}% of similar findings were skipped`,
    }
  }

  return {
    action: 'unknown',
    confidence: 0.3,
    reason: `Mixed history: ${counts.implemented} implemented, ${counts.skipped} skipped, ${counts.deferred} deferred`,
  }
}

// ---------------------------------------------------------------------------
// User Skill Model
// ---------------------------------------------------------------------------

const SKILL_PROFILE_FILE = join(ORCHESTRATOR_DIR, 'skill-profile.json')

/** Load the user's skill profile from disk. */
export function loadSkillProfile(): SkillLevel[] {
  if (!existsSync(SKILL_PROFILE_FILE)) return []
  try {
    return JSON.parse(readFileSync(SKILL_PROFILE_FILE, 'utf-8'))
  } catch {
    return []
  }
}

/** Save the skill profile to disk. */
export function saveSkillProfile(profile: SkillLevel[]): void {
  writeFileSync(SKILL_PROFILE_FILE, JSON.stringify(profile, null, 2), 'utf-8')
}

/**
 * Update the user's skill level for a domain based on observed signals.
 * Signals are things like: "used advanced git rebase", "asked basic TypeScript question",
 * "configured CI pipeline without help".
 */
export function updateSkillLevel(
  domain: string,
  signal: string,
  indicatedLevel: 'beginner' | 'intermediate' | 'advanced' | 'expert',
): SkillLevel {
  const profile = loadSkillProfile()
  const existing = profile.find(s => s.domain === domain)
  const now = new Date().toISOString()

  if (existing) {
    // Add signal
    existing.signals.push(signal)
    if (existing.signals.length > 20) existing.signals = existing.signals.slice(-20)
    existing.lastUpdated = now

    // Adjust level — only move up, or down if strong evidence
    const levels: SkillLevel['level'][] = ['beginner', 'intermediate', 'advanced', 'expert']
    const currentIdx = levels.indexOf(existing.level)
    const newIdx = levels.indexOf(indicatedLevel)

    if (newIdx > currentIdx) {
      // Level up — require confidence
      existing.confidence = Math.min(1, existing.confidence + 0.15)
      if (existing.confidence >= 0.7) {
        existing.level = indicatedLevel
        existing.confidence = 0.6  // reset after level change
      }
    } else if (newIdx < currentIdx) {
      // Level down — be cautious
      existing.confidence = Math.max(0, existing.confidence - 0.1)
      if (existing.confidence < 0.3) {
        existing.level = indicatedLevel
        existing.confidence = 0.5
      }
    } else {
      // Same level — increase confidence
      existing.confidence = Math.min(1, existing.confidence + 0.1)
    }

    saveSkillProfile(profile)
    return existing
  }

  // New domain
  const newSkill: SkillLevel = {
    domain,
    level: indicatedLevel,
    confidence: 0.5,
    signals: [signal],
    lastUpdated: now,
  }
  profile.push(newSkill)
  saveSkillProfile(profile)
  return newSkill
}

/**
 * Get the user's assessed skill level for a domain.
 * Returns null if we have no data for this domain.
 */
export function getSkillLevel(domain: string): SkillLevel | null {
  const profile = loadSkillProfile()
  return profile.find(s => s.domain === domain) ?? null
}

/**
 * Get a guidance style recommendation based on the user's overall skill profile.
 */
export function getGuidanceStyle(): {
  tone: 'tutorial' | 'collaborative' | 'concise'
  explainLevel: 'detailed' | 'moderate' | 'minimal'
  domains: Record<string, SkillLevel['level']>
} {
  const profile = loadSkillProfile()

  if (profile.length === 0) {
    return { tone: 'collaborative', explainLevel: 'moderate', domains: {} }
  }

  // Compute average skill level
  const levels = { beginner: 0, intermediate: 1, advanced: 2, expert: 3 }
  const avg = profile.reduce((sum, s) => sum + levels[s.level], 0) / profile.length

  const domains: Record<string, SkillLevel['level']> = {}
  for (const s of profile) domains[s.domain] = s.level

  if (avg < 0.8) {
    return { tone: 'tutorial', explainLevel: 'detailed', domains }
  }
  if (avg < 2.0) {
    return { tone: 'collaborative', explainLevel: 'moderate', domains }
  }
  return { tone: 'concise', explainLevel: 'minimal', domains }
}

// ---------------------------------------------------------------------------
// Decision History
// ---------------------------------------------------------------------------

/**
 * Record a decision with expected outcome.
 */
export function recordDecision(
  memory: OrchestratorMemory,
  decision: Omit<DecisionRecord, 'id' | 'timestamp' | 'actualOutcome' | 'outcomeAssessedAt'>,
): string {
  const record: DecisionRecord = {
    ...decision,
    id: `decision-${Date.now()}`,
    timestamp: new Date().toISOString(),
    actualOutcome: null,
    outcomeAssessedAt: null,
  }

  return memory.upsert({
    memoryType: 'decision',
    title: `Decision: ${decision.decision.slice(0, 100)}`,
    content: JSON.stringify(record),
    scope: decision.repo,
    sourceRef: decision.relatedFinding,
    confidence: 0.8,
    isPinned: false,
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    tags: ['decision'],
  })
}

/**
 * Update a decision's actual outcome.
 */
export function assessDecisionOutcome(
  memory: OrchestratorMemory,
  decisionId: string,
  actualOutcome: string,
): boolean {
  const item = memory.get(decisionId)
  if (!item || item.memoryType !== 'decision') return false

  try {
    const record = JSON.parse(item.content) as DecisionRecord
    record.actualOutcome = actualOutcome
    record.outcomeAssessedAt = new Date().toISOString()

    memory.upsert({
      id: item.id,
      memoryType: 'decision',
      title: item.title,
      content: JSON.stringify(record),
      scope: item.scope,
      sourceRef: item.sourceRef,
      confidence: item.confidence,
      isPinned: item.isPinned,
      expiresAt: item.expiresAt,
      tags: item.tags,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Get decisions that need outcome assessment (older than 7 days, no outcome yet).
 */
export function getPendingOutcomeAssessments(memory: OrchestratorMemory): DecisionRecord[] {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const decisions = memory.list({ memoryType: 'decision', limit: 50 })

  return decisions
    .map(item => {
      try { return JSON.parse(item.content) as DecisionRecord } catch { return null }
    })
    .filter((d): d is DecisionRecord =>
      d !== null &&
      d.actualOutcome === null &&
      d.timestamp < sevenDaysAgo
    )
}
