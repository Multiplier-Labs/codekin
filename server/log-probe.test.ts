/** Tests for the error-rate log probe — offset baselining, window counting, rotation, bounded reads. Uses real temp files. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runLogProbe } from './deployment-monitor.js'
import type { ProbeMetrics } from './deployment-monitor.js'

describe('runLogProbe', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-probe-'))
    file = join(dir, 'app.log')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const probe = { type: 'log' as const, path: '', maxErrorsPerWindow: 2 }

  it('baselines at EOF on the first sample without scanning history', async () => {
    writeFileSync(file, 'ERROR old\nERROR older\n')
    const result = await runLogProbe({ ...probe, path: file }, null)
    expect(result.ok).toBe(true)
    expect(result.metrics.errorCount).toBe(0)
    expect(result.metrics.fileOffset).toBe(result.metrics.fileSize)
  })

  it('counts only new error lines since the previous offset and breaches past the threshold', async () => {
    writeFileSync(file, 'boot ok\n')
    const first = await runLogProbe({ ...probe, path: file }, null)

    appendFileSync(file, 'info fine\nERROR one\nException two\nfatal three\n')
    const second = await runLogProbe({ ...probe, path: file }, first.metrics)

    expect(second.metrics.errorCount).toBe(3)
    expect(second.ok).toBe(false)
    expect(second.breaches[0]).toContain('3 error line(s)')

    // Nothing new → clean again (recovery transition).
    const third = await runLogProbe({ ...probe, path: file }, second.metrics)
    expect(third.ok).toBe(true)
    expect(third.metrics.errorCount).toBe(0)
  })

  it('restarts the scan from 0 when the file shrinks (rotation)', async () => {
    writeFileSync(file, 'a long line of ordinary content that will be rotated away\n')
    const first = await runLogProbe({ ...probe, path: file }, null)

    writeFileSync(file, 'ERROR after rotate\n') // smaller than previous size
    const second = await runLogProbe({ ...probe, path: file }, first.metrics)
    expect(second.metrics.errorCount).toBe(1)
  })

  it('respects a custom pattern', async () => {
    writeFileSync(file, '')
    const first = await runLogProbe({ ...probe, path: file, errorPattern: 'PANIC' }, null)
    appendFileSync(file, 'ERROR ignored\nPANIC counted\n')
    const second = await runLogProbe({ ...probe, path: file, errorPattern: 'PANIC' }, first.metrics)
    expect(second.metrics.errorCount).toBe(1)
  })

  it('breaches visibly on a missing file and on an invalid pattern', async () => {
    const missing = await runLogProbe({ ...probe, path: join(dir, 'nope.log') }, null)
    expect(missing.ok).toBe(false)
    expect(missing.breaches[0]).toContain('log probe failed')

    writeFileSync(file, '')
    const bad = await runLogProbe({ ...probe, path: file, errorPattern: '(' }, null)
    expect(bad.ok).toBe(false)
    expect(bad.breaches[0]).toContain('invalid errorPattern')
  })

  it('bounds the read window on runaway growth and flags the truncated scan', async () => {
    writeFileSync(file, '')
    const first = await runLogProbe({ ...probe, path: file }, null)
    // Simulate a huge jump by faking the previous offset far behind a large file.
    writeFileSync(file, 'x'.repeat(6 * 1024 * 1024))
    const prev: ProbeMetrics = { ...first.metrics, fileOffset: 0 }
    const second = await runLogProbe({ ...probe, path: file, maxErrorsPerWindow: 10_000 }, prev)
    expect(second.metrics.truncatedScan).toBe(1)
    expect(second.metrics.fileOffset).toBe(6 * 1024 * 1024)
  })
})
