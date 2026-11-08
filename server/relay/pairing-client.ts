/**
 * The machine side of hosted-relay pairing (desktop plan D2): the device-code
 * flow that `codekin relay login` used to run in the CLI, moved here so the
 * local server can run it for the in-app "Pair with app.codekin.ai" control
 * and the CLI calls the same code.
 *
 *   1. POST <relay>/api/machines/pair/start → userCode + verificationUrl
 *   2. the user approves the code in the hosted app (in their browser)
 *   3. poll POST <relay>/api/machines/pair/complete until complete / denied / expired
 *   4. write ~/.config/codekin/relay.json (managed), which the embedded
 *      connector picks up within a few seconds
 *
 * The machine secret goes only into relay.json (0600); it is never returned
 * by status(), logged, or sent to the browser.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, readFileSync } from 'fs'
import { hostname as osHostname, platform as osPlatform } from 'os'
import { dirname } from 'path'
import { readRelayCredential, relayCredentialPath, SECRET_REF_KEYCHAIN_FIELD, writeFileAtomic } from './relay-credential.js'
import { secretStoreFromEnv } from './secret-store.js'
import type { SecretStore } from './secret-store.js'

export const DEFAULT_RELAY_URL = 'https://app.codekin.ai'

/** What the relay returns from pair/complete when pairing succeeds. */
export interface PairingCompletion {
  machineId: string
  machineSecret: string
  ownerLogin?: string | null
}

export type PairingState =
  | { state: 'idle' }
  | { state: 'pending'; relayUrl: string; verificationUrl: string; userCode: string; expiresAt: number | null }
  | { state: 'complete'; relayUrl: string; machineId: string; ownerLogin: string | null }
  | { state: 'denied' | 'expired' | 'failed'; relayUrl: string; detail?: string }

export class PairingError extends Error {
  constructor(readonly code: 'already_paired' | 'invalid_url' | 'unreachable' | 'rejected', message: string) {
    super(message)
    this.name = 'PairingError'
  }
}

type FetchFn = typeof fetch

export interface PairingOptions {
  credentialFile?: string
  fetchImpl?: FetchFn
  hostname?: string
  platform?: string
  /** Wait between polls (injectable for tests). */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: Pick<Console, 'log' | 'warn'>
  /** Write a managed credential (the local server runs the connector). Default true. */
  managed?: boolean
}

/**
 * Normalise and validate a relay URL. HTTPS only, except plain HTTP to a
 * loopback host for local development of the relay itself.
 */
export function normalizeRelayUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim() || DEFAULT_RELAY_URL
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PairingError('invalid_url', `Not a valid URL: ${value}`)
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new PairingError('invalid_url', 'The relay URL must use https://')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new PairingError('invalid_url', 'The relay URL must not contain credentials, a query or a fragment')
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/** A GitHub login, checked so a relay's answer can't inject markup or escape codes. */
export function safeLogin(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(value) ? value : null
}

/**
 * Persist the machine credential. `managed: true` tells the local server to
 * run the connector itself. The installer writes the same shape.
 */
export function writeRelayCredential(
  file: string,
  relayUrl: string,
  data: PairingCompletion,
  managed: boolean,
  store: SecretStore | null = secretStoreFromEnv(),
): void {
  mkdirSync(dirname(file), { recursive: true })
  const credential: Record<string, unknown> = { url: relayUrl, machineId: data.machineId }
  // With a secret store (the desktop app's Keychain), the file only points at
  // the secret. If storing fails, fall back to the file: a pairing must not
  // be lost to a Keychain hiccup.
  let stored = false
  if (store) {
    try {
      store.set(data.machineId, data.machineSecret)
      stored = store.get(data.machineId) === data.machineSecret
    } catch (err) {
      console.warn(`[relay] Keeping the machine secret in ${file}: the Keychain refused it (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  if (stored) credential.secretRef = SECRET_REF_KEYCHAIN_FIELD
  else credential.machineSecret = data.machineSecret
  if (managed) credential.managed = true
  writeFileAtomic(file, JSON.stringify(credential, null, 2) + '\n')
  chmodSync(file, 0o600)
}

/** Remove the local credential, and its Keychain item if it has one. Returns false when there was none. */
export function removeRelayCredential(file = relayCredentialPath(), store: SecretStore | null = secretStoreFromEnv()): boolean {
  if (!existsSync(file)) return false
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { machineId?: unknown; secretRef?: unknown }
    if (store && parsed.secretRef === SECRET_REF_KEYCHAIN_FIELD && typeof parsed.machineId === 'string') {
      store.delete(parsed.machineId)
    }
  } catch (err) {
    console.warn(`[relay] Could not remove the Keychain item for this pairing: ${err instanceof Error ? err.message : String(err)}`)
  }
  rmSync(file)
  return true
}

function isCompletion(data: unknown): data is PairingCompletion {
  const d = data as Partial<PairingCompletion> | null
  return !!d && typeof d.machineId === 'string' && !!d.machineId && typeof d.machineSecret === 'string' && !!d.machineSecret
}

function parseExpiry(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isNaN(t) ? null : t
  }
  return null
}

async function postJson(fetchImpl: FetchFn, url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, data }
}

/**
 * Claim a pre-approved pairing token (the installer / `--code` path): no
 * approval step, one request.
 */
export async function claimPairingToken(
  relayUrlRaw: string | undefined,
  token: string,
  managed: boolean,
  opts: PairingOptions = {},
): Promise<{ machineId: string; ownerLogin: string | null; relayUrl: string }> {
  const relayUrl = normalizeRelayUrl(relayUrlRaw)
  const file = opts.credentialFile ?? relayCredentialPath()
  if (readRelayCredential(file)) throw new PairingError('already_paired', 'This machine is already paired')
  const fetchImpl = opts.fetchImpl ?? fetch
  let res
  try {
    res = await postJson(fetchImpl, `${relayUrl}/api/machines/pair/complete`, {
      deviceCode: token,
      hostname: opts.hostname ?? osHostname(),
      platform: opts.platform ?? osPlatform(),
    })
  } catch (err) {
    throw new PairingError('unreachable', `Could not reach the relay at ${relayUrl}: ${(err as Error).message}`)
  }
  if (res.data.status === 'complete' && isCompletion(res.data)) {
    writeRelayCredential(file, relayUrl, res.data, managed)
    return { machineId: res.data.machineId, ownerLogin: safeLogin(res.data.ownerLogin), relayUrl }
  }
  const why = typeof res.data.status === 'string' ? res.data.status : String(res.status)
  throw new PairingError('rejected', why === 'expired' ? 'expired' : `Pairing failed (${why})`)
}

/**
 * One interactive pairing at a time, run by the local server (or the CLI).
 * `start()` returns once the relay has issued a code; polling continues in
 * the background and `status()` reports progress.
 */
export class RelayPairing {
  private current: PairingState = { state: 'idle' }
  private abort: AbortController | null = null
  private readonly file: string
  private readonly fetchImpl: FetchFn
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly log: Pick<Console, 'log' | 'warn'>

  constructor(private readonly opts: PairingOptions = {}) {
    this.file = opts.credentialFile ?? relayCredentialPath()
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)))
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? console
  }

  status(): PairingState {
    return this.current
  }

  /** Stop polling. A completed pairing stays complete. */
  cancel(): void {
    this.abort?.abort()
    this.abort = null
    if (this.current.state === 'pending') this.current = { state: 'idle' }
  }

  /**
   * Begin pairing with `relayUrl` (default app.codekin.ai). If a pairing is
   * already pending, returns it unchanged rather than starting a second one.
   * Resolves with the pending state; `done` resolves when polling ends.
   */
  async start(relayUrlRaw?: string): Promise<{ state: PairingState; done: Promise<PairingState> }> {
    if (this.current.state === 'pending') {
      return { state: this.current, done: Promise.resolve(this.current) }
    }
    const relayUrl = normalizeRelayUrl(relayUrlRaw)
    if (readRelayCredential(this.file)) throw new PairingError('already_paired', 'This machine is already paired. Unpair it first.')

    let res
    try {
      res = await postJson(this.fetchImpl, `${relayUrl}/api/machines/pair/start`, {
        hostname: this.opts.hostname ?? osHostname(),
        platform: this.opts.platform ?? osPlatform(),
      })
    } catch (err) {
      throw new PairingError('unreachable', `Could not reach the relay at ${relayUrl}: ${(err as Error).message}`)
    }
    const { userCode, deviceCode, verificationUrl } = res.data
    if (res.status !== 200 || typeof userCode !== 'string' || typeof deviceCode !== 'string' || typeof verificationUrl !== 'string') {
      throw new PairingError('rejected', `The relay refused to start pairing (HTTP ${res.status})`)
    }
    // The browser opens this URL: it must point at the relay we asked.
    let verification: URL
    try {
      verification = new URL(verificationUrl)
    } catch {
      throw new PairingError('rejected', 'The relay returned an invalid verification URL')
    }
    if (verification.protocol !== new URL(relayUrl).protocol || verification.host !== new URL(relayUrl).host) {
      throw new PairingError('rejected', 'The relay returned a verification URL for another site')
    }

    this.current = {
      state: 'pending',
      relayUrl,
      verificationUrl: verification.toString(),
      userCode,
      expiresAt: parseExpiry(res.data.expiresAt),
    }
    const pollMs = typeof res.data.pollIntervalMs === 'number' && res.data.pollIntervalMs >= 500 ? res.data.pollIntervalMs : 3000
    const abort = new AbortController()
    this.abort = abort
    const done = this.poll(relayUrl, deviceCode, pollMs, abort.signal)
    return { state: this.current, done }
  }

  private async poll(relayUrl: string, deviceCode: string, pollMs: number, signal: AbortSignal): Promise<PairingState> {
    const pending = this.current
    const expiresAt = pending.state === 'pending' ? pending.expiresAt : null
    for (;;) {
      await this.sleep(pollMs)
      if (signal.aborted) return this.current
      if (expiresAt !== null && this.now() > expiresAt + pollMs) {
        return this.finish(signal, { state: 'expired', relayUrl })
      }
      let res
      try {
        res = await postJson(this.fetchImpl, `${relayUrl}/api/machines/pair/complete`, { deviceCode })
      } catch {
        continue // transient network error: keep polling until expiry
      }
      if (signal.aborted) return this.current
      if (res.status === 202) continue
      if (res.data.status === 'complete' && isCompletion(res.data)) {
        if (readRelayCredential(this.file)) {
          return this.finish(signal, { state: 'failed', relayUrl, detail: 'Another pairing finished first' })
        }
        writeRelayCredential(this.file, relayUrl, res.data, this.opts.managed ?? true)
        this.log.log(`[relay] Paired with ${relayUrl} as machine ${res.data.machineId}`)
        return this.finish(signal, {
          state: 'complete',
          relayUrl,
          machineId: res.data.machineId,
          ownerLogin: safeLogin(res.data.ownerLogin),
        })
      }
      if (res.data.status === 'denied') return this.finish(signal, { state: 'denied', relayUrl })
      if (res.data.status === 'expired') return this.finish(signal, { state: 'expired', relayUrl })
      const why = typeof res.data.status === 'string' ? res.data.status : `HTTP ${res.status}`
      return this.finish(signal, { state: 'failed', relayUrl, detail: `Pairing failed (${why})` })
    }
  }

  private finish(signal: AbortSignal, state: PairingState): PairingState {
    if (!signal.aborted) {
      this.current = state
      this.abort = null
    }
    return this.current
  }
}
