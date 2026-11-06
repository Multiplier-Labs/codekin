# Windows Port — Plan

Status: **Planned, not started**. Nothing in this document is implemented yet.

## Goal

The Codekin server and CLI run natively on Windows 10/11 (x64), so that `npx codekin` works on a Windows machine
and the desktop app ([DESKTOP-APP-TAURI-PLAN.md](DESKTOP-APP-TAURI-PLAN.md#windows)) can later bundle the same
server for Windows. Agents run on the Windows machine itself, in the user's normal Windows filesystem.

## Non-goals

- **Running the server inside WSL.** It would avoid the port but bring in a WSL dependency, networking between
  Windows and WSL, path translation between the two filesystems, and slow git on `/mnt/c`. Users who already
  work inside WSL can run the existing Linux build there.
- **Every harness on day one.** The launch target is Claude Code. Codex, OpenCode and Grok Build are best-effort
  and are listed as supported only once each one has passed the checklist.
- **A Windows build of the desktop app.** That follows this port and is covered by the desktop plan.
- **Approval rules for PowerShell commands.** Commands the approval parser can't read already fall back to asking
  the user, which is safe. Parsing PowerShell is follow-up work.

## Current state

Codekin doesn't run on Windows today. The README says so ("Windows isn't supported yet"), `server/` and `bin/`
have no `win32` handling, and CI runs on `ubuntu-latest` only.

The findings below come from **reading the code**, not from running it on Windows. Step 1 of the plan measures the
real list.

### Works as is

- Node, Express, `ws` and `better-sqlite3` (which ships Windows prebuilt binaries).
- `git`, called from about 30 places, and git worktrees, given Git for Windows on `PATH`.
- The post-commit hook (`server/commit-event-hook.sh`). Git for Windows runs hooks with its bundled `sh`, which
  includes `curl`. The `chmod 0755` on the hook is a harmless no-op.
- Most file paths, which are built with `path.join` / `path.resolve`.

## Required changes

| # | Area | Where | Change |
|---|---|---|---|
| W1 | **Launching harness CLIs** | `server/config.ts:122` (`which claude`); every `spawn` of `CLAUDE_BINARY`, `CODEX_BINARY`, `GROK_BINARY`, `'opencode'`; `server/utility-agent.ts` | Replace `which` with a cross-platform lookup that honours `PATHEXT`. npm installs CLIs as `.cmd` shims, and current Node refuses to `spawn` a `.cmd` or `.bat` without `shell: true`. Resolve the shim to its JS entry point and run it with `node` directly. Using `shell: true` instead would mean escaping every argument, including prompts, for `cmd.exe`, which is error-prone and a security risk. Native `.exe` installs (Claude Code's native installer) spawn as they are. |
| W2 | **Stopping process trees** | `kill('SIGTERM' / 'SIGKILL')` in `claude-process.ts`, `codex-process.ts`, `grok-process.ts`, `opencode-process.ts`, `utility-agent.ts`, `session-manager.ts` | On Windows, `kill()` force-terminates only the one process. Children such as Claude's shell commands keep running. Add a shared `killTree(proc, { graceMs })`: SIGTERM then SIGKILL on POSIX (unchanged behaviour); on Windows, ask the harness to stop where it has a protocol for it (e.g. Codex `turn/interrupt`), then `taskkill /PID <pid> /T /F`. A Job Object is the more robust option if `taskkill` proves racy. |
| W3 | **Graceful server shutdown** | `server/ws-server.ts:1028` (`process.on('SIGTERM')`) | Windows doesn't deliver SIGTERM, so `gracefulShutdown` (persist sessions, stop harnesses, stop the relay connector) never runs when a supervisor stops the server. Add an authenticated loopback-only `POST /api/shutdown` and a `codekin stop` path that uses it. The desktop app's launcher uses the same trigger. SIGINT (Ctrl+C in a console) keeps working. |
| W4 | **`pkill` before resume** | `server/claude-process.ts:237` | `pkill -f` kills a stale `claude` still holding the same session id. Replace it by tracking the PID of every harness process Codekin spawns (in memory plus a small PID file per session for restarts) and killing that PID tree with W2. That replaces pattern matching on all platforms. |
| W5 | **Path containment checks** | `server/config.ts:87`, `server/docs-routes.ts:111/156/177`, `server/orchestrator-reports.ts:112`, `server/orchestrator-session-router.ts:281` | These test `startsWith(root + '/')`, which on Windows denies everything (fails closed). Replace them, plus the already-correct checks in `attachment-paths.ts` and `prompt-router.ts:709`, with one shared `isInside(root, candidate)` helper. On Windows it must compare case-insensitively, and handle drive letters, `\` and `/`, UNC paths and `\\?\` prefixes, all after `realpath`. **Security-sensitive**: its own test suite, run on both platforms in CI. |
| W6 | **Other `/` path handling** | ~75 places that split or join with `/` | Most are URLs or git output, where `/` is correct. Review the rest one by one. The known important one: Claude's transcript folder name is derived from the session's working directory (`server/transcript-readers.ts`); check how Claude Code on Windows encodes `C:\…` against a real install. Also check repo display names derived from paths. |
| W7 | **Command approvals** | `server/shell-command.ts`, `server/approval-manager.ts` | Claude Code on Windows runs its Bash tool through Git Bash, so commands stay bash syntax and parse as today. Check what Codex sends on Windows; PowerShell commands fall back to asking (see Non-goals). Allowlists that name POSIX tools (`ls`, `cat`, `du`, …) stay as they are. |
| W8 | **Host probes** | `server/host-probe.ts:59` (`/proc/meminfo`), `server/deployment-monitor.ts:301` (`df -kP`) | `/proc/meminfo` already degrades to "unknown" off Linux; switch it to `os.totalmem()` / `os.freemem()` everywhere. `df` fails on Windows and would report a probe breach; switch to `fs.statfs`. |
| W9 | **CLI: service and installer** | `bin/codekin.mjs:610/660` (`service` handles `darwin` / `linux` only); `install.sh` | Add `codekin service install` for Windows as a Task Scheduler task that runs at logon (no admin rights needed; a real Windows service needs a wrapper and runs in session 0, away from the user's CLI logins). Add `install.ps1` as the PowerShell equivalent of `install.sh`. `setup`, `start`, `token` and `relay` should work as they are; verify. |
| W10 | **Secret file permissions** | `mode: 0o600` / `chmod` in `bin/codekin.mjs` (token), `approval-manager.ts`, `commit-event-hooks.ts`, `automation-changes.ts`, `dependency-audit.ts`; `relay.json` | Mode bits are ignored on Windows. Restrict the token file and `relay.json` to the current user with `icacls` (remove inheritance, grant the user only). The other files live under the user profile, which is private to that user by default. |
| W11 | **Native folder picker** | `server/native-folder-picker.ts` | macOS only. Leave it unavailable on Windows at first (typing a path still works). A PowerShell `FolderBrowserDialog` version can follow. |
| W12 | **Text shown to people and agents** | `server/orchestrator-manager.ts` (Joe's `curl … $CODEKIN_PORT` fallbacks), `server/harness-registry.ts` / `grok-process.ts` install hints (`curl … \| bash`) | Joe's MCP tools are his primary channel. `curl` ships with Windows 10+, but `$VAR` and `\` line continuations are bash. Give the fallbacks a Windows variant, and make install hints per platform. |
| W13 | **Harness support matrix** | per harness | Verify each CLI on Windows: install method, `.cmd` vs `.exe`, where it keeps auth and transcripts, how it runs shell commands. Claude Code: native build, needs Git for Windows. Codex, OpenCode, Grok Build: to be checked. Show unsupported harnesses as unavailable in the UI rather than failing at spawn. |
| W14 | **Tests** | 218 test files under `server/` and `src/` | Expect failures from hard-coded `/` paths, `/tmp`, POSIX-only fixtures and spawn mocks. Fix the tests to be platform-neutral rather than skip them; skip only tests of POSIX-only features, with a reason. |

## Shared helpers

Most of the risk is in W1–W5. They are built as four small modules first, with the call sites moved over in the
same PRs. All of them keep today's behaviour on macOS and Linux.

| Helper | Replaces |
|---|---|
| `resolveBinary(name)` | `which`, bare-name `spawn`, `.cmd` shim handling (W1) |
| `spawnHarness(binary, args, opts)` | Direct `spawn` of harness CLIs; records the PID (W1, W4) |
| `killTree(proc, opts)` | Per-module SIGTERM / SIGKILL logic and `pkill` (W2, W4) |
| `isInside(root, candidate)` | Every `startsWith(root + '/')` / `startsWith(root + sep)` check (W5) |

## Plan

| Step | Scope | Exit criterion |
|---|---|---|
| 1 — Measure | A `windows-latest` job in `.github/workflows/ci.yml` running build, lint and the test suite, `continue-on-error: true`. | Failure list captured in an issue; this plan updated with anything it missed |
| 2 — Helpers | `resolveBinary`, `spawnHarness`, `killTree`, `isInside` with tests on both platforms; move W1–W5 call sites over. | Helpers' tests pass on Linux and Windows CI |
| 3 — Remaining server changes | W6–W12, one small PR each; W14 test fixes alongside. | Windows CI job green |
| 4 — End to end | Manual checklist on a real Windows machine with Claude Code (below). Then make the Windows CI job blocking. | Checklist passes; CI job required |
| 5 — Docs and release | README support matrix, `install.ps1`, Windows section in the setup docs, CHANGELOG. Released through the normal `v*` tag. | `npx codekin` documented as supported on Windows |
| 6 — Other harnesses | W13 per harness, each added to the support matrix once it passes the checklist. | Matrix up to date |

Rough size: W1–W5 are the substantial part; W6–W14 are small and mechanical. A Claude-only port is in the order of
two weeks of focused work. This is an estimate from reading the code and will be revised after step 1.

## Where the work happens

| Where | What |
|---|---|
| Linux dev host | Writing the changes; Linux tests. |
| CI `windows-latest` | The build of record for Windows: tests on every PR from step 1 (non-blocking until step 4). |
| A Windows machine or VM | Step 4 and any debugging CI can't do: a Windows PC, a cloud VM, or Windows 11 on Arm in Parallels on an Apple Silicon Mac (runs x64 Node under emulation; fine for behaviour, not for performance). |

## Testing

- **Unit tests** for the four helpers, with Windows-specific cases for `isInside` (case, drive letters, `\` vs
  `/`, UNC, `\\?\`, symlinks and junctions) and `resolveBinary` (`.cmd`, `.exe`, `PATHEXT`, spaces in paths).
- **CI:** the whole existing suite on `windows-latest`, blocking from step 4.
- **Manual checklist** (Windows 11, Claude Code native install, Git for Windows):
  - `npx codekin setup` and `codekin start`; open the printed URL and log in
  - start a Claude session; send prompts; stream output
  - approval prompt appears for a non-allowlisted command; "Always allow" rule matches next time
  - attach a file; open the Changes panel and diff
  - start a session in a new worktree; archive it; delete it (worktree removed only when clean)
  - stop a session mid-command: no orphaned `claude` / `bash` processes left (Task Manager)
  - restart the server with sessions running: sessions resume, no stale process holds the session
  - `codekin stop` runs a graceful shutdown (sessions persisted)
  - Joe starts and his Codekin MCP tools work
  - a commit in a watched repo triggers the commit hook
  - repo and path checks: a path outside `REPOS_ROOT` is refused, also with different drive-letter case
  - `codekin service install`: server starts at logon and is reachable
  - pair with app.codekin.ai via `codekin relay login`; phone reaches the machine
  - token file and `relay.json` are readable only by the current user (`icacls`)
