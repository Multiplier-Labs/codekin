/**
 * Content-addressed artifact bodies for Loops 2.0.
 *
 * Evaluator output, diffs, reviews, and reports are retained as evidence —
 * metadata lives in the `loop_artifacts` table (LoopStore); bodies live here,
 * on disk, keyed by sha256 so identical output (a re-run producing the same
 * failure) is stored once. Bodies are written with 0o600 like the databases.
 *
 * Layout: {baseDir}/ab/abcdef…  (two-char fan-out to keep directories small)
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'

export class LoopArtifactStore {
  constructor(private readonly baseDir: string) {}

  /** Write a body (idempotent) and return its content hash. */
  put(body: string | Buffer): string {
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body
    const hash = createHash('sha256').update(buf).digest('hex')
    const dir = join(this.baseDir, hash.slice(0, 2))
    const path = join(dir, hash)
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, buf)
      chmodSync(path, 0o600)
    }
    return hash
  }

  /** Read a body by content hash; null when missing (e.g. pruned by retention). */
  get(contentHash: string): Buffer | null {
    // Hash comes from our own DB rows, but guard the path join anyway.
    if (!/^[0-9a-f]{64}$/.test(contentHash)) return null
    const path = join(this.baseDir, contentHash.slice(0, 2), contentHash)
    return existsSync(path) ? readFileSync(path) : null
  }
}
