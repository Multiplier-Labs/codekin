/**
 * On-disk output history: one append-only log per session.
 *
 * Each history was a JSON array rewritten whenever it changed. Histories run
 * to tens of megabytes, and the rewrite was synchronous: with ten sessions
 * streaming, every two-second persist serialized all ten and stopped the
 * event loop for the better part of a second, delaying every join, prompt and
 * stream frame queued behind it.
 *
 * Now `session-history/<id>.jsonl` holds one `[position, entry]` line per
 * entry, positions absolute as in history-window.ts. A persist appends only
 * the entries added since the last one, and re-appends the last entry when it
 * grew in place (streamed `output` merges into it): when reading, a later line
 * for a position replaces an earlier one, and the oldest entries past
 * MAX_HISTORY are dropped.
 *
 * Changes an append cannot express (the array replaced, or a history with no
 * log yet) and logs grown mostly stale are rewritten whole by compaction. That
 * runs off the persist path, one session at a time, serializing in slices
 * between which the event loop runs; the new log replaces the old by rename.
 * A short history is still rewritten at once. On shutdown (`final`)
 * pending rewrites are done synchronously.
 *
 * Files from before this format (`<id>.json`, a JSON array) are still read.
 * One is converted to a log the first time its history changes, and left in
 * place so that an older version, if reinstalled, still finds a history; it is
 * removed with the session.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { MAX_HISTORY } from './history-window.js'
import { jsonParse } from './json-parse.js'
import type { Session, WsServerMessage } from './types.js'

/** Ids that are safe as file names; any other id keeps its history inline. */
const FILE_SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Compact a log once this much has been appended since it was last written whole... */
const COMPACT_MIN_BYTES = 8 * 1024 * 1024

/** A history no longer than this is rewritten at once rather than queued. */
const SMALL_HISTORY_ENTRIES = 64

/** Serialized text per write while compacting; the event loop runs between slices. */
const COMPACT_SLICE_CHARS = 1024 * 1024

/** What was last written for a session, so the next persist appends only what changed. */
interface LogMark {
  /** The array written; a replaced array cannot be appended to. */
  ref: WsServerMessage[]
  /** Absolute position after the last entry written. */
  end: number
  /** The last entry written, and its text length when it was. */
  last: WsServerMessage | undefined
  lastSize: number
  /** Characters appended since the log was last written whole, and that write's size. */
  appended: number
  compacted: number
}

/** A history restored from a pre-log file, as read: unchanged, it needs no log yet. */
interface LegacyMark {
  ref: WsServerMessage[]
  length: number
  last: WsServerMessage | undefined
  lastSize: number
}

interface Compaction {
  aborted: boolean
}

/** Read at the time of the call: a shutdown can abandon a rewrite across any await. */
function abandoned(job: Compaction): boolean {
  return job.aborted
}

function sizeOf(entry: WsServerMessage | undefined): number {
  return entry?.type === 'output' ? entry.data.length : 0
}

function lines(history: WsServerMessage[], from: number, to: number, base: number): string {
  let out = ''
  for (let i = from; i < to; i++) out += JSON.stringify([base + i, history[i]]) + '\n'
  return out
}

function unlinkQuietly(file: string): void {
  try {
    unlinkSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`Failed to remove ${file}:`, err)
  }
}

export class HistoryStore {
  private marks = new Map<string, LogMark>()
  private legacy = new Map<string, LegacyMark>()
  /** Sessions with a log (or a legacy file) on disk that restoring would read. */
  private onDisk = new Set<string>()
  /** Rewrites queued or running, by session. */
  private compactions = new Map<string, Compaction>()
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private dir: string,
    private sessions: Map<string, Session>,
    /** A compaction finished: what it skipped can now be persisted. */
    private onCompacted: () => void = () => {},
  ) {}

  private logFile(id: string): string {
    return join(this.dir, `${id}.jsonl`)
  }

  private legacyFile(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  /**
   * Bring every history's log up to date. Returns the ids whose history is
   * in no file yet and so must stay inline in `sessions.json`.
   */
  writeAll(final = false): Set<string> {
    const inline = new Set<string>()
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch (err) {
      console.error('Failed to create the session history folder:', err)
      for (const id of this.sessions.keys()) inline.add(id)
      return inline
    }
    if (final) {
      // A rewrite still running is abandoned; its log is written below.
      for (const job of this.compactions.values()) job.aborted = true
      this.compactions.clear()
    }
    for (const s of this.sessions.values()) {
      if (!FILE_SAFE_ID.test(s.id)) { inline.add(s.id); continue }
      if (this.legacyUnchanged(s)) continue
      if (!this.compactions.has(s.id) && this.append(s)) continue
      if (!this.compactions.has(s.id) && (final || s.outputHistory.length <= SMALL_HISTORY_ENTRIES)) {
        if (this.rewriteNow(s)) continue
      } else {
        this.schedule(s.id)
      }
      if (!this.onDisk.has(s.id)) inline.add(s.id)
    }
    return inline
  }

  /** Still exactly as read from a pre-log file, which keeps serving it. */
  private legacyUnchanged(s: Session): boolean {
    const mark = this.legacy.get(s.id)
    if (!mark) return false
    const history = s.outputHistory
    const last = history[history.length - 1]
    if (mark.ref === history && mark.length === history.length && mark.last === last && mark.lastSize === sizeOf(last)) return true
    this.legacy.delete(s.id)
    return false
  }

  /**
   * Append what changed since the last write. False when the change is not
   * an append (or the write failed) and the log must be rewritten.
   */
  private append(s: Session): boolean {
    const mark = this.marks.get(s.id)
    const history = s.outputHistory
    if (!mark || mark.ref !== history) return false
    const base = s._historyBase ?? 0
    const end = base + history.length
    // Trimmed past everything written, or shorter without a trim: not an append.
    if (base > mark.end || end < mark.end) return false
    let from = mark.end
    const lastIdx = mark.end - 1 - base
    if (lastIdx >= 0 && (history[lastIdx] !== mark.last || sizeOf(history[lastIdx]) !== mark.lastSize)) from = mark.end - 1
    if (from === end) return true

    const text = lines(history, from - base, history.length, base)
    try {
      appendFileSync(this.logFile(s.id), text, { mode: 0o600 })
    } catch (err) {
      console.error(`Failed to append history for session ${s.id}:`, err)
      this.marks.delete(s.id)
      return false
    }
    mark.end = end
    mark.last = history[history.length - 1]
    mark.lastSize = sizeOf(mark.last)
    mark.appended += text.length
    if (mark.appended > Math.max(COMPACT_MIN_BYTES, mark.compacted)) this.schedule(s.id)
    return true
  }

  /** Write a history's log whole, synchronously. */
  private rewriteNow(s: Session): boolean {
    const history = s.outputHistory
    const base = s._historyBase ?? 0
    const file = this.logFile(s.id)
    const tmp = file + '.tmp'
    try {
      const text = lines(history, 0, history.length, base)
      writeFileSync(tmp, text, { mode: 0o600 })
      renameSync(tmp, file)
      const last = history[history.length - 1]
      this.written(s.id, history, base + history.length, last, sizeOf(last), text.length)
      return true
    } catch (err) {
      console.error(`Failed to persist history for session ${s.id}:`, err)
      this.marks.delete(s.id)
      return false
    }
  }

  /** Record a whole-log write ending at absolute position `end`, whose last entry was `last` at `lastSize`. */
  private written(id: string, ref: WsServerMessage[], end: number, last: WsServerMessage | undefined, lastSize: number, chars: number): void {
    this.marks.set(id, { ref, end, last, lastSize, appended: 0, compacted: chars })
    this.onDisk.add(id)
  }

  /** Queue a rewrite of one session's log. Appends to it wait until it is done. */
  private schedule(id: string): void {
    if (this.compactions.has(id)) return
    const job: Compaction = { aborted: false }
    this.compactions.set(id, job)
    this.queue = this.queue
      .then(() => this.compact(id, job))
      .catch((err: unknown) => {
        console.error(`Failed to compact history for session ${id}:`, err)
        if (this.compactions.get(id) === job) this.compactions.delete(id)
      })
  }

  private async compact(id: string, job: Compaction): Promise<void> {
    const s = this.sessions.get(id)
    if (job.aborted || !s) {
      if (this.compactions.get(id) === job) this.compactions.delete(id)
      return
    }
    const history = s.outputHistory
    const snapshot = history.slice()
    const last = snapshot[snapshot.length - 1]
    // Taken now: if `last` grows while this runs, the next append re-writes it.
    const lastSize = sizeOf(last)
    const base = s._historyBase ?? 0
    const file = this.logFile(id)
    const tmp = file + '.compact.tmp'

    let chars = 0
    const handle = await open(tmp, 'w', 0o600)
    try {
      let i = 0
      while (i < snapshot.length) {
        if (abandoned(job)) break
        let text = ''
        while (i < snapshot.length && text.length < COMPACT_SLICE_CHARS) {
          text += JSON.stringify([base + i, snapshot[i]]) + '\n'
          i++
        }
        await handle.write(text)
        chars += text.length
      }
    } finally {
      await handle.close()
    }

    // Checked and renamed in one turn of the event loop, so no append can
    // land in the old log between the two and be lost.
    if (abandoned(job) || this.compactions.get(id) !== job || !this.sessions.has(id)) {
      unlinkQuietly(tmp)
      return
    }
    renameSync(tmp, file)
    this.compactions.delete(id)
    this.written(id, history, base + snapshot.length, last, lastSize, chars)
    this.onCompacted()
  }

  /** Remove the logs of sessions that are gone (deleted or archived). */
  removeStale(): void {
    const known = new Set([...this.marks.keys(), ...this.legacy.keys(), ...this.onDisk, ...this.compactions.keys()])
    for (const id of known) {
      if (this.sessions.has(id)) continue
      this.marks.delete(id)
      this.legacy.delete(id)
      this.onDisk.delete(id)
      const job = this.compactions.get(id)
      if (job) { job.aborted = true; this.compactions.delete(id) }
      unlinkQuietly(this.logFile(id))
      unlinkQuietly(this.legacyFile(id))
    }
  }

  /**
   * A session's history from its log, or null when it has none. `base` is
   * the absolute position of the first entry kept.
   */
  read(id: string): { history: WsServerMessage[]; base: number } | null {
    if (!FILE_SAFE_ID.test(id)) return null
    const file = this.logFile(id)
    if (existsSync(file)) {
      try {
        return this.readLog(id, file)
      } catch (err) {
        console.warn(`Failed to restore history for session ${id}:`, err)
      }
    }
    const legacy = this.legacyFile(id)
    if (!existsSync(legacy)) return null
    try {
      const history = jsonParse(readFileSync(legacy, 'utf-8')) as WsServerMessage[]
      if (!Array.isArray(history)) return null
      this.onDisk.add(id)
      const kept = history.slice(-MAX_HISTORY)
      const last = kept[kept.length - 1]
      this.legacy.set(id, { ref: kept, length: kept.length, last, lastSize: sizeOf(last) })
      return { history: kept, base: history.length - kept.length }
    } catch (err) {
      console.warn(`Failed to restore history for session ${id}:`, err)
      return null
    }
  }

  private readLog(id: string, file: string): { history: WsServerMessage[]; base: number } {
    const byPosition = new Map<number, WsServerMessage>()
    let max = -1
    const text = readFileSync(file, 'utf-8')
    for (const line of text.split('\n')) {
      if (!line) continue
      let parsed: unknown
      try {
        parsed = jsonParse(line)
      } catch {
        continue // a line cut short by a crash
      }
      if (!Array.isArray(parsed) || typeof parsed[0] !== 'number' || typeof parsed[1] !== 'object' || parsed[1] === null) continue
      const pos = parsed[0]
      byPosition.set(pos, parsed[1] as WsServerMessage)
      if (pos > max) max = pos
    }
    this.onDisk.add(id)
    const kept = [...byPosition].sort((a, b) => a[0] - b[0]).slice(-MAX_HISTORY)
    const positions = kept.map(([pos]) => pos)
    const history = kept.map(([, entry]) => entry)
    const base = positions.length ? positions[0] : 0
    // Positions must run without a gap for appends to continue them, and the
    // log must end with a newline: an append after a line cut short by a crash
    // would join that line and be lost with it. Otherwise the first persist
    // rewrites the log.
    const contiguous = positions.length === 0 || max - base + 1 === positions.length
    if (contiguous && (text === '' || text.endsWith('\n'))) {
      const last = history[history.length - 1]
      this.marks.set(id, { ref: history, end: base + history.length, last, lastSize: sizeOf(last), appended: 0, compacted: text.length })
    }
    return { history, base }
  }

  /** Resolves once queued rewrites have finished (tests). */
  whenIdle(): Promise<void> {
    return this.queue
  }
}
