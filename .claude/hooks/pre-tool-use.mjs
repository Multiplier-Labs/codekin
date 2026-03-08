#!/usr/bin/env node
// PreToolUse hook — forwards approval requests to Codekin server.
// Unlike PermissionRequest (which only fires for interactive permission dialogs),
// PreToolUse fires before every tool execution and can return permissionDecision
// to allow or deny the tool, making it work in headless/stream-json mode.
import { createHook } from './lib/handler.mjs';
import { EnvContext } from './lib/context/env.mjs';
import { HttpTransport } from './lib/transport/http.mjs';
import { validateAuthToken } from './lib/auth.mjs';
import { resolve } from 'node:path';

const serverUrl = process.env.CODEKIN_HOOK_URL || 'http://localhost:32352/api/hook-decision';
const transport = new HttpTransport({
  url: serverUrl,
  timeout: 65000,
  authToken: process.env.CODEKIN_AUTH_TOKEN || process.env.CODEKIN_TOKEN,
});

/** Check if a file path is within the project directory. */
function isInProject(filePath, projectDir) {
  if (!filePath || !projectDir) return false;
  const resolved = resolve(filePath);
  const projResolved = resolve(projectDir);
  return resolved.startsWith(projResolved + '/') || resolved === projResolved;
}

createHook({
  transport,
  context: [new EnvContext()],
  handler: async (input, ctx) => {
    // File-read tools: auto-allow for in-project paths, prompt for outside
    if (input.tool_name === 'Read') {
      const filePath = input.tool_input?.file_path;
      if (isInProject(filePath, ctx.env.projectDir)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        };
      }
      // Out-of-project Read — fall through to approval flow below
    }

    // Webhook sessions: auto-allow after auth validation
    if (ctx.env.isWebhookSession) {
      const auth = await validateAuthToken(ctx.env.hubSessionId || ctx.env.sessionId);
      if (!auth.valid) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: auth.error,
          },
        };
      }

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }

    // Manual sessions: forward to server for UI-based approval
    try {
      const hubSessionId = ctx.env.hubSessionId;
      if (!hubSessionId) {
        // No hub session ID — let Claude Code handle it normally (don't block)
        return;
      }

      const decision = await transport.requestDecision({
        event: 'PreToolUse',
        sessionId: hubSessionId,
        toolName: input.tool_name,
        toolInput: input.tool_input,
      });

      if (typeof decision?.allow !== 'boolean') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Invalid server response',
          },
        };
      }

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.allow ? 'allow' : 'deny',
          ...(decision.message ? { permissionDecisionReason: decision.message } : {}),
        },
      };
    } catch (err) {
      // Server unavailable or timeout — fail closed
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Server error: ${err.message}`,
        },
      };
    }
  },
});
