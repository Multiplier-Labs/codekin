#!/usr/bin/env bash
# Codekin installer
# curl -fsSL https://raw.githubusercontent.com/Multiplier-Labs/codekin/main/install.sh | bash
set -euo pipefail

CODEKIN_VERSION="${CODEKIN_VERSION:-latest}"
MIN_NODE_VERSION=20

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()    { printf '\033[0;34m[codekin]\033[0m %s\n' "$*"; }
success() { printf '\033[0;32m[codekin]\033[0m %s\n' "$*"; }
warn()    { printf '\033[0;33m[codekin]\033[0m %s\n' "$*" >&2; }
die()     { printf '\033[0;31m[codekin]\033[0m ERROR: %s\n' "$*" >&2; exit 1; }

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
# 2. Check Claude Code CLI
# ---------------------------------------------------------------------------

check_claude() {
  if ! command -v claude &>/dev/null; then
    warn "Claude Code CLI not found."
    info "Install it with: npm install -g @anthropic-ai/claude-code"
    info "Then run 'claude' once to authenticate, and re-run this installer."
    exit 1
  fi
  info "Claude Code CLI found ($(claude --version 2>/dev/null | head -1 || echo 'unknown version'))."
}

# ---------------------------------------------------------------------------
# 3. Install / upgrade codekin
# ---------------------------------------------------------------------------

install_codekin() {
  if [[ "$CODEKIN_VERSION" == "latest" ]]; then
    info "Installing codekin (latest)..."
    npm install -g codekin
  else
    info "Installing codekin@${CODEKIN_VERSION}..."
    npm install -g "codekin@${CODEKIN_VERSION}"
  fi
  success "codekin $(codekin --version 2>/dev/null || echo 'installed')."
}

# ---------------------------------------------------------------------------
# 4. First-time setup (idempotent)
# ---------------------------------------------------------------------------

run_setup() {
  mkdir -p "$HOME/.config/codekin"

  # Delegate to the CLI (token generation, env file write)
  # Redirect stdin from /dev/tty so interactive prompts work when piped (curl | bash)
  codekin setup </dev/tty
}

# ---------------------------------------------------------------------------
# 5. Install background service
# ---------------------------------------------------------------------------

install_service() {
  info "Installing background service..."
  codekin service install </dev/tty
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo ""
echo "  Codekin Installer"
echo "  ================="
echo ""

ensure_node
check_claude
install_codekin
run_setup
install_service

echo ""
success "Installation complete!"
info "Run 'codekin token' at any time to get your access URL."
info "Run 'codekin service status' to check the service."
echo ""
