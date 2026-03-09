# Codex CLI Integration Plan for Codekin

> **Status**: Exploratory / Research Phase
> **Date**: March 2025
> **Audience**: Codekin contributors and maintainers

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Corrected Understanding: Codex Is Rust, Not Node.js](#corrected-understanding)
3. [Codex Internal Architecture](#codex-internal-architecture)
4. [Integration Approaches](#integration-approaches)
   - [Approach A: JSON-RPC via `app-server`](#approach-a-json-rpc-via-app-server)
   - [Approach B: `codex exec` Headless CLI (JSONL over stdio)](#approach-b-codex-exec-headless-cli)
   - [Approach C: MCP Server Mode](#approach-c-mcp-server-mode)
   - [Approach D: Fork + Custom Wire Protocol](#approach-d-fork--custom-wire-protocol)
5. [Comparison Matrix](#comparison-matrix)
6. [Recommended Path: Approach A (JSON-RPC)](#recommended-path)
7. [Protocol Mapping: Codex Events → Codekin WebSocket Messages](#protocol-mapping)
8. [Permission Model Bridging](#permission-model-bridging)
9. [Session Lifecycle](#session-lifecycle)
10. [Implementation Plan](#implementation-plan)
11. [Risks and Open Questions](#risks-and-open-questions)
12. [Appendix: Codex Crate Map](#appendix-codex-crate-map)

---

## Executive Summary

This document lays out a technical plan for integrating OpenAI's Codex CLI as an alternative backend agent in Codekin, alongside the existing Claude Code integration. The goal is to allow users to select "Codex" as their agent engine and get the same Codekin UI experience — streaming output, tool call visualization, approval prompts, multi-session support — backed by Codex's agent loop instead of Claude Code's.

**Critical correction from initial analysis**: Codex CLI is **not** a Node.js/TypeScript project. Despite the `@openai/codex` npm package, the actual implementation is a ~60-crate **Rust** workspace. The npm package is a thin shim that dispatches to the compiled Rust binary. This eliminates the "library import" approach discussed in the initial assessment and changes the integration calculus significantly.

The recommended approach is **JSON-RPC via Codex's `app-server`**, the same protocol used by the VS Code extension to communicate with Codex.

---

## Corrected Understanding

### What we originally assumed

| Factor | Assumed | Actual |
|--------|---------|--------|
| Language | Node.js/TypeScript | **Rust** (Cargo workspace, ~60 crates) |
| npm package | Full implementation | **Thin shim** — just `bin/codex.js` dispatching to native binary |
| Library import | Possible (same runtime) | **Not viable** — different language runtimes |
| IPC options | Could share process | **Must use IPC** — separate Rust process |

### What this means

- ~~Import as a library~~ — **eliminated**. Cannot import Rust crates into a Node.js process without an FFI bridge (napi-rs, etc.), which would be far more work than IPC.
- The integration is necessarily **process-to-process**, similar to how Codekin already talks to Claude Code.
- The good news: Codex already has a purpose-built JSON-RPC server (`codex-app-server`) designed for exactly this use case — driving Codex from an external application.

---

## Codex Internal Architecture

Understanding Codex's internals is important for knowing which integration seams to target.

### Core Separation: SQ/EQ Pattern

Codex's architecture cleanly separates the agent core from any UI. The `codex-core` crate communicates through a **Submission Queue / Event Queue** pattern:

```
┌──────────────┐     Submissions (Op)      ┌──────────────┐
│  UI / Client │  ─────────────────────►   │  codex-core   │
│  (TUI, exec, │  ◄─────────────────────   │  (agent loop) │
│   app-server)│     Events (EventMsg)     │               │
└──────────────┘                           └──────────────┘
```

```rust
// The core interface (simplified)
pub struct Codex {
    tx_sub: Sender<Submission>,           // send operations IN
    rx_event: Receiver<Event>,            // receive events OUT
    agent_status: watch::Receiver<AgentStatus>,
    session: Arc<Session>,
}
```

This means any consumer — the TUI, the headless CLI, the app-server, or a hypothetical Codekin bridge — interacts with the same core through the same SQ/EQ channel pair. The core itself has `#![deny(clippy::print_stdout)]` to enforce that it never writes directly to the terminal.

### Key Crates

| Crate | Purpose | Relevance to integration |
|-------|---------|--------------------------|
| `codex-core` | Agent loop, tool execution, LLM client | The engine we're driving |
| `codex-protocol` | Shared types: `Op`, `EventMsg`, policies | Defines the contract |
| `codex-exec` | Headless CLI mode (JSONL on stdout) | Approach B entry point |
| `codex-app-server` | JSON-RPC server (Unix socket / in-process) | **Approach A entry point** |
| `codex-app-server-protocol` | JSON-RPC schema definitions (v1 + v2) | The API spec |
| `codex-tui` | Ratatui terminal UI | Not relevant (we replace this) |
| `execpolicy` | Starlark-based command policy engine | Affects approval flow |
| `linux-sandbox` | landlock + seccomp sandboxing | Affects what tools can do |

### Event Types (~70+ variants)

The `EventMsg` enum in `codex-protocol` covers every observable event:

- **Streaming**: `AgentMessageDelta`, `AgentMessageComplete`
- **Tool execution**: `ExecCommandBegin`, `ExecCommandOutputDelta`, `ExecCommandEnd`
- **File operations**: `ApplyPatchApprovalRequest`, `ApplyPatchComplete`
- **Approvals**: `ExecApprovalRequest`, `ReviewDecision`
- **Session**: `TurnStart`, `TurnComplete`, `TaskComplete`
- **Context**: `ContextCompacted`, `ConversationCleared`
- **Sub-agents**: `DelegateStart`, `DelegateEvent`, `DelegateEnd`
- **Errors**: `AgentError`, `ExecCommandError`

This is a very rich event stream — more granular than Claude Code's `stream-json` output in some areas.

### Tool System

Codex's tool handlers implement a `ToolHandler` trait:

```rust
#[async_trait]
pub trait ToolHandler: Send + Sync {
    fn kind(&self) -> ToolKind;
    async fn is_mutating(&self, invocation: &ToolInvocation) -> bool;
    async fn handle(&self, invocation: ToolInvocation) -> Result<ToolOutput, FunctionCallError>;
}
```

Built-in tools:
- **Shell execution** (`ShellHandler`) — bash/zsh with sandboxing
- **File operations** — `apply_patch`, `read_file`, `list_dir`, `grep_files`
- **Search** — BM25-based semantic file search
- **Sub-agents** — can spawn child Codex instances
- **MCP tools** — dispatches to external MCP servers
- **JS REPL** — JavaScript evaluation
- **Planning** — structured planning tool

### LLM Client

- Speaks the **OpenAI Responses API** (not Chat Completions)
- Supports **SSE** and **WebSocket** wire protocols
- WebSocket supports "prewarm" connections for latency reduction
- Provider abstraction supports OpenAI, Ollama, LM Studio

---

## Integration Approaches

### Approach A: JSON-RPC via `app-server`

**This is the recommended approach.**

Codex ships a JSON-RPC server (`codex-app-server`) designed for IDE extensions and external applications to drive Codex programmatically. This is the same protocol the VS Code extension uses.

#### How it works

```
┌──────────┐  WebSocket  ┌──────────────────┐  JSON-RPC    ┌──────────────┐
│  Browser  │ ◄────────► │  Codekin Server   │ ◄──────────► │ codex        │
│  (React)  │            │  (Node.js)        │  (Unix sock) │ app-server   │
└──────────┘             │                   │              │ (Rust binary)│
                         │  CodexAdapter     │              └──────────────┘
                         │  ┌─────────────┐  │
                         │  │ JSON-RPC     │  │
                         │  │ client       │  │
                         │  └─────────────┘  │
                         └──────────────────┘
```

1. Codekin server spawns `codex app-server` as a child process
2. Communication happens over a **Unix domain socket** (or stdio)
3. Codekin sends JSON-RPC calls: `createThread`, `submitUserInput`, `approveExec`, etc.
4. Codex sends JSON-RPC notifications: streaming deltas, tool events, approval requests
5. `CodexAdapter` in Codekin translates these into Codekin's WebSocket message format

#### Advantages

- **First-party integration point** — This is the API Codex was designed to expose to external consumers
- **Versioned protocol** — `app-server-protocol` has v1 and v2 schemas
- **Rich event stream** — All ~70+ event types are available
- **Bidirectional** — Can send approvals, interrupts, config changes back to Codex
- **Maintained by OpenAI** — Updates to Codex will maintain this protocol for VS Code compat

#### Disadvantages

- **Protocol not yet stable** — May change across Codex versions
- **Limited public documentation** — Protocol is defined in Rust types, not a published spec
- **Unix socket management** — Need to manage socket lifecycle, reconnection

#### Technical requirements

- Parse the `codex-app-server-protocol` Rust types into TypeScript equivalents
- Implement a JSON-RPC client in Codekin's server (or use an existing library like `jayson`, `json-rpc-2.0`)
- Manage the `codex app-server` child process lifecycle
- Handle socket file cleanup on crashes

---

### Approach B: `codex exec` Headless CLI

Codex has a headless execution mode that reads from stdin and outputs JSONL to stdout.

#### How it works

```
┌──────────┐  WebSocket  ┌──────────────────┐  stdin/stdout  ┌──────────────┐
│  Browser  │ ◄────────► │  Codekin Server   │ ◄────────────► │ codex exec   │
│  (React)  │            │  CodexAdapter     │   (JSONL)      │ (Rust binary)│
└──────────┘             └──────────────────┘                └──────────────┘
```

1. Codekin spawns `codex exec --output-format jsonl` as a child process
2. User prompts are piped to stdin
3. JSONL events stream from stdout
4. `CodexAdapter` parses and maps to Codekin messages

#### Advantages

- **Simple to spawn** — Same pattern as current Claude Code integration
- **No socket management** — Uses stdio pipes
- **Familiar pattern** — Codekin already does this with `claude`

#### Disadvantages

- **Less interactive** — `exec` mode is designed for one-shot tasks, not persistent sessions
- **Limited bidirectionality** — Sending approvals, interrupts, and config changes mid-stream is less natural over stdio
- **JSONL format undocumented** — Output format may be less stable than the JSON-RPC protocol
- **Session continuity** — May need to restart the process per turn or manage long-running sessions carefully

#### When this makes sense

If we only want a "run Codex on this prompt" one-shot mode (not full interactive sessions), this is simpler than Approach A.

---

### Approach C: MCP Server Mode

Codex can run as an MCP (Model Context Protocol) server, exposing its capabilities as MCP tools.

#### How it works

```
┌──────────┐  WebSocket  ┌──────────────────┐  MCP protocol  ┌──────────────┐
│  Browser  │ ◄────────► │  Codekin Server   │ ◄────────────► │ codex        │
│  (React)  │            │  (MCP client)     │  (stdio/SSE)   │ mcp-server   │
└──────────┘             └──────────────────┘                └──────────────┘
```

#### Advantages

- **Standard protocol** — MCP is an emerging standard
- **Well-defined semantics** — Tool calls, results, streaming

#### Disadvantages

- **Wrong abstraction level** — MCP exposes Codex as a _tool_, not as an _agent_. We want the full agent experience (streaming thought, multi-turn conversation, tool visualization), not just "call Codex as a function."
- **Loses the agent loop** — We'd be wrapping an agent as a tool, which collapses the rich event stream into tool call/result pairs
- **Not suitable for the Codekin use case**

**Verdict**: Not recommended for Codekin integration. MCP mode is designed for Codex to be a tool inside another agent, not for driving Codex as the primary agent.

---

### Approach D: Fork + Custom Wire Protocol

Fork the Codex repo and add a custom output mode tailored for Codekin.

#### Advantages

- **Full control** — Can design the exact protocol Codekin needs
- **Could match Claude Code's `stream-json`** — Enabling a unified adapter layer

#### Disadvantages

- **Maintenance burden** — Must keep the fork updated with upstream Codex
- **Rust development** — Codekin team would need to maintain Rust code
- **Unnecessary** — `app-server` already provides what we need

**Verdict**: Not recommended unless Approach A proves insufficient.

---

## Comparison Matrix

| Factor | A: JSON-RPC | B: exec CLI | C: MCP | D: Fork |
|--------|:-----------:|:-----------:|:------:|:-------:|
| Event richness | ★★★★★ | ★★★☆☆ | ★★☆☆☆ | ★★★★★ |
| Bidirectionality | ★★★★★ | ★★☆☆☆ | ★★★☆☆ | ★★★★★ |
| Session persistence | ★★★★★ | ★★☆☆☆ | ★☆☆☆☆ | ★★★★★ |
| Implementation effort | ★★★☆☆ | ★★★★☆ | ★★★★★ | ★☆☆☆☆ |
| Maintenance burden | ★★★★☆ | ★★★★★ | ★★★★★ | ★☆☆☆☆ |
| Upstream compatibility | ★★★★☆ | ★★★☆☆ | ★★★★☆ | ★★☆☆☆ |
| Interactive approval | ★★★★★ | ★★☆☆☆ | ★☆☆☆☆ | ★★★★★ |
| Multi-turn conversation | ★★★★★ | ★★★☆☆ | ★☆☆☆☆ | ★★★★★ |

---

## Recommended Path

### Approach A: JSON-RPC via `app-server`

This is the clear winner:
- It's the **designed integration point** for external applications
- It provides the **full event stream** needed for Codekin's UI
- It supports **bidirectional communication** for approvals and interrupts
- It's **maintained by OpenAI** as part of their VS Code extension support
- It avoids the **maintenance burden** of a fork

---

## Protocol Mapping

### Codex EventMsg → Codekin WebSocket Messages

The core of the integration is mapping Codex's event types to Codekin's existing WebSocket message protocol.

| Codex EventMsg | Codekin Message Type | Notes |
|----------------|---------------------|-------|
| `AgentMessageDelta` | `output` (type: "text") | Streaming text chunks |
| `AgentMessageComplete` | `output` (type: "text", final) | End of response |
| `ExecCommandBegin` | `tool_active` | Tool execution started |
| `ExecCommandOutputDelta` | `tool_output` | Streaming tool output |
| `ExecCommandEnd` | `tool_done` | Tool execution complete |
| `ApplyPatchApprovalRequest` | `prompt` (type: "permission") | File edit approval |
| `ExecApprovalRequest` | `prompt` (type: "permission") | Command approval |
| `TurnComplete` | `output` (type: "turn_complete") | Turn finished |
| `AgentError` | `error` | Error in agent |
| `ContextCompacted` | (internal, no UI mapping) | Context window managed |
| `DelegateStart` | `tool_active` (sub-agent) | Sub-agent spawned |
| `DelegateEvent` | `output` / `tool_output` | Sub-agent events |
| `DelegateEnd` | `tool_done` | Sub-agent complete |
| `TaskComplete` | `output` (type: "task_complete") | Full task done |

### Codekin User Actions → Codex Ops

| Codekin Action | Codex Op | Notes |
|----------------|----------|-------|
| User sends message | `Op::UserInput` | Text prompt |
| User approves tool | `Op::ExecApproval { decision: Approved }` | Permission grant |
| User denies tool | `Op::ExecApproval { decision: Abort }` | Permission deny |
| User interrupts | `Op::Interrupt` | Cancel current operation |
| User switches session | Thread management via `ThreadManager` | Session routing |

### Message Adaptation Layer

```typescript
// server/adapters/codex-adapter.ts (conceptual)

interface CodexEvent {
  type: string;
  data: unknown;
}

class CodexAdapter implements AgentAdapter {
  private rpcClient: JsonRpcClient;
  private socketPath: string;

  async start(cwd: string, config: CodexConfig): Promise<void> {
    // Spawn codex app-server, connect to Unix socket
  }

  async sendMessage(text: string): Promise<void> {
    await this.rpcClient.call('submitUserInput', { text });
  }

  async approveToolUse(turnId: string, decision: 'approve' | 'deny'): Promise<void> {
    await this.rpcClient.call('approveExec', {
      turn_id: turnId,
      decision: decision === 'approve' ? 'Approved' : 'Abort',
    });
  }

  async interrupt(): Promise<void> {
    await this.rpcClient.call('interrupt', {});
  }

  onEvent(handler: (msg: CodekinMessage) => void): void {
    this.rpcClient.onNotification((event: CodexEvent) => {
      const mapped = this.mapEvent(event);
      if (mapped) handler(mapped);
    });
  }

  private mapEvent(event: CodexEvent): CodekinMessage | null {
    switch (event.type) {
      case 'AgentMessageDelta':
        return { type: 'output', subtype: 'text', content: event.data.delta };
      case 'ExecCommandBegin':
        return { type: 'tool_active', tool: event.data.command, id: event.data.call_id };
      case 'ExecApprovalRequest':
        return { type: 'prompt', promptType: 'permission', details: event.data };
      // ... etc
    }
  }
}
```

---

## Permission Model Bridging

Codex and Claude Code have different but analogous permission models. The bridge needs to handle these differences.

### Codex's Multi-Layer Permission System

```
┌─────────────────────────────────────────┐
│  AskForApproval Policy                  │  ← When to ask the user
│  (UnlessTrusted / OnRequest / Never)    │
├─────────────────────────────────────────┤
│  SandboxPolicy                          │  ← OS-level enforcement
│  (ReadOnly / WorkspaceWrite / FullAccess)│
├─────────────────────────────────────────┤
│  ExecutionPolicy (Starlark rules)       │  ← Per-command rules
│  (allow/deny based on command prefix)   │
├─────────────────────────────────────────┤
│  FileSystemSandboxPolicy                │  ← Per-path access control
│  (Read/Write/None per directory)        │
└─────────────────────────────────────────┘
```

### Mapping to Codekin's UI

Codekin currently surfaces Claude Code's permission requests as `prompt` messages with "approve/deny" buttons. For Codex:

| Codex Approval Request | Codekin UI Treatment |
|------------------------|---------------------|
| `ExecApprovalRequest` (shell command) | Show command, approve/deny buttons |
| `ApplyPatchApprovalRequest` (file edit) | Show diff, approve/deny buttons |
| `PrefixRuleAmendment` (auto-approve rule) | "Always allow `npm test`?" checkbox |
| `NetworkPolicyAmendment` | "Allow network access to X?" |

### Configuration

Codex's sandbox policy should be configurable per-session in Codekin's UI:

```typescript
interface CodexSessionConfig {
  sandboxPolicy: 'read-only' | 'workspace-write' | 'full-access';
  approvalPolicy: 'ask-always' | 'ask-unless-trusted' | 'auto-approve';
  model: string;  // e.g., 'o3', 'gpt-4.1'
  writableRoots?: string[];  // directories Codex can write to
}
```

---

## Session Lifecycle

### Startup Sequence

```
1. User creates new session with agent="codex"
2. Codekin SessionManager creates CodexAdapter
3. CodexAdapter spawns: codex app-server --socket /tmp/codekin-codex-{sessionId}.sock
4. CodexAdapter connects JSON-RPC client to the socket
5. CodexAdapter calls: rpc.createThread({ cwd, config })
6. Session is ready — user can send messages
```

### Message Flow (Single Turn)

```
User types "refactor the auth module"
  │
  ▼
Codekin WS server receives message
  │
  ▼
SessionManager routes to CodexAdapter
  │
  ▼
CodexAdapter: rpc.call('submitUserInput', { text: "refactor the auth module" })
  │
  ▼
Codex core processes, emits events via JSON-RPC notifications:
  │
  ├── AgentMessageDelta("Let me look at the auth module...")  → WS: output
  ├── ExecCommandBegin({ command: "find src -name 'auth*'" }) → WS: tool_active
  ├── ExecCommandOutputDelta("src/auth/index.ts\n...")        → WS: tool_output
  ├── ExecCommandEnd({ exit_code: 0 })                       → WS: tool_done
  ├── AgentMessageDelta("I'll update the following files...")  → WS: output
  ├── ApplyPatchApprovalRequest({ path: "src/auth/...", diff }) → WS: prompt
  │     │
  │     ▼  User clicks "Approve" in Codekin UI
  │     │
  │     CodexAdapter: rpc.call('approveExec', { decision: 'Approved' })
  │
  ├── ApplyPatchComplete({ path: "src/auth/...", success: true }) → WS: tool_done
  ├── AgentMessageComplete("Done! Here's what I changed...")  → WS: output
  └── TurnComplete                                            → WS: turn_complete
```

### Session Persistence

Codex has its own session persistence (`~/.codex/sessions/` in JSONL format). Codekin should:

1. Let Codex manage its own persistence (don't duplicate)
2. Map Codex's `thread_id` to Codekin's `sessionId`
3. On session resume, call `rpc.resumeThread({ thread_id })` to restore conversation state

### Cleanup

```
Session end:
  1. CodexAdapter: rpc.call('shutdown')
  2. Wait for codex app-server process to exit (timeout 5s)
  3. Kill process if still running
  4. Clean up socket file: /tmp/codekin-codex-{sessionId}.sock
  5. Release session resources
```

---

## Implementation Plan

### Phase 0: Research & Spike (1 week)

**Goal**: Validate that `codex app-server` works as expected and document the actual JSON-RPC protocol.

- [ ] Install Codex CLI locally
- [ ] Run `codex app-server` and inspect the Unix socket protocol
- [ ] Capture JSON-RPC message traces for: thread creation, user input, streaming, tool execution, approval flow
- [ ] Document the actual JSON-RPC method names, parameters, and notification shapes
- [ ] Identify any gaps between the protocol and what Codekin needs
- [ ] Write a minimal Node.js script that drives Codex via JSON-RPC end-to-end

**Deliverable**: Protocol documentation file and proof-of-concept script.

### Phase 1: Agent Adapter Abstraction (1 week)

**Goal**: Refactor Codekin's server to support pluggable agent backends.

- [ ] Define an `AgentAdapter` interface in Codekin's server:
  ```typescript
  interface AgentAdapter {
    start(cwd: string, env: Record<string, string>): Promise<void>;
    sendMessage(text: string, options?: SendOptions): Promise<void>;
    respondToPrompt(promptId: string, response: string): Promise<void>;
    interrupt(): Promise<void>;
    stop(): Promise<void>;
    onMessage(handler: (msg: CodekinMessage) => void): void;
  }
  ```
- [ ] Refactor existing Claude Code integration into a `ClaudeAdapter` implementing this interface
- [ ] Update `SessionManager` to instantiate the correct adapter based on session config
- [ ] Ensure no regressions in existing Claude Code functionality

**Deliverable**: Abstracted adapter layer, existing functionality preserved.

### Phase 2: Codex Adapter Core (2 weeks)

**Goal**: Implement the `CodexAdapter` that drives Codex via JSON-RPC.

- [ ] Implement JSON-RPC client (Unix domain socket transport)
- [ ] Implement `CodexAdapter` class:
  - Process spawning and lifecycle management
  - Socket connection and reconnection
  - Thread creation and management
  - User input submission
  - Event stream subscription and parsing
- [ ] Implement event mapping layer (Codex `EventMsg` → Codekin `CodekinMessage`)
- [ ] Handle all critical event types:
  - Streaming text output
  - Tool execution (begin, output, end)
  - Approval requests and responses
  - Errors and interrupts
  - Turn completion
- [ ] Unit tests for event mapping
- [ ] Integration tests with actual Codex process

**Deliverable**: Working `CodexAdapter` that can drive a basic Codex conversation.

### Phase 3: Permission & Approval Flow (1 week)

**Goal**: Full approval flow working through Codekin's UI.

- [ ] Map Codex approval request types to Codekin's prompt UI
- [ ] Implement approval response routing (UI → adapter → Codex)
- [ ] Handle "approve for session" and prefix-rule amendments
- [ ] Surface sandbox policy configuration in session settings
- [ ] Test approval flow for: shell commands, file edits, network access

**Deliverable**: Interactive approval flow working end-to-end.

### Phase 4: Frontend Integration (1 week)

**Goal**: UI support for selecting and using Codex as the agent backend.

- [ ] Add agent selection to session creation UI (Claude Code / Codex)
- [ ] Display Codex-specific tool calls appropriately (may differ from Claude's tool names)
- [ ] Handle Codex-specific approval UI (prefix rules, sandbox amendments)
- [ ] Show agent indicator in session header
- [ ] Handle Codex sub-agent events (delegate start/end)

**Deliverable**: Complete UI for Codex sessions.

### Phase 5: Polish & Edge Cases (1 week)

**Goal**: Production readiness.

- [ ] Graceful handling of Codex process crashes
- [ ] Session resume after server restart
- [ ] Codex binary detection and version checking
- [ ] Error messages when Codex is not installed
- [ ] Context compaction event handling
- [ ] Performance testing with long conversations
- [ ] Documentation for users on setting up Codex

**Deliverable**: Production-ready Codex integration.

### Total Estimated Timeline: 6-7 weeks

---

## Risks and Open Questions

### High Risk

1. **Protocol stability**: The `app-server` JSON-RPC protocol is not publicly documented or versioned for external consumers. It may change without notice between Codex releases. **Mitigation**: Pin to a specific Codex version; contribute upstream to stabilize the protocol.

2. **Protocol gaps**: The JSON-RPC protocol may not expose everything we need (e.g., conversation history for display on session resume). **Mitigation**: Phase 0 spike will identify gaps early. Fall back to `codex exec` for specific operations if needed.

3. **Authentication**: Codex requires an OpenAI API key. Codekin needs a secure way to configure and pass this per-user. **Mitigation**: Environment variable injection at process spawn, or Codex's own auth management (`CodexAuth`/`AuthManager`).

### Medium Risk

4. **Sub-agent events**: Codex can spawn sub-agents (`DelegateStart/Event/End`). Codekin's UI may not have a good representation for nested agent execution. **Mitigation**: Initially flatten sub-agent events into the parent stream; add nested visualization later.

5. **Sandbox enforcement**: Codex uses OS-level sandboxing (landlock on Linux, seatbelt on macOS). This may conflict with Codekin's own execution environment. **Mitigation**: Test sandbox policies in Codekin's deployment environment; provide override configuration.

6. **Model compatibility**: Codex is tightly coupled to OpenAI models (o3, gpt-4.1, etc.). Users need an OpenAI API key and compatible model access. **Mitigation**: Clear documentation; potentially support Codex's Ollama/LM Studio backends for local models.

### Open Questions

- **Q1**: Does `codex app-server` support multiple threads on a single server instance, or do we need one process per session?
- **Q2**: What is the exact JSON-RPC method surface? (Answered by Phase 0 spike)
- **Q3**: Can we configure Codex's model provider at runtime, or only at startup?
- **Q4**: How does Codex handle conversation context limits? Does it auto-compact, or do we need to manage this?
- **Q5**: Is there a way to get conversation history from a resumed thread for display in the UI?

---

## Appendix: Codex Crate Map

For reference, the full crate structure of the `codex-rs/` workspace:

```
codex-rs/
├── cli/                  # Main CLI entry point (dispatches to tui/exec/mcp)
├── core/                 # Agent loop, tool execution, LLM client
│   └── src/
│       ├── tools/
│       │   └── handlers/ # Shell, file ops, search, sub-agents, MCP
│       ├── client.rs     # LLM API client (SSE + WebSocket)
│       ├── codex.rs      # Core Codex struct (SQ/EQ pattern)
│       ├── context_manager/ # Conversation context tracking
│       └── compact.rs    # Context window compaction
├── protocol/             # Shared types: Op, EventMsg, policies
├── exec/                 # Headless CLI mode (JSONL output)
├── tui/                  # Ratatui terminal UI
├── app-server/           # JSON-RPC server for IDE extensions
├── app-server-protocol/  # JSON-RPC schema (v1 + v2)
├── app-server-client/    # In-process JSON-RPC client
├── execpolicy/           # Starlark-based execution policy
├── shell-command/        # Command parsing and safety classification
├── config/               # Configuration types and loading
├── hooks/                # Lifecycle hooks (before/after tool use)
├── skills/               # Slash-command skill support
├── mcp-server/           # Codex as MCP server
├── linux-sandbox/        # landlock + seccomp sandboxing
└── ...                   # ~45+ additional utility crates
```

---

*This document will be updated as Phase 0 research reveals more details about the actual JSON-RPC protocol.*
