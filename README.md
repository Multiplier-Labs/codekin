# Codekin

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/codekin.svg)](https://www.npmjs.com/package/codekin)

**[codekin.ai](https://codekin.ai)**

Web UI for Claude Code sessions — multi-session support, WebSocket streaming, file uploads, and slash-command skills.

![Codekin screenshot](docs/screenshot.png)

## Install

**Prerequisites:**
- macOS or Linux
- [Claude Code CLI](https://github.com/anthropics/claude-code) installed and authenticated (`claude` must be in your PATH)

**One-liner:**

```bash
curl -fsSL codekin.ai/install.sh | bash
```

This will:
1. Install Node.js 20+ if needed (via nvm)
2. Install the `codekin` npm package globally
3. Generate an auth token
4. Prompt for optional LLM API keys (Groq, OpenAI, Gemini, Anthropic) for session auto-naming
5. Install and start a persistent background service
6. Print your access URL

Open the printed URL in your browser, enter your Codekin Web token when prompted, and you're ready to go.

## Usage

```bash
codekin token                   # Print your access URL at any time
codekin config                  # Update API keys and settings
codekin service status          # Check whether the service is running
codekin service install         # (Re-)install the background service
codekin service uninstall       # Remove the background service
codekin start                   # Run in foreground (for debugging)
codekin setup --regenerate      # Generate a new auth token
codekin upgrade                 # Upgrade to latest version
codekin uninstall               # Remove Codekin entirely
```

## Features

- **Multi-session terminal** — Open and switch between multiple Claude Code sessions, one per repo
- **Session archive** — Full retrieval and re-activation of archived sessions
- **Repo browser** — Auto-discovers local repos and GitHub org repos
- **Screenshot upload** — Drag-and-drop or paste images; the file path is sent to Claude so it can read them natively
- **Skill browser** — Browse and invoke `/skills` defined in each repo's `.claude/skills/`, with inline slash-command autocomplete
- **Diff viewer** — Side panel showing staged/unstaged file changes with per-file discard support
- **Command palette** — `Ctrl+K` to quickly search repos, skills, and actions
- **Approval management** — Persistent approval storage with detailed per-permission revoking
- **Mobile-friendly** — Responsive layout that works on phones and tablets
- **Markdown browser** — Browse and view `.md` files directly in the UI
- **AI Workflows** — Scheduled code and repository audits and maintenance, with support for custom workflows defined as Markdown files
- **GitHub webhooks** — Automated bugfixing on CI failures via webhook integration
- **LLM-powered chores** — Optional API keys (Groq, OpenAI, Gemini, Anthropic) for background tasks like session auto-naming

## Upgrade

```bash
codekin upgrade
```

This checks npm for the latest version, installs it, and restarts the background service if running.

Alternatively, re-run the install script:

```bash
curl -fsSL codekin.ai/install.sh | bash
```

## Uninstall

```bash
codekin uninstall
```

This removes the background service, config files, and the npm package.

## Configuration

All configuration lives in `~/.config/codekin/env`. Edit this file to override defaults, then restart the service with `codekin service install`.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `32352` | Server port |
| `REPOS_ROOT` | `~/repos` | Root directory scanned for local repositories |
| `GROQ_API_KEY` | — | Optional. Enables session auto-naming via Llama 4 Scout (free tier at [groq.com](https://groq.com)) |
| `OPENAI_API_KEY` | — | Optional. Fallback for session auto-naming via GPT-4o Mini ([platform.openai.com](https://platform.openai.com)) |
| `GEMINI_API_KEY` | — | Optional. Fallback for session auto-naming via Gemini 2.5 Flash ([aistudio.google.com](https://aistudio.google.com)) |
| `ANTHROPIC_API_KEY` | — | Optional. Fallback for session auto-naming via Claude Haiku ([console.anthropic.com](https://console.anthropic.com)) |

## Manual / Advanced Setup

For remote servers, custom nginx, or other advanced setups, see [docs/INSTALL-DISTRIBUTION.md](docs/INSTALL-DISTRIBUTION.md).

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
