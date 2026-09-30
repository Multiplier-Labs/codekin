/**
 * The first-party Codekin MCP server.
 *
 * Wraps the local Codekin REST API as typed MCP tools, replacing the
 * string-built curl commands the orchestrator (Joe) previously drove the API
 * with. Spawned over stdio by the orchestrator's CLI process (registered via
 * ~/.codekin/orchestrator/.mcp.json — see orchestrator-manager), it inherits
 * CODEKIN_PORT and the session-scoped CODEKIN_AUTH_TOKEN from that process's
 * environment, so no extra secret plumbing exists.
 *
 * Tool names must stay in sync with ORCHESTRATOR_MCP_TOOL_NAMES in
 * orchestrator-manager.ts — that list is what pre-approves them for Joe.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { pathToFileURL } from 'url'
import { z } from 'zod'
import { CodekinApi } from './codekin-mcp-api.js'

function asText(result: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
}

/** Wrap an API call so failures surface as tool errors, not transport crashes. */
async function run(call: () => Promise<unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    return asText(await call())
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
}

export function buildCodekinMcpServer(api: CodekinApi): McpServer {
  const server = new McpServer({ name: 'codekin', version: '1.0.0' })

  server.registerTool(
    'spawn_child',
    {
      description:
        'Spawn a child coding session in a repo. The child works autonomously on the task and you are notified of progress, blocks, and completion. Max 5 concurrent.',
      inputSchema: {
        repo: z.string().describe('Absolute path to the repository'),
        task: z.string().describe('Focused task description for the child'),
        branchName: z.string().describe('Branch the child works on, e.g. fix/thing'),
        completionPolicy: z.enum(['pr', 'merge', 'commit-only']).optional()
          .describe('How finished work lands: pr (default) opens a pull request, merge pushes the branch without merging, commit-only commits locally'),
        useWorktree: z.boolean().optional().describe('Isolate the child in a git worktree (default true)'),
        taskId: z.string().optional().describe('Task this child works on (from list_tasks/create_task) — the task then tracks the child automatically'),
        timeoutMs: z.number().int().min(60_000).max(14_400_000).optional()
          .describe('Working-time budget in ms, 1 min to 4 h (default 30 min); time blocked on prompts does not count'),
        provider: z.enum(['claude', 'codex', 'opencode']).optional().describe('Agent harness; defaults to Joe’s selected harness. Honor the user’s choice.'),
        model: z.string().optional().describe('Model for the selected harness; inherits Joe’s model only when using the same harness. Children always run at Joe’s permission level.'),
      },
    },
    (args) => run(() => api.spawnChild(args)),
  )

  server.registerTool(
    'list_children',
    { description: 'List your child sessions with status: starting/running/blocked, or terminal completed (final step verified — see verification), unverified (PR/push not confirmed; check before reporting it ready), failed, timed_out, canceled.', inputSchema: {} },
    () => run(() => api.listChildren()),
  )

  server.registerTool(
    'get_child',
    { description: 'Get one child session, including its result, error, and verification evidence (commit, PR) once terminal. Also returns children from earlier server runs.', inputSchema: { id: z.string() } },
    ({ id }) => run(() => api.getChild(id)),
  )

  server.registerTool(
    'get_child_transcript',
    {
      description: 'Read a child session\'s recent transcript — use to check progress mid-flight before nudging or waiting.',
      inputSchema: { id: z.string(), limit: z.number().int().positive().optional().describe('Max characters (default 10000)') },
    },
    ({ id, limit }) => run(() => api.getChildTranscript(id, limit)),
  )

  server.registerTool(
    'send_to_child',
    {
      description:
        'Send a follow-up instruction to one of your active children that is not waiting on a prompt. A turn in progress receives it as its next message. Answer pending prompts with respond_to_prompt instead; for finished children use resume_child.',
      inputSchema: { id: z.string().describe('Child session id'), text: z.string().min(1) },
    },
    ({ id, text }) => run(() => api.sendToChild(id, text)),
  )

  server.registerTool(
    'stop_child',
    {
      description: 'Stop one of your active children. It becomes canceled; its worktree, branch, and transcript are kept, so resume_child can continue it later.',
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(() => api.stopChild(id)),
  )

  server.registerTool(
    'resume_child',
    {
      description:
        'Start another supervised attempt on a finished child (completed, unverified, failed, timed_out, canceled — including ones interrupted by a restart): same session, branch, and worktree, fresh working-time budget, completion re-verified. Counts toward the 5-child limit.',
      inputSchema: {
        id: z.string(),
        instructions: z.string().optional().describe('What to do next; defaults to finishing the task and delivering per its completion policy'),
      },
    },
    ({ id, instructions }) => run(() => api.resumeChild(id, instructions)),
  )

  server.registerTool(
    'close_child',
    {
      description:
        'Close one of your children. mode "archive" (default) stops it and keeps session, transcript, worktree, and branch — resumable. mode "delete" removes the session; a clean worktree is removed, one with uncommitted work is kept and listed. Branches are never deleted. Active children are refused unless cancel is true. Returns exactly what happened.',
      inputSchema: {
        id: z.string(),
        mode: z.enum(['archive', 'delete']).optional(),
        cancel: z.boolean().optional().describe('Also stop the child if it is still active'),
      },
    },
    ({ id, mode, cancel }) => run(() => api.closeChild(id, { mode, cancel })),
  )

  server.registerTool(
    'list_sessions',
    {
      description:
        'All Codekin sessions in one compact row each: state (working / idle / waiting_on_prompt / stopped / archived), repo, branch, and — for your children — child status and verification. Control tools only act on your own children.',
      inputSchema: {
        source: z.enum(['manual', 'webhook', 'workflow', 'stepflow', 'orchestrator', 'agent']).optional(),
        active: z.boolean().optional().describe('Exclude archived sessions'),
      },
    },
    (args) => run(() => api.listSessions(args)),
  )

  server.registerTool(
    'list_tasks',
    {
      description:
        'Your per-repo task list with counts. Statuses: todo, in_progress, needs_decision (waiting on the user), in_review (verified PR ready), done, dismissed. Task status follows its linked child automatically.',
      inputSchema: {
        repo: z.string().optional().describe('Absolute repo path; omit for all repos'),
        status: z.enum(['todo', 'in_progress', 'needs_decision', 'in_review', 'done', 'dismissed']).optional(),
      },
    },
    (args) => run(() => api.listTasks(args)),
  )

  server.registerTool(
    'get_task',
    { description: 'One task with its full history (attempts, decisions, reviews).', inputSchema: { id: z.string() } },
    ({ id }) => run(() => api.getTask(id)),
  )

  server.registerTool(
    'create_task',
    {
      description:
        'Add a task to a repo\'s list — e.g. an audit finding or follow-up the user agreed to. It starts as todo; start it with spawn_child (taskId). Do not create tasks the user has not asked for or approved.',
      inputSchema: {
        repo: z.string().describe('Absolute repo path'),
        title: z.string().min(1).max(300),
        detail: z.string().optional().describe('What to do, with enough context for a coding agent'),
        acceptance: z.string().optional().describe('How we know it is done'),
        priority: z.enum(['high', 'normal', 'low']).optional(),
        completionPolicy: z.enum(['pr', 'merge', 'commit-only']).optional(),
        source: z.enum(['joe', 'report', 'incident']).optional(),
        sourceRef: z.string().optional().describe('e.g. the report path the finding came from'),
        originSessionId: z.string().optional().describe('Repo session the request came from — its milestones are posted back there'),
        originRequestId: z.string().optional().describe('The @Joe request id from the Session Request notification'),
      },
    },
    (args) => run(() => api.createTask(args)),
  )

  server.registerTool(
    'update_task',
    {
      description:
        'Edit a task, or set its status to todo / done / dismissed (e.g. done once its PR merged). Other statuses follow the linked child and the user\'s review.',
      inputSchema: {
        id: z.string(),
        title: z.string().min(1).max(300).optional(),
        detail: z.string().optional(),
        acceptance: z.string().optional(),
        priority: z.enum(['high', 'normal', 'low']).optional(),
        status: z.enum(['todo', 'done', 'dismissed']).optional(),
        note: z.string().optional().describe('Why — recorded in the task history'),
      },
    },
    ({ id, ...patch }) => run(() => api.updateTask(id, patch)),
  )

  server.registerTool(
    'request_decision',
    {
      description:
        'Ask the user a decision you cannot make within the agreed scope. The task moves to needs_decision and shows in their "Needs your decision" list; you are notified with the answer. Explain what is blocked, your recommendation, and the consequence of each option.',
      inputSchema: {
        id: z.string().describe('Task id'),
        question: z.string().min(1),
        recommendation: z.string().optional(),
        options: z.array(z.string().min(1).max(200)).max(6).optional().describe('One-click answers; the user can always answer in free text'),
      },
    },
    ({ id, ...input }) => run(() => api.requestDecision(id, input)),
  )

  server.registerTool(
    'reply_in_session',
    {
      description:
        'Answer an @Joe request in the repo session it came from. The reply appears in that conversation attributed to you; the coding agent does not see it. Pass taskId to attach a task card.',
      inputSchema: {
        sessionId: z.string(),
        text: z.string().min(1),
        requestId: z.string().optional().describe('The request id from the Session Request notification'),
        taskId: z.string().optional(),
      },
    },
    ({ sessionId, ...input }) => run(() => api.replyInSession(sessionId, input)),
  )

  server.registerTool(
    'get_session_context',
    {
      description: 'Read a repo session\'s recent conversation (user, agent, and @Joe exchanges), its branch, who controls its execution, and its linked tasks.',
      inputSchema: { sessionId: z.string(), limit: z.number().int().positive().optional().describe('Max characters (default 10000)') },
    },
    ({ sessionId, limit }) => run(() => api.getSessionContext(sessionId, limit)),
  )

  server.registerTool(
    'take_over_session',
    {
      description:
        'Take control of a repo session\'s execution when the user explicitly asked you to in that session (pass that @Joe requestId). Returns the controller revision to use with send_to_session. Never take over work the user did not hand you.',
      inputSchema: { sessionId: z.string(), requestId: z.string(), taskId: z.string().optional().describe('Task you supervise it for') },
    },
    ({ sessionId, ...input }) => run(() => api.takeOverSession(sessionId, input)),
  )

  server.registerTool(
    'send_to_session',
    {
      description:
        'Instruct the coding agent of a session you control (not your own children — use send_to_child for those). Refused once the user takes back control or when your controllerRevision is stale.',
      inputSchema: { sessionId: z.string(), text: z.string().min(1), controllerRevision: z.number().int().nonnegative() },
    },
    ({ sessionId, ...input }) => run(() => api.sendToSession(sessionId, input)),
  )

  server.registerTool(
    'pending_prompts',
    { description: 'List sessions blocked on a tool approval or question, with the requestId needed to respond.', inputSchema: {} },
    () => run(() => api.pendingPrompts()),
  )

  server.registerTool(
    'respond_to_prompt',
    {
      description: 'Answer a blocked session\'s prompt. For permission prompts value is "allow" or "deny"; for questions it is the answer text, or one answer per question when the prompt asks several.',
      inputSchema: { sessionId: z.string(), requestId: z.string(), value: z.union([z.string().min(1), z.array(z.string()).min(1)]) },
    },
    ({ sessionId, requestId, value }) => run(() => api.respondToPrompt(sessionId, requestId, value)),
  )

  server.registerTool(
    'get_repo_activity',
    {
      description:
        'Activity tiers for configured repos (active / cooling / dormant) with the signals behind them — last commit, session, commit event, PR event. Dormant repos have their scheduled workflows held; cooling repos are throttled to weekly.',
      inputSchema: {},
    },
    () => run(() => api.getRepoActivity()),
  )

  server.registerTool(
    'list_deployments',
    {
      description:
        'Monitored deployments with each probe\'s latest sample (http status/latency/TLS, pm2 status/restarts/memory, disk free). Breaches arrive as notifications; use this for current state.',
      inputSchema: {},
    },
    () => run(() => api.listDeployments()),
  )

  server.registerTool(
    'get_deployment_samples',
    {
      description: 'Sample history for one probe (newest first) — use to see when a breach started or whether a metric is trending.',
      inputSchema: { probeKey: z.string().describe('Probe key from list_deployments'), limit: z.number().int().positive().optional() },
    },
    ({ probeKey, limit }) => run(() => api.getDeploymentSamples(probeKey, limit)),
  )

  server.registerTool(
    'list_runs',
    {
      description: 'List background runs (workflows and loops) newest-first in one unified shape. Filter by engine or status.',
      inputSchema: {
        engine: z.enum(['workflow', 'loop']).optional(),
        status: z.string().optional().describe('e.g. running, blocked, paused, succeeded, failed'),
        limit: z.number().int().positive().optional(),
      },
    },
    (args) => run(() => api.listRuns(args)),
  )

  server.registerTool(
    'start_loop',
    {
      description:
        'Start a loop run from a recipe (act → evaluate → continue loop). The run iterates until its evaluators pass, then lands the change per the recipe\'s completion action.',
      inputSchema: {
        recipeId: z.string().describe('Loop recipe id, e.g. ci-autorepair'),
        repo: z.string().describe('Absolute repo path'),
        branch: z.string().optional().describe('Branch for the agent to work on (default: generated loop/<recipe>-<timestamp>)'),
        goal: z.string().optional().describe('Override the recipe\'s default outcome text'),
      },
    },
    (args) => run(() => api.startLoop(args)),
  )

  server.registerTool(
    'abort_run',
    { description: 'Cancel an in-flight loop run.', inputSchema: { runId: z.string() } },
    ({ runId }) => run(() => api.abortRun(runId)),
  )

  server.registerTool(
    'trigger_workflow',
    {
      description:
        'Run a workflow now instead of waiting for its schedule: pass automationId to run a configured repo automation, or kind + input.repoPath for a one-off run. Returns the run (id, status) — watch it with list_runs.',
      inputSchema: {
        automationId: z.string().optional().describe('Configured repo automation to run (from list_repo_automations)'),
        kind: z.string().optional().describe('Workflow kind for a one-off run, e.g. repo-health.weekly'),
        input: z.record(z.string(), z.unknown()).optional().describe('One-off run input, e.g. { repoPath }'),
      },
    },
    ({ automationId, kind, input }) => run(async () => {
      if (!automationId && !kind) throw new Error('Pass automationId or kind')
      return api.triggerWorkflow({ automationId, kind, input })
    }),
  )

  // --- workflow definitions and repo automations -------------------------

  const changeFields = {
    reason: z.string().min(1).describe('Why — recorded in the automation\'s change history'),
    idempotencyKey: z.string().min(8).max(200)
      .describe('Unique per intended change; reuse the same key when retrying so the change applies once'),
    authorization: z.string().optional().describe('What authorizes it, e.g. "user asked in session <id>"'),
    originSessionId: z.string().optional().describe('Session the request came from'),
    taskId: z.string().optional().describe('Task the change belongs to'),
  }

  server.registerTool(
    'list_workflows',
    {
      description:
        'Workflow definitions available to a repo — built-ins, repo overrides of a built-in, and repo-only kinds — with source file, content hash and the per-automation settings you can change without a definition edit.',
      inputSchema: { repo: z.string().optional().describe('Absolute repo path; omit for built-ins only') },
    },
    ({ repo }) => run(() => api.listWorkflows(repo)),
  )

  server.registerTool(
    'get_workflow',
    {
      description: 'The effective definition of one workflow kind for a repo, including its prompt, source file and hash.',
      inputSchema: { kind: z.string(), repo: z.string().optional().describe('Absolute repo path') },
    },
    ({ kind, repo }) => run(() => api.getWorkflow(kind, repo)),
  )

  server.registerTool(
    'validate_workflow',
    {
      description:
        'Validate a workflow definition before it is activated. Pass content (a proposed .md file) — or repo + kind to validate the file in the repo checkout runs load from; that response says whether it is active (runs would use it now). A definition on an unmerged branch is not active.',
      inputSchema: {
        content: z.string().optional().describe('Proposed definition: frontmatter + prompt'),
        repo: z.string().optional().describe('Absolute repo path'),
        kind: z.string().optional().describe('With repo and no content: validate .codekin/workflows/<kind>.md'),
        filename: z.string().optional().describe('Intended filename, checked against the kind'),
      },
    },
    (args) => run(() => api.validateWorkflow(args)),
  )

  server.registerTool(
    'list_repo_automations',
    {
      description:
        'Configured repo automations: workflow, trigger (cron schedule in the shown timezone, or event), enabled, revision, next/last run and any activity hold.',
      inputSchema: { repo: z.string().optional().describe('Absolute repo path; omit for all repos') },
    },
    ({ repo }) => run(() => api.listRepoAutomations(repo)),
  )

  server.registerTool(
    'get_repo_automation',
    {
      description: 'One repo automation with its current revision — read it before update_repo_automation or remove_repo_automation.',
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(() => api.getRepoAutomation(id)),
  )

  server.registerTool(
    'create_repo_automation',
    {
      description:
        'Configure an existing workflow to run in a repo on a cron schedule (evaluated in the returned timezone) or on its event. Refused if the kind is already configured for the repo — update that one instead. This changes when a known workflow runs; changing what it does is a definition change (delegate the .md edit, then validate_workflow).',
      inputSchema: {
        repo: z.string().describe('Absolute repo path'),
        kind: z.string().describe('Workflow kind from list_workflows'),
        cronExpression: z.string().describe('Five-field cron, e.g. "0 9 * * 1" for Mondays 09:00, or "event" for event-driven kinds'),
        name: z.string().optional(),
        enabled: z.boolean().optional(),
        customPrompt: z.string().optional().describe('Extra focus appended to the workflow prompt for this repo'),
        model: z.string().optional(),
        provider: z.enum(['claude', 'codex', 'opencode']).optional(),
        ...changeFields,
      },
    },
    (args) => run(() => api.createRepoAutomation(args)),
  )

  server.registerTool(
    'update_repo_automation',
    {
      description:
        'Change an automation\'s schedule, settings, or enablement (enabled:false disables it and keeps its configuration and history). Pass the revision you read; a conflict means someone changed it since — re-read and retry. Disabling never cancels a run in progress; the response lists active runs.',
      inputSchema: {
        id: z.string(),
        expectedRevision: z.number().int().positive(),
        name: z.string().optional(),
        cronExpression: z.string().optional(),
        enabled: z.boolean().optional(),
        customPrompt: z.string().optional(),
        model: z.string().optional(),
        provider: z.enum(['claude', 'codex', 'opencode']).optional(),
        ...changeFields,
      },
    },
    ({ id, ...input }) => run(() => api.updateRepoAutomation(id, input)),
  )

  server.registerTool(
    'remove_repo_automation',
    {
      description:
        'Remove an automation\'s configured trigger. Run history and the workflow file are kept; a run in progress is not canceled (the response lists active runs). To pause instead, update_repo_automation with enabled:false.',
      inputSchema: { id: z.string(), expectedRevision: z.number().int().positive(), ...changeFields },
    },
    ({ id, ...input }) => run(() => api.removeRepoAutomation(id, input)),
  )

  server.registerTool(
    'get_automation_health',
    {
      description:
        'Evidence-based health of an automation: healthy, starting (no evidence yet), held (activity hold withholding coverage), degraded (overdue or failing), unavailable (scheduler/hook/config broken), or disabled — with reasons, last success/failure and effective next run.',
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(() => api.getAutomationHealth(id)),
  )

  server.registerTool(
    'get_automation_trigger_history',
    {
      description: 'Why an automation ran, was held, or did not run: scheduler decisions, its runs, and its configuration changes (who, why, before/after), newest first.',
      inputSchema: { id: z.string(), limit: z.number().int().positive().max(200).optional() },
    },
    ({ id, limit }) => run(() => api.getAutomationTriggerHistory(id, limit)),
  )

  server.registerTool(
    'get_trust_level',
    {
      description:
        "How much the user trusts an action, from their approval history: 'ask' (get the user), 'notify_do' (do it, then tell them), or 'silent' (just do it). Consult before answering a blocked session's prompt.",
      inputSchema: {
        action: z.string().describe('The action, e.g. the blocked tool invocation pattern'),
        category: z.string().describe("Action family, e.g. 'tool-approval', 'deploy', 'schedule-change'"),
        severity: z.enum(['low', 'medium', 'high']).optional(),
        repo: z.string().optional().describe('Repo path for repo-scoped trust'),
      },
    },
    (args) => run(() => api.getTrustLevel(args)),
  )

  server.registerTool(
    'record_trust_approval',
    {
      description: 'Record that an action was approved (by the user, or by you within trust). Builds toward notify_do/silent for that action.',
      inputSchema: { action: z.string(), category: z.string(), repo: z.string().optional() },
    },
    (args) => run(() => api.recordTrustApproval(args)),
  )

  server.registerTool(
    'record_trust_rejection',
    {
      description: 'Record that an action was rejected. Resets that action\'s trust to ask — always record user rejections.',
      inputSchema: { action: z.string(), category: z.string(), repo: z.string().optional() },
    },
    (args) => run(() => api.recordTrustRejection(args)),
  )

  server.registerTool(
    'list_reports',
    {
      description: 'List audit reports (.codekin/reports/) newest first — across all managed repos, or one repo.',
      inputSchema: {
        repo: z.string().optional().describe('Absolute repo path; omit for every managed repo'),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only reports dated on or after YYYY-MM-DD'),
      },
    },
    (args) => run(() => api.listReports(args)),
  )

  server.registerTool(
    'read_report',
    { description: 'Read one audit report by the path returned from list_reports.', inputSchema: { path: z.string() } },
    ({ path }) => run(() => api.readReport(path)),
  )

  return server
}

// Started directly (node server/dist/codekin-mcp-server.js): serve over stdio.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const server = buildCodekinMcpServer(CodekinApi.fromEnv())
  const transport = new StdioServerTransport()
  server.connect(transport).catch((err: unknown) => {
    console.error('[codekin-mcp] Failed to start:', err)
    process.exit(1)
  })
}
