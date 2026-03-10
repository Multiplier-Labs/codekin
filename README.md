# Codekin

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/codekin.svg)](https://www.npmjs.com/package/codekin)

Web UI for Claude Code sessions — multi-session support, WebSocket streaming, file uploads, and slash-command skills.

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
codekin uninstall               # Remove Codekin entirely
```

## Features

- **Multi-session terminal** — Open and switch between multiple Claude Code sessions, one per repo
- **Repo browser** — Auto-discovers local repos and GitHub org repos
- **Screenshot upload** — Drag-and-drop or paste images; the file path is sent to Claude so it can read them natively
- **Skill browser** — Browse and invoke `/skills` defined in each repo's `.claude/skills/`
- **Command palette** — `Ctrl+K` to quickly search repos, skills, and actions

## Upgrade

Re-run the install script — it's idempotent and will upgrade to the latest version:

```bash
curl -fsSL codekin.ai/install.sh | bash
```

Or upgrade manually:

```bash
npm install -g codekin
codekin service install
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
| `GH_ORG` | — | Comma-separated GitHub orgs for repo listing |
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
