# OpenCode Integration Audit

**Date:** 2026-06-11
**Scope:** How Codekin integrates OpenCode vs Claude Code, why OpenCode sessions feel verbose / loop / stall, and high-level improvements to take full advantage of the platform.

---

## Executive summary

Codekin's OpenCode integration is structurally sound — it correctly uses `opencode serve` + HTTP + SSE rather than the fragile `opencode run` mode — but it is **semantically hollow**. The transport works; almost everything layered on top of the transport for Claude (system-prompt injection, agent/mode selection, permission configuration, plan mode, turn-completion guarantees, skills, model switching) is missing or stubbed for OpenCode. In addition, a global user config (`~/.config/opencode/opencode.jsonc`) **replaces OpenCode's tuned build-agent system prompt** with a generic one, which by itself plausibly explains much of the verbosity and looping.

The three reported symptoms map to concrete causes:

| Symptom | Primary cause |
|---|---|
| Verbose, runs in circles | Tuned system prompt replaced by generic override in `~/.config/opencode/opencode.jsonc`; no Codekin context injected; no agent (`build`/`plan`) selected per turn |
| Stops mid-way | Turn-completion latch can never fire if SSE drops before `session.idle`; no in-flight turn timeout; permission `ask` states can deadlock; zombie sessions after reconnect exhaustion |
| Generally weaker than Claude sessions | Feature gaps: no AGENTS.md/skills surface, no plan mode, no permission-mode mapping, no mid-session model picker, lossy event translation |

---

## 1. Root cause outside the repo: the system prompt override

`~/.config/opencode/opencode.jsonc` sets `agent.build.prompt` to a long generic prompt. Per OpenCode semantics, this **replaces** (does not append to) the tuned, provider-specific system prompt OpenCode ships per model — including its conciseness norms, todo discipline, and anti-looping guidance. Codekin does not write this file, but every Codekin OpenCode session inherits it.

**Recommendation (highest impact, zero code):** remove or drastically trim the `agent.build.prompt` override. If Codekin-specific guidance is needed, prefer an `AGENTS.md`/`instructions` entry (additive) over `agent.*.prompt` (replacing).

## 2. "Stops mid-way": turn lifecycle is not robust

`server/opencode-process.ts`:

- **Turn-completion latch with no safety net** (`turnComplete`, lines 262, 658–737, 853): the turn only ends when one of `message.completed` / `session.status` / `session.idle` arrives over SSE. If the SSE stream drops mid-turn and the idle event is missed, the latch never fires — the session hangs with no `result`, indefinitely. There is no in-flight turn timeout (Claude path has a 60s startup timeout; OpenCode has none anywhere).
- **Zombie sessions after reconnect exhaustion** (lines 369–453): after 20 failed SSE reconnects the code emits `error` but the process stays `alive` and never emits `exit` — the frontend shows a running session that will never respond.
- **Reconnect does not recover turn state**: on reconnect, `turnComplete`, delta buffers, and reasoning state are not reconciled with the server (the server API exposes message history that could be used to resync).
- **Permission deadlocks**: OpenCode defaults several permissions to `ask` (`external_directory`, `doom_loop`, `.env` read denied). Codekin surfaces `permission.asked` as a control request, but (a) permission replies that fail over HTTP are swallowed (lines 784–789) — the user believes they approved while OpenCode still blocks; (b) Codekin never configures OpenCode's `permission` object from the session's `permissionMode`, despite the field claiming so (line 241), so `bypassPermissions` sessions still hit `ask` states server-side until the event round-trips.

**Recommendations:**
- Add a per-turn watchdog: if no SSE event for a session arrives for N seconds while a turn is open, query `GET /session/:id/message` (or session status) to resync, and force-complete or surface an error.
- After reconnect exhaustion, emit `exit` so the session transitions to a terminal state in the UI.
- On permission-reply HTTP failure, retry and surface the failure as a session error instead of `console.error`.
- Map Codekin `permissionMode` to OpenCode's `permission` config at session creation (e.g. `bypassPermissions` → all-allow), instead of only reactively auto-approving `permission.asked` events.

## 3. Feature parity gaps vs the Claude path

| Capability | Claude path | OpenCode path | OpenCode supports it? |
|---|---|---|---|
| System prompt context | `--append-system-prompt` with Codekin environment guidance (`claude-process.ts:208–215`) | none | Yes — `instructions` config, AGENTS.md, or custom agent definitions |
| Plan mode | `EnterPlanMode`/`ExitPlanMode` detection → `planning_mode` events | none, despite `capabilities.planMode: true` (line 114) | Yes — first-class `plan` agent; select via `agent` field on prompt |
| Agent selection | n/a (permission modes) | prompt body sends only `parts` + `model` (lines 909–926); never selects `build`/`plan`/custom agents | Yes — `agent` param on `/session/:id/prompt` |
| Permission modes | `--permission-mode`, granular control, `updatedInput` | global once/always/reject only; mode not pushed into config | Yes — per-tool `permission` object with pattern rules |
| Skills / slash commands | `.claude/skills` menu in InputBar | hidden | Partially — OpenCode has its own commands API (`/command` endpoints), unused |
| Mid-session model picker | InputBar dropdown | only at session creation (`App.tsx:222, 274–276`) | Yes — model is per-request already (lines 912–916); this is purely a UI gap |
| Todos | `todo_update` events → TodoPanel | partial (todowrite mapped) but step boundaries (`step-start`/`step-finish`) discarded (line 647) | Yes |
| Thinking display | thinking blocks → activity label | fragile text/reasoning delta disambiguation (lines 509–522) | Yes — `--thinking` / reasoning parts |
| Tool input summaries in permission UI | `summarizeToolInput` | permission type string only — user sees e.g. "external_directory" with no detail | Yes — `permission.asked` carries pattern/metadata |
| Context files | CLAUDE.md auto-loaded by CLI | implicit only (OpenCode falls back to CLAUDE.md unless `OPENCODE_DISABLE_CLAUDE_CODE=1`) — never verified or surfaced | Yes |

## 4. Translation-layer quality issues

- **Lossy event handling**: unhandled SSE event types are logged and dropped (`opencode-process.ts:762–767`). No inventory exists of which OpenCode bus events matter; new event types added upstream degrade silently.
- **User-echo heuristic**: initial deltas are buffered and compared against `lastUserInput` to suppress echo (lines 526–537, 853–860). If SSE drops before the buffer flushes, text is lost; flags are not reset on reconnect.
- **Hand-rolled HTTP/SSE client**: the official `@opencode-ai/sdk` (`createOpencodeClient`) provides typed sessions, events, and permission replies. Migrating would eliminate most of the bespoke parsing and track upstream protocol changes.
- **Brittle provider inference**: `EditWorkflowModal.tsx:36–38` infers provider from `!model.startsWith('claude-')`.

## 5. UX gaps (frontend)

- No permission-mode selector, no plan-mode entry point, no skills menu, and no mid-session model switcher for OpenCode sessions (`InputBar.tsx:503–517`, `App.tsx:222`), even where the backend could support them today.
- Features silently degrade: if OpenCode emits no `thinking`/`todo_update`/`planning_mode`, the UI shows empty state with no indication the capability is absent.
- Session resume rebuilds from `outputBuffer` uniformly (`useChatSocket.ts:327–366`) but no verification that the OpenCode path populates equivalent history events.

---

## Prioritized roadmap

1. **Fix the prompt override** (config change, no code): restore OpenCode's native system prompt; move any custom guidance to AGENTS.md/`instructions`. Likely fixes most verbosity/looping.
2. **Turn-lifecycle hardening** (server): in-flight turn watchdog + resync via message history; emit `exit` on reconnect exhaustion; retry + surface permission-reply failures. Fixes "stops mid-way".
3. **Map permission modes** to OpenCode's `permission` config at session creation; pass `agent: 'plan' | 'build'` on prompts to get real plan mode; surface permission metadata (patterns) in the approval UI.
4. **Adopt `@opencode-ai/sdk`** to replace the hand-rolled SSE/HTTP client and reduce translation-layer drift.
5. **Frontend parity**: mid-session model picker (backend already supports it), agent selector, OpenCode commands menu, and explicit "not supported by this provider" affordances instead of silent empty states.
6. **Inject Codekin context** for OpenCode sessions (web-terminal environment, report conventions) via project `AGENTS.md` or per-session `instructions`, mirroring `--append-system-prompt`.

## Key files

- `server/opencode-process.ts` — spawn, SSE, turn latch, permissions (988 lines)
- `server/claude-process.ts` — reference implementation of the richer path (779 lines)
- `src/components/InputBar.tsx`, `src/App.tsx` — provider-conditional UI
- `~/.config/opencode/opencode.jsonc` — system prompt override (outside repo)

## Upstream references

- OpenCode server/SDK docs: opencode.ai/docs/server, /docs/sdk, /docs/permissions, /docs/agents, /docs/rules
- Known headless-hang issues: anomalyco/opencode#3503, #11899, #14473, #16367, #17516
