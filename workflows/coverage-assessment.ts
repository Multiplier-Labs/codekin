/**
 * Standalone coverage assessment workflow using Stepflow.
 *
 * This runs as a separate process, independent of Codekin's server.
 * It schedules a daily coverage assessment that triggers a Codekin
 * session via webhook, waits for the result via callback, then exits.
 *
 * Architecture:
 *   CronScheduler (daily)
 *     → WorkflowEngine runs `coverage.assessment` workflow
 *       → Step `dispatch_claude`:
 *           1. Resolves HEAD SHA of target branch
 *           2. Emits `claude.session.requested` via WebhookEventTransport
 *              → POST to Codekin /api/webhooks/stepflow (signed HMAC)
 *           3. Codekin clones the repo, runs a Claude session
 *           4. Claude writes coverage-reports/YYYY-MM-DD.md, commits, pushes
 *           5. Codekin POSTs result to callbackUrl (this process)
 *             (callback receipt is fire-and-forget; logged but not awaited)
 *
 * Environment variables:
 *   CODEKIN_URL           — Base URL of Codekin (required)
 *   TARGET_REPO              — owner/repo (required)
 *   TARGET_BRANCH            — Branch to assess, default: main
 *   STEPFLOW_WEBHOOK_SECRET  — Shared HMAC secret with Codekin (required)
 *   STEPFLOW_CALLBACK_SECRET — Secret for signing callback POSTs (optional)
 *
 * Usage:
 *   npm install
 *   CODEKIN_URL=https://codekin.internal \
 *   TARGET_REPO=acme/my-app \
 *   STEPFLOW_WEBHOOK_SECRET=changeme \
 *   npx tsx coverage-assessment.ts
 */

import { execSync } from 'child_process'
import {
  WorkflowEngine,
  SQLiteStorageAdapter,
  WebhookEventTransport,
  CronScheduler,
} from '@multiplier-labs/stepflow'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CODEKIN_URL = process.env.CODEKIN_URL
const TARGET_REPO    = process.env.TARGET_REPO
const TARGET_BRANCH  = process.env.TARGET_BRANCH ?? 'main'
const WEBHOOK_SECRET = process.env.STEPFLOW_WEBHOOK_SECRET
const CALLBACK_SECRET = process.env.STEPFLOW_CALLBACK_SECRET

if (!CODEKIN_URL) throw new Error('CODEKIN_URL is required')
if (!TARGET_REPO)    throw new Error('TARGET_REPO is required (e.g. acme/my-app)')
if (!WEBHOOK_SECRET) throw new Error('STEPFLOW_WEBHOOK_SECRET is required')

// Cron expression: default to 06:00 UTC daily, overridable via env
const CRON_EXPRESSION = process.env.COVERAGE_CRON ?? '0 6 * * *'

// ---------------------------------------------------------------------------
// Engine setup
// ---------------------------------------------------------------------------

const engine = new WorkflowEngine({
  storage: new SQLiteStorageAdapter({ filename: './stepflow-coverage.db' }),
  events: new WebhookEventTransport({
    endpoints: [{
      id: 'codekin',
      url: `${CODEKIN_URL}/api/webhooks/stepflow`,
      secret: WEBHOOK_SECRET,
      // Only deliver claude.session.requested events to Codekin
      eventTypes: ['claude.session.requested'],
      retries: 3,
      timeout: 10_000,
    }],
  }),
})

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

engine.registerWorkflow({
  kind: 'coverage.assessment',
  name: 'Daily Coverage Assessment',
  steps: [
    {
      key: 'dispatch_claude',
      name: 'Dispatch Claude session',
      handler: async (ctx) => {
        const cloneUrl = `https://github.com/${TARGET_REPO}.git`

        // Resolve the current HEAD SHA without a local clone
        let headSha: string
        try {
          const output = execSync(
            `git ls-remote ${cloneUrl} refs/heads/${TARGET_BRANCH}`,
            { encoding: 'utf8', timeout: 30_000 }
          )
          headSha = output.split('\t')[0].trim()
          if (!headSha) throw new Error(`Empty SHA from git ls-remote`)
        } catch (err) {
          throw new Error(`Could not resolve HEAD for ${TARGET_BRANCH}: ${err}`)
        }

        const today = new Date().toISOString().slice(0, 10)
        const runId = (ctx as { runId?: string }).runId ?? 'unknown'

        const request = {
          repo: TARGET_REPO!,
          cloneUrl,
          branch: TARGET_BRANCH,
          headSha,
          taskDescription: [
            `Assess the unit test coverage of this repository and write a Markdown report.`,
            ``,
            `Steps:`,
            `1. Detect the test framework and coverage tooling (Jest, Vitest, pytest-cov, go test -cover, etc.).`,
            `2. Run the test suite with coverage enabled.`,
            `3. Analyse the output: overall %, per-file breakdown, files with < 50% coverage.`,
            `4. Write a Markdown report to \`coverage-reports/${today}.md\`:`,
            `   - Summary table (line / branch / function coverage)`,
            `   - Uncovered files list`,
            `   - Top 10 prioritised test proposals with rationale`,
            `5. Commit with message: \`chore: coverage report ${today}\``,
            `6. Push to ${TARGET_BRANCH}.`,
            ``,
            `Do NOT modify any source files or existing tests. Only create the report file.`,
          ].join('\n'),
          taskContext: [
            `This is a daily automated coverage assessment triggered by Stepflow.`,
            `Your job is analysis and reporting only — do not fix bugs or add tests.`,
            `Keep proposals concrete: file path, function/class, scenario to test, and rationale.`,
          ].join('\n'),
          callbackUrl: `${CODEKIN_URL}/api/stepflow/callback/${runId}`,
          callbackSecret: CALLBACK_SECRET,
        }

        // ctx.emit is fire-and-forget — Codekin receives and processes async
        ;(ctx as { emit?: (type: string, payload: unknown) => void }).emit?.(
          'claude.session.requested',
          request
        )

        console.log(`[coverage-assessment] Dispatched Claude for ${TARGET_REPO}@${headSha.slice(0, 7)}`)
        return { headSha, today, repo: TARGET_REPO }
      },
      onError: 'retry',
      maxRetries: 2,
      retryDelay: 30_000,
    },
  ],
})

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const scheduler = new CronScheduler({ engine })

await engine.initialize()
await scheduler.start()

await scheduler.addSchedule({
  workflowKind: 'coverage.assessment',
  triggerType: 'cron',
  cronExpression: CRON_EXPRESSION,
  timezone: 'UTC',
  enabled: true,
})

console.log(`Coverage assessment workflow running.`)
console.log(`  Target:   ${TARGET_REPO}@${TARGET_BRANCH}`)
console.log(`  Schedule: ${CRON_EXPRESSION} UTC`)
console.log(`  Hub:      ${CODEKIN_URL}`)

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown() {
  console.log('\n[coverage-assessment] Shutting down...')
  await scheduler.stop()
  await engine.shutdown()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
