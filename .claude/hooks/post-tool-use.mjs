#!/usr/bin/env node
// Hook 1: PostToolUse — Auto-Lint
// After Edit/Write, runs ESLint on the changed file.
import { createHook } from './lib/handler.mjs';
import { autoLint } from './lib/presets/auto-lint.mjs';

createHook({ handler: autoLint() });
