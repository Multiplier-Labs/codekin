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

const REPO_APPROVALS_FILE = join(DATA_DIR, 'repo-approvals.json')
const PERSIST_DEBOUNCE_MS = 2000

export class ApprovalManager {
  /** Repo-level auto-approval store, keyed by workingDir (repo path). */
  private repoApprovals = new Map<string, { tools: Set<string>; commands: Set<string>; patterns: Set<string> }>()
  private _approvalPersistTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.restoreRepoApprovalsFromDisk()
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
   * Command prefixes where prefix-based auto-approval is safe.
   * Only commands whose behavior is determined by later arguments (not by target)
   * should be listed here. Dangerous commands like rm, sudo, curl, etc. require
   * exact match to prevent escalation (e.g. approving `rm -rf /tmp/x` should NOT
   * also approve `rm -rf /`).
   */
  private static readonly SAFE_PREFIX_COMMANDS = new Set([
    'git add', 'git commit', 'git diff', 'git log', 'git show', 'git stash',
    'git status', 'git branch', 'git checkout', 'git switch', 'git rebase',
    'git fetch', 'git pull', 'git merge', 'git tag', 'git rev-parse',
    'npm run', 'npm test', 'npm install', 'npm ci', 'npm exec',
    'npx', 'node', 'bun', 'deno',
    'cargo build', 'cargo test', 'cargo run', 'cargo check', 'cargo clippy',
    'make', 'cmake',
    'python', 'python3', 'pip install',
    'go build', 'go test', 'go run', 'go vet',
    'tsc', 'eslint', 'prettier',
    'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'diff', 'less',
    'ls', 'pwd', 'echo', 'date', 'which', 'whoami', 'env', 'printenv',
    'find', 'grep', 'rg', 'ag', 'fd',
    'mkdir', 'touch',
  ])

  /**
   * Check if a tool/command is auto-approved for a repo.
   * For Bash commands, uses prefix matching only for safe commands;
   * dangerous commands require exact match to prevent escalation.
   */
  checkAutoApproval(workingDir: string, toolName: string, toolInput: Record<string, unknown>): boolean {
    const approvals = this.getRepoApprovalEntry(workingDir)
    if (approvals.tools.has(toolName)) return true
    if (toolName === 'Bash') {
      const cmd = String(toolInput.command || '').trim()
      // Exact match always works
      if (approvals.commands.has(cmd)) return true
      // Pattern match (e.g. "cat *" matches any cat command)
      for (const pattern of approvals.patterns) {
        if (this.matchesPattern(pattern, cmd)) return true
      }
      // Prefix match only for safe commands
      const cmdPrefix = this.commandPrefix(cmd)
      if (cmdPrefix && ApprovalManager.SAFE_PREFIX_COMMANDS.has(cmdPrefix)) {
        for (const approved of approvals.commands) {
          if (this.commandPrefix(approved) === cmdPrefix) return true
        }
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
   * Derive a glob pattern from a tool invocation for "Approve Pattern".
   * Returns a string like "cat *" or "git diff *", or null if no safe pattern applies.
   * Patterns use the format "<prefix> *" meaning "this prefix followed by anything".
   */
  derivePattern(toolName: string, toolInput: Record<string, unknown>): string | null {
    if (toolName !== 'Bash') return null
    const cmd = String(toolInput.command || '').trim()
    const tokens = cmd.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return null

    // Check single-token safe commands (cat, grep, ls, etc.)
    const first = tokens[0]
    if (ApprovalManager.SAFE_PREFIX_COMMANDS.has(first)) {
      return `${first} *`
    }

    // Check two-token safe commands (git diff, npm run, etc.)
    if (tokens.length >= 2) {
      const twoToken = `${tokens[0]} ${tokens[1]}`
      if (ApprovalManager.SAFE_PREFIX_COMMANDS.has(twoToken)) {
        return `${twoToken} *`
      }
    }

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

  /** Save an "Always Allow" approval for a tool/command. */
  saveAlwaysAllow(workingDir: string, toolName: string, toolInput: Record<string, unknown>): void {
    if (toolName === 'Bash') {
      const cmd = String(toolInput.command || '').trim()
      this.addRepoApproval(workingDir, { command: cmd })
      console.log(`[auto-approve] saved command for repo ${workingDir}: ${cmd.slice(0, 80)}`)
    } else {
      this.addRepoApproval(workingDir, { tool: toolName })
      console.log(`[auto-approve] saved tool for repo ${workingDir}: ${toolName}`)
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
      writeFileSync(tmp, JSON.stringify(data, null, 2))
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
        this.repoApprovals.set(dir, {
          tools: new Set(entry.tools || []),
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
