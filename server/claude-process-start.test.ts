/**
 * Tests for ClaudeProcess.start() — specifically the process event handlers
 * (error and close) that are registered when the child process is spawned.
 *
 * These require mocking child_process.spawn to avoid actually launching `claude`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

// Hoisted mock factory for child_process.spawn
const mockSpawn = vi.hoisted(() => vi.fn())
const mockExistsSync = vi.hoisted(() => vi.fn(() => true))
const mockRealpathSync = vi.hoisted(() => vi.fn((p: string) => p))

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: mockExistsSync, realpathSync: mockRealpathSync }
})

import { ClaudeProcess } from './claude-process.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CP = any

function makeFakeProc() {
  const proc = new EventEmitter() as CP
  // stdin is an EventEmitter so tests can deliver the async 'error' events
  // (EPIPE) that a real socket emits after the peer goes away.
  proc.stdin = Object.assign(new EventEmitter(), { writable: true, write: vi.fn(() => true) })
  proc.stdout = new PassThrough()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  return proc
}

describe('ClaudeProcess.start() — process event handlers', () => {
  let fakeProc: ReturnType<typeof makeFakeProc>

  beforeEach(() => {
    fakeProc = makeFakeProc()
    mockSpawn.mockReturnValue(fakeProc)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mockSpawn.mockReset()
  })

  it('calls spawn with "claude" when start() is invoked', () => {
    const cp = new ClaudeProcess('/tmp') as CP
    cp.start()
    expect(mockSpawn).toHaveBeenCalledWith('claude', expect.any(Array), expect.objectContaining({ cwd: '/tmp' }))
  })

  it('sets alive=true after start()', () => {
    const cp = new ClaudeProcess('/tmp') as CP
    cp.start()
    expect(cp.isAlive()).toBe(true)
  })

  it('is a no-op if start() is called when proc is already set', () => {
    const cp = new ClaudeProcess('/tmp') as CP
    cp.start()
    cp.start() // second call should be ignored
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  describe('process "error" event', () => {
    it('emits "error" event with the error message', () => {
      const cp = new ClaudeProcess('/tmp') as CP
      cp.start()

      const errors: string[] = []
      cp.on('error', (msg: string) => errors.push(msg))

      fakeProc.emit('error', new Error('ENOENT: claude not found'))

      expect(errors).toHaveLength(1)
      expect(errors[0]).toBe('ENOENT: claude not found')
    })

    it('logs the error to console.error', () => {
      const cp = new ClaudeProcess('/tmp') as CP
      cp.start()

      // Add an error listener to prevent the unhandled error throw
      cp.on('error', () => {})

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      fakeProc.emit('error', new Error('spawn error'))

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('spawn error'))
      consoleSpy.mockRestore()
    })
  })

  describe('process "close" event', () => {
    it('emits "exit" event with code and signal', () => {
      const cp = new ClaudeProcess('/tmp') as CP
      cp.start()

      const exits: Array<[number | null, string | null]> = []
      cp.on('exit', (code: number | null, signal: string | null) => exits.push([code, signal]))

      fakeProc.emit('close', 0, null)

      expect(exits).toHaveLength(1)
      expect(exits[0]).toEqual([0, null])
    })

    it('sets alive=false after close', () => {
      const cp = new ClaudeProcess('/tmp') as CP
      cp.start()
      expect(cp.isAlive()).toBe(true)

      fakeProc.emit('close', 0, null)

      expect(cp.isAlive()).toBe(false)
    })

    it('sets proc to null after close', () => {
      const cp = new ClaudeProcess('/tmp') as CP
      cp.start()

      fakeProc.emit('close', 1, null)

      expect(cp.proc).toBeNull()
    })

    it('clears tasks after close', () => {
      const cp = new ClaudeProcess('/tmp') as CP
      cp.start()

      // Simulate some tasks
      cp.tasks.set('t1', { id: 't1', subject: 'Do something', status: 'pending' })
      expect(cp.tasks.size).toBe(1)

      fakeProc.emit('close', 0, null)

      expect(cp.tasks.size).toBe(0)
    })

    it('passes non-zero exit code in the exit event', () => {
      const cp = new ClaudeProcess('/tmp') as CP
      cp.start()

      const exits: Array<[number | null, string | null]> = []
      cp.on('exit', (code: number | null, signal: string | null) => exits.push([code, signal]))

      fakeProc.emit('close', 1, 'SIGTERM')

      expect(exits[0]).toEqual([1, 'SIGTERM'])
    })
  })

  describe('process stderr', () => {
    it('emits "error" event when stderr produces data', () => {
      const cp = new ClaudeProcess('/tmp') as CP
      cp.start()

      const errors: string[] = []
      cp.on('error', (msg: string) => errors.push(msg))

      fakeProc.stderr.emit('data', Buffer.from('something went wrong'))

      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('[stderr]')
      expect(errors[0]).toContain('something went wrong')
    })

    it('does not emit "error" for empty stderr data', () => {
      const cp = new ClaudeProcess('/tmp') as CP
      cp.start()

      const errors: string[] = []
      cp.on('error', (msg: string) => errors.push(msg))

      fakeProc.stderr.emit('data', Buffer.from('   '))

      expect(errors).toHaveLength(0)
    })

    it('flags a resume whose conversation the CLI no longer has', () => {
      const gone = '0867baa2-cd6e-458e-bb3a-17150fb5ed9d'
      const cp = new ClaudeProcess('/tmp', { sessionId: gone, resume: true }) as CP
      cp.start()
      cp.on('error', () => { /* stderr is also surfaced to the session */ })
      expect(cp.hasResumeNotFound()).toBe(false)

      fakeProc.stderr.emit('data', Buffer.from(`No conversation found with session ID: ${gone}`))

      expect(cp.hasResumeNotFound()).toBe(true)
    })
  })

  describe('process stdin', () => {
    // EPIPE arrives as an async stream 'error' event, not a throw. Unlistened,
    // Node re-raises it as an uncaught exception and kills the server.
    it('absorbs an async EPIPE from stdin', () => {
      const cp = new ClaudeProcess('/tmp') as CP
      cp.start()

      const err = new Error('write EPIPE') as NodeJS.ErrnoException
      err.code = 'EPIPE'
      expect(fakeProc.stdin.listenerCount('error')).toBeGreaterThan(0)
      expect(() => fakeProc.stdin.emit('error', err)).not.toThrow()
    })
  })

  describe('start() with missing working directory', () => {
    it('emits error and exit without spawning when workingDir does not exist', async () => {
      mockExistsSync.mockReturnValue(false)
      const cp = new ClaudeProcess('/nonexistent/path') as CP

      const errors: string[] = []
      const exits: Array<[number | null, string | null]> = []
      cp.on('error', (msg: string) => errors.push(msg))
      cp.on('exit', (code: number | null, signal: string | null) => exits.push([code, signal]))

      cp.start()

      expect(mockSpawn).not.toHaveBeenCalled()
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('Working directory does not exist')
      expect(errors[0]).toContain('/nonexistent/path')

      // exit is emitted via process.nextTick
      await new Promise(r => process.nextTick(r))
      expect(exits).toHaveLength(1)
      expect(exits[0]).toEqual([1, null])
    })

    it('sets hasSpawnFailed() to true when workingDir missing', () => {
      mockExistsSync.mockReturnValue(false)
      const cp = new ClaudeProcess('/nonexistent/path') as CP
      cp.on('error', () => {}) // prevent unhandled error

      cp.start()

      expect(cp.hasSpawnFailed()).toBe(true)
    })

    it('does not set alive when workingDir missing', () => {
      mockExistsSync.mockReturnValue(false)
      const cp = new ClaudeProcess('/nonexistent/path') as CP
      cp.on('error', () => {})

      cp.start()

      expect(cp.isAlive()).toBe(false)
    })
  })

  describe('process "error" event with ENOENT/EACCES', () => {
    it('sets hasSpawnFailed() on ENOENT error', () => {
      mockExistsSync.mockReturnValue(true)
      const cp = new ClaudeProcess('/tmp') as CP
      cp.start()
      cp.on('error', () => {})

      const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      fakeProc.emit('error', err)

      expect(cp.hasSpawnFailed()).toBe(true)
    })

    it('sets hasSpawnFailed() on EACCES error', () => {
      mockExistsSync.mockReturnValue(true)
      const cp = new ClaudeProcess('/tmp') as CP
      cp.start()
      cp.on('error', () => {})

      const err = new Error('spawn claude EACCES') as NodeJS.ErrnoException
      err.code = 'EACCES'
      fakeProc.emit('error', err)

      expect(cp.hasSpawnFailed()).toBe(true)
    })

    it('does not set hasSpawnFailed() for other error codes', () => {
      mockExistsSync.mockReturnValue(true)
      const cp = new ClaudeProcess('/tmp') as CP
      cp.start()
      cp.on('error', () => {})

      const err = new Error('some other error') as NodeJS.ErrnoException
      err.code = 'EPIPE'
      fakeProc.emit('error', err)

      expect(cp.hasSpawnFailed()).toBe(false)
    })
  })
})
