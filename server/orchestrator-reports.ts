/**
 * Orchestrator report reader — scans .codekin/reports/ across managed repos.
 *
 * Discovers audit reports, parses their metadata, and provides them
 * to the orchestrator session for triage and action.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, basename, resolve } from 'path'
import { REPOS_ROOT, DATA_DIR } from './config.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReportMeta {
  /** Full path to the report file. */
  filePath: string
  /** Report category (directory name): repo-health, security, code-review, etc. */
  category: string
  /** Date extracted from filename (YYYY-MM-DD). */
  date: string
  /** Repository path this report belongs to. */
  repoPath: string
  /** File size in bytes. */
  size: number
  /** Last modified time. */
  mtime: string
}

export interface ReportContent extends ReportMeta {
  /** Full markdown content of the report. */
  content: string
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const REPORTS_DIR = '.codekin/reports'

/** Known report categories. */
const REPORT_CATEGORIES = [
  'code-review',
  'comments',
  'complexity',
  'dependencies',
  'docs-audit',
  'repo-health',
  'security',
  'test-coverage',
]

/**
 * Scan a single repo for all available reports.
 * Returns metadata only (no content) for efficiency.
 */
export function scanRepoReports(repoPath: string): ReportMeta[] {
  const reportsDir = join(repoPath, REPORTS_DIR)
  if (!existsSync(reportsDir)) return []

  const results: ReportMeta[] = []

  for (const category of REPORT_CATEGORIES) {
    const categoryDir = join(reportsDir, category)
    if (!existsSync(categoryDir)) continue

    let entries: string[]
    try {
      entries = readdirSync(categoryDir)
    } catch {
      continue
    }

    for (const file of entries) {
      if (!file.endsWith('.md')) continue

      const filePath = join(categoryDir, file)
      const stat = statSync(filePath)
      const dateMatch = basename(file).match(/^(\d{4}-\d{2}-\d{2})/)
      const date = dateMatch ? dateMatch[1] : 'unknown'

      results.push({
        filePath,
        category,
        date,
        repoPath,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      })
    }
  }

  // Sort by date descending (most recent first)
  results.sort((a, b) => b.date.localeCompare(a.date))
  return results
}

/**
 * Read a report's full content.
 */
export function readReport(filePath: string): ReportContent | null {
  const resolved = resolve(filePath)
  // Verify the path is within a known reports directory (anchored startsWith, not includes)
  const isDataReport = resolved.startsWith(DATA_DIR + '/reports/')
  const isRepoReport = resolved.startsWith(REPOS_ROOT + '/') &&
    /^[^/]+\/\.codekin\/reports\//.test(resolved.slice(REPOS_ROOT.length + 1))
  if (!isDataReport && !isRepoReport) return null
  if (!existsSync(resolved)) return null

  const content = readFileSync(resolved, 'utf-8')
  const stat = statSync(resolved)

  // Extract metadata from path
  const parts = filePath.split('/')
  const reportsIdx = parts.indexOf('reports')
  const category = reportsIdx >= 0 ? parts[reportsIdx + 1] : 'unknown'

  // Find repo path (everything before .codekin/reports)
  const codekinIdx = filePath.indexOf('.codekin/reports')
  const repoPath = codekinIdx >= 0 ? filePath.substring(0, codekinIdx - 1) : ''

  const dateMatch = basename(filePath).match(/^(\d{4}-\d{2}-\d{2})/)
  const date = dateMatch ? dateMatch[1] : 'unknown'

  return {
    filePath,
    category,
    date,
    repoPath,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    content,
  }
}

/**
 * Get the latest report for a given repo and category.
 */
export function getLatestReport(repoPath: string, category: string): ReportMeta | null {
  const reports = scanRepoReports(repoPath)
  return reports.find(r => r.category === category) ?? null
}

/**
 * Get reports that are newer than a given date.
 */
export function getReportsSince(repoPaths: string[], sinceDate: string): ReportMeta[] {
  const all: ReportMeta[] = []
  for (const repoPath of repoPaths) {
    all.push(...scanRepoReports(repoPath))
  }
  all.sort((a, b) => b.date.localeCompare(a.date))
  return all.filter(r => r.date >= sinceDate)
}
