/** Tests for readReport — verifies depth-agnostic path-validation for nested repo
 * layouts (org/repo/.codekin/reports/...) while still rejecting paths that escape
 * REPOS_ROOT or live outside the data-dir reports root. */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const root = mkdtempSync(join(tmpdir(), 'codekin-reports-test-'))
const reposRoot = join(root, 'repos')
const dataDir = join(root, 'data')
const outside = join(root, 'outside')
mkdirSync(reposRoot, { recursive: true })
mkdirSync(dataDir, { recursive: true })
mkdirSync(outside, { recursive: true })

// Flat: <REPOS_ROOT>/flatrepo/.codekin/reports/security/<date>_x.md
const flatDir = join(reposRoot, 'flatrepo', '.codekin', 'reports', 'security')
mkdirSync(flatDir, { recursive: true })
const flatReport = join(flatDir, '2026-04-21_audit.md')
writeFileSync(flatReport, '# Flat\n')

// Nested: <REPOS_ROOT>/org/subteam/nested-repo/.codekin/reports/code-review/<date>_y.md
const nestedDir = join(reposRoot, 'org', 'subteam', 'nested-repo', '.codekin', 'reports', 'code-review')
mkdirSync(nestedDir, { recursive: true })
const nestedReport = join(nestedDir, '2026-04-21_review.md')
writeFileSync(nestedReport, '# Nested\n')

// Data-dir report: <DATA_DIR>/reports/dashboard/<date>_z.md
const dataReportsDir = join(dataDir, 'reports', 'dashboard')
mkdirSync(dataReportsDir, { recursive: true })
const dataReport = join(dataReportsDir, '2026-04-21_summary.md')
writeFileSync(dataReport, '# Data\n')

// Malicious report outside REPOS_ROOT
const outsideReport = join(outside, 'evil.md')
writeFileSync(outsideReport, '# Evil\n')

// Symlink inside REPOS_ROOT pointing outside REPOS_ROOT
const symlinkReport = join(reposRoot, 'flatrepo', '.codekin', 'reports', 'security', 'link.md')
symlinkSync(outsideReport, symlinkReport)

// File under REPOS_ROOT but not under a `.codekin/reports` directory
const strayDir = join(reposRoot, 'flatrepo', 'docs')
mkdirSync(strayDir, { recursive: true })
const strayReport = join(strayDir, 'stray.md')
writeFileSync(strayReport, '# Stray\n')

vi.mock('./config.js', () => ({
  REPOS_ROOT: resolve(reposRoot),
  DATA_DIR: resolve(dataDir),
}))

// Import after mocks
const { readReport } = await import('./orchestrator-reports.js')

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readReport', () => {
  it('accepts a flat one-level repo layout', () => {
    const result = readReport(flatReport)
    expect(result).not.toBeNull()
    expect(result?.content).toContain('Flat')
    expect(result?.category).toBe('security')
  })

  it('accepts a nested deep repo layout (org/subteam/repo/.codekin/reports/...)', () => {
    const result = readReport(nestedReport)
    expect(result).not.toBeNull()
    expect(result?.content).toContain('Nested')
    expect(result?.category).toBe('code-review')
  })

  it('accepts data-dir reports', () => {
    const result = readReport(dataReport)
    expect(result).not.toBeNull()
    expect(result?.content).toContain('Data')
  })

  it('rejects a symlink that escapes REPOS_ROOT', () => {
    expect(readReport(symlinkReport)).toBeNull()
  })

  it('rejects a path that does not contain /.codekin/reports/', () => {
    expect(readReport(strayReport)).toBeNull()
  })

  it('rejects a path outside REPOS_ROOT and DATA_DIR', () => {
    expect(readReport(outsideReport)).toBeNull()
  })

  it('returns null when the path does not exist', () => {
    expect(readReport(join(reposRoot, 'flatrepo', '.codekin', 'reports', 'security', 'missing.md'))).toBeNull()
  })
})
