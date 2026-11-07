/** Tests for the updater manifest builder. */
import { describe, it, expect } from 'vitest'
import { buildManifest, PLATFORM } from './update-manifest.mjs'

const ok = {
  version: '0.9.10',
  signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==\n',
  url: 'https://github.com/Multiplier-Labs/codekin/releases/download/v0.9.10/Codekin_0.9.10_aarch64.app.tar.gz',
  pubDate: new Date('2026-11-07T10:00:00Z'),
}

describe('buildManifest', () => {
  it('produces the Tauri updater format for Apple Silicon', () => {
    expect(buildManifest(ok)).toEqual({
      version: '0.9.10',
      notes: '',
      pub_date: '2026-11-07T10:00:00.000Z',
      platforms: { [PLATFORM]: { signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==', url: ok.url } },
    })
    expect(PLATFORM).toBe('darwin-aarch64')
  })

  it('rejects anything that would publish a broken or misleading manifest', () => {
    expect(() => buildManifest({ ...ok, version: 'v0.9.10' })).toThrow(/semver/)
    expect(() => buildManifest({ ...ok, signature: '  ' })).toThrow(/signature/)
    expect(() => buildManifest({ ...ok, url: 'http://example.com/Codekin_0.9.10_aarch64.app.tar.gz' })).toThrow(/https/)
    expect(() => buildManifest({ ...ok, url: 'https://example.com/Codekin_0.9.10_aarch64.dmg' })).toThrow(/app\.tar\.gz/)
    expect(() => buildManifest({ ...ok, url: 'https://example.com/Codekin_0.9.9_aarch64.app.tar.gz' })).toThrow(/version/)
    expect(() => buildManifest({ ...ok, url: 'nope' })).toThrow(/not a URL/)
  })
})
