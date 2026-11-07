# Desktop App (Tauri) — Implementation Plan

Status: **In progress.** Merged: the server, CLI and launcher prerequisites (#755–#758), the server payload
builder (#759), the Tauri shell with its `macos-15` build and launch job (Phase 1), in-app relay pairing (#762),
the background features (Phase 2) and the Phase 3a release pipeline and updater; see
[Shell implementation notes](#shell-implementation-notes). Not started: the Phase 0 spike on a Mac, the manual
checklists, Phase 3b. The first release needs the updater signing key (setup in `desktop/README.md`). The decisions in
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
- Intel Macs, Windows and Linux builds in v1. Only Apple Silicon (`aarch64-apple-darwin`) is targeted. Windows is a
  separate later track, because the server itself doesn't run on Windows yet; see [Windows](#windows).
- Installing or logging in to the AI CLIs. `claude`, `codex`, `opencode` and `grok` keep their own installers
  and login flows, which do need a terminal. The app detects them and explains what is missing (see
  [First run](#first-run)).

## Decisions

D1–D6 confirmed 2026-11-06; D7 and D8 settled when implementation started (same day). Each one is referenced
from the section it shapes.

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Where does setup, env and start logic live? | In **Node**, in a launcher shared with the CLI. The Rust shell only spawns, watches and stops one Node process. | `codekin setup` / `start` already own the token, the env file and `FRONTEND_DIST` resolution. A Rust copy would drift from them. |
| D2 | Is relay pairing in scope? | **Yes, required before the first public release**, built as an in-app device-code flow (Phase 2). | Without it, phone access through app.codekin.ai needs `codekin relay login` in a terminal, which contradicts the goal. The flow is small: the CLI's device-code loop moves into the server. |
| D3 | Signing, distribution and updates | Phase 1 builds are local and ad-hoc signed. A public `.dmg` needs an Apple Developer ID under Multiplier Labs, notarization in CI, and `tauri-plugin-updater` verifying signed update artifacts referenced by a manifest on GitHub Releases. Work proceeds **without** the Apple account: everything up to and including unsigned CI builds and the updater is built first, and only Developer ID signing and notarization (Phase 3b) wait for it. | An app that bundles its server goes stale without an updater. Notarization is needed for anyone else to open it without Gatekeeper workarounds. **Owner of the Apple account not yet named.** |
| D4 | App version | **Same version as the npm package**, released from the same `v*` tag. | One number in bug reports, and the About panel always matches the bundled server. A shell-only fix ships as a patch release. |
| D5 | Dock icon when no window is open | **Keep the Dock icon** in v1. No `ActivationPolicy::Accessory` switching. | Switching policy at runtime has focus quirks, and the menu bar icon already shows that Codekin is running. Revisit after v1. |
| D6 | `window.confirm` / `window.alert` | Gate on the spike (Phase 0). If WKWebView under Tauri doesn't show them, replace them with an in-app confirm dialog before Phase 1 ships. | ~24 call sites (approvals, archived sessions, …). If the host doesn't implement the WebKit panels, `confirm()` returns `false` silently and those actions do nothing. |
| D7 | How is the data-directory lock taken? | A SQLite lock database in `DATA_DIR`, opened with `better-sqlite3` in `PRAGMA locking_mode = EXCLUSIVE` and held by an open write transaction for the server's lifetime. A second owner gets `SQLITE_BUSY` immediately (`busy_timeout = 0`) and reports `data_in_use`. | Node has no built-in file lock. `proper-lockfile` decides staleness by mtime, which the ownership rules forbid, and `fs-ext` adds a second native module to rebuild. SQLite's lock is an OS `fcntl` lock the kernel drops when the process dies, so a crash never leaves a stale owner, and `better-sqlite3` already ships. |
| D8 | How does the shell spawn the launcher? | Rust's `std::process::Command`, with `process_group(0)`, stdin as the lifetime pipe and fd 3 as the credential pipe. `bundle.externalBin` only places and signs `node`; the shell resolves its path next to the app executable. | `tauri-plugin-shell`'s sidecar API can't set a process group or pass extra file descriptors. Stdin as the lifetime pipe needs no extra fd: its EOF is the shell-crash signal, and the launcher doesn't otherwise read stdin. |

## Relationship to the CLI and the service

The app is **standalone**. A user who only installs the app never needs a terminal, `codekin setup`,
`codekin start` or `codekin service install`. It doesn't replace the service either, and the two coexist:

| Situation | App behaviour |
|---|---|
| Only the app is installed | App does first-run setup itself and runs its own bundled server |
| `codekin service` is installed and running | App attaches to the running server and doesn't start a second one |
| Service installed but stopped | App starts its own bundled server on the configured port |
| Service starts while the app's server is running | The shared data-directory lock rejects the second server before it opens state; a separate port does not bypass this protection |
| Attached service stops while the app is open | The supervisor takes over only after the ownership and compatibility checks below pass; otherwise it shows a recovery view |

Both use `~/.config/codekin` and, by default, `~/.codekin`; honor an existing `DATA_DIR` override. Sessions,
settings, credentials and relay pairing carry over when both use the same configuration. When attached, the window shows the service's frontend and the About
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
   `codekin app-server` entry point for the app (see [Launcher](#launcher-d1)). Put exclusive data-directory
   ownership enforcement (D7) in server startup too, so direct server entry points cannot bypass it, together
   with the writer-version marker that refuses to run an older server against newer data (see
   [Exclusive ownership and compatibility](#exclusive-ownership-and-compatibility)). Existing service
   installations must be upgraded to this prerequisite release before automatic takeover is supported.
3. **Codex MCP config keeps up with the Node path.** `ensureCodexMcpConfig` (`server/orchestrator-manager.ts`)
   is append-only: once a `[mcp_servers.codekin]` section exists, it is never rewritten. It records
   `process.execPath` and the server script path, which for the app are paths inside `Codekin.app`. If the
   section was written by the npm install, or by an app at an older location, Codex keeps the stale path. Change
   it to rewrite the `command` and `args` of an existing `codekin` section when they differ. The Claude and
   OpenCode configs are already rewritten on every start. **Implemented** (`upsertCodexMcpSection` in
   `server/orchestrator-manager.ts`): a text edit of only those two keys, keeping other keys in the section,
   other sections and comments byte for byte.
4. **In-app relay pairing (D2, Phase 2).** Move the device-code loop from `cmdRelayLogin` into a server module
   behind authenticated endpoints: `POST /api/relay/pair` starts pairing and returns `verificationUrl` and
   `userCode`; the server polls `/api/machines/pair/complete` and writes `relay.json` (managed); the existing
   `GET /api/relay/status` reports progress. A "Pair with app.codekin.ai" control in local Settings drives it.
   The CLI command calls the same module. **Implemented** (`server/relay/pairing-client.ts`,
   `server/relay/pairing-local-routes.ts`, Settings → This machine → Remote access): also `GET` / `DELETE
   /api/relay/pair` (state, cancel) and `POST /api/relay/unpair`. The verification URL must be on the relay's own
   origin, relay URLs must be `https://` (loopback `http://` for relay development), and none of `/api/relay/*` is on
   the connector's proxy allowlist, so the hosted relay can't pair or unpair a machine.
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
2. Unpack into a staging directory. Copy the root `package-lock.json` from the **same source commit** into
   staging: npm excludes it from packed packages. Keep the packed `package.json` unchanged and run
   `npm ci --omit=dev` using the pinned Node and its matching npm, with that Node first on the build `PATH`.
   A missing or out-of-sync lockfile fails the build; do not fall back to an unlocked install.
3. Rebuild native modules against the bundled Node (below), then run the isolated smoke test.

Record the Node version and download checksum in the build configuration. Assert `darwin` / `arm64` before
installing native dependencies. npm is build tooling and does not need to ship in the app.

**Implemented** (`desktop/scripts/bundle-server.mjs`). Details found while building it:
- `better-sqlite3` 13 is a Node-API module with prebuilt binaries inside its package and `gypfile: false`, so
  `npm install` compiles nothing and npm 11's install-script blocking doesn't apply. `npm ci` is the exception:
  the lockfile doesn't record `gypfile`, so npm infers `node-gyp rebuild` from the shipped `binding.gyp` and
  fails without a compiler. No production dependency needs an install script, so the builder runs
  `npm ci --ignore-scripts`. (Up to 0.9.10, on
  `better-sqlite3` 12, the builder wrote a build-only `.npmrc` with `allow-scripts=better-sqlite3` and checked
  the compiled addon existed.) The builder still loads it under the pinned Node before packaging, and deletes
  the lockfile. The packed `package.json` ships unchanged.
- `--target linux-x64` / `linux-arm64` run the same steps on Linux. The target must match the host, because
  the payload is checked by running the pinned Node.
See [npm's package inclusion rules](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files).

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

1. Ensures `~/.config/codekin/` exists. On first launch it generates a token (`0600`) and writes the env
   file with the default port and `AUTH_TOKEN_FILE`. Reuse existing configuration and custom credentials;
   generate a default token only when no credential is configured. An explicitly configured but unreadable
   token file is a configuration error, not permission to silently replace it.
2. Loads the **whole** env file over the inherited environment, as `codekin start` does (`PORT`, `DATA_DIR`,
   `REPOS_ROOT`, `BIND_HOST`, relay settings, …). It then **forces** `FRONTEND_DIST` to the bundled `dist/`.
   This affects the owned server only; attach mode keeps using the running service's frontend.
3. Sets `PATH` to the user's login-shell `PATH` (see [PATH](#path)). Resolves credentials with the same
   shared resolver as the server: effective `AUTH_TOKEN` first, otherwise effective `AUTH_TOKEN_FILE`.
   The shell must not independently assume `~/.config/codekin/token` is the effective credential.
4. Probes `http://127.0.0.1:<port>/api/ping` with a bounded timeout, then authenticates `/api/health`:
   - **Codekin answers and authentication succeeds**: prints `{"event":"attach","port":…,"version":…}`
     and exits 0. Record this server version for takeover checks below.
   - **Codekin answers but authentication fails**: emit `auth_error`; show how to correct the effective
     credential. Do not spawn, overwrite credentials or send the token to another origin.
   - **An occupied port has no valid ping**: emit `port_conflict`. Explain that this may be an older Codekin
     service lacking `/api/ping`, and offer instructions to upgrade or stop it. Never automatically kill it.
   - **Connection refused**: attempt exclusive ownership of the canonical `DATA_DIR`, then import
     `server/dist/ws-server.js` **in the same process**. Emit `started` only after listening and authenticated
     health readiness. A probe timeout is not evidence that nothing is listening.
5. Supply the effective credential to Rust through a dedicated inherited private pipe (fd 3, D8), separate
   from stdout, stderr and ordinary lifecycle events. Read this handoff before handling `attach` exit. Never put credentials
   in command-line arguments, event lines, error messages or logs. Close the pipe when the handoff finishes.

### Exclusive ownership and compatibility

- Acquire an OS-backed exclusive lock (D7) on the canonical data directory **before** constructing `SessionManager`,
  opening SQLite, migrating data or restoring sessions. Hold it for the server's lifetime. All server entry
  points use this guard; a different port does not permit a second owner. Do not use a check-then-create PID
  file or decide a lock is stale merely because an HTTP probe timed out.
- A lock conflict emits `data_in_use`. Re-probe for an attachable server; otherwise show a recovery view.
  A bind race similarly returns to probing after releasing ownership safely. Never retry by starting an
  unguarded second server. Older servers lack this lock: automatic takeover from them is unsupported.
- Attach may display a different-version service's own frontend after successful authentication. It must not
  change that service's files, MCP config or data. A missing `/api/ping` requires upgrading the service first.
- For v1, automatic takeover requires an attached server at the **same version** as the bundled server and
  support for the ownership prerequisite (the desktop release sets a minimum supported server version). If versions differ, explain how to align them and require an explicit
  retry after that action; do not silently run an older bundled server against newer data.
- Persist the last writer version in the data directory under the lock. Reject startup with an older server
  version before touching application state. Forward upgrades use the server's migrations; automatic
  downgrades are unsupported. Compare versions as semver, not strings. Legacy data without a writer marker
  is recorded by the first guarded server; an old service still running on the configured port is caught by
  the launcher's probe (attach or `port_conflict`) before that. Do not claim this guard protects against an
  old binary that predates it.
- **Implemented** (`server/data-ownership.ts`, `server/data-ownership-boot.ts`, imported first by
  `ws-server.ts`). Locked roots are `DATA_DIR` **and** `~/.codekin`, deduplicated by realpath: `DATA_DIR`
  only relocates part of the state, and the session archive, run database, webhook / hook / workflow /
  deployment config and PR cache always live in `~/.codekin`. Each root gets `.codekin-owner.sqlite` with a
  `meta` table (`writer_version`, `owner_pid`, `owned_since`); acquisition is all or nothing. A conflict or a
  newer marker exits the server with status 1 and, in app mode, emits `data_in_use` (`dir`) or `data_newer`
  (`dir`, `writerVersion`, `version`). Moving those hardcoded paths under `DATA_DIR` is a separate change, since
  it would relocate existing users' archives.
- Install desktop single-instance handling before spawning a launcher. A second app invocation focuses the
  existing window. The server lock remains necessary for races involving the CLI and service.

Running the server in the launcher's process (rather than a grandchild) means the shell supervises exactly one
PID, and SIGTERM goes straight to `gracefulShutdown`.

Event lines on stdout are JSON prefixed with `@@codekin `; everything else on stdout/stderr is server log output
and goes to the log file.

### Launcher contract (implemented)

`bin/lib/launch.mjs` (shared helpers) and `bin/lib/app-server.mjs` (the flow above). Invocation:

```
node codekin/bin/codekin.mjs app-server --credential-fd=3 --lifetime-stdin
```

- `--credential-fd=N` (N > 2): one JSON line `{"token":…,"source":"AUTH_TOKEN"|"AUTH_TOKEN_FILE"}` is written
  and the fd closed, before any outcome event.
- `--lifetime-stdin`: EOF on stdin sends the launcher SIGTERM (graceful shutdown), with a 15 s SIGKILL of
  the process group as backstop. When the launcher leads its process group, its `exit` handler SIGKILLs any
  remaining group members, which also covers the `process.exit(0)` at the end of `gracefulShutdown`.
- `PATH`: an explicit `PATH` in the env file wins; otherwise the login-shell `PATH`. `CODEKIN_LOGIN_PATH=0`
  skips the login shell (tests and the smoke test).
- The server signals binding in-process through `server/server-lifecycle.ts` (`listening`, `listen_error`).
  A failed bind now exits the server with status 1 for every entry point, instead of leaving a process that
  serves nothing.

| Event | Fields | Exit | Meaning |
|---|---|---|---|
| `started` | `port`, `host`, `version`, `pathSource` | keeps running | Owned server is listening and answered an authenticated `/api/health` |
| `attach` | `port`, `host`, `version` | 0 | A Codekin server accepted the credential |
| `config_error` | `reason`, `source` | 2 | Credential configured but unreadable, bad arguments, or no compiled server |
| `auth_error` | `port`, `host`, `version`, `source` | 3 | Codekin answered but rejected the credential |
| `port_conflict` | `port`, `host` | 4 | Something that isn't Codekin, or a Codekin release without `/api/ping` |
| `unresponsive` | `port`, `host` | 5 | Probe timed out or failed, or the started server failed its readiness check |
| `bind_failed` | `port`, `host`, `reason` | 1 | Lost a bind race after a refused probe; re-run the full flow |

| `data_in_use` | `port`, `host`, `dir` | 1 | Another server owns a state directory (D7) |
| `data_newer` | `port`, `host`, `dir`, `writerVersion`, `version` | 1 | The data was written by a newer Codekin; downgrades are refused |

## Startup flow (shell)

1. Show the native splash.
2. Spawn the launcher and wait for its first event (up to about 15 s):
   - `started` or `attach`: navigate the main window to `http://127.0.0.1:<port>/#token=<token>`.
   - `port_conflict`, `auth_error`, `config_error`, `data_in_use` or `data_newer`: show the corresponding recovery
     instructions, **Show logs** and **Retry**. Never retry by overwriting configuration or killing a service.
   - `unresponsive` or `bind_failed`: show the error view with **Retry**; Retry re-runs the full flow.
   - Timeout or the launcher exits without an event: show an error view with **Show logs** and **Retry**.
     Stop and reap any still-running owned launcher before Retry can create another one.
3. In attach mode, poll `/api/ping` every 3 s with a 2 s request timeout. After three consecutive failures,
   show reconnecting status. HTTP errors or timeouts alone never trigger takeover. Require connection refusal,
   the version checks above and successful exclusive-lock acquisition before starting the bundled server.
   If the service recovers or wins the startup race, authenticate and attach again. Reload only after readiness.

## Server lifecycle

- Spawn the launcher in its own process group (D8), with stdout/stderr appended to
  `~/Library/Logs/Codekin/server.log`.
- **Quit:** send SIGTERM to the **launcher PID only** and wait for it to exit. `gracefulShutdown` stops the relay
  connector and calls `sessions.shutdown()`, which stops each session process and persists state. Signalling the
  whole group at once would kill the `claude` / `codex` children while that is still running.
- **Backstop:** track the owned process group independently of the launcher PID. After graceful shutdown,
  clean up any remaining owned group members even if the launcher has already exited. Escalate to SIGKILL
  after 15 s and verify cleanup before releasing the supervisor to start a replacement. Never target an
  attached service's group. Harnesses must not leave untracked detached children; verify this on the Mac.
- **Server crash:** clean up surviving members of the old owned group before restarting with backoff
  (1 s, 2 s, 5 s, then every 10 s). Re-enter the full probe / lock / readiness flow: another service may have
  started in the meantime, so handle `attach` as well as `started`.
- **Shell crash:** a separate inherited lifetime pipe (the launcher's stdin, D8) remains open for the owned launcher's lifetime.
  EOF makes the launcher stop via `gracefulShutdown`, with a 15 s whole-group kill backstop. The app-mode
  shutdown path must perform its final descendant cleanup before exiting, rather than canceling that backstop
  when `gracefulShutdown` calls `process.exit`. This is separate
  from the short-lived credential handoff. A new shell invocation must wait for ownership and cleanup;
  it must not spawn a competing server during that shutdown. Test forced shell termination on a Mac.
- **Restart server:** available only for an owned server and uses the same shutdown / cleanup / startup flow.
  In attach mode disable it with an explanation that the CLI/service manages that server.
- In attach mode there is no child to stop: the app leaves the service running on quit.

### PATH

GUI apps launched from Finder or the Dock inherit launchd's minimal `PATH`, so they can't see Homebrew,
nvm, `~/.local/bin`, etc. Without a fix, the server can't find `claude`, `codex`, `git` or `gh`.

- The launcher invokes `$SHELL -ilc` with a command that prints `$PATH` between unique delimiters, using a
  5 s timeout. It captures only that delimited value so shell startup banners cannot corrupt it. On failure, prepend
  `/opt/homebrew/bin`, `/usr/local/bin` and `join(homedir(), '.local/bin')` to the inherited `PATH`, and log a
  warning. Expand the home directory explicitly: a literal `~` in an environment PATH is not expanded.
- The resolved `PATH` is captured once per launch. Installing a CLI while the app runs needs a restart from the
  menu bar icon (**Restart server**).

## First run

- If `claude` isn't found, the existing UI already reports it via `/api/health` (`claudeAvailable`). Phase 1
  checks that the message gives install steps that make sense for a user without the npm CLI.
- No repos root is asked for up front. Choices like `REPOS_ROOT` stay in the web UI and the env file.

### Shell implementation notes

What the Phase 1 shell does today, and where it differs from the text above:
- **Spawning (D8):** `std::process::Command` with `process_group(0)`, stdin as the lifetime pipe and fd 3
  (via `command-fds`) for the credential. Tauri's `externalBin` only places `node` next to the executable.
- **First-event timeout** is 45 s, not 15 s: server boot runs the harness CLI probes, which have 5 s timeouts
  each.
- **Quit:** a custom app menu replaces the default one, so Cmd-Q runs the Quit flow (session check, native
  confirmation, supervisor shutdown) instead of terminating at once. `ExitRequested` from any other source is
  also routed through it. The menu adds **Restart Server** (owned server only), **Show Logs** and View → Reload
  (Cmd-R); the Edit menu is needed for copy and paste in the webview.
- **Attach mode** polls `/api/ping` every 3 s. Three failures show the reconnecting view; three
  connection-refused results at the same version re-run the launcher flow (which must still win the D7 lock),
  at a different version they show the error view.
- **Logs:** `~/Library/Logs/Codekin/server.log` on macOS, the Tauri app log directory elsewhere. Launcher
  stdout written after the shell dies is lost (its reader is gone); stderr goes straight to the file.
- **Links:** `target=_blank` and `window.open` go to the default browser through `on_new_window` (never a
  second app window), like other external navigations.
- **Phase 2 (background):** the menu bar icon (template image) has Open Codekin, Keep Mac Awake, Open at
  Login, Restart Server, Show Logs and Quit Codekin. Where it differs from the text below:
  - *Keep Mac awake* runs `/usr/bin/caffeinate -i -w <app pid>` instead of calling IOKit: the same
    idle-system-sleep assertion, no FFI, and `-w` ends it with the app even after a crash. The choice is saved in
    the app config directory (`prefs.json`) and restored at launch. Menus have no tooltips on macOS, so a
    disabled line under it says it can't stop lid-closed sleep on battery.
  - *Open at login* uses `tauri-plugin-autostart` in `LaunchAgent` mode (a plist in `~/Library/LaunchAgents`)
    rather than an AppleScript login item, which would need an Automation permission prompt.
  - *App Nap* is disabled with `NSAppSleepDisabled` in Info.plist, not `beginActivity`. Whether that also
    keeps the server child unthrottled needs checking on a Mac (Phase 2 manual checklist).
  - In-app pairing: Settings → This machine → Remote access (#762).
- **Phase 3a (release pipeline):** the `desktop` job in `publish.yml` publishes each `v*` tag as a GitHub
  **prerelease** with the `.dmg` and the signed `.app.tar.gz` + `.sig`, then replaces `latest.json` on the
  rolling `desktop-channel` prerelease (the updater endpoint), after checking the artifact URL answers. A rolling
  channel release, rather than `releases/latest`, keeps the updater independent of which release GitHub marks
  Latest and lets the builds stay prereleases. `requireSignedVersion` is on from the first release. The update
  flow (`src-tauri/src/updater.rs`) follows "Updates" above; the supervisor's `StopForUpdate` stops an owned
  server without relaunching and reports whether its process group is gone. Move to Applications
  (`relocate.rs`) copies with `ditto` and removes quarantine from the copy only (as LetsMove does), so the
  moved copy isn't translocated again; it falls back to `~/Applications` when `/Applications` isn't writable,
  and never overwrites an existing copy. Key setup: `desktop/README.md`.
- **Icon:** the Codekin mark on a dark ink plate on Apple's 1024 grid, rendered from `desktop/icons-src/` (see its README).
- **Not yet:** Phase 3b.
- **Checked on Linux under Xvfb** (WebKitGTK, not WKWebView): first launch generates the credential and
  shows the live UI; the port-conflict error view, Retry, Ctrl+Q graceful quit, and SIGKILL of the shell
  (the launcher stops the server through stdin EOF) all work. That run found the WebSocket Origin bug fixed
  in #760.

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
  node-runtime.json       # pinned Node version + SHA-256 per target (from nodejs.org SHASUMS256.txt)
  scripts/
    bundle-server.mjs     # fetch + verify pinned Node, npm pack → lockfile → npm ci --omit=dev with
                          # that Node (better-sqlite3 built for its ABI), sidecar, smoke test
    smoke-test.mjs        # isolated app-server run against the payload (also runnable alone)
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
| CI, `macos-15` (arm64) runner | An unsigned build of `desktop/` on every PR that touches `desktop/` or the files the payload is built from, ending with the smoke test. This gives Linux-side changes build feedback before anyone opens a Mac. Later, signed release builds (Phase 3). |

Use the supported ARM64 `macos-15` label and assert `uname -m` is `arm64`; fail rather than accidentally
building an Intel payload. Recheck runner availability when implementing CI against the
[GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

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
- **CI:** a `desktop` job in `publish.yml` on a `macos-15` (arm64) runner, triggered by the same `v*` tag.
  Until the Apple account exists (Phase 3a), it attaches an **unsigned** `.dmg` to the release for internal
  testers. Opening that build on another Mac needs `xattr -dr com.apple.quarantine /Applications/Codekin.app`,
  so it is not offered to users. Once the account exists (Phase 3b), the signing certificate and notarization
  credentials go into repository secrets and the job signs and notarizes.
- **Updater signing** uses Tauri's own update key (`tauri signer generate`), not the Apple certificate, so it
  is set up in Phase 3a. The private key lives in repository secrets.
- **Update artifacts:** in Phase 3a set `bundle.createUpdaterArtifacts: true`, configure the updater public
  key and HTTPS manifest endpoint, and publish the macOS `.app.tar.gz` plus its `.sig` alongside the `.dmg`.
  `latest.json` includes the version and a `darwin-aarch64` entry containing the archive URL and signature.
  The updater verifies the **artifact**, not a signature on `latest.json`. Publish the manifest only after
  the complete artifact set is available. See the [Tauri updater contract](https://v2.tauri.app/plugin/updater/).
- **Updates:** check at launch and daily; offer Install / Later through native shell UI, since the server
  origin has no IPC permissions. If owned sessions are active, explain that installation interrupts them and
  require confirmation. If health cannot be read, treat session activity as unknown and still confirm.
  Download and verify first, disable automatic server restart, then await owned-server shutdown and group
  cleanup before replacing the app and relaunching. Failed cleanup blocks installation; download or signature
  failures leave the current app running. In attach mode update only the app and leave the service running.
  After relaunch use the usual compatibility checks; an app update does not update an attached service.
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
- No Tauri commands are exposed to the server origin. The shell uses authenticated HTTP for server APIs;
  the launcher's private credential and lifetime pipes are available only to its parent process.
- `/api/ping` returns only the app name and version; it reveals nothing that the port being open doesn't.
- The generated default token stays in `~/.config/codekin/token` with mode `0600`; existing `AUTH_TOKEN` or
  custom `AUTH_TOKEN_FILE` settings retain their precedence. No effective token is written to the launcher's
  stdout or the log file. Disable HTTP redirects for credential-bearing readiness requests.
- The server keeps binding to `127.0.0.1`. LAN exposure stays an explicit opt-in via `BIND_HOST`, as
  today.

## Windows

Not part of v1. Recorded here so the macOS work doesn't close doors, and so the order of work is agreed.

### The blocker is the server, not the shell

Codekin doesn't run on Windows today. The README says so ("Windows isn't supported yet"), `server/` and `bin/`
have no `win32` handling, and CI runs on Linux only. Known breakages from reading the code (not yet measured):

| Area | Problem on Windows |
|---|---|
| Finding harness CLIs | `server/config.ts` resolves `claude` with `which`, which doesn't exist. Node refuses to `spawn` an npm-installed `claude.cmd` / `codex.cmd` without `shell: true`, so harness launches fail even with the fallback. |
| Stopping processes | Session stop and shutdown use SIGTERM / SIGKILL. Windows has no POSIX signals or process groups; killing a process tree needs `taskkill /T` or a Job Object. |
| Shell assumptions | Command approvals, worktree handling and git helpers assume a POSIX shell and `/` paths. Scope unknown until measured. |
| Service | `codekin service` supports launchd and systemd only. No Windows service or Task Scheduler entry. |
| Token file | Mode `0600` has no effect; the token file needs an ACL limited to the current user. |
| Native folder picker | `server/native-folder-picker.ts` uses `osascript`; Windows needs another implementation or none. |
| Harnesses | Support varies by harness. Claude Code has a native Windows build; others may require or recommend WSL. Each one needs checking. |

### Order of work

The server port is planned in detail in [WINDOWS-PORT-PLAN.md](WINDOWS-PORT-PLAN.md).

1. **Measure.** Add a `windows-latest` job to `ci.yml` that runs the existing test suite, reporting but not
   blocking PRs. The failures become the porting backlog.
2. **Port the server and CLI** to run natively: harness discovery and launch (`where`, `.cmd` shims), process-tree
   termination, path and shell handling, token file ACL, and at least one supported harness end to end. Make the
   Windows CI job blocking once it passes. This is useful on its own: `npx codekin` would then work on Windows.
3. **Build the Windows app**, reusing the Tauri shell and the shared launcher (D1).

Running the server inside WSL from a Windows shell is **not** the plan. It would skip the port but bring in a WSL
dependency, networking between Windows and WSL, and path translation between the two filesystems, for a worse
result than a native port.

### What carries over to the Tauri shell

| Concern | macOS plan | Windows |
|---|---|---|
| Webview | WKWebView; `confirm`/`alert` gated on the spike (D6) | WebView2 (Chromium); `confirm`/`alert` work, D6 doesn't apply |
| Background | Menu bar icon, App Nap opt-out, Keep Mac awake | System tray icon; `SetThreadExecutionState` for keep-awake; no App Nap |
| Open at login | `tauri-plugin-autostart` (Login Item) | Same plugin (registry Run key) |
| `PATH` | Login-shell `PATH` capture | Not needed: GUI apps get the user's `PATH` |
| Shutdown | SIGTERM launcher, then SIGKILL the process group | Ask the launcher to stop (stdin message or local HTTP), then kill the process tree / Job Object |
| Bundled Node and `better-sqlite3` | `darwin-arm64` | `win32-x64` (and `win32-arm64` if wanted) |
| Updater | `tauri-plugin-updater` | Same plugin, same `latest.json` |
| Installer | `.dmg` | NSIS `.exe` (or MSI) |

Keep the shell's platform code behind small modules (`launcher.rs` shutdown, keep-awake, `PATH`) so a Windows
implementation slots in without restructuring.

### Where it gets built and tested

| Where | What |
|---|---|
| CI `windows-latest` (x64) | Test suite (step 1), then unsigned app builds on PRs and the release job on the `v*` tag, alongside the macOS job. Free for this public repository. `windows-11-arm` is available if ARM builds are wanted. |
| A Windows machine or VM | Manual checklists. A Windows PC, a cloud VM, or Windows 11 on Arm in Parallels on an Apple Silicon Mac. Parallels runs x64 builds under emulation, so it's fine for checking behaviour but not for judging performance. |
| Linux dev host | Writing code. Cross-compiling with `cargo-xwin` (NSIS only, experimental in Tauri) is possible, but nothing can run here, so CI is the build of record. |

### Signing

Unsigned installers trigger SmartScreen warnings. Options are Azure Trusted Signing (subscription) or an OV / EV
code-signing certificate. Like the Apple account (D3), this is an account decision that blocks only the signing
step.

## Phase 4: hosted locations in the app (planned)

Status: **implemented, not yet tested on a Mac.** Decisions D9–D12 confirmed 2026-11-07; relay and hosted UI in
#774 (4a), app in #775 (4b), both released in 0.10.0. The end-to-end manual checks below are still open.

### Goal

Use the desktop app as a client for hosted Codekin too: open app.codekin.ai, or any self-hosted relay
(docs/SELF-HOSTED-RELAY.md), in the app window, and switch between several. Users at companies with their own
relay, or with more than one (regions, teams), pick the location instead of keeping browser tabs. "This Mac"
(the bundled or attached local server) stays a location of its own, and the local server keeps running while
another location is shown, so the Mac stays reachable from the phone.

### Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| D9 | How does the app sign in to a hosted location? | **In the system browser, handed back by deep link**: the app opens the relay's desktop sign-in page in the default browser; after GitHub OAuth and 2FA there, the relay redirects to `codekin://auth` with a one-time code; the app redeems it in its webview, which then holds its own session cookie. | GitHub discourages OAuth in embedded webviews, and WebAuthn (passkeys) in WKWebView only works for Developer ID-signed apps with an Associated Domains entitlement per relay domain, which self-hosted relays can't easily get. The browser already has the user's GitHub session and passkeys. |
| D10 | One location at a time, or several windows? | **One main window, one location at a time** in v1, switched from the app menu and the menu bar icon. | Matches the single-window shell. Separate windows can come later on the same location model. |
| D11 | Where are locations stored, and how are sessions kept apart? | In the shell's `prefs.json` (`locations: [{ id, name, url }]`; "This Mac" is implicit). Each hosted location gets its own **WebKit data store** (macOS 14+, `WKWebsiteDataStore(forIdentifier:)`, exposed by Tauri as `data_store_identifier`, a 16-byte id derived from the location id), so cookies never mix between relays or with the local origin. The app supports macOS 12, so on 12–13 all locations share the default store; cookies are still per origin, but removing a location has to clear that origin's data explicitly. | Removing a location deletes its data store, which signs it out cleanly. |
| D12 | Step-up checks inside the hosted UI (the relay's "recent second factor" for sensitive actions) | TOTP works in the webview. A passkey step-up is sent to the browser via the same handoff, marking the webview's session as recently verified. In-webview passkeys wait for Phase 3b (Developer ID) and only for app.codekin.ai's domain. | Keeps passkey-only accounts usable without Associated Domains. |

### Location model and UI

- **Adding a location:** a bundled page (Tauri origin, like the splash) asks for a name and an `https://` URL. The
  shell checks it is a Codekin relay through a new unauthenticated identity endpoint,
  `GET /api/relay/info` → `{ "app": "codekin-relay", "version", "name" }` (the relay analogue of `/api/ping`),
  before saving. `http://` is accepted only for loopback, for relay development.
- **Switching:** app menu → Location → *This Mac* / each saved location / *Add Location…* / *Manage Locations…*;
  the menu bar icon gets the same submenu. The last-used location reopens at launch.
- **Window guard:** the navigation allowlist becomes "the selected location's origin" (plus the bundled pages).
  Everything else still opens in the default browser, and remote origins still get **no IPC**
  (no `remote` capability), so a compromised relay page can't reach the shell.
- **Signed out:** when the hosted UI reports no session, the shell shows a bundled "Sign in to <name>" page with
  a button that starts the D9 handoff.

### Sign-in handoff (D9)

1. The shell generates `state` and a PKCE pair (`code_verifier`, `code_challenge = S256(verifier)`), and opens
   `https://<relay>/api/auth/desktop/start?state=…&code_challenge=…&code_challenge_method=S256` in the default
   browser. (Every handoff route is under `/api/`: deployments, including the nginx config in
   SELF-HOSTED-RELAY.md, only send `/api/` and `/relay/` to the relay.)
2. `start` records the request (10 minutes to finish) and sends the browser to the hosted page
   `/desktop-auth?request=<id>`. Signed out, that runs the normal sign-in (GitHub OAuth, then TOTP or passkey) and
   comes back through the `returnTo` allowlist. The page asks "The Codekin desktop app is asking to sign in to
   <relay> as @login" (so a link someone else started can't sign an app in silently); approving needs a recent
   check, like device linking, and mints a **one-time code** bound to the user, `state` and `code_challenge`
   (60 s TTL, single use). The browser goes to `codekin://auth?relay=<origin>&code=…&state=…` and says "You can
   return to Codekin".
3. `tauri-plugin-deep-link` delivers the URL to the running app (via the single-instance plugin when the app
   is already open). The shell checks `state` and that `relay` is the origin it started with.
4. The shell navigates the location's webview to `https://<relay>/api/auth/desktop/claim` with a POST of `code` and
   `code_verifier` (a bundled auto-submitting form). The relay verifies both, creates a normal session for the
   webview's data store (`codekin_relay_sid`, SameSite=Lax, same lifetime and revocation as a browser session),
   and redirects to `/`.

PKCE is what makes the custom URL scheme safe: another app that registers `codekin://` and steals the code
can't redeem it without the verifier, which never leaves the shell. `claim` is the one mutation exempt from the
same-origin guard (its credential is in the body), so it also requires the `CodekinDesktop/` user-agent token:
otherwise any web page could post an attacker's own code and verifier from a victim's browser and sign that
browser in as the attacker. Sessions created this way are marked `client: desktop` and listed under
**Settings → Devices → Desktop apps** in the hosted app, each with its own sign-out.

### Relay changes (Phase 4a)

**Implemented** (#774; `server/relay/desktop-auth.ts`, `desktop-auth-routes.ts`):
- `GET /api/relay/info` → `{ app: "codekin-relay", version, name }`, public; `name` is `RELAY_NAME`, else the
  public host.
- `GET /api/auth/desktop/start`, `GET /api/auth/desktop/requests/:id`, `POST …/requests/:id/approve` (signed in,
  recent check) and `POST /api/auth/desktop/claim`, under the `/api/auth` rate limit. Requests and hashed codes
  live in `desktop_auth_requests` (migration 6). A wrong verifier burns the code; "sign out everywhere" revokes
  unclaimed codes. Audit events `desktop_auth_approved`, `desktop_signed_in`, `desktop_session_revoked`.
- The redirect target is fixed to `codekin://auth`; never taken from the request.
- `GET/DELETE /api/me/desktop-sessions` for the Desktop apps list (opaque handles, never session ids).
- Hosted UI in the app (user agent contains `CodekinDesktop/`): the login page shows "Sign in with your
  browser" (`codekin://sign-in`); passkeys are hidden (D12) and step-up offers "Use a passkey in your browser"
  (`codekin://sign-in?reason=step_up`); TOTP works inline.

### App changes (Phase 4b)

**Implemented** (`desktop/src-tauri/src/locations.rs`, pure and unit-tested; `hosted.rs`, the Tauri side;
bundled pages in `desktop/splash`). The Quit / update / supervisor flows are unchanged: they always concern the
local server, whichever location is on screen.

- **Windows.** `main` stays This Mac and the supervisor keeps driving it. A hosted location opens in its own
  window (`location-<n>`), because a webview's data store is fixed when it is created; it takes `main`'s frame,
  `main` is hidden, and at most one location window exists. Closing it hides it, like `main`. The Dock icon,
  the menu bar icon's *Open Codekin* and a second launch show whichever window is current. `main` starts
  hidden and is shown once the last-used location is known.
- **Data stores.** `data_store_identifier` is the first 16 bytes of `sha256("codekin-location:" + id)`. wry
  uses it on macOS 14+ and falls back to the default store on 12–13. Removing a location first signs it out on
  the relay (`POST /api/auth/logout` from a hidden window on the same store, so 12–13 are covered too), then
  deletes the store (`remove_data_store`, macOS).
- **Hosted UI contract.** The location window's user agent is Safari's plus `CodekinDesktop/<version>`. The
  hosted UI uses that token to hand sign-in to the shell: signed out, it navigates to `codekin://sign-in`
  (the shell shows its bundled "Sign in to <name>" page; nothing opens until the user clicks); for a passkey
  step-up (D12) it navigates to `codekin://sign-in?reason=step_up` (the shell starts the handoff right away).
  The navigation guard refuses every `codekin:` navigation and acts on it; other origins open in the default
  browser. Location windows may show only the `signin` / `waiting` / `claim` bundled pages, never the location
  manager.
- **Handoff.** `state` and the verifier are 32 random bytes each, base64url. The deep link is accepted once,
  only with the pending `state`, from the pending location's origin, within 10 minutes; a link that doesn't
  match leaves the real sign-in pending. The claim page in the location window (whose user agent the relay
  checks) posts `code` and `code_verifier`, and only to `<relay>/api/auth/desktop/claim`.
- **Adding.** *Location → Add Location…* opens a bundled manager window. The address is normalized to an origin
  (`https://` only, `http://` on loopback; no credentials, path, query or fragment) and checked with
  `GET /api/relay/info` using the system trust store, so a company CA installed on the Mac works.
- `tauri-plugin-deep-link` registers `codekin://` (in the bundle's Info.plist on macOS);
  `tauri-plugin-single-instance` forwards links on Linux / Windows.

### First-run choice

A new install asks before anything starts: **Run agents on this Mac** (start the bundled server, show This
Mac, optionally go on to Settings → Remote access) or **Connect to Codekin on the web** (a relay address,
prefilled `https://app.codekin.ai`, checked and saved like *Add Location…*, then the browser sign-in). The web
choice doesn't start the server: it starts, once, the first time This Mac is shown, and until then Quit and
updates skip the server and Keep Mac Awake is disabled. The choice is `startMode` in the shell's
`prefs.json`; *Codekin → Welcome…* asks again. Installs from before it (an existing `prefs.json`,
`~/.config/codekin` or `~/.codekin`) count as local and skip it. The move-to-Applications check still runs once
per launch, and the server waits for it.

### Testing

Relay: unit and route tests for the handoff (Linux). App: Rust unit tests for the location model, URL
validation and PKCE; CI launch test with a stub relay. Manual (Mac): add app.codekin.ai and a second relay,
sign in to both through the browser with a passkey account, switch between them and This Mac, sign-out and
revocation from Settings → Security, deep link while the app is closed and while it is open.

## Node.js version (Phase 4 analysis)

Asked: why does Codekin still use Node 20?

### Findings

- **Nothing chose Node 20 after launch.** The minimum `20` dates from the initial release commit (2026-03-08):
  `install.sh` (`MIN_NODE_VERSION=20`), README / GETTING-STARTED / SELF-HOSTED-RELAY ("Node.js 20+"), the CI matrix
  `[20, 22]` and `publish.yml` building the npm package on Node 20. It was a reasonable floor then and was never
  revisited. `package.json` has no `engines` field, so npm never warns anyone.
- **Node 20 is end of life** since 2026-04-30: no security releases for over six months. Node 22 is in
  maintenance until 2027-04-30, Node 24 in maintenance LTS until 2028-04-30, and **Node 26 became Active LTS on
  2026-10-28**.
- **"Node 20+" is already untrue.** `file-type` 22 (a runtime dependency) requires Node ≥ 22, and Vite 8 (build)
  requires `^20.19 || >=22.12`. CI on Node 20 passes only because the code paths used happen to work.
- **The versions users actually get aren't tested.** `install.sh` runs `nvm install --lts`, which installs
  **Node 26** since 2026-10-28. CI tests 20 and 22 only, the prod host runs 24.22.1, and the desktop app bundles
  24.22.2.
- **New installs on Node 26 compile SQLite from source.** `better-sqlite3` 12.9.0 declares Node 20–25 and ships
  prebuilt binaries per Node ABI; there is none for Node 26 (ABI 147), so `npm install -g codekin` falls back
  to `node-gyp` and fails on machines without Python and a C++ toolchain.
- **npm 11 (Node 24+) blocks dependency install scripts unless allowed** (still only a warning in 11.19.1). That
  is the same `better-sqlite3` install script; the desktop payload already needs a build-only `.npmrc` for it.
- **`better-sqlite3` 13** (2026-07) moved to Node-API with prebuilt binaries inside the package for macOS,
  Linux (glibc and musl) and Windows, `gypfile: false` and **no install script**. One binary works on every
  Node with Node-API 10, and both the compile fallback and the install-script problem disappear. Node-API 10
  arrived in **Node 22.14.0**: its `engines` says `>=22`, but on 22.13 (Node-API 9) it segfaults on load. Its 13.0.0 notes list only
  additions (`db.explain()`, `statement.toString()`) and an error-class fix.

### Plan

One PR, independent of the rest of Phase 4, ideally right after 0.9.10:

1. Upgrade `better-sqlite3` to 13.x and run the full suite (server SQLite stores, session archive, D7 lock).
   Remove the desktop payload's `allow-scripts` `.npmrc` and addon check, which no longer apply.
2. Declare `"engines": { "node": ">=22.14" }` (the Node-API 10 floor, above Vite's 22.12); `install.sh` checks
   for 22.14 including the minor version; docs say "Node.js 22.14+ (24 LTS recommended)".
3. CI matrix `[22, 24, 26]`; `publish.yml` builds on Node 24; the desktop runtime stays pinned to 24 and moves
   to 26 once 26 has a few patch releases.
4. Release as **0.10.0**, since dropping Node 20 is breaking for anyone still on it. The CHANGELOG says so first.

## Phases

| Phase | Scope | Exit criterion |
|---|---|---|
| 0 — Spike (Mac) | Bare Tauri window loading a running local server. Check `confirm`/`alert`, drag-and-drop, clipboard, folder picker focus, login-shell `PATH`, `better-sqlite3` under the bundled Node, App Nap. | Written findings; D6 resolved |
| Prereqs (Linux) | `/api/ping`, shared launcher + `app-server`, credential handoff, data ownership/version guard, Codex MCP config fix; confirm dialog if D6 requires it | Merged, released in npm |
| 1 — Local app | `desktop/` package, payload, launcher supervision, splash/error views, window behaviour, attach mode, unsigned PR build job in CI | CI build green; Phase 1 checklist items pass on a Mac |
| 2 — Background + pairing | Menu bar icon, open at login, keep awake, App Nap, in-app relay pairing | Phone reaches a freshly installed app via app.codekin.ai with no terminal |
| 3a — Release pipeline | Release job on the `v*` tag producing an unsigned `.dmg`, updater key and `latest.json`, move-to-Applications | A tag produces a `.dmg` that internal testers install and update |
| 3b — Signing (blocked on Apple account) | Developer ID signing with hardened runtime and entitlements, notarization, stapling | Notarized `.dmg` from a tag installs and updates on a clean Mac with no Gatekeeper warning |
| Node 22.14+ (any time) | `better-sqlite3` 13, `engines`, installer and docs, CI `[22, 24, 26]`, publish on 24; see [Node.js version](#nodejs-version-phase-4-analysis) | 0.10.0 installs on Node 26 with no compiler; CI green on 22/24/26 |
| 4a — Relay: desktop sign-in | `/api/relay/info`, `/api/auth/desktop/start` + `/claim` with PKCE one-time codes, `client: desktop` sessions | Route tests for replay, expiry, wrong verifier/state; deployed to app.codekin.ai |
| 4b — App: locations | Location model, per-location data stores, switcher, add/manage pages, deep link, handoff | Sign in to two relays through the browser and switch between them and This Mac on a Mac |

## Testing

- **Build smoke test** (in `bundle-server.mjs`): run with a fresh temporary home, configuration directory,
  `DATA_DIR`, repository root and test token; choose an available loopback test port and retry allocation on
  a bind race. Clear inherited Codekin settings and disable relay, webhooks and session auto-restore. Require
  the `started` event from the test-owned process (an `attach` result fails the test), valid `/api/ping`,
  authenticated `/api/health` and an opened SQLite database in the temporary data directory. Always stop and
  reap the owned process group and remove temporary files. Never read or write the builder's real credentials,
  sessions or harness config, or attach to its existing server.
- **Automated tests** in the existing Vitest suite for env merge, frontend override, credential precedence
  and private handoff/redaction, attach authentication, legacy ping failure and the Codex MCP config rewrite.
  Add integration coverage for simultaneous starts, different ports sharing one data directory, stale owner
  recovery, bind races, version/downgrade rejection, timed-out startup cleanup and isolated smoke-test behavior.
- **Manual checklist** (run the items applicable to each phase; all must pass before public release):
  - first launch on a machine without the CLI and with no `~/.config/codekin`, where no terminal step is
    needed
  - launch with existing config, sessions and `REPOS_ROOT`, which carry over
  - launch while `codekin service` is running, so the app attaches and doesn't spawn a second server
  - stop a compatible attached service: takeover happens only after exclusive ownership is available
  - hang or pause the attached service: timeout shows reconnecting and never starts a second server
  - attach to a different-version service: its own UI works, Restart server is disabled, and automatic
    takeover is refused; an older service without `/api/ping` gets upgrade instructions
  - existing `AUTH_TOKEN` and custom `AUTH_TOKEN_FILE` both authenticate; wrong credentials show recovery
    without being logged or replaced
  - launch two app instances and race app/service startup: one window owner and one data-directory owner
  - port taken by another app, which shows the error view
  - `claude` installed via Homebrew / nvm is found when launched from the Dock
  - Joe starts and its Codekin MCP tools work, under both the app and the service (configs point at a live Node)
  - revoke an approval rule and delete an archived session (confirm dialogs)
  - native folder picker opens in front of the app window
  - drag-and-drop attachment into the composer
  - close the window, then a phone session keeps streaming; Cmd-Q stops it with no orphaned processes and
    sessions resume after relaunch
  - kill the server process during an active harness session: old owned children are cleaned up before
    restart; force-kill the shell separately and verify the launcher lifetime-pipe shutdown
  - install an update with active sessions, defer it, then confirm: shutdown completes before replacement;
    invalid signatures and failed cleanup do not install; attached services survive app updates
  - attempt an older bundled server against newer data: startup refuses before opening application state
  - pair with app.codekin.ai from Settings (Phase 2)
  - reboot with "Open at login" enabled, after which Codekin is reachable from the phone
