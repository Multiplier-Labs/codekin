/**
 * The machine's own record of what the relay delivered and what it did with
 * it (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §7.2):
 * ~/.codekin/relay/intents.jsonl, mode 0600, append-only.
 *
 * One line per signed (or, in warn mode, unsigned) message:
 *
 *   { "seq", "prev", "at", "verdict", "reason"?, "action", "sessionId",
 *     "userId", "keyId", "payloadHash", "intent"? }
 *
 * `prev` is the SHA-256 (hex) of the previous line's exact text, so a line
 * can't be edited, dropped or inserted without breaking the chain. No
 * content: the stored intent holds only a hash of what ran, and proves who
 * signed it. Rotated at 30 days or 50 MB; the new file's first line chains
 * to the old file's last.
 */

import { createHash } from 'crypto'
import { appendFileSync, chmodSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, closeSync, renameSync, rmSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import type { SignedIntent } from './intent-actions.js'

export function intentLogPath(home = homedir()): string {
  return join(home, '.codekin', 'relay', 'intents.jsonl')
}

export type IntentVerdict = 'accepted' | 'rejected' | 'unsigned'

export interface IntentLogEntry {
  seq: number
  prev: string
  at: string
  verdict: IntentVerdict
  /** Why it was rejected or unsigned; set unless accepted. */
  reason?: string
  /** Whether it reached the local server (warn and off modes forward refusals). */
  forwarded: boolean
  action: string
  sessionId: string | null
  /** Relay principal the message came with. */
  userId: string | null
  keyId: string | null
  payloadHash: string | null
  /** Kept for accepted intents only: it proves who signed what. */
  intent?: SignedIntent
  /** Privileged actions (§6.6): whether a passkey or only the browser key confirmed it. */
  stepUp?: 'passkey' | 'browser-key'
  /** Refusals not written since the previous line (rate limit). */
  suppressedBefore?: number
}

export type IntentLogInput = Omit<IntentLogEntry, 'seq' | 'prev' | 'at'>

export const ROTATE_BYTES = 50 * 1024 * 1024
export const ROTATE_AGE_MS = 30 * 24 * 60 * 60_000

/** The hash a line contributes to the next line's `prev`. */
export function lineHash(line: string): string {
  return createHash('sha256').update(line, 'utf-8').digest('hex')
}

/** The first `prev` in a chain that starts from nothing. */
export const GENESIS = '0'.repeat(64)

/** Up to `maxBytes` from the end of a file, starting at a line boundary. */
function readTail(file: string, maxBytes: number): string {
  let size: number
  try { size = statSync(file).size } catch { return '' }
  if (size === 0) return ''
  const start = Math.max(0, size - maxBytes)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString('utf-8')
    // A partial first line (we started mid-file) is dropped.
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1)
  } finally {
    closeSync(fd)
  }
}

function firstLine(file: string): string | null {
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const n = readSync(fd, buf, 0, buf.length, 0)
      const text = buf.subarray(0, n).toString('utf-8')
      const nl = text.indexOf('\n')
      return nl === -1 ? (text || null) : text.slice(0, nl)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Rotated files kept beside the live log (30 days each: about a year). */
export const KEEP_ROTATED = 12
/** Refused and unsigned lines written per minute; a relay flooding the machine can't fill its disk. */
export const REFUSALS_PER_MINUTE = 120
/** How far back from the end to read for recent entries (the UI) and for replay seeding. */
const TAIL_BYTES = 8 * 1024 * 1024

export class IntentLog {
  private seq = 0
  private prev = GENESIS
  private startedAt: number | null = null
  private size = 0
  private loaded = false
  private refusalWindow = 0
  private refusalsInWindow = 0
  private suppressed = 0

  constructor(
    private readonly file = intentLogPath(),
    private readonly now: () => number = Date.now,
    private readonly log: Pick<Console, 'warn'> = console,
  ) {}

  get path(): string {
    return this.file
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    mkdirSync(dirname(this.file), { recursive: true })
    const tail = readTail(this.file, 1024 * 1024)
    if (!tail) return
    try { this.size = statSync(this.file).size } catch { this.size = 0 }
    const lines = tail.split('\n')
    const torn = !tail.endsWith('\n')
    if (lines.at(-1) === '') lines.pop()
    const last = lines.at(-1)
    if (last === undefined) return
    // Chain from the last line as written, even a torn one, so `verify`
    // reports the break instead of the log hiding it; take `seq` from the
    // last line that parses.
    this.prev = lineHash(last)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as Partial<IntentLogEntry>
        if (typeof entry.seq === 'number') { this.seq = entry.seq; break }
      } catch { /* keep looking */ }
    }
    // Never append onto the end of a torn line.
    if (torn) {
      appendFileSync(this.file, '\n')
      this.size += 1
    }
    const first = firstLine(this.file)
    try {
      const at = first ? Date.parse((JSON.parse(first) as { at?: string }).at ?? '') : NaN
      this.startedAt = Number.isNaN(at) ? this.now() : at
    } catch {
      this.startedAt = this.now()
    }
  }

  private rotateIfDue(): void {
    if (this.size === 0) return
    const tooOld = this.startedAt !== null && this.now() - this.startedAt > ROTATE_AGE_MS
    if (this.size < ROTATE_BYTES && !tooOld) return
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
    renameSync(this.file, this.file.replace(/\.jsonl$/, `-${stamp}.jsonl`))
    this.size = 0
    this.startedAt = null
    this.pruneRotated()
  }

  /** Rotated files beside the live log, oldest first (their names sort by time). */
  private rotatedFiles(): string[] {
    const base = basename(this.file, '.jsonl')
    try {
      return readdirSync(dirname(this.file)).filter(f => f.startsWith(`${base}-`) && f.endsWith('.jsonl')).sort()
    } catch {
      return []
    }
  }

  private pruneRotated(): void {
    const rotated = this.rotatedFiles()
    for (const old of rotated.slice(0, Math.max(0, rotated.length - KEEP_ROTATED))) {
      try { rmSync(join(dirname(this.file), old), { force: true }) } catch { /* best effort */ }
    }
  }

  /** False when this refusal should be counted rather than written. */
  private admitRefusal(): boolean {
    const minute = Math.floor(this.now() / 60_000)
    if (minute !== this.refusalWindow) {
      this.refusalWindow = minute
      this.refusalsInWindow = 0
    }
    this.refusalsInWindow += 1
    if (this.refusalsInWindow <= REFUSALS_PER_MINUTE) return true
    this.suppressed += 1
    return false
  }

  /** Append one entry. Never throws: losing a log line must not break the machine. */
  append(input: IntentLogInput): IntentLogEntry | null {
    try {
      if (input.verdict !== 'accepted' && !this.admitRefusal()) return null
      this.load()
      this.rotateIfDue()
      const suppressed = this.suppressed
      const entry: IntentLogEntry = {
        seq: this.seq + 1,
        prev: this.prev,
        at: new Date(this.now()).toISOString(),
        ...input,
        // Refusals left out since the last line, so a gap is visible.
        ...(suppressed > 0 ? { suppressedBefore: suppressed } : {}),
      }
      const line = JSON.stringify(entry)
      const created = this.size === 0
      appendFileSync(this.file, line + '\n', { mode: 0o600 })
      if (created) chmodSync(this.file, 0o600)
      this.suppressed = 0
      this.size += Buffer.byteLength(line) + 1
      this.seq = entry.seq
      this.prev = lineHash(line)
      this.startedAt ??= this.now()
      return entry
    } catch (err) {
      this.log.warn(`[relay] Could not write the intent log: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /**
   * Nonces of intents accepted since `since`, to seed the replay cache after a
   * restart. Reads the newest rotated file too: a rotation may have just
   * happened.
   */
  recentAcceptedNonces(since: number): Array<{ keyId: string; nonce: string; at: number }> {
    const out: Array<{ keyId: string; nonce: string; at: number }> = []
    const newestRotated = this.rotatedFiles().at(-1)
    const text = (newestRotated ? readTail(join(dirname(this.file), newestRotated), TAIL_BYTES) : '') + readTail(this.file, TAIL_BYTES)
    for (const entry of parseLines(text)) {
      if (entry.verdict !== 'accepted' || !entry.intent || !entry.keyId) continue
      const at = Date.parse(entry.at)
      if (!(at >= since)) continue
      try {
        const nonce = (JSON.parse(entry.intent.body) as { nonce?: unknown }).nonce
        if (typeof nonce === 'string') out.push({ keyId: entry.keyId, nonce, at })
      } catch { /* skip */ }
    }
    return out
  }
}

function parseLines(text: string): IntentLogEntry[] {
  const out: IntentLogEntry[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line) as IntentLogEntry) } catch { /* torn or edited; verify reports it */ }
  }
  return out
}

export interface ChainCheck {
  ok: boolean
  entries: number
  /** First problem found, with its 1-based line number. */
  problem?: { line: number; reason: string }
}

/**
 * Check a log file's chain: every line parses, `seq` counts up by one and
 * `prev` is the hash of the line before. The first line's `prev` is taken
 * as given (it chains to a rotated file, or is GENESIS).
 */
export function verifyIntentLog(file: string): ChainCheck {
  let text: string
  try { text = readFileSync(file, 'utf-8') } catch { return { ok: false, entries: 0, problem: { line: 0, reason: 'cannot read the log' } } }
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let prevLine: string | null = null
  let prevSeq: number | null = null
  for (let i = 0; i < lines.length; i++) {
    let entry: Partial<IntentLogEntry>
    try { entry = JSON.parse(lines[i]) as Partial<IntentLogEntry> } catch {
      return { ok: false, entries: i, problem: { line: i + 1, reason: 'not valid JSON (torn or edited line)' } }
    }
    if (prevLine !== null && entry.prev !== lineHash(prevLine)) {
      return { ok: false, entries: i, problem: { line: i + 1, reason: 'does not chain to the line before (edited, removed or inserted)' } }
    }
    if (prevSeq !== null && entry.seq !== prevSeq + 1) {
      return { ok: false, entries: i, problem: { line: i + 1, reason: `sequence jumps from ${prevSeq} to ${String(entry.seq)}` } }
    }
    prevLine = lines[i]
    prevSeq = typeof entry.seq === 'number' ? entry.seq : null
  }
  return { ok: true, entries: lines.length }
}

/** The newest entries, newest first, optionally filtered (for local Settings → Activity). Reads only the file's tail. */
export function readRecentIntents(
  file: string,
  opts: { limit?: number; keyId?: string; sessionId?: string; verdict?: IntentVerdict } = {},
): IntentLogEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
  const out: IntentLogEntry[] = []
  const entries = parseLines(readTail(file, TAIL_BYTES))
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const entry = entries[i]
    if (opts.keyId && entry.keyId !== opts.keyId) continue
    if (opts.sessionId && entry.sessionId !== opts.sessionId) continue
    if (opts.verdict && entry.verdict !== opts.verdict) continue
    out.push(entry)
  }
  return out
}
