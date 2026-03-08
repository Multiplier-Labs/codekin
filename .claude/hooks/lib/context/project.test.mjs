import { describe, it, expect, vi } from 'vitest';
import { ProjectContext } from './project.mjs';
import { readFileSync } from 'node:fs';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

describe('ProjectContext', () => {
  const ctx = new ProjectContext();

  it('has name "project"', () => {
    expect(ctx.name).toBe('project');
  });

  it('extracts script presence from package.json', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      name: 'codekin',
      scripts: { build: 'vite build', test: 'vitest run', lint: 'eslint .' },
    }));

    const result = await ctx.gather({ cwd: '/tmp/test-project' });
    expect(result).toEqual({
      name: 'codekin',
      hasLint: true,
      hasTest: true,
      hasBuild: true,
      hasTypecheck: false,
      hasDev: false,
    });
  });

  it('returns defaults when package.json missing', async () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

    const result = await ctx.gather({ cwd: '/nonexistent' });
    expect(result).toEqual({
      name: null,
      hasLint: false,
      hasTest: false,
      hasBuild: false,
      hasTypecheck: false,
      hasDev: false,
    });
  });
});
