# Session Canvas

**Status:** Slices 1–7 implemented: item model and store (#896), layout shell (#897), agent publishing (#898), renderers (#899), revisions (#900), selection → context (#901), the composer (#902), OpenCode tools (#903), the sandbox origin with charts and HTML items (#904), MCP Apps display (#905), live preview of local dev servers (#906), tool calls from MCP Apps, and preview snapshots.

## 1. Summary

Canvas is a panel beside a session's chat. It shows rich output that deserves more room than a transcript message: documents, tables, diagrams and images first, then charts, interactive tool interfaces (MCP Apps) and a live preview of the app being edited.

Each output is a named, durable **item** with revisions. The user reads it beside the chat, selects something specific (a paragraph, table rows, a diagram node) and sends that back to the agent as context.

Three ways in:

1. **The agent publishes** an item through a `canvas_show` / `canvas_update` tool on a Codekin MCP server added to every session (slice 3).
2. **The user opens a file** in Canvas from Changes, Docs or a file link in chat.
3. **An MCP tool returns a UI**, which the provider adapter detects (slice 6).
4. **A dev server runs on this machine.** The agent starts it and calls `canvas_preview`, or the user starts one from `.claude/launch.json`. Canvas shows the app live (slice 7, see "Live preview" in section 8).

## 2. Item model

An item belongs to one session and has an ordered list of revisions.

| Field | Meaning |
|---|---|
| `id` | Random id, unique within the session |
| `sessionId` | Owning session |
| `kind` | `markdown`, `table`, `diagram`, `image`, `chart` (Vega-Lite), `html`, `mcp_app` (from a tool call) or `preview` (a dev server) |
| `title` | Shown in the switcher and chat card |
| `source` | Who made it: `{ type: 'agent' }`, `{ type: 'file', path }` (opened by the user), `{ type: 'mcp', server }` or `{ type: 'launch', config }` (a preview the user started) |
| `revisions` | `{ n, createdAt, size, mediaType }`, numbered from 1 |
| `latest` | Highest revision number |
| `pinnedRevision` | Set when the user pins; new revisions then wait instead of replacing the view |
| `createdAt` / `updatedAt` | ISO timestamps |

**Content per kind**

- `markdown`: UTF-8 Markdown, rendered by the existing `marked` + DOMPurify pipeline.
- `table`: CSV, TSV or a JSON array of objects. Shown up to 200 columns, 250,000 rows and 500,000 cells (rows × columns); a larger table is cut to fit, with a notice saying how much is hidden.
- `diagram`: Mermaid source, plus optional node metadata `{ [nodeId]: { file?, line?, description? } }`. Mermaid renders with `securityLevel: 'strict'`, which disables its own click handlers. Codekin attaches its own handlers to the rendered node elements and looks each node up in the metadata. Mermaid is loaded only when a diagram is first shown. Under a strict `style-src 'self'`, its `<style>` element and `style` attributes are moved into a constructed stylesheet and CSSOM, which CSP doesn't restrict.
- `image`: PNG, JPEG, GIF, WebP or SVG bytes. SVG is only ever rendered through `<img>`, so scripts in it never run.
- `preview`: `{ port, path, config? }`, the local server it shows. A new revision means it points somewhere else (another path or port). The page itself is never stored.

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

**Live preview** (section 8):

| Message | Effect |
|---|---|
| `preview_configs` → `preview_configs { file, configs, error? }` | The session folder's launch configurations, each with its command, port, `cwd` and the names (not values) of its `env` |
| `preview_open { itemId }` | Give the item a proxy and report its state |
| `preview_launch { name }` | Start a launch configuration and show its preview item (created on first start) |
| `preview_stop` / `preview_restart { itemId }` | Stop or restart a server Codekin started |
| `preview_logs { itemId }` → `preview_log { lines, reset }` | The server output Codekin kept. New lines are broadcast as they come |
| `preview_state { sessionId, preview }` | Broadcast on every change: `status` (`starting`, `running`, `stopped`, `crashed`), `targetPort`, `proxyPort` and `entry` (the proxy URL that admits the frame), `managed`, `config`, `command`, `exitCode`, `error`, `notice`, and `snapshots` (this machine has a browser for snapshots) |
| `preview_snapshot { itemId, path?, viewport?, fullPage? }` → `preview_snapshot_result { itemId, snapshotItemId? \| error? }` | Take a snapshot of the page at `path` (default: the item's) at `viewport` (`full`, `tablet` or `phone`); `fullPage: true` captures the page's whole height. The reply goes to the asking client only |

**Agent publishing.**

- Every Claude, Codex and Grok session gets a stdio MCP server, `codekin_canvas` (`server/canvas-mcp-server.ts`), with four tools: `canvas_show`, `canvas_update`, `canvas_list` and `canvas_preview`.
- `canvas_preview { port, path?, title? }` shows a dev server the agent started itself (`POST /api/sessions/:id/canvas/preview`). It is refused while nothing listens on the port, and for Codekin's own ports. Calling it again for the same port revises that item.
- The server calls `POST/GET /api/sessions/:id/canvas/items[/:itemId]` with the session-scoped token the agent's process already carries. That token reaches only its own session.
- These routes are local only; the relay never proxies them.
- Content is inline text, or a file in the session's folder, an attached folder or the screenshots folder. Images always come from a file.
- How each harness gets the server:
  - **Claude:** `--mcp-config`, with the tools pre-approved through `--allowedTools`.
  - **Codex:** `-c mcp_servers.codekin_canvas.*` overrides, which forward the session env by name and set `default_tools_approval_mode="approve"`.
  - **Grok:** ACP `session/new` `mcpServers`. Its `use_tool` permission requests for these tools are allowed without a prompt.
- The tools need no approval because they write only to the session's own Canvas.
- **OpenCode** runs one shared `opencode serve` for every session, so it can't get a per-session MCP server. Instead, Codekin writes custom tools to `DATA_DIR/opencode/tool/canvas.ts` and starts that server with `OPENCODE_CONFIG_DIR` pointing there. The tools are `canvas_show`, `canvas_update`, `canvas_preview` and `canvas_list`.
  - OpenCode passes each call the calling session's id. The tools send it to `/api/opencode-canvas/:openCodeSession/items`, which maps it to the Codekin session. That route accepts only a token derived for this purpose and set in the OpenCode server's environment.
  - If you set `OPENCODE_CONFIG_DIR` yourself, Codekin leaves it alone, and OpenCode sessions run without Canvas.

The session list carries `canvas: { items, pinnedBehind }` per session, so the sidebar can show a count and a dot when a pinned item has a newer revision.

**Shared sessions (relay):**

- `canvas_list`, `canvas_get` and the server frames need `view`.
- `canvas_item` frames for items opened from repository files also need `view_diff`, because their content is code, as with diffs.
- `canvas_open_file` needs `view_diff` and `send_prompt`.
- Pin and delete are owner-only.
- Tool calls from MCP Apps (`mcp_app_call`) are owner-only: they run tools on the owner's machine.
- Previews are owner-only, both the `preview_*` requests and the `preview_*` frames. Their state carries the proxy's key, and server output can carry anything the dev server prints.
- Snapshot items are owner-only too. A grantee sees them in the list, but not their image or console record (`canvas_item` with source `snapshot`).

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

Each attachment records the item, its revision, what was selected (`text`, `rows` or `node`) and an excerpt.

- **In the message to the agent,** each attachment is a `<canvas_context item="…" item_id="…" revision="N" what="…" label="…">` block after the user's text. Table rows are sent as a Markdown table, and a diagram node as its label, file and description.
- **In the transcript,** the blocks show as chips under the user's message, and clicking a chip reopens the item at that revision. Highlighting the original selection is not built yet.
- **In the composer,** more than two attachments fold into one summary chip that expands into a list.
- **Image region selection** is not built yet.

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
- **Worktree:** the branch moves from the composer to the bar above the chat (where the session works). That bar also offers "No worktree" (move into one). Sessions without that bar, such as webhook sessions and Joe-driven ones, keep the worktree in the composer.
- **Permission menu:** permissions are a row in the session chip's menu that opens a pane, like Effort, so the model list keeps most of the menu.
- **"Add from Canvas":** opens Canvas so you can select what to ask about. Whole items are not attached.
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
- **Anything that runs code** (charts, HTML artifacts, MCP Apps, previews) renders only in a sandbox on a **separate origin**, never Codekin's own. Codekin's origin holds the session credentials, so script running there could drive the session API.

### The sandbox origin

The sandbox is a static page (`src/sandbox`, built into `dist/sandbox`). It holds nothing and does nothing until Codekin posts content to it. Codekin frames it, and the two talk by `postMessage` (`src/lib/sandboxProtocol.ts`). Each side accepts messages only from the other's window and origin, and treats them as untrusted data.

- **`chart`** items are Vega-Lite specs. They render with Vega's expression interpreter (no `eval`), with no actions menu, and with their data inline, because the page has no network. Selection parameters (brush or point) are sent back as a label plus the selected data rows, and can be attached to a message like any other selection.
- **`html`** items are self-contained pages. They render in a nested `sandbox="allow-scripts"` frame, which gives them an opaque origin, under a CSP that allows inline scripts and styles but no network.
- **The page's headers** (`sandboxHeaders()` in `server/canvas-sandbox.ts`, and `nginx/snippets/codekin-sandbox-headers.conf.example`):
  - `connect-src 'none'`;
  - inline scripts allowed, because an HTML item's frame inherits the policy;
  - `frame-ancestors` set to Codekin's origin or origins.

Where the page lives:

| Setup | Sandbox origin | Configuration |
|---|---|---|
| Local, desktop, or a server reached directly | Codekin serves the page on a second port (default: Codekin's port + 1) | `CANVAS_SANDBOX_PORT` (a number, or `off`) |
| Behind a reverse proxy on your own domain | A second hostname that serves `dist/sandbox`, ideally on a different registrable domain from Codekin's | `CANVAS_SANDBOX_ORIGIN=https://sandbox.example.net`, plus `nginx/sandbox.example` |
| Hosted web app built with `build:hosted` | The same, baked into the build | `VITE_CANVAS_SANDBOX_ORIGIN=https://sandbox.example.net` |

- **Codekin's own CSP** gets `frame-src` set to the sandbox origin and the preview ports only. With a port, that's that port on any host, because the browser may reach Codekin by any name.
- **`CANVAS_SANDBOX_FRAME_ANCESTORS`** narrows which pages may frame the sandbox. The default is any, because the page holds nothing and does nothing on its own.
- **Without a sandbox,** chart and HTML items show their source with a note explaining why.

### MCP Apps

A tool whose definition declares a UI resource (`_meta.ui.resourceUri`, the MCP Apps extension) is shown as an interactive view. Codekin never talks to MCP servers itself; the CLIs own those connections.

- **Claude Code**, when its `init` capabilities include `mcp_tool_ui_meta_v1` and `mcp_read_resource_v1`:
  - the adapter remembers each `mcp__<server>__<tool>` call;
  - on its result, it takes `structuredContent` and `_meta` from the top-level `tool_use_result`;
  - it looks the tool up in a cached `mcp_status`, and reads the resource with `mcp_read_resource`.
- **Codex app-server:** a completed `mcpToolCall` with `mcpAppUi.resourceUri` (or `mcpAppResourceUri`) is read with `mcpServer/resource/read`, bound to the originating call.
- **What gets shown:**
  - each call becomes one `mcp_app` item (source: the MCP server) holding the tool input, result and app document;
  - reopening it restores the view without running the tool again;
  - calls that failed without data (for example, a denied permission) aren't shown, and neither are Codekin's own servers;
  - agents can't publish this kind themselves.
- **Rendering:**
  - The sandbox page runs in proxy mode (`?mcp-app`). It announces `ui/notifications/sandbox-proxy-ready`, loads the document into an inner `allow-scripts allow-forms` frame with no network, and relays JSON-RPC both ways.
  - Codekin hosts it with ext-apps' `AppBridge`, loaded lazily, and sends the stored tool input and result.
- **What the app can ask for:**
  - **open a link** or **send a message as you:** shown in Codekin's own UI and confirmed first;
  - **call a tool** on its own server: see "Tool calls from apps" below;
  - **update model context, display mode:** accepted, inline only.
- **Network:** apps get none, whatever their resource's `_meta.ui.csp` declares. Apps must be self-contained, the single-file pattern ext-apps recommends.
- **Tool calls from apps.** Codekin advertises `serverTools` to the app and runs its `tools/call` requests through the session's agent CLI, without a model turn. The result goes back to the app and stays out of the agent's context.
  - **Which tools.** Only tools on the server the app's item came from. The server is never one the app names. Tools whose `_meta.ui.visibility` leaves out `"app"` are refused, as are unknown tools and Codekin's own servers.
  - **Claude Code** runs the call with the `mcp_call` control request. When the CLI advertises `mcp_call_check_permissions_v1`, the call goes through `check_permissions`, so it is decided as the agent's own call to that tool would be: permission rules and mode, managed settings and hooks. A refusal comes back to the app, and Canvas explains it: allow `mcp__<server>__<tool>`, or change the permission mode. With `mcp_call_result_not_for_model_v1` the result is the server's own, unshaped for a model. A CLI that can't check permissions runs a call only after the user confirmed it in Canvas. Before the first turn, which is when there is no `system/init` yet, the capabilities come from the `initialize` response.
  - **Codex** runs it with `mcpServer/tool/call`. The app-server doesn't say whether it applies approvals to these calls, so the user confirms each one in Canvas first, seeing the tool and its arguments.
  - **A stopped session** is started for the call. That needs no model turn, so it uses no quota. If a just-started Claude Code is still connecting to the server, Codekin waits for it.
  - **Limits per app:** 4 calls at once, 30 a minute, 256 KiB of arguments and a 4 MiB result. A call waits at most 10 minutes, including an approval prompt.
  - **Protocol.** `mcp_app_call { itemId, callId, tool, arguments, confirmed? }` is answered, to the asking client only, with `mcp_app_result { callId, result | error, needsConfirmation? }`. Over a relay it is owner-only, like the tools the agent runs.
- **Codekin controls stay outside the sandbox frame.** Every request a sandboxed app makes on the user's behalf goes through a confirmation in Codekin's chrome. That covers sending a message, opening a link and calling a tool, and tool calls also go through the normal approval rules.

### Live preview

A `preview` item shows a dev server running on the machine Codekin runs on.

**How servers start.** Codekin runs a command only when the user asks:

- **The agent** starts the server in its own shell, so the session's approval rules apply. It then calls `canvas_preview` with the port. Codekin never runs anything on the agent's behalf.
- **The user** starts a configuration from the repository's `.claude/launch.json`, the file Claude Code's desktop app uses. Canvas lists the configurations, with their commands, when it is empty, and offers **Start** on a stopped preview.
  - Codekin reads `name`, `runtimeExecutable` + `runtimeArgs` (or `program` + `args`, run with `node`), `port` (default 3000), `cwd` (inside the project), `env` and `url`.
  - An entry with only a localhost `url` attaches to a server you run yourself.
  - `${workspaceFolder}` is replaced in `cwd`, arguments and `env`. Comments and trailing commas are allowed.
  - `autoPort` is not supported: when the port is already in use, Codekin shows what answers there instead of starting another server.
  - **What you see is what runs.** The list and a stopped preview show the whole command, its folder and every `env` value. Starting sends back a digest of what was shown, and Codekin refuses (and shows the new command) if the file changed since. **Restart** runs exactly what was started, not what the file says now.
  - A server Codekin starts runs in its own process group, in the session's folder. Its environment is the agent CLIs' environment minus Codekin's own variables, credentials (names ending in `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, …) and `NODE_ENV`, plus `PORT` and the entry's `env`. Stopping signals the whole group, and kills what's left after five seconds.
  - One preview operation runs at a time per session, so pressing Start twice starts one server.
  - Codekin keeps the last 1,000 lines of its output and stops it when the preview is deleted, the session is deleted or Codekin shuts down.

**The proxy** (`server/preview-proxy.ts`). Each open preview gets its own proxy port, so the app runs on its own origin: never Codekin's, nor the sandbox's, nor another preview's.

- **Where it forwards.** HTTP and WebSocket traffic (hot reload) goes to `localhost:<port>` (IPv4, then IPv6) and nowhere else. Codekin's own port, the sandbox port and the preview ports are refused as targets.
- **Who it admits.** A browser gets in only after opening the preview's entry URL, which carries a random per-preview key. After that the key travels in an `HttpOnly` cookie named for the proxy port. Codekin gives the entry URL only to its own authenticated clients (owner-only over a relay), so another machine that can reach the port gets nothing.
- **How it presents requests.** `Host` and `Origin` look like the dev server's own (`localhost:<port>`), which satisfies dev servers' host checks (Vite's `allowedHosts`, for example). Codekin's cookie is stripped before forwarding, and `Location` headers that point at the dev server become paths.
- **How it frames the page.** `X-Frame-Options` and `frame-ancestors` are dropped. Codekin frames the page with `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"`: the app keeps its own origin, but can't navigate Codekin's tab.
- **The added script.** HTML pages (documents, not fragments a page fetches) get a small script (`/__codekin/preview.js`, served by the proxy) that does nothing until Canvas says hello from its origin. It then:
  - reports the page's location and title;
  - reports console errors and warnings and uncaught errors;
  - goes back, forward or reloads on request;
  - runs the element picker. A pick is accepted only while the user has the picker on, one per press. The user hovers to outline elements and clicks one. The selector, text, markup excerpt, size and, in React development builds, the component name and source are attached to the next message (`what="element"`).
  - Console errors and the server's output can be attached too (`what="console"`).
  - Canvas treats everything the script sends as untrusted text from the app.
- **Shared origins.** A proxy port serves different previews over time. Each browser keeps a marker cookie naming the preview it last entered on that port; when the marker names another preview (or the browser has none), the entry response sends `Clear-Site-Data: "storage"`. The decision is per browser, so a phone that last saw app X on a port is cleared even after a laptop has already entered app Y there. Service worker scripts are refused, and the app can't set Codekin's own `codekin_preview_*` cookies, so one app's storage and workers never reach another.
- **Only Codekin drives the script.** It answers a `hello` only from a top-level page on Codekin's own port.
- **Ports.** `CANVAS_PREVIEW_PORTS` sets the proxy ports: a range (`32362-32371`) or a list. The default is ten ports from Codekin's port + 10, and `off` turns previews off. When every port is in use, the preview opened longest ago gives up its port. Each preview gets the same port back when it is free, so the app's storage on that origin survives. Codekin's CSP adds the ports to `frame-src`.
- **Status.** A stopped or crashed server shows its status and last output in place of the page, never a stale copy. Codekin probes the port every few seconds, so a server the agent restarts comes back on its own.

**Where it works.** Previews work wherever the browser reaches Codekin's machine directly: localhost, the desktop app, or a LAN or tailnet address on which the proxy ports are reachable.

- **Not over https.** A Codekin page served over https can't frame the http proxy. Canvas offers **Open in a new tab** instead.
- **Not through the relay.** The hosted web app and relay sessions can't reach the proxy ports. Canvas says so and offers a snapshot instead (below), and the agent still sees the item.
- **Tunnels.** If you reach Codekin through an SSH tunnel, forward the preview ports too.

### Snapshots

A snapshot loads a preview's page in a headless Chrome or Chromium on the machine and keeps a screenshot as an image item. It is how a preview is seen where the live page can't be: the hosted web app, a relay session, or a Codekin page served over https.

- **Taking one.** **Snapshot** in the preview's toolbar (or **Take a snapshot** where the page can't be shown) loads the path the preview is on, at the chosen viewport: 1280×800, 820×1180, or a 390×844 phone (touch, 2x pixels). On a phone it is always the phone size.
- **Full page.** The toggle next to **Snapshot** makes snapshots capture the page's whole height instead of the first screen. Codekin scrolls down the page a screen at a time (so lazy-loaded images and scroll-triggered content load), back to the top, waits for the network to be quiet again, then captures the full content height at the viewport's width. Sections sized in `vh` keep their first-screen height, and `position: fixed` elements (cookie banners, chat widgets, a framework's dev toolbar) appear once, where the first screen ends. An image is at most 16,384 device pixels tall (8,192 CSS px for a phone): a longer page stops there and the snapshot says so. If a long page still passes the 2 MiB limit as JPEG, it is kept at a smaller scale. A page that scrolls inside its own container (an app shell with `overflow: hidden` on the body) has no extra height to capture, so a full-page snapshot of it matches the normal one.
- **What it records.** The image (PNG, or JPEG when a PNG would pass the 2 MiB image limit), the path and title the page ended on, the viewport (and whether it is full-page), and up to 50 console errors and warnings (console calls, uncaught errors, failed resources) seen while it loaded. Codekin waits for the load event and then for the network to be quiet for half a second (at most five more seconds), so a single-page app's first fetches land. The whole snapshot is limited to 30 seconds.
- **Where it goes.** Each preview has one snapshot item, `Snapshot: <preview title>`, with source `{ type: 'snapshot', preview }`. Every snapshot is a new revision, so the revision bar steps through them and **Compare** shows two side by side. The item opens when the snapshot is ready. Its console record can be sent to the agent like the live console.
- **The browser.** `CANVAS_SNAPSHOT_BROWSER` names it (a path, or `off`). Otherwise Codekin uses Chrome, Chromium or Edge on `PATH` or in `/Applications`, else the newest browser Playwright installed (`PLAYWRIGHT_BROWSERS_PATH`, or its default cache). Without one, the button explains what to install.
- **Isolation.**
  - Each snapshot runs a new browser with a new temporary profile: no cookies, storage or logins from anywhere, and the profile is deleted afterwards. A page behind a login shows its logged-out state.
  - Codekin drives it over `--remote-debugging-pipe`, so no debugging port is opened.
  - It loads `http://localhost:<port>` directly, not through the preview proxy, and only the item's port. Codekin's own ports are refused, as for previews.
  - One snapshot at a time per session, and two at a time per machine.
  - **Without Chrome's sandbox.** Where the sandbox can't start (Ubuntu 23.10 and later restrict the unprivileged user namespaces it needs, unless the browser ships an AppArmor profile), the snapshot fails and says how to fix it. Codekin never drops the sandbox on its own: the machine's owner opts in with `CANVAS_SNAPSHOT_NO_SANDBOX=1`, and then Codekin runs the browser without it. The page then reaches only this machine: every other request goes to a proxy that isn't there, and WebRTC can't send UDP. The snapshot says so and counts what was blocked, such as web fonts and CDN scripts.

## 9. Slices

| # | Slice | Contents |
|---|---|---|
| 1 | Item model + store | Server store, WebSocket protocol, relay policy, session-list summary. No UI |
| 2 | Layout shell | Rail, chat column, Canvas panel, Changes strip and slide-over, breakpoints, phone, "Open in Canvas" |
| 3 | Items and publishing | Markdown, image, table and diagram items; switcher, revisions, pinning, states; `canvas_show` / `canvas_update` for Claude, Codex and Grok; chat cards and auto-open |
| 4 | Selection → context | Selection toolbar, attachments, composer redesign (section 6) |
| 5 | Sandbox origin | Separate origin and CSP, then sandboxed charts and HTML artifacts (done) |
| 6 | MCP Apps (display) | Adapter enrichment for Claude and Codex, `AppBridge` host (done) |
| 7 | Live preview | Local dev servers: proxy, launch configurations, picker, console and server output (done). Live previews through the relay are not supported; snapshots work everywhere (done) |
| 8 | Interactive MCP Apps | Tool calls from apps through Claude Code `mcp_call` (session permission rules) and Codex `mcpServer/tool/call` (confirmed in Canvas) (done) |

Relay-tunnelled previews are out of scope until there is a supported path and evidence they're needed.
