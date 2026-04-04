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
    // AskUserQuestion: The CLI marks this tool with requiresUserInteraction()===true,
    // which short-circuits ALL permission paths (hooks, control_request, stream-json).
    // Even when the hook returns permissionDecision:"allow" with updatedInput containing
    // answers, the CLI's checkPermissions always returns behavior:"ask" and the
    // requiresUserInteraction guard prevents any override.
    //
    // Workaround: collect answers from the user via the server UI, then DENY the tool
    // with the answers formatted in the denial reason. Claude sees the "error" but the
    // content contains the user's actual answers, which it can use to continue.
    if (input.tool_name === 'AskUserQuestion') {
      const hubSessionId = ctx.env.hubSessionId;
      if (!hubSessionId) return; // No hub session — let CLI handle natively

      try {
        const decision = await transport.requestDecision({
          event: 'PreToolUse',
          sessionId: hubSessionId,
          toolName: 'AskUserQuestion',
          toolInput: input.tool_input,
        });

        if (!decision?.allow) {
          return denyWithNotification(ctx, 'AskUserQuestion', input.tool_input, 'User dismissed the question');
        }

        // Format the answers as a structured denial message that Claude can parse.
        // The answers were collected successfully via the UI — the "deny" is only
        // because the CLI doesn't support AskUserQuestion in stream-json mode.
        const answers = decision.updatedInput?.answers || {};
        const questions = input.tool_input?.questions || [];
        const parts = ['[AskUserQuestion] The user answered via the Codekin UI:\n'];
        for (const q of questions) {
          const answer = answers[q.question] || '(no answer)';
          parts.push(`Q: ${q.question}\nA: ${answer}\n`);
        }

        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: parts.join('\n'),
          },
        };
      } catch (err) {
        return denyWithNotification(ctx, 'AskUserQuestion', input.tool_input, `Server error: ${err.message}`);
      }
    }

    // ExitPlanMode: route through the server for plan approval via PlanManager.
    // The hook blocks until the user approves/rejects the plan in the UI.
    // On approve → allow (CLI executes ExitPlanMode normally).
    // On deny → deny with rejection reason (Claude revises the plan).
    if (input.tool_name === 'ExitPlanMode') {
      const hubSessionId = ctx.env.hubSessionId;
      if (!hubSessionId) return; // No hub session — let CLI handle natively

      try {
        const decision = await transport.requestDecision({
          event: 'PreToolUse',
          sessionId: hubSessionId,
          toolName: 'ExitPlanMode',
          toolInput: input.tool_input,
        });

        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision?.allow ? 'allow' : 'deny',
            ...(decision?.message ? { permissionDecisionReason: decision.message } : {}),
          },
        };
      } catch (err) {
        return denyWithNotification(ctx, 'ExitPlanMode', input.tool_input, `Server error: ${err.message}`);
      }
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

    // Webhook sessions: auto-allow after auth validation.
    // IMPORTANT: This check must remain BEFORE the skipPermissions check below.
    // Webhook sessions must always validate auth regardless of skip flags,
    // because webhook auth is a security boundary, not a UX convenience.
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

    // Skip all permission checks when dangerouslySkipPermissions is active.
    // Check both the env flag and the permission mode as a fallback to guard
    // against desynchronization if the env var mapping changes.
    if (ctx.env.skipPermissions || ctx.env.permissionMode === 'dangerouslySkipPermissions') {
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
        // No hub session ID — pass through to CLI-native handling.
        // This happens in standalone Claude Code sessions (not managed by Codekin).
        // Codekin-managed sessions always have CODEKIN_SESSION_ID set via extraEnv
        // in session-manager.ts, so this branch only fires for direct CLI usage.
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
