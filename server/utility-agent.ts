/**
 * Background AI utilities without a hardcoded vendor (audit N3).
 *
 * Session naming and handoff distillation used to spawn the Claude CLI
 * unconditionally — a hidden Claude dependency for Codex/OpenCode-only users
 * (the audit's finding: even the flagship cross-harness handoff needed a
 * working Claude install). This module runs a one-shot prompt through the
 * harness registry instead: prefer the session's own harness (the work bills
 * the quota the user chose), fall back to any other usable one, and fail
 * only when no agent on the host can answer.
 *
 * Probes are cached: they shell out to `--version`/auth checks, and naming
 * runs on every new session. `resetUtilityProbeCache` exists for tests.
 */

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { CodingProvider } from './coding-process.js'
import {
  HARNESSES,
  type HarnessDefinition,
  type HarnessProbe,
  type OneShotCommand,
  type OneShotOptions,
} from './harness-registry.js'

const probeCache = new Map<CodingProvider, HarnessProbe>()

export function resetUtilityProbeCache(): void {
  probeCache.clear()
}

/** Test seam: pre-fill a probe result so tests never shell out. */
export function seedUtilityProbe(provider: CodingProvider, probe: HarnessProbe): void {
  probeCache.set(provider, probe)
}

function cachedProbe(h: HarnessDefinition): HarnessProbe {
  let probe = probeCache.get(h.id)
  if (!probe) {
    probe = h.probe()
    probeCache.set(h.id, probe)
  }
  return probe
}

/**
 * The harnesses to try, in order: the preferred one first (usually the
 * session's own provider), then the rest in registry order. Only harnesses
 * whose cached probe reports available+authenticated participate — firing a
 * prompt at a missing or signed-out CLI just burns the timeout.
 */
export function utilityOrder(prefer?: CodingProvider): HarnessDefinition[] {
  const ordered = [...HARNESSES].sort((a, b) => (a.id === prefer ? -1 : b.id === prefer ? 1 : 0))
  return ordered.filter((h) => {
    const probe = cachedProbe(h)
    return probe.available && probe.authenticated
  })
}

/** Minimal env for a one-shot CLI: auth + config paths, no project context. */
export function buildOneShotEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  for (const key of [
    'HOME', 'USER', 'LANG', 'LC_ALL',
    'ANTHROPIC_API_KEY', 'CLAUDE_CODE_API_KEY', 'OPENAI_API_KEY',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
    'SHELL', 'TERM',
  ]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  env.NODE_NO_WARNINGS = '1'
  return env
}

/** Execute a resolved one-shot command. Injectable for tests. */
export type ExecOneShotFn = (cmd: OneShotCommand, timeoutMs: number) => Promise<string>

export const execOneShot: ExecOneShotFn = (cmd, timeoutMs) =>
  new Promise((resolve, reject) => {
    // tmpdir cwd: no project instruction files/hooks load into the turn.
    const proc = spawn(cmd.binary, cmd.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: tmpdir(),
      env: buildOneShotEnv(),
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(`${cmd.binary} one-shot timed out`))
    }, timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && stdout.trim()) resolve(stdout.trim())
      else reject(new Error(`${cmd.binary} exited with code ${code}: ${stderr.trim().slice(0, 300)}`))
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    if (cmd.stdin) proc.stdin.write(cmd.stdin)
    proc.stdin.end()
  })

export interface UtilityResult {
  text: string
  provider: CodingProvider
}

/**
 * Run a one-shot prompt through the first usable harness, falling back down
 * the chain on failure. Throws only when every usable harness failed (or
 * none exists) — callers treat that the way they treated a Claude failure.
 */
export async function runUtilityPrompt(
  opts: OneShotOptions & { prefer?: CodingProvider; timeoutMs: number },
  exec: ExecOneShotFn = execOneShot,
): Promise<UtilityResult> {
  const candidates = utilityOrder(opts.prefer)
  if (candidates.length === 0) throw new Error('No usable coding agent on this host for background prompts')

  const failures: string[] = []
  for (const h of candidates) {
    try {
      const text = await exec(h.oneShotCommand(opts), opts.timeoutMs)
      return { text, provider: h.id }
    } catch (err) {
      failures.push(`${h.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`All agents failed the one-shot prompt — ${failures.join('; ')}`)
}
