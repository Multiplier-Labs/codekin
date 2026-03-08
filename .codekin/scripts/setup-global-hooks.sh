#!/bin/bash
# Sets up global ~/.claude/settings.json with absolute paths to codekin hooks.
# This makes the approval UI work for sessions opened in ANY repo, not just codekin.
# Also removes duplicate hooks from the local settings.local.json to avoid double-prompts.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK_DIR="$REPO_ROOT/.claude/hooks"
GLOBAL_SETTINGS="$HOME/.claude/settings.json"
LOCAL_SETTINGS="$REPO_ROOT/.claude/settings.local.json"

echo "==> Writing global settings to $GLOBAL_SETTINGS"
cat > "$GLOBAL_SETTINGS" << ENDJSON
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node $HOOK_DIR/pre-tool-use.mjs",
            "timeout": 65
          }
        ]
      },
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "node $HOOK_DIR/pre-tool-use.mjs",
            "timeout": 65
          }
        ]
      },
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "node $HOOK_DIR/pre-tool-use.mjs",
            "timeout": 65
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node $HOOK_DIR/permission-request.mjs",
            "timeout": 65
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node $HOOK_DIR/user-prompt-submit.mjs",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "node $HOOK_DIR/session-start.mjs",
            "timeout": 10
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node $HOOK_DIR/subagent-start.mjs",
            "timeout": 5
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node $HOOK_DIR/notification.mjs",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node $HOOK_DIR/post-tool-use-failure.mjs",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
ENDJSON
echo "    Done."

echo "==> Updating local settings $LOCAL_SETTINGS (removing duplicate hooks)"
cat > "$LOCAL_SETTINGS" << ENDJSON
{
  "permissions": {
    "allow": [
      "Bash(npx tsc --noEmit 2>&1 | head -50)",
      "WebSearch",
      "Bash(env -u CLAUDECODE claude --version 2>&1)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node \"\$CLAUDE_PROJECT_DIR\"/.claude/hooks/post-tool-use.mjs",
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"\$CLAUDE_PROJECT_DIR\"/.claude/hooks/stop.mjs",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
ENDJSON
echo "    Done."

echo ""
echo "Setup complete! New sessions in any repo will now show approval prompts in the UI."
echo "Note: commit the updated .claude/settings.local.json to the codekin repo."
