# Grok Build integration spec

Status: **proposed**

Date: **2026-09-27**

Target: first-class `grok` coding harness in Codekin

## Goal

Let a user install and authenticate the official Grok Build CLI, then create,
resume, and switch to a Grok coding session in Codekin with the same core chat,
tool activity, cancellation, and permission experience as the existing harnesses.
Grok Build is SpaceXAI's coding agent (`grok`), distinct from using an xAI model
inside OpenCode or calling the Grok model API directly.

## Current Codekin boundary

Codekin already represents Claude Code, OpenCode, and Codex as `CodingProcess`
implementations. `server/harness-registry.ts` owns the process factory, boot probe,
install hint, and one-shot command. `server/session-lifecycle.ts` converts process
events into the shared session stream. The UI uses `CodingProvider` and `PROVIDERS`
from `src/types.ts`. Grok should use these seams, with its own adapter; Claude's
stream-JSON and Codex's app-server messages are different wire protocols.

The local host runs `grok`; the browser never receives Grok credentials. Hosted
Codekin continues to reach the local host through Codekin's existing relay.

## External interface to use

Use `grok agent stdio`, Grok Build's Agent Client Protocol (ACP) transport, as the
interactive session backend. It exchanges JSON-RPC over stdin/stdout and exposes
session creation/loading, prompt and update messages. Grok's own integration
guide describes text and thought chunks, tool calls, plans, and session IDs. Its
on-disk sessions live under `~/.grok/sessions/<encoded-cwd>/<session-id>/`.

Do **not** build the interactive adapter around repeated `grok -p` invocations.
Headless `--output-format streaming-json` is useful for a single prompt, but its
documented event examples do not provide the rich tool and approval lifecycle
Codekin needs. Use headless mode only for `oneShotCommand()` utilities.

References: [Grok Build source and overview](https://github.com/xai-org/grok-build),
[CLI, ACP, and persistence guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md),
[permission guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md).

## User behavior

1. When `grok` is on the host's PATH (or `GROK_BINARY` points to it), Grok appears
   alongside Claude, OpenCode, and Codex in new-session, provider-switch, and
   provider/model controls. A missing binary disables it with an install hint.
   Failed auth detection warns but does not block, matching existing providers.
2. The user authenticates through `grok login`/browser login or an `XAI_API_KEY`
   configured **on the host**. Codekin stores neither credential nor token.
3. Creating a Grok session opens an ACP session in its selected working directory.
   Messages and tool progress stream into the normal Codekin transcript. A refresh
   rejoins the Codekin session; a host restart reloads Grok's native session ID.
4. Switching to or from Grok follows the existing “Carry context” flow. The source
   harness's native session is never silently resumed by a different harness.
5. Permission controls display only modes that the integration can enforce. A mode
   must not claim user approval while Grok can execute gated tools without a
   Codekin decision.

## Process adapter

Add `server/grok-process.ts` implementing `CodingProcess` and emitting the existing
`ClaudeProcessEvents` contract. Keep ACP parsing and Grok-specific state inside
this adapter. Use one child process per active Codekin session, with JSON-RPC
request IDs and a single stdout reader; do not implement response handling with
per-request `once('line')` listeners because notifications can interleave.

### Startup and session identity

- Spawn `GROK_BINARY || 'grok'` with `agent stdio` and `cwd = session.workingDir`.
  Strip inherited `GIT_*` variables using the same policy as existing adapters.
  Pass only the session-scoped Codekin token, never the server master token.
- Send ACP `initialize` with a protocol version and only client capabilities
  Codekin actually implements. Do not advertise filesystem or terminal callbacks
  until their corresponding request handlers exist. Inspect the initialize
  response and reject unsupported protocol versions with a clear error.
- For a new session, call `session/new` with the working directory and supported
  MCP configuration. For a stored native ID, call `session/load` with the same
  directory. Persist the returned native ID in the existing
  `Session.claudeSessionId` field for compatibility; a later generic field rename
  can be a separate migration. `getSessionId()` returns that native ID.
- Mark the process ready only after initialize and new/load finish. Restore
  history without rebroadcasting replayed ACP updates as new chat content.
- Handle child exit, malformed JSON, JSON-RPC errors, startup timeout, stdin
  errors, and pending request rejection; let the existing lifecycle retry a
  recoverable failure. Bound shutdown and kill the child if it does not exit.

### Event mapping

| Grok ACP input | Codekin output |
| --- | --- |
| `agent_message_chunk` | `text` delta and the normal output stream |
| `agent_thought_chunk` | `thinking` summary, with the existing UI disclosure rules |
| `tool_call` and subsequent tool status updates | paired `tool_active` / `tool_done`; include a short safe input summary |
| `plan` | `todo_update` if entries map faithfully; otherwise show plan as text until mapped |
| `session/prompt` completion | exactly one `result` per turn, including cancelled/error cases |
| process failure | `error` followed by `exit`; do not synthesize a successful result |

Unknown optional update types are ignored with rate-limited diagnostics. Unknown
messages affecting turn completion, permissions, or tool ownership fail visibly;
they must not make the UI report a completed turn while Grok is still working.
Capture sanitized protocol fixtures from a pinned released binary before finalizing
the event mapper. Do not infer usage/cost from text; show it only if Grok supplies
reliable structured values.

`sendMessage()` sends an ACP `session/prompt` with text content and serializes turns
per session. `stop()` sends `session/cancel` for an active turn where supported, then
terminates the child with a bounded wait. Map Codekin's “stop response” separately
from stopping the session if the current UI exposes both actions.

## Permissions and plan mode: release gate

Grok's CLI documents ask/auto/always-approve modes, allow/deny rules, sandbox
profiles, and ACP `_meta.yoloMode` at session creation. These are distinct from
Codekin's modes and must be translated explicitly. In particular,
`--always-approve` is not a safe substitute for Codekin's normal `acceptEdits`
mode. Grok also loads project and Claude-compatible permission settings, so its
effective rules may differ by repository.

Before enabling a mode in the UI, use a real released `grok` binary to verify:

- An unapproved shell command and an unapproved file edit each cause an ACP
  permission request that Codekin can answer, or are blocked by a verified
  fail-closed mechanism. Test allow once, deny, and cancellation while waiting.
- `plan` prevents writes and commands as intended, including after restart.
  Use ACP `session/set_mode` only if the pinned binary advertises and honors it;
  otherwise start a fresh read-only session or hide the mode.
- The least-restrictive Codekin mode maps deliberately to Grok's documented
  always-approve behavior; it must remain an explicit user choice.
- Headless or unattended sessions never wait indefinitely for an approval UI.
  Apply a documented bounded policy for automated workflows.

If the ACP release does not deliver actionable approval requests, **do not ship
Ask/acceptEdits as if they work**. Either add and verify a fail-closed approval
bridge, or ship Grok only for an explicitly labeled always-approve mode. A third-
party client has reported missing `session/request_permission` events on earlier
Grok builds; treat that as a test lead, not as proof about the target version.
[Report](https://github.com/Rushour0/grok-build-desktop)

## Provider registration and UI

- Extend `CodingProvider` and `VALID_PROVIDERS` in `server/coding-process.ts`,
  `server/types.ts`, and `src/types.ts` with `grok`; define verified capabilities
  and add `Grok` to `PROVIDERS`.
- Add Grok to `server/harness-registry.ts`: version/auth probe, install hint,
  `createProcess()`, and a bounded one-shot command. Probe `grok --version` and
  `XAI_API_KEY`/Grok's supported auth status if one is available; never read or
  expose `~/.grok/auth.json` contents. Auth is a soft signal.
- Extend `server/ws-server.ts` connected health and `src/lib/agentHealth.ts`.
  Keep old clients compatible by adding optional fields and treating unknown
  health as a soft state.
- Model list: prefer models advertised by the ACP initialize/session response or
  a documented Grok discovery command. Add `/api/grok/models` only if the UI
  needs a separate fetch. Avoid a hard-coded model catalog; default to the CLI
  model when discovery fails. Update model hooks, workflow provider picker,
  environment checklist, and hosted relay route allowlist as needed.
- Ensure session naming, sidebar badges, provider switch controls, input-mode
  labels, README prerequisites, and setup documentation spell Grok consistently.

## Handoff, workflows, and orchestration

- Add a Grok reader in `server/transcript-readers.ts` for the native
  `updates.jsonl` under Grok's cwd-scoped session directory. Resolve the path
  safely from the exact cwd and native ID; parse user/assistant text and tool
  titles with a bounded extract. Extend `server/handoff-manager.ts` labels and
  verify switching both directions. Preserve the existing display-buffer
  fallback when a transcript is missing or unreadable.
- Add `grok` to workflow configuration/validation and loop provider types only
  after the adapter supports their noninteractive permission and stop semantics.
  The existing “different-from-maker” resolver needs an explicit Grok case;
  keep its default deterministic and documented.
- Agent Joe may use Grok once the core adapter works. Confirm Grok can discover
  Codekin's MCP server or use Joe's existing HTTP fallback; test both rather
  than assuming Claude's `.mcp.json` registration behaves identically.
- The harness registry's `oneShotCommand()` must be bounded, noninteractive,
  and suitable for session naming/handoff distillation. Verify the chosen
  headless `grok -p` flags against the target CLI so utility work does not edit
  the repo or block on tool approval.

## Validation and acceptance

1. **Protocol fixture tests:** initialize/new/load, interleaved updates and RPC
   replies, two sequential prompts, tool start/end, error, cancel, process exit,
   malformed lines, and resume replay without duplicate output.
2. **Permission tests on a real CLI:** read, edit, shell, allow, deny, plan,
   always-approve, and an unattended turn. Record the tested Grok version and
   sanitized observed ACP messages. Do not claim a capability from docs alone.
3. **Codekin integration tests:** create a Grok session, stream a result, reload
   after a server restart, switch Claude/Codex ↔ Grok with context, and verify
   provider/model/health controls in local and hosted views.
4. **Regression checks:** existing three harnesses retain their behavior;
   run typecheck/build and focused server/frontend tests, then the normal CI.

Done means a user can install Grok Build, choose Grok in Codekin, complete a
multi-turn coding task with visible tool events, resume it after restart, and
understand which permission mode is actually enforced. If the permission gate
cannot be met on the chosen CLI release, the UI exposes only verified modes and
states that limitation plainly.

## Implementation sequence

1. Pin a supported Grok CLI version for integration testing and collect ACP
   fixtures, especially permission and mode behavior.
2. Implement `GrokProcess` and its focused protocol tests.
3. Register the provider, health, models, UI controls, and documentation.
4. Add transcript handoff, then workflow/loop/Joe support once unattended mode
   has passed the permission gate.

This spec does not add Grok model calls directly to Codekin. Users who only
want Grok models can already configure xAI through OpenCode.
