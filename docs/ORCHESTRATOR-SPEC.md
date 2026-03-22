# Agent Joe — Master Orchestrator Session

> *"Agent Joe"* — a calm, knowledgeable ops manager who keeps your repositories healthy, your workflows running, and your audit findings actioned. Guides non-expert users toward becoming better vibe coders through pragmatic, friendly advice.

**Status**: Draft v0.1
**Location in UI**: Left sidebar, below "AI Workflows"

---

## 1. Identity & Personality

**Name**: Agent Joe

**Character traits**:
- Calm, orderly ops manager — never frantic, always measured
- Likes clean code and well-organized repositories
- Friendly and approachable — explains *why*, not just *what*
- Pragmatic — only recommends what's actually necessary right now
- Guides users toward better practices without being preachy
- Speaks plainly, avoids jargon unless the user is technical

**Voice examples**:
- "Your `api-gateway` repo hasn't had a health check in 12 days. Want me to set up a weekly workflow?"
- "The security scan found 3 findings — only 1 is actionable right now (an outdated dependency). I'd skip the other two. Want me to open a fix session?"
- "Looks like you just onboarded `payments-service`. I'd recommend starting with a repo-health workflow — it gives you a baseline before diving into features."

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Codekin Frontend                      │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │LeftSidebar│  │ OrchestratorView │  │  ChatView (child  │  │
│  │          │  │  (main panel) │  │   sessions)       │  │
│  │ ■ Workflows│  │              │  │                   │  │
│  │ ■ Agent Joe │──│ Dashboard    │  │                   │  │
│  │ ■ Sessions │  │ Reports      │  │                   │  │
│  │          │  │ Memory log   │  │                   │  │
│  └──────────┘  └──────┬───────┘  └───────────────────┘  │
│                       │                                  │
└───────────────────────┼──────────────────────────────────┘
                        │ WebSocket
┌───────────────────────┼──────────────────────────────────┐
│                   Codekin Server                         │
│                       │                                  │
│  ┌────────────────────▼─────────────────────────┐        │
│  │         Agent Joe Session (ClaudeProcess)      │        │
│  │                                               │        │
│  │  System prompt + Agent Joe CLAUDE.md           │        │
│  │  ├─ Global memory (SQLite + markdown)         │        │
│  │  ├─ Repo registry & policies                  │        │
│  │  ├─ Report reader                             │        │
│  │  └─ Session spawner (child sessions)          │        │
│  │                                               │        │
│  └───────────────┬───────────────────────────────┘        │
│                  │ spawns & monitors                      │
│  ┌───────────────▼───────────────────────────────┐        │
│  │         Child Sessions (standard Claude)       │        │
│  │  - Fix security finding in repo X              │        │
│  │  - Set up workflow for repo Y                  │        │
│  │  - Implement code-review suggestion in repo Z  │        │
│  └────────────────────────────────────────────────┘        │
│                                                           │
│  ┌────────────────────────────────────────────────┐        │
│  │         Agent Joe Memory Store                  │        │
│  │  ~/.codekin/orchestrator/                          │        │
│  │  ├─ memory.sqlite  (structured + FTS)          │        │
│  │  ├─ PROFILE.md     (user profile & prefs)      │        │
│  │  ├─ REPOS.md       (repo registry & policies)  │        │
│  │  └─ journal/       (daily activity logs)        │        │
│  └────────────────────────────────────────────────┘        │
└───────────────────────────────────────────────────────────┘
```

---

## 3. Session Model

### 3.1 Always-On Session

Agent Joe runs as a **special session type** within the existing `SessionManager` infrastructure:

```typescript
interface OrchestratorSession {
  type: 'orchestrator'              // distinguishes from regular sessions
  id: string                    // stable UUID, persisted across restarts
  status: 'active' | 'idle' | 'restarting'
  lastActivity: string          // ISO timestamp
  childSessions: string[]       // IDs of spawned implementation sessions
}
```

**Lifecycle**:
- Starts automatically when Codekin server boots (or on first sidebar click)
- Survives page refreshes — user reconnects to the same session
- On Codekin/Claude restart: session restarts fresh but re-reads its memory store to restore context
- Never appears in the "Archived Sessions" list
- Appears as a pinned item in the sidebar, not grouped under any repo

### 3.2 Reusing Existing Infrastructure

Agent Joe is a `ClaudeProcess` session with:
- A dedicated `CLAUDE.md` (the Agent Joe system prompt — see §8)
- `source: 'orchestrator'` in `CreateSessionOptions`
- `permissionMode: 'acceptEdits'` (it needs to read reports, write memory, spawn sessions)
- Working directory: `~/.codekin/orchestrator/` (its own workspace)

New additions to `SessionManager`:
```typescript
// In session-manager.ts
getOrchestratorSession(): OrchestratorSession | null
ensureOrchestratorRunning(): Promise<OrchestratorSession>
spawnChildSession(repo: string, task: string, options: ChildSessionOptions): Promise<string>
```

---

## 4. Core Capabilities

### 4.1 Repository Onboarding & Organization

When a user starts working with a repo in Codekin, Agent Joe can:

- **Detect new repos** — notice when a repo appears in the session list for the first time
- **Recommend AI Workflows** — suggest appropriate workflow schedules based on repo type (e.g., "This looks like a Node.js API — I'd recommend repo-health weekly + dependency audit monthly")
- **Auto-setup workflows** — with user approval, configure and enable workflows automatically
- **Suggest improvements** — based on what it sees (missing CI, no tests, outdated deps, etc.)

### 4.2 Audit Report Triage & Implementation

Agent Joe reads reports from `.codekin/reports/` across all managed repos and:

1. **Critically evaluates findings** — not everything in an audit needs fixing. Agent Joe applies pragmatic judgment:
   - Is this finding actually impactful?
   - Is it relevant to the repo's current stage? (MVP vs. production)
   - Would fixing it now prevent a real problem, or is it cosmetic?

2. **Prioritizes actionable items** — ranks findings by:
   - Severity (security > correctness > quality > style)
   - Effort (quick wins first)
   - Dependencies (does fixing A unblock B?)

3. **Spawns implementation sessions** — for approved fixes:
   - Creates a standard Claude session in the target repo
   - Provides the session with a focused task description
   - Monitors progress and reports back

4. **Respects per-repo policies** (see §5):
   - Some repos require PRs, others allow direct merge
   - Some repos need deployment after changes, others don't
   - Some repos are in "freeze" mode

### 4.3 Workflow Management

Agent Joe can manage AI Workflows on behalf of the user:

- **Create/modify schedules** — "Run security audit weekly on Mondays"
- **Enable/disable workflows** — based on repo activity levels
- **De-schedule passive repos** — if a repo hasn't had commits in N days, suggest pausing its workflows to save resources
- **Monitor workflow health** — alert if workflows are failing repeatedly

### 4.4 Proactive Monitoring

Agent Joe periodically (or on triggers) checks:

- New audit reports landing in `.codekin/reports/`
- Repos with no recent workflow runs
- Child sessions that completed or failed
- Repos newly added to Codekin

When it finds something noteworthy, it surfaces it in its chat view:
> "A new repo-health report just landed for `payments-service`. 2 items worth looking at — want a summary?"

---

## 5. Repo Registry & Policies

Each repo managed by Agent Joe has a policy configuration:

```typescript
interface RepoPolicy {
  repoPath: string
  displayName: string

  // Git workflow
  branchStrategy: 'pr' | 'direct-merge'     // how changes land
  requireReview: boolean                      // wait for PR approval?

  // Deployment
  deployAfterMerge: boolean                   // trigger deploy script?
  deployCommand?: string                      // custom deploy command

  // Audit preferences
  enabledAudits: string[]                     // which report types to run
  auditSchedule: Record<string, string>       // report type → cron expression
  autoImplementThreshold: 'critical' | 'high' | 'medium' | 'none'

  // Activity
  status: 'active' | 'passive' | 'frozen'    // frozen = no changes allowed
  lastCommitDate: string
  passiveThresholdDays: number                // days without commits → passive
}
```

Stored in `~/.codekin/orchestrator/REPOS.md` (human-readable) and `repos.json` (machine-readable).

---

## 6. Self-Improving Global Memory (Medium Tier)

Inspired by the OpenClaw/Moltbot memory blueprint, Agent Joe maintains a **dual memory system** — human-editable markdown files backed by a SQLite store with full-text search.

### 6.1 On-Disk Layout

```
~/.codekin/orchestrator/
├── PROFILE.md              # User profile, preferences, skill level
├── REPOS.md                # Repo registry with policies (human-readable)
├── DECISIONS.md            # Key decisions and their rationale
├── journal/
│   ├── 2026-03-17.md       # Daily activity journal
│   └── 2026-03-16.md
├── memory.sqlite           # Structured memory store + FTS
└── repos.json              # Machine-readable repo policies
```

### 6.2 Memory Types

| Type | Storage | TTL | Example |
|------|---------|-----|---------|
| `user_preference` | PROFILE.md + DB | permanent | "User prefers PRs over direct merge" |
| `repo_context` | REPOS.md + DB | until repo removed | "payments-service is a Go monolith, production-critical" |
| `decision` | DECISIONS.md + DB | 90 days | "Decided to skip test-coverage audits for prototypes" |
| `finding_outcome` | DB only | 180 days | "Security finding X was false positive — skipped" |
| `session_summary` | DB only | 60 days | "Fixed 3 dependency issues in api-gateway via session abc" |
| `journal_entry` | journal/ + DB | 30 days | "Today: onboarded 2 repos, ran 4 audits, spawned 1 fix session" |

### 6.3 SQLite Schema (Minimum Viable)

```sql
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  memory_type TEXT NOT NULL,       -- user_preference | repo_context | decision | finding_outcome | session_summary | journal
  scope TEXT,                      -- NULL (global) or repo path
  title TEXT,
  content TEXT NOT NULL,
  source_ref TEXT,                 -- session ID, report path, or user message
  confidence REAL DEFAULT 0.8,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,                 -- NULL = permanent
  is_pinned INTEGER DEFAULT 0,
  tags TEXT                        -- JSON array
);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  title, content, tags,
  content='memory_items',
  tokenize='unicode61'
);

CREATE TABLE memory_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  query TEXT
);
```

### 6.4 Memory Lifecycle

**Writing memories**:
- After each significant interaction, Agent Joe extracts memory candidates
- Deduplication: FTS similarity check before insert (update if >0.85 match)
- User preferences are always pinned (no expiry)
- Repo context updates when repo policies change

**Reading memories**:
- On session restart: load PROFILE.md + REPOS.md + recent journal entries
- Per interaction: FTS retrieval of top-N relevant items (budget: ~1200 tokens)
- Scoring: `0.50 * relevance + 0.30 * recency + 0.20 * pin_boost`

**Aging/cleanup**:
- Daily: expire items past their TTL
- Weekly: compact journal entries older than 30 days into monthly summaries

### 6.5 What Makes It "Self-Improving"

Over time, Agent Joe gets smarter because:
1. **Pattern learning** — remembers which audit findings were acted on vs. dismissed, learns to pre-filter
2. **User model** — builds understanding of user's skill level, preferences, and priorities
3. **Repo knowledge** — accumulates context about each repo's architecture, stack, and quirks
4. **Decision history** — remembers past decisions and their outcomes, avoids repeating mistakes
5. **Workflow tuning** — learns optimal schedules and report types per repo based on what was useful

---

## 7. Child Session Management

### 7.1 Spawning

When Agent Joe decides (with user approval) to implement a fix:

```typescript
interface ChildSessionOptions {
  repo: string                    // target repository path
  task: string                    // focused task description
  branchName: string              // e.g., "fix/update-lodash-dep"
  useWorktree: boolean            // typically true
  completionPolicy: 'pr' | 'merge' | 'commit-only'  // from repo policy
  deployAfter: boolean            // from repo policy
  parentSessionId: string         // Agent Joe's session ID
  timeout?: number                // max duration in minutes
}
```

### 7.2 Monitoring

Agent Joe tracks child sessions via:
- Polling session status from `SessionManager`
- Reading session output for completion signals
- Checking git state (branch created? PR opened? merged?)

### 7.3 Post-Completion

After a child session completes:
1. Agent Joe reads the outcome (success/failure, what was changed)
2. Stores a `session_summary` memory
3. If `completionPolicy === 'pr'`: verifies PR was created
4. If `deployAfter`: triggers deployment (with user confirmation)
5. Updates the corresponding audit finding status
6. Reports to the user in the Agent Joe chat

---

## 8. System Prompt (Agent Joe CLAUDE.md)

The Agent Joe session loads a dedicated CLAUDE.md that defines its behavior:

```markdown
# Agent Joe — Codekin Orchestrator

You are Agent Joe, a calm and friendly ops manager inside Codekin.
You help users keep their repositories healthy, their workflows running
smoothly, and their audit findings actioned pragmatically.

## Your Personality
- Calm, measured, never frantic
- You like clean code and orderly repositories
- You explain the "why" behind recommendations
- You're pragmatic — only suggest what's actually needed right now
- You guide users toward better practices without being preachy
- You speak plainly, avoiding unnecessary jargon

## Your Capabilities
- Read audit reports from .codekin/reports/ across all managed repos
- Manage AI Workflow schedules (create, modify, enable, disable)
- Spawn implementation sessions in target repos for approved fixes
- Maintain your memory store for continuity across restarts
- Track repo policies (PR vs merge, deploy requirements, activity status)

## Rules
- NEVER implement changes without user approval
- ALWAYS explain why you recommend (or skip) a finding
- When spawning fix sessions, provide focused, minimal task descriptions
- Respect repo policies — check branch strategy and deploy requirements
- Be honest about uncertainty — if you're not sure a fix is needed, say so
- Keep your memory store tidy — expire stale items, deduplicate

## On Restart
When you start fresh after a restart:
1. Read PROFILE.md for user context
2. Read REPOS.md for repo registry and policies
3. Read the last 3 journal entries for recent activity
4. Query memory.sqlite for any pinned items
5. Check for new audit reports that landed while you were offline
6. Greet the user with a brief status update
```

---

## 9. Frontend Integration

### 9.1 Sidebar Entry

In `LeftSidebar.tsx`, add a new pinned menu item below "AI Workflows":

```tsx
<button
  onClick={() => onNavigateToOrchestrator()}
  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[15px] ${
    view === 'orchestrator'
      ? 'text-accent-3 bg-accent-11/20'
      : 'text-neutral-3 hover:text-neutral-1 hover:bg-neutral-6'
  }`}
>
  <IconShield size={16} stroke={2} />
  <span>Agent Joe</span>
</button>
```

### 9.2 Agent Joe View

The Agent Joe view is a **chat interface** (reusing `ChatView`) with an optional dashboard header:

```
┌─────────────────────────────────────────────────┐
│  🛡 Agent Joe                          [status]  │
├─────────────────────────────────────────────────┤
│  ┌─────────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ 5 repos     │ │ 3 pending│ │ 2 sessions  │  │
│  │ managed     │ │ findings │ │ running     │  │
│  └─────────────┘ └──────────┘ └─────────────┘  │
├─────────────────────────────────────────────────┤
│                                                 │
│  [Agent Joe chat messages — standard ChatView]   │
│                                                 │
│  Agent Joe: Good morning. 2 new reports landed   │
│  overnight. The security scan for api-gateway   │
│  found 1 critical finding (outdated jsonwebtoken│
│  package). Want me to open a fix session?        │
│                                                 │
│  User: yes, go ahead                            │
│                                                 │
│  Agent Joe: On it. I've spawned a session in     │
│  api-gateway on branch fix/update-jsonwebtoken. │
│  It'll open a PR when done. I'll let you know.  │
│                                                 │
├─────────────────────────────────────────────────┤
│  [InputBar — standard input]                    │
└─────────────────────────────────────────────────┘
```

### 9.3 Router Addition

```typescript
// useRouter.ts
type ViewType = 'chat' | 'workflows' | 'orchestrator'

if (pathname === '/orchestrator') return { sessionId: null, view: 'orchestrator' }
```

---

## 10. API Additions

### 10.1 Server Routes (`server/orchestrator-routes.ts`)

```
GET    /cc/api/orchestrator/status          — session status + summary stats
POST   /cc/api/orchestrator/start           — ensure Agent Joe is running
GET    /cc/api/orchestrator/repos           — repo registry
POST   /cc/api/orchestrator/repos           — add repo to registry
PATCH  /cc/api/orchestrator/repos/:id       — update repo policy
DELETE /cc/api/orchestrator/repos/:id       — remove repo from registry
GET    /cc/api/orchestrator/memory          — query memory store (FTS)
GET    /cc/api/orchestrator/children        — list child sessions
GET    /cc/api/orchestrator/journal         — recent journal entries
```

### 10.2 WebSocket Messages

```typescript
// New message types
type OrchestratorNotification = {
  type: 'orchestrator_notification'
  severity: 'info' | 'action' | 'alert'
  title: string
  body: string
  actions?: { label: string; action: string }[]
}

type OrchestratorChildUpdate = {
  type: 'orchestrator_child_update'
  childSessionId: string
  status: 'started' | 'progress' | 'completed' | 'failed'
  summary?: string
}
```

---

## 11. Implementation Phases

### Phase 1 — Foundation (MVP)
- [ ] Agent Joe session type in `SessionManager` (always-on, auto-restart)
- [ ] Sidebar entry + route + basic `OrchestratorView` (chat-only, no dashboard header)
- [ ] Agent Joe CLAUDE.md with personality and base capabilities
- [ ] Markdown-based memory (PROFILE.md, REPOS.md, journal/)
- [ ] Manual interaction only (user asks, Agent Joe answers)

### Phase 2 — Report Triage & Child Sessions
- [ ] Report reader — Agent Joe can scan `.codekin/reports/` across repos
- [ ] Child session spawning with task descriptions
- [ ] Child session monitoring and completion reporting
- [ ] Repo policies (PR vs merge, deploy flags)
- [ ] SQLite memory store with FTS
- [ ] Trust records table + ASK-level approval flow

### Phase 3 — Workflow Management & Proactivity
- [ ] Workflow CRUD from Agent Joe (create/modify/disable schedules)
- [ ] Proactive notifications (new reports, idle repos, failed workflows)
- [ ] Auto-suggest workflow setup for new repos
- [ ] Dashboard header with summary stats
- [ ] De-scheduling passive repos
- [ ] NOTIFY+DO trust escalation (2-approval threshold)

### Phase 4 — Self-Improving Memory & Autonomy
- [ ] Memory candidate extraction after interactions
- [ ] Deduplication and aging/decay
- [ ] Pattern learning (finding outcomes → better triage)
- [ ] User skill model (adapt guidance to experience level)
- [ ] Decision history with outcome tracking
- [ ] SILENT trust level (5-approval threshold)
- [ ] User trust override commands ("always do X", "never auto-approve Y")

---

## 12. Learned Trust & Auto-Approval

Agent Joe doesn't start autonomous — it **earns autonomy** through repeated user approval of similar actions. This is a core part of the self-improving memory system.

### 12.1 Trust Model

Every action Agent Joe can take has an **action signature** — a normalized description of what it does:

```typescript
interface ActionSignature {
  action: string              // e.g., 'spawn_fix_session', 'enable_workflow', 'de-schedule_repo'
  category: string            // e.g., 'dependency_update', 'security_fix', 'workflow_setup'
  severity: string            // e.g., 'low', 'medium', 'high', 'critical'
  repo?: string               // optional — trust can be global or per-repo
}

interface TrustRecord {
  signature: ActionSignature
  approvalCount: number       // times user said "yes" to this pattern
  rejectionCount: number      // times user said "no"
  lastApproved: string        // ISO timestamp
  autoApproved: boolean       // has this crossed the threshold?
}
```

### 12.2 Escalation Ladder

```
┌─────────────────────────────────────────────────────────────┐
│  Approval     │  Threshold  │  Behavior                    │
│  Level        │             │                              │
├───────────────┼─────────────┼──────────────────────────────┤
│  ASK          │  0 prior    │  "Want me to do X?"          │
│               │  approvals  │  (waits for explicit yes)    │
├───────────────┼─────────────┼──────────────────────────────┤
│  NOTIFY+DO    │  2 prior    │  "I'm doing X — same as     │
│               │  approvals  │  last time. I'll let you     │
│               │  (0 rejects)│  know when it's done."       │
├───────────────┼─────────────┼──────────────────────────────┤
│  SILENT       │  5 prior    │  Does it, logs to journal.   │
│               │  approvals  │  User can review in chat     │
│               │  (0 rejects)│  history or journal.         │
└─────────────────────────────────────────────────────────────┘
```

**Key rules**:
- A single rejection **resets** the action back to ASK level for that signature
- Trust is scoped: approving "dependency update in api-gateway" doesn't auto-approve "dependency update in payments-service" (unless the user says "do this for all repos")
- High-severity actions (security fixes, deploys, anything touching `main`) have a **higher threshold**: 4 approvals for NOTIFY+DO, never reach SILENT
- The user can explicitly say "always do this" or "never do this without asking" to override the ladder
- Trust records are stored in `memory.sqlite` and survive restarts

### 12.3 Transparency

Agent Joe is always transparent about its trust level:

> "I'm auto-approving this dependency update — you've approved the same pattern 3 times before. Say 'stop' if you want me to ask first again."

The journal logs every auto-approved action with its trust justification:

```markdown
## 2026-03-17

- 09:14 — **Auto-approved** (NOTIFY+DO): spawned fix session for outdated `axios` in api-gateway
  (trust: 3 prior approvals for `dependency_update` in `api-gateway`, 0 rejections)
- 09:42 — **Asked** (ASK): security finding in payments-service — user approved
  (trust: first time for `security_fix` in `payments-service`)
```

### 12.4 User Override Commands

Users can manage trust directly in the Agent Joe chat:

- *"Always auto-approve dependency updates"* → sets global trust for `dependency_update` to SILENT
- *"Always ask before deploying"* → pins `deploy` actions to ASK level permanently
- *"Show me what you're auto-approving"* → lists all NOTIFY+DO and SILENT trust records
- *"Reset trust"* → clears all learned trust, goes back to ASK for everything

These overrides are stored as pinned `user_preference` memories.

---

### 12.5 Trust Scope: Per-Repo with Global Promotion

Trust is **per-repo by default** — approving "dependency update in api-gateway" twice only auto-approves future dependency updates in api-gateway, not in other repos.

Trust can be **promoted to global** in two ways:

1. **Explicit**: user says "always auto-approve dependency updates" (no repo qualifier) → stored as a global override
2. **Nudged**: when Agent Joe notices the user has approved the same action category in 4+ different repos, it suggests promotion:
   > "You've approved dependency updates in api-gateway, payments-service, frontend, and auth-service. Want me to just handle these everywhere?"

Global overrides are stored as pinned `user_preference` memories and take precedence over per-repo trust records.

---

## 13. Report Monitoring Strategy

### 13.1 Event-Driven with Fallback Poll

Agent Joe learns about new reports through two channels:

1. **Internal event hook** (primary): The workflow engine already generates reports and writes them to `.codekin/reports/`. When a workflow run completes, it emits an internal event that Agent Joe subscribes to. No filesystem watcher needed — this is simpler and more reliable.

2. **Fallback poll** (secondary): Every 15 minutes, Agent Joe scans `.codekin/reports/` across managed repos for any reports it hasn't seen. This catches manually placed reports, reports from external tools, or anything that slipped through the event channel.

### 13.2 Event Flow

```
Workflow Engine completes run
  → emits 'workflow:run:complete' event with { repo, reportType, reportPath }
  → Agent Joe receives event
  → reads report, evaluates findings
  → if actionable: surfaces in chat (respecting trust level)
```

### 13.3 Implementation

```typescript
// In workflow-engine.ts — emit after report is written
eventBus.emit('workflow:run:complete', {
  repo: run.repoPath,
  reportType: run.type,          // 'repo-health', 'security', etc.
  reportPath: outputPath,
  timestamp: new Date().toISOString(),
})

// In orchestrator session — subscribe on startup
eventBus.on('workflow:run:complete', (event) => {
  orchestrator.enqueueReportReview(event)
})
```

No cron jobs, no filesystem watchers — just event subscription + a simple interval poll as safety net.

---

## 14. Resolved Decisions

| Decision | Resolution |
|----------|-----------|
| Name | **Agent Joe** — visible in sidebar and chat |
| Notifications | **In-chat only** — no toasts or badges |
| Child session limit | **3 concurrent** |
| Trust escalation | **Learned trust** — 2 approvals → auto with notification, 5 → silent (§12) |
| Multi-user | **Single shared instance** — Codekin is single-user; scope to user_id later if needed |
| Report monitoring | **Event-driven** from workflow engine + 15-min fallback poll (§13) |
| Trust scope | **Per-repo by default**, explicit or nudged promotion to global (§12.5) |
