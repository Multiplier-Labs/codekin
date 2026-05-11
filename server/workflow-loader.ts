/**
 * MD-based workflow loader.
 *
 * Reads *.md files from server/workflows/ (built-in definitions shipped with
 * the NPM package) and from {repoPath}/.codekin/workflows/ (per-repo
 * definitions that can override built-ins or define entirely new workflows).
 *
 * All workflows share the same 4-step execution model:
 *   1. validate_repo  — verify path exists, is a git repo, check staleness
 *   2. create_session — create a Codekin session for the run
 *   3. run_prompt     — start Claude, send the prompt, wait for result
 *   4. save_report    — write Markdown output to outputDir, commit on the
 *                       long-lived codekin/reports branch, push (hard failure)
 *
 * MD file format — YAML frontmatter followed by the Claude prompt:
 *
 *   ---
 *   kind: code-review.daily
 *   name: Daily Code Review
 *   sessionPrefix: review
 *   outputDir: .codekin/reports/code-review
 *   filenameSuffix: _code-review-daily.md
 *   commitMessage: chore: code review
 *   model: claude-sonnet-4-6          # optional — defaults to system default
 *   ---
 *   You are performing a daily automated code review...
 *
 * Per-repo workflows: place MD files at {repoPath}/.codekin/workflows/.
 * Files whose `kind` matches a built-in override that built-in's prompt.
 * Files with a new `kind` register as standalone workflows for that repo.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { dirname, isAbsolute, join, resolve, sep } from 'path'
import { REPOS_ROOT } from './config.js'
import { fileURLToPath } from 'url'
import type { WorkflowEngine, WorkflowRun } from './workflow-engine.js'
import { SessionGoneError } from './workflow-engine.js'
import type { SessionManager } from './session-manager.js'
import type { WsServerMessage } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowKindInfo {
  kind: string
  name: string
  source: 'builtin' | 'repo'
}

export interface WorkflowDef {
  kind: string
  name: string
  sessionPrefix: string
  outputDir: string
  filenameSuffix: string
  commitMessage: string
  model?: string
  prompt: string
}

// ---------------------------------------------------------------------------
// MD parser
// ---------------------------------------------------------------------------

/**
 * Validate a relative path that came from untrusted MD frontmatter.
 *
 * `outputDir` and `filenameSuffix` are joined with `repoPath` and written to
 * disk by the save_report step. A repo workflow author who set
 * `outputDir: /etc` or `outputDir: ../../foo` could otherwise smuggle the
 * write outside the repo. We reject absolute paths and any segment equal to
 * `..`; the runtime check in save_report enforces the boundary defensively.
 */
function assertSafeRelativePath(value: string, field: string, sourcePath: string): void {
  if (isAbsolute(value)) {
    throw new Error(`Invalid ${field} in ${sourcePath}: absolute paths are not allowed`)
  }
  // Normalize backslashes so a Windows-style ..\\ is caught the same as ../
  const segments = value.split(/[/\\]/)
  if (segments.some(s => s === '..')) {
    throw new Error(`Invalid ${field} in ${sourcePath}: path traversal segments ('..') are not allowed`)
  }
}

/** Parse a workflow MD file into a WorkflowDef. Throws if required fields are missing or unsafe. */
function parseMdWorkflow(content: string, sourcePath: string): WorkflowDef {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/m)
  if (!fmMatch) throw new Error(`No frontmatter found in ${sourcePath}`)

  const frontmatter = fmMatch[1]
  const prompt = fmMatch[2].trim()

  const meta: Record<string, string> = {}
  for (const line of frontmatter.split('\n')) {
    const sep = line.indexOf(': ')
    if (sep === -1) continue
    meta[line.slice(0, sep).trim()] = line.slice(sep + 2).trim()
  }

  const required = ['kind', 'name', 'sessionPrefix', 'outputDir', 'filenameSuffix', 'commitMessage']
  for (const key of required) {
    if (!meta[key]) throw new Error(`Missing frontmatter field "${key}" in ${sourcePath}`)
  }

  // Reject path-traversal in any frontmatter field that is later joined with
  // repoPath at save time. Failing here prevents an unsafe def from being
  // registered at all.
  assertSafeRelativePath(meta.outputDir, 'outputDir', sourcePath)
  assertSafeRelativePath(meta.filenameSuffix, 'filenameSuffix', sourcePath)

  return {
    kind: meta.kind,
    name: meta.name,
    sessionPrefix: meta.sessionPrefix,
    outputDir: meta.outputDir,
    filenameSuffix: meta.filenameSuffix,
    commitMessage: meta.commitMessage,
    model: meta.model,
    prompt,
  }
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Resolve the workflows directory. When running from dist/ (compiled JS),
 * the MD files live one level up in server/workflows/. When running from
 * source (ts-node / tsx), they're a sibling directory.
 */
const __ownDir = dirname(fileURLToPath(import.meta.url))
const WORKFLOWS_DIR = existsSync(join(__ownDir, 'workflows'))
  ? join(__ownDir, 'workflows')
  : join(__ownDir, '..', 'workflows')

/**
 * Load all *.md files from the built-in server/workflows/ directory.
 *
 * @param strict  When true (default), parsing failures throw instead of being
 *                logged. Set to false only for listing/introspection where we
 *                want best-effort discovery without crashing the server.
 */
function loadBuiltinWorkflows(strict = false): WorkflowDef[] {
  if (!existsSync(WORKFLOWS_DIR)) {
    console.warn(`[workflow-loader] Built-in workflows dir not found: ${WORKFLOWS_DIR}`)
    return []
  }

  const defs: WorkflowDef[] = []
  for (const file of readdirSync(WORKFLOWS_DIR)) {
    if (!file.endsWith('.md')) continue
    const filePath = join(WORKFLOWS_DIR, file)
    try {
      defs.push(parseMdWorkflow(readFileSync(filePath, 'utf-8'), filePath))
    } catch (err) {
      if (strict) {
        throw err
      }
      console.error(`[workflow-loader] Failed to parse ${filePath}:`, err)
    }
  }
  return defs
}

/** Try to load a per-repo override for a given kind from {repoPath}/.codekin/workflows/. */
function loadRepoOverride(repoPath: string, kind: string): WorkflowDef | null {
  const filePath = join(repoPath, '.codekin', 'workflows', `${kind}.md`)
  if (!existsSync(filePath)) return null
  try {
    return parseMdWorkflow(readFileSync(filePath, 'utf-8'), filePath)
  } catch (err) {
    console.warn(`[workflow-loader] Failed to parse repo override ${filePath}:`, err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Shared polling helper
// ---------------------------------------------------------------------------

async function waitForSessionResult(
  sessions: SessionManager,
  sessionId: string,
  opts: { timeoutMs?: number; pollMs?: number; abortSignal?: AbortSignal; runId?: string; stepKey?: string } = {}
): Promise<{ success: boolean; text: string }> {
  const { timeoutMs = 600_000, pollMs = 2000, abortSignal, runId, stepKey } = opts
  const deadline = Date.now() + timeoutMs
  let lastSeen: string | null = null

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) throw new Error('Aborted')

    const session = sessions.get(sessionId)
    if (!session) {
      throw new SessionGoneError(runId ?? 'unknown', stepKey ?? 'run_prompt', sessionId, lastSeen)
    }
    lastSeen = new Date().toISOString()

    const resultMsg = session.outputHistory.find(m => m.type === 'result')
    if (resultMsg) {
      const assistantText = session.outputHistory
        .filter((m): m is Extract<WsServerMessage, { type: 'output' }> => m.type === 'output')
        .map(m => m.data)
        .join('')
      return { success: true, text: assistantText }
    }

    const exitMsg = session.outputHistory.find(m => m.type === 'exit')
    if (exitMsg) {
      const assistantText = session.outputHistory
        .filter((m): m is Extract<WsServerMessage, { type: 'output' }> => m.type === 'output')
        .map(m => m.data)
        .join('')
      return {
        success: assistantText.length > 0,
        text: assistantText || 'Claude exited without output',
      }
    }

    await new Promise(resolve => setTimeout(resolve, pollMs))
  }

  throw new Error(`Timed out waiting for session result after ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// Prompt guard
// ---------------------------------------------------------------------------

/**
 * Prepended to every workflow prompt so Claude does not duplicate the report.
 * The save_report step writes Claude's response text to the configured outputDir;
 * if Claude also uses the Write tool (per CLAUDE.md guidance), two files appear
 * — one substantive file under whatever category Claude chose, and one stub
 * (the conversational reply) under the configured outputDir.
 */
const WORKFLOW_PROMPT_GUARD = [
  'IMPORTANT: You are running as part of an automated Codekin workflow.',
  'The workflow runner will save your entire response as the report file.',
  'Do NOT use the Write or Edit tools to create the report yourself — that produces a duplicate file.',
  'Respond with the report Markdown directly, with no preamble.',
  'Disregard any conflicting guidance in CLAUDE.md about writing audit reports to disk; the workflow handles saving and committing.',
].join(' ')

/** Branch name for report commits. All workflow runs commit to this single long-lived branch. */
export const REPORT_BRANCH = 'codekin/reports'

/**
 * @deprecated Use REPORT_BRANCH directly. Retained for call-site compatibility.
 */
export function reportBranchName(_kind: string, _dateStr: string): string {
  return REPORT_BRANCH
}

/** True when a branch name is one a workflow run produces (or used to produce). */
export function isWorkflowReportsBranch(branch: string): boolean {
  // Accept the legacy long-lived branch and the new per-run audit/<kind>-<date> form.
  if (branch === 'codekin/reports') return true
  return /^audit\/[^/]+-\d{4}-\d{2}-\d{2}$/.test(branch)
}

// ---------------------------------------------------------------------------
// Workflow registration
// ---------------------------------------------------------------------------

function registerWorkflow(engine: WorkflowEngine, sessions: SessionManager, def: WorkflowDef) {
  engine.registerWorkflow({
    kind: def.kind,

    steps: [
      // Step 1: Validate repository
      {
        key: 'validate_repo',
        handler: async (input) => {
          const repoPath = input.repoPath as string
          if (!repoPath) throw new Error('Missing repoPath in workflow input')
          if (!existsSync(repoPath)) throw new Error(`Repository path does not exist: ${repoPath}`)
          const resolvedPath = realpathSync(repoPath)
          if (!resolvedPath.startsWith(REPOS_ROOT + sep)) {
            throw new Error(`Repository path ${resolvedPath} is outside REPOS_ROOT`)
          }

          try {
            const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, timeout: 5000 }).toString().trim()
            const lastCommit = execFileSync('git', ['log', '-1', '--oneline'], { cwd: repoPath, timeout: 5000 }).toString().trim()

            const sinceTimestamp = input.sinceTimestamp as string | undefined
            if (sinceTimestamp) {
              const newCommits = execFileSync('git', ['log', `--since=${sinceTimestamp}`, '--oneline'], { cwd: repoPath, timeout: 5000 }).toString().trim()
              if (!newCommits) {
                const { WorkflowSkipped } = await import('./workflow-engine.js')
                throw new WorkflowSkipped(`No code changes since last run (${sinceTimestamp})`)
              }
            }

            console.log(`[workflow:${def.kind}] Validated repo: ${repoPath} (${branch}) — ${lastCommit}`)
            return { branch, lastCommit, repoPath, repoName: input.repoName }
          } catch (err) {
            if (err instanceof Error && err.name === 'WorkflowSkipped') throw err
            throw new Error(`Not a valid git repository: ${repoPath}`, { cause: err })
          }
        },
      },

      // Step 2: Create session
      {
        key: 'create_session',
        handler: async (input, ctx) => {
          const repoPath = input.repoPath as string
          const repoName = (input.repoName as string) || repoPath.split('/').pop() || 'unknown'

          const model = (input.model as string | undefined) || def.model
          const provider = (input.provider as 'claude' | 'opencode' | undefined)
          const session = sessions.create(`${def.sessionPrefix}:${repoName}`, repoPath, {
            source: 'workflow',
            groupDir: repoPath,
            model,
            provider,
            allowedTools: ['Bash(gh pr:*)'],
          })

          // Persist the session id on the run BEFORE returning so a server crash
          // between this step and `run_prompt` can still locate the session.
          ctx.recordSessionId?.(session.id)

          console.log(`[workflow:${def.kind}] Created session ${session.id} for ${repoName} (run ${ctx.runId})`)
          return { sessionId: session.id, repoPath, repoName, branch: input.branch, lastCommit: input.lastCommit }
        },
      },

      // Step 3: Run prompt
      {
        key: 'run_prompt',
        handler: async (input, ctx) => {
          const sessionId = input.sessionId as string
          const repoName = input.repoName as string
          const repoPath = input.repoPath as string
          const customPrompt = input.customPrompt as string | undefined

          // If the session is already gone, fail with a typed error before doing any work —
          // gives a much clearer signal than a downstream "Session X not found" stack trace.
          if (!sessions.get(sessionId)) {
            throw new SessionGoneError(ctx.runId, 'run_prompt', sessionId, ctx.run.lastStepAt ?? null)
          }

          sessions.startClaude(sessionId)
          await sessions.waitForReady(sessionId)

          if (ctx.resumed) {
            // The prompt was already sent in the original run before the server crashed.
            // Just wait for the result Claude is (still) producing — sending again would
            // duplicate the prompt and fork the conversation.
            console.log(`[workflow:${def.kind}] Resuming run ${ctx.runId}: re-attaching to session ${sessionId} (no re-send)`)
          } else {
            // Per-repo override: check {repoPath}/.codekin/workflows/{kind}.md
            const repoOverride = loadRepoOverride(repoPath, ctx.run.kind)
            const basePrompt = repoOverride ? repoOverride.prompt : def.prompt

            const userPrompt = customPrompt
              ? `${basePrompt}\n\nAdditional focus areas:\n${customPrompt}`
              : basePrompt

            // If the run carries sanitized commit fields, prepend them as
            // XML-delimited context so injected text cannot escape its data
            // context. Fields are sanitized upstream in commit-event-handler.ts.
            const commitMessage = input.commitMessage as string | undefined
            const commitBranch = input.branch as string | undefined
            const commitAuthor = input.author as string | undefined
            let commitContext = ''
            if (commitMessage !== undefined) {
              commitContext = [
                '<commit-message>',
                commitMessage,
                '</commit-message>',
                `<branch>${commitBranch ?? 'unknown'}</branch>`,
                `<author>${commitAuthor ?? 'unknown'}</author>`,
                '',
                '',
              ].join('\n')
            }

            // Prepend the guard to suppress Claude's CLAUDE.md-driven file-write
            // behavior, which otherwise creates a duplicate report file.
            const prompt = `${WORKFLOW_PROMPT_GUARD}\n\n${commitContext}${userPrompt}`

            if (repoOverride) {
              console.log(`[workflow:${def.kind}] Using per-repo prompt override from ${repoPath}`)
            }

            sessions.sendInput(sessionId, prompt)
            console.log(`[workflow:${def.kind}] Sent prompt to session ${sessionId} for ${repoName}`)
          }

          const result = await waitForSessionResult(sessions, sessionId, {
            timeoutMs: 600_000,
            abortSignal: ctx.abortSignal,
            runId: ctx.runId,
            stepKey: 'run_prompt',
          })

          console.log(`[workflow:${def.kind}] Completed for ${repoName} (${result.text.length} chars)`)
          return {
            reportText: result.text,
            sessionId,
            repoName,
            repoPath,
            branch: input.branch,
            runId: ctx.runId,
          }
        },
      },

      // Step 4: Save report
      {
        key: 'save_report',
        handler: async (input, ctx) => {
          const repoPath = input.repoPath as string
          const repoName = input.repoName as string
          const reportText = input.reportText as string
          const sessionId = input.sessionId as string
          const branch = input.branch as string

          const now = new Date()
          const dateStr = now.toISOString().slice(0, 10)

          const markdown = [
            `# ${def.name}: ${repoName}`,
            '',
            `**Date**: ${now.toISOString()}`,
            `**Repository**: ${repoPath}`,
            `**Branch**: ${branch || 'unknown'}`,
            `**Workflow Run**: ${ctx.runId}`,
            `**Session**: ${sessionId}`,
            '',
            '---',
            '',
            reportText,
          ].join('\n')

          const reportsDir = join(repoPath, def.outputDir)
          const filename = `${dateStr}${def.filenameSuffix}`
          const filePath = join(reportsDir, filename)

          // Defense in depth — even though parseMdWorkflow rejects unsafe
          // outputDir/filenameSuffix at load, re-verify the resolved write
          // target is under the repo. realpath the parent so a symlinked
          // outputDir cannot escape; the file itself does not exist yet.
          const repoRealRoot = existsSync(repoPath) ? realpathSync(repoPath) : resolve(repoPath)
          const reportsRealRoot = existsSync(reportsDir) ? realpathSync(reportsDir) : resolve(reportsDir)
          if (
            !reportsRealRoot.startsWith(repoRealRoot + sep) &&
            reportsRealRoot !== repoRealRoot
          ) {
            throw new Error(
              `Refusing to write report outside repo: ${reportsRealRoot} is not under ${repoRealRoot}`,
            )
          }
          const resolvedFilePath = resolve(reportsRealRoot, filename)
          if (
            !resolvedFilePath.startsWith(reportsRealRoot + sep) &&
            resolvedFilePath !== reportsRealRoot
          ) {
            throw new Error(
              `Refusing to write report outside outputDir: ${resolvedFilePath} is not under ${reportsRealRoot}`,
            )
          }

          console.log(`[workflow:${def.kind}] Writing report to ${filePath}`)

          // All workflow runs commit to a single long-lived branch so the
          // orchestrator can always find reports in one place. Uses a temporary
          // git worktree to avoid stash/checkout races with concurrent runs.
          const reportsBranch = REPORT_BRANCH
          const relativePath = `${def.outputDir}/${filename}`

          // Ensure the reports branch exists (create if needed, fast-forward if behind).
          try {
            execFileSync('git', ['rev-parse', '--verify', reportsBranch], { cwd: repoPath, timeout: 5_000, stdio: 'pipe' })
            // Branch exists — try to fast-forward it to origin so we don't
            // diverge from remote.
            try {
              execFileSync('git', ['fetch', 'origin', reportsBranch], { cwd: repoPath, timeout: 30_000, stdio: 'pipe' })
              execFileSync('git', ['update-ref', `refs/heads/${reportsBranch}`, `origin/${reportsBranch}`], { cwd: repoPath, timeout: 5_000, stdio: 'pipe' })
            } catch {
              // Remote branch may not exist yet (first push) — that's fine.
            }
          } catch {
            // Branch doesn't exist yet — create it from origin/main so the
            // reports branch always forks from the latest upstream commit.
            let fetchOk = false
            try {
              execFileSync('git', ['fetch', 'origin', 'main'], { cwd: repoPath, timeout: 30_000, stdio: 'pipe' })
              fetchOk = true
            } catch (fetchErr) {
              console.warn(`[workflow:${def.kind}] git fetch origin main failed (will fork from local HEAD): ${fetchErr}`)
            }
            const branchArgs: string[] = ['branch', reportsBranch]
            if (fetchOk) branchArgs.push('origin/main')
            execFileSync('git', branchArgs, { cwd: repoPath, timeout: 5_000 })
            console.log(`[workflow:${def.kind}] Created branch ${reportsBranch}${fetchOk ? ' from origin/main' : ' from current HEAD (fetch failed)'}`)
          }

          // Create a temporary worktree on the reports branch
          const wtDir = join(repoPath, '..', `.codekin-wt-report-${ctx.runId}`)
          try {
            execFileSync('git', ['worktree', 'add', wtDir, reportsBranch], { cwd: repoPath, timeout: 10_000 })

            // Write the report file in the worktree
            const reportsDirInWt = join(wtDir, def.outputDir)
            if (!existsSync(reportsDirInWt)) {
              mkdirSync(reportsDirInWt, { recursive: true })
            }
            writeFileSync(join(reportsDirInWt, filename), markdown, 'utf-8')

            execFileSync('git', ['add', relativePath], { cwd: wtDir, timeout: 10_000 })
            execFileSync(
              'git', ['commit', '-m', `${def.commitMessage} ${dateStr}`],
              { cwd: wtDir, timeout: 15_000 }
            )
            console.log(`[workflow:${def.kind}] Committed ${relativePath} on ${reportsBranch}`)

            // Push to remote with retry (2 retries, exponential backoff).
            // Failure is hard — the run must not succeed if the report isn't
            // persisted on the remote.
            const MAX_PUSH_ATTEMPTS = 3
            let pushErr: unknown = null
            for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
              try {
                execFileSync('git', ['push', 'origin', reportsBranch], { cwd: wtDir, timeout: 30_000, stdio: 'pipe' })
                pushErr = null
                console.log(`[workflow:${def.kind}] Pushed ${reportsBranch} to origin`)
                break
              } catch (err) {
                pushErr = err
                if (attempt < MAX_PUSH_ATTEMPTS) {
                  const delayMs = 1000 * Math.pow(2, attempt - 1) // 1s, 2s
                  console.warn(`[workflow:${def.kind}] Push attempt ${attempt}/${MAX_PUSH_ATTEMPTS} failed, retrying in ${delayMs}ms: ${err}`)
                  await new Promise(r => setTimeout(r, delayMs))
                }
              }
            }
            if (pushErr) {
              throw new Error(`Failed to push report to origin/${reportsBranch} after ${MAX_PUSH_ATTEMPTS} attempts: ${pushErr}`)
            }

            // Verify the commit is present on the remote branch.
            const localSha = execFileSync('git', ['rev-parse', reportsBranch], { cwd: wtDir, timeout: 5_000, stdio: 'pipe' }).toString().trim()
            execFileSync('git', ['fetch', 'origin', reportsBranch], { cwd: repoPath, timeout: 30_000, stdio: 'pipe' })
            const remoteSha = execFileSync('git', ['rev-parse', `origin/${reportsBranch}`], { cwd: repoPath, timeout: 5_000, stdio: 'pipe' }).toString().trim()
            if (localSha !== remoteSha) {
              throw new Error(`Post-push verification failed: local ${reportsBranch} (${localSha}) ≠ origin/${reportsBranch} (${remoteSha})`)
            }
            console.log(`[workflow:${def.kind}] Verified commit ${localSha.slice(0, 8)} on origin/${reportsBranch}`)
          } finally {
            // Always clean up the temporary worktree
            try {
              execFileSync('git', ['worktree', 'remove', '--force', wtDir], { cwd: repoPath, timeout: 10_000 })
            } catch { /* worktree cleanup is best-effort */ }
          }

          return { filePath, filename, sessionId }
        },
      },
    ],

    // Cleanup: stop Claude process after workflow completes
    afterRun: async (run: WorkflowRun) => {
      try {
        const sessionId = run.output?.sessionId as string | undefined
        if (sessionId) {
          const session = sessions.get(sessionId)
          if (session?.claudeProcess?.isAlive()) {
            console.log(`[workflow:${def.kind}] Stopping Claude process for session ${sessionId}`)
            sessions.stopClaude(sessionId)
          }
        }
      } catch {
        // Ignore cleanup errors
      }

      // Guard: the audit session runs directly in repoPath (no worktree isolation),
      // so the Claude agent can check out the audit branch while following CLAUDE.md's
      // instruction to commit reports on a branch. Restore the original branch so the
      // next run does not fork its audit branch from a stale, audit-branch HEAD.
      const repoPath = run.output?.repoPath as string | undefined
      const branch = run.output?.branch as string | undefined
      if (repoPath && branch) {
        try {
          const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
            { cwd: repoPath, timeout: 5_000, stdio: 'pipe' }).toString().trim()
          if (current !== branch) {
            console.warn(`[workflow:${def.kind}] Main checkout is on '${current}' instead of '${branch}' — restoring`)
            execFileSync('git', ['checkout', branch], { cwd: repoPath, timeout: 10_000, stdio: 'pipe' })
          }
        } catch (err) {
          console.warn(`[workflow:${def.kind}] Could not restore branch to ${branch}: ${err}`)
        }
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Repo workflow discovery
// ---------------------------------------------------------------------------

/** Scan {repoPath}/.codekin/workflows/ for all MD workflow definitions. */
function discoverRepoWorkflows(repoPath: string): WorkflowDef[] {
  const dir = join(repoPath, '.codekin', 'workflows')
  if (!existsSync(dir)) return []

  const defs: WorkflowDef[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue
    const filePath = join(dir, file)
    try {
      defs.push(parseMdWorkflow(readFileSync(filePath, 'utf-8'), filePath))
    } catch (err) {
      console.warn(`[workflow-loader] Failed to parse repo workflow ${filePath}:`, err)
    }
  }
  return defs
}

/** Track which repo workflow kinds have already been registered with the engine. */
const registeredRepoKinds = new Set<string>()

/**
 * Discover and register any standalone repo workflows (kinds not already
 * registered as built-ins). Called when a repo is configured or when listing
 * available kinds for a repo. Safe to call multiple times — already-registered
 * kinds are skipped.
 */
export function ensureRepoWorkflowsRegistered(
  engine: WorkflowEngine,
  sessions: SessionManager,
  repoPath: string,
): void {
  const repoDefs = discoverRepoWorkflows(repoPath)
  for (const def of repoDefs) {
    const registrationKey = `${repoPath}::${def.kind}`
    if (registeredRepoKinds.has(registrationKey)) continue
    if (engine.hasWorkflow(def.kind)) continue
    registerWorkflow(engine, sessions, def)
    registeredRepoKinds.add(registrationKey)
    console.log(`[workflow-loader] Registered repo workflow "${def.kind}" from ${repoPath}`)
  }
}

// ---------------------------------------------------------------------------
// Kind listing
// ---------------------------------------------------------------------------

/** Return available workflow kinds: built-ins plus any from a specific repo. */
export function listAvailableKinds(repoPath?: string): WorkflowKindInfo[] {
  const builtinDefs = loadBuiltinWorkflows()
  const kinds: WorkflowKindInfo[] = builtinDefs.map(d => ({
    kind: d.kind,
    name: d.name,
    source: 'builtin' as const,
  }))

  const builtinKindSet = new Set(builtinDefs.map(d => d.kind))

  if (repoPath) {
    const repoDefs = discoverRepoWorkflows(repoPath)
    for (const def of repoDefs) {
      if (builtinKindSet.has(def.kind)) continue
      kinds.push({ kind: def.kind, name: def.name, source: 'repo' })
    }
  }

  return kinds
}

// ---------------------------------------------------------------------------
// Commit message prefixes (for cycle prevention)
// ---------------------------------------------------------------------------

/**
 * Return the commitMessage prefixes from all built-in workflow definitions.
 * Used by the commit event handler to detect and reject commits generated
 * by workflows themselves (cycle prevention).
 */
export function getWorkflowCommitPrefixes(): string[] {
  return loadBuiltinWorkflows().map(d => d.commitMessage)
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Load all MD workflow definitions and register them with the engine. Throws on malformed built-ins. */
export function loadMdWorkflows(engine: WorkflowEngine, sessions: SessionManager): void {
  const defs = loadBuiltinWorkflows(true)
  for (const def of defs) {
    registerWorkflow(engine, sessions, def)
  }

  // Let the engine consult the session manager when deciding whether an interrupted
  // run is still resumable. Returning null tells the engine the session has gone and
  // the run should fail with a clear, typed reason instead of being skipped silently.
  // (Defensive optional-call so older test doubles without setSessionResolver still pass.)
  engine.setSessionResolver?.((sessionId) => {
    const session = sessions.get(sessionId)
    if (!session) return null
    const lastActivityAt = session._lastActivityAt
      ? new Date(session._lastActivityAt).toISOString()
      : null
    return { lastActivityAt }
  })

  console.log(`[workflow-loader] Loaded ${defs.length} workflow(s) from MD definitions`)
}
