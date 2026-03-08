# Codekin — Docker Spec

## Audit Summary

### Current architecture

The app is three cooperating services on a single Linux host:

| Service | Port | Notes |
|---|---|---|
| nginx | 443 | TLS termination, static SPA, reverse proxy to all backends |
| ws-server (`ws-server.ts`) | 32352 | WebSocket + REST API + file uploads + repo listing, spawns Claude CLI per session |
| Authelia | 9091 | External auth proxy (optional) |

### Key pain points for portability

1. **Scattered config** — API keys live in `~/.config/env/api-keys`, the auth token in `~/.config/claude-code-web-token`, webhook config partly in env vars and partly in `~/.codekin/webhook-config.json`, workflow config in `~/.codekin/workflow-config.json`
2. **GitHub auth via interactive CLI** — `gh auth login` stores credentials in a local credential store; no env-var path exists
3. **Hardcoded paths** — `/srv/repos`, `/home/dev`, `/var/www/codekin/` are baked into the scan script, deploy script, and `claude-process.ts`
4. **Authelia tightly coupled in frontend** — `ccApi.ts` redirects to `/authelia/login` and assumes Authelia is running in the same nginx stack
5. **No `Dockerfile`** — requires manual systemd service and nginx setup on the host
6. **Settings UI is minimal** — only stores auth token, font size, and theme; API keys and integrations have no UI

---

## Proposed Docker Architecture

### Container topology

```
User Browser
  → :80/:443  codekin (nginx inside container)
              ├── /           → static SPA (React build, served by ws-server when FRONTEND_DIST is set)
              ├── /cc/        → ws-server :32352 (WebSocket + REST + uploads + repo listing)
              └── /cc/api/webhooks/github  → ws-server (no auth, HMAC only)

GitHub
  → POST /cc/api/webhooks/github (public, HMAC-validated)
```

**Single image, two docker-compose profiles:**

- `default` — one container with ws-server (serves frontend via `FRONTEND_DIST`) + Claude Code CLI + `gh` CLI
- `with-auth` — adds an Authelia or Caddy sidecar for production HTTPS + SSO

### Why single image vs. multi-container

Multiple containers would require the ws-server to spawn `claude` in a sidecar — which means full Docker-in-Docker or socket mounting. Since Claude Code is a child process of the server, keeping them together is simpler and avoids IPC complexity.

---

## Configuration Consolidation

All config collapses to a **single `.env` file**:

```env
# ── Required ─────────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...

# ── AI providers (optional) ──────────────────────────────────
GROQ_API_KEY=...           # Session auto-naming (Llama 70B)
GEMINI_API_KEY=...         # /validate-gemini skill
OPENAI_API_KEY=...         # /validate-gpt skill
OPENAI_MODEL=gpt-5.2
GEMINI_MODEL=gemini-2.0-flash

# ── GitHub integration (optional) ────────────────────────────
GITHUB_TOKEN=ghp_...       # Replaces "gh auth login"; used by gh CLI + webhook handler
GITHUB_WEBHOOK_SECRET=...
GITHUB_WEBHOOK_ENABLED=false
GITHUB_WEBHOOK_MAX_SESSIONS=3
GITHUB_WEBHOOK_LOG_LINES=200

# ── Security ─────────────────────────────────────────────────
AUTH_TOKEN=                # Auto-generated on first run if empty; printed to logs
CORS_ORIGIN=*

# ── Paths (inside container) ─────────────────────────────────
REPOS_DIR=/repos           # Where repos are mounted
DATA_DIR=/data             # Persistent state (sessions, approvals, config)
```

### Code changes required

| File | Status | Change |
|---|---|---|
| `server/config.ts` | ✅ Done | Centralizes all paths/ports as env vars (`PORT`, `AUTH_TOKEN`, `REPOS_ROOT`, `DATA_DIR`, `SCREENSHOTS_DIR`, `GH_ORG`, `CORS_ORIGIN`, `FRONTEND_DIST`) |
| `server/upload-routes.ts` | ✅ Done | Upload, repo listing, and clone endpoints merged into main server (was separate `upload-server.mjs` on port 32353) |
| `server/ws-server.ts` | ✅ Done | Serves frontend via `express.static` when `FRONTEND_DIST` is set; strips `/cc` prefix in Docker mode |
| `scripts/scan-repos.mjs` | ✅ Done | Uses `REPOS_DIR` env var |
| `server/claude-process.ts` | ✅ Done | Uses `process.env.HOME` |
| `server/webhook-config.ts` | Pending | Derive config path from `DATA_DIR` |
| `server/workflow-config.ts` | Pending | Derive config path from `DATA_DIR` |
| `server/session-manager.ts` | Pending | Derive all persistence paths from `DATA_DIR` |
| `server/webhook-github.ts` | Pending | Inject `GH_TOKEN` env var into `gh` CLI calls |

---

## Volume Mounts

```yaml
volumes:
  - ${REPOS_PATH:-./repos}:/repos        # Your git repos (bind mount from host)
  - codekin-data:/data                # Persistent: sessions, approvals, configs
  - codekin-claude:/root/.claude      # Claude CLI settings, hooks, CLAUDE.md files
```

`REPOS_PATH` lets users point at an existing repo directory (e.g. `~/code`) without moving files.

---

## Settings UI — API Key Management

The Settings modal should gain a new **Integrations tab** backed by a new server endpoint (`GET/PUT /api/server-config`). This endpoint reads and writes `DATA_DIR/server-config.json`, which the server loads at startup. Environment variables still take precedence over stored values.

| Setting | UI editable | Env var override | Notes |
|---|---|---|---|
| Anthropic API Key | Yes | `ANTHROPIC_API_KEY` | Masked; validates by probing Claude |
| GitHub Token | Yes | `GITHUB_TOKEN` | Replaces `gh auth login` dependency |
| Groq API Key | Yes | `GROQ_API_KEY` | |
| Gemini API Key | Yes | `GEMINI_API_KEY` | |
| OpenAI API Key | Yes | `OPENAI_API_KEY` | |
| OpenAI Model | Yes | `OPENAI_MODEL` | |
| Gemini Model | Yes | `GEMINI_MODEL` | |
| Webhook enabled | Yes | `GITHUB_WEBHOOK_ENABLED` | Toggle |
| Webhook secret | Yes | `GITHUB_WEBHOOK_SECRET` | Masked |
| Webhook max sessions | Yes | `GITHUB_WEBHOOK_MAX_SESSIONS` | |
| Auth token | Yes (existing) | `AUTH_TOKEN` | |

**Security**: the `/api/server-config` write endpoint must require auth. `DATA_DIR/server-config.json` should be chmod 600 on write.

---

## GitHub Auth: `gh auth login` → `GH_TOKEN`

Currently `webhook-github.ts` calls `gh auth status` and fails if no stored credential exists. In Docker there is no interactive login.

**Fix**: pass `GITHUB_TOKEN` (or `GH_TOKEN`) as env to `gh` CLI child process invocations. The `gh` CLI respects `GH_TOKEN` without needing a stored credential. The `checkGhHealth()` function should drop the `auth status` check in non-interactive mode and call `gh api /user` directly (which works with `GH_TOKEN`).

---

## Including Claude Code CLI in the Image

Claude Code CLI is installed directly in the Docker image:

```dockerfile
RUN npm install -g @anthropic-ai/claude-code@latest
```

This makes the image self-contained — a fresh Mac mini (or any machine) with just Docker can run the full stack. `ANTHROPIC_API_KEY` provides credentials via env var.

**Notes:**

- Claude Code CLI version should be pinnable via a build arg: `ARG CLAUDE_VERSION=latest`
- `~/.claude/` config directory should be in the `codekin-claude` volume so Claude's settings (CLAUDE.md, hooks, approval rules) persist across container restarts
- First-run: Claude Code accepts TOS automatically when `ANTHROPIC_API_KEY` is present and the server sets `--permission-mode acceptEdits`

---

## Stepflow

`@multiplier-labs/stepflow` is an **internal library** bundled within the ws-server — not a standalone service. The workflow admin API (`/api/workflows/*`) is part of the existing ws-server and is already behind token auth.

**Does it need to be publicly available?** No. Workflow endpoints (list runs, trigger workflows, manage schedules) are admin-only. In the Docker setup they stay behind the auth layer. The only endpoint that must be publicly reachable is the GitHub webhook (`/cc/api/webhooks/github`), which is HMAC-validated and explicitly bypasses the auth layer.

---

## Authelia: optional, not required

Currently the frontend has Authelia hard-coded — `checkAuthSession()` redirects to `/authelia/login` on session expiry.

**Proposed approach:**

- **Default (no Authelia)**: token-only auth. Auto-generate `AUTH_TOKEN` on first run, print to logs. Remove the Authelia redirect — treat non-JSON 401s as token errors, not session expiry.
- **Optional (with Authelia)**: `docker-compose --profile auth` brings up Authelia as a sidecar. Nginx config switches to `auth_request` mode. The frontend detects the active mode from a `/api/auth-mode` endpoint response.

---

## Side-by-side with Other Services (e.g. Clawdbot)

Multiple services can share the same `docker-compose.yml`:

```yaml
services:
  codekin:
    image: codekin
    volumes:
      - ${REPOS_PATH:-./repos}:/repos
      - codekin-data:/data
      - codekin-claude:/root/.claude
    networks:
      - hub-net

  clawdbot:          # or any companion service
    image: clawdbot
    volumes:
      - ${REPOS_PATH:-./repos}:/repos   # shared read access to the same repos
    networks:
      - hub-net

  nginx-proxy:       # optional: single entry-point nginx or Caddy
    image: nginx
    ports:
      - "80:80"
      - "443:443"
    networks:
      - hub-net
```

Key decisions when adding companion services:

- **Shared repos volume**: companion services that need to read the same source code can bind-mount `REPOS_PATH` read-only
- **Shared Claude config**: if a companion service also spawns Claude Code, they should share the `codekin-claude` volume to avoid conflicting approval rules and CLAUDE.md files
- **Port isolation**: each service runs internally on its own port; a top-level nginx/Caddy proxy routes by subdomain or path prefix
- **Networking**: put all services on the same Docker bridge network so they can reference each other by service name

---

## Implementation Checklist

1. ✅ Config centralization — `server/config.ts` exports all paths/ports as env vars with sensible defaults
2. ✅ Single-process server — upload/repo/clone endpoints merged into `ws-server` via `upload-routes.ts`; `upload-server.mjs` removed
3. ✅ Frontend serving — `ws-server.ts` serves React build via `express.static` when `FRONTEND_DIST` is set (removes nginx requirement in Docker)
4. ✅ TypeScript build — `server/package.json` has a `build` script; deploy compiles TS → JS and runs with `node`
5. ✅ `/cc` prefix stripping — middleware in `ws-server.ts` strips the nginx-level prefix so API calls work in Docker mode without nginx
6. ✅ `scan-repos.mjs` — uses `REPOS_DIR` env, no hardcoded paths
7. `Dockerfile` — node 24 base, install `gh` CLI + Claude Code CLI, bundle server and built frontend
8. `docker-compose.yml` — single service, env file, named volumes
9. `docker-compose.auth.yml` — Authelia overlay for production deployments
10. Config path abstraction — replace remaining `homedir()` calls in `webhook-config.ts`, `workflow-config.ts`, `session-manager.ts` with `DATA_DIR`
11. GitHub token env — replace `gh auth login` requirement with `GH_TOKEN` env var injection in `webhook-github.ts`
12. Settings UI: Integrations tab — new `GET/PUT /api/server-config` endpoint + UI for all API keys
13. Auth abstraction — make Authelia optional; remove hard redirect to `/authelia/login`
14. Auto-generate `AUTH_TOKEN` — on first run if not set, persist to `DATA_DIR/auth-token`

---

## SaaS Considerations

The Docker self-hosted release is the recommended first milestone. The config consolidation work above (env-per-tenant, `DATA_DIR` abstraction, secrets via env) maps cleanly onto a multi-tenant hosted architecture. The following factors become critical when moving from self-hosted to SaaS.

### Multi-tenancy & Process Isolation

The current architecture spawns Claude CLI as a child process with access to the host filesystem. In SaaS, each tenant's sessions must be fully isolated — separate processes, separate filesystem sandboxes, no shared volumes across tenants.

Options in increasing isolation order:

| Approach | Isolation | Complexity |
|---|---|---|
| Per-tenant Docker containers | Namespace + cgroup | Medium |
| gVisor (`runsc`) | Syscall interception | Medium |
| Firecracker microVMs | Full VM boundary | High |

Claude Code executes arbitrary shell commands, making this the highest-risk surface. `--permission-mode` helps but is not a security boundary against a compromised or malicious session. Network egress controls and seccomp/AppArmor profiles are required regardless of which isolation model is chosen.

### API Key Ownership

Two models:

- **Proxy mode** — you hold a master `ANTHROPIC_API_KEY`, bill usage to tenants. Requires per-tenant token metering and rate-limit management across all tenants sharing Anthropic's limits.
- **BYOK (Bring Your Own Key)** — each tenant supplies their own Anthropic key. Simpler billing; key storage security becomes your responsibility.

BYOK is lower-risk to start. Proxy mode enables usage-based pricing but requires metering infrastructure from day one.

### Secrets Management

Per-tenant API keys (Anthropic, GitHub tokens, webhook secrets) must be encrypted at rest in a secrets store (e.g. AWS Secrets Manager, HashiCorp Vault), not stored in flat JSON files. The `DATA_DIR/server-config.json` model from the Docker spec is a useful interim format but must be replaced by a secrets backend in production SaaS.

### Authentication & Identity

The simple `AUTH_TOKEN` model does not scale to multi-user SaaS. Required additions:

- OAuth2/OIDC for user identity (e.g. GitHub OAuth, Google)
- Org/team scoping for shared sessions or shared repo access
- Proper session management with short-lived tokens and refresh

### Billing & Metering

Natural billing axes:

- **Token consumption** (requires proxy mode or self-reported BYOK usage)
- **Session duration** or number of sessions per billing period
- **Concurrent sessions** (maps to compute cost)
- **Model tier** (Opus vs. Sonnet vs. Haiku at different price points)

Even if launching with a flat subscription, instrument token and session metrics from the start — retrofitting metering is expensive.

### Data Privacy & Compliance

Code and prompts sent through the service pass through your infrastructure. Enterprise customers will ask about:

- Data retention policy (are sessions logged? for how long?)
- Whether prompt/code data is used for model training (Anthropic's API terms cover this, but you need a clear stance)
- GDPR / data residency requirements
- SOC 2 Type II (a common enterprise procurement requirement)

Establish audit logging, data retention controls, and a data processing agreement template before targeting enterprise customers.

### Operational Model

The current systemd + single-server model must evolve:

| Current | SaaS equivalent |
|---|---|
| systemd service | Container scheduler (ECS, Kubernetes, Fly Machines) |
| Local volume persistence | Tenant-scoped object storage (S3, GCS) |
| Single nginx | Load balancer + per-tenant routing |
| Manual deploy via git hook | CI/CD pipeline with canary deploys |

Session persistence (the `codekin-claude` volume, CLAUDE.md files, approval rules) needs to become tenant-scoped storage keyed by tenant ID, not filesystem paths.

### Recommended Path

1. Ship the Docker self-hosted release — validates the product, builds user trust, surfaces real configuration pain points.
2. Add BYOK multi-tenant support on top of the same image, with a thin orchestration layer that provisions per-tenant containers and injects secrets.
3. Add proxy mode + metering once the user base justifies the operational overhead.
