/** Tests for exclusive state-directory ownership and the writer-version guard (desktop plan D7). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import {
  OWNERSHIP_DB,
  DataDirInUseError,
  DataDirNewerError,
  acquireDataOwnership,
  compareSemver,
  type OwnershipHandle,
} from './data-ownership.js'

let root: string
const handles: OwnershipHandle[] = []
const take = (dirs: string[], version = '1.0.0') => {
  const h = acquireDataOwnership(dirs, version)
  handles.push(h)
  return h
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codekin-own-')) })
afterEach(() => {
  for (const h of handles.splice(0)) h.release()
  rmSync(root, { recursive: true, force: true })
})

function readMeta(dir: string): Record<string, string> {
  const db = new Database(join(dir, OWNERSHIP_DB), { readonly: true })
  try {
    const rows = db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]
    return Object.fromEntries(rows.map(r => [r.key, r.value]))
  } finally { db.close() }
}

describe('compareSemver', () => {
  it('compares numerically, not as strings', () => {
    expect(compareSemver('0.9.10', '0.9.9')).toBe(1)
    expect(compareSemver('0.10.0', '0.9.99')).toBe(1)
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
    expect(compareSemver('v1.2.3', '1.2.4')).toBe(-1)
  })

  it('ranks prereleases below their release, per SemVer 2.0', () => {
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1)
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareSemver('1.0.0+build.1', '1.0.0+build.2')).toBe(0)
  })

  it('returns null for non-semver input', () => {
    expect(compareSemver('unknown', '1.0.0')).toBeNull()
    expect(compareSemver('1.0', '1.0.0')).toBeNull()
  })
})

describe('acquireDataOwnership', () => {
  it('creates the directory and records the writer version', () => {
    const dir = join(root, 'data')
    const h = take([dir], '1.2.3')
    expect(existsSync(join(dir, OWNERSHIP_DB))).toBe(true)
    expect(h.previousVersions[h.dirs[0]]).toBeNull()
    h.release()
    expect(readMeta(dir)).toMatchObject({ writer_version: '1.2.3', owner_pid: String(process.pid) })
  })

  it('refuses a second owner, and allows one after release', () => {
    const dir = join(root, 'data')
    const first = take([dir])
    expect(() => acquireDataOwnership([dir], '1.0.0')).toThrow(DataDirInUseError)
    first.release()
    expect(() => take([dir])).not.toThrow()
  })

  it('treats a symlinked path as the same directory', () => {
    const dir = join(root, 'data')
    mkdirSync(dir)
    const link = join(root, 'link')
    symlinkSync(dir, link)
    const h = take([dir, link])
    expect(h.dirs).toHaveLength(1)
    expect(() => acquireDataOwnership([link], '1.0.0')).toThrow(DataDirInUseError)
  })

  it('is all or nothing across directories', () => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    take([b])
    expect(() => acquireDataOwnership([a, b], '1.0.0')).toThrow(DataDirInUseError)
    // `a` was taken first (sorted order) and must have been released again.
    expect(() => take([a])).not.toThrow()
  })

  it('refuses an older server without changing the marker', () => {
    const dir = join(root, 'data')
    take([dir], '2.0.0').release()
    handles.length = 0
    let err: unknown
    try { acquireDataOwnership([dir], '1.9.9') } catch (e) { err = e }
    expect(err).toBeInstanceOf(DataDirNewerError)
    expect(err).toMatchObject({ writerVersion: '2.0.0', serverVersion: '1.9.9', code: 'data_newer' })
    expect(readMeta(dir).writer_version).toBe('2.0.0')
    // The refused attempt released its lock.
    expect(() => take([dir], '2.0.0')).not.toThrow()
  })

  it('records upgrades and allows the same version', () => {
    const dir = join(root, 'data')
    take([dir], '1.0.0').release()
    const h = take([dir], '1.1.0')
    expect(h.previousVersions[h.dirs[0]]).toBe('1.0.0')
    h.release()
    expect(readMeta(dir).writer_version).toBe('1.1.0')
    expect(() => take([dir], '1.1.0')).not.toThrow()
  })

  it('never overwrites a real marker with an unparseable version', () => {
    const dir = join(root, 'data')
    take([dir], '1.0.0').release()
    take([dir], 'unknown').release()
    expect(readMeta(dir).writer_version).toBe('1.0.0')
  })

  it('is released by the kernel when the owning process dies', async () => {
    const dir = join(root, 'data')
    mkdirSync(dir)
    // A separate process holds the same lock the way the server does.
    const holder = spawn(process.execPath, ['-e', `
      const Database = require(${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))});
      const db = new Database(${JSON.stringify(join(dir, OWNERSHIP_DB))}, { timeout: 0 });
      db.pragma('locking_mode = EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE');
      db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.exec('COMMIT');
      process.stdout.write('held\\n');
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>(resolve => holder.stdout.once('data', () => resolve()))
    expect(() => acquireDataOwnership([dir], '1.0.0')).toThrow(DataDirInUseError)
    holder.kill('SIGKILL')
    await new Promise(resolve => holder.once('exit', resolve))
    expect(() => take([dir])).not.toThrow()
  })
})
