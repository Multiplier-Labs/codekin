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
 *   4. save_report    — write Markdown output to outputDir, commit on codekin/reports branch, push
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
import { dirname, join, sep } from 'path'
import { REPOS_ROOT } from './config.js'
import { fileURLToPath } from 'url'
import type { WorkflowEngine, WorkflowRun } from './workflow-engine.js'
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

/** Parse a workflow MD file into a WorkflowDef. Throws if required fields are missing. */
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

/** Load all *.md files from the built-in server/workflows/ directory. */
function loadBuiltinWorkflows(): WorkflowDef[] {
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
  opts: { timeoutMs?: number; pollMs?: number; abortSignal?: AbortSignal } = {}
): Promise<{ success: boolean; text: string }> {
  const { timeoutMs = 600_000, pollMs = 2000, abortSignal } = opts
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) throw new Error('Aborted')

    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

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
            throw new Error(`Not a valid git repository: ${repoPath}`)
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
          const session = sessions.create(`${def.sessionPrefix}:${repoName}`, repoPath, {
            source: 'workflow',
            groupDir: repoPath,
            model,
          })

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

          sessions.startClaude(sessionId)
          await new Promise(resolve => setTimeout(resolve, 3000))

          // Per-repo override: check {repoPath}/.codekin/workflows/{kind}.md
          const repoOverride = loadRepoOverride(repoPath, ctx.run.kind)
          const basePrompt = repoOverride ? repoOverride.prompt : def.prompt

          const prompt = customPrompt
            ? `${basePrompt}\n\nAdditional focus areas:\n${customPrompt}`
            : basePrompt

          if (repoOverride) {
            console.log(`[workflow:${def.kind}] Using per-repo prompt override from ${repoPath}`)
          }

          sessions.sendInput(sessionId, prompt)
          console.log(`[workflow:${def.kind}] Sent prompt to session ${sessionId} for ${repoName}`)

          const result = await waitForSessionResult(sessions, sessionId, {
            timeoutMs: 600_000,
            abortSignal: ctx.abortSignal,
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
          if (!existsSync(reportsDir)) {
            mkdirSync(reportsDir, { recursive: true })
          }

          const filename = `${dateStr}${def.filenameSuffix}`
          const filePath = join(reportsDir, filename)
          writeFileSync(filePath, markdown, 'utf-8')

          console.log(`[workflow:${def.kind}] Saved report to ${filePath}`)

          // Commit on a dedicated branch so reports don't pollute the working branch
          const REPORTS_BRANCH = 'codekin/reports'
          try {
            const relativePath = `${def.outputDir}/${filename}`
            const originalBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, timeout: 5_000 }).toString().trim()

            // Ensure the reports branch exists (create as orphan if needed)
            try {
              execFileSync('git', ['rev-parse', '--verify', REPORTS_BRANCH], { cwd: repoPath, timeout: 5_000, stdio: 'pipe' })
            } catch {
              // Branch doesn't exist yet — create it from the current branch
              execFileSync('git', ['branch', REPORTS_BRANCH], { cwd: repoPath, timeout: 5_000 })
              console.log(`[workflow:${def.kind}] Created branch ${REPORTS_BRANCH}`)
            }

            // Stash any uncommitted changes on the working branch
            const stashResult = execFileSync('git', ['stash', '--include-untracked'], { cwd: repoPath, timeout: 10_000 }).toString().trim()
            const didStash = !stashResult.includes('No local changes')

            try {
              execFileSync('git', ['checkout', REPORTS_BRANCH], { cwd: repoPath, timeout: 10_000 })

              // Re-create the report file on this branch (the file was written while on the original branch)
              const reportsDirOnBranch = join(repoPath, def.outputDir)
              if (!existsSync(reportsDirOnBranch)) {
                mkdirSync(reportsDirOnBranch, { recursive: true })
              }
              writeFileSync(join(reportsDirOnBranch, filename), markdown, 'utf-8')

              execFileSync('git', ['add', relativePath], { cwd: repoPath, timeout: 10_000 })
              execFileSync(
                'git', ['commit', '-m', `${def.commitMessage} ${dateStr}`],
                { cwd: repoPath, timeout: 15_000 }
              )
              console.log(`[workflow:${def.kind}] Committed ${relativePath} on ${REPORTS_BRANCH}`)

              // Push to remote
              try {
                execFileSync('git', ['push', 'origin', REPORTS_BRANCH], { cwd: repoPath, timeout: 30_000, stdio: 'pipe' })
                console.log(`[workflow:${def.kind}] Pushed ${REPORTS_BRANCH} to origin`)
              } catch (pushErr) {
                console.warn(`[workflow:${def.kind}] Could not push ${REPORTS_BRANCH}: ${pushErr}`)
              }
            } finally {
              // Always switch back to the original branch
              execFileSync('git', ['checkout', originalBranch], { cwd: repoPath, timeout: 10_000 })
              if (didStash) {
                execFileSync('git', ['stash', 'pop'], { cwd: repoPath, timeout: 10_000 })
              }
            }
          } catch (err) {
            console.warn(`[workflow:${def.kind}] Could not commit report: ${err}`)
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
// Main entry point
// ---------------------------------------------------------------------------

/** Load all MD workflow definitions and register them with the engine. */
export function loadMdWorkflows(engine: WorkflowEngine, sessions: SessionManager): void {
  const defs = loadBuiltinWorkflows()
  for (const def of defs) {
    registerWorkflow(engine, sessions, def)
  }
  console.log(`[workflow-loader] Loaded ${defs.length} workflow(s) from MD definitions`)
}
