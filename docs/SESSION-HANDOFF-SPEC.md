# Session Handoff Spec

Pass a session's context between coding harnesses (Codex → Claude Code, Claude Code →
OpenCode, …) without manual copy-paste.

Status: **draft / ideation**

## Problem

A common workflow is to research or plan in one harness and implement in another
(e.g. explore with Codex in VS Code, then implement with Claude Code in Codekin).
Today the only bridge is manual copy-paste of conversation fragments.

Codekin already has a primitive internal version: `set_provider` restarts a session
under a new harness, and `SessionManager.buildSessionContext()` injects up to ~4,000
chars scraped from the WebSocket display buffer, framed as a server-restart recovery.
It is lossy, capped, ignores the real transcripts on disk, and cannot import sessions
that never ran inside Codekin.

## Design principle

**Distill, don't translate — and keep a lossless escape hatch.**

1. The *source agent* (or a one-shot distillation run over its transcript) writes a
   structured **handoff document**: goal, state, decisions, files touched, open
   questions. This is what gets injected into the target session.
2. The handoff carries the **path to the raw source transcript**. If the target agent
   needs a detail the summary dropped, it reads/greps the JSONL directly. No
   format-to-format translation layer is ever built or maintained.

Rejected alternatives:

- **Lossless transcript translation** (Codex rollout JSONL → Claude session JSONL +
  `--resume`): both formats are internal and unstable, tool-call schemas don't map,
  raw replay wastes the target's context window, permanent maintenance burden.
- **Summary-only handoff**: cheap but details are unrecoverable; the escape hatch
  costs nothing to add since transcripts already exist on disk.

## Source formats (read-only)

| Harness | Location | Notes |
|---|---|---|
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` | `session_meta` line has `cwd`, `timestamp`; `response_item` lines carry messages/function calls; `event_msg` lines carry `user_message` / `agent_message` |
| Claude Code | `~/.claude/projects/<cwd-slug>/<uuid>.jsonl` | slug is cwd with `/` → `-`; one JSONL per session |
| OpenCode | `~/.local/share/opencode/…` (verify) | reader added in Phase 2 |

Readers only need to extract: cwd, timestamps, user messages, assistant messages, and
tool-call titles — enough to list sessions in a picker and to feed a distillation
prompt. They never need to *write* a foreign format.

## Handoff document format

Markdown with YAML frontmatter, schema-versioned:

```markdown
---
schema: codekin-handoff/v1
source:
  harness: codex            # claude | codex | opencode
  sessionId: 019fd1e8-…
  transcript: /home/dev/.codex/sessions/2026/08/05/rollout-….jsonl
repo: /srv/repos/Multiplier-Labs/codekin
branch: wt/c65ce899
created: 2026-08-08T12:00:00Z
---

## Goal
What the user is ultimately trying to achieve.

## State
What is done, what is in progress, what was verified vs. assumed.

## Key findings & decisions
Facts discovered and choices made, with the *why*.

## Files touched
Paths read/modified that matter, with one-line roles.

## Open questions / next steps
Explicitly what the next session should do first.
```

Storage: `<DATA_DIR>/handoffs/<codekin-session-id>-<ts>.md` for Codekin-generated
handoffs. The file is plain markdown so the user can read/edit it before injection,
and it is portable to any tool (pasteable into a Cursor/ChatGPT session as-is).

## Injection framing

Replaces the current "interrupted by a server restart" fiction with an honest frame,
prefixed to the first user message of the target process (same injection point as
today, `sendMessage` phase 2):

```
[Handoff: this session continues work from a previous <Codex> session.
A handoff summary follows. The full transcript of the previous session is at
<transcript-path> — read or grep it if you need details the summary omits.]

<handoff document body>

[End of handoff. The user's message follows.]
```

## Flows

### Flow 1 — provider switch with context carry (MVP)

1. User switches provider in the UI with **"Carry context"** (default on).
2. Server locates the session's own transcript on disk (`claudeSessionId` →
   `~/.claude/projects/…/<id>.jsonl` for Claude, thread id → the Codex rollout
   file), builds a condensed extract, and distills it into a handoff document via a
   one-shot `claude -p` call (same pattern as session naming: custom system prompt,
   minimal env, timeout). This works whether the source process is alive or dead —
   the transcript is always on disk.
3. Fallback chain when distillation fails or no transcript is found: inject the raw
   condensed extract; last resort is the existing `buildSessionContext()`
   display-buffer summary.
4. `setProvider` proceeds as today (stop process, reset `claudeSessionId`).
5. First user message: handoff injected instead of the restart summary;
   `pendingHandoff` cleared. A small "Handed off from Codex" system line appears in
   the transcript so the user sees what happened.

### Flow 2 — import an external session (Phase 2)

For sessions that never ran in Codekin (e.g. Codex in VS Code — `source: "vscode"`
rollouts already exist on this machine):

1. New-session UI gains **"Continue from another tool…"**: server scans known
   transcript locations, filters by `cwd` matching the chosen repo, lists recent
   sessions (harness, first user message, age).
2. On pick, the server extracts a condensed transcript (user/assistant text +
   tool-call titles, recency-weighted, ~80k char budget) and injects it into the new
   session's first message with the same framing — including the transcript path
   escape hatch. The *target* agent effectively performs the distillation as it
   starts work, which avoids spawning a separate summarization run.
3. Optional later refinement: a one-shot distillation pass that writes a proper
   handoff file first (better for very long sessions).

### Flow 3 — manual export (Phase 3)

`/handoff` skill / button: generate the handoff document on demand without switching
anything, show it to the user, save to `<repo>/.codekin/handoffs/`. Useful for
pasting into tools Codekin doesn't manage, or for end-of-day state dumps.

## Server changes

- `server/handoff-manager.ts` — generate (one-shot `claude -p` distillation over the
  transcript extract), store, load, inject; fallback chain: distilled handoff →
  raw transcript extract → display-buffer summary.
- `server/transcript-readers.ts` — Claude + Codex readers (Phase 2: OpenCode,
  `listSessions(repoDir)` for the external-session picker); each reader exports
  transcript location by session id and `readCondensed(path, budget)`.
- `Session` gains `pendingHandoff?: { path: string; sourceHarness: CodingProvider }`
  (persisted, so a server restart between switch and first message doesn't lose it).

### Protocol additions (`types.ts`, both sides)

```ts
// client → server
| { type: 'set_provider'; provider: CodingProvider; carryContext?: boolean }
| { type: 'create_session'; …; handoff?: { transcriptPath: string } }
| { type: 'list_external_sessions'; workingDir: string }

// server → client
| { type: 'external_sessions'; sessions: ExternalSessionInfo[] }
| { type: 'handoff_status'; state: 'distilling' | 'ready' | 'failed'; detail?: string }
```

`transcriptPath` is server-validated against the known transcript roots (no arbitrary
file reads driven by the client).

## UI changes

- Provider switcher: "Carry context" checkbox + brief "Distilling context…" state.
- New-session modal: "Continue from another tool…" section (Phase 2).
- Transcript: system line marking the handoff, expandable to view the injected doc.

## Edge cases & risks

- **Secrets**: transcripts can contain tokens/keys echoed by tools. The handoff
  prompt instructs the agent to omit credentials; the raw-transcript escape hatch is
  a local file path, never file contents shipped over the wire to the UI.
- **Size**: frontier context windows are generous, so budgets are pragmatic rather
  than tight. Handoff docs have no hard cap — the distillation prompt asks for
  thoroughness without padding. Condensed transcript extracts feed the distiller up
  to ~80k chars (≈20k tokens), recency-weighted; direct injection of an extract
  (fallback / Flow 2) uses the same budget.
- **Dead/hung source process**: generation must time-box (~60s) and fall through the
  fallback chain rather than block the switch.
- **Worktrees**: transcript `cwd` may be a worktree path; match `cwd` against both
  the repo dir and its worktrees when listing external sessions.

## Phasing

1. **MVP**: Flow 1 — carry-context on provider switch, agent-authored handoff,
   honest injection framing, fallback chain. Replaces the restart-fiction summary.
2. **Phase 2**: external session import (Codex + Claude readers, picker UI).
3. **Phase 3**: manual `/handoff` export + handoff library in the repo.

## Open questions

- Should Flow 2 spawn a dedicated one-shot distillation run for very long external
  transcripts, and if so under which provider/model?
- Do we want handoffs committed to the repo (`.codekin/handoffs/`) by default for
  team visibility, or kept in `DATA_DIR` as personal artifacts? (MVP: `DATA_DIR`.)
