# Codekin

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/codekin.svg)](https://www.npmjs.com/package/codekin)

**[codekin.ai](https://codekin.ai)**

Web UI for [Claude Code](https://github.com/anthropics/claude-code), [OpenCode](https://github.com/nicepkg/opencode), and [OpenAI Codex](https://github.com/openai/codex) sessions — multi-provider AI coding with multi-session support, WebSocket streaming, file uploads, and slash-command skills.

Codekin runs the coding agent and accesses repositories **on the computer where you install it**. Use the hosted app to reach that computer from another device, or open the local UI directly for a self-hosted setup. See [Getting started](docs/GETTING-STARTED.md) for a first-session walkthrough and troubleshooting.

![Codekin screenshot](docs/screenshot.png)

## Quick start (hosted)

Codekin runs coding agents on your own computer; the hosted app at [app.codekin.ai](https://app.codekin.ai) is how you reach them from a browser, phone or tablet.

1. Install and sign in to at least one supported coding agent on your macOS or Linux computer: [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), or [OpenCode](https://opencode.ai). Windows isn't supported yet.
2. Open [app.codekin.ai](https://app.codekin.ai) and sign in with GitHub. Access is currently by invitation.
3. On **Connect your computer**, copy the generated install command and run it in a terminal **on that computer**. The pairing command expires after 10 minutes and can be used once.
4. Wait for the computer to show **online**, then click **Open**. Keep the computer awake and connected while using Codekin remotely.
5. Use **New** to choose a repository and a coding agent. Local Git checkouts under `~/repos` appear automatically; the GitHub CLI is optional for listing and cloning GitHub repositories.

Prefer to run everything yourself, without the hosted relay? Use the self-hosted install below.

## Install (self-hosted)

**Prerequisites:**
- macOS or Linux
- Node.js v20+ (the install script can install this via nvm)
- At least one supported coding agent CLI, installed and authenticated:
  - [Claude Code CLI](https://github.com/anthropics/claude-code) (`claude`)
  - [OpenAI Codex CLI](https://github.com/openai/codex) (`codex login`) to use ChatGPT-subscription OpenAI models
  - [OpenCode](https://opencode.ai) with a configured provider

**One-liner:**

```bash
curl -fsSL https://codekin.ai/install.sh | bash
```

This will:
1. Install Node.js 20+ if needed (via nvm)
2. Check for a supported coding agent CLI (installation stops with instructions if none is found)
3. Install the `codekin` npm package globally
4. Generate a local access token and install and start a background service
5. Print your local access URL

Open the printed `http://localhost:32352?token=...` URL **on the installed computer**. The token is in that URL; if you open the address without it, paste the token in the Settings prompt. Run `codekin token` to print the URL again. For another device, use the hosted setup above rather than a `localhost` link.

The installer checks GitHub CLI (`gh`) but does not require it. Existing local Git checkouts work without GitHub authentication. Continue with [your first session](docs/GETTING-STARTED.md#3-start-your-first-session).

## Usage

```bash
codekin token                   # Print your access URL at any time
codekin config                  # Update API keys and settings
codekin service status          # Check whether the service is running
codekin service install         # (Re-)install the background service
codekin service uninstall       # Remove the background service
codekin start                   # Run in foreground (for debugging)
codekin stop                    # Stop the running background service
codekin setup --regenerate      # Generate a new auth token
codekin upgrade                 # Upgrade to latest version
codekin uninstall               # Remove Codekin entirely
```

## Features

- **Multi-provider AI** — Use Claude Code, [OpenCode](https://github.com/nicepkg/opencode), or [OpenAI Codex](https://github.com/openai/codex) as the backend per session. OpenCode enables any LLM provider (OpenAI, Gemini, etc.) through a single interface; Codex unlocks ChatGPT-subscription OpenAI models — all with full streaming, tool events, plan mode, and permission control
- **Multi-session terminal** — Open and switch between multiple coding sessions, one per repo
- **Agent Joe** — AI orchestrator agent that spawns and manages up to 5 concurrent child sessions, with a dedicated chat UI, welcome screen, and color-coded sidebar status indicators. Resilient by design: realtime blocked-child notifications, a persistent notification outbox that replays when the orchestrator returns, pausable child timeouts, and ground-truth completion verification
- **Loops** — Durable, event-sourced outcome loops that run a coding agent until *deterministic* evaluators pass (your own build/test/lint commands, judged by exit code), under turn/cost/wall-time budgets with no-progress detection. An independent second provider reviews the diff before it lands, every transition is an auditable event with retained evidence artifacts, runs survive server restarts (pause/resume/steer included), and a passing run is committed, pushed and opened as a PR by Codekin itself. Ships with CI Autorepair, Coverage Increase, and Dependency Upgrade recipes
- **Git worktrees** — Isolate sessions in dedicated worktree directories, with mid-session creation, auto-enable setting, and session context preservation
- **Session archive** — Full retrieval and re-activation of archived sessions
- **Repo browser** — Auto-discovers Git checkouts under your repositories root (flat `~/repos/project` or owner-namespaced `~/repos/owner/project`), no GitHub CLI required; with an authenticated `gh`, also lists your personal and org GitHub repos, matches them to existing checkouts by remote URL, and clones the rest on demand
- **Screenshot upload** — Drag-and-drop or paste images; the file path is sent to the AI so it can read them natively
- **Skill browser** — Browse and invoke `/skills` defined in each repo's `.claude/skills/`, with inline slash-command autocomplete
- **Diff viewer** — Side panel showing staged/unstaged file changes with per-file discard support
- **Command palette** — `Ctrl+K` to quickly search repos, sessions, skills, docs, archived sessions, and actions
- **Approval management** — Persistent approval storage with per-permission revoking, permission mode selector, per-session tool pre-approvals, and `--dangerously-skip-permissions` mode for sandboxed environments
- **Dynamic model discovery** — New Claude models appear automatically without code changes, discovered via the Anthropic API or CLI alias probing (works with both API-key and subscription auth)
- **Connection status** — Real-time provider health indicators with disable/enable toggles for each backend
- **Subscription & API key auth** — Works with both Claude subscription (OAuth) and API key authentication
- **Mobile-friendly** — Responsive layout that works on phones and tablets, with touch-sized controls
- **Light & dark themes** — Both polarities are tuned against WCAG AA contrast, switchable in Settings
- **Markdown browser** — Browse and view `.md` files directly in the UI
- **AI Workflows** — Scheduled code and repository audits and maintenance, with support for custom workflows defined as Markdown files
- **GitHub webhooks** — Automated bugfixing on CI failures and PR code review via webhook integration
- **Upgrade notifications** — In-app banner when a newer version is available

## Upgrade

```bash
codekin upgrade
```

This checks npm for the latest version, installs it, and restarts the background service if running.

Alternatively, re-run the install script:

```bash
curl -fsSL https://codekin.ai/install.sh | bash
```

## Uninstall

```bash
codekin uninstall
```

This removes the background service, config files, and the npm package.

## Configuration

The installed service reads environment variables from `~/.config/codekin/env`. Edit that file to override defaults, then apply changes with `codekin service install`. The local access token is stored separately in `~/.config/codekin/token`; keep it private.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `32352` | Server port |
| `REPOS_ROOT` | `~/repos` | Root directory scanned for local repositories |

You can also change **Repositories Path** in the app's Settings or first-session screen without restarting the service. See [Getting started](docs/GETTING-STARTED.md#no-repositories-appear).

## Manual / Advanced Setup

For the installation internals and manual deployments, see [Installation and distribution](docs/INSTALL-DISTRIBUTION.md). For nginx and Authelia deployment, see the [advanced setup guide](docs/SETUP.md).

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
