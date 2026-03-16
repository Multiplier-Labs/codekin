#!/usr/bin/env node
/**
 * Codekin CLI
 *
 * Usage:
 *   codekin start                  Run server in foreground
 *   codekin setup                  First-time setup wizard
 *   codekin service install        Install + start background service
 *   codekin service uninstall      Remove background service
 *   codekin service status         Show service status
 *   codekin config                  Update API keys and settings
 *   codekin token                  Print access URL with auth token
 *   codekin upgrade                Upgrade to latest version
 *   codekin uninstall              Remove Codekin entirely
 */

import { execSync, execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, createReadStream, rmSync } from 'fs'
import { homedir, platform } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'
import { createInterface } from 'readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(__dirname, '..')
const CONFIG_DIR = join(homedir(), '.config', 'codekin')
const TOKEN_FILE = join(CONFIG_DIR, 'token')
const ENV_FILE = join(CONFIG_DIR, 'env')
const DEFAULT_PORT = 32352

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureConfigDir() {
  mkdirSync(CONFIG_DIR, { recursive: true })
}

function readToken() {
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf-8').trim()
  return null
}

function readEnvFile() {
  if (!existsSync(ENV_FILE)) return {}
  const vars = {}
  for (const line of readFileSync(ENV_FILE, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return vars
}

function writeEnvFile(vars) {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`)
  writeFileSync(ENV_FILE, lines.join('\n') + '\n')
}

function getPort() {
  const env = readEnvFile()
  return parseInt(env.PORT || String(DEFAULT_PORT), 10)
}

function openTtyInput() {
  // When piped (curl | bash), stdin is not a TTY — open /dev/tty directly
  if (process.stdin.isTTY) return { input: process.stdin, cleanup: null }
  try {
    const tty = createReadStream('/dev/tty', { encoding: 'utf-8' })
    return { input: tty, cleanup: () => tty.destroy() }
  } catch {
    // No TTY available (CI, headless) — fall back to stdin
    return { input: process.stdin, cleanup: null }
  }
}

function prompt(question) {
  const { input, cleanup } = openTtyInput()
  const rl = createInterface({ input, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      if (cleanup) cleanup()
      resolve(answer.trim())
    })
    // If input closes without an answer (non-interactive), resolve empty
    rl.on('close', () => resolve(''))
  })
}

function printAccessUrl() {
  const token = readToken()
  const port = getPort()
  if (token) {
    console.log(`\nCodekin is running at: http://localhost:${port}?token=${token}\n`)
  } else {
    console.log(`\nCodekin is running at: http://localhost:${port}\n`)
  }
}

function findServerScript() {
  // Prefer pre-compiled JS, fall back to tsx for dev
  const compiled = join(PACKAGE_ROOT, 'server', 'dist', 'ws-server.js')
  if (existsSync(compiled)) return { script: compiled, runner: process.execPath }
  const ts = join(PACKAGE_ROOT, 'server', 'ws-server.ts')
  if (existsSync(ts)) return { script: ts, runner: 'tsx' }
  throw new Error('Server script not found. Run npm run build first.')
}

function findFrontendDist() {
  const dist = join(PACKAGE_ROOT, 'dist')
  if (existsSync(dist)) return dist
  return null
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdSetup({ regenerate = false } = {}) {
  ensureConfigDir()

  console.log('\n-- Codekin Setup --\n')

  const existing = readEnvFile()

  // Auth token
  const existingToken = readToken()
  if (existingToken && !regenerate) {
    console.log('Auth token: (already exists, use --regenerate to replace)')
  } else {
    const token = randomBytes(16).toString('base64url')
    writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 })
    console.log('Auth token: generated')
  }

  // API keys for session auto-naming
  console.log('\nSession auto-naming uses an LLM to generate descriptive session names.')
  console.log('Configure at least one API key below (all optional, press Enter to skip).\n')

  const apiKeys = [
    { env: 'GROQ_API_KEY',      label: 'Groq',      hint: 'free tier available — groq.com' },
    { env: 'OPENAI_API_KEY',    label: 'OpenAI',     hint: 'platform.openai.com' },
    { env: 'GEMINI_API_KEY',    label: 'Gemini',     hint: 'aistudio.google.com' },
    { env: 'ANTHROPIC_API_KEY', label: 'Anthropic',  hint: 'console.anthropic.com' },
  ]

  for (const { env, label, hint } of apiKeys) {
    const current = existing[env]
    const mask = current ? ` (current: ${current.slice(0, 6)}...${current.slice(-4)})` : ''
    const answer = await prompt(`  ${label} API key${mask} [${hint}]: `)
    if (answer) {
      existing[env] = answer
    }
  }



  // Write env file
  const frontendDist = findFrontendDist()
  const envVars = {
    ...existing,
    AUTH_TOKEN_FILE: TOKEN_FILE,
  }
  if (frontendDist) envVars.FRONTEND_DIST = frontendDist
  writeEnvFile(envVars)

  // Show which naming provider will be used
  const namingProvider = apiKeys.find(k => envVars[k.env])
  if (namingProvider) {
    console.log(`\nSession naming provider: ${namingProvider.label}`)
  } else {
    console.log('\nNo API keys configured — session auto-naming will be disabled.')
  }

  console.log(`Config saved to ${CONFIG_DIR}`)

  printAccessUrl()
}

function cmdToken() {
  const token = readToken()
  if (!token) {
    console.error('No token found. Run: codekin setup')
    process.exit(1)
  }
  printAccessUrl()
}

function cmdStart() {
  const { script, runner } = findServerScript()
  const frontendDist = findFrontendDist()
  const env = {
    ...process.env,
    ...readEnvFile(),
  }
  if (frontendDist && !env.FRONTEND_DIST) env.FRONTEND_DIST = frontendDist

  console.log(`Starting Codekin server (${script})...`)
  printAccessUrl()

  const result = spawnSync(runner, [script], {
    env,
    stdio: 'inherit',
  })
  process.exit(result.status ?? 0)
}

// ---------------------------------------------------------------------------
// Service: macOS (launchd)
// ---------------------------------------------------------------------------

const LAUNCHD_LABEL = 'ai.codekin'
const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)

function buildPlist() {
  const { script, runner } = findServerScript()
  const envVars = readEnvFile()
  // Inject PATH and HOME so launchd service can find gh, node, etc.
  if (!envVars.PATH && process.env.PATH) envVars.PATH = process.env.PATH
  if (!envVars.HOME) envVars.HOME = homedir()
  const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const envEntries = Object.entries(envVars)
    .map(([k, v]) => `\t\t<key>${escXml(k)}</key>\n\t\t<string>${escXml(v)}</string>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCHD_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${runner}</string>
\t\t<string>${script}</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${envEntries}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${join(homedir(), '.codekin', 'server.log')}</string>
\t<key>StandardErrorPath</key>
\t<string>${join(homedir(), '.codekin', 'server.log')}</string>
</dict>
</plist>
`
}

function serviceInstallMac() {
  mkdirSync(dirname(LAUNCHD_PLIST), { recursive: true })
  mkdirSync(join(homedir(), '.codekin'), { recursive: true })

  // Unload existing if present
  if (existsSync(LAUNCHD_PLIST)) {
    spawnSync('launchctl', ['unload', LAUNCHD_PLIST], { stdio: 'inherit' })
  }

  writeFileSync(LAUNCHD_PLIST, buildPlist())
  const result = spawnSync('launchctl', ['load', LAUNCHD_PLIST], { stdio: 'inherit' })
  if (result.status === 0) {
    console.log('Codekin service installed and started.')
    printAccessUrl()
  } else {
    console.error('Failed to load launchd service.')
    process.exit(1)
  }
}

function serviceUninstallMac() {
  if (!existsSync(LAUNCHD_PLIST)) {
    console.log('Service not installed.')
    return
  }
  spawnSync('launchctl', ['unload', LAUNCHD_PLIST], { stdio: 'inherit' })
  import('fs').then(fs => fs.unlinkSync(LAUNCHD_PLIST))
  console.log('Codekin service removed.')
}

function serviceStatusMac() {
  const result = spawnSync('launchctl', ['list', LAUNCHD_LABEL], { encoding: 'utf-8' })
  if (result.status === 0) {
    console.log('Codekin service is running.')
    printAccessUrl()
  } else {
    console.log('Codekin service is not running.')
  }
}

// ---------------------------------------------------------------------------
// Service: Linux (systemd --user)
// ---------------------------------------------------------------------------

const SYSTEMD_SERVICE_DIR = join(homedir(), '.config', 'systemd', 'user')
const SYSTEMD_SERVICE_FILE = join(SYSTEMD_SERVICE_DIR, 'codekin.service')

function buildSystemdUnit() {
  const { script, runner } = findServerScript()
  return `[Unit]
Description=Codekin - Web UI for Claude Code
After=network.target

[Service]
Type=simple
ExecStart=${runner} ${script}
EnvironmentFile=${ENV_FILE}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
}

function serviceInstallLinux() {
  mkdirSync(SYSTEMD_SERVICE_DIR, { recursive: true })
  mkdirSync(join(homedir(), '.codekin'), { recursive: true })

  writeFileSync(SYSTEMD_SERVICE_FILE, buildSystemdUnit())

  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
  const result = spawnSync('systemctl', ['--user', 'enable', '--now', 'codekin'], { stdio: 'inherit' })

  // Enable linger so service survives logout (best-effort)
  spawnSync('loginctl', ['enable-linger', process.env.USER || ''], { stdio: 'pipe' })

  if (result.status === 0) {
    console.log('Codekin service installed and started.')
    printAccessUrl()
  } else {
    console.error('Failed to start systemd service. Check: journalctl --user -u codekin')
    process.exit(1)
  }
}

function serviceUninstallLinux() {
  spawnSync('systemctl', ['--user', 'disable', '--now', 'codekin'], { stdio: 'inherit' })
  if (existsSync(SYSTEMD_SERVICE_FILE)) {
    import('fs').then(fs => fs.unlinkSync(SYSTEMD_SERVICE_FILE))
  }
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
  console.log('Codekin service removed.')
}

function serviceStatusLinux() {
  const result = spawnSync('systemctl', ['--user', 'is-active', 'codekin'], { encoding: 'utf-8' })
  const active = result.stdout.trim() === 'active'
  if (active) {
    console.log('Codekin service is running.')
    printAccessUrl()
  } else {
    console.log('Codekin service is not running.')
  }
}

// ---------------------------------------------------------------------------
// Service dispatch
// ---------------------------------------------------------------------------

function serviceDispatch(action) {
  const os = platform()
  if (os === 'darwin') {
    if (action === 'install') serviceInstallMac()
    else if (action === 'uninstall') serviceUninstallMac()
    else if (action === 'status') serviceStatusMac()
  } else if (os === 'linux') {
    if (action === 'install') serviceInstallLinux()
    else if (action === 'uninstall') serviceUninstallLinux()
    else if (action === 'status') serviceStatusLinux()
  } else {
    console.error(`Service management is not supported on ${os}. Use 'codekin start' for foreground mode.`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

async function cmdUninstall() {
  const answer = await prompt('This will remove Codekin entirely (service, config, npm package). Continue? [y/N] ')
  if (answer.toLowerCase() !== 'y') {
    console.log('Aborted.')
    return
  }

  // 1. Stop and remove background service
  console.log('\nRemoving background service...')
  try {
    serviceDispatch('uninstall')
  } catch {
    // Service may not be installed — that's fine
  }

  // 2. Remove config directories
  const configDir = CONFIG_DIR
  const codekinDir = join(homedir(), '.codekin')

  if (existsSync(configDir)) {
    rmSync(configDir, { recursive: true, force: true })
    console.log(`Removed ${configDir}`)
  }
  if (existsSync(codekinDir)) {
    rmSync(codekinDir, { recursive: true, force: true })
    console.log(`Removed ${codekinDir}`)
  }

  // 3. Uninstall npm package
  console.log('\nUninstalling codekin npm package...')
  spawnSync('npm', ['uninstall', '-g', 'codekin'], { stdio: 'inherit' })

  console.log('\nCodekin has been completely removed.')
}

async function cmdUpgrade() {
  // Read current version
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'))
  const current = pkg.version

  // Check latest version on npm
  console.log('Checking for updates...')
  let latest
  try {
    latest = execSync('npm view codekin version', { encoding: 'utf-8' }).trim()
  } catch {
    console.error('Failed to check npm registry. Check your network connection.')
    process.exit(1)
  }

  if (latest === current) {
    console.log(`Already on the latest version (v${current}).`)
    return
  }

  console.log(`Current: v${current}`)
  console.log(`Latest:  v${latest}\n`)
  console.log('Upgrading...')

  const result = spawnSync('npm', ['install', '-g', 'codekin'], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('\nUpgrade failed. Try running with sudo or check npm permissions.')
    process.exit(1)
  }

  // Restart service if running
  try {
    const status = execSync('codekin service status', { encoding: 'utf-8' })
    if (status.includes('running')) {
      console.log('\nRestarting background service...')
      spawnSync('codekin', ['service', 'install'], { stdio: 'inherit' })
    }
  } catch {
    // Service not installed — skip
  }

  console.log(`\nUpgraded to v${latest}.`)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const cmd = args[0]

if (cmd === 'start') {
  cmdStart()
} else if (cmd === 'setup') {
  await cmdSetup({ regenerate: args.includes('--regenerate') })
} else if (cmd === 'config') {
  await cmdSetup()
} else if (cmd === 'token') {
  cmdToken()
} else if (cmd === 'upgrade') {
  await cmdUpgrade()
} else if (cmd === 'uninstall') {
  await cmdUninstall()
} else if (cmd === 'service') {
  const action = args[1]
  if (!['install', 'uninstall', 'status'].includes(action)) {
    console.error('Usage: codekin service <install|uninstall|status>')
    process.exit(1)
  }
  serviceDispatch(action)
} else {
  console.log(`Codekin - Web UI for Claude Code

Usage:
  codekin start                   Run server in foreground
  codekin setup                   First-time setup wizard
  codekin setup --regenerate      Regenerate auth token
  codekin config                  Update API keys and settings
  codekin service install         Install + start background service
  codekin service uninstall       Remove background service
  codekin service status          Show service status
  codekin token                   Print access URL with auth token
  codekin upgrade                 Upgrade to latest version
  codekin uninstall               Remove Codekin entirely
`)
}
