# Architecture

Codekin is a full-stack TypeScript application: React SPA frontend, Express + WebSocket backend, spawning Claude Code CLI (or OpenCode) per session.

## Module Map

| Directory | Responsibility |
|-----------|---------------|
| `src/` | React frontend (Vite + TailwindCSS 4) |
| `src/components/` | UI components (ChatView, InputBar, DiffPanel, Workflows, etc.) |
| `src/hooks/` | Custom hooks for WebSocket, sessions, settings, routing, diffs |
| `src/lib/` | REST client (`ccApi.ts`), slash commands, formatters, workflow API |
| `server/` | Express + WebSocket server, all backend logic (flat layout, ~70 modules) |
| `server/workflows/` | Built-in workflow definitions (Markdown + YAML frontmatter) |
| `bin/` | CLI entry point (`codekin.mjs`) — service management, setup, upgrade |
| `docs/` | Reference documentation |
| `nginx/` | Reverse proxy configuration |
| `workflows/` | CI/CD workflow definitions |
| `public/` | Static assets |

## Data Flow

```
Browser ──WebSocket──► ws-server.ts ──► session-manager.ts ──► claude-process.ts ──► Claude CLI (stdin/stdout NDJSON)
  │                        │                    │                     │
  │                        │                    │                     ├── opencode-process.ts ──► OpenCode HTTP+SSE
  │                        │                    │
  │                        │                    ├── approval-manager.ts (tool permission checks + cross-repo learning)
  │                        │                    ├── plan-manager.ts (read-only mode state machine)
  │                        │                    ├── diff-manager.ts (git diff operations)
  │                        │                    └── session-persistence.ts (disk state: ~/.codekin/sessions.json)
  │                        │
  │                        ├── REST routes (session, upload, webhook, workflow, orchestrator, docs)
  │                        ├── webhook-handler.ts (GitHub CI/PR events → auto-fix/review sessions)
  │                        ├── stepflow-handler.ts (Stepflow webhook → spawned sessions)
  │                        └── workflow-engine.ts (scheduled Claude sessions → reports)
  │
  └── REST ──► ccApi.ts (session CRUD, file upload, repo listing, approvals, workflows)
```

### WebSocket Message Flow

1. Client sends `WsClientMessage` (auth, create_session, input, prompt_response, etc.)
2. `ws-message-handler.ts` routes to `SessionManager` methods
3. `SessionManager` delegates to `ClaudeProcess` or `OpenCodeProcess`
4. Process events (`text`, `tool_active`, `tool_done`, `result`, `prompt`) emitted via EventEmitter
5. Server transforms events to `WsServerMessage` and sends to all subscribed clients
6. Frontend `useChatSocket` hook batches messages via `requestAnimationFrame` for 60fps rendering

## Key Abstractions

| Type/Class | Location | Purpose |
|-----------|----------|---------|
| `CodingProcess` | `server/coding-process.ts` | Abstract interface for AI providers (Claude CLI, OpenCode) |
| `ClaudeProcess` | `server/claude-process.ts` | Spawns Claude CLI, parses NDJSON stdout, emits typed events |
| `OpenCodeProcess` | `server/opencode-process.ts` | Wraps OpenCode HTTP server, maps to same event interface |
| `SessionManager` | `server/session-manager.ts` | Central lifecycle — create, start, stop, delete, input routing, idle reaping |
| `ApprovalManager` | `server/approval-manager.ts` | Per-repo tool auto-approval with pattern matching and cross-repo threshold |
| `PlanManager` | `server/plan-manager.ts` | Read-only mode state machine (idle → planning → reviewing → approved) |
| `WorkflowEngine` | `server/workflow-engine.ts` | Step-based workflow executor with SQLite persistence and cron scheduling |
| `WebhookHandler` | `server/webhook-handler.ts` | GitHub CI/PR events → session pipeline (dedup, rate-limit, workspace isolation) |
| `StepflowHandler` | `server/stepflow-handler.ts` | Stepflow webhook → spawned Claude sessions |
| `OrchestratorManager` | `server/orchestrator-manager.ts` | Always-on orchestrator session (Agent Joe) with child session management |
| `SessionArchive` | `server/session-archive.ts` | SQLite persistence for closed sessions and settings |
| `DiffManager` | `server/diff-manager.ts` | Stateless git diff/discard operations (staged, unstaged, all scopes) |
| `WsClientMessage` / `WsServerMessage` | `src/types.ts`, `server/types.ts` | WebSocket protocol contract |

## Entry Points

| Entry | File | Purpose |
|-------|------|---------|
| CLI | `bin/codekin.mjs` | Service lifecycle: start, setup, install, upgrade, uninstall |
| Server | `server/ws-server.ts` | Express + WebSocket on port 32352 (configurable via PORT env) |
| Frontend | `src/main.tsx` → `src/App.tsx` | React SPA mount point |

## External Dependencies

| Dependency | Integration Point | Protocol |
|-----------|-------------------|----------|
| Claude Code CLI | `server/claude-process.ts` | Subprocess, NDJSON on stdin/stdout |
| OpenCode server | `server/opencode-process.ts` | HTTP REST + SSE |
| GitHub API | `server/webhook-handler.ts`, `server/webhook-pr-github.ts` | Webhooks (inbound), `gh` CLI (outbound) |
| Stepflow | `server/stepflow-handler.ts` | Webhooks (inbound, HMAC-SHA256 verified) |
| SQLite | `server/session-archive.ts`, `server/workflow-engine.ts` | `better-sqlite3` — sessions, workflows, settings |
| Filesystem | `server/session-persistence.ts` | `~/.codekin/sessions.json`, `~/.codekin/repo-approvals.json` |

## Authentication

- Token-based auth with timing-safe SHA256 comparison (`server/crypto-utils.ts`)
- Token stored at `~/.config/codekin/token` (distribution) or `~/.codekin/auth-token` (manual)
- Session-scoped tokens derived via HMAC-SHA256(masterToken + sessionId) for hook endpoints
- WebSocket auth: 5-second timeout, must send `auth` message first
- Webhook auth: HMAC-SHA256 signature verification (GitHub: X-Hub-Signature-256, Stepflow: X-Webhook-Signature)

## Provider Architecture

The `CodingProcess` interface allows swapping between Claude CLI and OpenCode:

```
CodingProcess (interface)
  ├── ClaudeProcess  — subprocess per session, NDJSON I/O
  └── OpenCodeProcess — shared HTTP server, per-session routing via SSE
```

Both emit identical `ClaudeProcessEvents`, so `SessionManager` is provider-agnostic.

## Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Always ask before changes |
| `acceptEdits` | Auto-accept file edits |
| `plan` | Read-only proposals via PlanManager state machine |
| `bypassPermissions` | Accept all without asking |
| `dangerouslySkipPermissions` | Skip checks entirely (spawns with `--dangerously-skip-permissions`) |

## Data Persistence

| Store | Location | Contents |
|-------|----------|----------|
| SQLite (sessions) | `~/.codekin/codekin.db` | Archived sessions, message history, settings |
| SQLite (workflows) | `~/.codekin/workflows.db` | Workflow runs, steps, cron schedules |
| JSON | `~/.codekin/sessions.json` | Active session state (debounced writes) |
| JSON | `~/.codekin/repo-approvals.json` | Per-repo tool approval rules |
| Filesystem | `~/.codekin/orchestrator/` | Agent Joe profile, repos registry, journals |
| Filesystem | `~/.codekin/screenshots/` | Uploaded files |

## Rate Limiting & Constraints

- WebSocket: 30 connections/60s per IP, 60 messages/second per client
- Webhooks: 100 events/hour per workflow kind, 10 concurrent sessions
- Session history: 2000 messages server-side, 500 client-side
- Idle timeout: 30 minutes → process stopped
- Stale sessions: cleaned after 7 days
- Auto-restart: max 3 retries, 5-minute cooldown
