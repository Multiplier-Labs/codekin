# Desktop App (Tauri) — Implementation Plan

Status: **Draft / proposal**. Nothing in this document is implemented yet.

## Goal

Ship Codekin as a native macOS app: its own window, Dock icon and Cmd-Tab entry, no browser tab, while
keeping phone access through the relay or LAN working the way it does today.

## Non-goals

- Re-implementing any UI in native code. The app renders the existing React frontend unchanged.
- Replacing the npm / `install.sh` distribution. The CLI stays the main way to install.
- Windows and Linux builds in the first iteration (Tauri supports them, so they come later).

## Why this is cheap

Codekin already runs as a single local HTTP server that serves the frontend itself:

| Existing capability | Where | Why it matters |
|---|---|---|
| Server serves the built frontend when `FRONTEND_DIST` is set | `server/config.ts` (`FRONTEND_DIST`), `server/ws-server.ts` | The webview loads one URL; no dev-server or asset bundling inside Tauri |
| Frontend uses relative `/api/...` paths and same-origin WebSocket | `src/lib/ccApi.ts`, `src/hooks/useChatSocket*` | Works unchanged from `http://127.0.0.1:<port>` |
| Token handoff via URL fragment `#token=` | `src/hooks/useSettings.ts`, `bin/codekin.mjs` (`codekin token`) | The shell can log the user in by loading `/#token=<token>` |
| Token on disk at `~/.config/codekin/token`, port in `~/.config/codekin/env` | `bin/codekin.mjs` | The shell can find the running server without IPC |
| Binds to `127.0.0.1` by default | `server/config.ts` (`BIND_HOST`) | Safe to treat as a local backend |
| `GET /api/health` (401 without token, 200 with) | `server/auth-routes.ts` | Readiness probe: any HTTP response means the server is up |

The work is mostly in the Tauri shell (Rust) and packaging. **No server or frontend changes are needed
for Phase 1.**

## Phased plan

### Phase 1: thin shell over the installed CLI (≈0.5–1 day)

The app is only a window. It needs `codekin` to be installed (npm global or `install.sh`).

**Startup flow**

1. Read `PORT` from `~/.config/codekin/env` (default `32352`) and the token from `~/.config/codekin/token`.
2. Probe `http://127.0.0.1:<port>/api/health`. Any HTTP response (200 or 401) means the server is up.
3. If it's not up:
   - Resolve the user's login-shell `PATH` (see *PATH* below).
   - Spawn `codekin start` detached, then poll the health probe for up to about 15 s.
   - Show a small native loading state while waiting, and an error view with "Open logs" and
     "Retry" if it times out.
4. Navigate the main window to `http://127.0.0.1:<port>/#token=<token>`.
   - If there is no token file, show a one-screen message: "Run `codekin setup` first".

**Window behaviour**

- Closing the window hides it; Dock click or Cmd-Tab reopens it. Cmd-Q quits the shell but **leaves the
  `codekin` server running**, because it's either the launchd service or a detached process. Phone
  access keeps working.
- Remember window size and position (`tauri-plugin-window-state`).
- Override Cmd-R so it reloads the page rather than doing nothing, and make Cmd-W hide instead of close.

**Repo layout**

```
desktop/
  package.json            # @tauri-apps/cli as devDependency, scripts: dev / build
  src-tauri/
    Cargo.toml
    tauri.conf.json
    capabilities/default.json
    icons/                # generated from public/favicon.svg via `tauri icon`
    src/main.rs           # startup flow above (~100 lines)
```

Keep `desktop/` as its own package, so the root `npm install` doesn't pull in the Tauri CLI and
the existing build, tests and lint are unaffected.

**Key `tauri.conf.json` settings**

```json
{
  "productName": "Codekin",
  "identifier": "ai.codekin.desktop",
  "build": { "frontendDist": "./splash" },
  "app": {
    "windows": [{
      "label": "main",
      "title": "Codekin",
      "width": 1400, "height": 900,
      "dragDropEnabled": false
    }]
  },
  "bundle": { "targets": ["app", "dmg"], "category": "DeveloperTool" }
}
```

- `frontendDist` is a tiny bundled splash/error page. The real UI comes from the local server.
- `dragDropEnabled: false` is required. Otherwise Tauri swallows file drops and attachments in the
  composer stop working.
- Remote-URL capability: the main window must be allowed to navigate to `http://127.0.0.1:*` and
  `http://localhost:*` only. Don't grant any Tauri IPC permissions to that origin. The frontend doesn't
  need native APIs.

### Phase 2: self-contained app (≈3–5 days + CI)

Bundle everything so non-CLI users can install by drag-and-drop.

**Bundled payload** (in `Contents/Resources/`):

- `node`: a pinned Node runtime as a Tauri sidecar (`bundle.externalBin`), one per target triple
  (`aarch64-apple-darwin`, `x86_64-apple-darwin`).
- `server/dist/`, `dist/`, `server/workflows/`, `server/loops/`: the same set as the npm `files` field.
- Production `node_modules/`, pruned.

**Native module: `better-sqlite3`**

- Must be compiled against the **bundled** Node's ABI, per architecture. Use `prebuild-install` with an
  explicit `--target` / `--arch`, or `npm rebuild` run with the bundled Node binary.
- Add a CI smoke test that launches the bundled server and opens a database, so an ABI mismatch fails
  the build instead of the user's first launch.

**Server lifecycle**

- The shell spawns `node server/dist/ws-server.js` with `FRONTEND_DIST`, `PORT`, `AUTH_TOKEN_FILE` and
  `DATA_DIR` set, and stdout/stderr piped to `~/Library/Logs/Codekin/server.log`.
- On first launch, generate the token and env file in `~/.config/codekin/`, just like `codekin setup`.
  Existing data is reused.
- **Conflict with an installed `codekin service`:** if the health probe finds a server already running
  on the configured port, attach to it instead of spawning a second one. Two servers on the same
  `DATA_DIR` would fight over SQLite and session state.
- On quit, send SIGTERM to the server's process group so child `claude` / `codex` processes don't get
  orphaned. Escalate to SIGKILL after a timeout.
- Optionally supervise the server and restart it with backoff if it crashes, to match what launchd gives
  the service today.

**Background mode (needed for phone access)**

- Menu bar icon (`tray-icon` feature) with Open, Keep Mac awake (toggle), Show logs and Quit Codekin.
- Closing the last window keeps the app and server running. Optionally switch to
  `ActivationPolicy::Accessory` (no Dock icon) while no window is open.
- "Open at login" via `tauri-plugin-autostart` (registers a macOS Login Item).
- **App Nap:** opt out with `NSProcessInfo.beginActivity(.userInitiated | .idleSystemSleepDisabled)`
  while sessions are active. Otherwise macOS throttles the app and streaming to the phone stalls.
- **Sleep:** "Keep Mac awake" holds a power assertion that blocks idle sleep. It can't prevent sleep
  when the lid closes on battery, and the docs and UI should say so.

**Distribution**

- Developer ID signing + notarization (`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`,
  `APPLE_PASSWORD` in CI). The sidecar `node` binary and `better_sqlite3.node` must be signed too.
- GitHub Actions release job on `v*` tags that builds a universal or per-arch `.dmg` and attaches it to
  the release.
- Optional: `tauri-plugin-updater` with a signed update manifest on GitHub Releases.

## Cross-cutting concerns

### PATH (both phases)

GUI apps launched from Finder or the Dock inherit launchd's minimal `PATH`, so they can't see Homebrew,
nvm, `~/.local/bin`, etc. Without a fix, the server can't find `claude`, `codex`, `git` or `gh`.

- At startup, run `$SHELL -ilc 'printf %s "$PATH"'` (or use the `fix-path-env` crate) and pass the
  result to the spawned server.
- The launchd plist written by `codekin service install` already injects `PATH`. This only affects
  servers the app spawns.

### WebView differences

- The app runs in WKWebView (Safari engine), so anything that works in Chrome but not Safari will
  behave the same way here. Run the existing UI through Safari as a proxy test before shipping.
- Browser `Notification` API: not used by the frontend today. If desktop notifications are added later,
  route them through `tauri-plugin-notification`.
- Passkeys and GitHub OAuth are hosted-mode only and don't apply to the local app.

### Security

- Only `127.0.0.1` / `localhost` origins may be loaded in the main window. External links open in the
  default browser (handle `on_navigation` / new-window requests with `tauri-plugin-opener`).
- No Tauri commands are exposed to the remote origin. The shell talks to the server only over HTTP.
- The token stays in the existing file with its existing permissions, and the shell only reads it.

## Testing

- **Phase 1:** manual checklist (cold start with service stopped, warm start with service running,
  missing token, port taken by another app, drag-and-drop attachment, Cmd-Q leaves phone session alive).
- **Phase 2:** CI smoke test that launches the built `.app` headless, waits for `/api/health`,
  opens a SQLite DB and shuts down cleanly with no orphaned processes.

## Open questions

1. Should Phase 2 replace `codekin service install` on macOS, or live alongside it, attaching when
   the service is present?
2. Is there an Apple Developer ID available for signing and notarization?
3. Universal binary (one bigger `.dmg`) or separate arm64/x64 downloads?
4. Should the desktop app be versioned in lockstep with the npm package (`0.9.x`)?

## Alternative considered: PWA "Add to Dock"

`public/manifest.webmanifest` already exists. Safari's **File → Add to Dock** or Chrome's **Install app**
gives a standalone window with no new code. It can't start the server, show a menu bar icon or manage
login items. It's still the recommended stopgap for anyone who already runs `codekin service`.
