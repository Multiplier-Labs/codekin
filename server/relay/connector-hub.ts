/**
 * Connector hub: accepts outbound WebSocket connections from paired
 * machines at /relay/connector, authenticates the hello envelope against
 * machine credentials, tracks online/offline state in the DB, and routes
 * proxied REST requests to a machine's socket.
 *
 * The hub does no policy of its own on request contents — the browser side
 * decides who may talk to a machine, and the connector decides which paths
 * it will serve.
 */

import { randomUUID } from 'crypto'
import { onHubMessage, parseHubEnvelope } from './hub-protocol.js'
import type { WebSocket } from 'ws'
import type Database from 'better-sqlite3'
import { verifyMachineCredential } from './pairing.js'
import {
  ENROLMENT_FEATURE,
  envelope,
  PROXY_REQUEST_TIMEOUT_MS,
  RELAY_ERROR,
  STREAM_CLOSE,
} from './relay-protocol.js'
import { recordAuditEvent } from './audit.js'
import type { SignedIntent } from './intent-actions.js'
import { keyIdForSpki, parseP256Spki } from './machine-identity.js'
import {
  MACHINE_FRAME_LIMIT,
  MAX_CHANNELS_PER_MACHINE,
  RateLimiter,
  isBackedUp,
} from './rate-limit.js'
import { CONNECTOR_FLOORS, connectorUpdateRequired, hasCapability } from './connector-version.js'
import type { ConnectorFloors, UpdateRequired } from './connector-version.js'
import { confirmedDevicesEnforced, getConfirmedDevicesRule, getRequiredCapabilities, requiresPasskeyStepUp } from './workspaces.js'
import type { ConfirmedDevicesRule } from './workspaces.js'
import { isMeterPaused, meterFrame } from './usage-meter.js'
import type { UsageMeter } from './usage-meter.js'
import { isWellFormedStreamData, recordFinding } from './abuse-signals.js'
import type { AbuseFinding, AbuseSignals } from './abuse-signals.js'
import type {
  ConnectorHello,
  ConnectorHelloAck,
  EnrolReplyKind,
  EnrolRequest,
  EnrolRequestKind,
  LocalSessionSummary,
  ProxyRequest,
  ProxyResponse,
  RelayError,
  RelayPrincipal,
} from './relay-protocol.js'

/** Close codes mirroring the local server's WS conventions. */
const CLOSE_AUTH_FAILED = 4001
const CLOSE_REPLACED = 4009

/** A connector that hasn't sent hello within this window is dropped. */
const HELLO_TIMEOUT_MS = 5_000

/** A connector silent for longer than this is considered dead. */
const IDLE_TIMEOUT_MS = 90_000

/** last_seen_at writes are throttled to at most one per interval. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000

/** Cap on requests a single machine may have in flight, to bound hub memory. */
const MAX_PENDING_PER_MACHINE = 64

/** Sent when a machine exceeds its frame budget or stops draining its socket. */
const CLOSE_OVERLOADED = 4029

interface PendingRequest {
  machineId: string
  settle: (outcome: ProxyOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

interface ConnectedMachine {
  machineId: string
  socket: WebSocket
  lastActivity: number
  lastSeenWrite: number
  pending: Set<string>
  channels: Set<string>
  connectorVersion: string | null
  /** The workspace that owns the machine: its traffic is metered there. */
  workspaceId: string | null
  /** Traffic since the last abuse-signal sweep (counted only when a policy is set). */
  window: TrafficWindow
  /** Set when the connector is below a floor: connected, but refused traffic. */
  updateRequired: UpdateRequired | null
  /** Last session counts the connector advertised, if any. */
  sessions: LocalSessionSummary | null
  /** Whether the connector answers enrol_* frames (ENROLMENT_FEATURE). */
  enrolment: boolean
  /** Features the connector advertised (believed only at or above their floors). */
  features: string[]
  /** The intent policy the connector last reported (§6.8), or null if it never did. */
  intentPolicy: IntentPolicyReport | null
  /** The workspace's "Require confirmed devices" (§6.8). */
  rule: ConfirmedDevicesRule | null
  /** Whether the connector's claim of the intents capability is believed (fixed per connection). */
  intentsCapable: boolean
  /** Whether "Require confirmed devices" refused this machine when last evaluated (and the connector was told so). */
  unconfirmed: boolean
  /** The policy last written to the database and audit log, and when (writes are throttled). */
  persistedPolicy: IntentPolicyReport | null
  policyWrittenAt: number
  policyFlush: ReturnType<typeof setTimeout> | null
}

/** At most one stored and audited policy change per machine this often; the latest still applies at once. */
const POLICY_WRITE_INTERVAL_MS = 10_000

type IntentPolicyReport = 'off' | 'warn' | 'required'

const INTENT_POLICY_REPORTS: readonly string[] = ['off', 'warn', 'required']

/** Where a machine stands against its workspace's "Require confirmed devices" (§6.8). */
export type ConfirmedDevicesState =
  /** The workspace doesn't require confirmed devices. */
  | 'not_required'
  /** The machine requires confirmed devices. */
  | 'confirmed'
  /** It doesn't yet, but the workspace's grace period is running: only a warning. */
  | 'grace'
  /** It doesn't, and its traffic is refused until it does. */
  | 'refused'

interface TrafficWindow {
  start: number
  frames: number
  bytes: number
  streamFrames: number
  malformedStreamFrames: number
  largeFrames: number
}

function emptyWindow(now = Date.now()): TrafficWindow {
  return { start: now, frames: 0, bytes: 0, streamFrames: 0, malformedStreamFrames: 0, largeFrames: 0 }
}

export interface ConnectorHubOptions {
  floors?: ConnectorFloors
  meter?: UsageMeter
  /** Abuse-signal policy (docs/RELAY-HARDENING.md §6); no evaluation without one. */
  abuse?: AbuseSignals | null
  /** Called after a sweep that opened flags, e.g. to refresh throttles. */
  onAbuseFlags?: (created: Array<{ machineId: string; flagId: string; finding: AbuseFinding }>) => void
}

/** Frames a channel owner receives from the connector side. */
export type ChannelListener = (
  kind: 'event' | 'stream_data' | 'stream_close' | 'error',
  payload: unknown,
) => void

/** What a proxied request resolves to: the machine's response, or a relay error. */
export type ProxyOutcome = { response: ProxyResponse } | { error: RelayError }

/** What an enrolment frame resolves to: the connector's reply, or a relay error. */
export type EnrolOutcome = { reply: { kind: EnrolReplyKind; payload: unknown } } | { error: RelayError }

/** The connector answers from its own state, so a slow reply means trouble. */
const ENROL_TIMEOUT_MS = 15_000

interface PendingEnrol {
  machineId: string
  /** The reply kind that answers this request. */
  expects: EnrolReplyKind
  settle: (outcome: EnrolOutcome) => void
}

export class ConnectorHub {
  private machines = new Map<string, ConnectedMachine>()
  /** Retain traffic across reconnects; offline records expire after an empty window. */
  private traffic = new Map<string, Pick<ConnectedMachine, 'machineId' | 'workspaceId' | 'connectorVersion' | 'window' | 'sessions'>>()
  private pending = new Map<string, PendingRequest>()
  private pendingEnrol = new Map<string, PendingEnrol>()
  private channelListeners = new Map<string, ChannelListener>()
  /** Per-machine frame budget, so one connector cannot flood the hub. */
  private frameLimiter = new RateLimiter(MACHINE_FRAME_LIMIT)
  private idleTimer: ReturnType<typeof setInterval>

  private readonly floors: ConnectorFloors
  private readonly meter: UsageMeter | undefined
  private readonly abuse: AbuseSignals | null
  private abuseTimer: ReturnType<typeof setInterval> | null = null

  constructor(private db: Database.Database, private options: ConnectorHubOptions = {}) {
    this.floors = options.floors ?? CONNECTOR_FLOORS
    this.meter = options.meter
    this.abuse = options.abuse ?? null
    if (this.abuse) {
      this.abuseTimer = setInterval(() => { this.sweepAbuseSignals() }, this.abuse.windowMs)
      this.abuseTimer.unref()
    }
    // Recovering from a restart: nothing is connected yet.
    this.db.prepare(`UPDATE machines SET status = 'offline'`).run()
    this.idleTimer = setInterval(() => { this.dropIdleConnections(); }, IDLE_TIMEOUT_MS / 3)
    this.idleTimer.unref()
  }

  /** Number of currently connected machines (for tests / health). */
  get onlineCount(): number {
    return this.machines.size
  }

  /** Stream channels open across every connected machine. */
  get channelCount(): number {
    let total = 0
    for (const machine of this.machines.values()) total += machine.channels.size
    return total
  }

  /** Connected machines by connector version, `unknown` when not reported. */
  connectorVersionCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const machine of this.machines.values()) {
      const version = machine.connectorVersion ?? 'unknown'
      counts[version] = (counts[version] ?? 0) + 1
    }
    return counts
  }

  isOnline(machineId: string): boolean {
    return this.machines.has(machineId)
  }

  /** Wire up a fresh /relay/connector socket. */
  handleConnection(socket: WebSocket): void {
    let machineId: string | null = null

    const helloTimeout = setTimeout(() => {
      socket.close(CLOSE_AUTH_FAILED, 'hello timeout')
    }, HELLO_TIMEOUT_MS)

    onHubMessage(socket, data => {
      const msg = parseHubEnvelope(data.toString(), 'connector')
      if (!msg) {
        socket.close(1008, 'invalid relay frame')
        return
      }

      if (machineId === null) {
        if (msg.kind !== 'hello') {
          clearTimeout(helloTimeout)
          socket.close(CLOSE_AUTH_FAILED, 'hello expected')
          return
        }
        const hello = msg.payload as Partial<ConnectorHello>
        if (
          typeof hello.machineId !== 'string' ||
          typeof hello.machineSecret !== 'string' ||
          !verifyMachineCredential(this.db, hello.machineId, hello.machineSecret)
        ) {
          clearTimeout(helloTimeout)
          socket.close(CLOSE_AUTH_FAILED, 'invalid machine credential')
          return
        }
        clearTimeout(helloTimeout)
        machineId = hello.machineId
        this.registerMachine(machineId, socket, hello)
        return
      }

      if (!this.frameLimiter.tryConsume(machineId)) {
        socket.close(CLOSE_OVERLOADED, 'frame rate limit exceeded')
        return
      }

      const machine = this.machines.get(machineId)
      // A replaced or revoked socket cannot act as the new connection.
      if (!machine || machine.socket !== socket) return
      machine.lastActivity = Date.now()
      this.touchLastSeen(machine)
      const bytes = data.length
      if (machine.workspaceId) meterFrame(this.meter, socket, machine.workspaceId, 'm2b', bytes)
      this.countTraffic(machine, bytes)
      if (msg.kind === 'stream_data' && this.abuse?.inspectStreamFrames) {
        machine.window.streamFrames += 1
        if (!isWellFormedStreamData((msg.payload as { data?: unknown } | null)?.data)) machine.window.malformedStreamFrames += 1
      }
      if (msg.channelId && !machine.channels.has(msg.channelId)) return
      if (msg.kind === 'ping') {
        socket.send(JSON.stringify(envelope('pong', {})))
      } else if (msg.kind === 'response') {
        this.settleResponse(machineId, msg.id, msg.kind, msg.payload)
      } else if (msg.kind === 'enrol_challenge' || msg.kind === 'enrol_result') {
        this.settleEnrol(machineId, msg.id, msg.kind, msg.payload)
      } else if (msg.kind === 'error') {
        // An error envelope answers either a request (id) or a channel.
        if (msg.channelId) this.channelListeners.get(msg.channelId)?.(msg.kind, msg.payload)
        else if (msg.id && this.pendingEnrol.has(msg.id)) this.settleEnrol(machineId, msg.id, msg.kind, msg.payload)
        else this.settleResponse(machineId, msg.id, msg.kind, msg.payload)
      } else if (msg.kind === 'intent_policy') {
        this.recordIntentPolicy(machine, (msg.payload as { policy?: unknown }).policy)
      } else if (msg.kind === 'event' && !msg.channelId) {
        // Machine-level event: currently only the session summary (§11.3).
        const payload = msg.payload as { sessions?: LocalSessionSummary }
        if (payload.sessions) {
          machine.sessions = payload.sessions
          const traffic = this.traffic.get(machineId)
          if (traffic) traffic.sessions = payload.sessions
        }
      } else if (msg.kind === 'event' || msg.kind === 'stream_data' || msg.kind === 'stream_close') {
        if (msg.channelId) this.channelListeners.get(msg.channelId)?.(msg.kind, msg.payload)
      }
    })

    socket.on('close', () => {
      clearTimeout(helloTimeout)
      if (machineId !== null && this.machines.get(machineId)?.socket === socket) {
        const machine = this.machines.get(machineId)!
        this.machines.delete(machineId)
        this.failPending(machine, 'connector disconnected')
        this.setStatus(machineId, 'offline')
        recordAuditEvent(this.db, { kind: 'machine_disconnected', machineId })
      }
    })

    socket.on('error', () => {
      // close follows; nothing to do
    })
  }

  /**
   * Send a proxied REST request to a machine and await its response.
   *
   * Never rejects: transport problems come back as a `RelayError` so callers
   * can relay one consistent shape to the browser.
   */
  sendRequest(machineId: string, request: ProxyRequest, timeoutMs = PROXY_REQUEST_TIMEOUT_MS): Promise<ProxyOutcome> {
    const machine = this.machines.get(machineId)
    if (!machine) {
      return Promise.resolve({
        error: { code: RELAY_ERROR.machineOffline, message: 'Machine is not connected' },
      })
    }
    if (machine.updateRequired) {
      return Promise.resolve({ error: updateRequiredError(machine.updateRequired) })
    }
    const unconfirmed = this.confirmedDevicesRefusal(machine)
    if (unconfirmed) return Promise.resolve({ error: unconfirmed.error })
    if (machine.pending.size >= MAX_PENDING_PER_MACHINE) {
      return Promise.resolve({
        error: { code: RELAY_ERROR.badRequest, message: 'Too many requests in flight for this machine' },
      })
    }

    const id = randomUUID()
    return new Promise<ProxyOutcome>(resolve => {
      let settled = false
      const settle = (outcome: ProxyOutcome) => {
        if (settled) return
        settled = true
        const entry = this.pending.get(id)
        if (entry) clearTimeout(entry.timer)
        this.pending.delete(id)
        machine.pending.delete(id)
        resolve(outcome)
      }

      const timer = setTimeout(() => {
        settle({ error: { code: RELAY_ERROR.timeout, message: 'Machine did not respond in time' } })
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(id, { machineId, settle, timer })
      machine.pending.add(id)

      try {
        const frame = JSON.stringify(envelope('request', request, { id }))
        this.countTraffic(machine, Buffer.byteLength(frame))
        machine.socket.send(frame)
      } catch (err) {
        settle({
          error: {
            code: RELAY_ERROR.machineOffline,
            message: `Could not reach machine: ${err instanceof Error ? err.message : String(err)}`,
          },
        })
      }
    })
  }

  /**
   * The workspace's "Require confirmed devices" changed (§6.8): apply it to
   * its connected machines at once, and tell each one where it stands.
   */
  applyConfirmedDevicesRule(workspaceId: string, rule: ConfirmedDevicesRule): void {
    for (const machine of this.machines.values()) {
      if (machine.workspaceId !== workspaceId) continue
      machine.rule = rule
      this.reevaluate(machine)
    }
  }

  /** Where a machine stands against its workspace's "Require confirmed devices". */
  confirmedDevicesState(machineId: string, now = Date.now()): ConfirmedDevicesState {
    const machine = this.machines.get(machineId)
    if (!machine?.rule?.required) return 'not_required'
    if (this.meetsConfirmedDevices(machine)) return 'confirmed'
    return confirmedDevicesEnforced(machine.rule, now) ? 'refused' : 'grace'
  }

  /** The policy a connected machine last reported (§6.8). */
  intentPolicy(machineId: string): IntentPolicyReport | null {
    return this.machines.get(machineId)?.intentPolicy ?? null
  }

  private meetsConfirmedDevices(machine: ConnectedMachine): boolean {
    return machine.intentsCapable && machine.intentPolicy === 'required'
  }

  /** Whether a connected machine's connector can enforce signed intents (believed at or above the floor). */
  intentsSupported(machineId: string): boolean {
    return this.machines.get(machineId)?.intentsCapable ?? false
  }

  /**
   * Why the workspace's "Require confirmed devices" refuses this machine, if
   * it does. The report comes from the machine's own connector, so a forged
   * one only weakens that owner's own machine (§6.8).
   */
  private confirmedDevicesRefusal(machine: ConnectedMachine, now = Date.now()): { error: RelayError; enrolmentAllowed: boolean } | null {
    if (!confirmedDevicesEnforced(machine.rule, now) || this.meetsConfirmedDevices(machine)) return null
    if (!machine.intentsCapable) {
      const minimum = this.floors.capabilities.intents
      return {
        error: {
          code: RELAY_ERROR.connectorUpdateRequired,
          message: `This machine needs Codekin ${minimum ?? 'a newer version'} or later: the workspace requires confirmed devices`,
        },
        enrolmentAllowed: false,
      }
    }
    return {
      error: { code: RELAY_ERROR.devicesUnconfirmed, message: 'The workspace requires confirmed devices: confirm a browser on this computer' },
      enrolmentAllowed: true,
    }
  }

  /**
   * Re-apply "Require confirmed devices" after anything it depends on
   * changed (the rule, the reported policy, a grace period running out).
   * Becoming refused closes the machine's open channels at once, so a
   * session opened before can't carry on; the connector is told either way,
   * for its status line, but only when it changes.
   */
  private reevaluate(machine: ConnectedMachine): void {
    const refused = this.confirmedDevicesRefusal(machine) !== null
    if (refused === machine.unconfirmed) return
    machine.unconfirmed = refused
    if (refused) {
      for (const channelId of [...machine.channels]) {
        this.dropChannel(machine, channelId, 'the workspace requires confirmed devices: confirm a browser on this computer')
      }
    }
    if (!machine.updateRequired && machine.socket.readyState === machine.socket.OPEN) {
      machine.socket.send(JSON.stringify(envelope('event', { unconfirmed: refused })))
    }
  }

  /** Tell the connected machines of a workspace that its intent policy changed (signed-intents spec §6.6). */
  announceWorkspacePolicy(workspaceId: string, policy: { requirePasskeyStepUp: boolean }): void {
    for (const machine of this.machines.values()) {
      if (machine.workspaceId !== workspaceId || machine.socket.readyState !== machine.socket.OPEN) continue
      machine.socket.send(JSON.stringify(envelope('event', policy)))
    }
  }

  /**
   * Forward one enrolment frame (signed-intents spec §5.2) to a machine and
   * await its reply. The connector does every check that matters; the hub
   * only routes, so it can drop or delay these frames but not forge them.
   */
  sendEnrolment(machineId: string, kind: EnrolRequestKind, request: EnrolRequest): Promise<EnrolOutcome> {
    const machine = this.machines.get(machineId)
    if (!machine) return Promise.resolve({ error: { code: RELAY_ERROR.machineOffline, message: 'Machine is not connected' } })
    if (machine.updateRequired) return Promise.resolve({ error: updateRequiredError(machine.updateRequired) })
    // A machine refused only for not yet requiring confirmed devices must
    // still be able to confirm one: that is how it clears the refusal.
    const unconfirmed = this.confirmedDevicesRefusal(machine)
    if (unconfirmed && !unconfirmed.enrolmentAllowed) return Promise.resolve({ error: unconfirmed.error })
    if (!machine.enrolment) {
      return Promise.resolve({
        error: { code: RELAY_ERROR.connectorUpdateRequired, message: 'Update Codekin on this computer to confirm browsers on it' },
      })
    }
    if (machine.pending.size >= MAX_PENDING_PER_MACHINE) {
      return Promise.resolve({ error: { code: RELAY_ERROR.badRequest, message: 'Too many requests in flight for this machine' } })
    }
    const id = randomUUID()
    return new Promise<EnrolOutcome>(resolve => {
      const timer = setTimeout(() => {
        settle({ error: { code: RELAY_ERROR.timeout, message: 'Machine did not respond in time' } })
      }, ENROL_TIMEOUT_MS)
      timer.unref()
      const settle = (outcome: EnrolOutcome) => {
        if (!this.pendingEnrol.delete(id)) return
        clearTimeout(timer)
        machine.pending.delete(id)
        resolve(outcome)
      }
      this.pendingEnrol.set(id, { machineId, expects: kind === 'enrol_commit' ? 'enrol_challenge' : 'enrol_result', settle })
      machine.pending.add(id)
      try {
        const frame = JSON.stringify(envelope(kind, request, { id }))
        this.countTraffic(machine, Buffer.byteLength(frame))
        machine.socket.send(frame)
      } catch (err) {
        settle({ error: { code: RELAY_ERROR.machineOffline, message: `Could not reach machine: ${err instanceof Error ? err.message : String(err)}` } })
      }
    })
  }

  /** Route an enrolment reply (or error) to its waiting caller, if it is the reply that request expects. */
  private settleEnrol(machineId: string, id: string | undefined, kind: EnrolReplyKind | 'error', payload: unknown): void {
    if (!id) return
    const entry = this.pendingEnrol.get(id)
    if (!entry || entry.machineId !== machineId) return
    if (kind === 'error') {
      const err = payload as Partial<RelayError>
      entry.settle({ error: {
        code: typeof err.code === 'string' ? err.code : RELAY_ERROR.badRequest,
        message: typeof err.message === 'string' ? err.message : 'Machine reported an error',
      } })
      return
    }
    if (kind !== entry.expects) return
    entry.settle({ reply: { kind, payload } })
  }

  /**
   * Open a stream channel on a machine. The caller owns `channelId` and is
   * responsible for closing the channel; frames from the connector arrive on
   * `listener` until then.
   */
  openChannel(
    machineId: string,
    channelId: string,
    listener: ChannelListener,
    principal?: RelayPrincipal,
    intent?: SignedIntent,
  ): RelayError | null {
    const machine = this.machines.get(machineId)
    if (!machine) return { code: RELAY_ERROR.machineOffline, message: 'Machine is not connected' }
    if (machine.updateRequired) return updateRequiredError(machine.updateRequired)
    const unconfirmed = this.confirmedDevicesRefusal(machine)
    if (unconfirmed) return unconfirmed.error
    if (machine.channels.size >= MAX_CHANNELS_PER_MACHINE) {
      return { code: RELAY_ERROR.tooManyChannels, message: 'This machine is serving too many sessions' }
    }
    // A connector that has stopped draining is already in trouble; adding
    // another stream would only grow the backlog.
    if (isBackedUp(machine.socket)) {
      return { code: RELAY_ERROR.tooManyChannels, message: 'Machine connection is congested' }
    }

    this.channelListeners.set(channelId, listener)
    machine.channels.add(channelId)
    machine.socket.send(JSON.stringify(envelope('stream_open', { principal, ...(intent ? { intent } : {}) }, { channelId })))
    return null
  }

  /**
   * Relay a browser frame onto an open channel.
   *
   * The mirror of the browser-side check in BrowserHub: a connector that has
   * stopped draining accumulates its backlog in this process. The frame
   * limiter caps how many frames a browser may send, not how large they are,
   * so the byte ceiling has to be enforced here too — drop the channel rather
   * than the hub's memory.
   */
  sendChannelData(machineId: string, channelId: string, data: string, intent?: SignedIntent): boolean {
    const machine = this.machines.get(machineId)
    if (!machine || machine.socket.readyState !== machine.socket.OPEN || !machine.channels.has(channelId)) return false
    // A grace period may have run out since the channel opened.
    if (machine.rule?.required && !machine.unconfirmed) this.reevaluate(machine)
    if (!machine.channels.has(channelId)) return false
    if (isBackedUp(machine.socket)) {
      this.dropChannel(machine, channelId, 'machine connection is congested')
      return false
    }
    const frame = JSON.stringify(envelope('stream_data', intent ? { data, intent } : { data }, { channelId }))
    this.countTraffic(machine, Buffer.byteLength(frame))
    machine.socket.send(frame)
    return true
  }

  /**
   * Tear down one channel from the hub's side and tell both ends.
   * The listener's own cleanup calls back into closeChannel, which no-ops
   * once the channel is gone from the machine.
   */
  private dropChannel(machine: ConnectedMachine, channelId: string, reason: string): void {
    machine.channels.delete(channelId)
    const listener = this.channelListeners.get(channelId)
    this.channelListeners.delete(channelId)
    if (machine.socket.readyState === machine.socket.OPEN) {
      machine.socket.send(
        JSON.stringify(envelope('stream_close', { code: STREAM_CLOSE.normal, reason }, { channelId })),
      )
    }
    listener?.('stream_close', { code: STREAM_CLOSE.normal, reason })
  }

  /** Close a channel and stop listening on it. */
  closeChannel(machineId: string, channelId: string, code?: number, reason?: string): void {
    this.channelListeners.delete(channelId)
    const machine = this.machines.get(machineId)
    if (!machine || !machine.channels.delete(channelId)) return
    if (machine.socket.readyState === machine.socket.OPEN) {
      machine.socket.send(JSON.stringify(envelope('stream_close', { code, reason }, { channelId })))
    }
  }

  /** Route a `response`/`error` envelope back to its waiting caller. */
  private settleResponse(machineId: string, id: string | undefined, kind: 'response' | 'error', payload: unknown): void {
    if (!id) return
    const entry = this.pending.get(id)
    // A response for another machine's id means a confused or hostile
    // connector; drop it rather than letting it answer someone else's call.
    if (!entry || entry.machineId !== machineId) return
    if (kind === 'error') {
      const err = payload as Partial<RelayError>
      entry.settle({
        error: {
          code: typeof err.code === 'string' ? err.code : RELAY_ERROR.badRequest,
          message: typeof err.message === 'string' ? err.message : 'Machine reported an error',
          // Intent refusals (validated in hub-protocol.ts) pass through.
          ...(typeof err.detail === 'string' ? { detail: err.detail } : {}),
          ...(typeof err.intentNonce === 'string' ? { intentNonce: err.intentNonce } : {}),
          ...(typeof err.machineTime === 'number' ? { machineTime: err.machineTime } : {}),
          ...(typeof err.machineTimeSig === 'string' ? { machineTimeSig: err.machineTimeSig } : {}),
          ...(Array.isArray(err.stepUpPasskeys) ? { stepUpPasskeys: err.stepUpPasskeys } : {}),
        },
      })
      return
    }
    entry.settle({ response: payload as ProxyResponse })
  }

  /** Fail everything riding on a machine that just went away. */
  private failPending(machine: ConnectedMachine, reason: string): void {
    // A throttled policy write still due goes out now, rather than being lost.
    if (machine.policyFlush) this.persistPolicy(machine)
    for (const id of [...machine.pending]) {
      this.pending.get(id)?.settle({ error: { code: RELAY_ERROR.machineOffline, message: reason } })
      this.pendingEnrol.get(id)?.settle({ error: { code: RELAY_ERROR.machineOffline, message: reason } })
    }
    for (const channelId of [...machine.channels]) {
      machine.channels.delete(channelId)
      const listener = this.channelListeners.get(channelId)
      this.channelListeners.delete(channelId)
      listener?.('stream_close', { code: STREAM_CLOSE.machineGone, reason })
    }
  }

  private registerMachine(machineId: string, socket: WebSocket, hello: Partial<ConnectorHello>): void {
    // A reconnect may race the old socket's close — the new connection wins.
    const existing = this.machines.get(machineId)
    if (existing && existing.socket !== socket) {
      existing.socket.close(CLOSE_REPLACED, 'replaced by new connection')
      this.machines.delete(machineId)
      this.failPending(existing, 'connector reconnected')
    }

    const now = Date.now()
    const connectorVersion = hello.connectorVersion ?? null
    const features = Array.isArray(hello.capabilities?.features)
      ? hello.capabilities.features.filter((f): f is string => typeof f === 'string')
      : []
    const workspace = this.db.prepare('SELECT workspace_id FROM machines WHERE id = ?').get(machineId) as
      | { workspace_id: string }
      | undefined
    const required = workspace ? getRequiredCapabilities(this.db, workspace.workspace_id) : []
    const updateRequired = connectorUpdateRequired(connectorVersion, features, required, this.floors)
    this.machines.set(machineId, {
      machineId, socket, lastActivity: now, lastSeenWrite: now,
      pending: new Set(), channels: new Set(),
      connectorVersion,
      workspaceId: workspace?.workspace_id ?? null,
      window: this.traffic.get(machineId)?.window ?? emptyWindow(now),
      updateRequired,
      sessions: hello.sessions ?? null,
      enrolment: features.includes(ENROLMENT_FEATURE),
      features,
      intentPolicy: isIntentPolicyReport(hello.intentPolicy) ? hello.intentPolicy : null,
      rule: workspace ? getConfirmedDevicesRule(this.db, workspace.workspace_id) : null,
      intentsCapable: hasCapability(connectorVersion, features, 'intents', this.floors),
      unconfirmed: false,
      persistedPolicy: isIntentPolicyReport(hello.intentPolicy) ? hello.intentPolicy : null,
      policyWrittenAt: now,
      policyFlush: null,
    })
    const added = this.machines.get(machineId)
    if (added) added.unconfirmed = this.confirmedDevicesRefusal(added) !== null

    const registered = this.machines.get(machineId)
    if (this.abuse && registered) {
      this.traffic.set(machineId, {
        machineId, workspaceId: registered.workspaceId, connectorVersion,
        window: registered.window, sessions: registered.sessions,
      })
    }

    this.db.prepare(
      `UPDATE machines SET status = 'online', last_seen_at = datetime('now'),
         connector_version = COALESCE(?, connector_version),
         local_codekin_version = COALESCE(?, local_codekin_version),
         intent_policy = ?
       WHERE id = ?`,
    ).run(hello.connectorVersion ?? null, hello.localCodekinVersion ?? null, registered?.intentPolicy ?? null, machineId)

    const row = this.db.prepare('SELECT display_name, owner_user_id, identity_key FROM machines WHERE id = ?').get(machineId) as
      | { display_name: string; owner_user_id: string; identity_key: string | null }
      | undefined
    // The machine identity key is only a hint for browsers (they pin theirs
    // at enrolment), so a connector may replace it, but the change is audited.
    const identityKey = parseP256Spki(hello.identityKey)
    const identityChanged = !!identityKey && identityKey !== (row?.identity_key ?? null)
    if (identityChanged) {
      this.db.prepare('UPDATE machines SET identity_key = ? WHERE id = ?').run(identityKey, machineId)
    }
    recordAuditEvent(this.db, {
      kind: 'machine_connected',
      machineId,
      metadata: {
        connectorVersion: hello.connectorVersion ?? null,
        ...(identityKey ? { identityKeyId: keyIdForSpki(identityKey) } : {}),
        ...(identityChanged && row?.identity_key ? { identityKeyChanged: true } : {}),
        ...(updateRequired ? { updateRequiredMinimum: updateRequired.minimum, updateRequiredMissing: updateRequired.missing.join(',') } : {}),
      },
    })

    if (updateRequired) {
      console.warn(`[relay] machine ${machineId} needs connector ${updateRequired.minimum} or later: ${updateRequired.reason}`)
    }

    // Below a floor the socket stays open: old connectors treat most closes
    // as "reconnect", so closing would only start a loop. Traffic is refused
    // in sendRequest/openChannel instead.
    const ack: ConnectorHelloAck = { machineId, displayName: row?.display_name ?? 'Machine' }
    if (row?.owner_user_id) ack.ownerUserId = row.owner_user_id
    if (workspace && requiresPasskeyStepUp(this.db, workspace.workspace_id)) ack.requirePasskeyStepUp = true
    if (updateRequired) ack.updateRequired = updateRequired
    if (registered && !updateRequired && registered.unconfirmed) ack.unconfirmed = true
    ack.policyReports = true
    socket.send(JSON.stringify(envelope('hello_ack', ack)))
  }

  /** The connector reported a policy change (§6.8). */
  private recordIntentPolicy(machine: ConnectedMachine, policy: unknown): void {
    if (!isIntentPolicyReport(policy) || policy === machine.intentPolicy) return
    // Applies at once; storing and auditing it is throttled, so a connector
    // flipping its report can't flood the database or the audit log.
    machine.intentPolicy = policy
    this.reevaluate(machine)
    const wait = machine.policyWrittenAt + POLICY_WRITE_INTERVAL_MS - Date.now()
    if (wait <= 0) this.persistPolicy(machine)
    else machine.policyFlush ??= setTimeout(() => { this.persistPolicy(machine) }, wait)
  }

  private persistPolicy(machine: ConnectedMachine): void {
    if (machine.policyFlush) { clearTimeout(machine.policyFlush); machine.policyFlush = null }
    machine.policyWrittenAt = Date.now()
    const policy = machine.intentPolicy
    if (policy === machine.persistedPolicy) return
    const previous = machine.persistedPolicy
    machine.persistedPolicy = policy
    this.db.prepare('UPDATE machines SET intent_policy = ? WHERE id = ?').run(policy, machine.machineId)
    recordAuditEvent(this.db, { kind: 'machine_policy_changed', machineId: machine.machineId, metadata: { from: previous, to: policy } })
  }

  private setStatus(machineId: string, status: 'online' | 'offline' | 'degraded'): void {
    this.db.prepare(
      `UPDATE machines SET status = ?, last_seen_at = datetime('now') WHERE id = ?`,
    ).run(status, machineId)
  }

  private touchLastSeen(machine: ConnectedMachine): void {
    const now = Date.now()
    if (now - machine.lastSeenWrite >= LAST_SEEN_WRITE_INTERVAL_MS) {
      machine.lastSeenWrite = now
      this.db.prepare(`UPDATE machines SET last_seen_at = datetime('now') WHERE id = ?`).run(machine.machineId)
    }
  }

  private dropIdleConnections(): void {
    // Also where a running-out grace period starts refusing machines that sent nothing since.
    for (const machine of this.machines.values()) if (machine.rule?.required) this.reevaluate(machine)
    const cutoff = Date.now() - IDLE_TIMEOUT_MS
    for (const machine of [...this.machines.values()]) {
      if (isMeterPaused(machine.socket)) { machine.lastActivity = Date.now(); continue }
      if (machine.lastActivity < cutoff) {
        machine.socket.close(CLOSE_AUTH_FAILED, 'idle timeout')
      }
    }
  }

  /** Disconnect everything and stop timers (shutdown / tests). */
  /** Why a connected machine is refused traffic until its connector is updated, if it is. */
  updateRequired(machineId: string): UpdateRequired | null {
    return this.machines.get(machineId)?.updateRequired ?? null
  }

  /** Session counts a machine advertised at connect time (spec §11.3). */
  sessionSummary(machineId: string): LocalSessionSummary | null {
    return this.machines.get(machineId)?.sessions ?? null
  }

  /**
   * Forcibly drop a machine's connection (unpaired / credential revoked).
   * Credentials are checked at connect time only, so without this a removed
   * machine's live socket would keep serving until it next reconnected.
   */
  disconnectMachine(machineId: string, reason = 'machine removed'): void {
    const machine = this.machines.get(machineId)
    if (!machine) return
    this.machines.delete(machineId)
    this.failPending(machine, reason)
    // The close handler skips this once the map entry is gone, so mark the
    // row offline here in case it outlives the connection.
    this.setStatus(machineId, 'offline')
    machine.socket.close(CLOSE_AUTH_FAILED, reason)
    recordAuditEvent(this.db, { kind: 'machine_disconnected', machineId, metadata: { reason } })
  }

  /** Add one frame to a machine's abuse-signal window (no-op without a policy). */
  private countTraffic(machine: ConnectedMachine, bytes: number): void {
    if (!this.abuse) return
    machine.window.frames += 1
    machine.window.bytes += bytes
    if (this.abuse.largeFrameBytes > 0 && bytes >= this.abuse.largeFrameBytes) machine.window.largeFrames += 1
  }

  /**
   * Hand every connected machine's traffic window to the abuse policy, record
   * what it finds, and start new windows. Runs on a timer; exposed for tests.
   */
  sweepAbuseSignals(now = Date.now()): void {
    if (!this.abuse) return
    const created: Array<{ machineId: string; flagId: string; finding: AbuseFinding }> = []
    for (const machine of this.traffic.values()) {
      const w = machine.window
      machine.window = emptyWindow(now)
      const connected = this.machines.get(machine.machineId)
      if (connected) connected.window = machine.window
      const findings = this.abuse.evaluate({
        machineId: machine.machineId,
        workspaceId: machine.workspaceId,
        connectorVersion: machine.connectorVersion,
        windowSeconds: Math.max(1, (now - w.start) / 1000),
        frames: w.frames,
        bytes: w.bytes,
        streamFrames: w.streamFrames,
        malformedStreamFrames: w.malformedStreamFrames,
        largeFrames: w.largeFrames,
        sessionsAdvertised: machine.sessions?.total ?? null,
      })
      if (!connected && w.frames === 0) {
        this.traffic.delete(machine.machineId)
        this.abuse.forget?.(machine.machineId)
      }
      for (const finding of findings) {
        const flagId = recordFinding(this.db, machine.machineId, finding)
        if (flagId) {
          console.warn(`[relay] abuse signal ${finding.signal} on machine ${machine.machineId}: ${finding.action}`)
          created.push({ machineId: machine.machineId, flagId, finding })
        }
      }
    }
    if (created.length > 0) this.options.onAbuseFlags?.(created)
  }

  close(): void {
    clearInterval(this.idleTimer)
    if (this.abuseTimer) clearInterval(this.abuseTimer)
    this.frameLimiter.close()
    for (const machine of this.machines.values()) {
      this.failPending(machine, 'relay shutting down')
      machine.socket.close(1001, 'server shutting down')
    }
    this.machines.clear()
    for (const id of this.traffic.keys()) this.abuse?.forget?.(id)
    this.traffic.clear()
  }
}

function isIntentPolicyReport(value: unknown): value is IntentPolicyReport {
  return typeof value === 'string' && INTENT_POLICY_REPORTS.includes(value)
}

function updateRequiredError(update: UpdateRequired): RelayError {
  return {
    code: RELAY_ERROR.connectorUpdateRequired,
    message: `This machine needs Codekin ${update.minimum} or later: ${update.reason}`,
  }
}
