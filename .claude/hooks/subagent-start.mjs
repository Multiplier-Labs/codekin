#!/usr/bin/env node
// Hook 7: SubagentStart — Convention Injection
// Injects project conventions into subagent context.
import { createHook } from './lib/handler.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CONVENTIONS_FILE = '.claude/conventions.md';

// Compact conventions for injection (keep under 500 chars)
const DEFAULT_CONVENTIONS = [
  'TypeScript strict mode for server code.',
  'Frontend: React + TailwindCSS 4 utility classes, custom theme in src/index.css.',
  'Fonts: Inconsolata (mono), Lato (sans).',
  'Use fenced code blocks in all output.',
  'ESM modules (.mjs) throughout.',
  'Prefer editing existing files over creating new ones.',
].join(' ');

createHook({
  handler: async (input) => {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
    const convPath = join(projectDir, CONVENTIONS_FILE);

    let conventions = DEFAULT_CONVENTIONS;
    if (existsSync(convPath)) {
      conventions = readFileSync(convPath, 'utf8').trim().slice(0, 800);
    }

    // Agent-type-specific additions
    let extra = '';
    switch (input.agent_type) {
      case 'Explore':
        extra = ' Key dirs: src/components/, src/hooks/, server/.';
        break;
      case 'Bash':
        extra = ' Never use sudo. Never run rm -rf on project root.';
        break;
      case 'Plan':
        extra = ' Architecture: React+Vite frontend, Node+ws server on :32352, nginx proxy.';
        break;
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: `Project conventions: ${conventions}${extra}`,
      },
    };
  },
});
