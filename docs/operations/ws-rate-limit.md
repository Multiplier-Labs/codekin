# WebSocket Rate Limiting

Codekin's WebSocket server applies two complementary rate limits to keep a single client (or a flood of malformed traffic) from monopolizing the server:

1. A **per-IP connection limit** that caps how many new WebSocket connections an IP can open in a rolling window.
2. A **per-connection message rate limit** that caps how many frames a single open connection can send per second.

This document covers both. The implementations live in [`server/ws-server.ts`](../../server/ws-server.ts) (per-IP connection limit) and [`server/ws-rate-limit.ts`](../../server/ws-rate-limit.ts) (per-connection message limit). The per-connection message limiter was added in PR [#435](https://github.com/Multiplier-Labs/codekin/pull/435) and hardened against an off-by-one boundary bug in PR [#438](https://github.com/Multiplier-Labs/codekin/pull/438).

---

## Per-IP Connection Limit

Each new WebSocket handshake is checked against an in-memory per-IP counter **before** any application code runs.

| Knob | Value | Source |
|---|---|---|
| Max connections per IP | `30` | `WS_RATE_MAX_CONNECTIONS` in `server/ws-server.ts` |
| Window length | `60_000` ms (60s) | `WS_RATE_WINDOW_MS` in `server/ws-server.ts` |
| Map cap | `10_000` distinct IPs | `WS_RATE_MAP_MAX_SIZE` in `server/ws-server.ts` |

These are compile-time constants — there are no env-var overrides today. Adjust them by editing `server/ws-server.ts` and rebuilding.

### Key strategy

The IP key is taken from `req.socket.remoteAddress`, **except** when the server runs behind a trusted proxy. When `TRUST_PROXY=true` is set in the environment, the first entry of the `X-Forwarded-For` header is used instead so that nginx-forwarded clients are bucketed by their real source IP rather than the loopback address.

> **Note**: if you forget to set `TRUST_PROXY=true` behind nginx, every client will key as `127.0.0.1` and the limit will be hit globally rather than per-client. Confirm with `journalctl -u codekin -f` and look for `4029 Too many connections` close codes against `127.0.0.1`.

### Behavior on overflow

When an IP exceeds the connection cap, the server immediately closes the new connection with:

| Close code | Reason | Meaning |
|---|---|---|
| `4029` | `Too many connections` | The client opened more than `WS_RATE_MAX_CONNECTIONS` connections in the current 60s window |

Existing connections from the same IP are unaffected.

### Map cap

To prevent unbounded memory growth from a stream of unique IPs (e.g. a port-scan or a botnet flood), the per-IP map is capped at `WS_RATE_MAP_MAX_SIZE = 10_000` entries. Once full, any new IP is rejected outright until expired entries are reaped. A reaper runs every `WS_RATE_WINDOW_MS` and removes entries whose `resetAt` has passed.

---

## Per-Connection Message Rate Limit

Once a WebSocket is established, every inbound frame is counted against a per-connection limiter. This is the limiter implemented in `server/ws-rate-limit.ts`.

| Knob | Default | Source |
|---|---|---|
| Max messages per window | `60` | First arg to `createMessageRateLimiter()` in `server/ws-server.ts` |
| Window length | `1_000` ms (1s) | Second arg to `createMessageRateLimiter()` in `server/ws-server.ts` |
| Disconnect threshold | `2 × limit` (`120` frames in window) | Hard-coded in `server/ws-rate-limit.ts` |

These are passed positionally at the call site:

```ts
// server/ws-server.ts
const rateLimiter = createMessageRateLimiter(60, 1000)
```

Adjust by editing the call site and rebuilding. There is currently no env-var override.

### Counter strategy

The counter is incremented for **every observed frame, before any JSON parsing**. This is deliberate — it prevents a flood of malformed (unparseable) frames from bypassing the limit. A regression test in `server/ws-rate-limit.test.ts` covers this case explicitly.

### Window strategy

The window is a **fixed window**, not a sliding/rolling window. `windowStart` is captured on the first observed frame and the counter resets when the next frame arrives at or past `windowStart + windowMs`. PR [#438](https://github.com/Multiplier-Labs/codekin/pull/438) (commit `11cf610`) changed the rollover comparison from strict `>` to `>=` so that a frame arriving exactly on the boundary correctly starts a new window instead of being charged to the previous one.

### Behavior on overflow

| Frame number in window | Action |
|---|---|
| 1 – 60 | Allowed. Frame is parsed and dispatched normally. |
| 61 (first overflow) | Frame is dropped. Server sends a single `system_message` to the client: `Rate limit exceeded (60 messages/second). Message dropped.` |
| 62 – 120 | Frame is dropped. No additional warning is sent. |
| 121+ | Frame is dropped **and** the connection is closed with code `4029`, reason `Message rate limit exceeded`. |

The two-stage response — warn first, only disconnect on sustained abuse — gives well-behaved clients a chance to back off without losing their session, while a runaway client (or attack) is still cut off.

---

## Monitoring in Production

There is no dedicated metrics endpoint for either limiter. Use the server log:

```bash
journalctl -u codekin -f | grep -E '4029|Rate limit'
```

Specifically:

- A burst of `4029 Too many connections` close codes from one IP indicates a noisy (or hostile) client opening more than 30 sessions/minute. Investigate before raising `WS_RATE_MAX_CONNECTIONS`.
- A burst of `4029 Message rate limit exceeded` close codes indicates a single connection sustaining > 120 messages/second. Most legitimate UI traffic is well under 60/sec, so this is almost always a buggy client or an attack — investigate before tuning.
- The per-frame `system_message` warning is sent to the client only, not logged server-side. To observe it from the operator side, attach a WebSocket inspector (browser devtools → Network → WS) to a session and trigger the limit by sending > 60 frames/sec.

---

## Tuning

Both limits are intentionally generous for normal interactive use:

- 30 connections/IP/minute easily covers tab churn, page reloads, and split-screen workflows.
- 60 messages/second/connection is well above the natural cap of typed input + button clicks.

Raise them only if you have a confirmed legitimate use case (e.g. a scripted client driving Codekin) and you have rate-limit handling on the client side. Raising blindly removes the only protection against a runaway client.

To change values, edit the constants / call-site arguments listed above and rebuild & redeploy.

---

## Known Limitations

- **Single-instance only.** Both limiters are in-process maps. A multi-instance deployment behind a load balancer would let a client multiply their effective allowance by the number of instances. Use `ip_hash` (or equivalent sticky routing) at the load balancer if you scale out.
- **Fixed (not sliding) window for messages.** A client that sends 60 frames at the very end of one window and another 60 at the very start of the next can momentarily achieve `120 frames` over a sub-second interval without tripping disconnect. The disconnect threshold (`2 × limit` within a single window) catches sustained abuse; this remaining boundary slack is acceptable in practice.
- **No env-var configuration.** Both limiters use hard-coded constants. Operators who need per-environment tuning must fork the call site or wire env-var reads themselves.
- **Message-limit warning is single-shot.** Inside a single overflow window the client only sees one `system_message`. Subsequent dropped frames are silent until the window rolls over, to avoid amplifying the flood the limiter is trying to suppress.

---

## Related Source

- [`server/ws-rate-limit.ts`](../../server/ws-rate-limit.ts) — message-rate limiter implementation (`createMessageRateLimiter`, `observe()`)
- [`server/ws-rate-limit.test.ts`](../../server/ws-rate-limit.test.ts) — regression tests (overflow boundary, invalid-JSON flood, window rollover)
- [`server/ws-server.ts`](../../server/ws-server.ts) — per-IP connection limit (`checkWsRateLimit`) and message-limiter call site
