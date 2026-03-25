/**
 * Approval manager for Codekin.
 *
 * Manages repo-level auto-approval rules for tools and Bash commands.
 * Approvals are stored per-repo (keyed by workingDir) in
 * ~/.codekin/repo-approvals.json, so they persist across sessions
 * sharing the same repo.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from './config.js'
import { addNativePermission, toNativePermission, toAllowedToolsPatterns } from './native-permissions.js'

const REPO_APPROVALS_FILE = join(DATA_DIR, 'repo-approvals.json')
const PERSIST_DEBOUNCE_MS = 2000

/**
 * Minimum number of repos that must have independently approved the same
 * tool/command/pattern before it is auto-approved globally (cross-repo).
 */
const CROSS_REPO_THRESHOLD = 2

export class ApprovalManager {
  /**
   * Tools that must NEVER be auto-approved — they always require explicit
   * user confirmation regardless of saved registry rules.
   * Note: ExitPlanMode was previously here but is now handled by PlanManager
   * at the Codekin layer (conversational approval), not the permission layer.
   */
  static readonly NEVER_AUTO_APPROVE_TOOLS = new Set<string>([
    // Currently empty — all plan mode gating is in PlanManager.
    // Kept as a set for future use (e.g. destructive tools).
  ])

  /** Repo-level auto-approval store, keyed by workingDir (repo path). */
  private repoApprovals = new Map<string, { tools: Set<string>; commands: Set<string>; patterns: Set<string> }>()
  private _approvalPersistTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.validatePrefixSets()
    this.restoreRepoApprovalsFromDisk()
  }

  /** Warn at startup if any single-token prefix appears in both allow and deny lists. */
  private validatePrefixSets(): void {
    for (const prefix of ApprovalManager.PATTERNABLE_PREFIXES) {
      if (ApprovalManager.NEVER_PATTERN_PREFIXES.has(prefix)) {
        console.warn(`[approval-manager] WARNING: "${prefix}" is in both PATTERNABLE_PREFIXES and NEVER_PATTERN_PREFIXES — deny takes precedence for single-token; two-token allow overrides first-token deny`)
      }
    }
  }

  /** Get or create the approval entry for a repo (workingDir). */
  private getRepoApprovalEntry(workingDir: string): { tools: Set<string>; commands: Set<string>; patterns: Set<string> } {
    let entry = this.repoApprovals.get(workingDir)
    if (!entry) {
      entry = { tools: new Set(), commands: new Set(), patterns: new Set() }
      this.repoApprovals.set(workingDir, entry)
    }
    return entry
  }

  /** Add an auto-approval rule for a repo and persist. */
  addRepoApproval(workingDir: string, opts: { tool?: string; command?: string; pattern?: string }): void {
    const entry = this.getRepoApprovalEntry(workingDir)
    if (opts.tool) entry.tools.add(opts.tool)
    if (opts.command) entry.commands.add(opts.command)
    if (opts.pattern) entry.patterns.add(opts.pattern)
    this.persistRepoApprovalsDebounced()
  }

  /**
   * Prefixes where pattern-based grouping is safe. Used by derivePattern()
   * and compactExactCommands() to create "prefix *" patterns.
   *
   * IMPORTANT: Inclusion here does NOT auto-approve anything — the user
   * still explicitly approves the pattern. It only means "we can group
   * `git push origin feat/x` and `git push origin feat/y` into one
   * `git push *` pattern" instead of storing each as an exact match.
   */
  private static readonly PATTERNABLE_PREFIXES = new Set([
    // Git operations — safe to group by subcommand
    'git add', 'git commit', 'git diff', 'git log', 'git show', 'git stash',
    'git status', 'git branch', 'git checkout', 'git switch', 'git rebase',
    'git fetch', 'git pull', 'git merge', 'git tag', 'git rev-parse',
    'git remote', 'git cherry-pick',
    'git worktree', 'git archive',

    // GitHub CLI
    'gh pr', 'gh repo', 'gh run', 'gh search',
    'gh issue', 'gh release',

    // Package managers — Node (two-token subcommands only; bare executors are in NEVER list)
    'npm run', 'npm test', 'npm install', 'npm ci', 'npm exec',
    'yarn run', 'yarn test', 'yarn install', 'yarn add',
    'pnpm test', 'pnpm run', 'pnpm install',
    'pnpm --filter', 'pnpm typecheck',
    'bun run', 'bun test', 'bun install',

    // Build / compile (two-token subcommands only)
    'cargo build', 'cargo test', 'cargo run', 'cargo check', 'cargo clippy',
    'make', 'cmake',
    'pip install',
    'go build', 'go test', 'go run', 'go vet',
    'tsc', 'eslint', 'prettier',

    // File inspection (read-only)
    'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'diff', 'less',
    'ls', 'pwd', 'echo', 'date', 'which', 'whoami', 'env', 'printenv',
    'find', 'grep', 'rg', 'ag', 'fd',
    'mkdir', 'touch',
    'file', 'du', 'stat', 'tree',
    'basename', 'dirname', 'realpath',
  ])

  /**
   * Prefixes that should NEVER be auto-patterned, even if the user
   * clicks "Always Allow". These are stored as exact match only.
   */
  private static readonly NEVER_PATTERN_PREFIXES = new Set([
    'ssh', 'docker', 'docker-compose',
    'rm', 'sudo', 'curl', 'wget',
    'git reset', 'git clean',
    'git push',  // cross-remote escalation risk — require exact match
    'gh api',  // can perform DELETE/PUT — too broad to pattern
    // Code executors — "node *" / "python *" would match arbitrary code execution
    'node', 'npx', 'python', 'python3', 'deno', 'bun', 'pm2',
  ])

  /**
   * Check if a tool/command is auto-approved for a repo.
   * For Bash commands, uses prefix matching only for safe commands;
   * dangerous commands require exact match to prevent escalation.
   *
   * Falls back to cross-repo inference: if the same tool/command/pattern
   * has been approved in CROSS_REPO_THRESHOLD or more other repos,
   * it is auto-approved everywhere.
   */
  checkAutoApproval(workingDir: string, toolName: string, toolInput: Record<string, unknown>): boolean {
    if (this.checkRepoApproval(workingDir, toolName, toolInput)) return true
    return this.checkCrossRepoApproval(workingDir, toolName, toolInput)
  }

  /** Check approvals for a single repo (no cross-repo fallback). */
  private checkRepoApproval(workingDir: string, toolName: string, toolInput: Record<string, unknown>): boolean {
    if (ApprovalManager.NEVER_AUTO_APPROVE_TOOLS.has(toolName)) return false
    const approvals = this.repoApprovals.get(workingDir)
    if (!approvals) return false
    if (approvals.tools.has(toolName)) return true
    if (toolName === 'Bash') {
      const cmd = (typeof toolInput.command === 'string' ? toolInput.command : '').trim()
      // Exact match always works
      if (approvals.commands.has(cmd)) return true
      // Pattern match (e.g. "cat *" matches any cat command)
      for (const pattern of approvals.patterns) {
        if (this.matchesPattern(pattern, cmd)) return true
      }
      // Prefix match only for safe commands
      const cmdPrefix = this.commandPrefix(cmd)
      if (cmdPrefix && ApprovalManager.PATTERNABLE_PREFIXES.has(cmdPrefix)) {
        for (const approved of approvals.commands) {
          if (this.commandPrefix(approved) === cmdPrefix) return true
        }
      }
    }
    return false
  }

  /**
   * Cross-repo inference: if enough other repos have approved the same
   * tool/command/pattern, auto-approve it for this repo too.
   */
  private checkCrossRepoApproval(workingDir: string, toolName: string, toolInput: Record<string, unknown>): boolean {
    if (ApprovalManager.NEVER_AUTO_APPROVE_TOOLS.has(toolName)) return false
    let count = 0
    for (const [dir, entry] of this.repoApprovals) {
      if (dir === workingDir) continue
      // Check tool approval
      if (toolName !== 'Bash') {
        if (entry.tools.has(toolName)) count++
      } else {
        const cmd = (typeof toolInput.command === 'string' ? toolInput.command : '').trim()
        let matched = false
        // Exact command match
        if (entry.commands.has(cmd)) matched = true
        // Pattern match
        if (!matched) {
          for (const pattern of entry.patterns) {
            if (this.matchesPattern(pattern, cmd)) { matched = true; break }
          }
        }
        // Prefix match for safe commands
        if (!matched) {
          const cmdPrefix = this.commandPrefix(cmd)
          if (cmdPrefix && ApprovalManager.PATTERNABLE_PREFIXES.has(cmdPrefix)) {
            for (const approved of entry.commands) {
              if (this.commandPrefix(approved) === cmdPrefix) { matched = true; break }
            }
          }
        }
        if (matched) count++
      }
      if (count >= CROSS_REPO_THRESHOLD) {
        const label = toolName === 'Bash'
          ? `command: ${(typeof toolInput.command === 'string' ? toolInput.command : '').slice(0, 80)}`
          : `tool: ${toolName}`
        console.log(`[auto-approve] cross-repo inference (${count} repos) for ${workingDir}: ${label}`)
        return true
      }
    }
    return false
  }

  /** Extract the command prefix (first two tokens) for prefix-based matching. */
  private commandPrefix(cmd: string): string {
    const tokens = cmd.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return ''
    if (tokens.length === 1) return tokens[0]
    return `${tokens[0]} ${tokens[1]}`
  }

  /**
   * Derive a glob pattern from a tool invocation for "Always Allow".
   * Returns a string like "cat *" or "git diff *", or null if no safe pattern applies.
   * Patterns use the format "<prefix> *" meaning "this prefix followed by anything".
   */
  derivePattern(toolName: string, toolInput: Record<string, unknown>): string | null {
    if (toolName !== 'Bash') return null
    const cmd = (typeof toolInput.command === 'string' ? toolInput.command : '').trim()
    const tokens = cmd.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return null

    // Never pattern commands with shell meta-characters — the pattern
    // would be far broader than the specific command the user approved
    if (/[|;&`$(){}*?[\]~]/.test(cmd) || cmd.includes('\n')) return null

    const first = tokens[0]
    const twoToken = tokens.length >= 2 ? `${tokens[0]} ${tokens[1]}` : ''

    // Two-token deny-list always wins (e.g. "git push", "git reset")
    if (twoToken && ApprovalManager.NEVER_PATTERN_PREFIXES.has(twoToken)) return null

    // Two-token allow-list takes priority over first-token deny
    // (e.g. "bun run" is safe even though bare "bun" is denied)
    if (twoToken && ApprovalManager.PATTERNABLE_PREFIXES.has(twoToken)) return `${twoToken} *`

    // First-token deny-list blocks remaining single-token patterns
    if (ApprovalManager.NEVER_PATTERN_PREFIXES.has(first)) return null

    // First-token allow-list
    if (ApprovalManager.PATTERNABLE_PREFIXES.has(first)) return `${first} *`

    return null
  }

  /**
   * Check if a bash command matches a stored pattern.
   * Patterns of the form "<prefix> *" match any command starting with <prefix>.
   */
  private matchesPattern(pattern: string, cmd: string): boolean {
    if (pattern.endsWith(' *')) {
      const prefix = pattern.slice(0, -2)
      return cmd === prefix || cmd.startsWith(prefix + ' ')
    }
    return cmd === pattern
  }

  /**
   * Save an "Always Allow" approval for a tool/command.
   * For Bash commands, stores a pattern when derivable (e.g. "git push *"),
   * falling back to exact match only for commands without a safe pattern.
   */
  saveAlwaysAllow(workingDir: string, toolName: string, toolInput: Record<string, unknown>): void {
    if (ApprovalManager.NEVER_AUTO_APPROVE_TOOLS.has(toolName)) {
      console.log(`[auto-approve] skipping always-allow for ${toolName} (never auto-approve)`)
      return
    }
    if (toolName === 'Bash') {
      const pattern = this.derivePattern(toolName, toolInput)
      if (pattern) {
        this.addRepoApproval(workingDir, { pattern })
        console.log(`[auto-approve] saved pattern for repo ${workingDir}: ${pattern}`)
      } else {
        // No safe pattern derivable (command is in NEVER_PATTERN_PREFIXES or
        // contains shell metacharacters) — save as exact command match so
        // "Always Allow" actually works for these commands.
        const cmd = (typeof toolInput.command === 'string' ? toolInput.command : '').trim()
        if (cmd) {
          this.addRepoApproval(workingDir, { command: cmd })
          console.log(`[auto-approve] saved exact command for repo ${workingDir}: ${cmd.slice(0, 80)}`)
        }
      }
    } else {
      this.addRepoApproval(workingDir, { tool: toolName })
      console.log(`[auto-approve] saved tool for repo ${workingDir}: ${toolName}`)
    }

    // Dual-write: also persist to Claude Code's native settings.local.json
    const nativePerm = toNativePermission(toolName, toolInput)
    if (nativePerm) {
      addNativePermission(workingDir, nativePerm).catch(err => {
        console.error(`[auto-approve] failed to write native permission:`, err)
      })
    }
  }

  /** Save a pattern-based approval (e.g. "cat *") for a tool/command. */
  savePatternApproval(workingDir: string, toolName: string, toolInput: Record<string, unknown>): void {
    const pattern = this.derivePattern(toolName, toolInput)
    if (pattern) {
      this.addRepoApproval(workingDir, { pattern })
      console.log(`[auto-approve] saved pattern for repo ${workingDir}: ${pattern}`)
    } else {
      // No pattern derivable — skip saving rather than silently escalating to always-allow
      console.log(`[auto-approve] no pattern derivable for ${toolName}, skipping pattern save`)
    }
  }

  /** Return `--allowedTools` patterns for a repo, combining all registry approvals. */
  getAllowedToolsForRepo(workingDir: string): string[] {
    const approvals = this.getApprovals(workingDir)
    return toAllowedToolsPatterns(approvals)
  }

  /** Return the auto-approved tools, commands, and patterns for a repo (workingDir). */
  getApprovals(workingDir: string): { tools: string[]; commands: string[]; patterns: string[] } {
    const entry = this.repoApprovals.get(workingDir)
    if (!entry) return { tools: [], commands: [], patterns: [] }
    return {
      tools: Array.from(entry.tools).sort(),
      commands: Array.from(entry.commands).sort(),
      patterns: Array.from(entry.patterns).sort(),
    }
  }

  /**
   * Return approvals that are effective globally via cross-repo inference
   * (approved in CROSS_REPO_THRESHOLD+ repos). Each entry includes the
   * repos that contributed to it.
   */
  getGlobalApprovals(): { tools: Record<string, string[]>; commands: Record<string, string[]>; patterns: Record<string, string[]> } {
    const toolCounts = new Map<string, string[]>()
    const commandCounts = new Map<string, string[]>()
    const patternCounts = new Map<string, string[]>()

    for (const [dir, entry] of this.repoApprovals) {
      for (const tool of entry.tools) {
        const dirs = toolCounts.get(tool) || []
        dirs.push(dir)
        toolCounts.set(tool, dirs)
      }
      for (const cmd of entry.commands) {
        const dirs = commandCounts.get(cmd) || []
        dirs.push(dir)
        commandCounts.set(cmd, dirs)
      }
      for (const pattern of entry.patterns) {
        const dirs = patternCounts.get(pattern) || []
        dirs.push(dir)
        patternCounts.set(pattern, dirs)
      }
    }

    const filterAboveThreshold = (counts: Map<string, string[]>): Record<string, string[]> => {
      const result: Record<string, string[]> = {}
      for (const [key, dirs] of counts) {
        if (dirs.length >= CROSS_REPO_THRESHOLD) result[key] = dirs.sort()
      }
      return result
    }

    return {
      tools: filterAboveThreshold(toolCounts),
      commands: filterAboveThreshold(commandCounts),
      patterns: filterAboveThreshold(patternCounts),
    }
  }

  /** Remove an auto-approval rule for a repo (workingDir) and persist to disk.
   *  Returns 'invalid' if no tool/command provided, or boolean indicating if something was deleted.
   *  Pass skipPersist=true for bulk operations (caller must call persistRepoApprovals after). */
  removeApproval(workingDir: string, opts: { tool?: string; command?: string; pattern?: string }, skipPersist = false): 'invalid' | boolean {
    const tool = typeof opts.tool === 'string' ? opts.tool.trim() : ''
    const command = typeof opts.command === 'string' ? opts.command.trim() : ''
    const pattern = typeof opts.pattern === 'string' ? opts.pattern.trim() : ''
    if (!tool && !command && !pattern) return 'invalid'
    const entry = this.repoApprovals.get(workingDir)
    if (!entry) return false
    let removed = false
    if (tool) removed = entry.tools.delete(tool) || removed
    if (command) removed = entry.commands.delete(command) || removed
    if (pattern) removed = entry.patterns.delete(pattern) || removed
    if (removed && !skipPersist) this.persistRepoApprovals()
    return removed
  }

  /** Write repo-level approvals to disk (atomic rename). */
  persistRepoApprovals(): void {
    const data: Record<string, { tools: string[]; commands: string[]; patterns: string[] }> = {}
    for (const [dir, entry] of this.repoApprovals) {
      // Only persist non-empty entries
      if (entry.tools.size > 0 || entry.commands.size > 0 || entry.patterns.size > 0) {
        data[dir] = {
          tools: Array.from(entry.tools).sort(),
          commands: Array.from(entry.commands).sort(),
          patterns: Array.from(entry.patterns).sort(),
        }
      }
    }

    try {
      mkdirSync(DATA_DIR, { recursive: true })
      const tmp = REPO_APPROVALS_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
      renameSync(tmp, REPO_APPROVALS_FILE)
    } catch (err) {
      console.error('Failed to persist repo approvals:', err)
    }
  }

  private persistRepoApprovalsDebounced(): void {
    if (this._approvalPersistTimer) return
    this._approvalPersistTimer = setTimeout(() => {
      this._approvalPersistTimer = null
      this.persistRepoApprovals()
    }, PERSIST_DEBOUNCE_MS)
  }

  private restoreRepoApprovalsFromDisk(): void {
    if (!existsSync(REPO_APPROVALS_FILE)) return

    try {
      const raw = readFileSync(REPO_APPROVALS_FILE, 'utf-8')
      const data = JSON.parse(raw) as Record<string, { tools?: string[]; commands?: string[]; patterns?: string[] }>

      for (const [dir, entry] of Object.entries(data)) {
        const tools = new Set(entry.tools || [])
        // Remove tools that must never be auto-approved (stale entries from before the blocklist)
        for (const blocked of ApprovalManager.NEVER_AUTO_APPROVE_TOOLS) {
          tools.delete(blocked)
        }
        this.repoApprovals.set(dir, {
          tools,
          commands: new Set(entry.commands || []),
          patterns: new Set(entry.patterns || []),
        })
      }

      console.log(`Restored repo approvals for ${Object.keys(data).length} repo(s) from disk`)
    } catch (err) {
      console.error('Failed to restore repo approvals from disk:', err)
    }
  }
}
