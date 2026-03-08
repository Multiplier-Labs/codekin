/**
 * EnvContext — Gathers session environment information.
 */
export class EnvContext {
  name = 'env';

  async gather(input) {
    return {
      sessionId: input.session_id,
      /** The Codekin session ID (used for server API routing). */
      hubSessionId: process.env.CODEKIN_SESSION_ID || null,
      permissionMode: input.permission_mode,
      isRemote: process.env.CLAUDE_CODE_REMOTE === 'true',
      isWebhookSession: process.env.CODEKIN_SESSION_TYPE === 'webhook',
      projectDir: process.env.CLAUDE_PROJECT_DIR || input.cwd,
    };
  }
}
