#!/usr/bin/env node
// Hook 5: SessionStart — Environment Bootstrap
// Sets env vars and injects project context on new session startup.
import { createHook } from './lib/handler.mjs';
import { GitContext } from './lib/context/git.mjs';
import { ProjectContext } from './lib/context/project.mjs';
import { writeFileSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';

// Clean up stale stop-guard sentinels from crashed sessions (>30min old)
try {
  const now = Date.now();
  const tmpFiles = readdirSync('/tmp').filter((f) => f.startsWith('.claude-stop-guard-'));
  for (const f of tmpFiles) {
    try {
      const content = parseInt(readFileSync(`/tmp/${f}`, 'utf8'), 10);
      if (now - content > 30 * 60 * 1000) unlinkSync(`/tmp/${f}`);
    } catch {
      // Stale file without valid timestamp — remove it
      try { unlinkSync(`/tmp/${f}`); } catch { /* ignore */ }
    }
  }
} catch { /* /tmp read failed — non-fatal */ }

createHook({
  context: [new GitContext(), new ProjectContext()],
  handler: async (input, ctx) => {
    // Persist env vars for subsequent Bash commands via CLAUDE_ENV_FILE.
    // KEY=VALUE format (no 'export' prefix).
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (envFile) {
      const sessionType = process.env.CODEKIN_SESSION_TYPE || 'manual';
      const lines = [
        `CODEKIN_SESSION_TYPE=${sessionType}`,
        `CODEKIN_SERVER=http://localhost:32352`,
      ];
      writeFileSync(envFile, lines.join('\n') + '\n');
    }

    // Build context summary
    const parts = [];
    const sessionType = process.env.CODEKIN_SESSION_TYPE || 'manual';
    parts.push(`Session type: ${sessionType}`);
    if (input.model) parts.push(`Model: ${input.model}`);

    if (ctx.git?.branch) {
      parts.push(`Branch: ${ctx.git.branch}`);
    }
    if (ctx.project?.name) {
      const scriptMap = [
        { name: 'build', key: 'hasBuild' },
        { name: 'test', key: 'hasTest' },
        { name: 'lint', key: 'hasLint' },
        { name: 'typecheck', key: 'hasTypecheck' },
        { name: 'dev', key: 'hasDev' },
      ];
      const scripts = scriptMap.filter((s) => ctx.project[s.key]).map((s) => s.name);
      if (scripts.length) parts.push(`Scripts: ${scripts.join(', ')}`);
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: parts.join(' | '),
      },
    };
  },
});
