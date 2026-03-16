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
    it('returns true when 2 repos have approved the same tool', () => {
      mgr.addRepoApproval('/repo/a', { tool: 'Read' })
      mgr.addRepoApproval('/repo/b', { tool: 'Read' })

      // Third repo should auto-approve via cross-repo inference
      expect(mgr.checkAutoApproval('/repo/c', 'Read', {})).toBe(true)
    })

    it('returns false when only 1 repo has approved the tool', () => {
      mgr.addRepoApproval('/repo/a', { tool: 'Read' })

      expect(mgr.checkAutoApproval('/repo/c', 'Read', {})).toBe(false)
    })
  })

  // ─── 2. Cross-repo Bash command ────────────────────────────────────

  describe('checkAutoApproval - cross-repo Bash command', () => {
    it('auto-approves a Bash command approved in 2 other repos', () => {
      mgr.addRepoApproval('/repo/a', { command: 'git status' })
      mgr.addRepoApproval('/repo/b', { command: 'git status' })

      expect(
        mgr.checkAutoApproval('/repo/c', 'Bash', { command: 'git status' }),
      ).toBe(true)
    })
  })

  // ─── 3. Cross-repo pattern match ──────────────────────────────────

  describe('checkAutoApproval - cross-repo pattern match', () => {
    it('auto-approves via pattern match across repos', () => {
      mgr.addRepoApproval('/repo/a', { pattern: 'git diff *' })
      mgr.addRepoApproval('/repo/b', { pattern: 'git diff *' })

      expect(
        mgr.checkAutoApproval('/repo/c', 'Bash', { command: 'git diff HEAD' }),
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

    it('returns null for "git push origin main" (NEVER_PATTERN_PREFIXES)', () => {
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

  describe('compactExactCommands', () => {
    it('compacts 3+ commands sharing a prefix into a pattern', () => {
      // Mock disk data with 3 cat commands for one repo
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          '/repo/x': {
            tools: [],
            commands: ['cat a.txt', 'cat b.txt', 'cat c.txt'],
            patterns: [],
          },
        }),
      )

      const freshMgr = new ApprovalManager()

      // The 3 cat commands should have been compacted into "cat *"
      // so a new cat command should be auto-approved
      expect(
        freshMgr.checkAutoApproval('/repo/x', 'Bash', { command: 'cat d.txt' }),
      ).toBe(true)

      // Verify the pattern was created
      const approvals = freshMgr.getApprovals('/repo/x')
      expect(approvals.patterns).toContain('cat *')
      // Original exact commands should have been removed
      expect(approvals.commands).not.toContain('cat a.txt')
      expect(approvals.commands).not.toContain('cat b.txt')
      expect(approvals.commands).not.toContain('cat c.txt')
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
  })
})
