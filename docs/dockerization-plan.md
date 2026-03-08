# Codekin Dockerization Plan

This document outlines the full plan to dockerize Codekin and integrate it with an existing Claude Code setup on the host machine.

---

## Current Coupling Points (What Needs to Change)

Before Docker is viable, these host-specific dependencies must be resolved:

| Issue | Location | Problem |
|---|---|---|
| Hardcoded host paths | `settings.json`, `scan-repos.mjs` | `/home/dev/repos/`, `/var/www/`, etc. won't exist in a container |
| Auth via file | deploy script (`--auth-file`) | Path is baked in and host-specific |
| API keys from shell file | `~/.config/env/api-keys` | Host-specific; not portable |
| Two separate server processes | `ws-server` (32352) + `upload-server` (32353) | Ad-hoc launch, hard to manage in a container |
| nginx on host serves frontend | nginx config | Adds host dependency; needs rethinking for Docker |
| Claude CLI spawned as child process | `claude-process.ts` | `claude` binary must exist inside the container |
| `HOME` hardcoded to `/home/dev` | `claude-process.ts:81` | Container won't have this user/path |
| Repos accessed from host filesystem | `scan-repos.mjs` | Needs a volume strategy |
| `workingDir` hardcoded | `scan-repos.mjs:101` | `/home/dev/repos/${id}` — will break inside Docker |

---

## Docker Limitations for Codekin

Understanding these constraints before writing code avoids surprises later.

### Filesystem Access

Containers can only see bind-mounted host directories. Repos at `/srv/repos/` on the host must be explicitly mounted into the container. Writes from inside the container propagate back to the host — this is fine and expected behavior.

### Claude CLI

The host's `claude` binary is **not accessible** from inside the container. Options:

| Approach | Verdict |
|---|---|
| Install Claude CLI inside the container (`npm install -g @anthropic-ai/claude-code`) | Recommended — clean and self-contained |
| Bind-mount the host's `claude` binary | Fragile — binary depends on its own `node_modules` tree |
| Docker socket / host PID namespace tricks | Security hole — do not use |

### Billing: API Key vs. Claude Code Subscription

This is a critical decision with cost implications:

**When Claude CLI authenticates via `ANTHROPIC_API_KEY`:**
- Billed per token at Anthropic API rates
- No subscription required
- Good for low/moderate usage

**When Claude CLI authenticates via OAuth (browser login, stored in `~/.claude/`):**
- Uses your Claude Code Pro/Max subscription — flat monthly fee
- Higher usage limits, more economical for heavy sessions
- Credentials are user-specific and not suitable for multi-user distribution

**For personal/self-hosted use:** mounting `~/.claude/` from the host into the container gives you Max plan billing with zero extra cost. This is the recommended default.

**For distributing Codekin to others:** each user supplies their own `ANTHROPIC_API_KEY` and is billed at API rates.

### Claude's `~/.claude/` State

Claude CLI stores session history, settings, and tool approvals in `~/.claude/`. Inside Docker this is ephemeral unless mounted. Options:

- **Ephemeral (default):** clean state on every container start — predictable, but no session history
- **Mounted from host:** persistent history and auth — recommended for personal use

### SSH Keys and Git Credentials

Repos can be read and written via bind-mount, but `git push` over SSH will fail unless you also mount `~/.ssh/` or configure credential helpers inside the container.

### Dev Tools

Any tools Claude spawns via the Bash tool (`npm`, `python`, `cargo`, etc.) must exist in the container image or be mounted.

### nginx

Currently nginx on the host serves the frontend and proxies `/cc` to the WebSocket server. In Docker, either:
- Serve the frontend directly from the Node server (`express.static()`) — simpler, one container
- Add an nginx sidecar in `docker-compose.yml` — preserves the existing routing architecture

---

## Implementation Sequence

These steps should be done in order. Step 1 unblocks everything else.

### Step 1 — Centralize Config into Environment Variables

**This is the prerequisite for all other steps.**

Replace all hardcoded paths and settings with env vars with sensible defaults:

| Env Var | Default | Replaces |
|---|---|---|
| `PORT` | `32352` | hardcoded port |
| `AUTH_TOKEN` | (required) | `--auth-file` / token file |
| `REPOS_ROOT` | `/repos` | `/home/dev/repos/`, `/srv/repos/` |
| `FRONTEND_DIST` | `./dist` | nginx web root path |
| `CORS_ORIGIN` | `*` | currently defaults to `*` |

Files to update:
- `server/claude-process.ts` — remove hardcoded `HOME: '/home/dev'`, use `process.env.HOME`
- `server/scan-repos.mjs` — replace `workingDir = /home/dev/repos/${id}` with `REPOS_ROOT`
- `.codekin/settings.json` — remove deploy paths (only relevant for bare-metal)
- deploy script — replace `--auth-file` with `AUTH_TOKEN` env var

### Step 2 — Consolidate the Two Servers into One Process

Currently `ws-server` and `upload-server` are launched separately by the deploy script. Merge them into a single Express app. One process = simpler container lifecycle, no process manager needed.

### Step 3 — Serve Frontend from Node Server

Add `express.static(process.env.FRONTEND_DIST)` to the server so nginx is not required inside the container. The bare-metal deploy can continue using nginx — this just adds an alternative path.

### Step 4 — Compile TypeScript at Build Time

Currently `tsx` (a dev tool) runs the server at runtime. For Docker:
- Compile to JS with `tsc` in the Dockerfile
- Run with plain `node` in the container
- Removes dev toolchain from the production image, shrinks image size

### Step 5 — Handle Claude CLI Installation

Install Claude CLI in the Dockerfile:

```dockerfile
RUN npm install -g @anthropic-ai/claude-code
```

Do not attempt to bind-mount the host's `claude` binary — it won't work reliably.

### Step 6 — Define the Repo Volume Strategy

Two modes to support via `REPOS_ROOT`:

- **Single-repo mode:** mount one repo at `/workspace`, set `REPOS_ROOT=/workspace`
- **Multi-repo mode:** mount a directory at `/repos`, set `REPOS_ROOT=/repos` — mirrors current scan-repos behavior

### Step 7 — Write `docker-compose.yml`

```yaml
services:
  codekin:
    build: .
    ports:
      - "3000:3000"
    environment:
      - ANTHROPIC_API_KEY
      - GROQ_API_KEY
      - GEMINI_API_KEY
      - OPENAI_API_KEY
      - AUTH_TOKEN
      - REPOS_ROOT=/repos
      - FRONTEND_DIST=/app/dist
      - CORS_ORIGIN=${CORS_ORIGIN:-*}
    volumes:
      - ${HOME}/.claude:/root/.claude    # mounts host OAuth session for Max plan billing
      - ${HOME}/.ssh:/root/.ssh:ro       # optional: for git push over SSH
      - /path/to/your/repos:/repos       # repos to work on
```

The `${HOME}/.claude` mount is automatically resolved to the user running `docker compose up` — no manual path editing required.

### Step 8 — Write the Dockerfile

Multi-stage build:

```dockerfile
# Stage 1: Build frontend
FROM node:22-alpine AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Compile server TypeScript
FROM node:22-alpine AS server-build
WORKDIR /app
COPY server/package*.json ./
RUN npm ci
COPY server/ .
RUN npx tsc

# Stage 3: Runtime
FROM node:22-alpine
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY --from=frontend /app/dist ./dist
COPY --from=server-build /app/dist ./server
COPY server/package*.json ./
RUN npm ci --omit=dev
ENV FRONTEND_DIST=/app/dist
CMD ["node", "server/ws-server.js"]
```

### Step 9 — Auth and Security Hardening

- Generate `AUTH_TOKEN` automatically in the install script if not set
- Default `CORS_ORIGIN` to the machine's hostname (not `*`) in the Docker distribution
- Document all required vs. optional env vars in `README.md`
- Never bake secrets into the image — always use env vars or Docker secrets

---

## Install Script

A `./install.sh` shipped with the project handles first-time setup automatically:

```bash
#!/usr/bin/env bash
set -e

echo "=== Codekin Docker Setup ==="

# Check for Claude CLI auth
if [ ! -d "$HOME/.claude" ]; then
  echo "ERROR: ~/.claude not found."
  echo "Run 'claude' once to log in (for Max plan billing), then re-run this script."
  echo "Or set ANTHROPIC_API_KEY in .env to use API billing instead."
  exit 1
fi

# Generate auth token if not already set
AUTH_TOKEN=${AUTH_TOKEN:-$(openssl rand -hex 32)}

cat > .env <<EOF
# Claude authentication
# Option A: Mount ~/.claude for Max plan billing (default — leave ANTHROPIC_API_KEY unset)
# Option B: Set ANTHROPIC_API_KEY below for per-token API billing
# ANTHROPIC_API_KEY=your_key_here

# Optional API keys for Codekin skills
# GROQ_API_KEY=
# GEMINI_API_KEY=
# OPENAI_API_KEY=

# Codekin auth token (auto-generated)
AUTH_TOKEN=${AUTH_TOKEN}

# Restrict CORS (recommended for non-localhost deployments)
# CORS_ORIGIN=https://your-domain.com
EOF

echo ""
echo "Setup complete. Your auth token: ${AUTH_TOKEN}"
echo "Edit .env if you need to change any settings."
echo ""
echo "To start Codekin:"
echo "  docker compose up -d"
```

---

## What Users Must Do Manually (Minimum)

| Step | Manual? | Notes |
|---|---|---|
| Install Docker + Docker Compose | Yes | One-time host setup |
| Run `claude` to log in (for Max plan) | Yes | One-time; only if using subscription billing |
| Run `./install.sh` | Yes | Generates `.env`, checks prerequisites |
| Edit `.env` to point to repos | Maybe | Default is `/repos`; user sets the volume path in `docker-compose.yml` |
| `docker compose up` | Yes | Starts Codekin |

Everything else — path configuration, auth token generation, `~/.claude` mounting — is handled automatically.

---

## Migration Path for Bare-Metal Users

Existing bare-metal deployments continue to work unchanged. The changes in steps 1–4 are backwards-compatible:

- Env vars fall back to current hardcoded defaults when not set
- The deploy script and nginx config remain functional
- Docker support is additive, not a replacement

The goal is: **one codebase, two deployment modes** — bare-metal via deploy script, or Docker via `docker compose up`.
