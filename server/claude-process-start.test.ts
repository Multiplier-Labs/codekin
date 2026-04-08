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

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}))

import { ClaudeProcess } from './claude-process.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CP = any

function makeFakeProc() {
  const proc = new EventEmitter() as CP
  proc.stdin = { writable: true, write: vi.fn(() => true), once: vi.fn() }
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
  })
})
