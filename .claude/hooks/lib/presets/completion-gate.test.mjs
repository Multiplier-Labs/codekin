import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { completionGate } from './completion-gate.mjs';
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

describe('completionGate preset', () => {
  const baseInput = {
    session_id: 'test-session',
    cwd: '/srv/repos/project',
    last_assistant_message: 'Done.',
  };

  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(execSync).mockReset();
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(unlinkSync).mockReset();
  });

  it('allows stop when tests pass', async () => {
    const handler = completionGate();
    vi.mocked(execSync).mockReturnValue('All tests passed');

    const result = await handler(baseInput, {
      git: { dirty: false, status: null },
      project: { hasTest: true, hasBuild: false },
    });

    expect(result).toBeUndefined();
  });

  it('blocks stop when tests fail', async () => {
    const handler = completionGate();
    vi.mocked(execSync).mockImplementation(() => {
      const err = new Error('test failed');
      err.stdout = 'FAIL src/App.test.ts\n  Expected: true\n  Received: false';
      throw err;
    });

    const result = await handler(baseInput, {
      git: { dirty: false, status: null },
      project: { hasTest: true, hasBuild: false },
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('Tests are failing');
  });

  it('blocks on uncommitted changes when commit was mentioned', async () => {
    const handler = completionGate();
    const input = { ...baseInput, last_assistant_message: "I'll commit and push now" };

    const result = await handler(input, {
      git: { dirty: true, status: 'M src/App.tsx' },
      project: { hasTest: false },
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('Uncommitted changes');
  });

  it('does not block on uncommitted changes when no commit mentioned', async () => {
    const handler = completionGate();

    const result = await handler(baseInput, {
      git: { dirty: true, status: 'M src/App.tsx' },
      project: { hasTest: false },
    });

    expect(result).toBeUndefined();
  });

  it('skips when sentinel exists (infinite loop prevention)', async () => {
    const handler = completionGate();
    vi.mocked(existsSync).mockReturnValue(true);

    const result = await handler(baseInput, {
      git: { dirty: true, status: 'M src/App.tsx' },
      project: { hasTest: true },
    });

    expect(result).toBeUndefined();
    expect(unlinkSync).toHaveBeenCalled();
  });

  it('writes sentinel when blocking', async () => {
    const handler = completionGate();
    vi.mocked(execSync).mockImplementation(() => {
      const err = new Error('test failed');
      err.stdout = 'FAIL';
      throw err;
    });

    await handler(baseInput, {
      git: { dirty: false },
      project: { hasTest: true },
    });

    expect(writeFileSync).toHaveBeenCalledWith(
      '/tmp/.claude-stop-guard-test-session',
      expect.any(String),
    );
  });

  it('skips tests when project has no test script', async () => {
    const handler = completionGate();

    const result = await handler(baseInput, {
      git: { dirty: false },
      project: { hasTest: false },
    });

    expect(result).toBeUndefined();
    expect(execSync).not.toHaveBeenCalled();
  });

  it('respects stop_hook_active flag', async () => {
    const handler = completionGate();
    const input = { ...baseInput, stop_hook_active: true };

    const result = await handler(input, {
      git: { dirty: true, status: 'M file' },
      project: { hasTest: true },
    });

    expect(result).toBeUndefined();
  });

  it('runs build when configured', async () => {
    const handler = completionGate({ runBuild: true });
    vi.mocked(execSync).mockImplementation((cmd) => {
      if (cmd === 'npm run build') {
        const err = new Error('build failed');
        err.stdout = 'ERROR: Cannot resolve module';
        throw err;
      }
      return '';
    });

    const result = await handler(baseInput, {
      git: { dirty: false },
      project: { hasTest: true, hasBuild: true },
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('Build is broken');
  });
});
