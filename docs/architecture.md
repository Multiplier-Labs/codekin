# Architecture

Codekin is a full-stack TypeScript application: React SPA frontend, Express + WebSocket backend, spawning Claude Code CLI (or OpenCode) per session.

## Module Map

| Directory | Responsibility |
|-----------|---------------|
| `src/` | React frontend (Vite + TailwindCSS 4) |
| `src/components/` | UI components (ChatView, InputBar, DiffPanel, etc.) |
| `src/hooks/` | Custom hooks for WebSocket, sessions, settings, routing |
| `src/lib/` | REST client (`ccApi.ts`), slash commands, formatters |
| `server/` | Express + WebSocket server, all backend logic |
| `server/workflows/` | Built-in workflow definitions (Markdown + YAML frontmatter) |
| `bin/` | CLI entry point (`codekin.mjs`) — service management, setup |
| `docs/` | Reference documentation |
| `nginx/` | Reverse proxy configuration |
| `workflows/` | CI/CD workflow definitions |

## Data Flow

```
Browser ──WebSocket──► ws-server.ts ──► session-manager.ts ──► claude-process.ts ──► Claude CLI (stdin/stdout NDJSON)
  │                        │                    │                     │
  │                        │                    │                     ├── opencode-process.ts ──► OpenCode HTTP+SSE
  │                        │                    │
  │                        │                    ├── approval-manager.ts (tool permission checks)
  │                        │                    ├── diff-manager.ts (git diff operations)
  │                        │                    └── session-persistence.ts (disk state)
  │                        │
  │                        ├── REST routes (session, upload, webhook, workflow, orchestrator)
  │                        └── webhook-handler.ts (GitHub CI/PR events → auto-fix sessions)
  │
  └── REST ──► ccApi.ts (session CRUD, file upload, repo listing, approvals)
```

### WebSocket Message Flow

1. Client sends `WsClientMessage` (auth, create_session, input, prompt_response, etc.)
2. `ws-message-handler.ts` routes to `SessionManager` methods
3. `SessionManager` delegates to `ClaudeProcess` or `OpenCodeProcess`
4. Process events (`text`, `tool_active`, `tool_done`, `result`, `prompt`) emitted via EventEmitter
5. Server transforms events to `WsServerMessage` and sends to subscribed clients
6. Frontend `useChatSocket` hook batches messages via `requestAnimationFrame` for 60fps rendering

## Key Abstractions

| Type/Class | Location | Purpose |
|-----------|----------|---------|
| `CodingProcess` | `server/coding-process.ts` | Abstract interface for AI providers (Claude CLI, OpenCode) |
| `ClaudeProcess` | `server/claude-process.ts` | Spawns Claude CLI, parses NDJSON stdout, emits typed events |
| `OpenCodeProcess` | `server/opencode-process.ts` | Wraps OpenCode HTTP server (singleton), maps to same event interface |
| `SessionManager` | `server/session-manager.ts` | Central lifecycle manager — create, start, stop, delete, input routing |
| `ApprovalManager` | `server/approval-manager.ts` | Per-repo tool auto-approval with pattern matching and cross-repo threshold |
| `WorkflowEngine` | `server/workflow-engine.ts` | 4-step execution (validate → create session → run prompt → save report) |
| `WebhookHandler` | `server/webhook-handler.ts` | GitHub CI failure → auto-bugfix session pipeline |
| `OrchestratorManager` | `server/orchestrator-manager.ts` | Multi-child session management (Agent Joe) |
| `SessionArchive` | `server/session-archive.ts` | SQLite persistence for closed sessions |
| `WsClientMessage` / `WsServerMessage` | `src/types.ts`, `server/types.ts` | WebSocket protocol contract (duplicated in both layers) |

## Entry Points

| Entry | File | Purpose |
|-------|------|---------|
| CLI | `bin/codekin.mjs` | Service lifecycle: start, setup, install, upgrade, uninstall |
| Server | `server/ws-server.ts` | Express + WebSocket on port 32352 (configurable) |
| Frontend | `src/main.tsx` → `src/App.tsx` | React SPA mount point |

## External Dependencies

| Dependency | Integration Point | Protocol |
|-----------|-------------------|----------|
| Claude Code CLI | `server/claude-process.ts` | Subprocess, NDJSON on stdin/stdout |
| OpenCode server | `server/opencode-process.ts` | HTTP REST + SSE (singleton) |
| GitHub API | `server/webhook-handler.ts`, `server/webhook-pr-github.ts` | Webhooks (inbound), `gh` CLI (outbound) |
| SQLite | `server/session-archive.ts` | `better-sqlite3` for session archive |
| Filesystem | `server/session-persistence.ts` | `~/.codekin/sessions.json`, `~/.codekin/repo-approvals.json` |

## Authentication

- Token-based auth with timing-safe SHA256 comparison
- Token stored at `~/.config/codekin/token` (distribution) or `~/.codekin/auth-token` (manual setup)
- Session-scoped tokens derived from master token + sessionId

## Provider Architecture

The `CodingProcess` interface allows swapping between Claude CLI and OpenCode:

```
CodingProcess (interface)
  ├── ClaudeProcess  — subprocess per session
  └── OpenCodeProcess — shared HTTP server, per-session message routing
```

Both emit identical `ClaudeProcessEvents`, so `SessionManager` is provider-agnostic.

## Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Always ask before changes |
| `acceptEdits` | Auto-accept file edits |
| `plan` | Read-only proposals |
| `bypassPermissions` | Accept all without asking |
| `dangerouslySkipPermissions` | Skip checks entirely |
