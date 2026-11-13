/** Changes for a session's attached folders, against real git repositories. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager } from './session-manager.js'
import { invalidatePlace } from './places.js'
import type { WsServerMessage } from './types.js'

type DiffResult = Extract<WsServerMessage, { type: 'diff_result' }>

let base: string
let sm: SessionManager

function git(args: string[], cwd: string): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore' })
}

function repo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  git(['init', '-q', '-b', 'main'], dir)
  writeFileSync(join(dir, 'README.md'), '# r\n')
  git(['add', '.'], dir)
  git(['commit', '-q', '-m', 'init'], dir)
  return dir
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'codekin-attdiff-')))
  sm = new SessionManager()
  invalidatePlace()
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('Changes for attached folders', () => {
  it('diffs and discards in an attached repository, and counts its uncommitted files', async () => {
    const own = repo(join(base, 'own'))
    const other = repo(join(base, 'other'))
    const s = sm.create('t', own)
    s.addDirs = [other]
    writeFileSync(join(other, 'README.md'), '# r\nchanged\n')
    writeFileSync(join(own, 'README.md'), '# r\nmine\n')

    const result = await sm.getDiff(s.id, 'all', other) as DiffResult
    expect(result.type).toBe('diff_result')
    expect(result.files.map(f => f.path)).toEqual(['README.md'])
    expect(result.files[0].hunks.flatMap(h => h.lines.map(l => l.content))).toContain('changed')

    expect((await sm.getChangeSummary(s.id))?.uncommittedFiles).toBe(2)

    await sm.discardChanges(s.id, 'all', ['README.md'], undefined, other)
    expect(readFileSync(join(other, 'README.md'), 'utf-8')).toBe('# r\n')
    expect(readFileSync(join(own, 'README.md'), 'utf-8')).toBe('# r\nmine\n')
  })

  it('refuses a folder that is not attached, or not a repository', async () => {
    const own = repo(join(base, 'own'))
    const plain = join(base, 'plain')
    mkdirSync(plain)
    const s = sm.create('t', own)
    s.addDirs = [plain]
    expect(await sm.getDiff(s.id, 'all', join(base, 'elsewhere'))).toMatchObject({ type: 'diff_error', message: /not attached/ })
    expect(await sm.getDiff(s.id, 'all', plain)).toMatchObject({ type: 'diff_error', message: /not a git repository/ })
    expect(await sm.discardChanges(s.id, 'all', ['x'], undefined, join(base, 'elsewhere'))).toMatchObject({ type: 'diff_error' })
    // A non-git attached folder adds nothing to the count.
    expect((await sm.getChangeSummary(s.id))?.uncommittedFiles).toBe(0)
  })
})
