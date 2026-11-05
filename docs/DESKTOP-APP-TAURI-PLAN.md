# Desktop App (Tauri) — Implementation Plan

Status: **Draft / proposal**. Nothing in this document is implemented yet.

## Goal

A self-contained native macOS app that runs Codekin entirely on the local machine. The app bundles
the Codekin server and its own Node runtime, starts and stops the server itself, and shows the existing UI
in a native window with its own Dock icon and Cmd-Tab entry. The user doesn't need a browser tab, an npm
install or a terminal. Phone access through the relay or LAN keeps working while the app runs in the
background.

## Non-goals

- Re-implementing any UI in native code. The app renders the existing React frontend unchanged.
- Replacing the npm / `install.sh` distribution. The CLI stays available alongside the app.
- Windows and Linux builds for now (Tauri supports them, so they can follow).

## What already exists

Codekin already runs as a single local HTTP server that serves the frontend itself:

| Existing capability | Where | Why it matters |
|---|---|---|
| Server serves the built frontend when `FRONTEND_DIST` is set | `server/config.ts` (`FRONTEND_DIST`), `server/ws-server.ts` | The webview loads one URL; no dev-server or asset bundling inside Tauri |
| Frontend uses relative `/api/...` paths and same-origin WebSocket | `src/lib/ccApi.ts`, `src/hooks/useChatSocket*` | Works unchanged from `http://127.0.0.1:<port>` |
| Token handoff via URL fragment `#token=` | `src/hooks/useSettings.ts`, `bin/codekin.mjs` (`codekin token`) | The app can log the user in by loading `/#token=<token>` |
| Token in `~/.config/codekin/token`, port in `~/.config/codekin/env`, data in `~/.codekin` | `bin/codekin.mjs`, `server/config.ts` (`DATA_DIR`) | The app uses the same locations, so existing sessions and settings carry over |
| Binds to `127.0.0.1` by default | `server/config.ts` (`BIND_HOST`) | Safe to treat as a local backend |
| `GET /api/health` (401 without token, 200 with) | `server/auth-routes.ts` | Readiness probe: any HTTP response means the server is up |

No server or frontend changes are expected. The work is the Tauri shell (Rust), bundling and macOS
integration.

## Architecture

```
Codekin.app
├── Tauri shell (Rust)          window, menu bar icon, server supervisor
│     └── spawns ──► node (sidecar) server/dist/ws-server.js
│                        ├── serves dist/ (frontend) + /api + WebSocket on 127.0.0.1:<port>
│                        └── spawns claude / codex / opencode / grok sessions
└── WKWebView ──► http://127.0.0.1:<port>/#token=<token>
```

### Bundled payload

Inside `Contents/Resources/`:

- `node`: a pinned Node runtime as a Tauri sidecar (`bundle.externalBin`), built for the host
  architecture (`aarch64-apple-darwin` or `x86_64-apple-darwin`).
- `server/dist/`, `dist/`, `server/workflows/`, `server/loops/`: the same set as the npm `files` field.
- Production `node_modules/`, pruned.

The AI CLIs (`claude`, `codex`, …) and `git` / `gh` aren't bundled. The server uses the ones the user has
installed, just as it does today.

### Native module: `better-sqlite3`

- Must be compiled against the **bundled** Node's ABI. Run `npm rebuild better-sqlite3` with the bundled
  Node binary (or `prebuild-install --target <node-version> --arch <arch>`) as part of the bundle step.
- The build script ends with a smoke test: launch the bundled server, wait for `/api/health` and open a
  database. That way an ABI mismatch fails the build instead of the first launch.

## Startup flow

1. Ensure `~/.config/codekin/` exists. On first launch, generate the token and env file as
   `codekin setup` does. Existing files are reused as-is.
2. Read `PORT` from `~/.config/codekin/env` (default `32352`) and the token from `~/.config/codekin/token`.
3. Probe `http://127.0.0.1:<port>/api/health`:
   - **Server already running** (for example an installed `codekin service`): attach to it and don't
     spawn a second one. Two servers on the same `DATA_DIR` would fight over SQLite and session state.
   - **Port taken by something that isn't Codekin**: show an error view that names the port and
     explains how to change it.
   - **Nothing running**: spawn the bundled server (see *Server lifecycle*).
4. Show a native splash while waiting for the health probe (up to about 15 s). If it times out, show an
   error view with **Show logs** and **Retry**.
5. Navigate the main window to `http://127.0.0.1:<port>/#token=<token>`.

## Server lifecycle

- Spawn `node server/dist/ws-server.js` with `FRONTEND_DIST`, `PORT`, `AUTH_TOKEN_FILE` and `DATA_DIR`
  set, the login-shell `PATH` (see below), and stdout/stderr appended to
  `~/Library/Logs/Codekin/server.log`.
- Start it in its own process group. On quit, send SIGTERM to the whole group so child `claude` / `codex`
  processes don't get orphaned. Escalate to SIGKILL after a timeout.
- Supervise the server: if it exits unexpectedly, restart it with backoff and reload the window when it
  comes back. That gives the same robustness as the launchd service.
- If the app attached to an existing service instead of spawning one, it leaves that server running on quit.

### PATH

GUI apps launched from Finder or the Dock inherit launchd's minimal `PATH`, so they can't see Homebrew,
nvm, `~/.local/bin`, etc. Without a fix, the server can't find `claude`, `codex`, `git` or `gh`.

- At startup, run `$SHELL -ilc 'printf %s "$PATH"'` (or use the `fix-path-env` crate) and pass the
  result to the spawned server.
- If `claude` still isn't found, the existing UI already reports it via `/api/health`
  (`claudeAvailable`), so no extra handling is needed in the shell.

## Window and background behaviour

The app keeps running when its window is closed, so phone sessions stay connected.

- Closing the window (or Cmd-W) hides it. A Dock click, Cmd-Tab or the menu bar icon reopens it.
- **Menu bar icon** (`tray-icon` feature) with Open Codekin, Keep Mac awake (toggle), Open at login
  (toggle), Show logs and Quit Codekin. It makes clear that Codekin is still running after the window
  closes.
- Optionally switch to `ActivationPolicy::Accessory` (no Dock icon) while no window is open.
- **Open at login** via `tauri-plugin-autostart` (registers a macOS Login Item), so Codekin is reachable
  from the phone after a reboot.
- **App Nap:** opt out with `NSProcessInfo.beginActivity(.userInitiated)` while the server is running.
  Otherwise macOS throttles the app in the background and streaming to the phone stalls.
- **Sleep:** "Keep Mac awake" holds a power assertion (`.idleSystemSleepDisabled`) that blocks idle sleep.
  It can't prevent sleep when the lid closes on battery, and the menu item's tooltip should say so.
- Cmd-Q / Quit Codekin stops the server and all sessions. If sessions are running, confirm first.
- Remember window size and position (`tauri-plugin-window-state`). Cmd-R reloads the page.

## Repo layout

```
desktop/
  package.json            # @tauri-apps/cli as devDependency; scripts: dev, bundle-server, build
  scripts/
    bundle-server.mjs     # fetch pinned Node, copy server/dist + dist, prune node_modules,
                          # rebuild better-sqlite3, run smoke test
  splash/                 # tiny local splash / error page (Tauri frontendDist)
  src-tauri/
    Cargo.toml
    tauri.conf.json
    capabilities/default.json
    icons/                # generated from public/favicon.svg via `tauri icon`
    binaries/             # node-<target-triple> sidecar (gitignored, produced by bundle-server)
    src/
      main.rs             # app setup, window, menu bar
      server.rs           # spawn / probe / supervise / shutdown
      env.rs              # config dir, token, port, login-shell PATH
```

`desktop/` is its own package, so the root `npm install` doesn't pull in the Tauri CLI and the existing
build, tests and lint are unaffected.

### Key `tauri.conf.json` settings

```json
{
  "productName": "Codekin",
  "identifier": "ai.codekin.desktop",
  "build": {
    "frontendDist": "../splash",
    "beforeBuildCommand": "npm run bundle-server"
  },
  "app": {
    "windows": [{
      "label": "main",
      "title": "Codekin",
      "width": 1400, "height": 900,
      "dragDropEnabled": false
    }],
    "trayIcon": { "iconPath": "icons/tray.png", "iconAsTemplate": true }
  },
  "bundle": {
    "targets": ["app", "dmg"],
    "category": "DeveloperTool",
    "externalBin": ["binaries/node"],
    "resources": { "../build/codekin/": "codekin/" }
  }
}
```

- `dragDropEnabled: false` is required. Otherwise Tauri swallows file drops and attachments in the
  composer stop working.
- The main window may only navigate to `http://127.0.0.1:<port>` / `http://localhost:<port>`. No Tauri
  IPC permissions are granted to that origin. The frontend doesn't need native APIs.

## Building and installing locally

```bash
npm run build                 # existing frontend + server build
cd desktop
npm install
npm run build                 # bundle-server + tauri build
open src-tauri/target/release/bundle/macos/Codekin.app
```

Requirements: Rust toolchain (`rustup`), Xcode Command Line Tools, Node for the build step.

A locally built app is ad-hoc signed and runs on the machine that built it without notarization.
Developer ID signing and notarization are only needed to share the `.dmg` with other people. In that case
the sidecar `node` binary and `better_sqlite3.node` must be signed too.

## WebView differences

- The app runs in WKWebView (Safari engine), so anything that works in Chrome but not Safari will
  behave the same way here. Run the existing UI through Safari as a proxy test.
- Browser `Notification` API: not used by the frontend today. If desktop notifications are added later,
  route them through `tauri-plugin-notification`.
- Passkeys and GitHub OAuth are hosted-mode only and don't apply to the local app.

## Security

- Only the local server origin may be loaded in the main window. External links open in the default
  browser (intercept navigation / new-window requests and hand them to `tauri-plugin-opener`).
- No Tauri commands are exposed to the server origin. The shell talks to the server only over HTTP.
- The token stays in `~/.config/codekin/token` with mode `0600`. The shell reads it and passes the file
  path to the server.
- The server keeps binding to `127.0.0.1`. LAN exposure stays an explicit opt-in via `BIND_HOST`, as
  today.

## Testing

- **Build smoke test** (in `bundle-server.mjs`): bundled server starts, `/api/health` responds and SQLite
  opens.
- **Manual checklist:**
  - first launch with no `~/.config/codekin`
  - launch with existing config and sessions, which carry over
  - launch while `codekin service` is running, so the app attaches and doesn't spawn a second server
  - port taken by another app, which shows the error view
  - `claude` installed via Homebrew / nvm is found when launched from the Dock
  - drag-and-drop attachment into the composer
  - close the window, then a phone session keeps streaming; Cmd-Q stops it with no orphaned processes
  - kill the server process, which the app restarts and the window reconnects to
  - reboot with "Open at login" enabled, after which Codekin is reachable from the phone

## Open questions

1. When the app is installed, should `codekin service install` be discouraged on macOS, or should both
   keep working side by side (the app attaching to the service)?
2. Should the bundled Node version track the version pinned for the npm package / CI?
3. Should the desktop app be versioned in lockstep with the npm package (`0.9.x`)?
