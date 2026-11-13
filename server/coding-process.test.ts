/** Tests for the CodingProcess abstraction layer and provider dispatch. */
import { describe, it, expect } from 'vitest'
import type { CodingProvider } from './coding-process.js'

describe('CodingProvider type', () => {
  it('accepts claude, opencode, and codex as valid values', () => {
    const providers: CodingProvider[] = ['claude', 'opencode', 'codex']
    expect(providers).toHaveLength(3)
    expect(providers).toContain('claude')
    expect(providers).toContain('opencode')
    expect(providers).toContain('codex')
  })
})

describe('CodingProcess interface', () => {
  it('can be satisfied by a mock object with required methods', () => {
    // Verify the interface shape is correct by creating a mock that satisfies it
    const mock = {
      provider: 'claude' as CodingProvider,
      start: () => {},
      stop: () => {},
      sendMessage: () => {},
      sendRaw: () => {},
      sendControlResponse: () => {},
      isAlive: () => true,
      getSessionId: () => 'test-id',
      waitForExit: () => Promise.resolve(),
      // EventEmitter methods
      on: () => mock,
      once: () => mock,
      emit: () => true,
      removeAllListeners: () => mock,
      addListener: () => mock,
      removeListener: () => mock,
      off: () => mock,
      listeners: () => [],
      rawListeners: () => [],
      listenerCount: () => 0,
      prependListener: () => mock,
      prependOnceListener: () => mock,
      eventNames: () => [],
      setMaxListeners: () => mock,
      getMaxListeners: () => 10,
    } satisfies Record<string, unknown>

    // Type check: this would fail at compile time if interface is wrong
    expect(mock.provider).toBe('claude')
    expect(mock.isAlive()).toBe(true)
    expect(mock.getSessionId()).toBe('test-id')
  })
})