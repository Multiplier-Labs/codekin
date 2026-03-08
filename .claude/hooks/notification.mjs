#!/usr/bin/env node
// Hook 8: Notification — UI Forwarding
// Forwards Claude Code notifications to the Codekin server.
import { createHook } from './lib/handler.mjs';
import { HttpTransport } from './lib/transport/http.mjs';

const serverUrl = process.env.CODEKIN_HOOK_URL || 'http://localhost:32352/api/hook-decision';
const transport = new HttpTransport({ url: serverUrl });

createHook({
  handler: async (input) => {
    const hubSessionId = process.env.CODEKIN_SESSION_ID;
    if (!hubSessionId) return; // No Codekin session — skip notification

    await transport.notify({
      sessionId: hubSessionId,
      notificationType: input.notification_type,
      title: input.title || null,
      message: input.message,
    });

    // No output — notifications have no decision control
  },
});
