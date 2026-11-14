import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildHarnessEnv } from './harness-env.js'

describe('buildHarnessEnv', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('strips server API keys and GIT_* vars except GIT_EDITOR', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-stale')
    vi.stubEnv('AUTH_TOKEN', 'master')
    vi.stubEnv('GIT_INDEX_FILE', '.git/index')
    vi.stubEnv('GIT_EDITOR', 'vim')
    vi.stubEnv('XAI_API_KEY', 'xai-key')

    const env = buildHarnessEnv()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.AUTH_TOKEN).toBeUndefined()
    expect(env.GIT_INDEX_FILE).toBeUndefined()
    expect(env.GIT_EDITOR).toBe('vim')
    // Harness-specific keys pass through — each CLI owns its own auth.
    expect(env.XAI_API_KEY).toBe('xai-key')
  })

  it('strips the variables a parent Claude Code session sets, keeping user config', () => {
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'parent-session')
    vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1')
    vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '/tmp/cc-socks/1.sock')
    vi.stubEnv('CLAUDE_CODE_EXECPATH', '/home/u/.local/share/claude/versions/2.1.0')
    vi.stubEnv('CLAUDE_PROJECT_DIR', '/srv/repos/other')
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth')
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1')

    const env = buildHarnessEnv()
    for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PROJECT_DIR']) {
      expect(env[key]).toBeUndefined()
    }
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth')
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
  })

  it('strips the per-session variables of a Codekin session the server was started from', () => {
    vi.stubEnv('CODEKIN_SESSION_ID', 'parent')
    vi.stubEnv('CODEKIN_TOKEN', 'parent-token')
    vi.stubEnv('CODEKIN_AUTH_TOKEN', 'parent-token')
    vi.stubEnv('CODEKIN_SESSION_TYPE', 'manual')
    vi.stubEnv('CODEKIN_SKIP_PERMISSIONS', '1')
    vi.stubEnv('CODEKIN_PORT', '1')
    vi.stubEnv('CODEKIN_HOOK_URL', 'http://localhost:9/api/hook-decision')

    const env = buildHarnessEnv()
    for (const key of ['CODEKIN_SESSION_ID', 'CODEKIN_TOKEN', 'CODEKIN_AUTH_TOKEN', 'CODEKIN_SESSION_TYPE', 'CODEKIN_SKIP_PERMISSIONS', 'CODEKIN_PORT']) {
      expect(env[key]).toBeUndefined()
    }
    // Configuration, not session state, still passes through.
    expect(env.CODEKIN_HOOK_URL).toBe('http://localhost:9/api/hook-decision')
    // A session that does skip permissions still says so.
    expect(buildHarnessEnv({ CODEKIN_SKIP_PERMISSIONS: '1' }).CODEKIN_SKIP_PERMISSIONS).toBe('1')
  })

  it('applies extraEnv last', () => {
    vi.stubEnv('CODEKIN_SESSION_ID', 'from-parent')
    const env = buildHarnessEnv({ CODEKIN_SESSION_ID: 'from-session', CODEKIN_TOKEN: 'scoped' })
    expect(env.CODEKIN_SESSION_ID).toBe('from-session')
    expect(env.CODEKIN_TOKEN).toBe('scoped')
  })
})
