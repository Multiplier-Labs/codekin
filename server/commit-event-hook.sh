#!/bin/sh
# Codekin post-commit hook — fires a commit event to the Codekin server.
# Installed/managed by commit-event-hooks.ts; do not edit the section
# between BEGIN/END CODEKIN markers manually.
#
# Client-side fast filters avoid unnecessary HTTP calls:
#   1. Skip if branch = codekin/reports
#   2. Skip if message starts with a workflow commit prefix
#
# Fire-and-forget: never blocks `git commit`.

CONFIG_FILE="$HOME/.codekin/hook-config.json"

# Bail silently if no config
if [ ! -f "$CONFIG_FILE" ]; then
  exit 0
fi

# Read server URL and auth token from config
# Uses simple grep+sed to avoid jq dependency
SERVER_URL=$(grep '"serverUrl"' "$CONFIG_FILE" | sed 's/.*"serverUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
AUTH_TOKEN=$(grep '"authToken"' "$CONFIG_FILE" | sed 's/.*"authToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

if [ -z "$SERVER_URL" ] || [ -z "$AUTH_TOKEN" ]; then
  exit 0
fi

# Gather commit info
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
COMMIT_HASH=$(git rev-parse HEAD 2>/dev/null)
COMMIT_MESSAGE=$(git log -1 --format="%s" 2>/dev/null)
AUTHOR=$(git log -1 --format="%an" 2>/dev/null)
REPO_PATH=$(git rev-parse --show-toplevel 2>/dev/null)

# Client-side filter 1: skip reports branch
if [ "$BRANCH" = "codekin/reports" ]; then
  exit 0
fi

# Client-side filter 2: skip workflow-generated commits
case "$COMMIT_MESSAGE" in
  "chore: commit review"*|"chore: code review"*)
    exit 0
    ;;
esac

# Build JSON payload safely using jq to prevent injection via crafted values
if command -v jq >/dev/null 2>&1; then
  PAYLOAD=$(jq -n \
    --arg repoPath "$REPO_PATH" \
    --arg branch "$BRANCH" \
    --arg commitHash "$COMMIT_HASH" \
    --arg commitMessage "$COMMIT_MESSAGE" \
    --arg author "$AUTHOR" \
    '{repoPath: $repoPath, branch: $branch, commitHash: $commitHash, commitMessage: $commitMessage, author: $author}')
else
  # Fallback: escape each variable individually for safe JSON embedding
  json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$(printf '\t')/\\t/g" -e "s/$(printf '\r')//g"
  }
  PAYLOAD="{\"repoPath\":\"$(json_escape "$REPO_PATH")\",\"branch\":\"$(json_escape "$BRANCH")\",\"commitHash\":\"$(json_escape "$COMMIT_HASH")\",\"commitMessage\":\"$(json_escape "$COMMIT_MESSAGE")\",\"author\":\"$(json_escape "$AUTHOR")\"}"
fi

# Fire-and-forget POST to the server (5s timeout, backgrounded)
curl -s -o /dev/null -m 5 \
  -X POST "${SERVER_URL}/api/workflows/commit-event" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -d "$PAYLOAD" \
  &

exit 0
