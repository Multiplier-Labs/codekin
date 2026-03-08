#!/usr/bin/env node
// Hook 4: UserPromptSubmit — Context Injection
// Injects git state and project info before each prompt.
import { createHook } from './lib/handler.mjs';
import { GitContext } from './lib/context/git.mjs';
import { ProjectContext } from './lib/context/project.mjs';

createHook({
  context: [new GitContext(), new ProjectContext()],
  handler: async (input, ctx) => {
    const parts = [];

    if (ctx.git?.branch) {
      parts.push(`Branch: ${ctx.git.branch}`);
    }
    if (ctx.git?.dirty && typeof ctx.git.status === 'string') {
      // Compact: just filenames, not full status
      const files = ctx.git.status.split('\n').map((l) => l.trim()).slice(0, 10);
      parts.push(`Dirty: ${files.join(', ')}`);
    }

    if (parts.length === 0) return;

    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `[Context] ${parts.join(' | ')}`,
      },
    };
  },
});
