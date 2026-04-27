import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    readFileSync: vi.fn(),
  }
})

const { readFileSync } = await import('fs')
const mockReadFileSync = readFileSync as unknown as ReturnType<typeof vi.fn>

function setPackageVersion(version: string): void {
  mockReadFileSync.mockImplementation(() => JSON.stringify({ version }))
}

function mockFetch(impl: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    return impl(typeof input === 'string' ? input : input.toString())
  }) as typeof fetch
}

async function loadFreshModule(): Promise<typeof import('./version-check.js')> {
  vi.resetModules()
  return await import('./version-check.js')
}

describe('version-check', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  describe('checkForUpdates', () => {
    it('logs that version is up to date when latest matches current', async () => {
      setPackageVersion('1.0.0')
      mockFetch(() => new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 }))

      const mod = await loadFreshModule()
      await mod.checkForUpdates()

      expect(logSpy).toHaveBeenCalledWith('[update] Codekin 1.0.0 is up to date')
      expect(await mod.getUpdateNotification()).toBeNull()
    })

    it('logs that update is available when latest is newer', async () => {
      setPackageVersion('1.0.0')
      mockFetch(() => new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 }))

      const mod = await loadFreshModule()
      await mod.checkForUpdates()

      expect(logSpy).toHaveBeenCalledWith('[update] Codekin 1.2.0 is available (current: 1.0.0)')
    })

    it('treats older latest as up to date', async () => {
      setPackageVersion('2.0.0')
      mockFetch(() => new Response(JSON.stringify({ version: '1.9.9' }), { status: 200 }))

      const mod = await loadFreshModule()
      await mod.checkForUpdates()

      expect(logSpy).toHaveBeenCalledWith('[update] Codekin 2.0.0 is up to date')
    })

    it('handles non-OK responses as no-update', async () => {
      setPackageVersion('1.0.0')
      mockFetch(() => new Response('nope', { status: 500 }))

      const mod = await loadFreshModule()
      await mod.checkForUpdates()

      expect(logSpy).toHaveBeenCalledWith('[update] Codekin 1.0.0 is up to date')
    })

    it('handles fetch rejections gracefully', async () => {
      setPackageVersion('1.0.0')
      globalThis.fetch = vi.fn(async () => {
        throw new Error('network down')
      }) as typeof fetch

      const mod = await loadFreshModule()
      await expect(mod.checkForUpdates()).resolves.toBeUndefined()
      expect(logSpy).toHaveBeenCalledWith('[update] Codekin 1.0.0 is up to date')
    })

    it('handles missing version field in npm response', async () => {
      setPackageVersion('1.0.0')
      mockFetch(() => new Response(JSON.stringify({}), { status: 200 }))

      const mod = await loadFreshModule()
      await mod.checkForUpdates()

      expect(logSpy).toHaveBeenCalledWith('[update] Codekin 1.0.0 is up to date')
    })

    it('compares minor and patch components correctly', async () => {
      setPackageVersion('1.2.3')
      mockFetch(() => new Response(JSON.stringify({ version: '1.2.4' }), { status: 200 }))

      const mod = await loadFreshModule()
      await mod.checkForUpdates()

      expect(logSpy).toHaveBeenCalledWith('[update] Codekin 1.2.4 is available (current: 1.2.3)')
    })
  })

  describe('getUpdateNotification', () => {
    it('returns notification text when an update is available', async () => {
      setPackageVersion('1.0.0')
      mockFetch(() => new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 }))

      const mod = await loadFreshModule()
      await mod.checkForUpdates()

      expect(await mod.getUpdateNotification()).toBe(
        'Codekin v2.0.0 is available (current: v1.0.0). Run "codekin upgrade" to update.',
      )
    })

    it('re-checks npm when cache has expired', async () => {
      setPackageVersion('1.0.0')
      let calls = 0
      mockFetch(() => {
        calls++
        return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 })
      })

      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-27T00:00:00Z'))

      const mod = await loadFreshModule()
      await mod.checkForUpdates()
      expect(calls).toBe(1)

      vi.setSystemTime(new Date('2026-04-27T07:00:00Z'))
      await mod.getUpdateNotification()
      expect(calls).toBe(2)
    })

    it('does not re-check within the cache window', async () => {
      setPackageVersion('1.0.0')
      let calls = 0
      mockFetch(() => {
        calls++
        return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 })
      })

      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-27T00:00:00Z'))

      const mod = await loadFreshModule()
      await mod.checkForUpdates()
      expect(calls).toBe(1)

      vi.setSystemTime(new Date('2026-04-27T01:00:00Z'))
      await mod.getUpdateNotification()
      expect(calls).toBe(1)
    })
  })
})
