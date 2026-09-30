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

  it('applies extraEnv last', () => {
    vi.stubEnv('CODEKIN_SESSION_ID', 'from-parent')
    const env = buildHarnessEnv({ CODEKIN_SESSION_ID: 'from-session', CODEKIN_TOKEN: 'scoped' })
    expect(env.CODEKIN_SESSION_ID).toBe('from-session')
    expect(env.CODEKIN_TOKEN).toBe('scoped')
  })
})
