# Codekin desktop app

Native macOS (Apple Silicon) app that bundles the Codekin server and its own Node runtime.
Plan and status: [docs/DESKTOP-APP-TAURI-PLAN.md](../docs/DESKTOP-APP-TAURI-PLAN.md).

The Tauri shell (`src-tauri/`) isn't here yet. What exists is the server payload the app ships:

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
