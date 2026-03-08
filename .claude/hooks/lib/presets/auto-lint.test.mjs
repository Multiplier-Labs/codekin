import { describe, it, expect, vi, beforeEach } from 'vitest';
import { autoLint } from './auto-lint.mjs';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('autoLint preset', () => {
  const handler = autoLint();

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('skips non-lintable files', async () => {
    const result = await handler({
      tool_input: { file_path: 'image.png' },
      cwd: '/tmp',
    });
    expect(result).toBeUndefined();
  });

  it('skips when no file_path', async () => {
    const result = await handler({
      tool_input: {},
      cwd: '/tmp',
    });
    expect(result).toBeUndefined();
  });

  it('returns nothing on clean lint', async () => {
    vi.mocked(execFileSync).mockReturnValue('');

    const result = await handler({
      tool_input: { file_path: 'src/App.tsx' },
      cwd: '/srv/repos/project',
    });
    expect(result).toBeUndefined();
  });

  it('blocks on eslint errors', async () => {
    const eslintOutput = JSON.stringify([{
      filePath: 'src/App.tsx',
      messages: [
        { severity: 2, line: 10, message: "'foo' is unused", ruleId: 'no-unused-vars' },
      ],
    }]);

    vi.mocked(execFileSync).mockImplementation(() => {
      const err = new Error('ESLint failed');
      err.stdout = eslintOutput;
      throw err;
    });

    const result = await handler({
      tool_input: { file_path: 'src/App.tsx' },
      cwd: '/srv/repos/project',
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain("'foo' is unused");
    expect(result.reason).toContain('no-unused-vars');
  });

  it('returns warnings as non-blocking context', async () => {
    const eslintOutput = JSON.stringify([{
      filePath: 'src/App.tsx',
      messages: [
        { severity: 1, line: 5, message: 'Unexpected console statement', ruleId: 'no-console' },
      ],
    }]);

    vi.mocked(execFileSync).mockImplementation(() => {
      const err = new Error('ESLint failed');
      err.stdout = eslintOutput;
      throw err;
    });

    const result = await handler({
      tool_input: { file_path: 'src/App.tsx' },
      cwd: '/srv/repos/project',
    });

    expect(result.decision).toBeUndefined();
    expect(result.hookSpecificOutput.additionalContext).toContain('no-console');
  });

  it('handles eslint crash gracefully', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      const err = new Error('Cannot find module eslint');
      err.stdout = 'Cannot find module eslint';
      throw err;
    });

    const result = await handler({
      tool_input: { file_path: 'src/App.tsx' },
      cwd: '/srv/repos/project',
    });

    expect(result.hookSpecificOutput.additionalContext).toContain('ESLint failed to run');
  });

  it('lints .mjs files', async () => {
    vi.mocked(execFileSync).mockReturnValue('');

    const result = await handler({
      tool_input: { file_path: 'lib/handler.mjs' },
      cwd: '/tmp',
    });
    // Should have been called (not skipped)
    expect(execFileSync).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
