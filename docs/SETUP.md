# Codekin Setup Guide

Codekin is a web UI for managing multiple Claude Code terminal sessions. It connects to [cc-web](https://github.com/anthropics/claude-code-web) (Claude Code Web Terminal) via WebSocket and provides repo browsing, skill discovery, and screenshot uploads.

## Architecture

```
Internet (HTTPS)
  → nginx (port 443, YOUR_DOMAIN)
  ├── /                          → Authelia → Static files (React SPA)
  ├── /cc/                       → Authelia → cc-web on port 32352 (WebSocket + REST + uploads)
  ├── /cc/api/webhooks/github    → cc-web on port 32352 (no auth — HMAC validated)
  └── /authelia/                 → Authelia UI (port 9091)

GitHub (webhook events)
  → POST https://YOUR_DOMAIN/cc/api/webhooks/github
  → HMAC-SHA256 signature validation
  → Auto-creates Claude sessions for CI failures
```

### Services

| Service              | Port  | Description                          |
|----------------------|-------|--------------------------------------|
| nginx                | 443   | Reverse proxy + Authelia auth        |
| cc-web               | 32352 | Claude Code Web Terminal backend     |
| Authelia             | 9091  | Authentication (internal)            |

## Prerequisites

- Node.js v18+ (cc-web requires v24 for its own process)
- nginx with SSL (Let's Encrypt)
- Authelia for authentication
- cc-web installed globally (`npm i -g @anthropic-ai/claude-code-web`)

## 1. Clone and Install

```bash
git clone <repo-url> codekin
cd codekin
npm install
```

## 2. Environment Variables

All API keys and secrets are stored in a single file and sourced from `~/.bashrc`:

```bash
# Create the codekin config directory
mkdir -p ~/.codekin

# Create the env file
nano ~/.codekin/env
```

Contents of `~/.codekin/env`:

```bash
export GEMINI_API_KEY="your-gemini-key"
export OPENAI_API_KEY="your-openai-key"
export OPENAI_MODEL="gpt-5.2"
export GITHUB_WEBHOOK_SECRET="your-webhook-secret"
# ANTHROPIC_API_KEY is set separately (e.g. via claude CLI config)
```

Source it from `~/.bashrc` so it's available to all shells and systemd user services:

```bash
echo 'source ~/.codekin/env' >> ~/.bashrc
source ~/.codekin/env
```

To add a new env var later:

```bash
echo 'export NEW_VAR="value"' >> ~/.codekin/env
source ~/.codekin/env
# Then restart any services that need it:
sudo systemctl restart claude-code-web
```

> **Note**: You can override the env file location with `CODEKIN_ENV_FILE`. The systemd services run as your user with `WorkingDirectory=/home/YOUR_USER`, so they inherit env vars from the user's shell profile.

## 3. Configure cc-web

### Generate a token

```bash
mkdir -p ~/.codekin
openssl rand -hex 32 > ~/.codekin/auth-token
```

### Create systemd service

```bash
sudo nano /etc/systemd/system/claude-code-web.service
```

```ini
[Unit]
Description=Claude Code Web Terminal
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER
ExecStart=/bin/bash -c '$(which cc-web) --port 32352 --no-open --auth "$(cat /home/YOUR_USER/.codekin/auth-token)"'
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

> **Note**: Adjust the node path to match your nvm installation. Find it with `which cc-web`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable claude-code-web
sudo systemctl start claude-code-web
```

## 4. Create Data Directory

File uploads and session data are stored under `~/.codekin/` by default (override with `DATA_DIR` and `SCREENSHOTS_DIR` env vars).

```bash
mkdir -p ~/.codekin/screenshots
```

> **Note**: The upload server is no longer a separate process. File upload, repository listing, and clone endpoints (`/api/upload`, `/api/repos`, `/api/clone`) are served by the main cc-web server on port 32352.

## 5. Configure Repositories

### Option A: Auto-scan (default)

The repo scanner will scan the configured repos directory automatically:

```bash
node scripts/scan-repos.mjs
```

This generates `public/data/repos.json` which lists all discovered repos with their skills and tags.

### Option B: Manual config

Create `~/.codekin/repos.yml`:

```yaml
- name: my-project
- name: other-project: /custom/path/to/project
```

Then run the scanner:

```bash
node scripts/scan-repos.mjs
```

## 6. Deploy Settings

Copy the example settings and customize for your environment:

```bash
cp .codekin/settings.example.json .codekin/settings.json
nano .codekin/settings.json
```

Key fields in `settings.json`:

| Field       | Description                                | Default              |
|-------------|--------------------------------------------|----------------------|
| `webRoot`   | Where the built frontend is deployed to    | `./dist-deploy`      |
| `serverDir` | Runtime directory for the server           | `./server`           |
| `port`      | cc-web server port                         | `32352`              |
| `authFile`  | Path to the auth token file                | `~/.codekin/auth-token` |
| `log`       | Server log file path                       | `/tmp/cc-web.log`    |

> **Note**: `settings.json` is gitignored — your local config won't be overwritten by `git pull`.

## 7. Build and Deploy

```bash
# Build frontend
npm run build

# Deploy to web root (adjust path as needed)
sudo cp -r dist/* /var/www/your-web-root/
```

## 8. Configure nginx

Copy the provided config:

```bash
sudo cp nginx/codekin.example /etc/nginx/sites-available/codekin
# Edit the file and replace YOUR_DOMAIN with your actual domain
sudo nano /etc/nginx/sites-available/codekin
sudo ln -sf /etc/nginx/sites-available/codekin /etc/nginx/sites-enabled/
```

### SSL with Let's Encrypt

```bash
sudo certbot --nginx -d YOUR_DOMAIN
```

### Test and reload

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### nginx location summary

| Location      | Backend                      | Notes                              |
|---------------|------------------------------|------------------------------------|
| `/`           | Static files                 | SPA with `try_files`               |
| `/cc/`        | `127.0.0.1:32352`           | WebSocket + REST + uploads, 24h timeout |
| `/cc/api/webhooks/github` | `127.0.0.1:32352` | GitHub webhooks (no auth — HMAC validated) |
| `/authelia/`  | `127.0.0.1:9091`           | Auth UI + API                      |

## 9. First Login

1. Open `https://YOUR_DOMAIN` in a browser
2. Authenticate via Authelia
3. The Settings modal opens automatically — paste your cc-web token (from `~/.codekin/auth-token`)
4. Click a repo to open a terminal session

## 10. Configure GitHub Webhooks (Optional)

Codekin can receive GitHub webhook events and automatically create Claude sessions to diagnose and fix CI failures. See [GITHUB-WEBHOOKS-SPEC.md](./GITHUB-WEBHOOKS-SPEC.md) for the full specification.

### Server environment variables

Add the webhook env vars to `~/.codekin/env` (see [step 2](#2-environment-variables)):

```bash
cat >> ~/.codekin/env << 'EOF'
export GITHUB_WEBHOOK_SECRET="your-webhook-secret-here"
export GITHUB_WEBHOOK_ENABLED=true
# Optional overrides:
# export GITHUB_WEBHOOK_MAX_SESSIONS=3
# export GITHUB_WEBHOOK_LOG_LINES=200
EOF
```

Generate a strong secret:

```bash
openssl rand -hex 32
```

Reload and restart:

```bash
source ~/.codekin/env
sudo systemctl restart claude-code-web
```

### Authenticate the `gh` CLI

The webhook handler uses `gh` to fetch CI logs and clone repos. Ensure it's authenticated for your user:

```bash
gh auth status
# If not authenticated:
gh auth login
```

### nginx configuration

The webhook endpoint must be publicly accessible (GitHub needs to reach it), but it **must not** go through Authelia. The nginx config in `nginx/codekin.example` includes a dedicated location block that bypasses auth and relies on HMAC signature validation instead:

```nginx
# GitHub webhooks — no Authelia auth (validated by HMAC signature instead)
location = /cc/api/webhooks/github {
    proxy_pass http://127.0.0.1:32352/api/webhooks/github;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

This block must appear **before** the general `/cc/` block. Apply the config:

```bash
sudo cp nginx/codekin.example /etc/nginx/sites-available/codekin
sudo nginx -t
sudo systemctl reload nginx
```

### GitHub repository settings

1. Go to your GitHub repository → **Settings** → **Webhooks** → **Add webhook**

2. Configure the webhook:

   | Field | Value |
   |-------|-------|
   | **Payload URL** | `https://YOUR_DOMAIN/cc/api/webhooks/github` |
   | **Content type** | `application/json` |
   | **Secret** | Same value as `GITHUB_WEBHOOK_SECRET` in `~/.codekin/env` |
   | **SSL verification** | Enable SSL verification |

3. Under **"Which events would you like to trigger this webhook?"**, select **"Let me select individual events"** and check:

   - **Workflow runs** — triggers on CI pass/fail (Phase 1)
   - **Issues** — for future auto-triage (Phase 2+)
   - **Issue comments** — for `/claude` command triggers (Phase 2+)
   - **Pull requests** — for auto-review (Phase 2+)
   - **Pull request reviews** — for addressing review feedback (Phase 2+)
   - **Pull request review comments** — for inline comment responses (Phase 2+)

   For Phase 1, only **Workflow runs** is required.

4. Ensure **Active** is checked, then click **Add webhook**.

### Verify the webhook

After adding the webhook, GitHub sends a `ping` event. Check the server logs:

```bash
journalctl -u claude-code-web -f
# Look for: [webhook] Received ping event
```

You can also check the webhook delivery status in GitHub under **Settings → Webhooks → Recent Deliveries**. A green checkmark means the server responded successfully.

To trigger a real test, push a commit that intentionally fails CI (e.g., a syntax error) and watch for a new session appearing in the Codekin UI.

### Troubleshooting webhooks

| Problem | Solution |
|---------|----------|
| GitHub shows "failed to deliver" | Check nginx is proxying `/cc/api/webhooks/github` — run `curl -X POST https://YOUR_DOMAIN/cc/api/webhooks/github` and verify you get a `401` (not `404` or `502`) |
| `401 Unauthorized` on valid deliveries | Verify `GITHUB_WEBHOOK_SECRET` matches between GitHub and `~/.codekin/env`, then restart the service |
| Session not created after failure event | Check that `GITHUB_WEBHOOK_ENABLED=true` is set and `gh auth status` succeeds for your user |
| `429 Too Many Requests` | Max concurrent webhook sessions reached — increase `GITHUB_WEBHOOK_MAX_SESSIONS` or wait for existing sessions to finish |
| Webhook received but logs say "gh not found" | Ensure the `gh` CLI is on the PATH in the systemd service `Environment` line |

## Development

Start the Vite dev server (proxies to local services automatically):

```bash
npm run dev
```

The dev server proxies:
- `/cc` → `http://127.0.0.1:32352` (cc-web — WebSocket + REST + uploads)

## Updating

```bash
git pull
npm install
npm run build
sudo cp -r dist/* /var/www/your-web-root/

# If server dependencies changed:
cd server && npm install && cd ..
```

## Troubleshooting

### Check service status

```bash
sudo systemctl status claude-code-web
```

### View logs

```bash
journalctl -u claude-code-web -f
```

### Port conflicts

```bash
# Check what's using a port
lsof -i :32352
```

### Token issues

- Verify the token file exists: `cat ~/.codekin/auth-token`
- Test token verification: `curl -X POST http://127.0.0.1:32352/auth-verify -H 'Content-Type: application/json' -H 'Authorization: Bearer <token>' -d '{"token":"<token>"}'`

### Server health

```bash
curl http://127.0.0.1:32352/health
# Should return: {"status":"ok"}
```

## Directory Structure

```
codekin/
├── src/                        # React + TypeScript source
│   ├── App.tsx                 # Main component
│   ├── components/             # UI components
│   ├── hooks/                  # React hooks (settings, repos, sessions, socket)
│   ├── lib/                    # API client (ccApi.ts), terminal theme
│   └── types.ts                # TypeScript types
├── server/
│   ├── upload-routes.ts        # Upload, repo listing, clone endpoints
│   ├── ws-server.ts            # Main server entry point
│   └── package.json
├── scripts/
│   └── scan-repos.mjs          # Repository scanner
├── nginx/
│   └── codekin.example      # nginx site config template
├── docs/
│   └── SETUP.md                # This file
├── public/data/                # Generated repos.json
├── dist/                       # Production build output
├── vite.config.ts
├── package.json
└── index.html
```

## Key File Paths

| Path                                          | Purpose                        |
|-----------------------------------------------|--------------------------------|
| `~/.codekin/env` (or `CODEKIN_ENV_FILE`)      | API keys and secrets           |
| Web root (set via `FRONTEND_WEB_ROOT` or `settings.json`) | Deployed frontend |
| `~/.codekin/auth-token` (or `AUTH_FILE`)      | cc-web auth token              |
| `~/.codekin/repos.yml`                        | Optional repo list             |
| `~/.codekin/screenshots/`                     | Uploaded screenshots           |
| `/etc/nginx/sites-available/codekin`          | nginx config (production)      |
| `/etc/systemd/system/claude-code-web.service` | cc-web systemd unit            |
