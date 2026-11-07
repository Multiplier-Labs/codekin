/**
 * Environment for spawned harness CLIs (Claude, OpenCode, Codex, Grok).
 *
 * Passes through the full parent environment so each CLI inherits XDG paths,
 * TERM, SHELL, and anything else it needs, minus three classes of variables:
 *
 * - API keys the server itself may hold (ANTHROPIC_API_KEY, …). Stale or
 *   incorrect keys override a CLI's own subscription/OAuth login and cause
 *   "Invalid API key" errors, so each CLI uses its own auth instead.
 * - GIT_* variables (except GIT_EDITOR) inherited from the shell that
 *   launched the server. GIT_INDEX_FILE=.git/index in particular breaks
 *   worktrees, where .git is a file rather than a directory.
 * - Variables a Claude Code session sets for its own child processes, present
 *   when the server was started from one (e.g. `pm2 restart` run by an agent).
 *   They name that session, its messaging socket and its CLI install, all of
 *   which go stale, and would make every session look like its child. User
 *   configuration such as CLAUDE_CODE_OAUTH_TOKEN passes through.
 *
 * `extraEnv` (session-scoped tokens, CODEKIN_SESSION_ID, …) is applied last.
 */

const STRIPPED_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_API_KEY', 'AUTH_TOKEN', 'AUTH_TOKEN_FILE',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PID', 'CLAUDE_EFFORT',
])

export function buildHarnessEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] != null &&
          !STRIPPED_KEYS.has(entry[0]) &&
          (!entry[0].startsWith('GIT_') || entry[0] === 'GIT_EDITOR')
      )
    ),
    ...extraEnv,
  }
}
