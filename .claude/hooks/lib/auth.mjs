/**
 * Shared auth validation for Codekin hooks.
 *
 * Validates the CODEKIN_AUTH_TOKEN against the server's /api/auth/validate endpoint.
 * Used by both PreToolUse and PermissionRequest hooks for webhook session authentication.
 */

/**
 * Validate the auth token against the Codekin server.
 * @param {string} hubSessionId - The session ID to validate
 * @returns {Promise<{ valid: boolean; status?: number; error?: string }>}
 */
export async function validateAuthToken(hubSessionId) {
  const token = process.env.CODEKIN_AUTH_TOKEN;
  if (!token) {
    return { valid: false, error: 'Webhook session missing auth token' };
  }

  try {
    const hubServer = process.env.CODEKIN_SERVER || 'http://localhost:32352';
    const res = await fetch(`${hubServer}/api/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: hubSessionId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { valid: false, status: res.status, error: `Auth validation failed (HTTP ${res.status})` };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Auth validation error: ${err.message}` };
  }
}
