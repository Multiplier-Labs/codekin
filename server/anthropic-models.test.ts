/**
 * Tests for anthropic-models — verifies the two model-discovery strategies
 * (Anthropic API + CLI probing), cache TTL behavior, probe de-duplication,
 * and fallback when neither strategy has completed.
 *
 * The module keeps process-level state (cache + in-flight probe promise), so
 * each test loads a fresh copy via vi.resetModules().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock config so we don't depend on a real claude binary lookup.
vi.mock('./config.js', () => ({ CLAUDE_BINARY: 'claude' }))

// Mock child_process.execFile — the CLI probe path. Each test installs its own
// behavior via setExecFileImpl().
const mockExecFile = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))

type ExecCallback = (err: Error | null, stdout: string) => void

/** Probe response for a model that exists: exit 0, modelUsage keyed by the requested ID. */
function okProbe(modelId: string): [Error | null, string] {
  return [null, JSON.stringify({ is_error: false, modelUsage: { [modelId]: { inputTokens: 1 } } })]
}

/** Probe response for a model that doesn't exist: the CLI exits non-zero but
 *  still writes result JSON with api_error_status 404 to stdout. */
function notFoundProbe(): [Error | null, string] {
  return [new Error('exit 1'), JSON.stringify({ is_error: true, api_error_status: 404, modelUsage: {} })]
}

/** Probe response for a transient failure (rate limit / overload / timeout). */
function transientProbe(): [Error | null, string] {
  return [new Error('exit 1'), JSON.stringify({ is_error: true, api_error_status: 529, modelUsage: {} })]
}

/**
 * Install execFile behavior. `available` lists model IDs that "exist" — for
 * those, the callback yields a JSON result whose modelUsage is keyed by the
 * requested ID. Any other ID yields a definitive 404 (model doesn't exist).
 * `transient` lists IDs that fail with a retryable error instead.
 */
function setExecFileImpl(available: Set<string>, transient: Set<string> = new Set()): void {
  mockExecFile.mockImplementation((_bin: string, args: string[], _opts: any, cb: ExecCallback) => {
    // args = ['-p', '--model', <id>, '--output-format', 'json', <prompt>]
    const modelId = args[2]
    queueMicrotask(() => {
      if (transient.has(modelId)) cb(...transientProbe())
      else if (available.has(modelId)) cb(...okProbe(modelId))
      else cb(...notFoundProbe())
    })
    return { unref: vi.fn() }
  })
}

function mockFetch(impl: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
    impl(typeof input === 'string' ? input : input.toString()),
  ) as typeof fetch
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

async function loadFreshModule(): Promise<typeof import('./anthropic-models.js')> {
  vi.resetModules()
  return await import('./anthropic-models.js')
}

describe('anthropic-models', () => {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalCodeKey = process.env.CLAUDE_CODE_API_KEY

  beforeEach(() => {
    mockExecFile.mockReset()
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_API_KEY
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalApiKey
    if (originalCodeKey === undefined) delete process.env.CLAUDE_CODE_API_KEY
    else process.env.CLAUDE_CODE_API_KEY = originalCodeKey
  })

  /* ---------------------------------------------------------------- */
  /*  fetchAnthropicModels — Strategy 1 (API) + fallback              */
  /* ---------------------------------------------------------------- */

  describe('fetchAnthropicModels', () => {
    it('returns the hardcoded fallback when no API key and no cache', async () => {
      const mod = await loadFreshModule()
      const models = await mod.fetchAnthropicModels()
      expect(models).toEqual(mod.FALLBACK_MODELS)
    })

    it('maps, filters, and sorts the API catalog (newest created_at first)', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test'
      mockFetch(() =>
        jsonResponse({
          data: [
            { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6', created_at: '2026-01-01' },
            { id: 'claude-opus-4-8', display_name: 'Opus 4.8', created_at: '2026-05-01' },
            { id: 'claude-embed-1', display_name: 'Embed', created_at: '2026-05-02' },
            { id: 'gpt-4', display_name: 'Not Claude', created_at: '2026-05-03' },
          ],
        }),
      )

      const mod = await loadFreshModule()
      const models = await mod.fetchAnthropicModels()

      // embed + non-claude filtered out; sorted newest-first by created_at
      expect(models).toEqual([
        { id: 'claude-opus-4-8', label: 'Opus 4.8' },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      ])
    })

    it('derives a label from the id when display_name is absent', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test'
      mockFetch(() =>
        jsonResponse({ data: [{ id: 'claude-haiku-4-5-20251001', created_at: '2026-01-01' }] }),
      )

      const mod = await loadFreshModule()
      const models = await mod.fetchAnthropicModels()
      expect(models).toEqual([{ id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }])
    })

    it('falls back when the API responds non-OK', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test'
      mockFetch(() => jsonResponse({}, false))

      const mod = await loadFreshModule()
      const models = await mod.fetchAnthropicModels()
      expect(models).toEqual(mod.FALLBACK_MODELS)
    })

    it('falls back when fetch throws', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test'
      globalThis.fetch = vi.fn(async () => {
        throw new Error('network down')
      }) as typeof fetch

      const mod = await loadFreshModule()
      const models = await mod.fetchAnthropicModels()
      expect(models).toEqual(mod.FALLBACK_MODELS)
    })

    it('serves cached models within the TTL without re-fetching', async () => {
      vi.useFakeTimers()
      process.env.ANTHROPIC_API_KEY = 'sk-test'
      const fetchSpy = vi.fn(() =>
        jsonResponse({ data: [{ id: 'claude-opus-4-8', display_name: 'Opus 4.8', created_at: '2026-05-01' }] }),
      )
      globalThis.fetch = vi.fn(async () => fetchSpy()) as typeof fetch

      const mod = await loadFreshModule()
      await mod.fetchAnthropicModels()
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      // 30 min later — still within the 1h API TTL → cache hit, no new fetch
      vi.advanceTimersByTime(30 * 60 * 1000)
      await mod.fetchAnthropicModels()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('re-fetches once the API cache TTL expires', async () => {
      vi.useFakeTimers()
      process.env.ANTHROPIC_API_KEY = 'sk-test'
      const fetchSpy = vi.fn(() =>
        jsonResponse({ data: [{ id: 'claude-opus-4-8', display_name: 'Opus 4.8', created_at: '2026-05-01' }] }),
      )
      globalThis.fetch = vi.fn(async () => fetchSpy()) as typeof fetch

      const mod = await loadFreshModule()
      await mod.fetchAnthropicModels()
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      // Past the 1h TTL → cache expired → re-fetch
      vi.advanceTimersByTime(61 * 60 * 1000)
      await mod.fetchAnthropicModels()
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })
  })

  /* ---------------------------------------------------------------- */
  /*  triggerCliProbeIfNeeded — Strategy 2 (CLI probing)             */
  /* ---------------------------------------------------------------- */

  describe('triggerCliProbeIfNeeded', () => {
    it('probes candidate models and caches the discovered IDs', async () => {
      setExecFileImpl(new Set(['claude-opus-4-8', 'claude-sonnet-4-6']))

      const mod = await loadFreshModule()
      mod.triggerCliProbeIfNeeded()

      await vi.waitFor(async () => {
        const models = await mod.fetchAnthropicModels()
        expect(models).toEqual([
          { id: 'claude-opus-4-8', label: 'Opus 4.8' },
          { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
        ])
      })
    })

    it('de-duplicates model IDs returned by multiple probes', async () => {
      // Two probed candidates resolve to the SAME underlying model id.
      mockExecFile.mockImplementation((_bin: string, _args: string[], _opts: any, cb: ExecCallback) => {
        queueMicrotask(() =>
          cb(null, JSON.stringify({ is_error: false, modelUsage: { 'claude-opus-4-8': { inputTokens: 1 } } })),
        )
        return { unref: vi.fn() }
      })

      const mod = await loadFreshModule()
      mod.triggerCliProbeIfNeeded()

      await vi.waitFor(async () => {
        const models = await mod.fetchAnthropicModels()
        expect(models).toEqual([{ id: 'claude-opus-4-8', label: 'Opus 4.8' }])
      })
    })

    it('does not start a second probe while one is in flight (de-dup)', async () => {
      setExecFileImpl(new Set(['claude-opus-4-8']))

      const mod = await loadFreshModule()
      mod.triggerCliProbeIfNeeded()
      const callsAfterFirst = mockExecFile.mock.calls.length
      // Second synchronous call should be suppressed by probeInFlight guard.
      mod.triggerCliProbeIfNeeded()
      expect(mockExecFile.mock.calls.length).toBe(callsAfterFirst)

      await vi.waitFor(() => expect(mockExecFile).toHaveBeenCalled())
    })

    it('skips probing entirely when an API key is present', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test'
      setExecFileImpl(new Set(['claude-opus-4-8']))

      const mod = await loadFreshModule()
      mod.triggerCliProbeIfNeeded()

      expect(mockExecFile).not.toHaveBeenCalled()
    })

    it('caches CLI results for 24h — a later trigger does not re-probe', async () => {
      vi.useFakeTimers()
      setExecFileImpl(new Set(['claude-opus-4-8']))

      const mod = await loadFreshModule()
      mod.triggerCliProbeIfNeeded()
      await vi.waitFor(() => expect(mockExecFile).toHaveBeenCalled())
      const callsAfterFirstProbe = mockExecFile.mock.calls.length

      // 1h later — still inside the 24h CLI TTL → no new probe.
      vi.advanceTimersByTime(60 * 60 * 1000)
      mod.triggerCliProbeIfNeeded()
      expect(mockExecFile.mock.calls.length).toBe(callsAfterFirstProbe)
    })

    it('caps concurrent probe spawns at 4', async () => {
      let inFlight = 0
      let maxInFlight = 0
      mockExecFile.mockImplementation((_bin: string, args: string[], _opts: any, cb: ExecCallback) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        queueMicrotask(() => {
          inFlight--
          cb(...okProbe(args[2]))
        })
        return { unref: vi.fn() }
      })

      const mod = await loadFreshModule()
      mod.triggerCliProbeIfNeeded()
      await vi.waitFor(async () => {
        const models = await mod.fetchAnthropicModels()
        expect(models.length).toBeGreaterThan(1)
      })
      expect(maxInFlight).toBeLessThanOrEqual(4)
    })
  })

  /* ---------------------------------------------------------------- */
  /*  Probe resilience — transient failures vs definitive 404s        */
  /* ---------------------------------------------------------------- */

  describe('probe resilience', () => {
    it('retries transiently-failed probes and picks up the retry result', async () => {
      vi.useFakeTimers()
      // claude-opus-5 fails with a 529 on the first attempt, succeeds on retry.
      const attempts = new Map<string, number>()
      mockExecFile.mockImplementation((_bin: string, args: string[], _opts: any, cb: ExecCallback) => {
        const modelId = args[2]
        const n = (attempts.get(modelId) ?? 0) + 1
        attempts.set(modelId, n)
        queueMicrotask(() => {
          if (modelId === 'claude-opus-5' && n === 1) cb(...transientProbe())
          else if (modelId === 'claude-opus-5' || modelId === 'claude-fable-5') cb(...okProbe(modelId))
          else cb(...notFoundProbe())
        })
        return { unref: vi.fn() }
      })

      const mod = await loadFreshModule()
      mod.triggerCliProbeIfNeeded()

      // First wave completes on microtasks; then advance past the retry delay.
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(6_000)

      const models = await mod.fetchAnthropicModels()
      expect(models).toEqual([
        { id: 'claude-opus-5', label: 'Opus 5' },
        { id: 'claude-fable-5', label: 'Fable 5' },
      ])
      expect(attempts.get('claude-opus-5')).toBe(2)
      // Definitive 404s are not retried.
      expect(attempts.get('claude-sonnet-4-6')).toBe(1)
    })

    it('keeps last-known-good models when a probe keeps failing transiently', async () => {
      vi.useFakeTimers()
      // First run: fable-5 and opus-5 both exist.
      setExecFileImpl(new Set(['claude-fable-5', 'claude-opus-5']))
      const mod = await loadFreshModule()
      mod.triggerCliProbeIfNeeded()
      await vi.waitFor(async () => {
        expect(await mod.fetchAnthropicModels()).toHaveLength(2)
      })

      // Past the 24h TTL, opus-5 now fails transiently (rate limit) on every
      // attempt, and sonnet-5 has newly appeared (proves this run completed —
      // a stale cache read could not contain it).
      vi.advanceTimersByTime(25 * 60 * 60 * 1000)
      setExecFileImpl(new Set(['claude-fable-5', 'claude-sonnet-5']), new Set(['claude-opus-5']))
      mod.triggerCliProbeIfNeeded()

      // First wave on microtasks, then past the retry delay, then the retry wave.
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(6_000)

      const models = await mod.fetchAnthropicModels()
      // opus-5 survives via carry-over from the previous run.
      // Order is by preference (opus > sonnet > fable), not probe order.
      expect(models).toEqual([
        { id: 'claude-opus-5', label: 'Opus 5' },
        { id: 'claude-sonnet-5', label: 'Sonnet 5' },
        { id: 'claude-fable-5', label: 'Fable 5' },
      ])
    })

    it('drops a model once its probe returns a definitive 404', async () => {
      vi.useFakeTimers()
      setExecFileImpl(new Set(['claude-fable-5', 'claude-opus-5']))
      const mod = await loadFreshModule()
      mod.triggerCliProbeIfNeeded()
      await vi.waitFor(async () => {
        expect(await mod.fetchAnthropicModels()).toHaveLength(2)
      })

      // Past the TTL, opus-5 is retired — the API now 404s it.
      vi.advanceTimersByTime(25 * 60 * 60 * 1000)
      setExecFileImpl(new Set(['claude-fable-5']))
      mod.triggerCliProbeIfNeeded()

      await vi.waitFor(async () => {
        const models = await mod.fetchAnthropicModels()
        expect(models).toEqual([{ id: 'claude-fable-5', label: 'Fable 5' }])
      })
    })
  })

  /* ---------------------------------------------------------------- */
  /*  refreshAnthropicModels — forced rediscovery                     */
  /* ---------------------------------------------------------------- */

  describe('refreshAnthropicModels', () => {
    it('re-probes immediately even when the CLI cache is still valid', async () => {
      setExecFileImpl(new Set(['claude-fable-5']))
      const mod = await loadFreshModule()
      mod.triggerCliProbeIfNeeded()
      await vi.waitFor(async () => {
        expect(await mod.fetchAnthropicModels()).toEqual([{ id: 'claude-fable-5', label: 'Fable 5' }])
      })

      // A model appears; the plain trigger would be a no-op for 24h, but
      // refresh bypasses the TTL and returns the fresh list.
      setExecFileImpl(new Set(['claude-fable-5', 'claude-opus-5']))
      const models = await mod.refreshAnthropicModels()
      expect(models).toEqual([
        { id: 'claude-opus-5', label: 'Opus 5' },
        { id: 'claude-fable-5', label: 'Fable 5' },
      ])
    })

    it('uses the API strategy when an API key is present', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test'
      mockFetch(() =>
        jsonResponse({ data: [{ id: 'claude-opus-5', display_name: 'Opus 5', created_at: '2026-05-01' }] }),
      )

      const mod = await loadFreshModule()
      const models = await mod.refreshAnthropicModels()
      expect(models).toEqual([{ id: 'claude-opus-5', label: 'Opus 5' }])
      expect(mockExecFile).not.toHaveBeenCalled()
    })
  })

  /* ---------------------------------------------------------------- */
  /*  Ordering — entry [0] is the default new sessions start on        */
  /* ---------------------------------------------------------------- */

  describe('ordering', () => {
    it('ranks the newest general model first, not the probe order', async () => {
      vi.useFakeTimers()
      setExecFileImpl(new Set(['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8']))
      const mod = await loadFreshModule()
      mod.triggerCliProbeIfNeeded()
      await vi.waitFor(async () => {
        expect(await mod.fetchAnthropicModels()).toHaveLength(4)
      })

      // Fable is probed first but is a specialised model — Opus 5 is the default.
      expect((await mod.fetchAnthropicModels()).map((m: { id: string }) => m.id)).toEqual([
        'claude-opus-5',
        'claude-sonnet-5',
        'claude-fable-5',
        'claude-opus-4-8',
      ])
      expect(mod.getDefaultClaudeModel()).toBe('claude-opus-5')
    })

    it('sorts API results by preference rather than release date', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test'
      mockFetch(() =>
        jsonResponse({
          data: [
            { id: 'claude-fable-5', display_name: 'Fable 5', created_at: '2026-06-09' },
            { id: 'claude-opus-5', display_name: 'Opus 5', created_at: '2026-04-01' },
          ],
        }),
      )

      const mod = await loadFreshModule()
      const models = await mod.fetchAnthropicModels()
      expect(models.map((m: { id: string }) => m.id)).toEqual(['claude-opus-5', 'claude-fable-5'])
    })
  })
})
