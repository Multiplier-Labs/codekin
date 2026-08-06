/**
 * File upload, repo listing, and clone REST routes.
 *
 * Previously a standalone Express server (upload-server.mjs, port 32353).
 * Now merged into the main server process.
 */

import { Router } from 'express'
import type { Request } from 'express'
import multer from 'multer'
import { mkdirSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, unlinkSync } from 'fs'
import { join, extname, sep } from 'path'
import { fileTypeFromFile } from 'file-type'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { homedir } from 'os'
import { parse as parseYaml } from 'yaml'
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

export function parseMdWithFrontmatter(content: string): FrontmatterMeta & { body: string } {
  // Frontmatter must open on the first line; otherwise the whole file is body.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { name: '', description: '', body: content.trim() }
  }
  const [, rawFrontmatter, rawBody] = match
  const meta: FrontmatterMeta = { name: '', description: '' }

  try {
    const parsed: unknown = parseYaml(rawFrontmatter)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      if (obj.name != null) meta.name = String(obj.name).trim()
      if (obj.description != null) meta.description = String(obj.description).trim()
    }
  } catch (err) {
    // Malformed YAML — fall back to simple key:value line parsing so a single
    // bad line doesn't blank out the whole skill's metadata.
    console.warn(`[skills] Malformed YAML frontmatter, falling back to line parsing: ${err instanceof Error ? err.message : err}`)
    for (const line of rawFrontmatter.split('\n')) {
      const kv = line.match(/^(\w+):\s*(.+)/)
      if (kv) {
        if (kv[1] === 'name') meta.name = kv[2].trim()
        if (kv[1] === 'description') meta.description = kv[2].trim()
      }
    }
  }

  return { ...meta, body: rawBody.trim() }
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

// Timeout for gh CLI calls. Network/API issues should surface as a 504-style
// error rather than a hung request.
const GH_TIMEOUT_MS = 15_000

/** True if an execFile error was caused by the timeout option killing the child. */
function isExecTimeout(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true
}

/**
 * Local on-disk path for a repo, namespaced by owner to prevent collisions
 * between ownerA/foo and ownerB/foo.
 */
export function localRepoPath(reposRoot: string, owner: string, name: string): string {
  return join(reposRoot, owner, name)
}

async function fetchGhRepos(owner: string, reposRoot: string) {
  const { stdout } = await execFileAsync('gh', [
    'repo', 'list', owner,
    '--json', 'name,url,description',
    '--limit', '100',
  ], { env: ghEnv, timeout: GH_TIMEOUT_MS })
  const parsed: unknown = JSON.parse(stdout)
  const repos = parsed as Array<{ name: string; url: string; description?: string }>
  repos.sort((a, b) => a.name.localeCompare(b.name))
  return repos.map((r) => {
    const repoPath = localRepoPath(reposRoot, owner, r.name)
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
  /** Allowed extension → the MIME type(s) it may be declared as. Checking the
   *  two against each other (rather than against independent allowlists) closes
   *  the gap where a `.png` declared as `text/markdown` passed both lists and
   *  then skipped the magic-byte check below, which only covers binary MIMEs. */
  const EXTENSION_MIME_TYPES: Record<string, string[]> = {
    '.png': ['image/png'],
    '.jpg': ['image/jpeg'],
    '.jpeg': ['image/jpeg'],
    '.gif': ['image/gif'],
    '.webp': ['image/webp'],
    '.md': ['text/markdown'],
  }
  /** Binary MIME types that have detectable file signatures (magic bytes). */
  const BINARY_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase()
      const allowedMimes = EXTENSION_MIME_TYPES[ext]
      if (!allowedMimes) {
        cb(new Error(`File type not allowed: ${file.mimetype}`))
        return
      }
      if (!allowedMimes.includes(file.mimetype)) {
        cb(new Error(`File type mismatch: ${ext} declared as ${file.mimetype}`))
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
    upload.single('file')(req, res, (err: unknown) => {
      if (err) {
        const isMulterLimit = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        const status = isMulterLimit ? 413 : 400
        const message = err instanceof Error ? err.message : 'Upload failed'
        res.status(status).json({ error: message })
        return
      }
      next()
    })
  }, async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' })
      return
    }
    const filePath = join(SCREENSHOTS_DIR, req.file.filename)

    // Magic-byte validation for binary types — prevents polyglot/disguised files
    if (BINARY_MIME_TYPES.has(req.file.mimetype)) {
      try {
        const detected = await fileTypeFromFile(filePath)
        if (!detected || detected.mime !== req.file.mimetype) {
          unlinkSync(filePath)
          const actual = detected ? detected.mime : 'unknown'
          res.status(400).json({
            error: `File signature mismatch: claimed ${req.file.mimetype} but detected ${actual}`,
          })
          return
        }
      } catch {
        unlinkSync(filePath)
        res.status(400).json({ error: 'Failed to verify file signature' })
        return
      }
    }

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
      const { stdout: userJson } = await execFileAsync('gh', ['api', 'user', '--jq', '.login'], { env: ghEnv, timeout: GH_TIMEOUT_MS })
      const username = userJson.trim()

      const groups: Array<{ owner: string; repos: Awaited<ReturnType<typeof fetchGhRepos>> }> = []

      // Fetch org repos — use configured GH_ORG or auto-detect from gh CLI
      let orgs = GH_ORGS
      if (orgs.length === 0) {
        try {
          const { stdout: orgsJson } = await execFileAsync('gh', ['api', 'user/orgs', '--jq', '.[].login'], { env: ghEnv, timeout: GH_TIMEOUT_MS })
          orgs = orgsJson.trim().split('\n').filter(Boolean)
        } catch {
          // Auto-detection failed (incl. timeout) — continue without org repos
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
        // Return skills/modules even when gh is unavailable
        res.json({ groups: [], globalSkills, globalModules, ghMissing, reposPath: reposRoot })
        return
      }
      if (isExecTimeout(err)) {
        // Surface upstream slowness as 504 so the client can retry/back off
        // instead of seeing skills+modules with no repos and assuming success.
        res.status(504).json({ error: 'GitHub CLI timed out', globalSkills, globalModules, reposPath: reposRoot })
        return
      }
      res.json({ groups: [], globalSkills, globalModules, ghMissing, reposPath: reposRoot })
    }
  })

  // --- Clone a repo ---
  router.post('/api/clone', (req: Request<Record<string, string>, unknown, { owner?: string; name?: string }>, res) => {
    const token = extractToken(req)
    if (!verifyToken(token)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const { owner, name } = req.body
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

    let reposRoot: string
    try {
      reposRoot = realpathSync(resolveReposRoot())
    } catch (err) {
      console.error('Failed to resolve repos root:', err)
      res.status(500).json({ error: 'invalid_repos_root' })
      return
    }
    const ownerDir = join(reposRoot, owner)
    const dest = localRepoPath(reposRoot, owner, name)
    // C1: Prevent symlink-based path escape. lstat the owner dir to reject
    // symlinks; then canonicalize with realpathSync before the boundary check.
    // Lexical resolve() does not follow symlinks and cannot catch this class of escape.
    let resolvedDest: string
    if (existsSync(ownerDir)) {
      let ownerStat
      try {
        ownerStat = lstatSync(ownerDir)
      } catch {
        res.status(400).json({ error: 'Path escapes allowed root' })
        return
      }
      if (ownerStat.isSymbolicLink()) {
        res.status(400).json({ error: 'Path escapes allowed root' })
        return
      }
      let canonicalOwner: string
      try {
        canonicalOwner = realpathSync(ownerDir)
      } catch {
        res.status(400).json({ error: 'Path escapes allowed root' })
        return
      }
      resolvedDest = join(canonicalOwner, name)
    } else {
      // ownerDir does not exist; reposRoot is already canonical so this is safe.
      resolvedDest = join(reposRoot, owner, name)
    }
    if (!resolvedDest.startsWith(reposRoot + sep) && resolvedDest !== reposRoot) {
      res.status(400).json({ error: 'Path escapes allowed root' })
      return
    }
    if (existsSync(dest)) {
      res.json({ success: true, path: dest })
      return
    }
    // Ensure the owner-namespaced parent directory exists — git clone does not
    // create missing parents.
    mkdirSync(ownerDir, { recursive: true })

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
