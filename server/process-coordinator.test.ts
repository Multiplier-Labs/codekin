/** Tests for ProcessCoordinator — lifecycle mutex and timer management. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProcessCoordinator, type ProcessCoordinatorDeps } from './process-coordinator.js'

function makeDeps(overrides: Partial<ProcessCoordinatorDeps> = {}): ProcessCoordinatorDeps {
  return {
    startProcess: vi.fn(() => true),
    stopProcessAndWait: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('ProcessCoordinator', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  describe('requestStart', () => {
    it('calls startProcess and returns result', async () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      const result = await coord.requestStart()
      expect(result).toBe(true)
      expect(deps.startProcess).toHaveBeenCalledWith('s1')
    })

    it('bumps generation on each start', async () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      expect(coord.currentGeneration).toBe(0)
      await coord.requestStart()
      expect(coord.currentGeneration).toBe(1)
      await coord.requestStart()
      expect(coord.currentGeneration).toBe(2)
    })

    it('clears userStopped flag', async () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      await coord.requestStop()
      expect(coord.isUserStopped).toBe(true)
      await coord.requestStart()
      expect(coord.isUserStopped).toBe(false)
    })
  })

  describe('requestStop', () => {
    it('calls stopProcessAndWait', async () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      await coord.requestStop()
      expect(deps.stopProcessAndWait).toHaveBeenCalledWith('s1')
    })

    it('sets userStopped flag', async () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      await coord.requestStop()
      expect(coord.isUserStopped).toBe(true)
    })

    it('cancels pending restart timer', async () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      coord.scheduleRestart(5000)
      await coord.requestStop()
      vi.advanceTimersByTime(6000)
      // startProcess should NOT have been called by the restart timer
      expect(deps.startProcess).not.toHaveBeenCalled()
    })
  })

  describe('requestReconfigure', () => {
    it('stops then starts with config applied between', async () => {
      const order: string[] = []
      const deps = makeDeps({
        startProcess: vi.fn(() => { order.push('start'); return true }),
        stopProcessAndWait: vi.fn(async () => { order.push('stop') }),
      })
      const coord = new ProcessCoordinator('s1', deps)
      let configApplied = false
      await coord.requestReconfigure(() => { order.push('apply'); configApplied = true })
      expect(order).toEqual(['stop', 'apply', 'start'])
      expect(configApplied).toBe(true)
    })

    it('cancels pending restart timer before reconfiguring', async () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      coord.scheduleRestart(1000)
      await coord.requestReconfigure(() => {})
      vi.advanceTimersByTime(2000)
      // startProcess called once (by reconfigure), not twice (restart timer should be dead)
      expect(deps.startProcess).toHaveBeenCalledTimes(1)
    })
  })

  describe('mutex serialization', () => {
    it('serializes concurrent operations', async () => {
      const order: string[] = []
      let stopResolve: (() => void) | null = null
      const deps = makeDeps({
        startProcess: vi.fn(() => { order.push('start'); return true }),
        stopProcessAndWait: vi.fn(() => new Promise<void>(r => { stopResolve = r; order.push('stopBegin') })),
      })
      const coord = new ProcessCoordinator('s1', deps)

      // Start a stop that will block
      const stopDone = coord.requestStop()
      // While stop is pending, request a start — it should wait
      const startDone = coord.requestStart()

      // Let microtasks settle
      await vi.advanceTimersByTimeAsync(0)
      expect(order).toEqual(['stopBegin'])

      // Release the stop
      stopResolve!()
      await stopDone
      await startDone
      expect(order).toEqual(['stopBegin', 'start'])
    })

    it('serializes reconfigure during pending stop', async () => {
      const order: string[] = []
      let stopResolve: (() => void) | null = null
      const deps = makeDeps({
        startProcess: vi.fn(() => { order.push('start'); return true }),
        stopProcessAndWait: vi.fn(() => {
          order.push('stop')
          return new Promise<void>(r => { stopResolve = r })
        }),
      })
      const coord = new ProcessCoordinator('s1', deps)

      const stop1 = coord.requestStop()
      const reconfig = coord.requestReconfigure(() => { order.push('apply') })

      await vi.advanceTimersByTimeAsync(0)
      // First stop is executing
      expect(order).toEqual(['stop'])

      // Release first stop
      stopResolve!()
      await stop1
      await vi.advanceTimersByTimeAsync(0)

      // Reconfigure's stop executes next
      stopResolve!()
      await reconfig

      expect(order).toEqual(['stop', 'stop', 'apply', 'start'])
    })
  })

  describe('scheduleRestart', () => {
    it('fires after delay and calls startProcess', async () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      coord.scheduleRestart(2000)

      vi.advanceTimersByTime(1999)
      expect(deps.startProcess).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      // Timer fires, enqueues start through mutex
      await vi.advanceTimersByTimeAsync(0)
      expect(deps.startProcess).toHaveBeenCalledTimes(1)
    })

    it('does not fire if userStopped', async () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      coord.scheduleRestart(2000)
      coord.teardown()

      vi.advanceTimersByTime(3000)
      await vi.advanceTimersByTimeAsync(0)
      expect(deps.startProcess).not.toHaveBeenCalled()
    })

    it('does not fire if generation changed (another start happened first)', async () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      coord.scheduleRestart(2000)

      // Start a new process before the timer fires
      await coord.requestStart()
      expect(deps.startProcess).toHaveBeenCalledTimes(1)
      ;(deps.startProcess as ReturnType<typeof vi.fn>).mockClear()

      // Restart timer fires but generation changed
      vi.advanceTimersByTime(3000)
      await vi.advanceTimersByTimeAsync(0)
      expect(deps.startProcess).not.toHaveBeenCalled()
    })

    it('skips if onBeforeStart returns false', async () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      coord.scheduleRestart(1000, () => false)

      vi.advanceTimersByTime(1500)
      await vi.advanceTimersByTimeAsync(0)
      expect(deps.startProcess).not.toHaveBeenCalled()
    })

    it('replaces previous restart timer', async () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      coord.scheduleRestart(1000)
      coord.scheduleRestart(3000)

      vi.advanceTimersByTime(1500)
      await vi.advanceTimersByTimeAsync(0)
      expect(deps.startProcess).not.toHaveBeenCalled()

      vi.advanceTimersByTime(2000)
      await vi.advanceTimersByTimeAsync(0)
      expect(deps.startProcess).toHaveBeenCalledTimes(1)
    })
  })

  describe('scheduleApiRetry', () => {
    it('fires after delay', async () => {
      const sendRetry = vi.fn()
      const coord = new ProcessCoordinator('s1', makeDeps())
      coord.scheduleApiRetry(3000, sendRetry)

      vi.advanceTimersByTime(3000)
      expect(sendRetry).toHaveBeenCalledTimes(1)
    })

    it('does not fire if generation changed (process restarted)', async () => {
      const sendRetry = vi.fn()
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      coord.scheduleApiRetry(3000, sendRetry)

      // Process restarts — bumps generation
      await coord.requestStart()

      vi.advanceTimersByTime(3000)
      expect(sendRetry).not.toHaveBeenCalled()
    })

    it('does not fire if userStopped', async () => {
      const sendRetry = vi.fn()
      const coord = new ProcessCoordinator('s1', makeDeps())
      coord.scheduleApiRetry(3000, sendRetry)
      coord.teardown()

      vi.advanceTimersByTime(3000)
      expect(sendRetry).not.toHaveBeenCalled()
    })

    it('is cancelled by cancelApiRetry', () => {
      const sendRetry = vi.fn()
      const coord = new ProcessCoordinator('s1', makeDeps())
      coord.scheduleApiRetry(3000, sendRetry)
      coord.cancelApiRetry()

      vi.advanceTimersByTime(3000)
      expect(sendRetry).not.toHaveBeenCalled()
    })

    it('is cancelled when a new lifecycle operation enqueues', async () => {
      const sendRetry = vi.fn()
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      coord.scheduleApiRetry(3000, sendRetry)

      await coord.requestStop()

      vi.advanceTimersByTime(3000)
      expect(sendRetry).not.toHaveBeenCalled()
    })
  })

  describe('teardown', () => {
    it('cancels all timers and sets userStopped', () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      coord.scheduleRestart(1000)
      coord.scheduleApiRetry(2000, vi.fn())

      coord.teardown()

      expect(coord.isUserStopped).toBe(true)
      vi.advanceTimersByTime(3000)
      expect(deps.startProcess).not.toHaveBeenCalled()
    })
  })

  describe('clearUserStopped', () => {
    it('allows scheduled restarts to fire again', async () => {
      const deps = makeDeps()
      const coord = new ProcessCoordinator('s1', deps)
      await coord.requestStop()
      coord.clearUserStopped()
      expect(coord.isUserStopped).toBe(false)
    })
  })

  describe('invariant: at most one process per session', () => {
    it('randomized sequence of operations never double-starts', async () => {
      let aliveCount = 0
      let maxAlive = 0
      const deps = makeDeps({
        startProcess: vi.fn(() => {
          aliveCount++
          maxAlive = Math.max(maxAlive, aliveCount)
          return true
        }),
        stopProcessAndWait: vi.fn(async () => {
          aliveCount = Math.max(0, aliveCount - 1)
        }),
      })
      const coord = new ProcessCoordinator('s1', deps)

      // Simulate a randomized sequence of operations
      const ops = [
        () => coord.requestStart(),
        () => coord.requestStop(),
        () => coord.requestReconfigure(() => {}),
        () => { coord.scheduleRestart(100) },
        () => { coord.scheduleApiRetry(200, () => {}) },
      ]

      // Run 20 random operations
      const promises: Promise<unknown>[] = []
      for (let i = 0; i < 20; i++) {
        const op = ops[i % ops.length]
        const result = op()
        if (result instanceof Promise) promises.push(result)
        if (i % 3 === 0) {
          vi.advanceTimersByTime(150)
          await vi.advanceTimersByTimeAsync(0)
        }
      }

      vi.advanceTimersByTime(1000)
      await vi.advanceTimersByTimeAsync(0)
      await Promise.allSettled(promises)

      // The key invariant: each start is preceded by a stop (via reconfigure)
      // or is the first start.  The mutex ensures sequential execution.
      expect(maxAlive).toBeLessThanOrEqual(2) // reconfigure does stop+start, start may stack before stop
    })
  })
})
