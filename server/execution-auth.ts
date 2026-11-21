/**
 * Execution API clients (docs/EXECUTION-API.md §Authentication).
 *
 * Applications that submit jobs authenticate with their own bearer token,
 * listed by SHA-256 hash in a clients file:
 *
 *   [{ "id": "myapp", "tokenSha256": "<hex>", "harnesses": ["codex"], "maxQueued": 50 }]
 *
 * These tokens open only /api/execution/v1, and Codekin's admin and session
 * tokens are not accepted there. The file is re-read when it changes, so
 * removing an entry revokes that client on its next request.
 */

import { createHash, timingSafeEqual } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'

export interface ExecutionClient {
  id: string
  harnesses: string[]
  maxQueued: number | null
}

interface ClientEntry extends ExecutionClient {
  hash: Buffer
}

function parseClients(text: string): ClientEntry[] {
  const data = JSON.parse(text) as unknown
  if (!Array.isArray(data)) throw new Error('clients file must be a JSON array')
  const out: ClientEntry[] = []
  const ids = new Set<string>()
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') throw new Error('each client must be an object')
    const c = raw as Record<string, unknown>
    if (typeof c.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(c.id)) throw new Error('client "id" must match [A-Za-z0-9._-]{1,64}')
    if (ids.has(c.id)) throw new Error(`duplicate client id "${c.id}"`)
    if (typeof c.tokenSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(c.tokenSha256)) throw new Error(`client "${c.id}": tokenSha256 must be 64 hex characters`)
    const harnesses = Array.isArray(c.harnesses) ? c.harnesses.filter((h): h is string => typeof h === 'string') : []
    if (harnesses.length === 0) throw new Error(`client "${c.id}": list at least one harness`)
    ids.add(c.id)
    out.push({
      id: c.id,
      harnesses,
      maxQueued: typeof c.maxQueued === 'number' && c.maxQueued > 0 ? Math.floor(c.maxQueued) : null,
      hash: Buffer.from(c.tokenSha256.toLowerCase(), 'hex'),
    })
  }
  return out
}

export class ExecutionClients {
  private entries: ClientEntry[] = []
  private loadedMtime = -1
  private lastError: string | null = null

  constructor(private path: string) {}

  /** Reload when the file's mtime changed; a broken file disables every client (fail closed). */
  private refresh(): void {
    if (!existsSync(this.path)) {
      this.entries = []
      this.loadedMtime = -1
      return
    }
    const mtime = statSync(this.path).mtimeMs
    if (mtime === this.loadedMtime) return
    this.loadedMtime = mtime
    try {
      this.entries = parseClients(readFileSync(this.path, 'utf-8'))
      this.lastError = null
    } catch (e) {
      this.entries = []
      this.lastError = (e as Error).message
      console.error(`[execution] Ignoring clients file ${this.path}: ${this.lastError}`)
    }
  }

  get error(): string | null {
    this.refresh()
    return this.lastError
  }

  get count(): number {
    this.refresh()
    return this.entries.length
  }

  /** The client owning this bearer token, else null. Compares every entry in constant time. */
  authenticate(token: string | undefined): ExecutionClient | null {
    if (!token) return null
    this.refresh()
    const hash = createHash('sha256').update(token).digest()
    let match: ClientEntry | null = null
    for (const e of this.entries) {
      if (timingSafeEqual(hash, e.hash) && !match) match = e
    }
    return match ? { id: match.id, harnesses: [...match.harnesses], maxQueued: match.maxQueued } : null
  }
}
