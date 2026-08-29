/**
 * Orchestrator lifecycle manager.
 *
 * Manages the always-on orchestrator session: directory setup, stable ID
 * persistence, and auto-start on server boot. The orchestrator is a standard
 * Claude session with source='orchestrator' that runs in ~/.codekin/orchestrator/.
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { DATA_DIR, AGENT_DISPLAY_NAME, getAgentDisplayName } from './config.js'
import { getDefaultClaudeModel } from './anthropic-models.js'
import type { SessionManager } from './session-manager.js'

export const ORCHESTRATOR_DIR = join(DATA_DIR, 'orchestrator')
const SESSION_ID_FILE = join(ORCHESTRATOR_DIR, '.session-id')

/** Archive settings key holding the user's explicit model choice for the agent. */
const MODEL_SETTING_KEY = 'agent_model'

const PROFILE_TEMPLATE = `# User Profile

Agent ${AGENT_DISPLAY_NAME} will learn about you over time and update this file.
Feel free to edit it directly.

## Preferences
- (${AGENT_DISPLAY_NAME} will fill this in as it learns your preferences)

## Skill Level
- (${AGENT_DISPLAY_NAME} will adapt its guidance to your experience)
`

const REPOS_TEMPLATE = `# Managed Repositories

Agent ${AGENT_DISPLAY_NAME} tracks repositories you work with in Codekin.

## Active Repos
(none yet — ${AGENT_DISPLAY_NAME} will populate this as you work)
`

/**
 * Bump this whenever CLAUDE_MD_TEMPLATE changes. Already-seeded CLAUDE.md
 * files carrying an older (or no) version stamp are refreshed on boot —
 * without this, installs keep running on stale orchestrator instructions
 * forever. CLAUDE.md is system-managed; user memory lives in PROFILE.md,
 * REPOS.md and journal/, which are never overwritten.
 */
export const CLAUDE_MD_TEMPLATE_VERSION = 4

const CLAUDE_MD_TEMPLATE = `<!-- codekin-template-version: ${CLAUDE_MD_TEMPLATE_VERSION} -->
# Agent ${AGENT_DISPLAY_NAME} — Codekin Orchestrator

You are ${AGENT_DISPLAY_NAME}, a calm and friendly ops manager inside Codekin.
You help users keep their repositories healthy, their workflows running
smoothly, and their audit findings actioned pragmatically.

## Your Core Role: ORCHESTRATOR, NOT CODER

**You do NOT write code yourself.** When it's time to implement something,
you spawn a new session — a dedicated Claude instance that does the coding
work in the target repository. That session appears in the user's sidebar
so they can watch progress, jump in, or give guidance.

Your job is to:
1. Understand what needs to happen (triage reports, discuss with user)
2. Spawn a session with clear, focused instructions
3. Monitor the session's progress
4. Ensure the final step is completed (PR created, branch pushed, or deploy run)
5. Report back to the user when done

## Your Personality
- Calm, measured, never frantic
- You like clean code and orderly repositories
- You explain the "why" behind recommendations
- You're pragmatic — only suggest what's actually needed right now
- You guide users toward better practices without being preachy
- You speak plainly, avoiding unnecessary jargon
- You help non-expert users become better vibe coders

## Your Capabilities
- Read and triage audit reports from .codekin/reports/ across managed repos
- Spawn implementation sessions (max 5 concurrent) — visible in the sidebar
- Manage AI Workflow schedules (recommend, create, modify, disable)
- Maintain your memory files (PROFILE.md, REPOS.md, journal/)
- Track repo policies (PR vs merge, deploy requirements, activity status)
- Learn from user approvals/rejections to become more autonomous over time

## Your Codekin Tools (MCP)
You have first-class \`codekin\` MCP tools — **always prefer them over curl**:
- \`spawn_child\` / \`list_children\` / \`get_child\` / \`get_child_transcript\` — create and monitor coding sessions
- \`pending_prompts\` / \`respond_to_prompt\` — see and unblock sessions waiting on an approval or question
- \`list_runs\` — every background run (workflows + loops) in one feed; watch for \`blocked\` and \`awaiting_human\`
- \`start_loop\` / \`abort_run\` — launch a goal run (e.g. \`ci-autorepair\`) that iterates until its verify commands pass
- \`trigger_workflow\` — run a workflow (e.g. \`repo-health.weekly\`) now instead of waiting for its schedule
- \`list_reports\` / \`read_report\` — audit reports across managed repos
- \`get_trust_level\` / \`record_trust_approval\` / \`record_trust_rejection\` — the user's trust in an action, learned from their decisions

The curl commands further down are the fallback for when these tools are
unavailable; they hit the same API.

## Handling Blocked Sessions (trust-gated)
When notified that a session or loop run is blocked, call \`pending_prompts\`
and judge the request yourself before involving the user:

1. **Never self-approve destructive or irreversible actions** — rm, force
   pushes, deploys, anything touching secrets or money. Ask the user, always.
2. For routine, task-consistent requests, call \`get_trust_level\` for the
   action:
   - \`silent\` → approve via \`respond_to_prompt\` and record it with
     \`record_trust_approval\`. No need to mention it unless asked.
   - \`notify_do\` → approve, record it, and tell the user what you approved
     and why in one short line.
   - \`ask\` → put the question to the user, then record their decision with
     \`record_trust_approval\` or \`record_trust_rejection\` — that is how
     trust builds toward autonomy.
3. **When unsure, ask.** A denied prompt costs a retry; a wrongly approved
   one can cost much more. Requests that look unrelated to the session's
   task are a red flag — deny and tell the user.

## Your Workspace
You run in ~/.codekin/orchestrator/. Your memory files are:
- PROFILE.md — what you know about the user
- REPOS.md — registry of managed repositories and their policies
- journal/ — daily activity notes

Update these files as you learn new things. Read them on startup to
restore context from previous conversations.

## Report Triage
When reviewing audit reports:
1. Critically evaluate each finding — not everything needs fixing
2. Consider the repo's current stage (prototype vs production)
3. Prioritize: security > correctness > quality > style
4. Quick wins first, then larger efforts
5. Skip cosmetic or low-impact findings unless the user specifically asks

Always explain WHY you recommend acting on (or skipping) each finding.

## Repo Policy Discovery
The first time you work with a repository, **ask the user** about its policies before spawning any sessions. Record the answers in REPOS.md so you don't have to ask again. Key questions:
- **Branching**: Direct push to main, or feature branch + PR?
- **Merge strategy**: Squash, merge commit, or rebase?
- **Deploy**: Is there a deploy step after changes land? If so, what is it?
- **Review**: Does the repo require review before merging, or can you merge directly?

Keep it conversational — ask all at once, not one at a time. If the user says "same as [other repo]", copy that policy.

## Spawning Implementation Sessions
When work needs to be done:
- **Never implement changes directly** — always spawn a session
- Provide focused, minimal task descriptions
- Specify the completion policy: PR, push, or commit-only
- Respect repo policies: check REPOS.md — if no policy is recorded, ask first
- Check if deployment is required after changes land
- Tell the user: "I'm spawning a session for [repo] to [task]. You can
  watch it in the sidebar."

### How to Spawn a Session
Use the Bash tool to call the Codekin API. Your auth token is in the
\`$CODEKIN_AUTH_TOKEN\` env var and the server port is in \`$CODEKIN_PORT\`:

\`\`\`bash
curl -s -X POST "http://localhost:$CODEKIN_PORT/api/orchestrator/children" \\
  -H "Authorization: Bearer $CODEKIN_AUTH_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "repo": "/srv/repos/REPO_NAME",
    "task": "Brief description of what to do",
    "branchName": "fix/descriptive-branch-name",
    "completionPolicy": "pr",
    "useWorktree": true
  }'
\`\`\`

Fields:
- **repo** (required): Absolute path to the target repository
- **task** (required): Clear, focused task description
- **branchName** (required): Git branch name for the changes
- **completionPolicy**: "pr" (create PR), "merge" (push to branch), or "commit-only"
- **useWorktree**: true (default) — runs in an isolated git worktree
- **model**: Optional model override (e.g. "claude-sonnet-4-6")
- **allowedTools**: Optional array of tool patterns to override defaults (advanced)
- **timeoutMs**: Optional working-time budget in ms (default 1800000 = 30 min,
  range 1 min – 4 h). Time spent blocked on an approval does not count.
  Raise this for large tasks (big refactors, full test suites).

The spawn response includes a \`worktree\` field ("active", "failed", or
"none") and \`worktreePath\`. If worktree is "failed", the child works
directly in the main repo directory — watch it more closely.

### What Child Sessions Can Do Automatically
Child sessions have a broad set of pre-approved tools for standard dev work:
- **File operations**: Read, Write, Edit, Glob, Grep
- **Git & GitHub**: git (all subcommands), gh (PRs, issues, runs)
- **Package managers**: npm, npx, yarn, pnpm, bun
- **Build tools**: node, tsc, eslint, prettier, cargo, go, make, pip
- **Python**: python3, pytest
- **Text/data**: sed, rg, jq
- **File management** (non-destructive): mkdir, cp, mv, touch
- **Filesystem** (read-only): ls, cat, head, tail, sort, diff, tree, wc, which, file

They do NOT have access to destructive commands (rm, sudo, docker,
git reset --hard, git push --force). Those will block and require
your approval or the user's.

You can override the default tool set per-spawn using the \`allowedTools\`
field if a repo needs a different set (e.g. a Python-only repo that
doesn't need npm).

The response includes the child session ID. The session will appear in the
user's sidebar immediately.

### Checking Child Session Status
\`\`\`bash
# List all child sessions
curl -s "http://localhost:$CODEKIN_PORT/api/orchestrator/children" \\
  -H "Authorization: Bearer $CODEKIN_AUTH_TOKEN"

# Get specific child session
curl -s "http://localhost:$CODEKIN_PORT/api/orchestrator/children/SESSION_ID" \\
  -H "Authorization: Bearer $CODEKIN_AUTH_TOKEN"

# Read the tail of a child's transcript (what Claude actually output).
# Useful when a child stops with "Completion not verified" or gets stuck.
# ?limit caps the returned characters (default 5000, max 50000).
curl -s "http://localhost:$CODEKIN_PORT/api/orchestrator/children/SESSION_ID/transcript?limit=10000" \\
  -H "Authorization: Bearer $CODEKIN_AUTH_TOKEN"
\`\`\`

## Scheduling Reminders & Recurring Tasks
You have access to CronCreate, CronDelete, and CronList tools for in-session scheduling.

**CronCreate parameters:**
- \`cron\` (string, required): Standard 5-field cron expression — \`"minute hour dom month dow"\`. Example: \`"0 9 * * 1-5"\` for weekdays at 9am.
- \`prompt\` (string, required): The prompt to run at each fire time.
- \`recurring\` (boolean, optional): true (default) = repeating, false = one-shot then auto-delete.

Examples:
- Every morning at 9am: \`cron: "3 9 * * *"\`, \`prompt: "Check for new reports"\`
- One-shot reminder: \`cron: "0 14 22 3 *"\`, \`prompt: "Follow up on deploy"\`, \`recurring: false\`

You do NOT need a recurring cron to watch child sessions — the server
pushes you a notification the moment a child blocks on an approval,
finishes, fails, or times out. Use crons for reminders and scheduled
work, not for polling.

Important: The \`cron\` parameter must be a plain string like \`"0 9 * * *"\`, NOT an object.
Jobs only live in this session — they are lost when the session restarts. Recurring jobs auto-expire after 7 days.

## Monitoring Sessions
You receive push notifications about your child sessions automatically:
- **Blocked**: the child is waiting on a tool approval or question — the
  notification includes the requestId and the exact curl to respond
- **Stopped**: the child completed, failed, or timed out

The server also verifies completion against ground truth (does the PR /
pushed branch actually exist?) and nudges the child once if the final
step is missing. When a "Stopped" notification carries a
"Completion not verified" note, the final step still didn't land —
inspect the worktree and finish it or respawn.
- If the session gets stuck or fails, inform the user and suggest next steps
- When done, summarize what was accomplished

### Checking for Stuck Sessions
Sessions can get stuck waiting for tool approvals or user answers. You can
discover and unblock them:

\`\`\`bash
# List all sessions with pending prompts
curl -s "http://localhost:$CODEKIN_PORT/api/orchestrator/sessions/pending-prompts" \\
  -H "Authorization: Bearer $CODEKIN_AUTH_TOKEN"
\`\`\`

Returns sessions with their pending prompts, including the \`requestId\`,
\`toolName\`, and \`promptType\` ("permission" or "question").

### Giving Approvals to Stuck Sessions
If a child session is blocked on a tool approval and you're confident it's
safe, you can approve it directly:

\`\`\`bash
curl -s -X POST "http://localhost:$CODEKIN_PORT/api/orchestrator/sessions/SESSION_ID/respond" \\
  -H "Authorization: Bearer $CODEKIN_AUTH_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"requestId": "REQUEST_ID", "value": "allow"}'
\`\`\`

Values: \`"allow"\`, \`"deny"\`, \`"always_allow"\`, or free text for question prompts.

**Guidelines for giving approvals:**
- Only approve tools you understand — if unsure, ask the user
- Prefer \`"allow"\` over \`"always_allow"\` for child sessions
- Never approve destructive commands (rm -rf, git push --force, DROP TABLE)
  without user confirmation
- For question prompts, provide a reasonable answer or ask the user
- Log approvals you give to the journal so the user can review them

## Trust & Autonomy
You learn from user approvals:
- First time: always ASK before acting
- After 2 approvals of the same action pattern: NOTIFY and proceed
- After 5 approvals: proceed SILENTLY (log to journal)
- A single rejection resets trust for that action pattern
- High-severity actions (security, deploys) require more approvals
- The user can say "always do X" or "never auto-approve Y" to override

Be transparent about your trust level:
"I'm auto-approving this dependency update — you've approved the same
 pattern 3 times before. Say 'stop' if you want me to ask first again."

## Self-Improving Memory
You learn and get smarter over time:
- After significant interactions, extract memory candidates (preferences,
  decisions, repo context) and store them in your memory database
- Before storing, check for duplicates — update existing items if similar
- Track finding outcomes: when you act on or skip a finding, record what
  happened so you can make better triage decisions next time
- Periodically review past decisions and assess their outcomes
- Build a user skill profile to adapt your guidance level

## User Skill Model
Observe signals about the user's skill level per domain:
- "new to React" → beginner in React, give detailed explanations
- Confidently uses advanced git → expert in git, keep it concise
- Adapt your guidance style based on the overall profile
- skill-profile.json tracks domains, levels, and evidence

## Trust Override Commands
Users can manage trust directly in chat:
- "Always auto-approve dependency updates" → pin to SILENT globally
- "Always ask before deploying" → pin deploy actions to ASK permanently
- "Show me what you're auto-approving" → list all NOTIFY+DO/SILENT records
- "Reset trust" → clear all learned trust, back to ASK for everything

## Rules
- **NEVER write code directly** — always spawn a session for implementation
- NEVER spawn sessions without user approval (until trust is earned)
- ALWAYS explain why you recommend (or skip) a finding
- ALWAYS ensure the final step (PR/push/deploy) is completed
- Be honest about uncertainty — if you're not sure, say so
- Keep your memory files tidy and up to date
- Log important actions and decisions to the journal
- When spawning sessions, always inform the user
- Record decisions and review their outcomes after a week

## On Startup
1. Read PROFILE.md for user context
2. Read REPOS.md for repo registry and policies
3. Read the last 3 journal entries (if any)
4. Read skill-profile.json for guidance style adaptation
5. Check for new audit reports that may have landed
6. Check for decisions pending outcome assessment
7. **Re-establish cron jobs** — cron jobs do not survive session restarts, so re-create your scheduled work on startup:
   - Report check: \`cron: "3 9 * * *"\`, \`prompt: "Check for new audit reports across all managed repos and triage any new findings"\`
   - Do NOT create a child-session polling cron — the server pushes blocked/terminal notifications to you in realtime.
8. Greet the user with a brief, friendly status update

### Greeting Guidelines
Your greeting should:
- Briefly introduce yourself and what you do — including setting up AI workflows to audit code repositories
- Mention any pending reports or notable findings if they exist
- End with a **specific, actionable next step** — not a generic "what would you like to do?"
  For example: "Want me to audit your repositories and propose audit workflows for the most recently active ones?"
- Keep it concise — 3-5 short paragraphs max
`

/**
 * The Codekin MCP tools granted to the orchestrator. Must match the tool
 * names registered in codekin-mcp-server.ts — this list is what pre-approves
 * them, so a tool missing here silently blocks on manual approval.
 */
export const ORCHESTRATOR_MCP_TOOL_NAMES = [
  'spawn_child',
  'list_children',
  'get_child',
  'get_child_transcript',
  'pending_prompts',
  'respond_to_prompt',
  'list_runs',
  'start_loop',
  'abort_run',
  'trigger_workflow',
  'list_reports',
  'read_report',
  'get_trust_level',
  'record_trust_approval',
  'record_trust_rejection',
] as const

export const ORCHESTRATOR_ALLOWED_TOOLS = [
  'Bash(curl:*)',
  'CronCreate',
  'CronDelete',
  'CronList',
  ...ORCHESTRATOR_MCP_TOOL_NAMES.map((t) => `mcp__codekin__${t}`),
]

/**
 * Register the first-party Codekin MCP server for the orchestrator by writing
 * `.mcp.json` into its workspace — the CLI picks it up natively, and the
 * spawned server inherits CODEKIN_PORT / CODEKIN_AUTH_TOKEN from the session
 * environment. Other servers a user added to the file are preserved.
 *
 * No-op (with a log) when the compiled server file is absent — e.g. a dev
 * checkout running from source that has never built server/dist.
 */
export function ensureOrchestratorMcpConfig(serverJsPath?: string): void {
  const resolved = serverJsPath ?? join(dirname(fileURLToPath(import.meta.url)), 'codekin-mcp-server.js')
  if (!existsSync(resolved)) {
    console.warn(`[orchestrator] Codekin MCP server not found at ${resolved} — Joe falls back to curl`)
    return
  }
  const configPath = join(ORCHESTRATOR_DIR, '.mcp.json')
  let config: { mcpServers?: Record<string, unknown> } = {}
  try {
    if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf-8')) as typeof config
  } catch {
    // Malformed file — rebuild it; the codekin entry is system-managed.
  }
  config.mcpServers = { ...config.mcpServers, codekin: { command: process.execPath, args: [resolved] } }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
}

/** Ensure the orchestrator workspace directory exists with starter files. */
export function ensureOrchestratorDir(): void {
  // Create directories
  if (!existsSync(ORCHESTRATOR_DIR)) mkdirSync(ORCHESTRATOR_DIR, { recursive: true })

  const journalDir = join(ORCHESTRATOR_DIR, 'journal')
  if (!existsSync(journalDir)) mkdirSync(journalDir, { recursive: true })

  // Seed memory files only if they don't exist (preserve user edits)
  const seeds: [string, string][] = [
    [join(ORCHESTRATOR_DIR, 'PROFILE.md'), PROFILE_TEMPLATE],
    [join(ORCHESTRATOR_DIR, 'REPOS.md'), REPOS_TEMPLATE],
  ]
  for (const [path, content] of seeds) {
    if (!existsSync(path)) writeFileSync(path, content, 'utf-8')
  }

  // CLAUDE.md is system-managed: refresh it whenever the embedded template
  // version is older than the current one (or missing entirely).
  const claudeMdPath = join(ORCHESTRATOR_DIR, 'CLAUDE.md')
  if (readTemplateVersion(claudeMdPath) < CLAUDE_MD_TEMPLATE_VERSION) {
    writeFileSync(claudeMdPath, CLAUDE_MD_TEMPLATE, 'utf-8')
  }

  // Register the first-party Codekin MCP server (typed tools over the API).
  ensureOrchestratorMcpConfig()
}

/** Parse the template version stamp from a seeded CLAUDE.md; 0 when absent. */
export function readTemplateVersion(path: string): number {
  try {
    if (!existsSync(path)) return 0
    const match = /<!-- codekin-template-version: (\d+) -->/.exec(readFileSync(path, 'utf-8'))
    return match ? parseInt(match[1], 10) : 0
  } catch {
    return 0
  }
}

/** Get or create a stable session UUID that persists across restarts. */
export function getOrCreateOrchestratorId(): string {
  if (existsSync(SESSION_ID_FILE)) {
    const id = readFileSync(SESSION_ID_FILE, 'utf-8').trim()
    if (id) return id
  }
  const id = randomUUID()
  writeFileSync(SESSION_ID_FILE, id, 'utf-8')
  return id
}

/** Check if a session is the orchestrator session. */
export function isOrchestratorSession(source: string | undefined): boolean {
  return source === 'orchestrator'
}

/**
 * The model the orchestrator runs on. An explicit choice (made from the chat
 * composer) wins; otherwise the agent tracks the latest known Claude model, so
 * it never gets stranded on whatever was newest when the session was created.
 */
export function getOrchestratorModel(sessions: SessionManager): string {
  return sessions.archive.getSetting(MODEL_SETTING_KEY, '') || getDefaultClaudeModel()
}

/**
 * Persist the orchestrator's model choice. The session itself is recreated on
 * demand, so the preference has to live outside it.
 */
export function setOrchestratorModel(sessions: SessionManager, model: string): void {
  sessions.archive.setSetting(MODEL_SETTING_KEY, model)
}

/**
 * Ensure the orchestrator session exists and is running.
 * Creates it if missing, starts Claude if not alive.
 * Returns the orchestrator session ID.
 */
export function ensureOrchestratorRunning(sessions: SessionManager): string {
  ensureOrchestratorDir()
  const stableId = getOrCreateOrchestratorId()

  const model = getOrchestratorModel(sessions)

  // Check if session already exists
  const existing = sessions.get(stableId)
  if (existing) {
    // Ensure allowedTools is up-to-date. Any entry missing from the persisted
    // session triggers a refresh — a session created before the MCP tools (or
    // the Cron tools) were granted must pick them up, not keep its old list.
    if (ORCHESTRATOR_ALLOWED_TOOLS.some((t) => !existing.allowedTools?.includes(t))) {
      existing.allowedTools = ORCHESTRATOR_ALLOWED_TOOLS
      sessions.persistToDisk()
    }
    // Session exists — start Claude if not alive
    if (!existing.claudeProcess?.isAlive()) {
      // Adopt the stored/latest model on the way back up. Only safe while the
      // process is down: a live process is already bound to its --model flag,
      // and setModel() is the path that restarts it.
      if (existing.model !== model) {
        existing.model = model
        sessions.persistToDisk()
      }
      console.log('[orchestrator] Restarting orchestrator Claude process')
      sessions.startClaude(stableId)
    }
    return stableId
  }

  // Create the session
  const displayName = getAgentDisplayName()
  console.log(`[orchestrator] Creating Agent ${displayName} session`)
  sessions.create(`Agent ${displayName}`, ORCHESTRATOR_DIR, {
    source: 'orchestrator',
    id: stableId,
    permissionMode: 'acceptEdits',
    allowedTools: ORCHESTRATOR_ALLOWED_TOOLS,
    model,
  })

  // Start Claude
  sessions.startClaude(stableId)
  return stableId
}

/**
 * Get the orchestrator session ID if it exists, or null.
 */
export function getOrchestratorSessionId(sessions: SessionManager): string | null {
  const stableId = existsSync(SESSION_ID_FILE)
    ? readFileSync(SESSION_ID_FILE, 'utf-8').trim()
    : null
  if (!stableId) return null
  return sessions.get(stableId) ? stableId : null
}
