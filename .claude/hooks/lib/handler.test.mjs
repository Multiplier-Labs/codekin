import { describe, it, expect, vi } from 'vitest';
import { createHook } from './handler.mjs';

class MockTransport {
  constructor(input) {
    this.input = input;
    this.output = null;
    this.error = null;
  }
  async readInput() { return this.input; }
  writeOutput(o) { this.output = o; }
  writeError(m) { this.error = m; }
}

describe('createHook', () => {
  it('reads input and calls handler', async () => {
    const input = { hook_event_name: 'PostToolUse', session_id: 'test-1', cwd: '/tmp' };
    const transport = new MockTransport(input);
    const handler = vi.fn().mockResolvedValue(null);

    await createHook({ transport, handler });

    expect(handler).toHaveBeenCalledWith(input, {});
  });

  it('writes handler output to transport', async () => {
    const input = { hook_event_name: 'PostToolUse', session_id: 'test-1', cwd: '/tmp' };
    const transport = new MockTransport(input);
    const output = { decision: 'block', reason: 'test error' };
    const handler = vi.fn().mockResolvedValue(output);

    await createHook({ transport, handler });

    expect(transport.output).toEqual(output);
  });

  it('does not write when handler returns nothing', async () => {
    const input = { hook_event_name: 'PostToolUse', session_id: 'test-1', cwd: '/tmp' };
    const transport = new MockTransport(input);
    const handler = vi.fn().mockResolvedValue(undefined);

    await createHook({ transport, handler });

    expect(transport.output).toBeNull();
  });

  it('gathers context from providers', async () => {
    const input = { hook_event_name: 'SessionStart', session_id: 'test-1', cwd: '/tmp' };
    const transport = new MockTransport(input);
    const provider = { name: 'test', gather: vi.fn().mockResolvedValue({ foo: 'bar' }) };
    const handler = vi.fn().mockResolvedValue(null);

    await createHook({ transport, context: [provider], handler });

    expect(provider.gather).toHaveBeenCalledWith(input);
    expect(handler).toHaveBeenCalledWith(input, { test: { foo: 'bar' } });
  });

  it('gathers from multiple providers', async () => {
    const input = { hook_event_name: 'SessionStart', session_id: 'test-1', cwd: '/tmp' };
    const transport = new MockTransport(input);
    const p1 = { name: 'git', gather: vi.fn().mockResolvedValue({ branch: 'main' }) };
    const p2 = { name: 'env', gather: vi.fn().mockResolvedValue({ sessionId: 'test-1' }) };
    const handler = vi.fn().mockResolvedValue(null);

    await createHook({ transport, context: [p1, p2], handler });

    expect(handler).toHaveBeenCalledWith(input, {
      git: { branch: 'main' },
      env: { sessionId: 'test-1' },
    });
  });
});
