/**
 * Tests for the DeploymentMonitor — sampling, breach/recovery transition
 * signals (alert once, not per sample), one-off events, and sample queries.
 * Uses a real in-memory SQLite database with injected probe runners and a
 * captured signal publisher.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { DeploymentMonitor, parsePm2Jlist, type ProbeResult, type ProbeMetrics } from './deployment-monitor.js'
import type { DeploymentsFile } from './deployment-config.js'

const NOW = new Date('2026-08-30T12:00:00.000Z')

const okResult = (metrics: ProbeMetrics = {}): ProbeResult => ({ ok: true, breaches: [], events: [], metrics })
const breachedResult = (breach: string, metrics: ProbeMetrics = {}): ProbeResult =>
  ({ ok: false, breaches: [breach], events: [], metrics })

function makeConfig(): DeploymentsFile {
  return {
    deployments: [{
      id: 'app-1',
      name: 'Codekin Prod',
      enabled: true,
      probes: [{ type: 'http', url: 'https://example.test/health' }],
    }],
  }
}

describe('parsePm2Jlist', () => {
  const JSON_LIST = '[{"name":"codekin","pm2_env":{"status":"online","restart_time":3}}]'

  it('parses clean output', () => {
    expect(parsePm2Jlist(JSON_LIST)[0].name).toBe('codekin')
  })

  it('parses output preceded by a warning banner with ANSI color codes', () => {
    // Real-world shape: pm2 prints an out-of-date banner on stdout before the
    // JSON when the daemon predates the CLI (e.g. after a node upgrade).
    const banner = '\x1b[31m\x1b[1m>>>> In-memory PM2 is out-of-date, do:\x1b[22m\x1b[39m\n'
      + '\x1b[31m\x1b[1m>>>> $ pm2 update\x1b[22m\x1b[39m\n'
      + 'In memory PM2 version: 5.3.0\nLocal PM2 version: 6.0.8\n'
    expect(parsePm2Jlist(banner + JSON_LIST)[0].pm2_env?.status).toBe('online')
  })

  it('throws (instead of returning garbage) when no JSON array is present', () => {
    expect(() => parsePm2Jlist('some error text')).toThrow(/no JSON array/)
  })
})

describe('DeploymentMonitor', () => {
  let monitor: DeploymentMonitor
  let published: Array<{ kind: string; payload?: Record<string, unknown>; dedupeKey?: string }>

  function makeMonitor(httpResults: ProbeResult[], config: DeploymentsFile = makeConfig()) {
    published = []
    let call = 0
    monitor = new DeploymentMonitor({
      dbPath: ':memory:',
      publish: (input) => published.push(input),
      loadConfig: () => config,
      runners: {
        http: async () => httpResults[Math.min(call++, httpResults.length - 1)],
      },
    })
    return monitor
  }

  afterEach(() => {
    monitor.close()
  })

  it('samples every enabled probe and records metrics', async () => {
    makeMonitor([okResult({ status: 200, latencyMs: 45 })])
    await monitor.sampleAll(NOW)

    const samples = monitor.latestSamples()
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({
      deploymentId: 'app-1',
      probeKey: 'app-1::http:https://example.test/health',
      ok: true,
      metrics: { status: 200, latencyMs: 45 },
    })
    expect(published).toHaveLength(0)
  })

  it('skips disabled deployments', async () => {
    const config = makeConfig()
    config.deployments[0].enabled = false
    makeMonitor([okResult()], config)
    await monitor.sampleAll(NOW)
    expect(monitor.latestSamples()).toHaveLength(0)
  })

  it('signals a breach only on the ok → breached transition, and recovery on the way back', async () => {
    makeMonitor([
      okResult(),
      breachedResult('http 502'),
      breachedResult('http 502'),
      okResult(),
    ])

    await monitor.sampleAll(NOW)                                      // ok — nothing
    await monitor.sampleAll(new Date(NOW.getTime() + 5 * 60_000))     // breach → signal
    await monitor.sampleAll(new Date(NOW.getTime() + 10 * 60_000))    // still breached → silent
    await monitor.sampleAll(new Date(NOW.getTime() + 15 * 60_000))    // recovered → signal

    expect(published.map(p => p.kind)).toEqual(['probe-breach', 'probe-recovered'])
    expect(published[0].payload).toMatchObject({
      deploymentId: 'app-1',
      deploymentName: 'Codekin Prod',
      breaches: ['http 502'],
    })
    expect(published[0].dedupeKey).toBe('probe-breach::app-1::http:https://example.test/health')
  })

  it('signals a breach immediately when the first-ever sample is breached', async () => {
    makeMonitor([breachedResult('unreachable: ECONNREFUSED')])
    await monitor.sampleAll(NOW)
    expect(published.map(p => p.kind)).toEqual(['probe-breach'])
  })

  it('publishes one-off events regardless of breach state', async () => {
    published = []
    const config: DeploymentsFile = {
      deployments: [{
        id: 'app-1', name: 'Codekin Prod', enabled: true,
        probes: [{ type: 'pm2', processName: 'codekin' }],
      }],
    }
    let call = 0
    monitor = new DeploymentMonitor({
      dbPath: ':memory:',
      publish: (input) => published.push(input),
      loadConfig: () => config,
      runners: {
        pm2: async (_probe, previous) => {
          call++
          const restarts = call === 1 ? 3 : 4
          const events: string[] = []
          const prev = typeof previous?.restarts === 'number' ? previous.restarts : null
          if (prev !== null && restarts > prev) events.push(`restarted (${prev} → ${restarts})`)
          return { ok: true, breaches: [], events, metrics: { status: 'online', restarts, memoryMb: 120 } }
        },
      },
    })

    await monitor.sampleAll(NOW)
    await monitor.sampleAll(new Date(NOW.getTime() + 5 * 60_000))

    expect(published.map(p => p.kind)).toEqual(['probe-event'])
    expect(published[0].payload).toMatchObject({ event: 'restarted (3 → 4)' })
  })

  it('returns sample history newest-first and prunes by retention', async () => {
    makeMonitor([okResult({ status: 200 })])
    await monitor.sampleAll(NOW)
    await monitor.sampleAll(new Date(NOW.getTime() + 5 * 60_000))

    const key = 'app-1::http:https://example.test/health'
    const history = monitor.listSamples({ probeKey: key })
    expect(history).toHaveLength(2)
    expect(history[0].id).toBeGreaterThan(history[1].id)

    // Both samples are in the past relative to a far-future cutoff → pruned.
    monitor.pruneSamples(-24 * 60 * 60 * 1000)
    expect(monitor.listSamples({ probeKey: key })).toHaveLength(0)
  })
})
