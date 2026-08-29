/**
 * The harness registry — one self-describing definition per coding agent.
 *
 * Before this, adding a harness meant editing a dozen sites: an if/else
 * process factory in session-lifecycle, three hand-rolled probe blocks in
 * ws-server, scattered install hints, and a capabilities object nothing
 * read. Each definition now carries its own metadata, environment probe, and
 * process factory; the boot probes and the spawn path iterate/dispatch over
 * the registry. Adding harness #4 is one entry here plus its adapter.
 *
 * Claude remains the fallback for sessions with no recorded provider —
 * that is persisted-data compatibility, not preference.
 */

import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { CodingProcess, CodingProvider } from './coding-process.js'
import type { Session } from './types.js'
import { ClaudeProcess } from './claude-process.js'
import { OpenCodeProcess } from './opencode-process.js'
import { CodexProcess } from './codex-process.js'
import { CLAUDE_BINARY } from './config.js'
import { jsonParse } from './json-parse.js'

export interface HarnessProbe {
  /** The CLI exists and responds to --version. */
  available: boolean
  version: string
  /**
   * Auth detected (API key, subscription, or stored login). A false here is
   * a heuristic, not ground truth — callers warn, they don't block.
   */
  authenticated: boolean
}

export interface CreateProcessContext {
  sessionId: string
  extraEnv: Record<string, string>
  /** Session allowlist merged with the repo approval registry (consumed by Claude today). */
  mergedAllowedTools: string[]
}

export interface HarnessDefinition {
  id: CodingProvider
  label: string
  /** Shell command that installs/fixes the harness — shown in health surfaces and logs. */
  installHint: string
  /** Probe the host once at boot: binary presence, version, auth state. */
  probe(): HarnessProbe
  /** Build (but do not start) the session's process. */
  createProcess(session: Session, ctx: CreateProcessContext): CodingProcess
}

function tryVersion(binary: string): string | null {
  try {
    return execFileSync(binary, ['--version'], { timeout: 5000 }).toString().trim()
  } catch {
    return null
  }
}

const claude: HarnessDefinition = {
  id: 'claude',
  label: 'Claude Code',
  installHint: 'npm install -g @anthropic-ai/claude-code, then run `claude` once to sign in',
  probe() {
    const version = tryVersion(CLAUDE_BINARY)
    if (version === null) return { available: false, version: '', authenticated: false }
    // API key env wins; otherwise ask the CLI (covers subscription/OAuth auth).
    let authenticated = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_API_KEY)
    if (!authenticated) {
      try {
        const auth = jsonParse(execFileSync(CLAUDE_BINARY, ['auth', 'status'], { timeout: 5000 }).toString()) as Record<string, unknown>
        authenticated = !!auth.loggedIn
      } catch {
        // auth status probe failed — report unauthenticated, callers only warn
      }
    }
    return { available: true, version, authenticated }
  },
  createProcess(session, ctx) {
    return new ClaudeProcess(session.workingDir, {
      sessionId: session.claudeSessionId || undefined,
      extraEnv: ctx.extraEnv,
      model: session.model,
      permissionMode: session.permissionMode,
      // A recorded CLI session id means a JSONL exists — --resume continues it
      // (--session-id would collide with the existing file).
      resume: !!session.claudeSessionId,
      allowedTools: ctx.mergedAllowedTools,
      addDirs: session.addDirs,
    })
  },
}

const opencode: HarnessDefinition = {
  id: 'opencode',
  label: 'OpenCode',
  installHint: 'install the OpenCode CLI (opencode.ai)',
  probe() {
    const version = tryVersion(process.env.OPENCODE_BINARY || 'opencode')
    // OpenCode brokers provider auth itself; binary presence is the whole probe.
    return version === null
      ? { available: false, version: '', authenticated: false }
      : { available: true, version, authenticated: true }
  },
  createProcess(session, ctx) {
    // Recent assistant text already shown to the user — lets the resumed
    // process skip re-emitting messages during missed-history hydration.
    const recentOutputText = session.outputHistory
      .filter((m): m is { type: 'output'; data: string } => m.type === 'output')
      .slice(-100)
      .map((m) => m.data)
      .join('')
    return new OpenCodeProcess(session.workingDir, {
      sessionId: ctx.sessionId,
      opencodeSessionId: session.claudeSessionId || undefined,
      model: session.model,
      extraEnv: ctx.extraEnv,
      permissionMode: session.permissionMode,
      recentOutputText,
    })
  },
}

const codex: HarnessDefinition = {
  id: 'codex',
  label: 'Codex',
  installHint: 'install the Codex CLI, then run `codex login`',
  probe() {
    const version = tryVersion(process.env.CODEX_BINARY || 'codex')
    if (version === null) return { available: false, version: '', authenticated: false }
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
    const authenticated = existsSync(join(codexHome, 'auth.json')) || !!process.env.OPENAI_API_KEY
    return { available: true, version, authenticated }
  },
  createProcess(session, ctx) {
    return new CodexProcess(session.workingDir, {
      sessionId: ctx.sessionId,
      codexThreadId: session.claudeSessionId || undefined,
      model: session.model,
      extraEnv: ctx.extraEnv,
      permissionMode: session.permissionMode,
    })
  },
}

export const HARNESSES: readonly HarnessDefinition[] = [claude, opencode, codex]

/** Resolve a provider to its definition. Claude is the persisted-data fallback. */
export function getHarness(provider: CodingProvider | undefined): HarnessDefinition {
  return HARNESSES.find((h) => h.id === provider) ?? claude
}
