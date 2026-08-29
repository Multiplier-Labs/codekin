#!/usr/bin/env node
/**
 * Codekin CLI
 *
 * Usage:
 *   codekin start                  Run server in foreground
 *   codekin stop                   Stop the running background service
 *   codekin setup                  First-time setup wizard
 *   codekin service install        Install + start background service
 *   codekin service uninstall      Remove background service
 *   codekin service status         Show service status
 *   codekin config                  Update settings
 *   codekin token                  Print access URL with auth token
 *   codekin relay <cmd>            Hosted relay pairing + connector
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
// Relay (hosted control plane pairing + connector)
// ---------------------------------------------------------------------------

const RELAY_CREDENTIAL_FILE = join(CONFIG_DIR, 'relay.json')
const DEFAULT_RELAY_URL = 'https://app.codekin.ai'

function readRelayCredential() {
  if (!existsSync(RELAY_CREDENTIAL_FILE)) return null
  try {
    const parsed = JSON.parse(readFileSync(RELAY_CREDENTIAL_FILE, 'utf-8'))
    if (parsed && parsed.url && parsed.machineId && parsed.machineSecret) return parsed
    return null
  } catch {
    return null
  }
}

function findConnectorScript() {
  const compiled = join(PACKAGE_ROOT, 'server', 'dist', 'relay', 'connector-cli.js')
  if (existsSync(compiled)) return { script: compiled, runner: process.execPath }
  const ts = join(PACKAGE_ROOT, 'server', 'relay', 'connector-cli.ts')
  if (existsSync(ts)) return { script: ts, runner: 'tsx' }
  throw new Error('Connector script not found. Run npm run build in server/ first.')
}

async function cmdRelayLogin(args) {
  const urlFlag = args.indexOf('--url')
  const relayUrl = (urlFlag !== -1 && args[urlFlag + 1] ? args[urlFlag + 1] : DEFAULT_RELAY_URL).replace(/\/$/, '')
  const codeFlag = args.indexOf('--code')
  const pairingToken = codeFlag !== -1 ? args[codeFlag + 1] : null

  const existing = readRelayCredential()
  if (existing) {
    console.log(`Already paired with ${existing.url} (machine ${existing.machineId}).`)
    console.log('Run `codekin relay logout` first to pair again.')
    process.exit(1)
  }

  // Browser-first pairing: a token minted in the hosted UI claims directly —
  // no verification URL, no polling.
  if (pairingToken) {
    let res
    try {
      res = await fetch(`${relayUrl}/api/machines/pair/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceCode: pairingToken,
          hostname: execSync('hostname').toString().trim(),
          platform: platform(),
        }),
      })
    } catch (err) {
      console.error(`Could not reach the relay at ${relayUrl}: ${err.message}`)
      process.exit(1)
    }
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.status === 'complete') {
      ensureConfigDir()
      writeFileSync(
        RELAY_CREDENTIAL_FILE,
        JSON.stringify({ url: relayUrl, machineId: data.machineId, machineSecret: data.machineSecret }, null, 2) + '\n',
      )
      chmodSync(RELAY_CREDENTIAL_FILE, 0o600)
      console.log(`Paired. Machine id: ${data.machineId}`)
      console.log('Run `codekin relay connect` to bring this machine online.')
      return
    }
    if (data.status === 'expired') {
      console.error('Pairing token expired — generate a fresh install command in the hosted UI.')
    } else {
      console.error(`Pairing failed (${data.status || res.status}). Generate a fresh install command in the hosted UI.`)
    }
    process.exit(1)
  }

  let start
  try {
    const res = await fetch(`${relayUrl}/api/machines/pair/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname: execSync('hostname').toString().trim(), platform: platform() }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    start = await res.json()
  } catch (err) {
    console.error(`Could not reach the relay at ${relayUrl}: ${err.message}`)
    process.exit(1)
  }

  console.log('\nTo pair this machine, open:\n')
  console.log(`    ${start.verificationUrl}\n`)
  console.log(`and confirm the code: ${start.userCode}\n`)
  console.log('Waiting for approval (Ctrl-C to cancel)...')

  const pollMs = start.pollIntervalMs || 3000
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs))
    let res
    try {
      res = await fetch(`${relayUrl}/api/machines/pair/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      })
    } catch {
      continue // transient network error — keep polling until expiry
    }
    if (res.status === 202) continue
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.status === 'complete') {
      ensureConfigDir()
      writeFileSync(
        RELAY_CREDENTIAL_FILE,
        JSON.stringify({ url: relayUrl, machineId: data.machineId, machineSecret: data.machineSecret }, null, 2) + '\n',
      )
      chmodSync(RELAY_CREDENTIAL_FILE, 0o600)
      console.log(`\nPaired. Machine id: ${data.machineId}`)
      console.log('Run `codekin relay connect` to bring this machine online.')
      return
    }
    if (data.status === 'denied') {
      console.error('\nPairing was denied in the hosted UI.')
      process.exit(1)
    }
    if (data.status === 'expired') {
      console.error('\nPairing request expired. Run `codekin relay login` again.')
      process.exit(1)
    }
    console.error(`\nPairing failed (${data.status || res.status}).`)
    process.exit(1)
  }
}

function cmdRelayConnect() {
  const credential = readRelayCredential()
  if (!credential) {
    console.error('Not paired. Run `codekin relay login` first.')
    process.exit(1)
  }
  const { script, runner } = findConnectorScript()
  console.log(`Connecting to ${credential.url} as machine ${credential.machineId}...`)
  const result = spawnSync(runner, [script], {
    env: { ...process.env, ...readEnvFile() },
    stdio: 'inherit',
  })
  process.exit(result.status ?? 0)
}

async function cmdRelayStatus() {
  const credential = readRelayCredential()
  if (!credential) {
    console.log('Not paired. Run `codekin relay login` to pair this machine.')
    return
  }
  console.log(`Relay:      ${credential.url}`)
  console.log(`Machine id: ${credential.machineId}`)
  try {
    const res = await fetch(`${credential.url}/api/health`)
    const data = await res.json()
    console.log(`Hub health: ${data.ok ? 'ok' : 'unhealthy'} (${data.machinesOnline ?? 0} machine(s) online)`)
  } catch {
    console.log('Hub health: unreachable')
  }
}

function cmdRelayLogout() {
  if (!existsSync(RELAY_CREDENTIAL_FILE)) {
    console.log('Not paired; nothing to remove.')
    return
  }
  rmSync(RELAY_CREDENTIAL_FILE)
  console.log('Removed local pairing credential.')
  console.log('To fully revoke this machine, also remove it in the hosted UI (Machines page).')
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

  console.log('\nSession auto-naming uses the Claude CLI — no extra API keys needed.')

  // Write env file
  const frontendDist = findFrontendDist()
  const envVars = {
    ...existing,
    AUTH_TOKEN_FILE: TOKEN_FILE,
  }
  if (frontendDist) envVars.FRONTEND_DIST = frontendDist
  writeEnvFile(envVars)

  console.log(`\nConfig saved to ${CONFIG_DIR}`)

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
\t<!--
\t  KeepAlive as a dict (not <true/>) so a clean exit (e.g. \`codekin stop\`,
\t  which sends SIGTERM and triggers gracefulShutdown → exit(0)) is NOT
\t  respawned. Only crashes (non-zero exit) trigger restart, preserving
\t  the daemon UX without making the process unkillable.
\t-->
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
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
  rmSync(LAUNCHD_PLIST, { force: true })
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
# on-failure (not always) so \`codekin stop\` / \`systemctl --user stop\` exits
# cleanly without an immediate respawn. Crashes still get restarted.
Restart=on-failure
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
  rmSync(SYSTEMD_SERVICE_FILE, { force: true })
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
// Stop (cross-platform)
// ---------------------------------------------------------------------------

function cmdStop() {
  const os = platform()
  if (os === 'darwin') {
    if (!existsSync(LAUNCHD_PLIST)) {
      console.log('Codekin background service is not installed.')
      console.log('If a foreground server is running, switch to its terminal and press Ctrl+C.')
      return
    }
    const result = spawnSync('launchctl', ['unload', LAUNCHD_PLIST], { stdio: 'inherit' })
    if (result.status === 0) {
      // launchctl unload (no -w) takes the agent out of the current session's
      // launchd job list. The plist file stays in ~/Library/LaunchAgents/, so
      // loginwindow loads it again at next user login (which fires RunAtLoad).
      // The user has to take an explicit action to opt out of that.
      console.log('Codekin service stopped (launchctl unload).')
      console.log('Notes:')
      console.log('  - Plist file is still at ' + LAUNCHD_PLIST + '.')
      console.log('  - It will reload automatically at next user login (RunAtLoad re-fires).')
      console.log('  - To resume now without waiting:     launchctl load ' + LAUNCHD_PLIST)
      console.log('  - To stop permanently (no auto-load): codekin service uninstall')
    } else {
      console.error('Failed to stop launchd service.')
      process.exit(1)
    }
  } else if (os === 'linux') {
    if (!existsSync(SYSTEMD_SERVICE_FILE)) {
      console.log('Codekin background service is not installed.')
      console.log('If a foreground server is running, switch to its terminal and press Ctrl+C.')
      return
    }
    const result = spawnSync('systemctl', ['--user', 'stop', 'codekin'], { stdio: 'pipe', encoding: 'utf-8' })
    if (result.status === 0) {
      console.log('Codekin service stopped. The unit remains installed —')
      console.log('  - to start it again:     systemctl --user start codekin')
      console.log('  - to remove permanently: codekin service uninstall')
    } else {
      const msg = (result.stderr || '').trim()
      if (msg) console.error(msg)
      process.exit(1)
    }
  } else {
    console.error(`Service stop is not supported on ${os}. Press Ctrl+C in the foreground server's terminal.`)
    process.exit(1)
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
} else if (cmd === 'stop') {
  cmdStop()
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
} else if (cmd === 'relay') {
  const action = args[1]
  if (action === 'login') {
    await cmdRelayLogin(args.slice(2))
  } else if (action === 'connect') {
    cmdRelayConnect()
  } else if (action === 'status') {
    await cmdRelayStatus()
  } else if (action === 'logout') {
    cmdRelayLogout()
  } else {
    console.error('Usage: codekin relay <login|connect|status|logout> [--url <relay-url>] [--code <pairing-token>]')
    process.exit(1)
  }
} else {
  console.log(`Codekin - Web UI for Claude Code

Usage:
  codekin start                   Run server in foreground
  codekin stop                    Stop the running background service
  codekin setup                   First-time setup wizard
  codekin setup --regenerate      Regenerate auth token
  codekin config                  Update settings
  codekin service install         Install + start background service
  codekin service uninstall       Remove background service
  codekin service status          Show service status
  codekin token                   Print access URL with auth token
  codekin relay login             Pair this machine with hosted Codekin
  codekin relay connect           Run the relay connector (foreground)
  codekin relay status            Show pairing + hub status
  codekin relay logout            Remove the local pairing credential
  codekin upgrade                 Upgrade to latest version
  codekin uninstall               Remove Codekin entirely
`)
}
