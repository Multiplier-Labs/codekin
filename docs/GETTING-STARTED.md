# Getting started with Codekin

Codekin is a browser interface for coding agents that run on your computer. The agent CLI and Git repositories must be accessible to the account running the Codekin service. You need macOS or Linux, a terminal, and at least one signed-in coding agent. Windows is not currently supported.

## 1. Prepare a coding agent

Install **one** of these CLIs on the computer that will run Codekin, then complete its sign-in or provider setup before installing Codekin:

| Agent | Check it in a terminal | Sign-in or setup |
|---|---|---|
| [Claude Code](https://github.com/anthropics/claude-code) | `claude --version` | Run `claude` and follow its sign-in prompts |
| [OpenAI Codex](https://github.com/openai/codex) | `codex --version` | Run `codex login` |
| [OpenCode](https://opencode.ai) | `opencode --version` | Configure an LLM provider in OpenCode |

The installer looks for `claude`, `codex`, or `opencode` on your `PATH` and stops with install hints if it finds none. You can add more agents later. A detected CLI still needs working credentials; Codekin's **Environment** checklist reports its current state.

## 2. Choose how to connect

### Remote access from a browser or phone

Remote access goes through a Codekin web app: the public instance at [app.codekin.ai](https://app.codekin.ai), or one your team hosts ([Hosting your own Codekin web app](SELF-HOSTED-RELAY.md)). The steps are the same for both.

1. Open your Codekin web app and sign in with GitHub. Access is by invitation: use the invite link a workspace owner or admin sent you.
2. On **Connect your computer**, generate and copy the install command. Run that exact command in a terminal on your macOS or Linux computer. It contains a one-use pairing token that expires after 10 minutes; generate a new command if it expires.
3. The installer pairs the computer, installs Codekin, and starts its background service. Wait for the page to show the machine **online**, then click **Open**.

The web app connects to the service on your computer; it does not run your coding agent in the browser. Keep that computer awake and connected while you use it remotely. If the installer finishes but the machine stays offline, see [Machine is paired but offline](#machine-is-paired-but-offline).

### Local access

Run this on the computer where the agent and repositories live:

```bash
curl -fsSL https://codekin.ai/install.sh | bash
```

The script can install Node.js 20+ through nvm, installs Codekin from npm, creates a local access token, and starts a user-level background service. It also checks for GitHub CLI (`gh`), but `gh` is optional if you use local Git checkouts.

Open the URL printed by the installer on the **same computer**. It looks like `http://localhost:32352/#token=...`. `localhost` refers to the device opening the URL, so this link will not reach your computer from a phone or another computer. Run `codekin token` to print it again. The URL contains an access credential; keep it private. If you open the page without the `#token=...` part, enter the token on the **Settings → Connection** page, which opens automatically.

## 3. Start your first session

1. On the landing page, check **Environment**. At least one agent should be ready. The GitHub CLI is optional.
2. Choose a repository. Codekin finds local Git checkouts under `~/repos`, including `~/repos/project` and `~/repos/owner/project`. If your checkouts are elsewhere, set **Repositories Path** below the repository list or in **Settings → Sessions** to the directory containing them. You can also clone a repository into `~/repos` yourself.
3. If you have installed and signed in to [GitHub CLI](https://cli.github.com/) (`gh auth login`) on the Codekin computer, Codekin can list your GitHub repositories and clone one when you select it.
4. Use **New** in the sidebar, select the repository, then choose an available provider. Send your first message in the session that opens. Selecting a repository directly can reopen an existing session; for a new session it uses the current default provider.

## Common first-run problems

### No agent is ready

Run the agent's command from [step 1](#1-prepare-a-coding-agent) on the Codekin computer and complete its sign-in. If you installed the CLI after Codekin started, run `codekin service install` to restart the service. If it is still missing from **Environment**, check that the background service can find the CLI on its `PATH`. On Linux, inspect `journalctl --user -u codekin -n 100`; on macOS, inspect `~/.codekin/server.log`.

### No repositories appear

Use **Repositories Path** on the landing page or in **Settings → Sessions** to select the directory that contains your local Git checkouts. The directory must exist and be readable by the user running Codekin. Leave the field empty to use the default `~/repos`. GitHub CLI is only needed to list and clone GitHub repositories; it is not needed for local checkouts.

### The local page does not open

Run `codekin service status` and `codekin token` on the installed computer. If the service is stopped, run `codekin service install`. Check `journalctl --user -u codekin -n 100` on Linux or `~/.codekin/server.log` on macOS for startup errors. The default port is `32352`; if you changed `PORT` in `~/.config/codekin/env`, reprint the URL with `codekin token`.

### Machine is paired but offline

Run `codekin service status` and `codekin relay status` on the paired computer. If the service is stopped, run `codekin service install`. If pairing failed or expired, generate a fresh command under **Settings → Machines** in the hosted app and follow its **already installed** instructions. If the computer was paired in unmanaged mode, `codekin relay status` will say so; run `codekin relay connect` and keep that terminal open, or re-pair using the hosted setup command for a managed connection.

## Useful commands

```bash
codekin token             # Print the local access URL again
codekin service status    # Check the background service
codekin relay status      # Check hosted pairing and connection
codekin service install   # Install or restart the background service
codekin upgrade           # Install the latest published version
```

For configuration and all CLI commands, see the [README](../README.md#usage). For manual deployments, see [Installation and distribution](INSTALL-DISTRIBUTION.md).
