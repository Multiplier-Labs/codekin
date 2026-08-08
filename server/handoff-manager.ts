/**
 * Handoff generation for cross-harness session transfer.
 *
 * Distills a session's on-disk transcript into a structured handoff document
 * (codekin-handoff/v1) via a one-shot `claude -p` call, saves it under
 * DATA_DIR/handoffs/, and builds the injection block prefixed to the first
 * message of the target harness. The injection always carries the raw
 * transcript path as a lossless escape hatch.
 *
 * Fallback chain: distilled handoff → raw condensed extract → null (caller
 * falls back to the display-buffer summary).
 *
 * See docs/SESSION-HANDOFF-SPEC.md.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'node:os'
import { join } from 'path'
import type { CodingProvider } from './coding-process.js'
import { CLAUDE_BINARY, DATA_DIR } from './config.js'
import { buildOneShotCliEnv } from './session-naming.js'
import { findTranscript, readCondensed } from './transcript-readers.js'

/** Chars of condensed transcript fed to the distiller (≈20k tokens). */
const EXTRACT_BUDGET_CHARS = 80_000
/** Time box for the one-shot distillation call. */
const DISTILL_TIMEOUT_MS = 90_000

export const HANDOFFS_DIR = join(DATA_DIR, 'handoffs')

const HARNESS_LABELS: Record<CodingProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

const DISTILL_SYSTEM_PROMPT =
  'You distill coding-session transcripts into handoff documents for another AI ' +
  'coding agent that will continue the work in the same repository. Output ONLY ' +
  'the handoff document in markdown — no preamble, no commentary. Use exactly ' +
  'these sections: "## Goal", "## State", "## Key findings & decisions", ' +
  '"## Files touched", "## Open questions / next steps". Be thorough but do not ' +
  'pad: include every fact, decision, constraint, and file path the next agent ' +
  'needs, and nothing decorative. Distinguish what was verified from what was ' +
  'assumed. Never include credentials, API keys, or tokens even if the ' +
  'transcript contains them.'

/** A generated handoff, ready for injection into the target session. */
export interface Handoff {
  /** Injectable body: the distilled document, or the raw extract on fallback. */
  content: string
  /** Raw source transcript path — the lossless escape hatch. */
  transcriptPath: string
  sourceHarness: CodingProvider
  /** False when distillation failed and content is the raw condensed extract. */
  distilled: boolean
  /** Saved handoff file under DATA_DIR/handoffs (distilled handoffs only). */
  savedPath: string | null
}

export interface HandoffSource {
  /** Codekin session id (used for the saved filename). */
  codekinSessionId: string
  provider: CodingProvider
  /** Effective cwd of the session (worktree path when one is used). */
  workingDir: string
  /** Harness-native session/thread id. */
  harnessSessionId: string | null
  /** Explicit transcript path — skips lookup by session id. Used by tests and
   *  by external-session import (Flow 2). */
  transcriptPath?: string
}

/** One-shot distillation call. Injectable for tests. */
export type DistillFn = (systemPrompt: string, prompt: string) => Promise<string>

function distillViaCli(systemPrompt: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // tmpdir cwd: prevent project CLAUDE.md/hooks from loading into the
    // distillation turn. Tools disabled — the transcript extract is the input.
    const proc = spawn(CLAUDE_BINARY, ['-p', '--max-turns', '1', '--tools', '', '--system-prompt', systemPrompt], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: tmpdir(),
      env: buildOneShotCliEnv(),
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('handoff distillation timed out'))
    }, DISTILL_TIMEOUT_MS)

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && stdout.trim()) resolve(stdout.trim())
      else reject(new Error(`claude -p exited with code ${code}: ${stderr.trim().slice(0, 500)}`))
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

/**
 * Generate a handoff for a session from its on-disk transcript.
 * Returns null when no transcript can be located or it yields no content —
 * the caller should fall back to its display-buffer summary.
 */
export async function generateHandoff(source: HandoffSource, distill: DistillFn = distillViaCli): Promise<Handoff | null> {
  const transcriptPath = source.transcriptPath ?? findTranscript(source.provider, source.workingDir, source.harnessSessionId ?? '')
  if (!transcriptPath) return null
  const extract = readCondensed(transcriptPath, source.provider, EXTRACT_BUDGET_CHARS)
  if (!extract) return null

  const label = HARNESS_LABELS[source.provider]
  try {
    const doc = await distill(
      DISTILL_SYSTEM_PROMPT,
      `Transcript extract of a ${label} session in repository ${source.workingDir} follows. Produce the handoff document.\n\n${extract}`,
    )
    const savedPath = saveHandoff(source, transcriptPath, doc)
    return { content: doc, transcriptPath, sourceHarness: source.provider, distilled: true, savedPath }
  } catch (err) {
    console.warn(`[handoff] distillation failed for session ${source.codekinSessionId}, falling back to raw extract:`, err instanceof Error ? err.message : err)
    return { content: extract, transcriptPath, sourceHarness: source.provider, distilled: false, savedPath: null }
  }
}

/** Write the distilled document with codekin-handoff/v1 frontmatter. */
function saveHandoff(source: HandoffSource, transcriptPath: string, doc: string): string | null {
  try {
    mkdirSync(HANDOFFS_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(HANDOFFS_DIR, `${source.codekinSessionId}-${stamp}.md`)
    const frontmatter = [
      '---',
      'schema: codekin-handoff/v1',
      'source:',
      `  harness: ${source.provider}`,
      `  sessionId: ${source.harnessSessionId ?? 'unknown'}`,
      `  transcript: ${transcriptPath}`,
      `repo: ${source.workingDir}`,
      `created: ${new Date().toISOString()}`,
      '---',
      '',
    ].join('\n')
    writeFileSync(path, frontmatter + doc + '\n')
    return path
  } catch (err) {
    console.warn('[handoff] could not save handoff file:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Build the block prefixed to the first user message of the target process. */
export function buildHandoffInjection(handoff: Handoff): string {
  const label = HARNESS_LABELS[handoff.sourceHarness]
  const intro = handoff.distilled
    ? 'A handoff summary follows.'
    : 'A condensed extract of that session follows.'
  return (
    `[Handoff: this session continues work from a previous ${label} session. ${intro} ` +
    `The full transcript of the previous session is at ${handoff.transcriptPath} (JSONL) — ` +
    `read or grep it if you need details the summary omits.]\n\n` +
    `${handoff.content}\n\n` +
    `[End of handoff. The user's message follows.]`
  )
}
