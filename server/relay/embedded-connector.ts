/**
 * Embedded relay connector: the local Codekin server runs the hosted-relay
 * connector in-process when this machine holds a *managed* relay credential,
 * so a machine paired by the installer stays online for as long as the
 * Codekin service runs — no separate foreground `codekin relay connect`.
 *
 * The supervisor polls relay.json (a cheap stat every few seconds) so it
 * picks up a credential written after startup (the installer may pair after
 * the service starts; users may `relay login` later), stops when the file
 * disappears (`relay logout`), and restarts when it names another machine.
 *
 * Unmanaged credentials (written before the `managed` field existed) are left
 * alone: those machines run their own connector, and a second one would take
 * the machine's slot back and forth with it ("replaced").
 *
 * `replaced` and `auth_failed` are terminal for a given credential: the
 * supervisor logs once and waits for relay.json to change rather than
 * reconnecting, which would just repeat the failure (or fight the other
 * connector).
 */

import { statSync } from 'fs'
import { Router } from 'express'
import type { Request } from 'express'
import { RelayConnector } from './connector.js'
import type { ConnectorOptions, ConnectorStatus } from './connector.js'
import type { LocalServerTarget } from './connector-proxy.js'
import { readRelayCredential, relayCredentialPath } from './relay-credential.js'
import type { RelayCredential } from './relay-credential.js'

export type EmbeddedConnectorState =
  /** CODEKIN_RELAY_CONNECTOR=off */
  | 'disabled'
  /** No relay.json */
  | 'unpaired'
  /** Paired, but the connector is run elsewhere (`codekin relay connect`). */
  | 'unmanaged'
  | 'connecting'
  | 'connected'
  /** Lost the relay; the connector is backing off and will retry. */
  | 'disconnected'
  /** Another connector took this machine's slot. Terminal until relay.json changes. */
  | 'replaced'
  /** The relay rejected the credential. Terminal until relay.json changes. */
  | 'auth_failed'
  | 'stopped'

export interface RelayStatus {
  paired: boolean
  managed: boolean
  state: EmbeddedConnectorState
  machineId: string | null
  relayUrl: string | null
  detail?: string
}

export interface ConnectorLike {
  start(): void
  stop(): void
}

export interface EmbeddedConnectorOptions {
  /** Codekin package version, advertised to the hub. */
  version: string
  /** Where to proxy; resolved when a connector starts (default: resolveLocalTarget via RelayConnector). */
  localTarget?: () => LocalServerTarget
  /** Path to relay.json (default ~/.config/codekin/relay.json). */
  credentialFile?: string
  /** How often to re-stat relay.json. */
  pollIntervalMs?: number
  /** True when CODEKIN_RELAY_CONNECTOR=off. */
  disabled?: boolean
  /** Injectable connector, for tests. */
  createConnector?: (opts: ConnectorOptions) => ConnectorLike
  log?: Pick<Console, 'log' | 'warn' | 'error'>
}

export const DEFAULT_POLL_INTERVAL_MS = 5_000

/** Whether the environment opts out of the embedded connector. */
export function embeddedConnectorDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.CODEKIN_RELAY_CONNECTOR ?? '').trim().toLowerCase()
  return value === 'off' || value === 'false' || value === '0'
}

function credentialKey(c: RelayCredential): string {
  return `${c.url}\n${c.machineId}\n${c.machineSecret}`
}

export class EmbeddedConnectorSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null
  private connector: ConnectorLike | null = null
  /** Identity of the current connector; status from any other is ignored. */
  private activeToken: object | null = null
  private runningKey: string | null = null
  /** Credential that ended in replaced/auth_failed; not retried until it changes. */
  private haltedKey: string | null = null
  private fileSignature: string | null = null
  private credential: RelayCredential | null = null
  private state: EmbeddedConnectorState = 'unpaired'
  private detail: string | undefined
  private readonly file: string
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>

  constructor(private readonly opts: EmbeddedConnectorOptions) {
    this.file = opts.credentialFile ?? relayCredentialPath()
    this.log = opts.log ?? console
  }

  start(): void {
    if (this.timer) return
    this.check()
    this.timer = setInterval(() => { this.check() }, this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.stopConnector()
    if (this.credential?.managed && !this.opts.disabled) this.setState('stopped')
  }

  status(): RelayStatus {
    const c = this.credential
    return {
      paired: !!c,
      managed: c?.managed ?? false,
      state: this.state,
      machineId: c?.machineId ?? null,
      relayUrl: c?.url ?? null,
      ...(this.detail ? { detail: this.detail } : {}),
    }
  }

  /** Re-read relay.json if it changed and reconcile the connector. Public for tests. */
  check(): void {
    const signature = this.statSignature()
    if (signature === this.fileSignature) return
    this.fileSignature = signature

    const credential = signature === null ? null : readRelayCredential(this.file)
    this.credential = credential

    if (!credential) {
      if (this.connector) this.log.log('[relay] Pairing credential removed — stopping the embedded connector.')
      this.stopConnector()
      this.haltedKey = null
      this.setState('unpaired')
      return
    }
    if (!credential.managed) {
      this.stopConnector()
      this.setState('unmanaged')
      return
    }
    if (this.opts.disabled) {
      this.setState('disabled')
      return
    }

    const key = credentialKey(credential)
    if (this.connector && key === this.runningKey) return
    if (key === this.haltedKey) return // same credential that was refused/replaced — don't flap
    this.haltedKey = null

    if (this.connector) this.log.log('[relay] Pairing credential changed — restarting the embedded connector.')
    this.stopConnector()
    this.startConnector(credential, key)
  }

  private statSignature(): string | null {
    try {
      const st = statSync(this.file)
      return `${st.mtimeMs}:${st.size}:${st.ino}`
    } catch {
      return null
    }
  }

  private startConnector(credential: RelayCredential, key: string): void {
    const create = this.opts.createConnector ?? ((o: ConnectorOptions) => new RelayConnector(o))
    // Status callbacks from a connector we have since replaced are ignored.
    const token = {}

    const connector = create({
      relayUrl: credential.url,
      machineId: credential.machineId,
      machineSecret: credential.machineSecret,
      connectorVersion: this.opts.version,
      localCodekinVersion: this.opts.version,
      localTarget: this.opts.localTarget?.(),
      onStatus: (status, detail) => {
        if (this.activeToken !== token) return
        this.onConnectorStatus(status, detail, key, credential)
      },
    })
    this.activeToken = token
    this.connector = connector
    this.runningKey = key
    this.setState('connecting')
    this.log.log(`[relay] Starting embedded connector for machine ${credential.machineId} (${credential.url})`)
    connector.start()
  }

  private onConnectorStatus(
    status: ConnectorStatus,
    detail: string | undefined,
    key: string,
    credential: RelayCredential,
  ): void {
    switch (status) {
      case 'connecting':
        // Reconnect attempts keep reporting 'disconnected' until they land.
        if (this.state !== 'disconnected') this.setState('connecting')
        break
      case 'connected':
        if (this.state !== 'connected') this.log.log(`[relay] Machine online as "${detail ?? credential.machineId}"`)
        this.setState('connected', detail)
        break
      case 'disconnected':
      case 'reconnect_scheduled':
        if (this.state === 'connected') this.log.warn(`[relay] Lost the relay connection${detail ? ` (${detail})` : ''}; retrying.`)
        this.setState('disconnected', detail)
        break
      case 'replaced':
        this.log.error(
          `[relay] Another connector took over machine ${credential.machineId}${detail ? ` (${detail})` : ''}. ` +
            'The embedded connector has stopped. If you run `codekin relay connect` separately (e.g. under pm2), ' +
            'stop it, or set CODEKIN_RELAY_CONNECTOR=off to keep using it. Restart Codekin to take the slot back.',
        )
        this.halt(key, 'replaced', detail)
        break
      case 'auth_failed':
        this.log.error(
          `[relay] The relay rejected this machine's credential${detail ? ` (${detail})` : ''}. ` +
            'The machine may have been removed in the hosted app. Run `codekin relay logout` and pair again.',
        )
        this.halt(key, 'auth_failed', detail)
        break
      case 'stopped':
        break
    }
  }

  private halt(key: string, state: 'replaced' | 'auth_failed', detail: string | undefined): void {
    this.haltedKey = key
    this.connector = null
    this.runningKey = null
    this.activeToken = null
    this.setState(state, detail)
  }

  private stopConnector(): void {
    const connector = this.connector
    this.connector = null
    this.runningKey = null
    this.activeToken = null
    connector?.stop()
  }

  private setState(state: EmbeddedConnectorState, detail?: string): void {
    this.state = state
    this.detail = detail
  }
}

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

/**
 * GET /api/relay/status — the embedded connector's state, for the installer
 * and `codekin relay status`. Local-only by design: not on the connector's
 * proxy allowlist, so the hosted relay cannot read it.
 */
export function createRelayStatusRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  supervisor: Pick<EmbeddedConnectorSupervisor, 'status'>,
): Router {
  const router = Router()
  router.get('/api/relay/status', (req, res) => {
    if (!verifyToken(extractToken(req))) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    res.json(supervisor.status())
  })
  return router
}
