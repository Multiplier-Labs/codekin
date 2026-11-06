/** Tests for the native macOS folder dialog: locality gate and osascript handling. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const mockHomedir = vi.hoisted(() => vi.fn(() => '/tmp/placeholder-home'))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: mockHomedir }
})

import {
  isNativeFolderPickerAvailable,
  isFolderDialogOpen,
  pickFolderNative,
  resolveDefaultLocation,
} from './native-folder-picker.js'

const local = (headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') => ({ socket: { remoteAddress }, headers })

describe('isNativeFolderPickerAvailable', () => {
  it('allows loopback callers on macOS', () => {
    expect(isNativeFolderPickerAvailable(local(), 'darwin')).toBe(true)
    expect(isNativeFolderPickerAvailable(local({}, '::1'), 'darwin')).toBe(true)
    expect(isNativeFolderPickerAvailable(local({}, '::ffff:127.0.0.1'), 'darwin')).toBe(true)
  })

  it('refuses other platforms', () => {
    expect(isNativeFolderPickerAvailable(local(), 'linux')).toBe(false)
    expect(isNativeFolderPickerAvailable(local(), 'win32')).toBe(false)
  })

  it('refuses non-loopback callers', () => {
    expect(isNativeFolderPickerAvailable(local({}, '192.168.1.20'), 'darwin')).toBe(false)
    expect(isNativeFolderPickerAvailable(local({}, '100.64.0.3'), 'darwin')).toBe(false)
    expect(isNativeFolderPickerAvailable({ socket: {}, headers: {} }, 'darwin')).toBe(false)
  })

  it('refuses proxied requests even from loopback', () => {
    expect(isNativeFolderPickerAvailable(local({ 'x-forwarded-for': '203.0.113.9' }), 'darwin')).toBe(false)
  })
})

describe('pickFolderNative', () => {
  let home: string

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'nfp-home-')))
    mockHomedir.mockReturnValue(home)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  type Cb = (error: (Error & { code?: number }) | null, stdout: string, stderr: string) => void
  const execReturning = (error: (Error & { code?: number }) | null, stdout: string, stderr = '') =>
    vi.fn((_file: string, _args: string[], _opts: { timeout: number }, cb: Cb) => { cb(error, stdout, stderr) })

  it('returns the chosen path without a trailing slash', async () => {
    const exec = execReturning(null, '/Users/me/repos/\n')
    await expect(pickFolderNative(undefined, exec)).resolves.toBe('/Users/me/repos')
  })

  it('keeps the root path intact', async () => {
    const exec = execReturning(null, '/\n')
    await expect(pickFolderNative(undefined, exec)).resolves.toBe('/')
  })

  it('returns null when the user cancels', async () => {
    const err = Object.assign(new Error('Command failed'), { code: 1 })
    const exec = execReturning(err, '', 'execution error: Error: Error: User canceled. (-128)')
    await expect(pickFolderNative(undefined, exec)).resolves.toBeNull()
  })

  it('recognises a cancel in any system language', async () => {
    const err = Object.assign(new Error('Command failed'), { code: 1 })
    const exec = execReturning(err, '', 'execution error: Error: Error: Von Benutzer:in abgebrochen. (-128)')
    await expect(pickFolderNative(undefined, exec)).resolves.toBeNull()
  })

  it('runs the script as JavaScript for Automation', async () => {
    const exec = execReturning(null, '/x\n')
    await pickFolderNative(undefined, exec)
    const [, args] = exec.mock.calls[0]
    expect(args.slice(0, 2)).toEqual(['-l', 'JavaScript'])
  })

  it('rejects on other failures', async () => {
    const err = Object.assign(new Error('Command failed'), { code: 1 })
    const exec = execReturning(err, '', 'execution error: something broke (-1700)')
    await expect(pickFolderNative(undefined, exec)).rejects.toThrow('something broke')
  })

  it('passes the default location as an argv item, not as script text', async () => {
    const dir = join(home, 'code "quoted"')
    const { mkdirSync } = await import('fs')
    mkdirSync(dir)
    const exec = execReturning(null, `${dir}/\n`)
    await pickFolderNative(dir, exec)
    const [file, args] = exec.mock.calls[0]
    expect(file).toBe('osascript')
    expect(args[args.length - 1]).toBe(dir)
    const scriptLines = args.filter((_, i) => args[i - 1] === '-e')
    expect(scriptLines.some(l => l.includes(dir))).toBe(false)
  })

  it('clears the in-flight flag once the dialog closes', async () => {
    let finish: (() => void) | undefined
    const exec = vi.fn((_f: string, _a: string[], _o: { timeout: number }, cb: Cb) => { finish = () => { cb(null, '/x\n', '') } })
    const pending = pickFolderNative(undefined, exec)
    expect(isFolderDialogOpen()).toBe(true)
    finish?.()
    await pending
    expect(isFolderDialogOpen()).toBe(false)
  })

  it('clears the in-flight flag when osascript fails to launch synchronously', async () => {
    const exec = vi.fn(() => { throw new Error('spawn EAGAIN') })
    await expect(pickFolderNative(undefined, exec)).rejects.toThrow('spawn EAGAIN')
    expect(isFolderDialogOpen()).toBe(false)
  })
})

describe('resolveDefaultLocation', () => {
  let home: string

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'nfp-home-')))
    mockHomedir.mockReturnValue(home)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('uses an existing directory as-is', () => {
    expect(resolveDefaultLocation(home)).toBe(home)
  })

  it('expands ~', () => {
    expect(resolveDefaultLocation('~')).toBe(home)
  })

  it('falls back to home for missing, relative or empty paths', () => {
    expect(resolveDefaultLocation(join(home, 'nope'))).toBe(home)
    expect(resolveDefaultLocation('relative/dir')).toBe(home)
    expect(resolveDefaultLocation(undefined)).toBe(home)
    expect(resolveDefaultLocation('')).toBe(home)
  })
})
