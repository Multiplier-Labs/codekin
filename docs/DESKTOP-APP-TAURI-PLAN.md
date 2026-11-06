# Desktop App (Tauri) — Implementation Plan

Status: **Planned, not started**. Nothing in this document is implemented yet. The decisions in
[Decisions](#decisions) were confirmed on 2026-11-06. One input is still open: who owns the Apple Developer
account (D3). It blocks only the signing and notarization step, not the rest of the work.

## Goal

A self-contained native macOS app for Apple Silicon that runs Codekin entirely on the local machine. The app bundles
the Codekin server and its own Node runtime, starts and stops the server itself, and shows the existing UI
in a native window with its own Dock icon and Cmd-Tab entry. The user doesn't need a browser tab, an npm
install or a terminal for Codekin itself. Phone access through the relay or LAN keeps working while the app runs in the
background.

## Non-goals

- Re-implementing any UI in native code. The app renders the existing React frontend.
- Replacing the npm / `install.sh` distribution or `codekin service`. Both stay supported alongside the
  app.
- Intel Macs, Windows and Linux builds. Only Apple Silicon (`aarch64-apple-darwin`) is targeted; Tauri supports the others if they are ever needed.
- Installing or logging in to the AI CLIs. `claude`, `codex`, `opencode` and `grok` keep their own installers
  and login flows, which do need a terminal. The app detects them and explains what is missing (see
  [First run](#first-run)).

## Decisions

Confirmed 2026-11-06. Each one is referenced from the section it shapes.

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Where does setup, env and start logic live? | In **Node**, in a launcher shared with the CLI. The Rust shell only spawns, watches and stops one Node process. | `codekin setup` / `start` already own the token, the env file and `FRONTEND_DIST` resolution. A Rust copy would drift from them. |
| D2 | Is relay pairing in scope? | **Yes, required before the first public release**, built as an in-app device-code flow (Phase 2). | Without it, phone access through app.codekin.ai needs `codekin relay login` in a terminal, which contradicts the goal. The flow is small: the CLI's device-code loop moves into the server. |
| D3 | Signing, distribution and updates | Phase 1 builds are local and ad-hoc signed. A public `.dmg` needs an Apple Developer ID under Multiplier Labs, notarization in CI, and `tauri-plugin-updater` reading a signed manifest from GitHub Releases. Work proceeds **without** the Apple account: everything up to and including unsigned CI builds and the updater is built first, and only Developer ID signing and notarization (Phase 3b) wait for it. | An app that bundles its server goes stale without an updater. Notarization is needed for anyone else to open it without Gatekeeper workarounds. **Owner of the Apple account not yet named.** |
| D4 | App version | **Same version as the npm package**, released from the same `v*` tag. | One number in bug reports, and the About panel always matches the bundled server. A shell-only fix ships as a patch release. |
| D5 | Dock icon when no window is open | **Keep the Dock icon** in v1. No `ActivationPolicy::Accessory` switching. | Switching policy at runtime has focus quirks, and the menu bar icon already shows that Codekin is running. Revisit after v1. |
| D6 | `window.confirm` / `window.alert` | Gate on the spike (Phase 0). If WKWebView under Tauri doesn't show them, replace them with an in-app confirm dialog before Phase 1 ships. | ~24 call sites (approvals, archived sessions, …). If the host doesn't implement the WebKit panels, `confirm()` returns `false` silently and those actions do nothing. |

## Relationship to the CLI and the service

The app is **standalone**. A user who only installs the app never needs a terminal, `codekin setup`,
`codekin start` or `codekin service install`. It doesn't replace the service either, and the two coexist:

| Situation | App behaviour |
|---|---|
| Only the app is installed | App does first-run setup itself and runs its own bundled server |
| `codekin service` is installed and running | App attaches to the running server and doesn't start a second one |
| Service installed but stopped | App starts its own bundled server on the configured port |
| Service starts while the app's server is running | The service fails to bind the port and the app's server keeps working. Documented: run one or the other |
| Attached service stops while the app is open | The supervisor notices and starts the bundled server, then the window reconnects |

Both share `~/.config/codekin` and `~/.codekin`, so sessions, settings, the token and the relay pairing are the
same no matter which server is running. When attached, the window shows the service's frontend and the About
panel reports the version the running server returns from `/api/ping`, not the bundled one.

## What already exists

| Existing capability | Where | Why it matters |
|---|---|---|
| Server serves the built frontend when `FRONTEND_DIST` is set | `server/config.ts`, `server/ws-server.ts` | The webview loads one URL; no dev server or asset bundling inside Tauri |
| Frontend uses relative `/api/...` paths and same-origin WebSocket | `src/lib/ccApi.ts`, `src/hooks/useChatSocket*` | Works unchanged from `http://127.0.0.1:<port>` |
| Token handoff via URL fragment `#token=`, then persisted for the origin | `src/hooks/useSettings.ts` | The app logs the user in by loading `/#token=<token>`; Cmd-R reloads keep working |
| Token in `~/.config/codekin/token`, config in `~/.config/codekin/env`, data in `~/.codekin` | `bin/codekin.mjs`, `server/config.ts` | The app uses the same locations, so existing sessions and settings carry over |
| `codekin start` merges the whole env file into the server environment | `bin/codekin.mjs` (`cmdStart`) | The app must do the same — see [Launcher](#launcher-d1) |
| Graceful shutdown on SIGTERM: stops the relay connector, persists and stops sessions | `server/ws-server.ts` (`gracefulShutdown`) | The shell must let it run — see [Server lifecycle](#server-lifecycle) |
| Embedded relay connector, picks up `relay.json` written while running | `server/relay/embedded-connector.ts` | In-app pairing only has to write the credential |
| Native "Choose Folder" dialog via `osascript` for loopback callers on macOS | `server/native-folder-picker.ts` | Works in the app; needs a focus check (see [Testing](#testing)) |
| Binds to `127.0.0.1` by default | `server/config.ts` (`BIND_HOST`) | Safe to treat as a local backend |

## Required server, CLI and frontend changes

The app is not a pure wrapper. These land as ordinary PRs **before** the Tauri work, and each is useful on its own.

1. **`GET /api/ping`, no auth.** Returns `{ "app": "codekin", "version": "<semver>" }` and nothing else.
   `/api/health` answers 401 without a token, so today a probe can't tell a Codekin server using another token
   from an unrelated app on the port. The shell and the launcher use `/api/ping` to choose between attach,
   spawn and port-conflict.
2. **Shared launcher (D1).** Move the setup and start logic out of `bin/codekin.mjs` into a module (e.g.
   `bin/lib/launch.mjs`) used by `codekin setup`, `codekin start`, the service unit and the app. Add a hidden
   `codekin app-server` entry point for the app (see [Launcher](#launcher-d1)).
3. **Codex MCP config keeps up with the Node path.** `ensureCodexMcpConfig` (`server/orchestrator-manager.ts`)
   is append-only: once a `[mcp_servers.codekin]` section exists, it is never rewritten. It records
   `process.execPath` and the server script path, which for the app are paths inside `Codekin.app`. If the
   section was written by the npm install, or by an app at an older location, Codex keeps the stale path. Change
   it to rewrite the `command` and `args` of an existing `codekin` section when they differ. The Claude and
   OpenCode configs are already rewritten on every start.
4. **In-app relay pairing (D2, Phase 2).** Move the device-code loop from `cmdRelayLogin` into a server module
   behind authenticated endpoints: `POST /api/relay/pair` starts pairing and returns `verificationUrl` and
   `userCode`; the server polls `/api/machines/pair/complete` and writes `relay.json` (managed); the existing
   `GET /api/relay/status` reports progress. A "Pair with app.codekin.ai" control in local Settings drives it.
   The CLI command calls the same module.
5. **In-app confirm dialog (D6, only if the spike fails).** A themed `confirmDialog()` / `alertDialog()` returning
   promises, replacing every `window.confirm` / `window.alert` in `src/`, plus an ESLint `no-restricted-globals`
   rule so new ones don't creep back.

## Architecture

```
Codekin.app
├── Tauri shell (Rust)          window, menu bar icon, process supervisor
│     └── spawns ──► node (sidecar) codekin/bin/codekin.mjs app-server
│                        └── same process: server/dist/ws-server.js
│                              ├── serves dist/ + /api + WebSocket on 127.0.0.1:<port>
│                              ├── embedded relay connector (when paired)
│                              └── spawns claude / codex / opencode / grok sessions
└── WKWebView ──► http://127.0.0.1:<port>/#token=<token>
```

### Bundled payload

Inside `Contents/Resources/codekin/`, built from the **npm package itself** so the app and npm ship the same
files:

1. `npm pack` in the repo root (after `npm run build`).
2. Unpack into a staging directory and run `npm ci --omit=dev` there with the bundled Node.
3. Rebuild native modules against the bundled Node (below), then run the smoke test.

This picks up exactly the `files` field (`bin/`, `dist/`, `server/dist/`, `server/workflows/`, `server/loops/`)
and the root `dependencies`. It deliberately does **not** use `server/package.json`, whose extra dependencies
(`express-session`, `@simplewebauthn/server`) belong to the hosted relay.

The Node runtime is a pinned `aarch64-apple-darwin` build shipped as a Tauri sidecar (`bundle.externalBin`), at
`Contents/MacOS/node`. The AI CLIs and `git` / `gh` aren't bundled; the server uses the ones the user has
installed, as it does today.

### Native module: `better-sqlite3`

- Compile against the **bundled** Node's ABI: `npm rebuild better-sqlite3` run with the bundled Node binary
  (or `prebuild-install --target <node-version> --arch arm64`).
- The smoke test catches an ABI mismatch at build time instead of first launch.

## Launcher (D1)

The shell spawns `node codekin/bin/codekin.mjs app-server`. That entry point, using the shared launcher module:

1. Ensures `~/.config/codekin/` exists. On first launch it does what `codekin setup` does, non-interactively:
   generates the token (`0600`) and writes the env file with the default port and `AUTH_TOKEN_FILE`. Existing
   files are reused as-is.
2. Loads the **whole** env file into `process.env`, as `codekin start` does (`PORT`, `REPOS_ROOT`, `BIND_HOST`,
   relay settings, …). It then **forces** `FRONTEND_DIST` to the bundled `dist/`: the env file's value, if any,
   points at an npm install whose version may differ.
3. Sets `PATH` to the user's login-shell `PATH` (see [PATH](#path)).
4. Probes `http://127.0.0.1:<port>/api/ping`:
   - **Codekin answers**: prints `{"event":"attach","port":…,"version":…}` and exits 0. Two servers on the same
     `DATA_DIR` would fight over SQLite and session state.
   - **Something else answers, or the port is in use**: prints `{"event":"port_conflict","port":…}` and exits.
   - **Nothing listening**: imports `server/dist/ws-server.js` **in the same process**, and prints
     `{"event":"started","port":…,"version":…}` once the server is listening.
5. Never prints the token. The shell reads `~/.config/codekin/token` itself.

Running the server in the launcher's process (rather than a grandchild) means the shell supervises exactly one
PID, and SIGTERM goes straight to `gracefulShutdown`.

Event lines on stdout are JSON prefixed with `@@codekin `; everything else on stdout/stderr is server log output
and goes to the log file.

## Startup flow (shell)

1. Show the native splash.
2. Spawn the launcher and wait for its first event (up to about 15 s):
   - `started` or `attach`: navigate the main window to `http://127.0.0.1:<port>/#token=<token>`.
   - `port_conflict`: show an error view naming the port, with how to change it (`PORT` in
     `~/.config/codekin/env`) and **Retry**.
   - Timeout or the launcher exits without an event: show an error view with **Show logs** and **Retry**.
3. In attach mode, the shell keeps polling `/api/ping` every few seconds. If the attached server goes away, it
   starts the launcher again, which now spawns the bundled server; the window reloads when it is up.

## Server lifecycle

- Spawn the launcher in its own process group, with stdout/stderr appended to
  `~/Library/Logs/Codekin/server.log`.
- **Quit:** send SIGTERM to the **launcher PID only** and wait for it to exit. `gracefulShutdown` stops the relay
  connector and calls `sessions.shutdown()`, which stops each session process and persists state. Signalling the
  whole group at once would kill the `claude` / `codex` children while that is still running.
- **Backstop:** if the launcher hasn't exited after 15 s, send SIGKILL to the whole process group so no session
  process is orphaned.
- **Crash:** if the launcher exits unexpectedly, restart it with backoff (1 s, 2 s, 5 s, then every 10 s) and
  reload the window when it reports `started`. That gives the same robustness as the launchd service.
- In attach mode there is no child to stop: the app leaves the service running on quit.

### PATH

GUI apps launched from Finder or the Dock inherit launchd's minimal `PATH`, so they can't see Homebrew,
nvm, `~/.local/bin`, etc. Without a fix, the server can't find `claude`, `codex`, `git` or `gh`.

- The launcher runs `$SHELL -ilc 'printf %s "$PATH"'` with a 5 s timeout and uses the result. On failure it
  falls back to `/opt/homebrew/bin:/usr/local/bin:~/.local/bin` prepended to the inherited `PATH`, and logs a
  warning.
- The resolved `PATH` is captured once per launch. Installing a CLI while the app runs needs a restart from the
  menu bar icon (**Restart server**).

## First run

- If `claude` isn't found, the existing UI already reports it via `/api/health` (`claudeAvailable`). Phase 1
  checks that the message gives install steps that make sense for a user without the npm CLI.
- No repos root is asked for up front. Choices like `REPOS_ROOT` stay in the web UI and the env file.

## Window and background behaviour

The app keeps running when its window is closed, so phone sessions stay connected.

- Closing the window (or Cmd-W) hides it. A Dock click, Cmd-Tab or the menu bar icon reopens it. The Dock
  icon stays (D5).
- **Menu bar icon** (`tray-icon` feature) with Open Codekin, Keep Mac awake (toggle), Open at login
  (toggle), Restart server, Show logs and Quit Codekin.
- **Open at login** via `tauri-plugin-autostart` (registers a macOS Login Item), so Codekin is reachable
  from the phone after a reboot.
- **App Nap:** opt out with `NSProcessInfo.beginActivity(.userInitiated)` while the server is running.
  Otherwise macOS throttles the app in the background and streaming to the phone stalls.
- **Sleep:** "Keep Mac awake" holds a power assertion (`.idleSystemSleepDisabled`) that blocks idle sleep.
  It can't prevent sleep when the lid closes on battery, and the menu item's tooltip should say so.
- Cmd-Q / Quit Codekin stops the server and all sessions. If sessions are running, confirm first (the shell asks
  `/api/health` for `claudeSessions`). In attach mode Quit only closes the app.
- Remember window size and position (`tauri-plugin-window-state`). Cmd-R reloads the page.

## Repo layout

```
desktop/
  package.json            # @tauri-apps/cli as devDependency; scripts: dev, bundle-server, build
  scripts/
    bundle-server.mjs     # fetch pinned Node, npm pack → npm ci --omit=dev, rebuild better-sqlite3,
                          # run smoke test
  splash/                 # local splash / error pages (Tauri frontendDist)
  src-tauri/
    Cargo.toml
    tauri.conf.json
    capabilities/default.json
    icons/                # generated from public/favicon.svg via `tauri icon`
    binaries/             # node-<target-triple> sidecar (gitignored, produced by bundle-server)
    src/
      main.rs             # app setup, window, menu bar
      launcher.rs         # spawn launcher, parse events, supervise, shutdown
      ping.rs             # /api/ping probe for attach mode
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
- Capabilities: the splash pages (Tauri origin) get only the commands they need (`retry`, `show_logs`). The
  server origin gets **no** IPC permissions; the frontend doesn't need native APIs.

## Versioning (D4)

The app's version in `tauri.conf.json` is set from the root `package.json` at build time. A `v*` tag produces
both the npm release and the `.dmg`. The About panel shows the app version and, when attached to a service, the
version reported by that server.

## Build environment

The app can't be built or run on the Linux development host. Tauri's macOS target needs the macOS SDK, and
the payload needs a native `better-sqlite3` built for `darwin-arm64`. Work splits like this:

| Where | What |
|---|---|
| Linux dev host | The prerequisite server, CLI and frontend changes, with their unit tests. Writing `desktop/` code and the `bundle-server.mjs` script. Nothing that needs the app to run. |
| Apple Silicon Mac | The Phase 0 spike, local builds, and the manual checklist. Every phase's exit criterion is checked here. |
| CI, `macos-14` (arm64) runner | An unsigned build of `desktop/` on every PR that touches `desktop/` or the files the payload is built from, ending with the smoke test. This gives Linux-side changes build feedback before anyone opens a Mac. Later, signed release builds (Phase 3). |

## Building and installing locally

```bash
npm run build                 # existing frontend + server build
cd desktop
npm install
npm run build                 # bundle-server + tauri build
open src-tauri/target/release/bundle/macos/Codekin.app
```

Requirements: a Mac with Apple Silicon, Rust toolchain (`rustup`), Xcode Command Line Tools, Node for the build
step.

A locally built app is ad-hoc signed and runs on the machine that built it without notarization.

## Distribution (D3)

- **Signing:** Developer ID Application certificate. The sidecar `node`, `better_sqlite3.node` and every other
  Mach-O in `Resources/` must be signed with the hardened runtime. Node needs the
  `com.apple.security.cs.allow-jit` and `allow-unsigned-executable-memory` entitlements.
- **Notarization** with `notarytool` in CI, then staple the `.dmg`.
- **CI:** a `desktop` job in `publish.yml` on a `macos-14` (arm64) runner, triggered by the same `v*` tag.
  Until the Apple account exists (Phase 3a), it attaches an **unsigned** `.dmg` to the release for internal
  testers. Opening that build on another Mac needs `xattr -dr com.apple.quarantine /Applications/Codekin.app`,
  so it is not offered to users. Once the account exists (Phase 3b), the signing certificate and notarization
  credentials go into repository secrets and the job signs and notarizes.
- **Updater signing** uses Tauri's own update key (`tauri signer generate`), not the Apple certificate, so it
  is set up in Phase 3a. The private key lives in repository secrets.
- **Updates:** `tauri-plugin-updater` checks a signed `latest.json` attached to the GitHub Release. The update
  check runs at launch and daily; installing restarts the app, which stops the bundled server gracefully.
- **App translocation:** a quarantined app opened from Downloads runs from a random read-only path, and harness
  MCP configs would record that path. The `.dmg` uses the standard "drag to Applications" layout, and the app
  warns (and offers to move itself) when launched from outside `/Applications`.

## WebView differences

- WKWebView is Safari's engine, so anything that works in Chrome but not Safari behaves the same way here.
  Run the existing UI through Safari as a proxy test.
- `window.confirm` / `window.alert`: see D6.
- `navigator.clipboard.writeText` needs a user gesture in WebKit. The current call sites are click handlers;
  verify in the spike.
- Browser `Notification` API: not used by the frontend today. If desktop notifications are added later,
  route them through `tauri-plugin-notification`.
- Passkeys and GitHub OAuth are hosted-mode only and don't apply to the local app.

## Security

- Only the local server origin (`http://127.0.0.1:<port>`, `http://localhost:<port>`) and the splash pages may
  load in the main window. External links and `target=_blank` open in the default browser (intercept
  navigation / new-window requests and hand them to `tauri-plugin-opener`).
- No Tauri commands are exposed to the server origin. The shell talks to the server only over HTTP.
- `/api/ping` returns only the app name and version; it reveals nothing that the port being open doesn't.
- The token stays in `~/.config/codekin/token` with mode `0600`. It is never written to the launcher's stdout
  or the log file.
- The server keeps binding to `127.0.0.1`. LAN exposure stays an explicit opt-in via `BIND_HOST`, as
  today.

## Phases

| Phase | Scope | Exit criterion |
|---|---|---|
| 0 — Spike (Mac) | Bare Tauri window loading a running local server. Check `confirm`/`alert`, drag-and-drop, clipboard, folder picker focus, login-shell `PATH`, `better-sqlite3` under the bundled Node, App Nap. | Written findings; D6 resolved |
| Prereqs (Linux) | `/api/ping`, shared launcher + `app-server`, Codex MCP config fix; confirm dialog if D6 requires it | Merged, released in npm |
| 1 — Local app | `desktop/` package, payload, launcher supervision, splash/error views, window behaviour, attach mode, unsigned PR build job in CI | CI build green; manual checklist passes on a Mac |
| 2 — Background + pairing | Menu bar icon, open at login, keep awake, App Nap, in-app relay pairing | Phone reaches a freshly installed app via app.codekin.ai with no terminal |
| 3a — Release pipeline | Release job on the `v*` tag producing an unsigned `.dmg`, updater key and `latest.json`, move-to-Applications | A tag produces a `.dmg` that internal testers install and update |
| 3b — Signing (blocked on Apple account) | Developer ID signing with hardened runtime and entitlements, notarization, stapling | Notarized `.dmg` from a tag installs and updates on a clean Mac with no Gatekeeper warning |

## Testing

- **Build smoke test** (in `bundle-server.mjs`): `app-server` starts, `/api/ping` and `/api/health` respond, and
  SQLite opens.
- **Unit tests** for the shared launcher (env merge, `FRONTEND_DIST` override, attach / conflict / start
  decisions) and the Codex MCP config rewrite, in the existing Vitest suite.
- **Manual checklist:**
  - first launch on a machine without the CLI and with no `~/.config/codekin`, where no terminal step is
    needed
  - launch with existing config, sessions and `REPOS_ROOT`, which carry over
  - launch while `codekin service` is running, so the app attaches and doesn't spawn a second server
  - stop the attached service while the app is open, and the app takes over with its own server
  - port taken by another app, which shows the error view
  - `claude` installed via Homebrew / nvm is found when launched from the Dock
  - Joe starts and its Codekin MCP tools work, under both the app and the service (configs point at a live Node)
  - revoke an approval rule and delete an archived session (confirm dialogs)
  - native folder picker opens in front of the app window
  - drag-and-drop attachment into the composer
  - close the window, then a phone session keeps streaming; Cmd-Q stops it with no orphaned processes and
    sessions resume after relaunch
  - kill the server process, which the app restarts and the window reconnects to
  - pair with app.codekin.ai from Settings (Phase 2)
  - reboot with "Open at login" enabled, after which Codekin is reachable from the phone
