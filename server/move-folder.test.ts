/** Moving a scratch folder: where it may go, and the move itself. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

const mockHomedir = vi.hoisted(() => vi.fn(() => '/tmp/placeholder'))
const mockReposRoot = vi.hoisted(() => ({ value: '/tmp/placeholder-repos' }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: mockHomedir }
})
vi.mock('./config.js', () => ({
  get REPOS_ROOT() { return mockReposRoot.value },
}))

import { moveDir, validateMoveTarget } from './move-folder.js'
import { configureScratchRoot } from './places.js'

let BASE: string, HOME: string, SCRATCH: string, SOURCE: string

beforeEach(() => {
  BASE = join(realpathSync(tmpdir()), 'codekin-move-' + randomUUID())
  HOME = join(BASE, 'home')
  SCRATCH = join(HOME, 'codekin', 'scratch')
  SOURCE = join(SCRATCH, 'brisk-otter')
  mkdirSync(SOURCE, { recursive: true })
  mkdirSync(join(BASE, 'repos'))
  mockHomedir.mockReturnValue(HOME)
  mockReposRoot.value = join(BASE, 'repos')
  configureScratchRoot('')
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

describe('validateMoveTarget', () => {
  it('moves into a folder under home, keeping the name', () => {
    mkdirSync(join(HOME, 'projects'))
    expect(validateMoveTarget(join(HOME, 'projects'), SOURCE)).toEqual({ ok: true, target: join(HOME, 'projects', 'brisk-otter') })
    expect(validateMoveTarget('~/projects', SOURCE)).toEqual({ ok: true, target: join(HOME, 'projects', 'brisk-otter') })
  })

  it('refuses missing, outside, scratch and taken targets', () => {
    expect(validateMoveTarget('', SOURCE).ok).toBe(false)
    expect(validateMoveTarget(join(HOME, 'nope'), SOURCE)).toMatchObject({ ok: false, error: /does not exist/ })
    mkdirSync(join(BASE, 'outside'))
    expect(validateMoveTarget(join(BASE, 'outside'), SOURCE)).toMatchObject({ ok: false, error: /home directory/ })
    expect(validateMoveTarget(SCRATCH, SOURCE)).toMatchObject({ ok: false, error: /outside the scratch/ })
    mkdirSync(join(HOME, 'projects', 'brisk-otter'), { recursive: true })
    expect(validateMoveTarget(join(HOME, 'projects'), SOURCE)).toMatchObject({ ok: false, error: /already exists/ })
  })
})

describe('moveDir', () => {
  it('moves the folder with its contents', () => {
    writeFileSync(join(SOURCE, 'a.txt'), 'kept')
    const target = join(HOME, 'brisk-otter')
    moveDir(SOURCE, target)
    expect(existsSync(SOURCE)).toBe(false)
    expect(readFileSync(join(target, 'a.txt'), 'utf-8')).toBe('kept')
  })
})
