/**
 * Tool calls MCP Apps make from Canvas (docs/CANVAS-SPEC.md §8, "MCP Apps").
 *
 * An app may call tools on its own server only: the server is the one its
 * item came from, never one the app names. The session's harness makes the
 * call without a model turn (CodingProcess.callAppTool), applying the
 * session's permission rules where it can and otherwise only after the user
 * confirmed in Codekin. The result goes back to the app, not the agent.
 * Calls are limited per item, so a misbehaving app can't flood a server.
 */

import { MAX_APP_RESULT, type AppToolCallOutcome } from './mcp-app.js'
import type { CodingProcess } from './coding-process.js'

export const APP_CALL_LIMITS = {
  /** Calls one app may have running at once. */
  inFlight: 4,
  /** Calls one app may start per minute. */
  perMinute: 30,
  /** Size of the arguments, as JSON. */
  maxArgsBytes: 256 * 1024,
} as const

export interface AppToolCallDeps {
  /** The MCP server an item came from, or null when it isn't an MCP App. */
  appServer: (sessionId: string, itemId: string) => Promise<string | null>
  /** The session's harness process, or null. */
  process: (sessionId: string) => CodingProcess | null
  /** Start the session's harness (no model turn, so no usage); false when it can't start. */
  start: (sessionId: string) => boolean
  now?: () => number
  /** How long to wait for a started harness to be ready. */
  startTimeoutMs?: number
}

export class AppToolCalls {
  private usage = new Map<string, { inFlight: number; started: number[] }>()

  constructor(private readonly deps: AppToolCallDeps) {}

  async call(sessionId: string, itemId: unknown, tool: unknown, args: unknown, confirmed: boolean): Promise<AppToolCallOutcome> {
    if (typeof itemId !== 'string' || typeof tool !== 'string' || !tool || tool.length > 200) return { ok: false, error: 'Invalid tool call.' }
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) return { ok: false, error: 'Tool arguments must be an object.' }
    const argObj = (args ?? {}) as Record<string, unknown>
    if (Buffer.byteLength(JSON.stringify(argObj)) > APP_CALL_LIMITS.maxArgsBytes) return { ok: false, error: 'The tool arguments are too large.' }

    const server = await this.deps.appServer(sessionId, itemId)
    if (!server) return { ok: false, error: 'That Canvas item is not an MCP App.' }

    // The limits apply before anything else happens, starting the agent included.
    const key = `${sessionId}:${itemId}`
    const now = (this.deps.now ?? Date.now)()
    const use = this.usage.get(key) ?? { inFlight: 0, started: [] }
    use.started = use.started.filter(t => now - t < 60_000)
    if (use.inFlight >= APP_CALL_LIMITS.inFlight) return { ok: false, error: `This app already has ${APP_CALL_LIMITS.inFlight} tool calls running.` }
    if (use.started.length >= APP_CALL_LIMITS.perMinute) return { ok: false, error: 'This app is calling tools too often. Try again in a minute.' }
    use.inFlight++
    use.started.push(now)
    this.usage.set(key, use)
    /** Remove this call's own timestamp (not whichever has the same value). */
    const uncount = () => { const i = use.started.lastIndexOf(now); if (i >= 0) use.started.splice(i, 1) }
    try {
      const proc = await this.running(sessionId)
      if (!proc) return { ok: false, error: 'The session\'s agent couldn\'t be started, so the tool can\'t run. Send a message to start it, then try again.' }
      if (!proc.callAppTool) return { ok: false, error: 'This session\'s agent can\'t run tool calls for apps.' }
      const outcome = await proc.callAppTool({ server, tool, arguments: argObj, confirmed })
      // A call waiting for the user's confirmation hasn't run: it doesn't count.
      if (!outcome.ok && outcome.needsConfirmation) uncount()
      if (outcome.ok && Buffer.byteLength(JSON.stringify(outcome.result)) > MAX_APP_RESULT) {
        return { ok: false, error: `${tool} returned more than ${MAX_APP_RESULT / 1024 / 1024} MiB, which is more than Codekin passes to an app.` }
      }
      return outcome
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      use.inFlight--
    }
  }

  /**
   * The session's harness, started if it isn't running: an app opened after
   * a restart can call tools before the user sends anything.
   */
  private async running(sessionId: string): Promise<CodingProcess | null> {
    const current = this.deps.process(sessionId)
    if (current?.isAlive() && current.isReady()) return current
    if (!current?.isAlive() && !this.deps.start(sessionId)) return null
    const deadline = (this.deps.now ?? Date.now)() + (this.deps.startTimeoutMs ?? 30_000)
    for (;;) {
      const proc = this.deps.process(sessionId)
      if (proc?.isAlive() && proc.isReady()) return proc
      if ((this.deps.now ?? Date.now)() >= deadline) return null
      await new Promise(r => setTimeout(r, 200))
    }
  }

  forgetSession(sessionId: string): void {
    for (const key of this.usage.keys()) if (key.startsWith(`${sessionId}:`)) this.usage.delete(key)
  }
}
