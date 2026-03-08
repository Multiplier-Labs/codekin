# Codekin — Functionality Overview

> A comprehensive reference for market research and value proposition mapping.

---

## What Is Codekin?

Codekin is a self-hosted, web-based control plane for Claude Code. It turns Claude Code CLI — a powerful but terminal-bound AI coding assistant — into a persistent, multi-session, browser-accessible workbench. Users can run simultaneous Claude Code sessions across multiple repositories, respond to Claude's tool permission prompts, monitor task progress, and trigger automated workflows, all from a single browser tab.

Codekin is built for developers and teams who use Claude Code intensively and need better session management, collaboration visibility, and automation hooks than the raw CLI provides.

---

## Target Users

- **Individual developers** — power users of Claude Code who want persistent sessions, session history, and a better UI
- **Engineering teams** — teams that want a shared view of Claude activity across repos, with per-repo permission registries
- **DevOps / platform engineers** — teams that want to automate CI failure triage, scheduled code reviews, and pipeline-triggered Claude sessions
- **AI-native teams** — organizations building coding workflows where Claude is a first-class participant in CI/CD

---

## Core Value Propositions

| Value | Description |
|---|---|
| **Persistent sessions** | Claude Code sessions survive browser refreshes, server restarts, and network drops |
| **Multi-session parallelism** | Run multiple Claude processes simultaneously across different repositories |
| **Browser accessibility** | Replace terminal dependency with a rich web UI accessible from any device |
| **Automation hooks** | GitHub webhooks, Stepflow integration, and a built-in cron workflow engine |
| **Structured interaction** | Tool approval UIs, task progress panels, planning mode indicators — not just a terminal |
| **Institutional memory** | Session archive, per-repo approval registries, and context modules persist knowledge |

---

## Feature Groups

### 1. Multi-Session Management

Codekin's primary differentiator from running Claude Code directly in a terminal is the ability to manage many sessions simultaneously with a structured UI.

- **Session tab bar** — a persistent top bar shows all active sessions with colored status dots (green = active, amber = waiting for input, gray = inactive)
- **Multi-repo isolation** — each session is bound to a working directory; sessions for the same repo are grouped together under a shared tab group
- **Parallel execution** — multiple Claude processes run simultaneously in different repos without interference
- **Tentative queue** — when two sessions for the same repo would conflict (both processing at the same time), new messages are held in a tentative queue and auto-dispatched once the blocking session finishes, preventing interleaved file edits
- **Session reuse** — opening a repo that already has a session rejoins it instead of creating a duplicate
- **Auto-reconnect** — on WebSocket reconnect, Codekin automatically rejoins the last active session and replays its history
- **Session naming** — sessions are auto-named from repo IDs; the `hub:` prefix is stripped in the UI for cleanliness

### 2. Real-Time Chat Interface

The main interaction surface is a streaming chat view built for Claude Code output, not generic LLM chat.

- **GitHub Flavored Markdown rendering** — tables, task lists, autolinks, strikethrough
- **Syntax-highlighted code blocks** — language detection from fenced code, VS Code Dark+ theme
- **60fps streaming** — text deltas batched via `requestAnimationFrame` for smooth rendering during fast output
- **User message bubbles** — distinct visual treatment for user messages vs. assistant output
- **System event messages** — color-coded lifecycle events (session init, restart, stall, error) with model name display
- **Timestamps** — displayed at minute boundaries between messages
- **Smart auto-scroll** — scrolls to bottom when near the bottom; suppresses if user has scrolled up to read history
- **Scroll-to-bottom button** — floating arrow button restores the bottom view
- **Configurable font size** — 10px–24px adjustable in Settings
- **Light and dark themes** — toggleable from the sidebar

### 3. Tool Activity Display

When Claude invokes tools (Read, Write, Edit, Bash, Grep, Glob, Task, etc.), the UI renders structured activity summaries rather than raw terminal output.

- **Grouped tool runs** — consecutive tool calls are collapsed into a single block showing count and tool names (e.g., "3 tool calls — Read, Edit, Bash")
- **Active tool indicator** — pulsing gold dot on in-progress tools
- **One-line summaries** — Bash shows the command, Read/Write/Edit shows the file path, Grep shows the search pattern
- **Collapsible output** — long tool output is collapsed with a toggle; error output is red
- **Auto-expand for active tools** — tool groups with running tools expand automatically
- **Error count badge** — group header shows "(N errors)" when tool outputs contain errors

### 4. Task Tracking

When Claude uses the `TodoWrite` tool to create a task list, Codekin displays a live task panel.

- **Floating todo panel** — appears in the chat area when tasks are present
- **Status icons** — empty circle (pending), pulsing gold dot (in progress), green checkmark (done)
- **Progress counter** — e.g., "3/5"
- **Active form labels** — shows present-continuous labels while tasks are running ("Running tests..." vs. "Run tests")
- **Auto-hide on completion** — panel hides 10 seconds after all tasks complete

### 5. Planning Mode

When Claude enters plan mode (using the `EnterPlanMode` tool), Codekin provides visual feedback.

- **Sticky plan mode banner** — pulsing gold dot + "Plan Mode" label visible at the top of the chat
- **Inline mode transition messages** — "Entered plan mode" / "Exited plan mode" appear as system messages in the chat flow

### 6. Permission and Prompt Handling

Codekin provides a structured UI for responding to Claude's tool permission requests and questions — a key friction point in the raw CLI experience.

- **Permission prompts** — when Claude requests a tool approval, three buttons appear: **Allow**, **Always Allow**, and **Deny**, with the tool name and command shown for review
- **Question prompts** — when Claude asks the user a question via `AskUserQuestion`, clickable option buttons appear with descriptions and a free-text input
- **Multi-select prompts** — checkbox-based selection for questions that accept multiple answers
- **Always Allow registry** — "Always Allow" saves the tool+command pattern to a persistent per-repo registry; future identical requests are auto-approved silently
- **Auto-deny on disconnect** — pending approvals are auto-denied when no clients are connected, preventing hung processes
- **60-second timeout** — approvals time out to prevent indefinitely stuck processes

### 7. Repository Browser and Discovery

The landing screen (no active session) provides a structured view of available repositories.

- **Owner-grouped listing** — repos organized under owner/organization with sticky headers
- **Repo metadata** — name, description, tags
- **One-click open** — click a repo to create or rejoin a session
- **Command palette** (`Ctrl+K` / `Cmd+K`) — fuzzy search across repos, skills, modules, presets, and actions from a single input field

### 8. Slash-Command Skills

Skills are templated prompts triggered by slash commands, enabling repeatable, parameterized AI workflows.

- **Skill menu** — accessible from the terminal icon in the input bar
- **Skill expansion** — typing `/skill-name arg1 arg2` expands the command's template, replacing `$ARGUMENTS` with the trailing text
- **Display text** — the original short command is shown in chat while the full expansion is sent to Claude, keeping the chat readable
- **Global skills** — available across all repos (e.g., `/validate-gemini`, `/validate-gpt`)
- **Repo-specific skills** — repos define skills in `.claude/skills/` directories; they appear automatically in the active repo's session
- **Built-in skills**:
  - `/validate-gemini` — asks Gemini to critique/validate the current change
  - `/validate-gpt` — asks GPT to critique/validate the current change
- **Discoverable** — skills appear in the command palette, skill menu, and skill browser

### 9. Context Modules

Modules are reusable context blocks that inject instructions or project knowledge into Claude in one click.

- **Module browser** — accessible from the book icon in the sidebar
- **Global and repo-specific** — modules can be defined globally or per-repository
- **One-click send** — sends the module content wrapped in `[Module: name]` markers
- **Use cases** — coding guidelines, architecture docs, recurring instructions, project context

### 10. Plugin Presets

Pre-configured bundles of Claude Code plugins for common development stacks, installable with a single click.

- **Available presets**: TS/React, Python, Rust, Full Stack
- **One-click install** — sends sequential `/plugin install` commands for all preset plugins
- **Preset browser** — accessible from the packages icon in the sidebar

### 11. File Uploads and Attachments

Files can be attached to messages for Claude to analyze — images, logs, data files.

- **Drag and drop** — drag files onto the chat area; drop zone overlay appears
- **Clipboard paste** — paste images directly from clipboard
- **File picker** — paperclip icon opens a native file picker with multi-file selection
- **Pending file chips** — files appear as removable chips above the input before sending
- **Upload status** — banner shows upload progress and errors
- **Server-side storage** — files stored in `~/.codekin/screenshots/`, paths prepended to the message as `[Attached files: ...]`

### 12. Session Persistence and Recovery

Sessions are designed to survive failures at every layer.

- **Disk persistence** — session metadata, output history, and approval registries written to `~/.codekin/sessions.json` (debounced, atomic)
- **Output history buffer** — 2000 messages stored server-side; last 500 replayed on client reconnect
- **Context rebuilding** — when Claude's process restarts, output history is converted to a context summary and fed as a system prompt so Claude can resume mid-task
- **Browser persistence** — active session ID stored in `localStorage`; page refresh auto-rejoins the last session
- **Auto-rejoin on WebSocket reconnect** — exponential backoff reconnection up to 30 seconds
- **Background tab restoration** — when returning to a background browser tab, session state is restored

### 13. Auto-Restart and Stall Detection

Resilience features for long-running or unattended sessions.

- **Auto-restart** — Claude process auto-restarts up to 3 times on unexpected exit; 5-minute cooldown before counter resets
- **Stall detection** — after 5 minutes of no output, a stall warning system message is displayed
- **API error retry** — transient API errors (overload, rate limits, 5xx) trigger automatic retry with exponential backoff (3 retries, 3s/6s/12s delays)
- **User-initiated stop** — Ctrl+C or stop button suppresses auto-restart
- **Restart notification** — yellow system message shown on auto-restart

### 14. Session Archive

Closed sessions are persisted to a SQLite database for later review.

- **Automatic archiving** — sessions are archived when deleted
- **Per-repo filtering** — view archived sessions for a specific repository
- **Full output history** — archived sessions retain their complete message history
- **Session restore** — archived sessions can be used as context when starting a new session ("new session from archive")
- **Retention policy** — configurable retention period (days) via settings API
- **Archived session browser** — accessible from the right sidebar

### 15. Tool Approval Registry

A per-repo registry of pre-approved tool invocations, eliminating repetitive approval prompts.

- **Per-repo scope** — approvals are keyed by working directory (repo path), shared across all sessions for the same repo
- **Three approval types**: specific tools, Bash command patterns, regex patterns
- **Persistent** — stored to `~/.codekin/repo-approvals.json`
- **Manageable** — view and revoke approvals from the Approvals panel in the right sidebar
- **Bulk revoke** — remove multiple approvals at once

### 16. GitHub Webhook Integration

Codekin can receive GitHub `workflow_run` webhooks and automatically spawn Claude sessions to triage CI failures.

- **Automated CI failure triage** — when a GitHub Actions workflow fails, Claude receives the failure logs, job summaries, error annotations, commit context, and PR title, and autonomously diagnoses the issue
- **Session grouping** — webhook-triggered sessions appear grouped under their repo's tab, alongside manual sessions
- **Async processing** — 202 Accepted response to GitHub; log fetching, workspace creation, and session spawning happen asynchronously
- **Isolated workspaces** — a fresh git clone of the failing commit is created per webhook event and cleaned up after Claude exits
- **Deduplication** — idempotency key prevents duplicate sessions for retried webhook deliveries
- **Concurrency cap** — configurable maximum concurrent webhook sessions
- **Rate limiting** — per-source rate limiting on the webhook endpoint
- **Processing watchdog** — events stuck in "processing" for >5 minutes are auto-marked as errors to prevent concurrency count leaks
- **Event history** — last 100 webhook events visible in the management API

### 17. Stepflow Workflow Integration

Codekin integrates with the Stepflow workflow orchestration platform, allowing external workflows to request Claude sessions as steps in larger pipelines.

- **`claude.session.requested` events** — Stepflow emits events asking Codekin to create a session for a specific task
- **Isolated workspace per request** — a fresh repo clone is created for each Stepflow-triggered session
- **Callback on completion** — Codekin POSTs the session result back to the provided callback URL once Claude exits
- **HMAC signature verification** — requests are authenticated with a shared secret
- **Deduplication and concurrency cap** — same protections as the GitHub webhook handler

### 18. Built-in Workflow Engine

An embedded step-based workflow engine with SQLite persistence and cron scheduling.

- **Step-based execution** — workflows are defined as ordered steps; each step receives the accumulated output of previous steps
- **SQLite persistence** — run history, step status, and schedules survive server restarts
- **Cron scheduling** — workflows can be triggered on cron expressions (standard 5-field format); schedules persist and resume after restarts
- **Manual trigger** — workflows can be triggered via the REST API
- **Interrupt recovery** — runs interrupted by server restarts are marked as failed on next startup
- **Run cancellation** — active runs can be canceled via the API; abort signals are propagated to step handlers
- **Real-time events** — workflow run/step lifecycle events are broadcast to all connected WebSocket clients

### 19. Automated Code Review Workflow

A built-in workflow that runs a daily automated code review using Claude.

- **Scheduled daily reviews** — configured via cron schedule; runs automatically
- **Comprehensive review prompt** — examines project structure, recent git history (7 days), code quality, security, performance, documentation, test coverage, and dependencies
- **Custom focus areas** — the review prompt can be extended with additional focus areas per run
- **Findings saved as Markdown** — review output written to `review logs/<timestamp>_code-review-daily.md` in the repo
- **Structured findings** — grouped by severity (critical, warning, info) with file paths and line numbers
- **Visible in UI** — workflow-triggered sessions appear in the session tab bar

### 20. Workflows View

A dedicated view in the UI for monitoring workflow runs and schedules.

- **Run list** — lists all workflow runs with status, kind, and timestamps
- **Step-level detail** — drill into a run to see individual step status and timing
- **Schedule management** — view, enable/disable, and manually trigger cron schedules
- **Navigation to sessions** — workflow runs that created a Claude session link directly to that session

### 21. Security and Authentication

- **Token-based auth** — WebSocket connections and REST API endpoints require a shared bearer token
- **Authelia integration** — production deployments run behind Authelia for user authentication at the nginx layer
- **HMAC signature verification** — GitHub and Stepflow webhooks are verified with HMAC-SHA256 signatures
- **CORS configuration** — `CORS_ORIGIN` env var controls allowed origins
- **Logout** — sidebar logout button redirects to the Authelia logout endpoint

### 22. Settings and Configuration

- **Settings modal** — accessible from the sidebar gear icon; auto-opens on first visit
- **Auth token** — token entry with real-time validity indicator
- **Font size** — adjustable 10px–24px slider
- **Theme toggle** — dark/light mode, persisted to localStorage
- **Archive retention** — configurable session retention period in days

---

## Use Cases

### Use Case 1: Daily Development Workbench

A developer opens Codekin in a browser tab at the start of the day. They see their active sessions from yesterday still running (or resumed). They switch between sessions for their frontend and backend repos using the tab bar, send Claude tasks, review tool activity in real time, approve or auto-approve common Bash commands, and track multi-step tasks in the todo panel — without ever touching a terminal.

**Key value**: persistent state, multi-repo parallelism, structured tool UI

---

### Use Case 2: CI Failure Triage on Autopilot

An engineering team configures GitHub webhooks to point at Codekin. When a workflow fails, Codekin automatically clones the failing commit, collects the failure logs and annotations, and spawns a Claude session with the full context. By the time the developer opens their browser, Claude has already diagnosed the failure and may have proposed a fix.

**Key value**: automated CI triage, zero developer intervention for routine failures

---

### Use Case 3: Scheduled Code Quality Reviews

A team configures a daily cron workflow. Every morning, Claude reviews each configured repo for code quality, security issues, and documentation gaps. Findings are saved as Markdown reports in the repo and visible in the Workflows view, giving the team a daily health snapshot without any manual effort.

**Key value**: automated code quality monitoring, findable history

---

### Use Case 4: AI-Native CI/CD Pipelines

A team integrates Codekin into their Stepflow pipelines. Individual workflow steps can request a Claude session for specific tasks: writing tests, applying patches, generating changelog entries. Codekin handles workspace isolation, session management, and result callback, allowing Claude to be a composable step in any pipeline.

**Key value**: Claude as a composable pipeline step, full lifecycle management

---

### Use Case 5: Team Knowledge Codification

A team defines shared context modules (architecture docs, coding guidelines, API contracts) and global skills (common review scripts, commit templates). Any developer opening Codekin automatically has access to these shared resources without any setup. The always-allow registry shared per-repo means teams collectively build up a set of pre-approved tool patterns.

**Key value**: shared institutional knowledge, team-level Claude configuration

---

### Use Case 6: Remote Development

A developer running Claude Code on a powerful remote machine accesses it from any device via Codekin in a browser — phone, tablet, laptop — without needing the Claude CLI installed locally. Sessions persist regardless of which device is used.

**Key value**: device independence, remote access to powerful compute

---

## Architecture Summary

```
Browser (React SPA)
    WebSocket + REST (token-auth)
nginx (HTTPS, Authelia auth)
    /           Static files
    /cc/        WebSocket server (port 32352) — WebSocket + REST + uploads
                     |
              WebSocket Server (Node.js)
                     |
          ┌──────────┼──────────┐
     Session     Workflow    Webhook
     Manager     Engine      Handler
          |
     Claude Code CLI
     (stream-json protocol, one process per session)
```

### Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React, Vite, TailwindCSS 4, TypeScript |
| Backend | Node.js, Express, ws (WebSocket) |
| Database | SQLite (via better-sqlite3) — workflow runs, schedules, session archive |
| Claude integration | Claude Code CLI with stream-json protocol |
| Auth | Authelia (nginx layer) + bearer token (API layer) |
| Proxy | nginx with SSL |
| Session naming | Groq API (Llama 4 Scout) for auto-generated session names |

---

## Positioning Summary

Codekin occupies the gap between raw CLI usage of Claude Code and a full-featured, cloud-hosted AI coding assistant platform. It is:

- **More capable than the CLI** — persistent sessions, multi-session management, browser UI, automation hooks
- **More controllable than SaaS** — self-hosted, no data leaves your infrastructure, full configuration control
- **More integrated than alternatives** — first-class GitHub CI integration, Stepflow pipeline support, built-in workflow engine
- **Developer-first UX** — built by and for developers who use Claude Code heavily, with features that address real pain points: session recovery, approval fatigue, context sharing, and CI automation
