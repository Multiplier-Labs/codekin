#!/usr/bin/env node
// Hook 2: Stop — Completion Enforcement
// Blocks stop if tests fail or changes are uncommitted.
import { createHook } from './lib/handler.mjs';
import { GitContext } from './lib/context/git.mjs';
import { ProjectContext } from './lib/context/project.mjs';
import { completionGate } from './lib/presets/completion-gate.mjs';

createHook({
  context: [new GitContext(), new ProjectContext()],
  handler: completionGate(),
});
