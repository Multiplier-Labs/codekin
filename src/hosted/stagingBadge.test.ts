// @vitest-environment jsdom
/** Tests for the staging badge: shown only when the relay says it is staging, once. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { showStagingBadgeIfNeeded } from './stagingBadge'

const respond = (body: unknown, ok = true) => vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) })

afterEach(() => {
  document.getElementById('codekin-staging-badge')?.remove()
  document.title = 'Codekin'
})

describe('showStagingBadgeIfNeeded', () => {
  it('marks a staging relay with a badge and a title prefix, once', async () => {
    document.title = 'Codekin'
    expect(await showStagingBadgeIfNeeded(respond({ inviteOnly: true, staging: true }) as never)).toBe(true)
    expect(await showStagingBadgeIfNeeded(respond({ staging: true }) as never)).toBe(true)
    expect(document.querySelectorAll('#codekin-staging-badge')).toHaveLength(1)
    expect(document.title).toBe('[STAGING] Codekin')
  })

  it('does nothing on a normal relay or when the config cannot be read', async () => {
    expect(await showStagingBadgeIfNeeded(respond({ inviteOnly: true }) as never)).toBe(false)
    expect(await showStagingBadgeIfNeeded(respond({}, false) as never)).toBe(false)
    expect(await showStagingBadgeIfNeeded(vi.fn().mockRejectedValue(new Error('offline')) as never)).toBe(false)
    expect(document.getElementById('codekin-staging-badge')).toBeNull()
    expect(document.title).toBe('Codekin')
  })
})
