/**
 * Shepherd orchestrator lifecycle manager.
 *
 * Manages the always-on Shepherd session: directory setup, stable ID
 * persistence, and auto-start on server boot. Shepherd is a standard
 * Claude session with source='shepherd' that runs in ~/.codekin/shepherd/.
 */

import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { DATA_DIR } from './config.js'
import type { SessionManager } from './session-manager.js'

export const SHEPHERD_DIR = join(DATA_DIR, 'shepherd')
const SESSION_ID_FILE = join(SHEPHERD_DIR, '.session-id')

const PROFILE_TEMPLATE = `# User Profile

Shepherd will learn about you over time and update this file.
Feel free to edit it directly.

## Preferences
- (Shepherd will fill this in as it learns your preferences)

## Skill Level
- (Shepherd will adapt its guidance to your experience)
`

const REPOS_TEMPLATE = `# Managed Repositories

Shepherd tracks repositories you work with in Codekin.

## Active Repos
(none yet — Shepherd will populate this as you work)
`

const CLAUDE_MD_TEMPLATE = `# Shepherd — Codekin Orchestrator

You are Shepherd, a calm and friendly ops manager inside Codekin.
You help users keep their repositories healthy, their workflows running
smoothly, and their audit findings actioned pragmatically.

## Your Personality
- Calm, measured, never frantic
- You like clean code and orderly repositories
- You explain the "why" behind recommendations
- You're pragmatic — only suggest what's actually needed right now
- You guide users toward better practices without being preachy
- You speak plainly, avoiding unnecessary jargon

## Your Capabilities (Phase 1)
- Answer questions about repository health and organization
- Read and discuss audit reports from .codekin/reports/
- Recommend AI Workflow setups for repositories
- Maintain your memory files (PROFILE.md, REPOS.md, journal/)
- Give guidance on improving repository quality

## Your Workspace
You run in ~/.codekin/shepherd/. Your memory files are:
- PROFILE.md — what you know about the user
- REPOS.md — registry of managed repositories and their policies
- journal/ — daily activity notes

Update these files as you learn new things. Read them on startup to
restore context from previous conversations.

## Rules
- NEVER implement changes without user approval
- ALWAYS explain why you recommend (or skip) a finding
- Be honest about uncertainty — if you're not sure, say so
- Keep your memory files tidy and up to date
- When you start fresh after a restart, read your memory files first
  and greet the user with a brief status update

## On Startup
1. Read PROFILE.md for user context
2. Read REPOS.md for repo registry
3. Read the last 3 journal entries (if any)
4. Greet the user with a brief, friendly status update
`

/** Ensure the shepherd workspace directory exists with starter files. */
export function ensureShepherdDir(): void {
  // Create directories
  if (!existsSync(SHEPHERD_DIR)) mkdirSync(SHEPHERD_DIR, { recursive: true })

  const journalDir = join(SHEPHERD_DIR, 'journal')
  if (!existsSync(journalDir)) mkdirSync(journalDir, { recursive: true })

  // Seed files only if they don't exist (preserve user edits)
  const seeds: [string, string][] = [
    [join(SHEPHERD_DIR, 'PROFILE.md'), PROFILE_TEMPLATE],
    [join(SHEPHERD_DIR, 'REPOS.md'), REPOS_TEMPLATE],
    [join(SHEPHERD_DIR, 'CLAUDE.md'), CLAUDE_MD_TEMPLATE],
  ]
  for (const [path, content] of seeds) {
    if (!existsSync(path)) writeFileSync(path, content, 'utf-8')
  }
}

/** Get or create a stable session UUID that persists across restarts. */
export function getOrCreateShepherdId(): string {
  if (existsSync(SESSION_ID_FILE)) {
    const id = readFileSync(SESSION_ID_FILE, 'utf-8').trim()
    if (id) return id
  }
  const id = randomUUID()
  writeFileSync(SESSION_ID_FILE, id, 'utf-8')
  return id
}

/** Check if a session is the Shepherd session. */
export function isShepherdSession(source: string | undefined): boolean {
  return source === 'shepherd'
}

/**
 * Ensure the Shepherd session exists and is running.
 * Creates it if missing, starts Claude if not alive.
 * Returns the shepherd session ID.
 */
export function ensureShepherdRunning(sessions: SessionManager): string {
  ensureShepherdDir()
  const stableId = getOrCreateShepherdId()

  // Check if session already exists
  const existing = sessions.get(stableId)
  if (existing) {
    // Session exists — start Claude if not alive
    if (!existing.claudeProcess?.isAlive()) {
      console.log('[shepherd] Restarting Shepherd Claude process')
      sessions.startClaude(stableId)
    }
    return stableId
  }

  // Create the session
  console.log('[shepherd] Creating Shepherd session')
  sessions.create('Shepherd', SHEPHERD_DIR, {
    source: 'shepherd',
    id: stableId,
    permissionMode: 'acceptEdits',
  })

  // Start Claude
  sessions.startClaude(stableId)
  return stableId
}

/**
 * Get the Shepherd session ID if it exists, or null.
 */
export function getShepherdSessionId(sessions: SessionManager): string | null {
  const stableId = existsSync(SESSION_ID_FILE)
    ? readFileSync(SESSION_ID_FILE, 'utf-8').trim()
    : null
  if (!stableId) return null
  return sessions.get(stableId) ? stableId : null
}
