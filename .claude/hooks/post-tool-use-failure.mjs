#!/usr/bin/env node
// Hook 6: PostToolUseFailure — Error Recovery
// Analyzes Bash failures and injects corrective context.
import { createHook } from './lib/handler.mjs';

const ERROR_PATTERNS = [
  {
    match: /command not found|ENOENT.*spawn/i,
    advice: (cmd) =>
      `"${cmd}" is not in PATH. Check if the tool is installed, or use the full path.`,
  },
  {
    match: /ENOSPC/i,
    advice: () => 'Disk space is low. Clean up temp files or build artifacts before retrying.',
  },
  {
    match: /EACCES|permission denied/i,
    advice: () =>
      'Permission denied. Check file ownership. Do NOT use sudo — find the root cause.',
  },
  {
    match: /ECONNREFUSED/i,
    advice: () =>
      'Connection refused. The target service may not be running. Check if the server needs to be started.',
  },
  {
    match: /merge conflict|CONFLICT/i,
    advice: () =>
      'Git conflict detected. List conflicting files with `git diff --name-only --diff-filter=U` and resolve each one.',
  },
  {
    match: /npm ERR! test/i,
    advice: () =>
      'Test failure. Run failing tests individually with `npm test -- --testNamePattern="<name>"` to isolate.',
  },
  {
    match: /error TS\d+/i,
    advice: () =>
      'TypeScript compilation errors. Fix them in dependency order — start with type definition files, then implementations.',
  },
];

createHook({
  handler: async (input) => {
    if (input.is_interrupt) return;

    const error = input.error || '';
    const command = input.tool_input?.command || '';
    const combined = `${command} ${error}`;

    for (const { match, advice } of ERROR_PATTERNS) {
      if (match.test(combined)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolUseFailure',
            additionalContext: advice(command),
          },
        };
      }
    }
    // No pattern matched — let Claude handle it naturally
  },
});
