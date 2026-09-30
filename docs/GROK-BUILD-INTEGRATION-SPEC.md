# Grok Build integration spec

Status: **implemented** (steps 1–3: #699, #700, #701). Steps 4–5 (workflows, loops, Joe) pending. Revised after upstream-doc and codebase review and a spike against grok 1.0.44 (2026-09-30).

Date: **2026-09-27**

Target: first-class `grok` coding harness in Codekin

## Goal

Let a user install and authenticate the official Grok Build CLI, then create,
resume, and switch to a Grok coding session in Codekin with the same core chat,
tool activity, cancellation, and permission experience as the existing harnesses.
Grok Build is SpaceXAI's coding agent (`grok`), distinct from using an xAI model
inside OpenCode or calling the Grok model API directly.

Non-goal: calling Grok models directly from Codekin. Users who only want Grok
models can already configure xAI through OpenCode.

## Current Codekin boundary

Codekin represents Claude Code, OpenCode, and Codex as `CodingProcess`
implementations (`server/coding-process.ts`). Relevant facts for this work:

- **Interface.** `start`, `stop`, `sendMessage`, `sendRaw`,
  `sendControlResponse(id, 'allow' | 'deny' | 'allow_always', …)`,
  optional `setPermissionMode`, `seedTasks`, `isAlive`, `isReady`,
  `getSessionId`, `waitForExit`, plus `provider` and `capabilities`.
- **Events.** The `ClaudeProcessEvents` contract lives in
  `server/claude-process.ts` (`text`, `thinking`, `tool_active`, `tool_done`,
  `tool_output`, `system_init`, `control_request`, `planning_mode`,
  `todo_update`, `result`, `usage`, `error`, `exit`, …).
- **Registry.** `server/harness-registry.ts` holds one `HarnessDefinition` per
  harness: `id`, `label`, `installHint`, `probe()`, `createProcess()`,
  `oneShotCommand()`.
- **Provider unions.** `CodingProvider` is declared in both
  `server/coding-process.ts` and `src/types.ts`; `VALID_PROVIDERS` is in
  `server/types.ts`; the UI list `PROVIDERS` is in `src/types.ts`. Loops have
  their own `LoopProvider` and `PROVIDERS` in `server/loop-recipe.ts`, and
  workflows use inline unions in `workflow-config.ts` / `workflow-loader.ts`.
- **Capabilities are advisory.** No code outside the adapters reads
  `capabilities` (Codex has `planMode: false`, yet the UI still offers plan).
  Any UI gating described below must be wired up as part of this work.
- **Approvals.** Adapters emit `control_request`; `session-lifecycle.ts`
  forwards it to `PromptRouter.onControlRequestEvent`, which applies registry
  auto-approval, plan-mode denial, and the UI prompt. Codex
  (`handleServerRequest`) and OpenCode (`permission.asked`) both use this
  bridge. Grok must too.

Grok is a new adapter behind these seams. Its wire protocol (ACP) is different
from Claude's stream-JSON and Codex's app-server protocol.

The local host runs `grok`; the browser never receives Grok credentials. Hosted
Codekin reaches the local host through Codekin's existing relay.

## External interface to use

Use `grok agent stdio` as the interactive session backend. It speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) as JSON-RPC 2.0
over stdin/stdout. From Grok's agent-mode guide:

- Base methods: `initialize`, `session/new`, `session/load`, `session/prompt`,
  `session/cancel`, `session/set_config_option`, plus agent-to-client
  `session/request_permission` when a session is not always-approve.
- `session/update` notifications carry `sessionUpdate` =
  `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
  `tool_call_update`, `plan`, and (non-exhaustive) `config_option_update` and
  others. Grok also emits `x.ai/*` extension notifications; ignore them unless
  mapped deliberately.
- `session/new` and `session/load` responses include a typed `configOptions`
  list. `configId: "model"` switches the model; `configId: "reasoning_effort"`
  sets effort (`minimal` … `xhigh`). This is the model-discovery and
  model-switch mechanism for live sessions.
- Session `_meta` on `session/new`: `yoloMode` (always-approve), `autoMode`
  (classifier-gated auto mode), `rules`, `systemPromptOverride`,
  `agentProfile`, `pluginDirs`.
- Agent flags go between `agent` and `stdio`: `--model`, `--always-approve`
  (alias `--yolo`), `--plugin-dir`, `--no-leader`.
- `GROK_CONFIG` (inline JSON) injects allowlisted soft settings (models,
  features, narrowed toolset). It cannot change permissions or auth.

Persistence: sessions live under `$GROK_HOME/sessions/<encoded-cwd>/<id>/`.
`GROK_HOME` defaults to `~/.grok`. `<encoded-cwd>` is the URL-encoded working
directory, or a slug-plus-hash with a `.cwd` file when the encoded name exceeds
255 bytes. `updates.jsonl` is the authoritative ACP update log; `summary.json`
holds the title and model; `plan.md` holds the plan-mode plan.

Headless `grok -p … --output-format streaming-json` does emit tool-call events.
It is still unsuitable for interactive sessions because it is read-only: there
is no channel for approvals, cancellation, or follow-up prompts. Use it only for
`oneShotCommand()`.

References: [Grok Build source and overview](https://github.com/xai-org/grok-build);
user guide in `crates/codegen/xai-grok-pager/docs/user-guide/`:
[agent mode](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md),
[headless mode](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md),
[sessions](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md),
[plan mode](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/19-plan-mode.md),
[permissions](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md).
Treat the docs as leads. Every behavior below is confirmed against a pinned
binary before it ships (see [Validation](#validation-and-acceptance)).

## User behavior

1. When `grok` is on the host's PATH (or `GROK_BINARY` points to it), Grok appears
   alongside Claude, OpenCode, and Codex in new-session, provider-switch, and
   provider/model controls. A missing binary disables it with an install hint
   (curl installer from the Grok Build README; there is no npm package).
   Failed auth detection warns but does not block, matching existing providers.
2. The user authenticates through `grok login` or an `XAI_API_KEY` configured
   **on the host**. Codekin stores neither credential nor token.
3. Creating a Grok session opens an ACP session in its selected working directory.
   Messages and tool progress stream into the normal Codekin transcript. A refresh
   rejoins the Codekin session; a host restart reloads Grok's native session.
4. Switching to or from Grok follows the existing “Carry context” flow. The source
   harness's native session is never silently resumed by a different harness.
5. Permission controls display only modes that the integration can enforce. A mode
   must not claim user approval while Grok can execute gated tools without a
   Codekin decision.

## Process adapter

Add `server/grok-process.ts` implementing `CodingProcess` and emitting the
`ClaudeProcessEvents` contract. Keep ACP parsing and Grok-specific state inside
this adapter; put pure mapping functions (update → events, mode → `_meta`) in
a sibling module so they can be fixture-tested without spawning. Run one child
process per active Codekin session, with one stdout line reader that
dispatches JSON-RPC responses by `id`, notifications by `method`, and
agent-to-client requests by `method` + `id`. Do not copy the upstream sample
client's pattern of `once('line')` per request with a fixed `id: 1`, because
notifications interleave with responses.

Hand-roll a small JSON-RPC layer (as `codex-process.ts` does) rather than
adding `@agentclientprotocol/sdk`, unless the pinned protocol version makes
the SDK clearly cheaper. Decide during step 1 and record why.

### Startup and session identity

- Spawn `GROK_BINARY || 'grok'` with
  `agent [--model <m>] [--always-approve] --no-leader stdio` and
  `cwd = session.workingDir`. Use `--no-leader` so each Codekin session owns
  its process and `stop()` cannot affect another client. Set
  `GROK_TELEMETRY_ENABLED` only if the user has configured it; do not
  override the user's telemetry or update choices silently. Disable
  interactive auto-update prompts if the agent flags support it.
- Build the child environment with the same policy as the other adapters:
  strip inherited `GIT_*` except `GIT_EDITOR`, pass through `XAI_API_KEY`,
  and add only the session-scoped `CODEKIN_TOKEN`/`CODEKIN_AUTH_TOKEN`, never
  the master token. This policy is currently duplicated in three adapters;
  extract a shared `buildHarnessEnv()` helper first and use it in all four.
- **Always set `GROK_CLAUDE_HOOKS_ENABLED=false`** on the child. Grok runs
  Claude hooks from `~/.claude/settings.json` by default, and Codekin installs
  a global `PreToolUse` hook (`.claude/hooks/pre-tool-use.mjs`) there. The
  spike showed that hook answering `permissionDecision: "allow"`, and Grok
  then skipped its own prompt: ask mode was bypassed without any
  `session/request_permission` reaching the client. Grok approvals must flow
  through ACP only. Leave Claude rules, skills, and MCP compatibility on (see
  [Cross-harness configuration bleed](#cross-harness-configuration-bleed)).
- Send `initialize` with `protocolVersion: 1` and only the client capabilities
  Codekin implements. Do **not** advertise `fs` or `terminal` until those
  client-side request handlers exist. Without them, Grok runs its own tools
  in-process, which is what we want. Reject an unsupported negotiated
  protocol version with a clear error.
- New session: `session/new` with `cwd`, `mcpServers` (see Joe below), and
  `_meta` derived from the permission mode. Stored native ID: `session/load`
  with the same `cwd`. If load fails because the session is missing, fall back
  to `session/new` and emit a visible notice, as Codex does with
  `thread/resume` → `thread/start`.
- Emit `system_init` once the session exists. `session-manager.ts` stores
  `cp.getSessionId()` into `Session.claudeSessionId` **only** from the
  `system_init` handler, so a missing event means resume never works. Keep
  the `claudeSessionId` field name for now; a generic rename is a separate
  migration.
- Mark the process ready only after `initialize` and new/load finish.
  `session/load` replays history as `session/update` notifications before its
  response (confirmed: `user_message_chunk`, coalesced agent/thought chunks,
  and `tool_call`s already carrying their final status, plus an
  `_x.ai/session/update` `turn_completed` for each past turn). Drop every
  update received between sending `session/load` and its response. Codekin
  already holds the transcript, and replayed turns must not emit `result`.
- The `session/new` and `session/load` responses carry `models`
  (`currentModelId`, `availableModels[]` with context size and reasoning
  efforts) and `configOptions` (`model`, `reasoning_effort`). There is no
  `modes` field.
- Handle child exit, malformed JSON, JSON-RPC errors, startup timeout, stdin
  `EPIPE`, and rejection of pending requests on exit. Let the existing
  lifecycle retry recoverable failures. Bound shutdown and kill the child if it
  does not exit.

### Event mapping

| Grok ACP input | Codekin output |
| --- | --- |
| `agent_message_chunk` (text content) | `text` delta and the normal output stream |
| `agent_thought_chunk` | `thinking`, under the existing UI disclosure rules |
| `tool_call` | `tool_active`, keyed by `toolCallId`. The first `tool_call` has only `title` = raw tool name and `_meta["x.ai/tool"]` (`name`, `kind`, `read_only`). Normalize by `_meta["x.ai/tool"].kind`/`name` (`execute`/`run_terminal_command` → `Bash`, `write` → `Write`, edit → `Edit`, …) and summarize `rawInput` |
| `tool_call_update` without `status` | refresh the summary. It carries the human title (``Execute `cmd` ``), ACP `kind`, and `diff` content for edits |
| `tool_call_update` with `completed`/`failed` | `tool_done` (plus `tool_output` for bounded text content). Repeated `in_progress` updates stream output; the `rawOutput.output` byte arrays must not be forwarded |
| `plan` | `todo_update` when entries map to `{content, status}`; otherwise ignore |
| `session_info_update` (`title`) | optional: offer as the session name instead of a utility-agent call |
| `current_mode_update` | reconcile Codekin's displayed mode |
| `session/prompt` response | exactly one `result` per turn. `stopReason` `end_turn` → success; `cancelled`, `refusal`, `max_tokens`, `max_turn_requests` → result with that reason surfaced |
| `session/prompt` response `_meta.usage` | `usage`: `inputTokens`, `outputTokens`, `cachedReadTokens`, `reasoningTokens`, `costUsdTicks` (1 USD = 10^10 ticks, which may be absent) |
| `_x.ai/*` notifications (setup phases, MCP status, queue, announcements, settings, `session_notification`) | ignored. They are high-volume and not part of the contract; log only in debug |
| process failure | `error` followed by `exit`; do not synthesize a successful result |

Tool calls still open when a turn ends are closed with `tool_done` (error) so
the UI never shows a spinner forever. Unknown optional update types are
ignored with rate-limited diagnostics. Unknown messages that affect turn
completion, permissions, or tool ownership fail visibly; they must not make
the UI report a completed turn while Grok is still working. Unknown
agent-to-client **requests** get a JSON-RPC error response right away, never
silence, as Codex does.

`sendMessage()` sends `session/prompt` with text content blocks (images later,
if `promptCapabilities.image` is advertised) and serializes turns per session.
`stop()` sends `session/cancel` for an active turn, drops any pending
permission request and its UI prompt (Grok resolves it itself), waits a bounded time for the `cancelled`
prompt response, then terminates the child. If the UI exposes “stop response”
separately from ending the session, map the first to `session/cancel` only.

## Permissions and plan mode

### Mode mapping

Grok's native modes are `default` (ask), `acceptEdits`, `auto`, `dontAsk`,
`bypassPermissions`/always-approve, and plan. Codekin's `PermissionMode` is
`default | acceptEdits | plan | bypassPermissions |
dangerouslySkipPermissions`. Mapping, verified on grok 1.0.44 except where
noted:

| Codekin mode | Grok launch | Codekin-side policy on `session/request_permission` |
| --- | --- | --- |
| `default` | ask (no `_meta` mode) | forward every request to `PromptRouter` |
| `acceptEdits` | ask | auto-allow once for edit-kind requests whose path is inside the working directory; forward the rest |
| `plan` | ask + `session/set_mode {modeId: "plan"}` | deny edit-kind requests without prompting (Codekin's plan-mode rule); shell commands prompt the user, as for every harness |
| `bypassPermissions` / `dangerouslySkipPermissions` | `_meta.yoloMode: true` on new/load | none (Grok deny rules still apply) |

**Grok's ask mode is not Claude's default mode.** Grok auto-approves commands
it classifies as safe, with no `session/request_permission` sent. In the spike,
`touch`, `mkdir -p`, and `git status` ran unprompted, including `touch` on a
path **outside** the working directory. `rm` and shell redirects (`echo >`)
did prompt. Codekin cannot see or veto those auto-approvals. The UI's
Ask/plan labels for Grok must say “Grok asks for commands it considers
risky”, not “asks before every command”. Tightening this (for example a
`[permission] ask = ["Bash"]` rule in the user's `~/.grok/config.toml`; the
`GROK_CONFIG` overlay cannot set permissions) is a follow-up. It must be
verified before the UI claims more.

Do not map any Codekin mode to Grok's `auto`. Its classifier decides without
the user, and that decision is not visible to Codekin.

Mode changes on a live session (Codekin's `setPermissionMode`): switching into
or out of `plan` uses `session/set_mode` and is acknowledged by a
`current_mode_update`. `set_mode` returns `{}` even for unknown mode IDs, so
treat the `current_mode_update` as the confirmation and fail visibly without
it. Toggling yolo on a live session is unverified (`/always-approve on|off` is
an advertised slash command). Until verified, change it by restarting the
child with `session/load` and new `_meta`, the same way OpenCode re-applies
settings when it resumes a session.

### Approval bridge

- Translate `session/request_permission` into `control_request` with the
  normalized tool name and input, so the existing auto-approval registry,
  plan-mode denial, and UI prompt all apply unchanged.
- Answer with the request's own `options[]`, selecting by `kind`:
  Codekin `allow` → `allow_once`, `deny` → `reject_once`. Observed options:
  shell requests offer `always-allow` (“don't ask again for bash commands”,
  which is **all** bash, not this command), `allow-once`, `reject-once`, and
  `reject-always`; edit requests offer `allow-edits-session`, `allow-once`, and
  `reject-once`. Because Grok's `allow_always` is broader than Codekin's
  per-pattern “Always allow”, map Codekin `allow_always` to `allow_once` and
  let Codekin's own registry remember the pattern. A cancelled turn
  answers with the ACP `cancelled` outcome.
- **A rejection ends the turn.** `reject_once` fails the tool and the prompt
  resolves with `stopReason: "cancelled"` (Grok's
  `_x.ai/session/prompt_complete` adds `cancellationCategory:
  "PermissionRejected"`). This differs from Claude, where the model sees the
  denial and continues. Report a denied-then-stopped turn as “stopped after
  denial”, not as a user cancel or an error.
- Pending permission requests time out under the same policy as other
  harnesses; unattended sessions deny instead of waiting indefinitely.

### Cross-harness configuration bleed

Grok reads several Claude Code files by default, so a Grok session inherits
more than its own config. The spec must account for each:

- `.claude/settings.json` and `.claude/settings.local.json` permission rules.
  Codekin's “Always allow” dual-writes Claude rules into
  `.claude/settings.local.json` (`approval-manager.ts` → `native-permissions.ts`),
  so a rule approved in a Claude session also silently auto-approves in Grok.
  This is acceptable only if the Always-allow UI says so. Otherwise
  scope Codekin's registry and skip the Claude dual-write for Grok approvals.
- Claude hooks: disabled for Grok children via `GROK_CLAUDE_HOOKS_ENABLED`
  (see Startup), because Codekin's own global `PreToolUse` hook otherwise
  pre-approves tools. Without that setting, user-scope Claude hooks
  demonstrably run (`global/settings:pre_tool_use`,
  `user_prompt_submit`).
- `CLAUDE.md` / `AGENTS.md` project rules, `.claude/skills` (exposed as Grok
  slash commands), and MCP servers from `~/.claude.json`, `.mcp.json`, and
  Cursor configs. The spike session inherited the user's `bookgraph` and
  `tubegraph` MCP servers and Claude skills. This is desirable; keep it.
- Folder trust: project rules, skills, and hooks load only in trusted folders.
  Confirm how `agent stdio` treats trust. If it is untrusted by default, the
  Grok session won't see `CLAUDE.md`, and the UI must say so. Do not grant
  trust automatically on the user's behalf.

### Plan mode

Grok's plan mode is **not** a read-only sandbox. Verified: after
`session/set_mode plan`, the write tool was rejected by Grok itself (“file
edits are not allowed in plan mode”), but `echo x > plan-shell.txt` arrived
as an ordinary permission request and, when allowed, wrote the file.
Subagents also start outside the plan gate. Therefore:

- Codekin `plan` launches Grok in ask mode, never yolo. Edit requests are
  denied by Codekin's plan-mode rule; shell commands reach the user as
  ordinary prompts (the same behaviour as Claude plan mode), so a shell write
  needs an explicit approval. Plan-mode safety comes from Codekin, not from
  Grok's gate. Grok's safe-command
  auto-approval (above) still applies, so `touch`/`mkdir` can run in plan mode.
  The plan-mode label must not promise “read-only”.
- Grok's `exit_plan_mode` approval should map to Codekin's existing
  plan-approval UI (`planning_mode` event, ExitPlanMode prompt) if it
  arrives as a permission request. If not, show the plan as text and hide the
  plan-approval affordance for Grok.
- Plan state persists in Grok across restarts (`plan_mode.json` in the
  session directory; `current_mode_update` is part of the load replay). On
  `session/load`, reconcile it with Codekin's stored mode.

### Release gate

Before enabling a mode in the UI, use a real released `grok` binary to verify
and record:

- An unapproved shell command and an unapproved file edit each produce a
  `session/request_permission` that Codekin can answer. Test allow once,
  allow always, deny, and cancel-while-waiting.
- Codekin `plan` blocks edits and shell writes (for example, `echo > file`),
  including after a restart and via a subagent.
- `yoloMode` runs tools without requests and is only reachable through an
  explicit user choice.
- Unattended turns never hang on an approval.

If the pinned release does not deliver actionable approval requests, **do not
ship Ask/acceptEdits/plan as if they work**. Ship Grok with only the
always-approve mode, labeled plainly, until the bridge is verified. A
third-party client ([grok-build-desktop](https://github.com/Rushour0/grok-build-desktop))
reported missing `session/request_permission` events on earlier builds. Treat
that as a test lead, not as proof about the target version.

## Provider registration and UI

The compiler catches `Record<CodingProvider, …>` sites; it does not catch
`switch` statements without a default, string-literal comparisons, or
localStorage keys. Every site is listed here so none is missed.

**Server**
- Add `grok` to `CodingProvider` (both copies) and `VALID_PROVIDERS`. Add
  `GROK_CAPABILITIES`. `PROVIDER_LABELS` in `session-lifecycle.ts`.
- `harness-registry.ts` entry: `probe()` runs `grok --version`. It reports
  authenticated when `XAI_API_KEY` is set or `$GROK_HOME/auth.json` **exists**
  (never read its contents). `createProcess()` passes `claudeSessionId` as the
  native ID, plus model, `extraEnv`, and `permissionMode`.
- `ws-message-handler.ts` / `session-routes.ts` provider validation, and the
  per-provider default-model logic.
- `ws-server.ts` `connected` frame (`server/types.ts`, `src/types.ts`) adds
  optional `grokAvailable` and `grokAuthenticated` fields; old clients ignore them.
- Model list: `GET /api/grok/models` backed by a cached `fetchGrokModels()`
  that runs a short-lived `grok agent stdio` → `initialize` → `session/new`
  and reads `configOptions[model]` (mirroring `fetchCodexModels`). The
  `initialize` response's `_meta.modelState.availableModels` already lists
  models with context size and reasoning efforts, so `session/new` is only
  needed as a fallback. Use `grok models` output only if the ACP route fails.
  Do not hard-code a model catalog. Live model switches use
  `session/set_config_option {configId: "model", value}`; the response is the
  updated option list, and an unknown ID returns JSON-RPC `-32602`. Add the
  route to the relay `connector-proxy.ts` allowlist.

**Frontend**
- `PROVIDERS` in `src/types.ts`; `agentHealth.ts` (`providerAvailability` has
  no default case, so add one returning a soft/unknown state).
- `App.tsx` health state, `*Disabled` flags, model hook, `availableModels`,
  localStorage model key, toggle handlers.
- `ConnectionPopup.tsx` rows, plus prop threading through `LeftSidebar.tsx` and
  `SessionContent.tsx`. Consider replacing the per-harness props with a
  keyed map while there; four copies is the point where that pays off.
- `InputBar.tsx` `visibleModes`: show only the verified Grok modes.
  `ProviderModelSection.tsx`, `EditWorkflowModal.tsx`, `workflowApi.ts`,
  `ccApi.ts`, `RepoSection.tsx`, `NewSessionButton.tsx`.
- New `useGrokModelSync` hook, modeled on `useCodexModelSync`.
- `environmentChecklist.ts` keeps a second copy of the install hints. Derive
  it from the registry, or at least add Grok to it.
- README prerequisites, setup docs, and consistent “Grok” spelling in badges
  and labels.

## Handoff, utilities, workflows, and orchestration

- **Utility agent (ships with registration).** `utility-agent.ts` tries every
  available and authenticated harness, in registry order, for session naming
  and handoff distillation. Grok therefore joins this rotation the moment it
  is registered. Place it last in the registry, and add `XAI_API_KEY` to
  `buildOneShotEnv`. Its `oneShotCommand()` must not edit the repo or block:
  `grok -p <prompt> --output-format json --tools read_file,grep,list_dir
  --max-turns <small> --no-auto-update`, with a timeout. Verify the flags
  against the pinned CLI.
- **Transcript reader.** Add a Grok branch in `transcript-readers.ts`
  (today every non-Codex provider falls through to the Claude parser). Resolve
  `$GROK_HOME/sessions/<encoded-cwd>/<id>/updates.jsonl` from the exact cwd,
  handling the long-path slug form through its `.cwd` file. The encoding is
  `encodeURIComponent`-style (`/tmp/grok-spike/repo` →
  `%2Ftmp%2Fgrok-spike%2Frepo`). Validate that `<id>` is a plain ID so it
  cannot escape the directory, and bound the read. Each line is
  `{timestamp, method, params}` with `method` = `session/update` or
  `_x.ai/session/update`. Chunks are already coalesced per message. Parse
  `user_message_chunk`, `agent_message_chunk`, and `tool_call` titles. Extend the `handoff-manager.ts`
  labels, keep the display-buffer fallback, and test switching in both directions.
- **Workflows and loops.** Add `grok` to `workflow-config.ts`,
  `workflow-loader.ts`, `workflow-routes.ts`, and `loop-recipe.ts`
  (`LoopProvider`, loop `PROVIDERS`) only after unattended permission and
  stop behavior pass the gate. `different-from-maker` currently hard-codes
  `claude ↔ codex`; a Grok maker should resolve to `claude`. Keep the
  resolver deterministic and documented.
- **Agent Joe.** Joe's provider is validated only against `VALID_PROVIDERS`,
  so registering Grok makes Joe-on-Grok selectable immediately. Explicitly
  exclude `grok` from Joe's provider validation until MCP access is verified.
  Joe's per-harness MCP registration (`orchestrator-manager.ts`) should pass
  Codekin's MCP server through ACP `session/new` `mcpServers`. That is
  per-session and needs no config files, unlike Claude's `.mcp.json` or
  Codex's `config.toml`. Test both that path and Joe's HTTP fallback.

## Validation and acceptance

1. **Protocol fixture tests** (captured from the pinned binary, sanitized):
   initialize/new/load, load replay without duplicate output or results,
   interleaved updates and RPC replies, two sequential prompts, tool
   start/update/end, tools left open at turn end, permission request and each
   answer, cancel mid-tool and mid-permission, error stop reasons, process
   exit, malformed lines, and unknown request methods.
2. **Permission tests on a real CLI:** read, edit, shell, allow, allow always,
   deny, plan (including shell writes and subagents), yolo, and an unattended
   turn. Record the tested Grok version and the observed ACP messages in a
   `docs/` appendix. Do not claim a capability from docs alone.
3. **Codekin integration tests:** create a Grok session, stream a result, reload
   after a server restart, switch Claude/Codex ↔ Grok with context, and verify
   provider/model/health controls in local and hosted views.
4. **Regression checks:** the existing three harnesses keep their behavior,
   including after the shared env-helper refactor. Run typecheck/build, focused
   server/frontend tests, then normal CI.

Done means a user can install Grok Build, choose Grok in Codekin, complete a
multi-turn coding task with visible tool events, resume it after restart, and
understand which permission mode is actually enforced. If the permission gate
cannot be met on the chosen CLI release, the UI exposes only verified modes and
states that limitation plainly.

## Implementation sequence

0. **Spike: done** (grok 1.0.44, 2026-09-30). See
   [Spike results](#spike-results-grok-1044). Before step 2, capture sanitized
   fixtures (strip host paths, hostnames, MCP URLs, and response
   `signature`s) into `server/__fixtures__/grok/`.
1. Extract `buildHarnessEnv()`; no behavior change.
2. `GrokProcess` plus the pure mapper module and fixture tests.
3. Registry entry, provider unions, health, model route and hook, UI controls,
   docs. Joe, workflows, and loops stay excluded.
4. Transcript reader and handoff.
5. Workflows, loops, and Joe, once unattended mode has passed the gate.

## Spike results (grok 1.0.44)

Probed on 2026-09-30 with a throwaway ACP client against `grok agent
--no-leader stdio`, logged in via grok.com, in a scratch git repo.

| Question | Result |
| --- | --- |
| Does `session/request_permission` arrive in ask mode? | **Yes**, for `rm`, shell redirects, and file writes. `allow-once` ran the tool; `reject-once` failed it **and ended the turn** (`stopReason: cancelled`). |
| Does everything risky prompt? | **No.** `touch` (including outside the cwd), `mkdir -p`, and `git status` auto-ran with no request. |
| Do Codekin's Claude hooks interfere? | **Yes.** The global `PreToolUse` hook returned `allow` and Grok skipped the prompt. `GROK_CLAUDE_HOOKS_ENABLED=false` removes this. |
| Is there a live mode switch? | `session/set_mode {modeId: "plan"}` works and emits `current_mode_update`. It returns `{}` for unknown IDs too. There is no `modes` field in responses. |
| Does plan mode enforce read-only? | Edit tools are blocked by Grok. Shell writes come through as permission requests and run if allowed. |
| Does `yoloMode` work? | Yes: shell tools run with no request. |
| Does `session/load` replay? | Yes, before the load response: user/agent/thought chunks, tool calls with final status, the mode, and `turn_completed` markers. |
| Does model discovery/switch work? | `initialize` `_meta.modelState` and `session/new` `models`/`configOptions` list `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`. `set_config_option` switches models; an unknown ID → `-32602`. |
| Usage/cost? | Prompt response `_meta.usage` has token counts and `costUsdTicks`. Headless `-p` reports its model as `grok-4.7-build`, which `grok models` does not list. |
| Inherited config? | User MCP servers (`bookgraph`, `tubegraph`), Claude skills as slash commands, and `CLAUDE.md` rules loaded in an untrusted `/tmp` repo. |
| Cancel | With a permission request pending (`rm`), `session/cancel` resolved the interaction on Grok's side with no client reply. The prompt returned `cancelled` (`cancellationCategory: MidTurnAbort`) within 5 ms, the command did not run, and the next prompt worked. The adapter must drop its pending approval (and dismiss the UI prompt) instead of answering it. |

Still open:

- Whether `exit_plan_mode` reaches the client as a permission request; the
  spike did not drive a full plan → approve cycle.
- Whether `/always-approve on|off` toggles yolo on a live session with Claude
  hooks disabled.
- Whether a user-level `[permission] ask = ["Bash"]` rule makes Grok prompt
  for the commands it currently auto-approves.
- Joe via ACP `session/new` `mcpServers` (not exercised).
