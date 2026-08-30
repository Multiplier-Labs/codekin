/** Tests for OrchestratorMonitor lifecycle — engine-driven tick registration vs legacy intervals. */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/monitor-test-data',
  REPOS_ROOT: '/nonexistent-monitor-test-root',
  AGENT_DISPLAY_NAME: 'TestAgent',
  getAgentDisplayName: () => 'TestAgent',
}))

import { OrchestratorMonitor } from './orchestrator-monitor.js'
import type { SessionManager } from './session-manager.js'
import type { WorkflowEngine } from './workflow-engine.js'

function makeSessions(): SessionManager {
  return { isRateLimited: vi.fn(() => false) } as unknown as SessionManager
}

function makeEngine() {
  return {
    on: vi.fn(),
    registerTickTask: vi.fn(),
    unregisterTickTask: vi.fn(),
    getEngineHealth: vi.fn(() => ({ lastTickAt: null, tickCount: 0 })),
  } as unknown as WorkflowEngine
}

describe('OrchestratorMonitor lifecycle', () => {
  let monitor: OrchestratorMonitor

  afterEach(() => {
    monitor.stop()
    vi.useRealTimers()
  })

  it('registers poll and aging as engine tick tasks when an engine is attached', () => {
    monitor = new OrchestratorMonitor(makeSessions())
    const engine = makeEngine()
    monitor.setEngine(engine)

    monitor.start()

    expect(engine.registerTickTask).toHaveBeenCalledWith('orchestrator-poll', 15 * 60 * 1000, expect.any(Function))
    expect(engine.registerTickTask).toHaveBeenCalledWith('orchestrator-aging', 6 * 60 * 60 * 1000, expect.any(Function))

    // Idempotent start — no duplicate registrations.
    monitor.start()
    expect(engine.registerTickTask).toHaveBeenCalledTimes(2)

    monitor.stop()
    expect(engine.unregisterTickTask).toHaveBeenCalledWith('orchestrator-poll')
    expect(engine.unregisterTickTask).toHaveBeenCalledWith('orchestrator-aging')
  })

  it('falls back to setInterval without an engine', () => {
    vi.useFakeTimers()
    monitor = new OrchestratorMonitor(makeSessions())

    monitor.start()
    // No engine attached — nothing to assert against but absence of throw;
    // stop() must clear the intervals so fake timers drain cleanly.
    monitor.stop()
    vi.advanceTimersByTime(20 * 60 * 1000)
  })
})
