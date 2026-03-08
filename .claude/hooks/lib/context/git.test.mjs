import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitContext } from './git.mjs';
import { execSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

describe('GitContext', () => {
  const ctx = new GitContext();
  const input = { cwd: '/tmp/test-project' };

  beforeEach(() => {
    vi.mocked(execSync).mockReset();
  });

  it('has name "git"', () => {
    expect(ctx.name).toBe('git');
  });

  it('returns branch and clean status', async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce('main\n')   // git rev-parse
      .mockReturnValueOnce('');         // git status --porcelain

    const result = await ctx.gather(input);
    expect(result).toEqual({ branch: 'main', dirty: false, status: null });
  });

  it('returns dirty status with file list', async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce('feature-branch\n')
      .mockReturnValueOnce('M src/App.tsx\n?? new-file.ts');

    const result = await ctx.gather(input);
    expect(result).toEqual({
      branch: 'feature-branch',
      dirty: true,
      status: 'M src/App.tsx\n?? new-file.ts',
    });
  });

  it('returns defaults on git failure (not a repo)', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not a git repo'); });

    const result = await ctx.gather(input);
    expect(result).toEqual({ branch: null, dirty: false, status: null });
  });
});
