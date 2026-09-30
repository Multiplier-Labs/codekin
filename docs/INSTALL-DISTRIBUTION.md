# Codekin Distribution & Installation

> For a first installation and session, use [Getting started](./GETTING-STARTED.md). This document covers packaging, the installer internals, releases, and manual deployment.

## Overview

Codekin is distributed as an npm package with a one-liner install script, modelled on Ollama's approach. The goal is that a single command installs everything, sets up a persistent background service, and hands the user a URL with an auth token — no manual process management, no nginx, no Docker required.

```bash
curl -fsSL https://codekin.ai/install.sh | bash
```

`https://codekin.ai/install.sh` is a 302 redirect to
`https://raw.githubusercontent.com/Multiplier-Labs/codekin/main/install.sh`,
so **the installer users run is whatever is on `main`** (after GitHub's raw
CDN cache, a few minutes) — not the npm release. The npm package it installs
is the latest *published* release. A change that needs both (e.g. the script
relying on a new server feature) must degrade gracefully while `main` is ahead
of npm. Always use the `https://` URL: without a scheme curl's first request
is plain HTTP, and the response is piped straight into `bash`.

## How It Works

### Distribution: npm package with pre-built assets

The `codekin` npm package ships with:

- `dist/` — pre-built Vite frontend (React app)
- `server/dist/` — pre-compiled TypeScript server (Node.js)
- `bin/codekin.mjs` — the `codekin` CLI entry point

End users never run `npm run build` or `tsc`. The package on npm always contains ready-to-run artifacts, built by CI on every release.

The server's `FRONTEND_DIST` env var (see `server/config.ts`) makes this possible — when set, Express serves the frontend directly, eliminating the nginx dependency entirely.

### CLI: `codekin`

Installed globally via npm, the `codekin` command manages the local server:

| Command | Description |
|---|---|
| `codekin start` | Run server in foreground (for testing/debugging) |
| `codekin setup` | First-time wizard: auth token generation |
| `codekin service install` | Install + start as a persistent user-level background service |
| `codekin service uninstall` | Remove the background service |
| `codekin service status` | Show whether the service is running |
| `codekin token` | Print the current access URL with auth token |
| `codekin relay login` | Pair with hosted Codekin (`CODEKIN_PAIR_TOKEN` / `--code`, or device-code flow); `--unmanaged` to run the connector yourself |
| `codekin relay status` | Pairing mode, embedded connector state, hub health |
| `codekin relay logout` | Remove the local pairing credential |

### Service: user-level, no sudo

The background service is installed at the user level — no root or sudo required:

- **macOS**: `~/Library/LaunchAgents/ai.codekin.plist` (launchd user agent)
  - Starts automatically on login
  - Managed with `launchctl load/unload`
- **Linux**: `~/.config/systemd/user/codekin.service`
  - Enabled with `systemctl --user enable --now codekin`
  - Persists across reboots via `loginctl enable-linger`

Both read configuration from:
- `~/.config/codekin/env` — environment variables (`PORT`, `REPOS_ROOT`, etc.)
- `~/.config/codekin/token` — auth token file

### Auth Token

On first run (`codekin setup`), a random token is generated and saved to `~/.config/codekin/token`. The server reads it via `AUTH_TOKEN_FILE` (already supported in `server/config.ts`).

The token is embedded in the access URL: `http://localhost:32352/#token=<token>`

`codekin token` reprints this URL at any time. `codekin setup --regenerate` issues a new token.

### Install Script (`install.sh`)

The curl-pipe-bash script handles bootstrapping on a fresh machine:

1. **Check Node.js ≥20** — installs via nvm if missing
2. **Check coding agents** — needs at least one of `claude`, `codex`, `opencode`; lists what it found, and exits with install hints for each if none is present
3. **Hosted pairing** (only with `CODEKIN_PAIR_TOKEN`, or the legacy `--pair <token>`) — claims the token *before* the slow steps so a long `npm install` cannot outlive its 10-minute TTL, and writes `~/.config/codekin/relay.json` with `managed: true`. An existing credential counts as already paired. A failed claim does not stop the local install
4. **`npm install -g codekin`**
5. **`codekin setup`** — generates auth token and writes config
6. **`codekin service install`** — installs and starts the background service; for a managed pairing the service also runs the hosted-relay connector
7. **Finish** — without pairing, prints the local access hints. With pairing, polls the local `GET /api/relay/status` for up to 30 s and ends with "Your machine is online — return to Codekin in your browser" or the specific reason it is not (pairing failed, older server without the embedded connector, service not responding, …)

The hosted app generates:

```bash
curl -fsSL https://codekin.ai/install.sh | CODEKIN_PAIR_TOKEN=<token> bash
```

The token is passed in the environment, not as an argument, so it is not
visible in `ps`; the script also removes it from the environment of every
later child process. `--relay <url>` (or `CODEKIN_RELAY_URL`) selects a
non-default relay.

The script is idempotent: re-running it upgrades codekin and restarts the service.

## Release Process

Releases are automated via GitHub Actions (`.github/workflows/publish.yml`). The workflow triggers **only on version tag pushes** (`v*`) — regular commits do nothing.

### First-time setup (do once)

Before any release can succeed, two things must be in place:

**1. Create an npm account and get a publish token**

- Sign up at [npmjs.com](https://www.npmjs.com) if you don't have an account
- Go to your npm account → **Access Tokens** → **Generate New Token** → choose **Granular Access Token** (or Classic **Automation** token)
- Set it to allow publishing the `codekin` package
- Copy the token

**2. Add the token as a GitHub Actions secret**

- Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
- Click **New repository secret**
- Name: `NPM_TOKEN`
- Value: paste the npm token
- Click **Add secret**

That's it. The workflow reads `secrets.NPM_TOKEN` automatically.

### Publishing a release

```bash
# 1. Make sure you're on main and everything is committed
git checkout main
git pull

# 2. Bump the version in package.json (pick one)
npm version patch   # 0.1.0 → 0.1.1  (bug fixes)
npm version minor   # 0.1.0 → 0.2.0  (new features)
npm version major   # 0.1.0 → 1.0.0  (breaking changes)

# 3. Push the commit AND the tag
git push --follow-tags
```

`npm version` updates `package.json`, commits the change, and creates a git tag (e.g. `v0.1.1`) automatically. The `--follow-tags` flag pushes both the commit and the tag in one step.

Once the tag hits GitHub, the Actions workflow starts within seconds. You can watch it at:
`https://github.com/<your-org>/codekin/actions`

The workflow will:
1. `npm run build` → builds frontend into `dist/`
2. `npx tsc -p server/tsconfig.json` → compiles server into `server/dist/`
3. `npm publish --provenance` → publishes to npm with built artifacts

### Versioning

Follow semver. The version in `package.json` is the source of truth.

## Configuration Reference

All configuration is via environment variables. Defaults suit a local install; override in `~/.config/codekin/env` for custom setups.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `32352` | Server port |
| `BIND_HOST` | `127.0.0.1` | Interface to listen on. Set `0.0.0.0` only to expose the port directly (behind TLS or a trusted network) |
| `AUTH_TOKEN` | — | Auth token (inline). Prefer `AUTH_TOKEN_FILE` |
| `AUTH_TOKEN_FILE` | `~/.config/codekin/token` | Path to auth token file |
| `FRONTEND_DIST` | (set by CLI) | Path to built frontend `dist/` directory |
| `REPOS_ROOT` | `~/repos` | Root directory scanned for local repositories |
| `DATA_DIR` | `~/.codekin` | Codekin data directory (sessions, uploads, etc.) |
| `CORS_ORIGIN` | `http://localhost:5173` | Restrict CORS for remote access |
| `GH_ORG` | — | Comma-separated GitHub orgs for repo listing |
| `SCREENSHOTS_DIR` | `~/.codekin/screenshots` | Directory for uploaded file storage |
| `CODEKIN_AUTO_RESTORE_SESSIONS` | `false` | Auto-restart Claude processes that were alive at previous shutdown (`true` to opt in) |
| `CODEKIN_ORCHESTRATOR_MONITOR` | `false` | Run the orchestrator proactive monitor (15-minute polling) (`true` to opt in) |
| `CODEKIN_RELAY_CONNECTOR` | on | `off` stops the server from running the hosted-relay connector for a managed pairing |

For webhook-specific environment variables (`GITHUB_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_ENABLED`, etc.), see the [webhook setup section in SETUP.md](./SETUP.md#10-configure-github-webhooks-optional).

## Directory Layout (after install)

```
~/.config/codekin/
  env          # environment variables for the service (PORT, REPOS_ROOT, etc.)
  token        # auth token
  relay.json   # hosted-relay pairing credential (mode 600), if paired

~/.codekin/
  sessions/    # persisted session data
  screenshots/ # file upload storage

$(npm root -g)/codekin/
  bin/
    codekin.mjs
  dist/         # pre-built frontend
  server/
    dist/       # pre-compiled server JS
```

## Bare-Metal / Advanced Setup

For users who prefer manual control (remote servers, custom nginx, etc.):

```bash
# Clone and build manually
git clone https://github.com/Multiplier-Labs/codekin
cd codekin
npm install
npm run build
npx tsc -p server/tsconfig.json

# Run with FRONTEND_DIST (no nginx needed)
AUTH_TOKEN=mytoken \
FRONTEND_DIST=./dist \
node server/dist/ws-server.js
```

For bare-metal deployments with nginx, see [docs/SETUP.md](./SETUP.md) for the full production setup guide.
