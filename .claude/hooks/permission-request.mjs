#!/usr/bin/env node
// Hook 3: PermissionRequest — Approval Simplification
// Webhook sessions: auto-allow after auth validation.
// Manual sessions: forward to Codekin server for UI-based approval.
import { createHook } from './lib/handler.mjs';
import { EnvContext } from './lib/context/env.mjs';
import { HttpTransport } from './lib/transport/http.mjs';
import { validateAuthToken } from './lib/auth.mjs';

const serverUrl = process.env.CODEKIN_HOOK_URL || 'http://localhost:32352/api/hook-decision';
const transport = new HttpTransport({
  url: serverUrl,
  timeout: 65000,
  authToken: process.env.CODEKIN_AUTH_TOKEN || process.env.CODEKIN_TOKEN,
});

createHook({
  transport,
  context: [new EnvContext()],
  handler: async (input, ctx) => {
    // Webhook sessions: auto-allow after auth validation
    if (ctx.env.isWebhookSession) {
      const auth = await validateAuthToken(ctx.env.hubSessionId || ctx.env.sessionId);
      if (!auth.valid) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'deny', message: `${auth.error} — denying` },
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

    // Plain CLI sessions (no Codekin context): skip hook, use normal permissions
    const hubSessionId = ctx.env.hubSessionId;
    if (!hubSessionId && !process.env.CODEKIN_SESSION_TYPE) {
      return { hookSpecificOutput: null };
    }

    // Manual sessions: forward to server, which prompts the UI client
    try {
      if (!hubSessionId) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'deny', message: 'No CODEKIN_SESSION_ID — cannot route approval request' },
          },
        };
      }

      const decision = await transport.requestDecision({
        event: 'PermissionRequest',
        sessionId: hubSessionId,
        toolName: input.tool_name,
        toolInput: input.tool_input,
        permissionSuggestions: input.permission_suggestions,
      });

      // Validate server response shape
      if (typeof decision?.allow !== 'boolean') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'deny', message: 'Hook schema validation failed — manual approval required' },
          },
        };
      }

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
    } catch (err) {
      // Server unavailable or timeout — fail closed
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: `Server error: ${err.message} — manual approval required` },
        },
      };
    }
  },
});
