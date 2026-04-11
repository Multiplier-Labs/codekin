/**
 * File upload, repo listing, and clone REST routes.
 *
 * Previously a standalone Express server (upload-server.mjs, port 32353).
 * Now merged into the main server process.
 */

import { Router } from 'express'
import type { Request } from 'express'
import multer from 'multer'
import { mkdirSync, existsSync, readFileSync, readdirSync, realpathSync } from 'fs'
import { join, extname, resolve, sep } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { homedir } from 'os'
import { SCREENSHOTS_DIR, REPOS_ROOT, GH_ORGS } from './config.js'

const execFileAsync = promisify(execFile)

const GLOBAL_SKILLS_DIR = join(homedir(), '.claude', 'skills')
const GLOBAL_MODULES_DIR = join(homedir(), '.claude', 'modules')

type VerifyFn = (token: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

// ---------------------------------------------------------------------------
// Skill / module scanning helpers
// ---------------------------------------------------------------------------

interface FrontmatterMeta { name: string; description: string }

function parseMdWithFrontmatter(content: string): FrontmatterMeta & { body: string } {
  const lines = content.split('\n')
  const meta: FrontmatterMeta = { name: '', description: '' }
  let inFrontmatter = false
  let bodyStart = 0

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (inFrontmatter) {
        bodyStart = i + 1
        break
      }
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      const match = lines[i].match(/^(\w+):\s*(.+)/)
      if (match) {
        const [, key, value] = match
        if (key === 'name') meta.name = value.trim()
        if (key === 'description') meta.description = value.trim()
      }
    }
  }

  const body = lines.slice(bodyStart).join('\n').trim()
  return { ...meta, body }
}

function scanSkills(skillsDir: string) {
  if (!existsSync(skillsDir)) return []

  const skills: Array<{ id: string; name: string; description: string; command: string; content: string }> = []
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillMd = join(skillsDir, entry.name, 'SKILL.md')
    if (!existsSync(skillMd)) continue
    const content = readFileSync(skillMd, 'utf-8')
    const parsed = parseMdWithFrontmatter(content)
    skills.push({
      id: entry.name,
      name: parsed.name || entry.name,
      description: parsed.description || '',
      command: `/${entry.name}`,
      content: parsed.body || '',
    })
  }
  return skills
}

function scanModules(modulesDir: string) {
  if (!existsSync(modulesDir)) return []

  const modules: Array<{ id: string; name: string; description: string; content: string }> = []
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const moduleMd = join(modulesDir, entry.name, 'MODULE.md')
    if (!existsSync(moduleMd)) continue
    const content = readFileSync(moduleMd, 'utf-8')
    const parsed = parseMdWithFrontmatter(content)
    modules.push({
      id: entry.name,
      name: parsed.name || entry.name,
      description: parsed.description || '',
      content: parsed.body,
    })
  }
  return modules
}

// ---------------------------------------------------------------------------
// GitHub repo fetching
// ---------------------------------------------------------------------------

// Strip GITHUB_TOKEN so gh CLI uses the stored OAuth token (with repo scope)
// instead of an npm-scoped PAT that may lack visibility.
const ghEnv = { ...process.env }
delete ghEnv.GITHUB_TOKEN

async function fetchGhRepos(owner: string, reposRoot: string) {
  const { stdout } = await execFileAsync('gh', [
    'repo', 'list', owner,
    '--json', 'name,url,description',
    '--limit', '100',
  ], { env: ghEnv })
  const repos: Array<{ name: string; url: string; description?: string }> = JSON.parse(stdout)
  repos.sort((a, b) => a.name.localeCompare(b.name))
  return repos.map((r) => {
    const repoPath = `${reposRoot}/${r.name}`
    const cloned = existsSync(repoPath)
    return {
      id: r.name,
      name: r.name,
      owner,
      path: repoPath,
      workingDir: repoPath,
      cloned,
      description: r.description || '',
      url: r.url,
      skills: cloned ? scanSkills(join(repoPath, '.claude', 'skills')) : [],
      modules: cloned ? scanModules(join(repoPath, '.claude', 'modules')) : [],
      tags: [],
    }
  })
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createUploadRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  getReposPath?: () => string,
): Router {
  const router = Router()

  /** Resolve the effective repos root: DB setting > REPOS_ROOT env/default. */
  const resolveReposRoot = () => {
    if (getReposPath) {
      const custom = getReposPath()
      if (custom) return custom
    }
    return REPOS_ROOT
  }

  // Ensure upload directory exists
  if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true })

  const storage = multer.diskStorage({
    destination: SCREENSHOTS_DIR,
    filename: (_req, file, cb) => {
      const ts = Date.now()
      const safe = file.originalname.slice(0, 64).replace(/[^a-zA-Z0-9._-]/g, '_')
      cb(null, `${ts}-${safe}`)
    },
  })
  const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/markdown']
  const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.md']
  const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase()
      const extAllowed = ALLOWED_EXTENSIONS.includes(ext)
      const mimeAllowed = ALLOWED_MIME_TYPES.includes(file.mimetype)
      const allowed = extAllowed && mimeAllowed
      if (!allowed) {
        cb(new Error(`File type not allowed: ${file.mimetype}`))
        return
      }
      cb(null, true)
    },
  })

  // --- File upload ---
  router.post('/api/upload', (req, res, next) => {
    const token = extractToken(req)
    if (!verifyToken(token)) {
      res.status(401).json({ error: 'Invalid token' })
      return
    }
    next()
  }, (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const status = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
        res.status(status).json({ error: err.message })
        return
      }
      next()
    })
  }, (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' })
      return
    }
    const filePath = join(SCREENSHOTS_DIR, req.file.filename)
    console.log(`Saved file: ${filePath}`)
    res.json({ success: true, path: filePath })
  })

  // --- List repos ---
  router.get('/api/repos', async (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const reposRoot = resolveReposRoot()
    const globalSkills = scanSkills(GLOBAL_SKILLS_DIR)
    const globalModules = scanModules(GLOBAL_MODULES_DIR)

    try {
      // Get current user login
      const { stdout: userJson } = await execFileAsync('gh', ['api', 'user', '--jq', '.login'])
      const username = userJson.trim()

      const groups: Array<{ owner: string; repos: Awaited<ReturnType<typeof fetchGhRepos>> }> = []

      // Fetch org repos — use configured GH_ORG or auto-detect from gh CLI
      let orgs = GH_ORGS
      if (orgs.length === 0) {
        try {
          const { stdout: orgsJson } = await execFileAsync('gh', ['api', 'user/orgs', '--jq', '.[].login'], { env: ghEnv })
          orgs = orgsJson.trim().split('\n').filter(Boolean)
        } catch {
          // Auto-detection failed — continue without org repos
        }
      }
      for (const org of orgs) {
        const orgRepos = await fetchGhRepos(org, reposRoot)
        groups.push({ owner: org, repos: orgRepos })
      }

      // Fetch user repos
      const userRepos = await fetchGhRepos(username, reposRoot)
      groups.push({ owner: username, repos: userRepos })

      res.json({ groups, globalSkills, globalModules, reposPath: reposRoot })
    } catch (err) {
      console.error('Failed to list repos from GitHub:', err)
      const ghMissing = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
      if (ghMissing) {
        console.error('GitHub CLI (gh) not found. Install it: https://cli.github.com')
      }
      // Return skills/modules even when GitHub is unavailable
      res.json({ groups: [], globalSkills, globalModules, ghMissing, reposPath: reposRoot })
    }
  })

  // --- Clone a repo ---
  router.post('/api/clone', (req, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const { owner, name } = req.body as { owner?: string; name?: string }
    if (!owner || !name) {
      res.status(400).json({ error: 'Missing owner or name' })
      return
    }

    // Sanitize: must start with a word character, no leading dots, and reject
    // reserved names like '.git'. The regex requires a letter or digit first,
    // followed by word chars, hyphens, or dots (but not leading dot).
    const validName = /^[a-zA-Z0-9][\w.-]*$/
    if (!validName.test(owner) || !validName.test(name) ||
        owner.toLowerCase() === '.git' || name.toLowerCase() === '.git') {
      res.status(400).json({ error: 'Invalid owner or repo name' })
      return
    }
    if (owner.includes('..') || name.includes('..')) {
      res.status(400).json({ error: 'Invalid owner or repo name' })
      return
    }
    if (owner.length > 100 || name.length > 100) {
      res.status(400).json({ error: 'Owner or repo name too long' })
      return
    }

    const reposRoot = realpathSync(resolveReposRoot())
    const dest = join(reposRoot, name)
    // Boundary check: ensure resolved dest stays within REPOS_ROOT
    // Use realpathSync on reposRoot to prevent symlink bypass
    const resolvedDest = resolve(dest)
    if (!resolvedDest.startsWith(reposRoot + sep) && resolvedDest !== reposRoot) {
      res.status(400).json({ error: 'Path escapes allowed root' })
      return
    }
    if (existsSync(dest)) {
      res.json({ success: true, path: dest })
      return
    }

    console.log(`Cloning ${owner}/${name} into ${dest}...`)
    execFileAsync('gh', ['repo', 'clone', `${owner}/${name}`, dest], { timeout: 120000 })
      .then(() => {
        console.log(`Cloned ${owner}/${name}`)
        res.json({ success: true, path: dest })
      })
      .catch((err: Error) => {
        console.error(`Clone failed for ${owner}/${name}:`, err)
        res.status(500).json({ error: `Clone failed: ${err.message}` })
      })
  })

  return router
}
