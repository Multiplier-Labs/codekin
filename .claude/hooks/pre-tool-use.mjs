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

/** Deny a tool and fire a best-effort notification to the UI so the user sees why. */
async function denyWithNotification(ctx, toolName, toolInput, reason) {
  const hubSessionId = ctx.env.hubSessionId;
  if (hubSessionId) {
    try {
      await transport.notify({
        sessionId: hubSessionId,
        notificationType: 'hook_denial',
        title: `Permission denied: ${toolName}`,
        message: reason,
        toolName,
        toolInput,
      });
    } catch {
      // Best-effort — don't block denial on notification failure
    }
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

createHook({
  transport,
  context: [new EnvContext()],
  handler: async (input, ctx) => {
    // AskUserQuestion: pass through to control_request flow.
    // The CLI emits a control_request for this tool, which lets the server
    // collect answers via the UI. If the hook handles it, the control_request
    // is never generated and the tool fails with is_error=true.
    if (input.tool_name === 'AskUserQuestion') {
      return;
    }

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
        return denyWithNotification(ctx, input.tool_name, input.tool_input, auth.error);
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
        return denyWithNotification(ctx, input.tool_name, input.tool_input, 'Invalid server response');
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
      return denyWithNotification(ctx, input.tool_name, input.tool_input, `Server error: ${err.message}`);
    }
  },
});
