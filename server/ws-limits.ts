/**
 * Pre-auth limits for the WebSocket server.
 *
 * Both apply before a socket has sent its `auth` frame, so they must not trust
 * anything the client controls: the frame size is capped before the frame is
 * buffered, and the rate-limit IP ignores the client-supplied part of
 * `X-Forwarded-For`.
 */

/**
 * Largest client frame accepted, in bytes. Client messages are JSON text
 * (prompts, pasted input, review comments); files go through the REST upload
 * route. Without this, `ws` buffers up to its 100 MiB default per frame before
 * any auth or rate-limit check runs. Oversized frames close the socket (1009).
 */
export const WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024

/**
 * Number of reverse proxies in front of the server when TRUST_PROXY is on.
 * Matches Express's `trust proxy` hop count so `req.ip` and the WebSocket
 * limiter agree on the client address.
 */
export const TRUSTED_PROXY_HOPS = 1

/**
 * Client IP for a WebSocket upgrade request.
 *
 * nginx's `$proxy_add_x_forwarded_for` appends the real peer to whatever
 * `X-Forwarded-For` the client sent, so only the rightmost TRUSTED_PROXY_HOPS
 * entries are trustworthy. Taking the leftmost entry would let a client pick
 * a fresh rate-limit bucket on every connection.
 */
export function wsClientIp(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy && forwardedFor) {
    const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor
    const hops = header.split(',').map(s => s.trim()).filter(Boolean)
    const ip = hops[hops.length - TRUSTED_PROXY_HOPS]
    if (ip) return ip
  }
  return remoteAddress || 'unknown'
}
