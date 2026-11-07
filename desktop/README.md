# Codekin desktop app

Native macOS (Apple Silicon) app that bundles the Codekin server and its own Node runtime.
Plan and status: [docs/DESKTOP-APP-TAURI-PLAN.md](../docs/DESKTOP-APP-TAURI-PLAN.md).

Two parts: the **server payload** the app ships (`scripts/`), and the **Tauri shell** (`src-tauri/`,
`splash/`) that starts, supervises and stops it.

## Server payload

```bash
# In the repository root: build the frontend and the server first.
npm ci && npm ci --prefix server
npm run build
npx tsc -p server/tsconfig.json

# Then build the payload and run the isolated smoke test.
node desktop/scripts/bundle-server.mjs                     # darwin-arm64, on an Apple Silicon Mac
node desktop/scripts/bundle-server.mjs --target linux-x64  # same steps, checkable on Linux
```

Output (all gitignored):

| Path | What |
|---|---|
| `build/codekin/` | The npm package as packed, with production dependencies installed for the bundled Node |
| `build/payload.json` | Codekin version, Node version and target of the payload |
| `src-tauri/binaries/node-<target-triple>` | The pinned Node binary, as the Tauri sidecar |
| `.cache/` | Downloaded Node tarballs, re-verified against `node-runtime.json` on every build |

`node-runtime.json` pins the Node version and the SHA-256 of each tarball (from nodejs.org's
`SHASUMS256.txt`). Update the version and every checksum together.

`scripts/smoke-test.mjs` can also be run on its own against an existing payload. It never reads or
writes your real `~/.config/codekin`, `~/.codekin` or harness config, and never attaches to a running
Codekin. CI runs the build and smoke test on `macos-15` and `ubuntu-latest` (`.github/workflows/desktop.yml`).

## Tauri shell

`src-tauri/src/`:

| Module | What |
|---|---|
| `protocol.rs` | The launcher's event / credential contract, URLs, navigation allowlist, restart backoff (pure, unit-tested) |
| `launcher.rs` | Spawns `codekin app-server` in its own process group, stdin = lifetime pipe, fd 3 = credential; graceful SIGTERM, group SIGKILL backstop |
| `http.rs` | `/api/ping` (attach liveness) and active-session count, no redirects |
| `background.rs` | Shell preferences (`prefs.json`) and Keep Mac awake (`caffeinate -i -w <pid>`) |
| `supervisor.rs` | Start / attach / crash-restart / Quit state machine, independent of Tauri |
| `lib.rs` | Window, app menu and menu bar icon, Open at login, navigation guard, splash commands (`retry`, `show_logs`, `quit`), Quit and Restart confirmations |

```bash
# After building the payload (above):
cd desktop
npm ci
npx tauri build --bundles app     # macOS: src-tauri/target/release/bundle/macos/Codekin.app
cd src-tauri && cargo test         # Rust unit tests (any Unix host)
```

On Linux the shell builds and runs for development (with the WebKitGTK dev packages and a
`--target linux-x64` payload); the shipped target is macOS only. CI (`.github/workflows/desktop.yml`,
`shell` job) runs fmt / clippy / tests on `macos-15`, builds an unsigned `.app`, launches it with a
throwaway HOME, takes a screenshot, and checks that killing the shell stops the server. The zipped `.app`
and screenshot are uploaded as the `codekin-desktop-unsigned` artifact (7 days). It's ad-hoc signed:
on another Mac it needs `xattr -dr com.apple.quarantine Codekin.app` before it opens.
