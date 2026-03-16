/**
 * completion-gate preset — Stop handler.
 *
 * Checks whether work is actually complete before allowing Claude to stop.
 * Verifies tests pass, build succeeds, and changes are committed.
 *
 * If node_modules is missing, installs dependencies first so that test/build
 * commands don't fail due to missing tooling (e.g. tsc). This avoids Claude
 * needing to run `yarn install` through the approval system.
 */
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const COMMIT_KEYWORDS = /\b(commit|push|deploy|ship|merge)\b/i;
const MAX_OUTPUT = 500;

/**
 * Detect the project's package manager by checking for lock files.
 * Returns the install command to use, or null if no package.json exists.
 */
function detectInstallCommand(cwd) {
  if (!existsSync(join(cwd, 'package.json'))) return null;
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn install --frozen-lockfile';
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile';
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun install --frozen-lockfile';
  return 'npm ci';
}

/**
 * Ensure node_modules exists. Runs the appropriate install command if missing.
 * Runs silently — install failures are not blocking (tests will catch the real issue).
 */
function ensureDepsInstalled(cwd) {
  if (existsSync(join(cwd, 'node_modules'))) return;
  const cmd = detectInstallCommand(cwd);
  if (!cmd) return;
  try {
    execSync(cmd, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120000,
      env: { ...process.env, CI: 'true' },
    });
  } catch {
    // Install failed — let tests/build surface the real error
  }
}

export function completionGate({ runTests = true, runBuild = false } = {}) {
  return async (input, ctx) => {
    // Primary guard: file-based sentinel prevents infinite loops.
    // When stop is blocked, sentinel is written. Next invocation sees it
    // and allows the stop, preventing infinite continuation.
    const sentinelPath = `/tmp/.claude-stop-guard-${input.session_id}`;
    if (existsSync(sentinelPath)) {
      unlinkSync(sentinelPath);
      return;
    }
    // Secondary guard: CLI-provided flag (may not exist in all versions)
    if (input.stop_hook_active) return;

    const reasons = [];

    // Check uncommitted changes when task implied a commit
    if (ctx.git?.dirty && COMMIT_KEYWORDS.test(input.last_assistant_message || '')) {
      reasons.push(
        `Uncommitted changes detected:\n${ctx.git.status}\nCommit and push before stopping.`
      );
    }

    // Ensure dependencies are installed before running tests/build
    if ((runTests && ctx.project?.hasTest) || (runBuild && ctx.project?.hasBuild)) {
      ensureDepsInstalled(input.cwd);
    }

    // Run tests
    if (runTests && ctx.project?.hasTest) {
      try {
        execSync('npm test', {
          cwd: input.cwd,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 60000,
          env: { ...process.env, CI: 'true' },
        });
      } catch (err) {
        const output = (err.stdout || err.message).slice(-MAX_OUTPUT);
        reasons.push(`Tests are failing:\n${output}`);
      }
    }

    // Run build
    if (runBuild && ctx.project?.hasBuild) {
      try {
        execSync('npm run build', {
          cwd: input.cwd,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 60000,
          env: { ...process.env, CI: 'true' },
        });
      } catch (err) {
        const output = (err.stdout || err.message).slice(-MAX_OUTPUT);
        reasons.push(`Build is broken:\n${output}`);
      }
    }

    if (reasons.length > 0) {
      // Write sentinel so next Stop invocation doesn't re-block
      writeFileSync(sentinelPath, Date.now().toString());
      return { decision: 'block', reason: reasons.join('\n\n') };
    }
  };
}
