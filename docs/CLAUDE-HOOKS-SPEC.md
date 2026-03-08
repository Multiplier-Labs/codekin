# Claude Code Hooks — Specification

**Status**: All 8 hooks implemented and in production. Extraction plan is future work.
**Date**: 2026-02-25
**Author**: Codekin Team

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Goals](#goals)
- [Non-Goals](#non-goals)
- [Architecture Overview](#architecture-overview)
- [Module Structure](#module-structure)
- [Core Interfaces](#core-interfaces)
- [Hook Specifications](#hook-specifications)
  - [Hook 1: PostToolUse — Auto-Lint [Implemented]](#hook-1-posttooluse--auto-lint-implemented)
  - [Hook 2: Stop — Completion Enforcement [Implemented]](#hook-2-stop--completion-enforcement-implemented)
  - [Hook 3: PermissionRequest — Approval Simplification [Implemented]](#hook-3-permissionrequest--approval-simplification-implemented)
  - [Hook 4: UserPromptSubmit — Context Injection [Implemented]](#hook-4-userpromptsubmit--context-injection-implemented)
  - [Hook 5: SessionStart — Environment Bootstrap [Implemented]](#hook-5-sessionstart--environment-bootstrap-implemented)
  - [Hook 6: PostToolUseFailure — Error Recovery [Implemented]](#hook-6-posttoolusefailure--error-recovery-implemented)
  - [Hook 7: SubagentStart — Convention Injection [Implemented]](#hook-7-subagentstart--convention-injection-implemented)
  - [Hook 8: Notification — UI Forwarding [Implemented]](#hook-8-notification--ui-forwarding-implemented)
- [Settings Configuration](#settings-configuration)
- [Integration with Codekin](#integration-with-codekin)
- [Testing Strategy](#testing-strategy)
- [Extraction Plan [Future]](#extraction-plan-future)
- [Open Questions](#open-questions)

---

## Problem Statement

Claude Code sessions in Codekin lack automated feedback loops. When Claude writes code, there is no immediate signal about lint errors, type failures, or missing tests until a human notices. When Claude stops responding, there is no enforcement of completion criteria. The existing tool-approval infrastructure is custom-built around the stream-json protocol rather than using Claude Code's native hooks system, adding complexity without leveraging the CLI's built-in extension points.

---

## Goals

1. **Tight feedback loops** — Claude gets immediate lint/typecheck feedback after writing code, correcting issues in the same turn
2. **Completion enforcement** — Claude cannot stop until quality gates pass (tests, build, no uncommitted changes)
3. **Simplified approval** — Replace custom HTTP+WebSocket approval pipeline with native `PermissionRequest` hooks
4. **Richer context** — Inject git state, project info, and session awareness into every prompt automatically
5. **Modular architecture** — Structure hook infrastructure for later extraction as a standalone `@multiplier-labs/claude-hooks` package
6. **Zero runtime dependencies** — Hook scripts use only Node.js built-ins and child_process for external tools

---

## Non-Goals

- Replacing the existing stream-json protocol handling (hooks complement it, don't replace it)
- Building a hook management UI (use `/hooks` menu in Claude Code CLI)
- Supporting non-Node.js hook runtimes (no Bun, no Python)
- Implementing all 16 Claude Code hook events (start with 8, expand as needed)
- Persisting hook state across sessions (hooks are stateless per-invocation)

---

## Architecture Overview

Claude Code hooks are shell commands that run at specific lifecycle points. The CLI spawns a new process per hook invocation, passes JSON on stdin, and reads JSON from stdout. This constrains the architecture to short-lived scripts.

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code CLI (per-session process)                  │
│                                                         │
│  Events: PreToolUse, PostToolUse, Stop, etc.            │
│     │                                                   │
│     ▼                                                   │
│  Spawns hook process ──stdin──▶ .claude/hooks/X.mjs     │
│                       ◀─stdout──                        │
└─────────────────────────────────────────────────────────┘
                                        │
                                        │  imports
                                        ▼
                              ┌─────────────────────┐
                              │  .claude/hooks/lib/  │
                              │                      │
                              │  handler.mjs         │
                              │  transport/stdio.mjs │
                              │  context/git.mjs     │
                              │  context/env.mjs     │
                              │  presets/lint.mjs     │
                              │  presets/gate.mjs     │
                              └──────────┬──────────┘
                                         │
                                         │  HTTP (optional)
                                         ▼
                              ┌─────────────────────┐
                              │  Codekin Server   │
                              │  :32352              │
                              │                      │
                              │  /api/hook-decision  │
                              │  /api/hook-notify    │
                              └─────────────────────┘
```

**Key constraint**: Each hook invocation is a fresh process. There is no shared in-memory state between invocations. Hooks that need to communicate with the Codekin server (approval forwarding, notifications) use HTTP calls to `localhost:32352`.

---

## Module Structure

Designed for in-tree development now, package extraction later.

```
.claude/hooks/
├── lib/                          # extractable core (future @multiplier-labs/claude-hooks)
│   ├── types.mjs                 # all interfaces and type-like constants
│   ├── handler.mjs               # createHook() — the stdin→process→stdout loop
│   ├── transport/
│   │   ├── stdio.mjs             # default: read stdin JSON, write stdout JSON
│   │   └── http.mjs              # forward to a running server, return its response
│   ├── context/
│   │   ├── git.mjs               # branch, dirty, diff, recent commits
│   │   ├── env.mjs               # session type, env vars, permission mode
│   │   └── project.mjs           # package.json name, scripts, tsconfig presence
│   └── presets/
│       ├── auto-lint.mjs         # PostToolUse → eslint on changed file
│       └── completion-gate.mjs   # Stop → check tests/build/git status
│
├── post-tool-use.mjs             # entry point: Hook 1 (auto-lint)
├── stop.mjs                      # entry point: Hook 2 (completion gate)
├── permission-request.mjs        # entry point: Hook 3 (approval forwarding)
├── user-prompt-submit.mjs        # entry point: Hook 4 (context injection)
├── session-start.mjs             # entry point: Hook 5 (env bootstrap)
├── post-tool-use-failure.mjs     # entry point: Hook 6 (error recovery)
├── subagent-start.mjs            # entry point: Hook 7 (convention injection)
└── notification.mjs              # entry point: Hook 8 (UI forwarding)
```

**Entry points** are thin — typically 5-15 lines that wire up a transport, context providers, and a handler (preset or custom). All reusable logic lives in `lib/`.

---

## Core Interfaces

### HookInput

Every hook receives this base shape on stdin. Event-specific fields are merged in.

```javascript
// lib/types.mjs

/**
 * @typedef {'SessionStart'|'SessionEnd'|'UserPromptSubmit'|'PreToolUse'|'PostToolUse'
 *   |'PostToolUseFailure'|'PermissionRequest'|'Notification'|'SubagentStart'
 *   |'SubagentStop'|'Stop'|'TeammateIdle'|'TaskCompleted'|'ConfigChange'
 *   |'PreCompact'|'WorktreeCreate'|'WorktreeRemove'} HookEventName
 */

/**
 * @typedef {Object} HookInput
 * @property {string} session_id
 * @property {string} transcript_path
 * @property {string} cwd
 * @property {string} permission_mode
 * @property {HookEventName} hook_event_name
 * Additional event-specific fields are merged at the top level.
 */
```

### HookOutput

What hooks return via stdout (JSON on exit 0).

```javascript
/**
 * @typedef {Object} HookOutput
 * @property {boolean} [continue]         - false stops Claude entirely
 * @property {string}  [stopReason]       - shown to user when continue=false
 * @property {'block'} [decision]         - blocks the action (PostToolUse, Stop, etc.)
 * @property {string}  [reason]           - explanation when decision='block'
 * @property {boolean} [suppressOutput]   - hide stdout from verbose mode
 * @property {string}  [systemMessage]    - warning shown to user
 * @property {Object}  [hookSpecificOutput] - event-specific control fields
 */
```

### Per-Event Output Contracts

Each hook event uses a specific subset of `HookOutput` fields. The CLI reads different fields depending on the event:

| Event | Output Shape | Key Fields |
|---|---|---|
| `PostToolUse` | Top-level decision or hookSpecificOutput | `{ decision: 'block', reason }` on errors; `{ hookSpecificOutput: { additionalContext } }` for warnings; or no output |
| `Stop` | Top-level decision | `{ decision: 'block', reason }` to force continuation; or no output to allow stop |
| `PermissionRequest` | hookSpecificOutput only | `{ hookSpecificOutput: { hookEventName, decision: { behavior: 'allow'|'deny', message?, updatedPermissions? } } }` |
| `UserPromptSubmit` | hookSpecificOutput only | `{ hookSpecificOutput: { hookEventName, additionalContext } }` |
| `SessionStart` | hookSpecificOutput only | `{ hookSpecificOutput: { hookEventName, additionalContext } }` |
| `PostToolUseFailure` | hookSpecificOutput only | `{ hookSpecificOutput: { hookEventName, additionalContext } }` |
| `SubagentStart` | hookSpecificOutput only | `{ hookSpecificOutput: { hookEventName, additionalContext } }` |
| `Notification` | No output | Side-effect only (HTTP POST); no stdout |

> **Important**: Do not mix top-level `decision` fields with `hookSpecificOutput.decision` — they are separate protocols. Top-level `decision: 'block'` is used by PostToolUse and Stop to block/continue the action. `hookSpecificOutput.decision` is used exclusively by PermissionRequest with the `{ behavior, message, updatedPermissions }` shape.

> **MUST VERIFY**: The PermissionRequest output schema (`hookSpecificOutput.decision` with `{behavior, message, updatedPermissions}`) has NOT been validated against a live Claude Code CLI. Before implementing Hook 3, capture a real PermissionRequest stdin payload and test the hook stdout contract end-to-end. If the schema is wrong, the hook MUST fail closed (deny) rather than silently allowing. Implement schema validation: if the server response doesn't match the expected shape, return `{ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Hook schema validation failed — manual approval required' } } }`.

### HookTransport

Pluggable I/O adapter. Default is stdio (CLI mode). HTTP transport enables server integration.

```javascript
/**
 * @typedef {Object} HookTransport
 * @property {() => Promise<HookInput>} readInput
 * @property {(output: HookOutput) => void} writeOutput
 * @property {(message: string) => void} writeError
 */
```

### ContextProvider

Pluggable context gatherers. Each one contributes a keyed object to the handler context.

```javascript
/**
 * @typedef {Object} ContextProvider
 * @property {string} name                           - key in the context object
 * @property {(input: HookInput) => Promise<Object>} gather
 */
```

### createHook()

The core entry point — wires transport, context, and handler.

```javascript
// lib/handler.mjs

/**
 * @param {Object} options
 * @param {HookTransport} [options.transport]          - default: StdioTransport
 * @param {ContextProvider[]} [options.context]         - default: []
 * @param {(input: HookInput, ctx: Object) => Promise<HookOutput|void>} options.handler
 */
export async function createHook({ transport, context = [], handler }) {
  const io = transport ?? new StdioTransport();
  try {
    const input = await io.readInput();

    // Gather context from all providers in parallel
    const ctxEntries = await Promise.all(
      context.map(async (p) => [p.name, await p.gather(input)])
    );
    const ctx = Object.fromEntries(ctxEntries);

    const output = await handler(input, ctx);
    if (output) io.writeOutput(output);
  } catch (err) {
    io.writeError(err.message);
    process.exit(2);
  }
}
```

### StdioTransport

Default transport — reads JSON from stdin, writes JSON to stdout.

```javascript
// lib/transport/stdio.mjs

export class StdioTransport {
  async readInput() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
  }

  writeOutput(output) {
    process.stdout.write(JSON.stringify(output));
  }

  writeError(message) {
    process.stderr.write(message);
  }
}
```

### HttpTransport

For hooks that need to delegate decisions to the Codekin server.

```javascript
// lib/transport/http.mjs

export class HttpTransport {
  #stdio;

  /**
   * @param {Object} options
   * @param {string} options.url         - server endpoint (e.g. http://localhost:32352/api/hook-decision)
   * @param {string} [options.notifyUrl] - notification endpoint (defaults to origin of url + '/api/hook-notify')
   * @param {string} [options.authToken] - optional bearer token
   * @param {number} [options.timeout]   - ms, default 30000
   */
  constructor({ url, notifyUrl, authToken, timeout = 30000 }) {
    this.url = url;
    this.notifyUrl = notifyUrl || new URL('/api/hook-notify', new URL(url).origin).href;
    this.authToken = authToken;
    this.timeout = timeout;
    this.#stdio = new StdioTransport();
  }

  async readInput() {
    return this.#stdio.readInput();
  }

  writeOutput(output) {
    // Only write to stdout for the CLI — server communication uses
    // requestDecision() or notify() explicitly, never writeOutput.
    this.#stdio.writeOutput(output);
  }

  writeError(message) {
    this.#stdio.writeError(message);
  }

  /**
   * Round-trip RPC: send input to server, receive decision.
   * Used exclusively by PermissionRequest hook where server determines allow/deny.
   */
  async requestDecision(input) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw new Error(`Hook server returned ${res.status}`);
    return res.json();
  }

  /**
   * Fire-and-forget notification to server. Non-fatal on failure.
   * Used by Notification hook and other side-effect-only hooks.
   */
  async notify(data) {
    try {
      await fetch(this.notifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Non-fatal: server may be down
    }
  }
}
```

### Context Providers

> **Known limitation**: Context providers are declared `async` (to satisfy the `Promise.all` interface in `createHook`) but currently use synchronous I/O (`execSync`, `readFileSync`). This means `Promise.all` in `createHook` does not actually parallelize them — they run sequentially on the event loop. For v1 this is acceptable (total ~50ms), but on package extraction, consider switching to `execFile` and `readFile` async variants to enable true parallel context gathering.

```javascript
// lib/context/git.mjs
import { execSync } from 'node:child_process';

export class GitContext {
  name = 'git';

  async gather(input) {
    const opts = { cwd: input.cwd, encoding: 'utf8', timeout: 5000 };
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
      const status = execSync('git status --porcelain', opts).trim();
      const dirty = status.length > 0;
      return { branch, dirty, status: status || null };
    } catch {
      return { branch: null, dirty: false, status: null };
    }
  }
}


// lib/context/env.mjs

export class EnvContext {
  name = 'env';

  async gather(input) {
    return {
      sessionId: input.session_id,
      permissionMode: input.permission_mode,
      isRemote: process.env.CLAUDE_CODE_REMOTE === 'true',
      isWebhookSession: process.env.CODEKIN_SESSION_TYPE === 'webhook',
      projectDir: process.env.CLAUDE_PROJECT_DIR || input.cwd,
    };
  }
}


// lib/context/project.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class ProjectContext {
  name = 'project';

  async gather(input) {
    try {
      const pkgPath = join(input.cwd, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      return {
        name: pkg.name,
        hasLint: !!pkg.scripts?.lint,
        hasTest: !!pkg.scripts?.test,
        hasBuild: !!pkg.scripts?.build,
        hasTypecheck: !!pkg.scripts?.typecheck,
        hasDev: !!pkg.scripts?.dev,
      };
    } catch {
      return { name: null, hasLint: false, hasTest: false, hasBuild: false, hasTypecheck: false, hasDev: false };
    }
  }
}
```

---

## Hook Specifications

### Hook 1: PostToolUse — Auto-Lint [Implemented]

**Event**: `PostToolUse`
**Matcher**: `Edit|Write`
**Priority**: Highest — creates immediate quality feedback loop
**Blocking**: Yes on errors (`decision: 'block'`); warnings only use `additionalContext` (non-blocking)

#### Behavior

After every `Edit` or `Write` tool call, run ESLint on the changed file. If there are errors, feed them back to Claude as additional context so it can fix them in the same turn without an extra user prompt.

#### Input (from Claude Code)

```json
{
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/path/to/codekin/src/components/ChatView.tsx",
    "content": "..."
  },
  "tool_response": {
    "filePath": "/path/to/codekin/src/components/ChatView.tsx",
    "success": true
  }
}
```

#### Logic

```
1. Extract file_path from tool_input
2. Skip if file is not lintable (not .ts, .tsx, .js, .jsx, .mjs)
3. Run: ./node_modules/.bin/eslint --no-warn-ignored --format json <file_path>
4. Parse ESLint JSON output
5. If errors > 0:
   Return { decision: "block", reason: "<formatted errors>" }
6. If warnings only:
   Return { hookSpecificOutput: { additionalContext: "<formatted warnings>" } }
7. If clean:
   Return nothing (exit 0, no output)
```

#### Output Examples

**Errors found** (fed back to Claude as blocking feedback):

```json
{
  "decision": "block",
  "reason": "ESLint errors in ChatView.tsx:\n  Line 42: 'useState' is defined but never used (no-unused-vars)\n  Line 87: Missing return type on function (explicit-function-return-type)\nFix these before continuing."
}
```

**Clean** — no output, exit 0.

#### Entry Point

```javascript
#!/usr/bin/env node
// .claude/hooks/post-tool-use.mjs
import { createHook } from './lib/handler.mjs';
import { autoLint } from './lib/presets/auto-lint.mjs';

createHook({ handler: autoLint() });
```

#### Preset Implementation

```javascript
// lib/presets/auto-lint.mjs
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const LINTABLE = /\.(ts|tsx|js|jsx|mjs)$/;

export function autoLint({ fix = false } = {}) {
  return async (input) => {
    const filePath = input.tool_input?.file_path;
    if (!filePath || !LINTABLE.test(filePath)) return;

    // Use the project-local eslint binary directly to avoid npx auto-install.
    // npx would silently download eslint if missing, adding unbounded latency.
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
      // eslint exits non-zero when errors found; JSON output is in err.stdout,
      // diagnostic messages may also appear in err.stderr
      let results;
      try {
        results = JSON.parse(err.stdout || '[]');
      } catch {
        // ESLint itself failed (missing dep, bad config, non-JSON output).
        // Return non-blocking context rather than crashing the hook.
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
```

#### Performance

- ESLint startup: ~500ms cold, ~200ms warm (daemon)
- Runs after every Edit/Write — acceptable since Claude pauses for hook completion
- Timeout: 15 seconds (handles large files)

---

### Hook 2: Stop — Completion Enforcement [Implemented]

**Event**: `Stop`
**Matcher**: none (fires on every stop)
**Priority**: High — prevents incomplete work
**Blocking**: Yes (`decision: "block"` forces Claude to continue)

#### Behavior

When Claude finishes responding, check whether the work is actually complete. If tests fail, there are uncommitted changes (when the task implied a commit), or the build is broken, block the stop and tell Claude what remains.

#### Input (from Claude Code)

```json
{
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "I've completed the refactoring. Here's a summary..."
}
```

> **Assumptions to Verify**: The fields `stop_hook_active` and `last_assistant_message` are assumed based on Claude Code hook documentation. Before implementation, confirm these exact field names against the actual CLI Stop event schema. If `stop_hook_active` does not exist, use a file-based sentinel (e.g., `/tmp/.claude-stop-guard-<session_id>`) to prevent infinite loops. If `last_assistant_message` does not exist, skip commit-intent detection or parse the transcript file at `transcript_path` to extract the last message.

#### Logic

```
1. CRITICAL: If stop_hook_active is true (or sentinel file exists), return immediately (prevent infinite loops)
2. Read last_assistant_message to understand what Claude thinks it did (if available)
3. Check git status:
   - If dirty and message mentions "commit" or "deploy" → block
4. Run npm test (with timeout):
   - If tests fail → block with failure output
5. Run npm run build (with timeout):
   - If build fails → block with error output
6. If all pass → allow stop (exit 0, no output)
```

#### Output Examples

**Tests failing**:

```json
{
  "decision": "block",
  "reason": "Tests are failing. Fix before stopping:\n  FAIL src/hooks/useChatSocket.test.ts\n    Expected: 'connected'\n    Received: 'disconnected'"
}
```

**Uncommitted changes**:

```json
{
  "decision": "block",
  "reason": "You mentioned committing but there are uncommitted changes:\n  M src/components/ChatView.tsx\n  M src/hooks/useChatSocket.ts\nCommit and push before stopping."
}
```

#### Entry Point

```javascript
#!/usr/bin/env node
// .claude/hooks/stop.mjs
import { createHook } from './lib/handler.mjs';
import { GitContext } from './lib/context/git.mjs';
import { ProjectContext } from './lib/context/project.mjs';
import { completionGate } from './lib/presets/completion-gate.mjs';

createHook({
  context: [new GitContext(), new ProjectContext()],
  handler: completionGate(),
});
```

#### Preset Implementation

```javascript
// lib/presets/completion-gate.mjs
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';

const COMMIT_KEYWORDS = /\b(commit|push|deploy|ship|merge)\b/i;
const MAX_OUTPUT = 500; // chars of test/build output to include in reason

export function completionGate({ runTests = true, runBuild = false } = {}) {
  return async (input, ctx) => {
    // Primary guard: file-based sentinel (works regardless of CLI schema version)
    const sentinelPath = `/tmp/.claude-stop-guard-${input.session_id}`;
    if (existsSync(sentinelPath)) {
      unlinkSync(sentinelPath); // Clean up for next stop
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
      // Write sentinel so the next Stop invocation (after Claude addresses feedback)
      // does not re-block — prevents infinite continuation loops.
      writeFileSync(sentinelPath, Date.now().toString());
      return { decision: 'block', reason: reasons.join('\n\n') };
    }
  };
}
```

#### Edge Cases

- **Infinite loop prevention**: Primary mechanism is a file-based sentinel (`/tmp/.claude-stop-guard-<session_id>`). When the hook blocks a stop, it writes the sentinel; on the next invocation, the sentinel is detected and cleaned up, allowing the stop. Secondary: check `stop_hook_active` if the CLI provides it.
- **Test timeout**: Cap at 60s. If tests hang, let Claude stop rather than blocking forever.
- **No test script**: Skip test check if `package.json` has no `test` script.
- **Watch mode tests**: The hook sets `CI=true` in the environment to prevent interactive/watch mode hangs. Most test frameworks (Jest, Vitest) respect this and run in single-pass mode.

---

### Hook 3: PermissionRequest — Approval Simplification [Implemented]

**Event**: `PermissionRequest`
**Matcher**: `.*` (all tools)
**Priority**: High — reduces custom infrastructure
**Blocking**: Yes (decides allow/deny on behalf of user)

#### Behavior

Replace the custom HTTP+WebSocket approval pipeline. When Claude Code would show a permission dialog, this hook decides:

- **Webhook sessions**: Auto-allow after auth validation (headless, no human in the loop). Requires valid `CODEKIN_AUTH_TOKEN` that is verified against the server via `POST /api/auth/validate`. A mere presence check is insufficient — the token must be validated server-side to prevent auto-allow with arbitrary values. Without a valid token, all requests are denied. Consider restricting destructive tools (`Bash` with `rm`/`kill`) to an explicit allowlist in production.
- **Manual sessions with known tools**: Check the auto-approval registry, allow if listed
- **Manual sessions with unknown tools**: Forward to the Codekin server, which prompts the connected UI client and returns the decision

#### Input (from Claude Code)

```json
{
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf node_modules && npm install"
  },
  "permission_suggestions": [
    { "type": "toolAlwaysAllow", "tool": "Bash" }
  ]
}
```

#### Logic

```
1. Determine session type:
   - Check CODEKIN_SESSION_TYPE env var (set by SessionStart hook)
   - Or read from session metadata file
2. If webhook session:
   Validate CODEKIN_AUTH_TOKEN via POST /api/auth/validate
   If valid → return allow (auto-approve all tools in headless mode)
   If invalid or missing → return deny
3. POST to http://localhost:32352/api/hook-decision with input
   Server forwards to UI client, waits for response
   Return server's allow/deny decision
   If server returns updatedPermissions, include them in the response
   (Claude Code CLI handles permission persistence natively)
```

> **Future Enhancement**: A local auto-approval registry (`~/.codekin/hook-approvals.json`) could cache approved tools to avoid server round-trips for previously-approved actions. This is deferred — the server is the source of truth for approval decisions in v1.

#### Output Examples

**Auto-approved (webhook session)**:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
```

**Denied by user via UI**:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "User denied this action"
    }
  }
}
```

**Approved with "Always Allow" persisted**:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedPermissions": [
        { "type": "toolAlwaysAllow", "tool": "Write" }
      ]
    }
  }
}
```

#### Entry Point

```javascript
#!/usr/bin/env node
// .claude/hooks/permission-request.mjs
import { createHook } from './lib/handler.mjs';
import { EnvContext } from './lib/context/env.mjs';
import { HttpTransport } from './lib/transport/http.mjs';

const serverUrl = process.env.CODEKIN_HOOK_URL || 'http://localhost:32352/api/hook-decision';
const transport = new HttpTransport({ url: serverUrl, timeout: 65000 });

createHook({
  transport,
  context: [new EnvContext()],
  handler: async (input, ctx) => {
    // Webhook sessions: auto-allow after auth validation
    if (ctx.env.isWebhookSession) {
      const token = process.env.CODEKIN_AUTH_TOKEN;
      if (!token) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'deny', message: 'Webhook session missing auth token — denying' },
          },
        };
      }

      // Validate token against the server (not just presence check).
      // Without this, any non-empty CODEKIN_AUTH_TOKEN would auto-allow all tools.
      try {
        const serverUrl = process.env.CODEKIN_SERVER || 'http://localhost:32352';
        const res = await fetch(`${serverUrl}/api/auth/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ sessionId: ctx.env.sessionId }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: { behavior: 'deny', message: `Auth token validation failed (HTTP ${res.status}) — denying` },
            },
          };
        }
      } catch (err) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'deny', message: `Auth token validation error: ${err.message} — denying` },
          },
        };
      }

      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      };
    }

    // Forward to server, which prompts the UI client
    const decision = await transport.requestDecision({
      event: 'PermissionRequest',
      sessionId: ctx.env.sessionId,
      toolName: input.tool_name,
      toolInput: input.tool_input,
      permissionSuggestions: input.permission_suggestions,
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: decision.allow ? 'allow' : 'deny',
          ...(decision.message ? { message: decision.message } : {}),
          ...(decision.updatedPermissions ? { updatedPermissions: decision.updatedPermissions } : {}),
        },
      },
    };
  },
});
```

#### Server-Side Endpoint

Requires a new endpoint on the Codekin WebSocket server:

```
POST /api/hook-decision

Request:
{
  "event": "PermissionRequest",
  "sessionId": "abc123",
  "toolName": "Bash",
  "toolInput": { "command": "npm install" },
  "permissionSuggestions": [...]
}

Response:
{
  "allow": true,
  "always": false,
  "updatedPermissions": null,
  "message": null
}
```

This replaces the existing `POST /api/tool-approval` endpoint. The server-side logic (forward to UI client, wait for response, timeout handling) remains the same — it's the transport layer that changes.

#### Migration Path

1. Implement `PermissionRequest` hook alongside existing `control_request` handling
2. Verify both paths produce identical behavior
3. Remove old `control_request` handler and `/api/tool-approval` endpoint
4. Remove custom auto-approval registry code from `session-manager.ts` (native `updatedPermissions` replaces it)

---

### Hook 4: UserPromptSubmit — Context Injection [Implemented]

**Event**: `UserPromptSubmit`
**Matcher**: none (fires on every prompt)
**Priority**: Medium — improves quality of every response
**Blocking**: No (adds context only)

#### Behavior

Before Claude processes each user prompt, inject contextual information so Claude starts every turn with fresh situational awareness. This replaces the pattern of Claude running `git status` as its first tool call.

#### Input (from Claude Code)

```json
{
  "hook_event_name": "UserPromptSubmit",
  "prompt": "Fix the broken test in useChatSocket"
}
```

#### Logic

```
1. Gather git context: branch, dirty files, recent commits (last 3)
2. Gather project context: available scripts, current errors
3. Build additionalContext string with compact formatting
4. Return context (non-blocking, always allows the prompt)
```

#### Output

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "[Context] Branch: main | Dirty: M src/hooks/useChatSocket.ts, M src/hooks/useChatSocket.test.ts | Recent: a0291aa Fix 4 terminal component bugs, 84404c5 Add JSDoc module headers"
  }
}
```

#### Entry Point

```javascript
#!/usr/bin/env node
// .claude/hooks/user-prompt-submit.mjs
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

    if (parts.length === 0) return; // nothing to inject

    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `[Context] ${parts.join(' | ')}`,
      },
    };
  },
});
```

#### Performance

Must be fast — runs on every prompt submission. Target: <200ms.

- `git rev-parse` + `git status --porcelain`: ~50ms
- No eslint, no npm commands, no network calls
- If git is slow (large repo), gracefully degrade (return no context)

---

### Hook 5: SessionStart — Environment Bootstrap [Implemented]

**Event**: `SessionStart`
**Matcher**: `startup` (new sessions only, not resume/compact)
**Priority**: Medium — cleaner session initialization
**Blocking**: No (sets env vars and injects context)

#### Behavior

On new session startup, set environment variables that other hooks depend on and inject initial project context. This replaces ad-hoc env setup and gives Claude awareness of the project from the first message.

#### Input (from Claude Code)

```json
{
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-opus-4-6"
}
```

#### Logic

```
1. Detect session type from environment:
   - CODEKIN_SESSION_TYPE (set by ws-server when spawning Claude)
   - Fallback: check if running inside codekin server context
2. Write to CLAUDE_ENV_FILE:
   - CODEKIN_SESSION_TYPE=manual|webhook
   - CODEKIN_SERVER=http://localhost:32352
   - NODE_ENV (if not set)
3. Return additionalContext with project summary:
   - Available npm scripts
   - Git branch + last commit
   - Active session type
```

#### Output

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Session type: manual | Model: claude-opus-4-6 | Branch: main (a0291aa) | Scripts: build, test, test:watch, dev"
  }
}
```

#### Entry Point

```javascript
#!/usr/bin/env node
// .claude/hooks/session-start.mjs
import { createHook } from './lib/handler.mjs';
import { GitContext } from './lib/context/git.mjs';
import { ProjectContext } from './lib/context/project.mjs';
import { writeFileSync } from 'node:fs';

createHook({
  context: [new GitContext(), new ProjectContext()],
  handler: async (input, ctx) => {
    // Persist env vars for subsequent Bash commands.
    // CLAUDE_ENV_FILE expects KEY=VALUE format (no 'export' prefix).
    // Use writeFileSync for idempotency — avoids duplicate entries on session restart.
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
    parts.push(`Model: ${input.model}`);

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
```

#### Notes

- `CLAUDE_ENV_FILE` is only available in `SessionStart` hooks — this is the only place we can persist env vars.
- The `startup` matcher means this doesn't re-run on `/clear` or compaction — env vars persist.
- `CODEKIN_SESSION_TYPE` must be set by the ws-server when it spawns the Claude CLI process (via environment). The SessionStart hook reads and re-exports it to `CLAUDE_ENV_FILE` so Bash commands in the session can access it.

---

### Hook 6: PostToolUseFailure — Error Recovery [Implemented]

**Event**: `PostToolUseFailure`
**Matcher**: `Bash` (focus on command failures)
**Priority**: Medium — smarter failure handling
**Blocking**: No (provides additional context only)

#### Behavior

When a Bash command fails, analyze the error and inject corrective context so Claude doesn't flail or retry blindly. Map common error patterns to actionable suggestions.

#### Input (from Claude Code)

```json
{
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test",
    "description": "Run test suite"
  },
  "error": "Command exited with non-zero status code 1",
  "is_interrupt": false
}
```

#### Logic

```
1. If is_interrupt is true, skip (user canceled, not a real error)
2. Extract command and error text
3. Match against known error patterns:
   - "command not found"    → suggest install or path fix
   - "ENOSPC"              → disk space warning
   - "EACCES"              → permission issue
   - "ECONNREFUSED"        → service not running
   - npm test failures     → suggest running with --verbose
   - tsc errors            → extract first 5 errors, suggest fix order
   - eslint errors         → suggest --fix flag
   - git conflicts         → list conflicting files
4. Return additionalContext with suggestion
5. If no pattern matches, return nothing (let Claude handle normally)
```

#### Output Example

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUseFailure",
    "additionalContext": "This npm test failure likely has specific failing test names in the output. Focus on fixing one test at a time. Run `npm test -- --testNamePattern='<test-name>'` to isolate individual failures."
  }
}
```

#### Entry Point

```javascript
#!/usr/bin/env node
// .claude/hooks/post-tool-use-failure.mjs
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
    match: /conflict/i,
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
```

#### Extensibility

The `ERROR_PATTERNS` array is designed for easy additions. Codekin-specific patterns (e.g., WebSocket server errors, deploy failures) can be added without modifying the framework.

---

### Hook 7: SubagentStart — Convention Injection [Implemented]

**Event**: `SubagentStart`
**Matcher**: none (fires for all subagent types)
**Priority**: Lower — consistency improvement
**Blocking**: No (injects context only)

#### Behavior

When Claude spawns a subagent via the Task tool, inject project conventions and constraints so the subagent produces consistent, on-style output. Subagents don't inherit the full CLAUDE.md context, so this bridges the gap.

#### Input (from Claude Code)

```json
{
  "hook_event_name": "SubagentStart",
  "agent_id": "agent-abc123",
  "agent_type": "Explore"
}
```

#### Logic

```
1. Read project conventions from a compact source:
   - .claude/conventions.md (if exists) — a dedicated short-form conventions file
   - Fallback: extract key rules from CLAUDE.md (coding conventions section)
2. Filter by agent type:
   - "Explore" agents: inject file structure hints, key directories
   - "Bash" agents: inject safe command guidelines
   - "Plan" agents: inject architecture constraints
   - All agents: inject coding style rules
3. Return additionalContext with conventions
```

#### Output Example

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SubagentStart",
    "additionalContext": "Project conventions: TypeScript strict mode. TailwindCSS 4 utility classes with custom theme in src/index.css. Monospace font: Inconsolata. Sans font: Lato. Use fenced code blocks for all code output. ESM modules throughout."
  }
}
```

#### Entry Point

```javascript
#!/usr/bin/env node
// .claude/hooks/subagent-start.mjs
import { createHook } from './lib/handler.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CONVENTIONS_FILE = '.claude/conventions.md';

// Compact conventions for injection (keep under 500 chars to avoid bloating subagent context)
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
```

#### Notes

- Keep injected context compact (<800 chars). Subagents have limited context windows.
- Optional `.claude/conventions.md` allows project-specific overrides without modifying hook code.
- `DEFAULT_CONVENTIONS` is hardcoded for codekin — on package extraction, this becomes a constructor parameter.

---

### Hook 8: Notification — UI Forwarding [Implemented]

**Event**: `Notification`
**Matcher**: none (all notification types)
**Priority**: Lower — improves UI responsiveness
**Blocking**: No (side effect only, no decision control)

#### Behavior

Forward all Claude Code notifications to the Codekin WebSocket server, which broadcasts them to connected UI clients. This ensures permission prompts, idle alerts, and other notifications appear in the web UI in real-time without relying on the stream-json polling.

#### Input (from Claude Code)

```json
{
  "hook_event_name": "Notification",
  "message": "Claude needs your permission to use Bash",
  "title": "Permission needed",
  "notification_type": "permission_prompt"
}
```

#### Logic

```
1. POST notification to http://localhost:32352/api/hook-notify
   Body: { sessionId, notificationType, title, message }
2. Fire-and-forget — don't wait for response
3. Always exit 0 (notifications can't be blocked)
```

#### Output

No stdout output. The hook communicates via HTTP side-effect only.

#### Entry Point

```javascript
#!/usr/bin/env node
// .claude/hooks/notification.mjs
import { createHook } from './lib/handler.mjs';
import { HttpTransport } from './lib/transport/http.mjs';

const serverUrl = process.env.CODEKIN_HOOK_URL || 'http://localhost:32352/api/hook-decision';
const transport = new HttpTransport({ url: serverUrl });

createHook({
  handler: async (input) => {
    // Fire-and-forget via HttpTransport.notify() — centralizes URL resolution,
    // timeout handling, and auth headers with other HTTP hooks.
    await transport.notify({
      sessionId: input.session_id,
      notificationType: input.notification_type,
      title: input.title || null,
      message: input.message,
    });

    // No output — notifications have no decision control
  },
});
```

#### Server-Side Endpoint

New endpoint on the Codekin WebSocket server:

```
POST /api/hook-notify

Request:
{
  "sessionId": "abc123",
  "notificationType": "permission_prompt",
  "title": "Permission needed",
  "message": "Claude needs your permission to use Bash"
}

Response: 204 No Content
```

Server broadcasts to all clients connected to that session:

```json
{
  "type": "notification",
  "sessionId": "abc123",
  "notificationType": "permission_prompt",
  "title": "Permission needed",
  "message": "Claude needs your permission to use Bash"
}
```

#### Notes

- This hook runs **async-safe** — uses `fetch` with a 5-second timeout (via `HttpTransport.notify()`) and catches all errors.
- Even if the server is down, the hook exits cleanly and doesn't block Claude.
- Complements (doesn't replace) existing notification paths until Hook 3 (PermissionRequest) fully replaces the approval pipeline.

---

## Settings Configuration

All hooks are registered in `.claude/settings.local.json` (not committed — specific to this codekin installation).

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/post-tool-use.mjs",
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/stop.mjs",
            "timeout": 120
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/permission-request.mjs",
            "timeout": 65
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/user-prompt-submit.mjs",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/session-start.mjs",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/post-tool-use-failure.mjs",
            "timeout": 5
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/subagent-start.mjs",
            "timeout": 5
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/notification.mjs",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

> **Note**: All hook commands reference `$CLAUDE_PROJECT_DIR`, an environment variable provided automatically by the Claude Code CLI. It resolves to the project root directory (the directory containing `.claude/`). If this variable is not set (e.g., when running hooks manually for testing), the commands will fail. For manual testing, set it explicitly: `CLAUDE_PROJECT_DIR=/path/to/codekin node .claude/hooks/post-tool-use.mjs`.

**Timeout rationale**:

| Hook | Timeout | Why |
|---|---|---|
| PostToolUse (lint) | 30s | ESLint can be slow on large files |
| Stop (gate) | 120s | Runs `npm test` + optionally `npm run build` |
| PermissionRequest | 65s | Waits for human response via UI (60s server timeout + 5s buffer) |
| UserPromptSubmit | 5s | Must be fast — just git commands |
| SessionStart | 10s | Reads files, sets env vars |
| PostToolUseFailure | 5s | Pattern matching only, no external calls |
| SubagentStart | 5s | Reads a file, returns string |
| Notification | 5s | Fire-and-forget HTTP POST |

---

## Integration with Codekin

### New Server Endpoints

| Endpoint | Method | Purpose | Used By |
|---|---|---|---|
| `/api/hook-decision` | POST | Forward permission requests to UI, return decision | Hook 3 (PermissionRequest) |
| `/api/hook-notify` | POST | Broadcast notifications to session clients | Hook 8 (Notification) |
| `/api/auth/validate` | POST | Validate webhook session auth tokens | Hook 3 (PermissionRequest) |

### Environment Variables Set by Server

When the ws-server spawns a Claude CLI process, it should set:

| Variable | Value | Used By |
|---|---|---|
| `CODEKIN_SESSION_TYPE` | `manual` or `webhook` | Hooks 3, 5 |
| `CODEKIN_SERVER` | `http://localhost:32352` | Hooks 3, 8 |
| `CODEKIN_AUTH_TOKEN` | session-scoped token | Hook 3 |

### Migration from Existing Infrastructure

| Current Mechanism | Replaced By | Phase |
|---|---|---|
| `POST /api/tool-approval` | Hook 3 (`PermissionRequest`) | Phase 2 |
| `control_request` stream handling | Hook 3 (`PermissionRequest`) | Phase 2 |
| `autoApprovedTools` / `autoApprovedCommands` in session-manager | Native `updatedPermissions` in Hook 3 | Phase 2 |
| Manual `git status` calls by Claude | Hook 4 (`UserPromptSubmit`) context | Phase 1 |

---

## Testing Strategy

### Unit Tests

Each preset and context provider is testable in isolation:

```javascript
// lib/presets/auto-lint.test.mjs
import { autoLint } from './auto-lint.mjs';

test('skips non-lintable files', async () => {
  const handler = autoLint();
  const result = await handler({ tool_input: { file_path: 'image.png' }, cwd: '/tmp' });
  expect(result).toBeUndefined();
});

test('returns errors for failing lint', async () => {
  // Mock execSync to simulate eslint failure
  const handler = autoLint();
  const result = await handler({
    tool_input: { file_path: 'bad.ts' },
    cwd: '/tmp',
  });
  expect(result.decision).toBe('block');
});
```

### Integration Tests

Test the full stdin→handler→stdout loop using the `createHook` function with a mock transport:

```javascript
class MockTransport {
  constructor(input) { this.input = input; this.output = null; }
  async readInput() { return this.input; }
  writeOutput(o) { this.output = o; }
  writeError(m) { this.error = m; }
}
```

### Manual Testing

Each hook can be tested independently from the command line:

```bash
echo '{"hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":"src/test.ts"},"cwd":"/path/to/codekin"}' | node .claude/hooks/post-tool-use.mjs
```

---

## Extraction Plan [Future]

When ready to publish as a standalone package:

1. **Move** `.claude/hooks/lib/` to a new repo
2. **Add** `package.json` with sub-path exports (following stepflow pattern):
   ```json
   {
     "exports": {
       ".": { "import": "./dist/index.js" },
       "./transport": { "import": "./dist/transport/index.js" },
       "./context": { "import": "./dist/context/index.js" },
       "./presets": { "import": "./dist/presets/index.js" }
     }
   }
   ```
3. **Add** tsup build config (ESM, dts, sourcemaps)
4. **Convert** JSDoc types to TypeScript interfaces
5. **Update** codekin entry points to import from the package instead of relative paths
6. **Add** more transports (WebSocket direct, file-based), context providers, and presets
7. **Publish** to GitHub Packages (same registry as stepflow)

The extraction boundary is clean: `lib/` has zero imports from codekin. Entry points (`.mjs` files) are the only codekin-specific code.

---

## Open Questions

1. **Hook + stream-json conflict**: When `PermissionRequest` hook is active, does the CLI still emit `control_request` on stdout? Need to verify that hooks fully replace the stream-json permission flow, or whether both fire simultaneously.

2. **Startup latency**: Each hook spawns a Node.js process (~40ms). With 2-3 hooks firing per tool call, that's ~120ms overhead. Acceptable for most hooks, but monitor the `UserPromptSubmit` path (runs on every prompt).

3. **Stop hook infinite loops**: The `stop_hook_active` guard prevents infinite loops, but what if the Stop hook's npm test itself triggers a PostToolUse hook? Need to confirm hooks don't nest recursively.

4. **CLAUDE_ENV_FILE availability**: The spec assumes `CLAUDE_ENV_FILE` is available in `SessionStart` hooks. Need to verify this works when Claude is spawned by the ws-server with `--permission-mode bypassPermissions`.

5. **Approval registry persistence**: Hook 3 uses `updatedPermissions` to persist "Always Allow" choices natively. Need to verify this survives session restart / resume, and whether it interacts with the `.claude/settings.local.json` permissions allowlist.

6. **Multiple hooks per event**: PostToolUse has the lint hook matching `Edit|Write`. If we later add a formatter hook on the same event, do both run in parallel or sequentially? The docs say parallel — need to ensure they don't conflict (e.g., both modifying the same file).

7. **Subagent hook depth**: Do hooks fire for tools used by subagents, or only the main agent? If a subagent runs `Edit`, does the `PostToolUse` lint hook fire? This determines whether Hook 1 needs subagent-awareness.
