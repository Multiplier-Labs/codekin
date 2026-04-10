/** Tests for ApprovalManager — verifies cross-repo inference, per-repo approval tracking, and Bash pattern matching; mocks fs to avoid disk I/O. */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readFileSync: vi.fn(() => '{}'),
  }
})

import { ApprovalManager } from './approval-manager.js'
import { existsSync, readFileSync } from 'fs'

describe('ApprovalManager', () => {
  let mgr: ApprovalManager

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no file on disk
    vi.mocked(existsSync).mockReturnValue(false)
    mgr = new ApprovalManager()
  })

  // ─── 1. Cross-repo inference (non-Bash tool) ───────────────────────

  describe('checkAutoApproval - cross-repo inference', () => {
    it('returns true when 5 repos have approved the same tool', () => {
      mgr.addRepoApproval('/repo/a', { tool: 'Read' })
      mgr.addRepoApproval('/repo/b', { tool: 'Read' })
      mgr.addRepoApproval('/repo/c', { tool: 'Read' })
      mgr.addRepoApproval('/repo/d', { tool: 'Read' })
      mgr.addRepoApproval('/repo/e', { tool: 'Read' })

      // Sixth repo should auto-approve via cross-repo inference
      expect(mgr.checkAutoApproval('/repo/f', 'Read', {})).toBe(true)
    })

    it('returns false when fewer than 5 repos have approved the tool', () => {
      mgr.addRepoApproval('/repo/a', { tool: 'Read' })
      mgr.addRepoApproval('/repo/b', { tool: 'Read' })
      mgr.addRepoApproval('/repo/c', { tool: 'Read' })
      mgr.addRepoApproval('/repo/d', { tool: 'Read' })

      expect(mgr.checkAutoApproval('/repo/f', 'Read', {})).toBe(false)
    })
  })

  // ─── 2. Cross-repo Bash command ────────────────────────────────────

  describe('checkAutoApproval - cross-repo Bash command', () => {
    it('auto-approves a Bash command approved in 5 other repos', () => {
      mgr.addRepoApproval('/repo/a', { command: 'git status' })
      mgr.addRepoApproval('/repo/b', { command: 'git status' })
      mgr.addRepoApproval('/repo/c', { command: 'git status' })
      mgr.addRepoApproval('/repo/d', { command: 'git status' })
      mgr.addRepoApproval('/repo/e', { command: 'git status' })

      expect(
        mgr.checkAutoApproval('/repo/f', 'Bash', { command: 'git status' }),
      ).toBe(true)
    })
  })

  // ─── 3. Cross-repo pattern match ──────────────────────────────────

  describe('checkAutoApproval - cross-repo pattern match', () => {
    it('auto-approves via pattern match across repos', () => {
      mgr.addRepoApproval('/repo/a', { pattern: 'git diff *' })
      mgr.addRepoApproval('/repo/b', { pattern: 'git diff *' })
      mgr.addRepoApproval('/repo/c', { pattern: 'git diff *' })
      mgr.addRepoApproval('/repo/d', { pattern: 'git diff *' })
      mgr.addRepoApproval('/repo/e', { pattern: 'git diff *' })

      expect(
        mgr.checkAutoApproval('/repo/f', 'Bash', { command: 'git diff HEAD' }),
      ).toBe(true)
    })
  })

  // ─── 4. derivePattern ──────────────────────────────────────────────

  describe('derivePattern', () => {
    it('derives "git diff *" from "git diff HEAD"', () => {
      expect(mgr.derivePattern('Bash', { command: 'git diff HEAD' })).toBe('git diff *')
    })

    it('derives "npm run *" from "npm run build"', () => {
      expect(mgr.derivePattern('Bash', { command: 'npm run build' })).toBe('npm run *')
    })

    it('derives "cat *" from "cat foo.txt"', () => {
      expect(mgr.derivePattern('Bash', { command: 'cat foo.txt' })).toBe('cat *')
    })

    it('returns null for "git push origin main" (NEVER_PATTERN_PREFIXES wins over PATTERNABLE)', () => {
      expect(mgr.derivePattern('Bash', { command: 'git push origin main' })).toBeNull()
    })

    it('returns null for "rm -rf /tmp/foo" (NEVER_PATTERN_PREFIXES)', () => {
      expect(mgr.derivePattern('Bash', { command: 'rm -rf /tmp/foo' })).toBeNull()
    })

    it('returns null for commands with shell metacharacters', () => {
      expect(mgr.derivePattern('Bash', { command: 'echo "hello" | grep h' })).toBeNull()
    })

    it('derives "bun run *" — two-token allow overrides first-token deny', () => {
      expect(mgr.derivePattern('Bash', { command: 'bun run test' })).toBe('bun run *')
    })

    it('returns null for bare "node script.js" (executor denied)', () => {
      expect(mgr.derivePattern('Bash', { command: 'node script.js' })).toBeNull()
    })
  })

  // ─── 5. compactExactCommands via restoreRepoApprovalsFromDisk ──────

  describe('restoreRepoApprovalsFromDisk', () => {
    it('restores commands and patterns from disk', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          '/repo/x': {
            tools: [],
            commands: ['cat a.txt', 'cat b.txt', 'cat c.txt'],
            patterns: ['cat *'],
          },
        }),
      )

      const freshMgr = new ApprovalManager()

      const approvals = freshMgr.getApprovals('/repo/x')
      expect(approvals.patterns).toContain('cat *')
      // Exact commands are preserved (may be redundant with pattern, but harmless)
      expect(approvals.commands).toContain('cat a.txt')
      expect(approvals.commands).toContain('cat b.txt')
      expect(approvals.commands).toContain('cat c.txt')
    })

    it('restores exact commands from disk', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          '/repo/x': {
            tools: [],
            commands: ['docker run myimage', 'git push origin main'],
            patterns: ['npm *'],
          },
        }),
      )

      const freshMgr = new ApprovalManager()

      const approvals = freshMgr.getApprovals('/repo/x')
      expect(approvals.commands).toContain('docker run myimage')
      expect(approvals.commands).toContain('git push origin main')
      expect(approvals.patterns).toContain('npm *')
    })
  })

  // ─── 6. saveAlwaysAllow ────────────────────────────────────────────

  describe('saveAlwaysAllow', () => {
    it('saves patternable commands as patterns', () => {
      mgr.saveAlwaysAllow('/repo/a', 'Bash', { command: 'git diff HEAD' })
      const approvals = mgr.getApprovals('/repo/a')
      expect(approvals.patterns).toContain('git diff *')
      expect(approvals.commands).toHaveLength(0)
    })

    it('saves non-patternable commands as exact commands', () => {
      mgr.saveAlwaysAllow('/repo/a', 'Bash', { command: 'docker run myimage' })
      const approvals = mgr.getApprovals('/repo/a')
      expect(approvals.commands).toContain('docker run myimage')
      expect(approvals.patterns).toHaveLength(0)
    })

    it('saves non-Bash tools by tool name', () => {
      mgr.saveAlwaysAllow('/repo/a', 'Read', {})
      const approvals = mgr.getApprovals('/repo/a')
      expect(approvals.tools).toContain('Read')
    })
  })

  // ─── 7. checkRepoApproval - prefix match for safe commands ─────────

  describe('checkRepoApproval - prefix match for safe commands', () => {
    it('approves "git diff main" after "git diff HEAD" was approved (shared two-token prefix)', () => {
      mgr.addRepoApproval('/repo/a', { command: 'git diff HEAD' })

      expect(
        mgr.checkAutoApproval('/repo/a', 'Bash', { command: 'git diff main' }),
      ).toBe(true)
    })

    it('does not prefix-match unsafe commands like "docker run"', () => {
      mgr.addRepoApproval('/repo/a', { command: 'docker run image1' })

      expect(
        mgr.checkAutoApproval('/repo/a', 'Bash', { command: 'docker run image2' }),
      ).toBe(false)
    })
  })

  // ─── 8. removeApproval ─────────────────────────────────────────────

  describe('removeApproval', () => {
    it('removes a tool approval and confirms it is gone', () => {
      mgr.addRepoApproval('/repo/a', { tool: 'Write' })
      expect(mgr.getApprovals('/repo/a').tools).toContain('Write')

      const result = mgr.removeApproval('/repo/a', { tool: 'Write' })
      expect(result).toBe(true)
      expect(mgr.getApprovals('/repo/a').tools).not.toContain('Write')
    })

    it('returns false when removing a non-existent approval', () => {
      expect(mgr.removeApproval('/repo/a', { tool: 'NonExistent' })).toBe(false)
    })

    it('returns "invalid" when no tool/command/pattern is provided', () => {
      expect(mgr.removeApproval('/repo/a', {})).toBe('invalid')
    })

    it('removes a pattern approval and confirms it is gone', () => {
      mgr.addRepoApproval('/repo/a', { pattern: 'git diff *' })
      expect(mgr.getApprovals('/repo/a').patterns).toContain('git diff *')

      const result = mgr.removeApproval('/repo/a', { pattern: 'git diff *' })
      expect(result).toBe(true)
      expect(mgr.getApprovals('/repo/a').patterns).not.toContain('git diff *')
    })

    it('does not call persistRepoApprovals when skipPersist is true', () => {
      mgr.addRepoApproval('/repo/a', { tool: 'Write' })
      const persistSpy = vi.spyOn(mgr, 'persistRepoApprovals')

      mgr.removeApproval('/repo/a', { tool: 'Write' }, true)
      expect(persistSpy).not.toHaveBeenCalled()
    })
  })

  // ─── 9. getGlobalApprovals ──────────────────────────────────────────

  describe('getGlobalApprovals', () => {
    it('returns tools/commands/patterns approved in 5+ repos', () => {
      mgr.addRepoApproval('/repo/a', { tool: 'Read' })
      mgr.addRepoApproval('/repo/b', { tool: 'Read' })
      mgr.addRepoApproval('/repo/c', { tool: 'Read' })
      mgr.addRepoApproval('/repo/d', { tool: 'Read' })
      mgr.addRepoApproval('/repo/e', { tool: 'Read' })
      mgr.addRepoApproval('/repo/a', { pattern: 'cat *' })
      mgr.addRepoApproval('/repo/b', { pattern: 'cat *' })
      mgr.addRepoApproval('/repo/c', { pattern: 'cat *' })
      mgr.addRepoApproval('/repo/d', { pattern: 'cat *' })
      mgr.addRepoApproval('/repo/e', { pattern: 'cat *' })

      const global = mgr.getGlobalApprovals()
      expect(global.tools).toHaveProperty('Read')
      expect(global.tools['Read']).toHaveLength(5)
      expect(global.patterns).toHaveProperty('cat *')
      expect(global.patterns['cat *']).toHaveLength(5)
    })

    it('excludes tools/patterns approved in only 1 repo', () => {
      mgr.addRepoApproval('/repo/a', { tool: 'Read' })
      mgr.addRepoApproval('/repo/a', { pattern: 'cat *' })

      const global = mgr.getGlobalApprovals()
      expect(global.tools).not.toHaveProperty('Read')
      expect(global.patterns).not.toHaveProperty('cat *')
    })
  })

  // ─── 10. savePatternApproval ────────────────────────────────────────

  describe('savePatternApproval', () => {
    it('saves a pattern-based approval for a patternable command', () => {
      mgr.savePatternApproval('/repo/a', 'Bash', { command: 'cat foo.txt' })
      const approvals = mgr.getApprovals('/repo/a')
      expect(approvals.patterns).toContain('cat *')
    })

    it('does not save when no pattern is derivable', () => {
      mgr.savePatternApproval('/repo/a', 'Bash', { command: 'docker run myimage' })
      const approvals = mgr.getApprovals('/repo/a')
      expect(approvals.patterns).toHaveLength(0)
      expect(approvals.commands).toHaveLength(0)
    })
  })

  // ─── 11. NEVER_AUTO_APPROVE_TOOLS ───────────────────────────────────

  describe('NEVER_AUTO_APPROVE_TOOLS', () => {
    it('does not contain ExitPlanMode (gated via PlanManager + hook)', () => {
      // ExitPlanMode approval is handled by PlanManager via the PreToolUse hook,
      // not by the auto-approval blocklist.
      expect(ApprovalManager.NEVER_AUTO_APPROVE_TOOLS.has('ExitPlanMode')).toBe(false)
    })
  })

  // ─── 12. Cross-repo Bash prefix match ───────────────────────────────

  describe('checkAutoApproval - cross-repo Bash prefix match', () => {
    it('auto-approves via prefix match across repos for safe commands', () => {
      // "git diff HEAD" approved in 5 repos
      mgr.addRepoApproval('/repo/a', { command: 'git diff HEAD' })
      mgr.addRepoApproval('/repo/b', { command: 'git diff HEAD' })
      mgr.addRepoApproval('/repo/c', { command: 'git diff HEAD' })
      mgr.addRepoApproval('/repo/d', { command: 'git diff HEAD' })
      mgr.addRepoApproval('/repo/e', { command: 'git diff HEAD' })

      // "git diff main" should be auto-approved in a sixth repo via prefix match
      expect(
        mgr.checkAutoApproval('/repo/f', 'Bash', { command: 'git diff main' }),
      ).toBe(true)
    })
  })

  // ─── 13. derivePattern edge cases ───────────────────────────────────

  describe('derivePattern - edge cases', () => {
    it('returns null for non-Bash tools', () => {
      expect(mgr.derivePattern('Read', { file_path: '/tmp/foo' })).toBeNull()
    })

    it('returns null for empty command', () => {
      expect(mgr.derivePattern('Bash', { command: '' })).toBeNull()
    })
  })
})
