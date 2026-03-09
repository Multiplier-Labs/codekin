/**
 * REST routes for the docs browser feature.
 *
 * Provides two endpoints:
 * - GET /api/repos/:repoId/docs — list markdown files in a repo
 * - GET /api/repos/:repoId/docs/:filePath — get raw content of a markdown file
 *
 * The :repoId is the URL-encoded workingDir path of the repo.
 * The :filePath is a URL-encoded relative path (e.g. "docs%2Fprotocol.md").
 */

import { Router } from 'express'
import type { Request } from 'express'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve, relative, extname } from 'path'

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

/** Directories to exclude from the file listing. */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.github', '.codekin', '.vscode',
  '.idea', 'dist', 'build', 'coverage', '__pycache__', '.next',
  '.nuxt', '.svelte-kit', 'vendor', '.cache',
])

/** Files pinned to the top of the list, in display order. */
const PINNED_FILES = ['CLAUDE.md', 'README.md']

interface DocFile {
  path: string
  pinned: boolean
}

/**
 * Recursively find all .md files in a directory, up to maxDepth levels deep.
 * Excludes hidden directories and common non-source directories.
 */
function findMarkdownFiles(root: string, maxDepth: number): string[] {
  const results: string[] = []

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.') continue
      const fullPath = join(dir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry)) {
          walk(fullPath, depth + 1)
        }
      } else if (stat.isFile() && extname(entry).toLowerCase() === '.md') {
        results.push(relative(root, fullPath))
      }
    }
  }

  walk(root, 0)
  return results
}

export function createDocsRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
): Router {
  const router = Router()

  // Auth middleware for all docs routes
  router.use('/api/repos/:repoId/docs', (req, res, next) => {
    if (!verifyToken(extractToken(req))) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
  })

  /**
   * GET /api/repos/:repoId/docs
   * List markdown files in the repo. Pinned files appear first.
   */
  router.get('/api/repos/:repoId/docs', (req, res) => {
    const repoPath = decodeURIComponent(req.params.repoId)

    // Validate the repo path exists and is a directory
    try {
      const stat = statSync(repoPath)
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Not a directory' })
      }
    } catch {
      return res.status(404).json({ error: 'Repo not found' })
    }

    const mdFiles = findMarkdownFiles(repoPath, 3)
    const pinnedSet = new Set(PINNED_FILES.map(f => f.toLowerCase()))

    const pinned: DocFile[] = []
    const rest: DocFile[] = []

    for (const filePath of mdFiles) {
      if (pinnedSet.has(filePath.toLowerCase())) {
        pinned.push({ path: filePath, pinned: true })
      } else {
        rest.push({ path: filePath, pinned: false })
      }
    }

    // Sort pinned in the defined order, rest alphabetically
    pinned.sort((a, b) => {
      const ai = PINNED_FILES.findIndex(p => p.toLowerCase() === a.path.toLowerCase())
      const bi = PINNED_FILES.findIndex(p => p.toLowerCase() === b.path.toLowerCase())
      return ai - bi
    })
    rest.sort((a, b) => a.path.localeCompare(b.path))

    res.json({ files: [...pinned, ...rest] })
  })

  /**
   * GET /api/repos/:repoId/docs/:filePath
   * Get the raw content of a single markdown file.
   * :filePath is URL-encoded relative path (e.g. "docs%2Fprotocol.md").
   */
  router.get('/api/repos/:repoId/docs/:filePath', (req, res) => {
    const repoPath = decodeURIComponent(req.params.repoId)
    const filePath = decodeURIComponent(req.params.filePath)

    // Validate file extension
    if (extname(filePath).toLowerCase() !== '.md') {
      return res.status(400).json({ error: 'Only .md files are supported' })
    }

    // Path traversal guard
    const resolved = resolve(repoPath, filePath)
    const repoResolved = resolve(repoPath)
    if (!resolved.startsWith(repoResolved + '/') && resolved !== repoResolved) {
      return res.status(404).json({ error: 'File not found' })
    }

    try {
      const content = readFileSync(resolved, 'utf-8')
      res.json({ path: filePath, content })
    } catch {
      res.status(404).json({ error: 'File not found' })
    }
  })

  return router
}
