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

## Releases and updates

Pushing a `v*` tag runs the `desktop` job in `.github/workflows/publish.yml` next to the npm publish:

1. checks the tag matches `package.json`, and that the updater key and public key are configured
2. builds the payload (smoke test), `Codekin.app`, the `.dmg`, and the signed updater artifact
3. uploads `Codekin_<v>_aarch64.dmg`, `.app.tar.gz` and `.app.tar.gz.sig` to the tag's GitHub release, created
   as a **prerelease** (these builds are unsigned and for internal testers)
4. last, once the artifact URL answers, replaces `latest.json` on the rolling `desktop-channel` prerelease, which
   is the updater's endpoint

The app checks for updates 20 s after launch and then daily (release builds only; **Check for Updates…** in
the app menu checks now). It downloads and verifies the update before asking anything else, confirms if
sessions are running, stops its own server and waits for its processes to exit, then installs and relaunches.
An attached `codekin service` is never touched. `requireSignedVersion` is on: the signature must name the
version the manifest announces, so an old signed build can't be served as a "newer" one.

### One-time setup: the updater signing key

The updater key is separate from Apple's Developer ID (Phase 3b) and only signs update artifacts. Losing the
private key or its password means installed apps can no longer verify updates, so keep a copy in your password
manager.

1. Generate the key on a machine you trust (run as `dev` on the Codekin host, or on your Mac):

   ```bash
   cd desktop && npm ci
   npx tauri signer generate -w ~/.tauri/codekin-updater.key
   ```

   It asks for a password. Use a strong one and store it, and the two files it writes, in your password manager.

2. Add the private key and its password as repository secrets (only the `gh` CLI or the repository's
   Settings → Secrets and variables → Actions page ever sees them):

   ```bash
   gh secret set TAURI_SIGNING_PRIVATE_KEY --repo Multiplier-Labs/codekin < ~/.tauri/codekin-updater.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo Multiplier-Labs/codekin
   ```

   The second command prompts for the password, so it doesn't end up in shell history.

3. Put the **public** key (`~/.tauri/codekin-updater.key.pub`, safe to commit) into
   `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`, in a PR.

Until all three are done, the release job fails at its first check (the npm publish is a separate job and
isn't affected), and the app reports that updates aren't configured.

Rotating the key later means every installed app needs one manual update to a build with the new public key.

## Move to Applications

A release build launched from outside `/Applications` or `~/Applications` (for example straight from Downloads,
where macOS runs it from a temporary read-only path) offers to copy itself to Applications and reopen from
there, before its server starts. `CODEKIN_SKIP_MOVE_CHECK=1` skips this; CI uses it to launch the build output
directly.
