/** Tests for the host probe — pure evaluation over injected raw readings, and the weekly digest builder. */
import { describe, it, expect } from 'vitest'
import { evaluateHostProbe, buildHostDigest, type HostRaw } from './host-probe.js'
import type { DeploymentSample } from './deployment-monitor.js'

const HEALTHY: HostRaw = {
  memTotalKb: 8 * 1024 * 1024,
  memAvailableKb: 4 * 1024 * 1024,
  load1: 0.5,
  cores: 4,
  upgradable: 0,
  securityUpgradable: 0,
  rebootRequired: false,
}

describe('evaluateHostProbe', () => {
  it('is ok on a healthy host and reports rounded metrics', () => {
    const result = evaluateHostProbe({ type: 'host' }, HEALTHY)
    expect(result.ok).toBe(true)
    expect(result.metrics).toMatchObject({
      memAvailablePct: 50,
      memTotalMb: 8192,
      load1: 0.5,
      cores: 4,
      upgradable: 0,
      securityUpgradable: 0,
      rebootRequired: 0,
    })
  })

  it('breaches on low memory and high load per core', () => {
    const result = evaluateHostProbe({ type: 'host' }, {
      ...HEALTHY,
      memAvailableKb: 400 * 1024, // ~5%
      load1: 14,                  // 3.5/core
    })
    expect(result.ok).toBe(false)
    expect(result.breaches).toEqual([
      'memory low: 5% available',
      'load high: 14.00 (3.50 per core)',
    ])
  })

  it('proposes operator-run remediation for pending security updates and reboot', () => {
    const result = evaluateHostProbe({ type: 'host' }, {
      ...HEALTHY,
      upgradable: 12,
      securityUpgradable: 3,
      rebootRequired: true,
    })
    expect(result.breaches).toHaveLength(2)
    expect(result.breaches[0]).toContain('3 security update(s) pending')
    expect(result.breaches[0]).toContain('operator-run')
    expect(result.breaches[1]).toContain('reboot required')
  })

  it('respects opt-outs and custom thresholds', () => {
    const relaxed = evaluateHostProbe(
      { type: 'host', alertOnSecurityUpdates: false, alertOnRebootRequired: false, maxLoadPerCore: 10 },
      { ...HEALTHY, securityUpgradable: 5, rebootRequired: true, load1: 20 },
    )
    expect(relaxed.ok).toBe(true)
  })

  it('treats unreadable sources as unknown, not breached', () => {
    const result = evaluateHostProbe({ type: 'host' }, {
      ...HEALTHY,
      memTotalKb: null,
      memAvailableKb: null,
      upgradable: null,
      securityUpgradable: null,
    })
    expect(result.ok).toBe(true)
    expect(result.metrics.memAvailablePct).toBeNull()
    expect(result.metrics.upgradable).toBeNull()
  })
})

describe('buildHostDigest', () => {
  const hostSample: DeploymentSample = {
    id: 10, deploymentId: 'host', probeKey: 'host::host:system', probeType: 'host',
    ok: false,
    breaches: ['2 security update(s) pending (proposed, operator-run: sudo apt-get update && sudo apt-get upgrade)'],
    metrics: { memAvailablePct: 42, memTotalMb: 8192, load1: 0.7, cores: 4, upgradable: 9, securityUpgradable: 2, rebootRequired: 1 },
    createdAt: '2026-08-30T12:00:00.000Z',
  }
  const httpSample: DeploymentSample = {
    id: 11, deploymentId: 'app', probeKey: 'app::http:https://x/health', probeType: 'http',
    ok: true, breaches: [], metrics: { status: 200 }, createdAt: '2026-08-30T12:00:00.000Z',
  }

  it('summarizes host state, proposals, and deployment probe health', () => {
    const digest = buildHostDigest(hostSample, [hostSample, httpSample])
    expect(digest).toContain('Memory: 42% available of 8192MB')
    expect(digest).toContain('Updates: 9 upgradable, 2 security')
    expect(digest).toContain('operator-run: sudo apt-get update')
    expect(digest).toContain('Reboot required: YES')
    expect(digest).toContain('Deployment probes: 1/1 healthy')
    expect(digest).toContain('Active host breaches:')
  })
})
