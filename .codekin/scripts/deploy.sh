#!/usr/bin/env bash
# Deploy codekin: sync frontend to nginx root and restart the cc-web server.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Source API keys / env vars (not auto-sourced in non-interactive shells like git hooks).
# Set CODEKIN_ENV_FILE to point to your env/secrets file, or place it at ~/.codekin/env.
ENV_FILE="${CODEKIN_ENV_FILE:-$HOME/.codekin/env}"
if [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"
  echo "[deploy] Loaded env from $ENV_FILE" >&2
else
  echo "[deploy] WARNING: env file not found: $ENV_FILE (API keys may be missing)" >&2
fi

# Strip GITHUB_TOKEN so gh CLI uses the stored OAuth token (with repo scope)
# instead of an npm-scoped PAT that may lack visibility.
unset GITHUB_TOKEN

# Config: env vars with settings.json fallbacks (bare-metal compat)
SETTINGS="$REPO_ROOT/.codekin/settings.json"
_cfg() { node -e "const s=JSON.parse(require('fs').readFileSync('$SETTINGS','utf8')); process.stdout.write(String(s.deploy.$1))"; }
# Resolve relative paths (against REPO_ROOT) and expand ~ to $HOME
_resolve() {
  local p="$1"
  p="${p/#\~/$HOME}"
  [[ "$p" = /* ]] || p="$REPO_ROOT/$p"
  echo "$p"
}
DIST="$(_resolve "${FRONTEND_DIST:-$(_cfg distDir)}")"
WEB_ROOT="$(_resolve "${FRONTEND_WEB_ROOT:-$(_cfg webRoot)}")"
SERVER_DIR="$(_resolve "${SERVER_DIR:-$(_cfg serverDir)}")"
PORT="${PORT:-$(_cfg port)}"
LOG="$(_resolve "${LOG_FILE:-$(_cfg log)}")"

# Auth: prefer AUTH_TOKEN env var, fall back to token file
AUTH_FILE="$(_resolve "${AUTH_FILE:-$(_cfg authFile)}")"
if [ -n "${AUTH_TOKEN:-}" ]; then
  export AUTH_TOKEN
elif [ -f "$AUTH_FILE" ]; then
  export AUTH_TOKEN_FILE="$AUTH_FILE"
fi

# 1. Deploy frontend
if [ -d "$DIST" ]; then
  rsync -a --delete "$DIST/" "$WEB_ROOT/"
  echo "[deploy] Frontend synced to $WEB_ROOT"
else
  echo "[deploy] WARNING: $DIST not found, skipping frontend deploy"
fi

# 2. Compile server TypeScript to JS and sync to runtime dir
if npx tsc --project "$REPO_ROOT/server/tsconfig.json" 2>/dev/null; then
  echo "[deploy] Server TypeScript compiled to dist/"
else
  echo "[deploy] WARNING: tsc failed, falling back to tsx at runtime"
fi
rsync -a "$REPO_ROOT/server/" "$SERVER_DIR/"
echo "[deploy] Server code synced to $SERVER_DIR"

# 3. Restart cc-web server (single process: WebSocket + REST + uploads)
OLD_PID=$(lsof -ti :"$PORT" 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  kill "$OLD_PID" 2>/dev/null || true
  # Wait up to 15s for the port to be released (graceful shutdown persists
  # sessions, completes tasks, and kills Claude child processes)
  for i in $(seq 1 30); do
    if ! lsof -ti :"$PORT" &>/dev/null; then
      break
    fi
    sleep 0.5
  done
  # Force-kill if still hanging
  REMAINING=$(lsof -ti :"$PORT" 2>/dev/null || true)
  if [ -n "$REMAINING" ]; then
    echo "[deploy] Force-killing stubborn process on :$PORT"
    kill -9 "$REMAINING" 2>/dev/null || true
    sleep 1
  fi
fi

cd "$SERVER_DIR"
if [ -f "dist/ws-server.js" ]; then
  nohup node dist/ws-server.js --port "$PORT" --auth-file "$AUTH_FILE" > "$LOG" 2>&1 &
  echo "[deploy] cc-web server restarted with node (PID $!)"
else
  nohup npx tsx ws-server.ts --port "$PORT" --auth-file "$AUTH_FILE" > "$LOG" 2>&1 &
  echo "[deploy] cc-web server restarted with tsx (PID $!)"
fi
