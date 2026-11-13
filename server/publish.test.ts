/** Publish to GitHub: input checks, and the git steps against a real folder (gh faked). */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { publishFolder, validatePublishInput, type Runner } from './publish.js'

const execFileAsync = promisify(execFile)
let dir: string

beforeAll(() => {
  // Commits need an identity; CI machines may have none configured.
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  })
})
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'codekin-publish-'))) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** Real git; gh recorded and answered with a URL. */
function runner(ghCalls: string[][], ghFails?: string): Runner {
  return async (cmd, args, opts) => {
    if (cmd === 'gh') {
      ghCalls.push(args)
      if (ghFails) throw Object.assign(new Error('gh failed'), { stderr: ghFails })
      return { stdout: `https://github.com/${args[2]}\n` }
    }
    const { stdout } = await execFileAsync(cmd, args, { cwd: opts.cwd })
    return { stdout }
  }
}

describe('validatePublishInput', () => {
  it('accepts an owner, a repo name and a visibility (private by default)', () => {
    expect(validatePublishInput({ owner: 'acme-co', name: 'bank-csv' })).toEqual({ ok: true, input: { owner: 'acme-co', name: 'bank-csv', visibility: 'private' } })
    expect(validatePublishInput({ owner: 'sam', name: 'a.b_c', visibility: 'public' })).toMatchObject({ ok: true, input: { visibility: 'public' } })
  })

  it('refuses bad owners and names', () => {
    for (const body of [{}, { owner: '-x', name: 'a' }, { owner: 'sam', name: '' }, { owner: 'sam', name: '..' }, { owner: 'sam', name: 'a/b' }, { owner: 'sam', name: 'x.git' }]) {
      expect(validatePublishInput(body).ok).toBe(false)
    }
  })
})

describe('publishFolder', () => {
  it('inits, commits everything and creates the repository from the folder', async () => {
    writeFileSync(join(dir, 'categorise.py'), 'print(1)\n')
    const gh: string[][] = []
    const { url } = await publishFolder(dir, { owner: 'sam', name: 'bank-csv', visibility: 'private' }, runner(gh))
    expect(url).toBe('https://github.com/sam/bank-csv')
    expect(gh).toEqual([['repo', 'create', 'sam/bank-csv', '--private', '--source', '.', '--remote', 'origin', '--push']])
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf-8' }).trim()).toBe('Initial commit')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' }).trim()).toBe('')
  })

  it('refuses an empty folder and one that already has an origin', async () => {
    const gh: string[][] = []
    await expect(publishFolder(dir, { owner: 'sam', name: 'x', visibility: 'private' }, runner(gh))).rejects.toThrow(/empty/)
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/x.git'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    await expect(publishFolder(dir, { owner: 'sam', name: 'x', visibility: 'private' }, runner(gh))).rejects.toThrow(/already has a remote/)
    expect(gh).toEqual([])
  })

  it('reports what gh said', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    await expect(publishFolder(dir, { owner: 'sam', name: 'x', visibility: 'public' }, runner([], 'Name already exists on this account')))
      .rejects.toThrow('gh repo create failed: Name already exists on this account')
  })
})
