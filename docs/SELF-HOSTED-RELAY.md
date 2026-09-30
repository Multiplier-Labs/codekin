# Hosting Your Own Codekin Web App

[app.codekin.ai](https://app.codekin.ai) is one instance of the Codekin web app. You can run
your own on any server you control, so your team reaches its computers through your domain,
under your GitHub sign-in, with your data in your database. Nothing in the web app or the
connector is tied to codekin.ai.

An instance is three pieces:

| Piece | What it is | Where it runs |
|---|---|---|
| Relay / control plane | `server/dist/relay/relay-server.js`: GitHub sign-in, workspaces, invitations, 2FA, and the WebSocket hub between browsers and computers | your server, `127.0.0.1:32360`, behind a reverse proxy |
| Web app | the static bundle from `npm run build:hosted` | your server, served by the reverse proxy |
| Connector | outbound WebSocket from each developer computer to your relay | each computer; installed and paired from your web app |

Computers only ever connect **outbound** to your relay, so they need no open ports.

## 1. Prerequisites

- A Linux server with Node.js 20+ and a domain name for the web app, e.g. `codekin.example.com`.
- TLS for that domain. Use HTTPS in production: session cookies are only marked `Secure` when
  `PUBLIC_URL` is `https://`, and passkeys require a secure origin.
- A reverse proxy that handles WebSocket upgrades. The nginx example below is the configuration
  app.codekin.ai runs.
- A GitHub account for the **operator**, who administers the instance.

## 2. Create a GitHub OAuth App

In GitHub go to **Settings → Developer settings → OAuth Apps → New OAuth App**. It can also be
created under an organization.

- **Homepage URL:** `https://codekin.example.com`
- **Authorization callback URL:** `https://codekin.example.com/api/auth/github/callback`
  (exactly this, derived from `PUBLIC_URL`)

Keep the client ID and generate a client secret. The app only reads the signed-in user's
profile and verified emails.

## 3. Build from a release

Check out the release that matches the `codekin` version your computers install, so the web app,
relay and connectors are in step:

```bash
git clone https://github.com/Multiplier-Labs/codekin.git && cd codekin
git checkout v0.9.0                      # or the latest release tag
npm ci && (cd server && npm ci)
npm run build:hosted                     # web app → dist-hosted/
(cd server && npm run build)             # relay → server/dist/relay/
```

On a machine that exports `NODE_ENV=production`, install with `NODE_ENV=development npm ci
--include=dev`. The builds need dev dependencies.

## 4. Configure the relay

The relay reads `~/.codekin-relay/env` (`KEY=VALUE` lines) for the user it runs as. Values in
the process environment take precedence. It refuses to start while a required value is
missing. Keep the file `chmod 600`.

```bash
PUBLIC_URL=https://codekin.example.com
GITHUB_CLIENT_ID=…
GITHUB_CLIENT_SECRET=…
SESSION_SECRET=…            # openssl rand -hex 32
MFA_ENCRYPTION_KEY=…        # openssl rand -hex 32 — keep a copy; losing it resets every authenticator app
OWNER_GITHUB_ID=…           # numeric id: curl -s https://api.github.com/users/<login> | jq .id
NODE_ENV=production
```

| Key | Required | Meaning |
|---|---|---|
| `PUBLIC_URL` | yes | The web app's origin. It sets the OAuth callback, the allowed `Origin` for REST and WebSocket requests, the passkey domain, and the `--relay` URL in generated install commands. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | yes | From step 2. |
| `SESSION_SECRET` | yes | At least 32 characters; signs session cookies. |
| `OWNER_GITHUB_ID` | yes | The operator. They own the first workspace, can create workspaces, and manage all accounts. |
| `MFA_ENCRYPTION_KEY` | recommended | 32 bytes (64 hex characters), encrypting authenticator-app secrets at rest. Without it, 2FA offers passkeys only. |
| `ALLOWED_GITHUB_IDS` | no | Comma-separated numeric ids let in without an invitation, as members of the first workspace. Usually unnecessary: invitations admit people. |
| `RELAY_PORT` | no | Default `32360`, bound to 127.0.0.1. |
| `AUDIT_RETENTION_DAYS` | no | Default `90`; `0` keeps everything. |
| `RELAY_ACCESS_REQUEST_URL` | no | An `https:` or `mailto:` link shown on the sign-in page for people without access. |

Access is keyed by GitHub's **numeric** user id, never the login. Logins can be renamed and
re-registered by someone else.

## 5. Run it

Run the relay under a process manager, for example pm2:

```bash
pm2 start server/dist/relay/relay-server.js --name codekin-relay
pm2 save
```

Copy the web app to the web root (`rsync -a --delete dist-hosted/ /var/www/codekin-app/`) and
serve both behind the reverse proxy:

```nginx
server {
    server_name codekin.example.com;
    listen 443 ssl;
    # ssl_certificate / ssl_certificate_key: e.g. from certbot

    # Web app (static). Unknown paths fall back to index.html (client-side routes).
    location / {
        root /var/www/codekin-app;
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }
    location /assets/ {
        root /var/www/codekin-app;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # Relay REST API
    location /api/ {
        proxy_pass http://127.0.0.1:32360;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 20m;
    }

    # Relay WebSockets (browsers and connectors)
    location /relay/ {
        proxy_pass http://127.0.0.1:32360;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
```

The relay trusts exactly **one** proxy hop for client addresses (used for rate limits and the
audit log). If another proxy or CDN sits in front of nginx, adjust `trust proxy` in
`relay-server.ts`.

Check it: `curl https://codekin.example.com/api/health` should return `{"ok":true,…}`.

## 6. First sign-in and inviting people

1. The operator opens `https://codekin.example.com`, signs in with GitHub, and sets up
   two-factor authentication. Owners and admins must have it.
2. **Settings → Workspace → Members → Invite people:** enter a GitHub username or an email
   address and pick a role. Send the link it shows. It works once, only for that person, for 7
   days.
3. The invitee opens the link and accepts by signing in with GitHub. That admits them to the
   instance and the workspace.
4. More workspaces: the operator can create them, and can allow others to under
   **Settings → Platform → Accounts**. Each workspace has its own owners, admins, members and
   machines.

## 7. Connecting computers

Each person uses **Connect your computer** (or **Settings → Machines**) in your web app. The
generated command already points at your relay:

```bash
curl -fsSL https://codekin.ai/install.sh | CODEKIN_PAIR_TOKEN=<token> bash -s -- --relay https://codekin.example.com
```

The install script is downloaded from codekin.ai. It installs the published `codekin` npm
package and pairs with *your* relay; nothing is routed through codekin.ai. On a computer that
already has Codekin: `CODEKIN_PAIR_TOKEN=<token> codekin relay login --url https://codekin.example.com`.

## 8. Operating

- **Upgrading:** check out the new release tag, rebuild both parts, copy the web app, then
  `pm2 restart codekin-relay`. The database migrates itself on start. Back up
  `~/.codekin-relay/control-plane.db*` first: a migrated database cannot be used by an older
  relay.
- **Accounts:** **Settings → Platform → Accounts** (operator) disables an account everywhere or
  allows it to create workspaces. Membership is managed per workspace by its owners and admins.
- **Lost second factor:** only the operator can reset one, on the server:
  `node server/dist/relay/relay-admin-cli.js reset-mfa <github-id>`. This is audited and ends the
  account's sessions.
- **Health and logs:** `GET /api/health` reports connected machines and browsers. The relay logs
  to stdout.

More detail on the relay's operation (connector modes, status fields, troubleshooting) is in
[OPERATIONS.md → Hosted relay](OPERATIONS.md#hosted-relay). The design is in
[HOSTED-RELAY-CONTROL-PLANE-SPEC.md](HOSTED-RELAY-CONTROL-PLANE-SPEC.md).
