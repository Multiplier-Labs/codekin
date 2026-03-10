/**
 * Session naming logic for Codekin.
 *
 * Generates descriptive names for sessions using AI models (Groq, OpenAI,
 * Gemini, or Anthropic) based on conversation context. Supports automatic
 * retry with exponential back-off.
 */

import { generateText, type LanguageModel } from 'ai'
import { createGroq } from '@ai-sdk/groq'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createAnthropic } from '@ai-sdk/anthropic'
import type { Session, WsServerMessage } from './types.js'

/** Max naming retry attempts before giving up. */
const MAX_NAMING_ATTEMPTS = 5
/** Back-off delays for naming retries: 20s, 60s, 120s, 240s, 240s */
const NAMING_DELAYS = [20_000, 60_000, 120_000, 240_000, 240_000]

/** Callback interface for SessionNaming to interact with SessionManager. */
export interface SessionNamingDeps {
  getSession(id: string): Session | undefined
  hasSession(id: string): boolean
  getSetting(key: string, fallback: string): string
  rename(sessionId: string, newName: string): boolean
}

export class SessionNaming {
  private deps: SessionNamingDeps

  constructor(deps: SessionNamingDeps) {
    this.deps = deps
  }

  /** Schedule session naming via the Anthropic API.
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

  /** Resolve the AI model to use for session naming based on available API keys.
   *  Respects the user's preferred support provider setting.
   *  Fallback priority: Groq (free/fast) → OpenAI → Gemini → Anthropic. */
  private getNamingModel(): LanguageModel | null {
    const preferred = this.deps.getSetting('support_provider', 'auto')

    const providers: Record<string, () => LanguageModel | null> = {
      groq: () => process.env.GROQ_API_KEY
        ? createGroq({ apiKey: process.env.GROQ_API_KEY })('meta-llama/llama-4-scout-17b-16e-instruct')
        : null,
      openai: () => process.env.OPENAI_API_KEY
        ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY })('gpt-4o-mini')
        : null,
      gemini: () => process.env.GEMINI_API_KEY
        ? createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })('gemini-2.5-flash')
        : null,
      anthropic: () => process.env.ANTHROPIC_API_KEY
        ? createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-haiku-4-5-20251001')
        : null,
    }

    // If a specific provider is preferred and available, use it
    if (preferred !== 'auto' && providers[preferred]) {
      const model = providers[preferred]()
      if (model) return model
    }

    // Auto: try in priority order
    for (const key of ['groq', 'openai', 'gemini', 'anthropic']) {
      const model = providers[key]()
      if (model) return model
    }
    return null
  }

  /** Execute the actual naming call. Called by the timer set in scheduleSessionNaming.
   *  Uses the first available API provider for minimal cost and latency. */
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

    const userMsg = session._lastUserInput || ''
    if (!userMsg && !latestContext) {
      // No context yet — schedule a retry
      this.scheduleSessionNaming(sessionId)
      return
    }

    const model = this.getNamingModel()
    if (!model) {
      console.warn('[session-name] No API key set for naming (GROQ_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY), skipping')
      return
    }

    try {
      const { text } = await generateText({
        model,
        maxOutputTokens: 60,
        prompt: [
          'Generate a descriptive name (3-6 words, max 60 characters) for this coding session.',
          'The name MUST be at least 3 words that clearly summarize what the user is working on.',
          'Reply with ONLY the session name. No quotes, no punctuation, no explanation.',
          'Example names: "Fix Login Page Styling", "Add User Auth Flow", "Refactor Database Query Performance"',
          '',
          `User message: ${userMsg.slice(0, 500)}`,
          '',
          `Assistant response (truncated): ${latestContext.slice(0, 1500)}`,
        ].join('\n'),
      })

      if (!this.deps.hasSession(sessionId)) return
      if (!session.name.startsWith('hub:')) return

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
