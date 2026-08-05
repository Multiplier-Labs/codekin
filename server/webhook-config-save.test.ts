/**
 * Tests for saveWebhookConfig — verifies the merge semantics and that the
 * config file, which holds the GitHub webhook secret, is owner-only on disk.
 *
 * Separate from webhook-config.test.ts because that file mocks fs; these tests
 * need real writes against a redirected home directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const fakeHome = vi.hoisted(() => {
  const { mkdtempSync, realpathSync } = require('fs')
  const { tmpdir } = require('os')
  const { join } = require('path')
  return realpathSync(mkdtempSync(join(tmpdir(), 'codekin-home-')))
})

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => fakeHome,
}))

import { saveWebhookConfig } from './webhook-config.js'
import { writeFileSync, readFileSync, statSync, existsSync, rmSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'

const CONFIG_FILE = join(fakeHome, '.codekin', 'webhook-config.json')

/** Permission bits of the config file, e.g. 0o600. */
const mode = () => statSync(CONFIG_FILE).mode & 0o777

describe('saveWebhookConfig', () => {
  beforeEach(() => {
    rmSync(join(fakeHome, '.codekin'), { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(join(fakeHome, '.codekin'), { recursive: true, force: true })
  })

  it('creates the config file with owner-only permissions', () => {
    saveWebhookConfig({ secret: 'super-secret', enabled: true })

    expect(existsSync(CONFIG_FILE)).toBe(true)
    expect(mode()).toBe(0o600)
  })

  it('leaves no world-readable temp file behind', () => {
    saveWebhookConfig({ secret: 'super-secret' })

    expect(existsSync(CONFIG_FILE + '.tmp')).toBe(false)
  })

  it('tightens permissions on a file written by an older version', () => {
    mkdirSync(join(fakeHome, '.codekin'), { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify({ enabled: true }) + '\n')
    chmodSync(CONFIG_FILE, 0o644)

    saveWebhookConfig({ secret: 'super-secret' })

    expect(mode()).toBe(0o600)
  })

  it('merges updates into existing values', () => {
    saveWebhookConfig({ enabled: true, maxConcurrentSessions: 7 })
    saveWebhookConfig({ secret: 'super-secret' })

    const saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    expect(saved).toMatchObject({
      enabled: true,
      maxConcurrentSessions: 7,
      secret: 'super-secret',
    })
  })
})
