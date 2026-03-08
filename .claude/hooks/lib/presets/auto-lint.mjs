/**
 * auto-lint preset — PostToolUse handler.
 *
 * After Edit/Write, runs ESLint on the changed file.
 * Returns blocking feedback on errors, non-blocking on warnings.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const LINTABLE = /\.(ts|tsx|js|jsx|mjs)$/;

export function autoLint({ fix = false } = {}) {
  return async (input) => {
    const filePath = input.tool_input?.file_path;
    if (!filePath || !LINTABLE.test(filePath)) return;

    // Use project-local eslint to avoid npx auto-install latency.
    const eslintBin = join(input.cwd, 'node_modules', '.bin', 'eslint');

    try {
      const args = ['--no-warn-ignored', '--format', 'json'];
      if (fix) args.push('--fix');
      args.push(filePath);
      execFileSync(eslintBin, args, {
        cwd: input.cwd, encoding: 'utf8', timeout: 15000,
      });
      // Exit 0 from eslint = no errors
    } catch (err) {
      // eslint exits non-zero when errors found; JSON is in err.stdout
      let results;
      try {
        results = JSON.parse(err.stdout || '[]');
      } catch {
        // ESLint itself failed (missing dep, bad config, non-JSON output)
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: `ESLint failed to run on ${filePath}: ${(err.message || 'unknown error').slice(0, 200)}. Check eslint config and dependencies.`,
          },
        };
      }

      const file = results[0];
      if (!file?.messages?.length) return;

      const errors = file.messages.filter((m) => m.severity === 2);
      const warnings = file.messages.filter((m) => m.severity === 1);

      const format = (msgs) =>
        msgs.map((m) => `  Line ${m.line}: ${m.message} (${m.ruleId})`).join('\n');

      if (errors.length > 0) {
        return {
          decision: 'block',
          reason: `ESLint errors in ${filePath}:\n${format(errors)}\nFix these before continuing.`,
        };
      }

      if (warnings.length > 0) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: `ESLint warnings in ${filePath}:\n${format(warnings)}`,
          },
        };
      }
    }
  };
}
