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
        completionPolicy: z.enum(['pr', 'merge', 'commit-only']).optional().describe('How finished work lands (default pr)'),
        useWorktree: z.boolean().optional().describe('Isolate the child in a git worktree (default true)'),
        deployAfter: z.boolean().optional(),
        model: z.string().optional().describe('Model override for the child'),
      },
    },
    (args) => run(() => api.spawnChild(args)),
  )

  server.registerTool(
    'list_children',
    { description: 'List your child sessions with status (starting/running/blocked/completed/failed/timed_out).', inputSchema: {} },
    () => run(() => api.listChildren()),
  )

  server.registerTool(
    'get_child',
    { description: 'Get one child session, including its result or error once terminal.', inputSchema: { id: z.string() } },
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
    'pending_prompts',
    { description: 'List sessions blocked on a tool approval or question, with the requestId needed to respond.', inputSchema: {} },
    () => run(() => api.pendingPrompts()),
  )

  server.registerTool(
    'respond_to_prompt',
    {
      description: 'Answer a blocked session\'s prompt. For permission prompts value is "allow" or "deny"; for questions it is the answer text.',
      inputSchema: { sessionId: z.string(), requestId: z.string(), value: z.string() },
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
    'list_runs',
    {
      description: 'List background runs (workflows and loops) newest-first in one unified shape. Filter by engine or status.',
      inputSchema: {
        engine: z.enum(['workflow', 'loop']).optional(),
        status: z.string().optional().describe('e.g. running, blocked, awaiting_human, succeeded, failed'),
        limit: z.number().int().positive().optional(),
      },
    },
    (args) => run(() => api.listRuns(args)),
  )

  server.registerTool(
    'start_loop',
    {
      description:
        'Start a goal run (act → verify → continue loop) from a loop template. The loop iterates until its verify commands pass, then lands the change per the template\'s completion policy.',
      inputSchema: {
        kind: z.string().describe('Loop template kind, e.g. ci-autorepair'),
        repo: z.string().describe('Absolute repo path'),
        branch: z.string().describe('Branch for the maker to work on'),
        goal: z.string().optional().describe('Override the template\'s default goal text'),
      },
    },
    (args) => run(() => api.startLoop(args)),
  )

  server.registerTool(
    'abort_run',
    { description: 'Abort an in-flight goal run.', inputSchema: { runId: z.string() } },
    ({ runId }) => run(() => api.abortRun(runId)),
  )

  server.registerTool(
    'trigger_workflow',
    {
      description: 'Trigger a workflow run now (e.g. repo-health.weekly) instead of waiting for its schedule.',
      inputSchema: { kind: z.string(), input: z.record(z.string(), z.unknown()).optional().describe('e.g. { repoPath }') },
    },
    ({ kind, input }) => run(() => api.triggerWorkflow(kind, input)),
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
    { description: 'List audit reports (.codekin/reports/) across managed repos.', inputSchema: {} },
    () => run(() => api.listReports()),
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
