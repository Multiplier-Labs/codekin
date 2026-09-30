/**
 * Environment for spawned harness CLIs (Claude, OpenCode, Codex, Grok).
 *
 * Passes through the full parent environment so each CLI inherits XDG paths,
 * TERM, SHELL, and anything else it needs, minus two classes of variables:
 *
 * - API keys the server itself may hold (ANTHROPIC_API_KEY, …). Stale or
 *   incorrect keys override a CLI's own subscription/OAuth login and cause
 *   "Invalid API key" errors, so each CLI uses its own auth instead.
 * - GIT_* variables (except GIT_EDITOR) inherited from the shell that
 *   launched the server. GIT_INDEX_FILE=.git/index in particular breaks
 *   worktrees, where .git is a file rather than a directory.
 *
 * `extraEnv` (session-scoped tokens, CODEKIN_SESSION_ID, …) is applied last.
 */

const STRIPPED_KEYS = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_API_KEY', 'AUTH_TOKEN', 'AUTH_TOKEN_FILE'])

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
