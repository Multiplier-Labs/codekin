import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHandoffInjection, generateHandoff, HANDOFFS_DIR } from './handoff-manager.js'
import type { Handoff, HandoffSource } from './handoff-manager.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codekin-handoff-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeClaudeTranscript(): string {
  const path = join(dir, 'session.jsonl')
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Research the storage format' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'It is JSONL, one line per event.' }] } },
  ]
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'))
  return path
}

function source(transcriptPath: string): HandoffSource {
  return {
    codekinSessionId: 'test-session-1',
    provider: 'claude',
    workingDir: '/repo',
    harnessSessionId: 'abc-123',
    transcriptPath,
  }
}

describe('generateHandoff', () => {
  it('distills the extract and saves a frontmattered handoff file', async () => {
    const transcript = writeClaudeTranscript()
    const distill = vi.fn().mockResolvedValue('## Goal\nUnderstand the storage format.')
    const handoff = await generateHandoff(source(transcript), distill)

    expect(handoff).not.toBeNull()
    expect(handoff!.distilled).toBe(true)
    expect(handoff!.content).toContain('## Goal')
    expect(handoff!.transcriptPath).toBe(transcript)
    // Distiller received the condensed extract, not raw JSONL
    const prompt = distill.mock.calls[0][1] as string
    expect(prompt).toContain('User: Research the storage format')
    expect(prompt).not.toContain('"role"')
    // Saved file carries schema frontmatter
    expect(handoff!.savedPath).not.toBeNull()
    const saved = readFileSync(handoff!.savedPath!, 'utf8')
    expect(saved).toContain('schema: codekin-handoff/v1')
    expect(saved).toContain('harness: claude')
    expect(saved).toContain(`transcript: ${transcript}`)
    rmSync(handoff!.savedPath!, { force: true })
  })

  it('falls back to the raw extract when distillation fails', async () => {
    const transcript = writeClaudeTranscript()
    const distill = vi.fn().mockRejectedValue(new Error('timeout'))
    const handoff = await generateHandoff(source(transcript), distill)

    expect(handoff).not.toBeNull()
    expect(handoff!.distilled).toBe(false)
    expect(handoff!.content).toContain('User: Research the storage format')
    expect(handoff!.savedPath).toBeNull()
  })

  it('returns null when no transcript exists', async () => {
    const distill = vi.fn()
    const handoff = await generateHandoff(source(join(dir, 'missing.jsonl')), distill)
    expect(handoff).toBeNull()
    expect(distill).not.toHaveBeenCalled()
  })

  it('returns null for sessions without a harness session id and no explicit path', async () => {
    const handoff = await generateHandoff(
      { codekinSessionId: 's', provider: 'claude', workingDir: join(dir, 'no-such-repo'), harnessSessionId: null },
      vi.fn(),
    )
    expect(handoff).toBeNull()
  })
})

describe('buildHandoffInjection', () => {
  const base: Handoff = {
    content: '## Goal\nShip it.',
    transcriptPath: '/home/x/.codex/sessions/2026/08/05/rollout-x.jsonl',
    sourceHarness: 'codex',
    distilled: true,
    savedPath: null,
  }

  it('frames a distilled handoff with source label and transcript escape hatch', () => {
    const text = buildHandoffInjection(base)
    expect(text).toContain('continues work from a previous Codex session')
    expect(text).toContain('A handoff summary follows.')
    expect(text).toContain(base.transcriptPath)
    expect(text).toContain('## Goal')
    expect(text).toMatch(/\[End of handoff\. The user's message follows\.\]$/)
  })

  it('labels raw extracts differently', () => {
    const text = buildHandoffInjection({ ...base, distilled: false })
    expect(text).toContain('A condensed extract of that session follows.')
  })
})

describe('HANDOFFS_DIR', () => {
  it('lives under the Codekin data dir', () => {
    expect(HANDOFFS_DIR.endsWith(join('handoffs'))).toBe(true)
    // Never a repo-relative path
    expect(existsSync(HANDOFFS_DIR) || HANDOFFS_DIR.startsWith('/')).toBe(true)
  })
})
