# Hosted Relay & Control Plane

**Status**: Draft architecture spec
**Goal**: Let team members use Codekin from a hosted web app while keeping coding agents, subscriptions, credentials, repositories, and command execution on each developer's local machine.

---

## 1. Problem

Codekin currently runs as a local web app. That is the right execution model for technical users because Claude Code, Codex, OpenCode, Git, repo files, SSH keys, package managers, and MCP/tool credentials already live on their machines.

The friction is for non-technical teammates:

- They should not need to install Node, run a daemon, manage ports, or expose localhost.
- They should be able to open a hosted URL and collaborate in a browser.
- Their interactions should still operate through the developer's local agent setup, not through a shared server account.

The hosted product must therefore be a control plane and relay, not a remote code execution host.

---

## 2. Non-Goals

- Do not copy developer Claude, Codex, OpenCode, GitHub, SSH, npm, cloud, or MCP credentials into the hosted service.
- Do not require repos to be cloned onto Codekin-hosted infrastructure for normal interactive sessions.
- Do not make browser clients connect directly to developer laptops.
- Do not require inbound ports, manual router setup, or per-user reverse proxy configuration.
- Do not replace local Codekin; hosted Codekin coordinates and relays to it.

---

## 3. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         Hosted Codekin                             │
│                                                                    │
│  ┌──────────────────┐     ┌──────────────────┐     ┌────────────┐ │
│  │ Hosted Frontend  │────▶│ Control Plane API │────▶│ Relay Hub   │ │
│  └──────────────────┘     └──────────────────┘     └─────┬──────┘ │
│             ▲                         ▲                   │        │
│             │                         │                   │        │
│             │                         │                   │        │
│       Browser users              SSO / ACLs          Outbound WSS  │
└─────────────┼─────────────────────────┼───────────────────┼────────┘
              │                         │                   │
              │                         │                   ▼
              │                 ┌───────────────────────────────────┐
              │                 │ Developer machine                  │
              │                 │                                   │
              │                 │  ┌─────────────────────────────┐  │
              └─────────────────┼─▶│ Codekin Local Connector      │  │
                                │  └──────────────┬──────────────┘  │
                                │                 │ localhost       │
                                │                 ▼                 │
                                │  ┌─────────────────────────────┐  │
                                │  │ Local Codekin Server         │  │
                                │  │ - REST API                   │  │
                                │  │ - WebSocket session stream   │  │
                                │  │ - SessionManager             │  │
                                │  └──────────────┬──────────────┘  │
                                │                 │                 │
                                │                 ▼                 │
                                │  ┌─────────────────────────────┐  │
                                │  │ Local tools and data         │  │
                                │  │ claude / codex / opencode    │  │
                                │  │ repos / git / shell / MCP     │  │
                                │  └─────────────────────────────┘  │
                                └───────────────────────────────────┘
```

Hosted Codekin owns identity, sharing, routing, audit metadata, and relay availability. The local machine owns model auth, repo access, tool execution, file uploads, session state, and approval execution.

---

## 4. Components

### 4.1 Hosted Frontend

The hosted frontend is the browser app users open at a team URL.

Responsibilities:

- Authenticate through the hosted control plane.
- Show machines, repos, sessions, and shared sessions the current user can access.
- Route REST-like operations and session streams through the hosted relay.
- Preserve the existing Codekin chat, approvals, diff, archive, workflow, and orchestrator views where possible.

The frontend should not know local daemon tokens. It should hold only a hosted session token scoped to the signed-in user.

### 4.2 Control Plane API

The control plane is the authoritative hosted service for team-level metadata.

Responsibilities:

- User authentication and authorization.
- Organization/team membership.
- Machine registration and device pairing.
- Session sharing policies.
- Relay target selection.
- Audit log metadata.
- Connector health, version, and capability inventory.

It should not proxy file contents or chat transcripts through normal REST persistence unless explicitly enabled by policy. The default should be metadata-only retention.

### 4.3 Relay Hub

The relay hub is a bidirectional message router between browser clients and local connectors.

Responsibilities:

- Accept outbound WebSocket connections from local connectors.
- Accept browser WebSocket connections from hosted users.
- Multiplex request/response calls and streaming session channels.
- Enforce ACL checks before binding a browser channel to a connector channel.
- Apply rate limits, heartbeat checks, backpressure, and message size limits.
- Avoid interpreting provider-specific stream payloads where possible.

The relay is not an agent runtime. It should not spawn Claude, Codex, OpenCode, shells, or Git commands.

### 4.4 Local Connector

The local connector runs on the developer's machine. It can be implemented as part of `codekin` CLI/service rather than a separate binary.

Responsibilities:

- Pair with the hosted control plane.
- Maintain an outbound `wss://` connection to the relay hub.
- Advertise local capabilities: Codekin version, providers, provider auth state, repos, OS, and feature flags.
- Forward authorized hosted requests to the local Codekin server.
- Relay local Codekin WebSocket streams back to the hosted browser.
- Enforce local allow/deny policies before executing sensitive operations.

The connector should communicate with local Codekin over `http://127.0.0.1:<port>` and authenticate with the existing local Codekin bearer token from `~/.config/codekin/token`.

### 4.5 Local Codekin Server

The local Codekin server remains responsible for:

- Session lifecycle.
- Provider process lifecycle.
- Local repo discovery and path validation.
- File uploads to local disk.
- Tool approvals.
- Diff generation.
- Archived session storage.
- Workflow and orchestrator execution.

The first implementation should avoid changing provider process adapters except where new relay metadata needs to surface in session records or audit events.

---

## 5. Trust Boundaries

### 5.1 Hosted Service Can See

By default the hosted relay can observe relayed prompts, responses, file path metadata, tool requests, and approval decisions because it transports the stream. That is acceptable for a trusted internal deployment, but must be explicit in product/security docs.

Hosted persistence should be minimized:

- Persist account, machine, ACL, and audit metadata.
- Do not persist full chat transcripts by default.
- Do not persist file contents by default.
- Do not persist local Codekin bearer tokens.
- Do not persist provider credentials.

### 5.2 Local Machine Can Enforce

The local connector must remain the last authorization boundary before local execution.

Examples:

- A hosted user may be allowed to view a session but not send prompts.
- A hosted user may be allowed to send prompts but not answer shell approvals.
- A hosted user may be allowed to approve read-only commands but not mutating commands.
- A developer may pause sharing or disconnect their machine at any time.

### 5.3 Browser User Can Influence

Any user with write access to a session can influence code and command execution on the connected developer machine. That is equivalent to granting them remote agent input access and must be visible in the UI.

---

## 6. Identity, Pairing, and Access Control

### 6.1 User Identity

Hosted Codekin should use organization SSO. Initial provider can be GitHub OAuth or Google Workspace; the model should support additional OIDC providers later.

Core entities:

```typescript
interface Organization {
  id: string
  name: string
}

interface User {
  id: string
  organizationId: string
  email: string
  displayName: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
}
```

### 6.2 Machine Pairing

Pairing flow:

1. Developer runs `codekin relay login`.
2. CLI opens a browser/device-code flow.
3. Hosted control plane issues a machine credential.
4. CLI stores the credential in `~/.config/codekin/relay.json`.
5. `codekin relay connect` starts the outbound relay connection.

Machine entity:

```typescript
interface Machine {
  id: string
  organizationId: string
  ownerUserId: string
  displayName: string
  hostname: string
  platform: 'darwin' | 'linux'
  connectorVersion: string
  localCodekinVersion: string
  status: 'online' | 'offline' | 'degraded'
  lastSeenAt: string
}
```

### 6.3 Session ACLs

```typescript
interface SessionShare {
  id: string
  organizationId: string
  machineId: string
  localSessionId: string
  sharedByUserId: string
  granteeUserId?: string
  granteeGroupId?: string
  permissions: SessionPermission[]
  createdAt: string
  expiresAt?: string
}

type SessionPermission =
  | 'view'
  | 'send_prompt'
  | 'upload_file'
  | 'view_diff'
  | 'approve_readonly_tool'
  | 'approve_mutating_tool'
  | 'approve_shell'
  | 'stop_session'
```

Default policy should be owner-only. Sharing should be explicit per session or per repo.

---

## 7. Relay Protocol

Use a single WebSocket transport in both directions:

- Browser to relay hub.
- Connector to relay hub.

All messages are JSON envelopes. Binary file upload can be added later; MVP can forward base64 or use chunked JSON frames with size limits.

### 7.1 Common Envelope

```typescript
interface RelayEnvelope<T = unknown> {
  version: 1
  id?: string
  channelId?: string
  kind:
    | 'hello'
    | 'hello_ack'
    | 'request'
    | 'response'
    | 'stream_open'
    | 'stream_data'
    | 'stream_close'
    | 'event'
    | 'error'
    | 'ping'
    | 'pong'
  payload: T
}
```

`id` correlates request/response messages. `channelId` identifies long-lived streams, especially proxied Codekin WebSocket sessions.

### 7.2 Connector Handshake

```typescript
interface ConnectorHello {
  machineId: string
  connectorVersion: string
  localCodekinUrl: string
  capabilities: {
    restProxy: true
    wsProxy: true
    fileUpload: boolean
    providers: Array<'claude' | 'codex' | 'opencode'>
  }
}
```

The connector authenticates with a machine credential. The relay validates it with the control plane, then marks the machine online.

### 7.3 Browser Handshake

```typescript
interface BrowserHello {
  userSessionToken: string
  organizationId: string
}
```

The relay validates the browser token with the control plane. Every later operation is checked against machine/session ACLs.

### 7.4 REST Proxy

Browser request:

```typescript
interface RelayRestRequest {
  machineId: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  headers?: Record<string, string>
  body?: unknown
}
```

Connector response:

```typescript
interface RelayRestResponse {
  status: number
  headers?: Record<string, string>
  body?: unknown
}
```

The connector maps allowed hosted requests onto the local Codekin API, injecting the local Codekin bearer token. The hosted browser never receives that local token.

### 7.5 WebSocket Stream Proxy

Browser opens a stream:

```typescript
interface RelayStreamOpen {
  machineId: string
  target: 'local-codekin-ws'
  sessionId?: string
}
```

The connector opens a local WebSocket to Codekin, sends the existing Codekin `auth` message using the local token, and then forwards Codekin frames through `stream_data` envelopes.

For MVP, payloads can remain the existing Codekin `WsClientMessage` and `WsServerMessage` JSON strings. The relay only wraps and routes them.

---

## 8. Hosted API Sketch

Initial control plane endpoints:

```text
GET    /api/me
GET    /api/machines
POST   /api/machines/pair/start
POST   /api/machines/pair/complete
DELETE /api/machines/:machineId

GET    /api/machines/:machineId/capabilities
GET    /api/machines/:machineId/sessions
GET    /api/machines/:machineId/repos

GET    /api/shares
POST   /api/shares
PATCH  /api/shares/:shareId
DELETE /api/shares/:shareId

GET    /api/audit-events
```

Relay WebSocket endpoints:

```text
GET /relay/browser
GET /relay/connector
```

The hosted frontend should call the hosted API for control-plane metadata and use `/relay/browser` for live proxied Codekin operations.

---

## 9. Changes to Existing Codekin

### 9.1 CLI

Add commands:

```bash
codekin relay login
codekin relay connect
codekin relay status
codekin relay disconnect
codekin relay logout
```

`codekin service install` should eventually support running the relay connector as part of the background service, gated by config.

### 9.2 Local Connector Module

Add a server-side/CLI module, likely under `server/relay-connector.ts` or `bin/` depending on packaging boundaries.

It should:

- Read local Codekin URL and token.
- Read hosted relay credential.
- Connect to hosted relay with reconnect/backoff.
- Forward REST calls.
- Forward local WebSocket streams.
- Report health and capabilities.
- Enforce local policy.

### 9.3 Frontend Transport Abstraction

Today the frontend assumes `BASE = '/cc'` and `wsUrl() = location.host + '/cc/'`.

Introduce a transport layer:

```typescript
interface CodekinTransport {
  request<T>(req: TransportRequest): Promise<T>
  openSessionStream(opts: StreamOptions): CodekinStream
}
```

Implementations:

- `LocalHttpTransport`: current direct `/cc` behavior.
- `HostedRelayTransport`: wraps REST and WebSocket traffic through the relay.

This keeps local Codekin working while enabling hosted mode.

### 9.4 Session and Machine UI

Hosted mode needs a target selector:

- Current machine.
- Online/offline state.
- Repos available on that machine.
- Sessions shared with the current user.

Local mode can keep the current UI.

### 9.5 Audit Events

Add audit events for hosted actions that can influence local execution:

```typescript
type AuditEventKind =
  | 'machine_paired'
  | 'machine_connected'
  | 'machine_disconnected'
  | 'session_shared'
  | 'session_unshared'
  | 'session_viewed'
  | 'prompt_sent'
  | 'file_uploaded'
  | 'approval_answered'
  | 'session_stopped'
```

Audit events should include actor user, target machine, target session, timestamp, IP/user-agent for browser-originated actions, and concise action metadata. Avoid storing full prompt text by default unless org policy enables it.

---

## 10. Permission Model

Hosted permissions should map onto existing Codekin session permissions, but with an additional hosted ACL check.

Recommended default:

| Action | Owner | Shared editor | Shared viewer |
|---|---:|---:|---:|
| View session output | yes | yes | yes |
| Send prompt | yes | yes | no |
| Upload file | yes | yes | no |
| View diff | yes | yes | optional |
| Approve read-only tool | yes | optional | no |
| Approve mutating tool | yes | no by default | no |
| Approve shell command | yes | no by default | no |
| Stop session | yes | optional | no |
| Delete/archive session | yes | no | no |

The connector must enforce these permissions locally even if the hosted relay has already checked them.

---

## 11. Failure Modes

### 11.1 Connector Offline

Browser should show machine offline and disable mutating actions. Existing sessions remain listed from hosted metadata if available, but live stream operations should fail fast.

### 11.2 Browser Disconnect

Local sessions should continue running. This matches current local Codekin behavior.

### 11.3 Relay Disconnect

Connector should reconnect with exponential backoff and jitter. On reconnect, it should re-advertise capabilities and current local session summaries.

### 11.4 Local Codekin Down

Connector should report degraded state. It may offer to start local Codekin if the connector is embedded in the CLI/service and has enough context to do so safely.

### 11.5 Backpressure

Relay hub should impose:

- Max message size.
- Max open channels per browser.
- Max open channels per machine.
- Per-user and per-machine rate limits.
- Bounded outbound queues.

When queues overflow, close the affected channel rather than risking unbounded memory growth.

---

## 12. Data Retention

Default hosted retention:

- Users, orgs, machines: retained until deleted.
- Session share metadata: retained until deleted plus audit retention.
- Audit events: retained according to org policy.
- Full chat transcripts: not retained by hosted service by default.
- File uploads: not retained by hosted service by default.

Local Codekin keeps its existing local session archive and screenshots behavior.

---

## 13. Rollout Plan

### Phase 1: Transport Abstraction

- Add frontend transport abstraction.
- Preserve current `/cc` local transport as default.
- Add tests proving existing local mode behavior is unchanged.

### Phase 2: Local Connector MVP

- Add `codekin relay login/connect/status/logout`.
- Implement outbound connector WebSocket.
- Implement REST proxy for read-only local endpoints first.
- Implement connector health and capability reporting.

### Phase 3: Relay Hub MVP

- Add hosted relay endpoints for connector and browser sockets.
- Add machine registration and online/offline tracking.
- Add browser-to-machine REST proxying.
- Add basic SSO and owner-only access.

### Phase 4: Session Streaming

- Proxy local Codekin WebSocket streams through relay channels.
- Support session create/join/input/approval flows.
- Add channel-level ACL checks and audit events.

### Phase 5: Sharing

- Add explicit session sharing UI and API.
- Add viewer/editor permission levels.
- Add local connector enforcement for hosted grants.

### Phase 6: Hardening

- Add reconnect recovery.
- Add rate limits and backpressure.
- Add audit exports.
- Add org-level retention controls.
- Add connector auto-update/version warnings.

---

## 14. Open Questions

- Which hosted identity provider ships first: GitHub OAuth, Google Workspace, or generic OIDC?
- Should hosted relay persist prompt text for audit/compliance, or only metadata?
- Should sharing be session-scoped only at first, or repo-scoped as well?
- Should non-owner users ever be allowed to approve shell commands?
- Should connector-to-local-Codekin use the existing HTTP API only, or should local Codekin expose a narrower internal relay API?
- How should file uploads be handled for large files: chunked JSON frames, signed temporary upload channels through relay, or direct connector pull?
- Is end-to-end encryption between browser and connector required for any customer profile, knowing it would limit hosted audit and policy inspection?

---

## 15. Initial Acceptance Criteria

The first production-capable hosted relay version is ready when:

- A developer can pair a machine without exposing inbound ports.
- A non-technical teammate can sign into hosted Codekin and view an explicitly shared local session.
- An authorized teammate can send a prompt to that session from the hosted UI.
- Claude/Codex/OpenCode execution still happens on the developer machine using local credentials.
- The hosted service never receives local provider credentials or local Codekin bearer tokens.
- The developer can revoke sharing and disconnect the machine immediately.
- The system records audit metadata for prompt sends, approvals, and share changes.
- Local-only Codekin mode remains supported.
