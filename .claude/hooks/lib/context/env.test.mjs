import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnvContext } from './env.mjs';

describe('EnvContext', () => {
  const ctx = new EnvContext();
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CLAUDE_CODE_REMOTE;
    delete process.env.CODEKIN_SESSION_TYPE;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('has name "env"', () => {
    expect(ctx.name).toBe('env');
  });

  it('returns session info from input', async () => {
    const result = await ctx.gather({
      session_id: 'sess-1',
      permission_mode: 'default',
      cwd: '/tmp',
    });
    expect(result.sessionId).toBe('sess-1');
    expect(result.permissionMode).toBe('default');
    expect(result.isRemote).toBe(false);
    expect(result.isWebhookSession).toBe(false);
    expect(result.projectDir).toBe('/tmp');
  });

  it('detects webhook session', async () => {
    process.env.CODEKIN_SESSION_TYPE = 'webhook';
    const result = await ctx.gather({ session_id: 'x', permission_mode: 'default', cwd: '/tmp' });
    expect(result.isWebhookSession).toBe(true);
  });

  it('detects remote', async () => {
    process.env.CLAUDE_CODE_REMOTE = 'true';
    const result = await ctx.gather({ session_id: 'x', permission_mode: 'default', cwd: '/tmp' });
    expect(result.isRemote).toBe(true);
  });

  it('uses CLAUDE_PROJECT_DIR over cwd', async () => {
    process.env.CLAUDE_PROJECT_DIR = '/srv/repos/project';
    const result = await ctx.gather({ session_id: 'x', permission_mode: 'default', cwd: '/tmp' });
    expect(result.projectDir).toBe('/srv/repos/project');
  });
});
