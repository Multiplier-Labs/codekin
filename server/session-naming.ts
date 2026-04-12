/**
 * Session naming logic for Codekin.
 *
 * Generates descriptive names for sessions using the Claude CLI in one-shot
 * print mode (`claude -p`). This leverages the user's existing Claude
 * authentication — no separate API keys required. Supports automatic retry
 * with exponential back-off.
 */

import { spawn } from 'node:child_process'
import type { Session, WsServerMessage } from './types.js'
import { CLAUDE_BINARY } from './config.js'

/** Max naming retry attempts before giving up. */
const MAX_NAMING_ATTEMPTS = 5
/** Back-off delays for naming retries: 20s, 60s, 120s, 240s, 240s */
const NAMING_DELAYS = [20_000, 60_000, 120_000, 240_000, 240_000]

/** Timeout for the claude -p process (15 seconds). */
const CLI_TIMEOUT_MS = 15_000

/** Callback interface for SessionNaming to interact with SessionManager. */
export interface SessionNamingDeps {
  getSession(id: string): Session | undefined
  hasSession(id: string): boolean
  rename(sessionId: string, newName: string): boolean
}

/** Generate a session name by spawning `claude -p` in one-shot mode. */
function generateNameViaCLI(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // --max-turns 2: one turn to receive/process the prompt, one to reply with the name.
    // Using 1 would sometimes cause the CLI to exit before producing output.
    const proc = spawn(CLAUDE_BINARY, ['-p', '--max-turns', '2', '--model', 'haiku'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('claude -p timed out'))
    }, CLI_TIMEOUT_MS)

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim())
      } else {
        reject(new Error(`claude -p exited with code ${code}: ${stderr.trim()}`))
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

export class SessionNaming {
  private deps: SessionNamingDeps

  constructor(deps: SessionNamingDeps) {
    this.deps = deps
  }

  /** Schedule session naming via Claude CLI.
   *  Used as a 20s fallback for long responses — fires immediately via result handler
   *  for responses that finish sooner.
   *  Automatically retries on failure with increasing delays. */
  scheduleSessionNaming(sessionId: string): void {
    const session = this.deps.getSession(sessionId)
    if (!session) return
    if (!session.name.startsWith('hub:')) return
    // Don't schedule if a naming timer is already pending
    if (session._namingTimer) return
    // Give up after max attempts
    if (session._namingAttempts >= MAX_NAMING_ATTEMPTS) return

    const delay = NAMING_DELAYS[
      Math.min(session._namingAttempts, NAMING_DELAYS.length - 1)
    ]

    session._namingTimer = setTimeout(() => {
      delete session._namingTimer
      void this.executeSessionNaming(sessionId)
    }, delay)
  }

  /** Execute the actual naming call. Called by the timer set in scheduleSessionNaming.
   *  Spawns `claude -p` with Haiku for fast, low-cost name generation. */
  async executeSessionNaming(sessionId: string): Promise<void> {
    const session = this.deps.getSession(sessionId)
    if (!session) return
    if (!session.name.startsWith('hub:')) return

    session._namingAttempts++

    // Gather context from conversation history
    const latestContext = session.outputHistory
      .filter((m: WsServerMessage) => m.type === 'output')
      .map((m: WsServerMessage) => (m as { data?: string }).data || '')
      .join('')
      .slice(0, 2000)

    const userMsg = session._namingUserInput || session._lastUserInput || ''
    if (!userMsg && !latestContext) {
      // No context yet — schedule a retry
      this.scheduleSessionNaming(sessionId)
      return
    }

    try {
      const prompt = [
        'Generate a descriptive name (3-6 words, max 60 characters) for this coding session.',
        'The name MUST be at least 3 words that clearly summarize what the user is working on.',
        'Reply with ONLY the session name. No quotes, no punctuation, no explanation.',
        'Example names: "Fix Login Page Styling", "Add User Auth Flow", "Refactor Database Query Performance"',
        '',
        `User message: ${userMsg.slice(0, 500)}`,
        '',
        `Assistant response (truncated): ${latestContext.slice(0, 1500)}`,
      ].join('\n')

      const text = await generateNameViaCLI(prompt)

      if (!this.deps.hasSession(sessionId)) return
      if (!session.name.startsWith('hub:')) return

      // Reject CLI error messages that leaked through stdout
      if (/^error:/i.test(text) || /reached max turns/i.test(text)) {
        console.warn(`[session-name] CLI returned error-like output: "${text.slice(0, 80)}"`)
        this.scheduleSessionNaming(sessionId)
        return
      }

      const rawName = text
        .trim()
        .replace(/^["'`*_]+|["'`*_]+$/g, '')
        .replace(/^(session\s*name\s*[:：]\s*)/i, '')
        .trim()

      const wordCount = rawName.split(/\s+/).filter(w => w.length > 0).length
      if (rawName.length >= 2 && rawName.length <= 80 && wordCount >= 3) {
        const finalName = rawName.length <= 60
          ? rawName
          : (rawName.slice(0, 60).replace(/\s+\S*$/, '') || rawName.slice(0, 60))
        this.deps.rename(sessionId, finalName)
      } else {
        console.warn(`[session-name] invalid name (${rawName.length} chars, ${wordCount} words): "${rawName.slice(0, 80)}"`)
        this.scheduleSessionNaming(sessionId)
      }
    } catch (err: unknown) {
      if (!this.deps.hasSession(sessionId)) return
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[session-name] attempt ${session._namingAttempts} failed: ${msg}`)
      this.scheduleSessionNaming(sessionId)
    }
  }

  /** Re-trigger session naming when user interacts, if the session is still unnamed
   *  and no naming timer is already pending. Uses a short delay (5s) since we already
   *  have conversation context at this point. */
  retrySessionNamingOnInteraction(sessionId: string): void {
    const session = this.deps.getSession(sessionId)
    if (!session) return
    if (!session.name.startsWith('hub:')) return
    // Already have a timer pending or exhausted retries
    if (session._namingTimer) return
    if (session._namingAttempts >= MAX_NAMING_ATTEMPTS) return

    // Short delay — context already available from prior turns
    session._namingTimer = setTimeout(() => {
      delete session._namingTimer
      void this.executeSessionNaming(sessionId)
    }, 5_000)
  }
}
