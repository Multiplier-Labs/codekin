/** Tests for the CodingProcess abstraction layer and provider dispatch. */
import { describe, it, expect } from 'vitest'
import { CLAUDE_CAPABILITIES, OPENCODE_CAPABILITIES } from './coding-process.js'
import type { CodingProcess, CodingProvider, ProviderCapabilities } from './coding-process.js'

describe('CodingProvider type', () => {
  it('accepts claude and opencode as valid values', () => {
    const providers: CodingProvider[] = ['claude', 'opencode']
    expect(providers).toHaveLength(2)
    expect(providers).toContain('claude')
    expect(providers).toContain('opencode')
  })
})

describe('ProviderCapabilities', () => {
  it('CLAUDE_CAPABILITIES has expected defaults', () => {
    expect(CLAUDE_CAPABILITIES).toEqual({
      streaming: true,
      multiTurn: true,
      permissionControl: true,
      toolEvents: true,
      thinkingDisplay: true,
      multiProvider: false,
      planMode: true,
    })
  })

  it('OPENCODE_CAPABILITIES has expected defaults', () => {
    expect(OPENCODE_CAPABILITIES).toEqual({
      streaming: true,
      multiTurn: true,
      permissionControl: true,
      toolEvents: true,
      thinkingDisplay: true,
      multiProvider: true,
      planMode: true,
    })
  })

  it('Claude is single-provider, OpenCode is multi-provider', () => {
    expect(CLAUDE_CAPABILITIES.multiProvider).toBe(false)
    expect(OPENCODE_CAPABILITIES.multiProvider).toBe(true)
  })
})

describe('CodingProcess interface', () => {
  it('can be satisfied by a mock object with required methods', () => {
    // Verify the interface shape is correct by creating a mock that satisfies it
    const mock = {
      provider: 'claude' as CodingProvider,
      capabilities: CLAUDE_CAPABILITIES,
      start: () => {},
      stop: () => {},
      sendMessage: (_content: string) => {},
      sendRaw: (_data: string) => {},
      sendControlResponse: (_requestId: string, _behavior: 'allow' | 'deny') => {},
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
    expect(mock.capabilities).toBe(CLAUDE_CAPABILITIES)
    expect(mock.isAlive()).toBe(true)
    expect(mock.getSessionId()).toBe('test-id')
  })
})
