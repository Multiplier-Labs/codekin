#!/bin/bash
# Sets up global ~/.claude/settings.json with absolute paths to codekin hooks.
# This makes the approval UI work for sessions opened in ANY repo, not just codekin.
# Also removes duplicate hooks from the local settings.local.json to avoid double-prompts.

set -e

HOOK_DIR="/srv/repos/codekin/.claude/hooks"
GLOBAL_SETTINGS="$HOME/.claude/settings.json"
LOCAL_SETTINGS="/srv/repos/codekin/.claude/settings.local.json"

echo "==> Writing global settings to $GLOBAL_SETTINGS"
cat > "$GLOBAL_SETTINGS" << 'ENDJSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node /srv/repos/codekin/.claude/hooks/pre-tool-use.mjs",
            "timeout": 65
          }
        ]
      },
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "node /srv/repos/codekin/.claude/hooks/pre-tool-use.mjs",
            "timeout": 65
          }
        ]
      },
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "node /srv/repos/codekin/.claude/hooks/pre-tool-use.mjs",
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
            "command": "node /srv/repos/codekin/.claude/hooks/permission-request.mjs",
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
            "command": "node /srv/repos/codekin/.claude/hooks/user-prompt-submit.mjs",
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
            "command": "node /srv/repos/codekin/.claude/hooks/session-start.mjs",
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
            "command": "node /srv/repos/codekin/.claude/hooks/subagent-start.mjs",
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
            "command": "node /srv/repos/codekin/.claude/hooks/notification.mjs",
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
            "command": "node /srv/repos/codekin/.claude/hooks/post-tool-use-failure.mjs",
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
cat > "$LOCAL_SETTINGS" << 'ENDJSON'
{
  "permissions": {
    "allow": [
      "Bash(grep -r \"xterm\" /srv/repos/codekin/src --include=\"*.ts\" --include=\"*.tsx\" --include=\"*.js\" --include=\"*.jsx\" 2>/dev/null | head -20)",
      "Bash(npx tsc --noEmit 2>&1 | head -50)",
      "Bash(npx vite build && sudo cp -r dist/* /var/www/codekin/ 2>&1)",
      "Bash(grep -rn \"className=\\\"[^\\\"]*\\s\\(bg-|text-|border-|shadow-|divide-|ring-\\)\" /srv/repos/codekin/src --include=\"*.tsx\" 2>/dev/null | grep -E \"\\(gray|red|green|blue|yellow|orange|purple|pink|indigo|teal|cyan|rose|violet|fuchsia|lime|emerald|sky|slate|zinc|stone|amber\\)-\\(50|100|200|300|400|500|600|700|800|900\\)\" | head -50)",
      "WebSearch",
      "Bash(find /home/dev/repos/codekin -type f \\( -name \"*.ts\" -o -name \"*.js\" -o -name \"*.mjs\" \\) ! -path \"*/node_modules/*\" 2>/dev/null | head -20)",
      "Bash(env -u CLAUDECODE claude --version 2>&1)",
      "Bash(timeout 35 node test-stream7.mjs 2>&1)",
      "Bash(timeout 40 node test-stream8.mjs 2>&1)",
      "Bash(timeout 40 node test-stream9.mjs 2>&1)",
      "Bash(timeout 30 node test-stream10.mjs 2>&1)",
      "Bash(timeout 35 node test-stream11.mjs 2>&1)",
      "Bash(timeout 35 node test-stream12.mjs 2>&1)",
      "Bash(timeout 25 node test-stream13.mjs 2>&1)",
      "Bash(timeout 35 node test-stream-final.mjs 2>&1)",
      "Bash(timeout 35 node test-multiturn.mjs 2>&1)",
      "Bash(cd /srv/repos/codekin/server && npm install 2>&1)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/post-tool-use.mjs",
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
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/stop.mjs",
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
