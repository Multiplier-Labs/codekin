/**
 * HttpTransport — Delegates decisions to the Codekin server.
 *
 * Uses StdioTransport for CLI I/O, adds HTTP methods for
 * server-side decision making and notifications.
 */
import { StdioTransport } from './stdio.mjs';

export class HttpTransport {
  #stdio;

  /**
   * @param {Object} options
   * @param {string} options.url         - server endpoint (e.g. http://localhost:32352/api/hook-decision)
   * @param {string} [options.notifyUrl] - notification endpoint (defaults to origin + '/api/hook-notify')
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
    this.#stdio.writeOutput(output);
  }

  writeError(message) {
    this.#stdio.writeError(message);
  }

  /**
   * Round-trip RPC: send input to server, receive decision.
   * Used by PermissionRequest where the server determines allow/deny.
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
   */
  async notify(data) {
    try {
      await fetch(this.notifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Non-fatal: server may be down
    }
  }
}
