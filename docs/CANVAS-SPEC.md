# Session Canvas

**Status:** Specified. Slice 1 (item model and store) in progress.

## 1. Summary

Canvas is a panel beside a session's chat. It shows rich output that deserves more room than a transcript message: documents, tables, diagrams and images first, then charts, interactive tool interfaces (MCP Apps) and a live preview of the app being edited.

Each output is a named, durable **item** with revisions. The user reads it beside the chat, selects something specific (a paragraph, table rows, a diagram node) and sends that back to the agent as context.

Three ways in:

1. **The agent publishes** an item through a `canvas_show` / `canvas_update` tool on a Codekin MCP server added to every session (slice 3).
2. **The user opens a file** in Canvas from Changes, Docs or a file link in chat.
3. **An MCP tool returns a UI**, which the provider adapter detects (slice 5).

## 2. Item model

An item belongs to one session and has an ordered list of revisions.

| Field | Meaning |
|---|---|
| `id` | Random id, unique within the session |
| `sessionId` | Owning session |
| `kind` | `markdown`, `table`, `diagram` or `image` (later `chart`, `html`, `mcp_app`, `preview`) |
| `title` | Shown in the switcher and chat card |
| `source` | Who made it: `{ type: 'agent' }`, `{ type: 'file', path }` (opened by the user) or `{ type: 'mcp', server }` |
| `revisions` | `{ n, createdAt, size, mediaType }`, numbered from 1 |
| `latest` | Highest revision number |
| `pinnedRevision` | Set when the user pins; new revisions then wait instead of replacing the view |
| `createdAt` / `updatedAt` | ISO timestamps |

**Content per kind**

- `markdown`: UTF-8 Markdown, rendered by the existing `marked` + DOMPurify pipeline.
- `table`: CSV, TSV or a JSON array of objects.
- `diagram`: Mermaid source, plus optional node metadata `{ [nodeId]: { file?, line?, description? } }`. Mermaid renders with `securityLevel: 'strict'`, which disables its own click handlers. Codekin attaches its own handlers to the rendered node elements and looks each node up in the metadata.
- `image`: PNG, JPEG, GIF, WebP or SVG bytes. SVG is only ever rendered through `<img>`, so scripts in it never run.

**Limits:** 100 items per session, 50 revisions per item (the oldest unpinned revisions are dropped first), 1 MiB per text revision and 2 MiB per image revision. A dropped revision that an attachment still refers to shows "This revision is no longer available".

**Storage:** `DATA_DIR/canvas/<sessionId>/` (default `~/.codekin/canvas`), never in the repository. Each item has a metadata file and one content file per revision.

- Items are kept while a session is archived.
- They are deleted when the session is deleted. The transcript archive keeps the chat cards, but not the items.

## 3. Protocol

Canvas uses the session WebSocket, like review comments, so it follows the session's existing access rules everywhere, including shared sessions over a relay.

**Client → server**

| Message | Effect |
|---|---|
| `canvas_list` | Reply with `canvas_items` |
| `canvas_get { itemId, revision? }` | Reply with `canvas_item` (latest revision when omitted) |
| `canvas_open_file { path, root? }` | Create an item from a file in the session's working directory or an attached folder. Re-opening the same file adds a revision when its content changed |
| `canvas_pin { itemId, revision \| null }` | Pin at a revision, or unpin |
| `canvas_delete { itemId }` | Delete the item and its revisions |

**Server → client**

| Message | When |
|---|---|
| `canvas_items { sessionId, items }` | Reply to `canvas_list`, and broadcast to the session after any change |
| `canvas_item { sessionId, item, revision, content, encoding }` | Reply to `canvas_get`. `encoding` is `utf8` or `base64` |
| `canvas_event { sessionId, itemId, kind, title, revision, action }` | Added to the transcript when an item is `created` or `updated`; renders as the chat card |
| `canvas_error { sessionId?, message }` | A failed request |

The session list carries `canvas: { items, pinnedBehind }` per session, so the sidebar can show a count and a dot when a pinned item has a newer revision.

**Shared sessions (relay):**

- `canvas_list`, `canvas_get` and the server frames need `view`.
- `canvas_item` frames for items opened from repository files also need `view_diff`, because their content is code, as with diffs.
- `canvas_open_file` needs `view_diff` and `send_prompt`.
- Pin and delete are owner-only.

## 4. Layout: canvas-forward

When Canvas opens, the work area takes most of the window.

| Region | Canvas closed | Canvas open |
|---|---|---|
| Left sidebar | As today | Collapsed to a 56 px rail. Expanding it shows the sidebar as an overlay |
| Chat | Full width | 440 px by default, resizable from 360 to 560 px, remembered in server prefs |
| Canvas | Hidden | The rest of the window |
| Changes | Session-header button | A 40 px strip on the right edge with a file count. Clicking it slides `DiffPanel` over Canvas |

- At 1100 px and below, Canvas replaces the chat instead of sitting beside it. A bottom bar shows the agent's last line and a one-line composer.
- On phones, Canvas is a full-screen view with "‹ Chat" to go back.
- Only one of Canvas and Changes is in front at a time. Canvas stays mounted under Changes, so its scroll, selection and open item survive the switch.
- Each session remembers whether Canvas is open and which item it shows.
- Opening and closing is one 240 ms ease-out transition, and no animation under `prefers-reduced-motion`.

**Auto-open:** the first agent-published item in a session opens Canvas; later items and revisions only post a chat card. This is a setting with three values: first item (default), every item, never. Canvas never auto-opens on phones, while the composer has text, or for a revision.

**Agent updates:** a new revision replaces the view only when the user is idle at the top of the item. Otherwise, or when the item is pinned, a one-line revision bar offers "Show rev N" and "Compare".

## 5. Selection → context

Selecting text, table rows, a diagram node, an image region, or later a chart range or preview element shows a floating toolbar:

- **Ask about this** attaches the selection and focuses the composer.
- **Add to prompt** attaches the selection without moving focus.

Each attachment records `{ itemId, revision, anchor }`. In the message sent to the agent, each attachment is a fenced block labelled with the item title, revision and source. In the transcript, attachments show as chips above the user's message; clicking a chip reopens the item at that revision with the selection highlighted.

## 6. Composer

The in-session composer is redesigned for the 440 px chat column. It must stay compatible with the start-view composer (#894), which keeps its five-line draft and its agent menu with a segmented agent row and the model list front and centre.

- **Toolbar:** `+`, the session chip, and Send.
  - The `+` menu holds Attach files, Add from Canvas, Skills (`/`) and Ask Joe (`@joe`).
- **Session chip:** shows the permission icon, model and effort. It opens the same menu structure as the start view, adapted for a running session:
  - the model list front and centre;
  - the Effort row with its cycle hint;
  - permission modes (`⇧Tab` still cycles them);
  - "Hand off to another agent" in place of the segmented agent row, since the agent of a running session changes only by handoff.
- **Typed triggers:** `/` opens skills as today. Typing `@joe` addresses Joe and shows a "To Joe" recipient chip and "Send to Joe".
- **Worktree:** the branch moves from the composer to the session header.
- **Attachments:** one chip style for files and Canvas context. More than two fold into a summary chip that expands into a list.
- **Dangerous permission modes** stay visible on the chip at every width.

The start view keeps its own agent menu, and gains only the `+` menu and the attachment chips.

## 7. Keyboard

| Keys (macOS / other) | Action |
|---|---|
| `⌘\` / `Ctrl+\` | Toggle Canvas; focus moves into it on open and back to the composer on close |
| `⌥⌘[` and `⌥⌘]` / `Ctrl+Alt+[` and `Ctrl+Alt+]` | Previous / next item |
| `⌘⇧D` / `Ctrl+Shift+D` | Changes (unchanged) |
| `⌘K` / `Ctrl+K` | Command palette (unchanged) |

- **Why not `⌘⇧[` / `⌘⇧]`:** browsers use them to switch tabs, and pages cannot reliably take them over.
- **Avoiding AltGr clashes:** item switching matches on `KeyboardEvent.code` (`BracketLeft` / `BracketRight`) and is ignored while focus is in a text field. On layouts where AltGr (reported as Ctrl+Alt) types brackets, typing them never switches items.

## 8. Security

- **Native items** render in Codekin's own document through existing sanitizers. Markdown goes through DOMPurify. Mermaid uses strict mode. Images render only through `<img>`, and remote images in Markdown become links as they do in chat.
- **Anything that runs code** (charts, HTML artifacts, MCP Apps, previews) renders only in a sandbox on a **separate origin**, never Codekin's own. Codekin's origin holds the session credentials, so script running there could drive the session API. The sandbox origin, its CSP and its deployment options for local, desktop and self-hosted setups are specified with slice 4.
- **Codekin controls stay outside the sandbox frame.** Every request a sandboxed app makes on the user's behalf goes through a confirmation in Codekin's chrome. That covers sending a message, opening a link and calling a tool, and tool calls also go through the normal approval rules.

## 9. Slices

| # | Slice | Contents |
|---|---|---|
| 1 | Item model + store | Server store, WebSocket protocol, relay policy, session-list summary. No UI |
| 2 | Layout shell | Rail, chat column, Canvas panel, Changes strip and slide-over, breakpoints, phone, "Open in Canvas" |
| 3 | Items and publishing | Markdown, image, table and diagram items; switcher, revisions, pinning, states; `canvas_show` / `canvas_update` for Claude, Codex and Grok; chat cards and auto-open |
| 4 | Selection → context | Selection toolbar, attachments, composer redesign (section 6) |
| 5 | Sandbox origin | Separate origin and CSP, then sandboxed charts and HTML artifacts |
| 6 | MCP Apps (display) | Adapter enrichment for Claude and Codex, `AppBridge` host |
| 7 | Live preview | Local first, then self-hosted remote |

Interactive MCP Apps (app-initiated tool calls) and relay-tunnelled previews are out of scope until there is a supported path and evidence they're needed.
