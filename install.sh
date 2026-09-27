#!/usr/bin/env bash
# Codekin installer
#
#   curl -fsSL https://codekin.ai/install.sh | bash
#
# Hosted setup (the command generated at app.codekin.ai pairs this machine in
# the same run; the token travels in the environment, not on the command line):
#
#   curl -fsSL https://codekin.ai/install.sh | CODEKIN_PAIR_TOKEN=<token> bash
#
# `bash -s -- --pair <token> [--relay <url>]` is still accepted for older
# generated commands.
set -euo pipefail

CODEKIN_VERSION="${CODEKIN_VERSION:-latest}"
MIN_NODE_VERSION=20
DEFAULT_RELAY_URL="https://app.codekin.ai"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()    { printf '\033[0;34m[codekin]\033[0m %s\n' "$*"; }
success() { printf '\033[0;32m[codekin]\033[0m %s\n' "$*"; }
warn()    { printf '\033[0;33m[codekin]\033[0m %s\n' "$*" >&2; }
die()     { printf '\033[0;31m[codekin]\033[0m ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Arguments. The pairing token is a short-lived bearer secret: prefer the
# CODEKIN_PAIR_TOKEN environment variable, which (unlike argv) does not show
# up in `ps`.
# ---------------------------------------------------------------------------

PAIR_TOKEN="${CODEKIN_PAIR_TOKEN:-}"
RELAY_URL="${CODEKIN_RELAY_URL:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --pair)  PAIR_TOKEN="${2:-}"; shift 2 || shift ;;
    --relay) RELAY_URL="${2:-}"; shift 2 || shift ;;
    *) shift ;;
  esac
done
# Keep the token out of every child process that does not need it
# (npm, codekin setup, the service unit).
unset CODEKIN_PAIR_TOKEN
RELAY_URL="${RELAY_URL:-$DEFAULT_RELAY_URL}"
RELAY_URL="${RELAY_URL%/}"

# Outcome of hosted pairing: none | paired | already | failed
PAIR_STATE="none"
PAIR_DETAIL=""

# ---------------------------------------------------------------------------
# 1. Check / install Node.js
# ---------------------------------------------------------------------------

node_version() {
  node -e "process.stdout.write(process.version.slice(1).split('.')[0])" 2>/dev/null || echo "0"
}

ensure_node() {
  if command -v node &>/dev/null && [[ $(node_version) -ge $MIN_NODE_VERSION ]]; then
    info "Node.js $(node --version) found."
    return
  fi

  info "Node.js >=${MIN_NODE_VERSION} not found. Installing via nvm..."

  # Install nvm if needed
  if ! command -v nvm &>/dev/null && [[ ! -f "$HOME/.nvm/nvm.sh" ]]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh | bash
  fi

  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh" 2>/dev/null || true
  nvm install --lts
  nvm use --lts

  command -v node &>/dev/null || die "Node.js installation failed. Install manually: https://nodejs.org"
  info "Node.js $(node --version) installed."
}

# ---------------------------------------------------------------------------
# 2. Check coding agents — any one supported CLI is enough.
#    Keep in sync with PROVIDERS in src/types.ts / server/harness-registry.ts.
# ---------------------------------------------------------------------------

check_agents() {
  local found=()
  local agent version
  for agent in claude codex opencode; do
    if command -v "$agent" &>/dev/null; then
      version="$("$agent" --version 2>/dev/null | head -1 || true)"
      found+=("$agent")
      info "Found coding agent: $agent${version:+ ($version)}"
    fi
  done

  if [ ${#found[@]} -eq 0 ]; then
    warn "No supported coding agent CLI found. Codekin needs at least one of:"
    info "  Claude Code:  npm install -g @anthropic-ai/claude-code   (then run 'claude' once to sign in)"
    info "  Codex:        npm install -g @openai/codex                (then run 'codex login')"
    info "  OpenCode:     see https://opencode.ai                     (then configure a provider)"
    info "Install one, sign in to it, and re-run this installer."
    exit 1
  fi

  local missing=()
  for agent in claude codex opencode; do
    [[ " ${found[*]} " == *" $agent "* ]] || missing+=("$agent")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    info "Optional agents not installed: ${missing[*]} (you can add them later)."
  fi
}

# ---------------------------------------------------------------------------
# 3. Hosted pairing — claimed early, before the slow steps, so a long npm
#    install cannot outlive the token. Runs without the codekin CLI (not
#    installed yet) and writes relay.json exactly as `codekin relay login`
#    does, with managed: true so the Codekin service runs the connector.
# ---------------------------------------------------------------------------

pair_early() {
  [ -n "$PAIR_TOKEN" ] || return 0
  info "Connecting this machine to Codekin at ${RELAY_URL}..."

  local output status=0
  # The token goes to node via the environment only — never argv.
  output="$(CODEKIN_PAIR_TOKEN="$PAIR_TOKEN" CODEKIN_RELAY_URL="$RELAY_URL" node --input-type=module -e '
import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "fs"
import { homedir, hostname, platform } from "os"
import { join } from "path"

const dir = join(homedir(), ".config", "codekin")
const file = join(dir, "relay.json")
const relayUrl = process.env.CODEKIN_RELAY_URL
const token = process.env.CODEKIN_PAIR_TOKEN

if (existsSync(file)) {
  try {
    const c = JSON.parse(readFileSync(file, "utf-8"))
    if (c && c.url && c.machineId && c.machineSecret) {
      console.log(`${c.url} (machine ${c.machineId})`)
      process.exit(3)
    }
  } catch {}
}

let res
try {
  res = await fetch(`${relayUrl}/api/machines/pair/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode: token, hostname: hostname(), platform: platform() }),
    signal: AbortSignal.timeout(20000),
  })
} catch (err) {
  console.log(`could not reach ${relayUrl} (${err.message})`)
  process.exit(1)
}
const data = await res.json().catch(() => ({}))
if (res.ok && data.status === "complete") {
  mkdirSync(dir, { recursive: true })
  const credential = { url: relayUrl, machineId: data.machineId, machineSecret: data.machineSecret, managed: true }
  writeFileSync(file, JSON.stringify(credential, null, 2) + "\n", { mode: 0o600 })
  chmodSync(file, 0o600)
  console.log(data.machineId)
  process.exit(0)
}
if (data.status === "expired") { console.log("the setup command expired"); process.exit(2) }
if (data.status === "not_found") { console.log("the setup command was already used or replaced"); process.exit(2) }
console.log(`the relay answered ${data.status || res.status}`)
process.exit(1)
' 2>&1)" || status=$?
  PAIR_TOKEN=""

  case "$status" in
    0)
      PAIR_STATE="paired"
      success "Machine paired (id ${output})."
      ;;
    3)
      PAIR_STATE="already"
      PAIR_DETAIL="$output"
      info "This machine is already paired with ${output} — keeping that pairing."
      ;;
    *)
      PAIR_STATE="failed"
      PAIR_DETAIL="$output"
      warn "Hosted pairing failed: ${output}. Continuing with the local installation."
      ;;
  esac
}

# ---------------------------------------------------------------------------
# 4. Check GitHub CLI auth
# ---------------------------------------------------------------------------

check_github() {
  if ! command -v gh &>/dev/null; then
    warn "GitHub CLI (gh) not found."
    info "The repo browser needs 'gh' to list and clone your repositories."
    info "Install it: https://cli.github.com"
    info "Then run: gh auth login"
    echo ""
    return
  fi

  if ! gh auth status &>/dev/null; then
    warn "GitHub CLI is not authenticated."
    info "The repo browser needs GitHub auth to list and clone your repositories."
    info "Run this after installation: gh auth login"
    echo ""
    return
  fi

  info "GitHub CLI authenticated ($(gh auth status 2>&1 | grep -o 'Logged in to [^ ]*' | head -1 || echo 'ok'))."
}

# ---------------------------------------------------------------------------
# 5. Install / upgrade codekin
# ---------------------------------------------------------------------------

install_codekin() {
  if [[ "$CODEKIN_VERSION" == "latest" ]]; then
    info "Installing codekin (latest)..."
    npm install -g codekin --loglevel=error
  else
    info "Installing codekin@${CODEKIN_VERSION}..."
    npm install -g "codekin@${CODEKIN_VERSION}" --loglevel=error
  fi
  success "codekin $(codekin --version 2>/dev/null || echo 'installed')."
}

# ---------------------------------------------------------------------------
# 6. First-time setup (idempotent)
# ---------------------------------------------------------------------------

run_setup() {
  mkdir -p "$HOME/.config/codekin"

  # Delegate to the CLI (token generation, env file write)
  # Redirect stdin from /dev/tty so interactive prompts work when piped (curl | bash)
  codekin setup </dev/tty
}

# ---------------------------------------------------------------------------
# 7. Install background service
# ---------------------------------------------------------------------------

install_service() {
  info "Installing background service..."
  codekin service install </dev/tty
}

# ---------------------------------------------------------------------------
# 8. Hosted connection check — ask the local service (GET /api/relay/status)
#    whether its embedded connector reached the relay. Prints one state word:
#    connected | connecting | disconnected | replaced | auth_failed |
#    unmanaged | disabled | unpaired | legacy (server predates the endpoint)
#    | unreachable. Detail, if any, follows a tab.
# ---------------------------------------------------------------------------

CONNECT_STATE=""
CONNECT_DETAIL=""

wait_for_online() {
  [ "$PAIR_STATE" = "paired" ] || [ "$PAIR_STATE" = "already" ] || return 0
  info "Waiting for this machine to come online (up to 30 seconds)..."

  local result
  result="$(node --input-type=module -e '
import { readFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"

const dir = join(homedir(), ".config", "codekin")
const env = {}
try {
  for (const line of readFileSync(join(dir, "env"), "utf-8").split("\n")) {
    const eq = line.indexOf("=")
    if (eq > 0 && !line.trim().startsWith("#")) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
} catch {}
let token = env.AUTH_TOKEN || ""
const tokenFile = env.AUTH_TOKEN_FILE || join(dir, "token")
if (!token && existsSync(tokenFile)) token = readFileSync(tokenFile, "utf-8").trim()
const port = parseInt(env.PORT || "32352", 10)

const deadline = Date.now() + 30000
let last = { state: "unreachable" }
while (Date.now() < deadline) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/relay/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    })
    if (res.status === 404) { last = { state: "legacy" }; break }
    if (res.ok) {
      last = await res.json()
      if (["connected", "replaced", "auth_failed", "unmanaged", "disabled"].includes(last.state)) break
    }
  } catch {}
  await new Promise(r => setTimeout(r, 2000))
}
process.stdout.write(`${last.state}\t${last.detail || ""}`)
' 2>/dev/null || printf 'unreachable\t')"
  CONNECT_STATE="${result%%$'\t'*}"
  CONNECT_DETAIL="${result#*$'\t'}"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

print_local_hints() {
  info "Local access (this computer only): run 'codekin token' for the URL."
  info "Service status: 'codekin service status'. Hosted connection: 'codekin relay status'."
}

print_summary() {
  echo ""
  if [ "$PAIR_STATE" = "none" ]; then
    success "Installation complete!"
    info "Run 'codekin token' at any time to get your access URL."
    info "Run 'codekin service status' to check the service."
    echo ""
    return
  fi

  if [ "$PAIR_STATE" = "failed" ]; then
    warn "Codekin is installed on this computer, but connecting it to Codekin in your browser FAILED:"
    warn "  ${PAIR_DETAIL}"
    warn "Generate a new setup command in Codekin (Settings → Machines), then run the"
    warn "'already installed' command it shows, e.g.:  CODEKIN_PAIR_TOKEN=<token> codekin relay login"
    echo ""
    print_local_hints
    echo ""
    return
  fi

  local detail=""
  [ -n "$CONNECT_DETAIL" ] && detail=" (${CONNECT_DETAIL})"
  case "$CONNECT_STATE" in
    connected)
      success "Your machine is online — return to Codekin in your browser."
      info "Keep this computer awake and connected to the internet while you use Codekin from the browser;"
      info "the Codekin service reconnects automatically after sleep, network changes and reboots."
      ;;
    legacy)
      warn "Paired, but the installed Codekin version does not run the hosted connector by itself yet."
      warn "Bring the machine online with:  codekin relay connect   (keep that terminal open)"
      ;;
    unmanaged)
      warn "This machine was paired earlier in unmanaged mode, so the service does not run the connector."
      warn "Keep using your own 'codekin relay connect', or re-pair: codekin relay logout, then run the"
      warn "setup command from Codekin in your browser again."
      ;;
    disabled)
      warn "Paired, but the hosted connector is disabled (CODEKIN_RELAY_CONNECTOR=off in the service env)."
      ;;
    replaced)
      warn "Paired, but another connector for this machine is already running${detail}."
      warn "Stop the other 'codekin relay connect' process, then restart the service."
      ;;
    auth_failed)
      warn "The relay rejected this machine's credential${detail} — it may have been removed in Codekin."
      warn "Run 'codekin relay logout', then generate a new setup command in Codekin (Settings → Machines)."
      ;;
    unreachable)
      warn "Paired, but the local Codekin service did not respond, so the machine is not online yet."
      warn "Check 'codekin service status' (logs: ~/.codekin/server.log or journalctl --user -u codekin)."
      ;;
    *)
      warn "Paired, but the machine has not reached Codekin yet (state: ${CONNECT_STATE:-unknown}${detail})."
      warn "The service keeps retrying in the background; check with 'codekin relay status'."
      ;;
  esac
  echo ""
  print_local_hints
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo ""
echo "  Codekin Installer"
echo "  ================="
echo ""

ensure_node
check_agents
pair_early
check_github
install_codekin
run_setup
install_service
wait_for_online
print_summary
