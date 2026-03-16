# Codekin Setup Guide (Advanced / Self-Hosted)

> **Standard users**: If you just want to install and run Codekin, see [INSTALL-DISTRIBUTION.md](./INSTALL-DISTRIBUTION.md). This guide is for advanced/self-hosted bare-metal deployments with nginx, Authelia, and systemd.

Codekin is a web UI for managing multiple Claude Code terminal sessions. It connects via WebSocket and provides repo browsing, skill discovery, and screenshot uploads.

## Architecture

```
Internet (HTTPS)
  → nginx (port 443, YOUR_DOMAIN)
  ├── /                          → Authelia → Static files (React SPA)
  ├── /cc/                       → Authelia → codekin on port 32352 (WebSocket + REST + uploads)
  ├── /cc/api/webhooks/github    → codekin on port 32352 (no auth — HMAC validated)
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
| codekin              | 32352 | Codekin backend                      |
| Authelia             | 9091  | Authentication (internal)            |

## Prerequisites

- Node.js v20+
- nginx with SSL (Let's Encrypt)
- Authelia for authentication
- codekin installed globally (`npm i -g codekin`)

## 1. Clone and Install

```bash
git clone https://github.com/Multiplier-Labs/codekin.git codekin
cd codekin
npm install
```

## 2. Environment Variables

Secrets and configuration are stored in a single file and sourced from `~/.bashrc`.
Session naming uses the Claude CLI (`claude -p`), so no separate API keys are needed.

```bash
# Create the codekin config directory
mkdir -p ~/.config/codekin

# Create the env file
nano ~/.config/codekin/env
```

Contents of `~/.config/codekin/env`:

```bash
# Add environment variables here as needed.
# Webhook-specific vars are configured in Step 10.
```

Source it from `~/.bashrc` so it's available to all shells and systemd user services:

```bash
echo 'source ~/.config/codekin/env' >> ~/.bashrc
source ~/.config/codekin/env
```

To add a new env var later:

```bash
echo 'export NEW_VAR="value"' >> ~/.config/codekin/env
source ~/.config/codekin/env
# Then restart any services that need it:
sudo systemctl restart codekin
```

> **Note**: The systemd services run as your user with `WorkingDirectory=/home/YOUR_USER`, so they inherit env vars from the user's shell profile.

## 3. Configure codekin

### Generate a token

```bash
mkdir -p ~/.config/codekin
openssl rand -hex 32 > ~/.config/codekin/token
```

### Create systemd service

```bash
sudo nano /etc/systemd/system/codekin.service
```

```ini
[Unit]
Description=Codekin Server
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER
EnvironmentFile=/home/YOUR_USER/.config/codekin/env
ExecStart=codekin start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

> **Note**: Ensure `codekin` is on the system PATH (e.g. via `/usr/local/bin`). If using nvm, you may need to specify the full path — find it with `which codekin`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable codekin
sudo systemctl start codekin
```

## 4. Create Data Directory

File uploads and session data are stored under `~/.codekin/` by default (override with `DATA_DIR` and `SCREENSHOTS_DIR` env vars).

```bash
mkdir -p ~/.codekin/screenshots
```

> **Note**: The upload server is no longer a separate process. File upload, repository listing, and clone endpoints (`/api/upload`, `/api/repos`, `/api/clone`) are served by the main codekin server on port 32352.

## 5. Configure Repositories

Repositories are discovered automatically at runtime — no manual scanning step is needed.

- **Local repos** — The server scans the directory specified by `REPOS_ROOT` (default: `~/repos`) for git repositories on startup and periodically thereafter.
- **GitHub orgs** — If `GH_ORG` is set (comma-separated org names), the server also fetches repositories from those GitHub organizations via the `gh` CLI.

To add local repositories, simply clone them into your `REPOS_ROOT` directory. They will appear in the Codekin UI automatically.

## 6. Deploy Settings

Copy the example settings and customize for your environment:

```bash
cp .codekin/settings.example.json .codekin/settings.json
nano .codekin/settings.json
```

Key fields in `settings.json`:

| Field       | Description                                | Default              |
|-------------|--------------------------------------------|----------------------|
| `webRoot`   | Where the built frontend is deployed to    | `/var/www/codekin`   |
| `distDir`   | Path to the frontend build output          | `./dist`             |
| `serverDir` | Path to the server source directory        | `./server`           |
| `port`      | codekin server port                         | `32352`              |
| `authFile`  | Path to the auth token file                | `~/.codekin/auth-token` |
| `log`       | Server log file path                       | `/tmp/codekin.log`    |

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
3. The Settings modal opens automatically — paste your codekin token (from `~/.config/codekin/token`)
4. Click a repo to open a terminal session

## 10. Configure GitHub Webhooks (Optional)

Codekin can receive GitHub webhook events and automatically create Claude sessions to diagnose and fix CI failures. See [GITHUB-WEBHOOKS-SPEC.md](./GITHUB-WEBHOOKS-SPEC.md) for the full specification.

### Server environment variables

Add the webhook env vars to `~/.config/codekin/env` (see [step 2](#2-environment-variables)):

```bash
cat >> ~/.config/codekin/env << 'EOF'
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
source ~/.config/codekin/env
sudo systemctl restart codekin
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
   | **Secret** | Same value as `GITHUB_WEBHOOK_SECRET` in `~/.config/codekin/env` |
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
journalctl -u codekin -f
# Look for: [webhook] Received ping event
```

You can also check the webhook delivery status in GitHub under **Settings → Webhooks → Recent Deliveries**. A green checkmark means the server responded successfully.

To trigger a real test, push a commit that intentionally fails CI (e.g., a syntax error) and watch for a new session appearing in the Codekin UI.

### Troubleshooting webhooks

| Problem | Solution |
|---------|----------|
| GitHub shows "failed to deliver" | Check nginx is proxying `/cc/api/webhooks/github` — run `curl -X POST https://YOUR_DOMAIN/cc/api/webhooks/github` and verify you get a `401` (not `404` or `502`) |
| `401 Unauthorized` on valid deliveries | Verify `GITHUB_WEBHOOK_SECRET` matches between GitHub and `~/.config/codekin/env`, then restart the service |
| Session not created after failure event | Check that `GITHUB_WEBHOOK_ENABLED=true` is set and `gh auth status` succeeds for your user |
| `429 Too Many Requests` | Max concurrent webhook sessions reached — increase `GITHUB_WEBHOOK_MAX_SESSIONS` or wait for existing sessions to finish |
| Webhook received but logs say "gh not found" | Ensure the `gh` CLI is on the PATH in the systemd service `Environment` line |

## Development

Start the Vite dev server (proxies to local services automatically):

```bash
npm run dev
```

The dev server proxies:
- `/cc` → `http://127.0.0.1:32352` (codekin — WebSocket + REST + uploads)

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
sudo systemctl status codekin
```

### View logs

```bash
journalctl -u codekin -f
```

### Port conflicts

```bash
# Check what's using a port
lsof -i :32352
```

### Token issues

- Verify the token file exists: `cat ~/.config/codekin/token`
- Test token verification: `curl -X POST http://127.0.0.1:32352/auth-verify -H 'Content-Type: application/json' -H 'Authorization: Bearer <token>' -d '{"token":"<token>"}'`

### Server health

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:32352/api/health
# Returns: {"status":"ok","claudeAvailable":true,"claudeVersion":"...","apiKeySet":true,...}
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
├── nginx/
│   └── codekin.example      # nginx site config template
├── docs/
│   └── SETUP.md                # This file
├── dist/                       # Production build output
├── vite.config.ts
├── package.json
└── index.html
```

## Key File Paths

| Path                                          | Purpose                        |
|-----------------------------------------------|--------------------------------|
| `~/.config/codekin/env`                       | Secrets and configuration      |
| Web root (set via `FRONTEND_DIST` or `settings.json`) | Deployed frontend |
| `~/.config/codekin/token` (or `AUTH_TOKEN_FILE`) | codekin auth token           |
| `~/.codekin/screenshots/`                     | Uploaded screenshots           |
| `/etc/nginx/sites-available/codekin`          | nginx config (production)      |
| `/etc/systemd/system/codekin.service` | codekin systemd unit            |
