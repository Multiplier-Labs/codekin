# Docs Browser — Feature Spec

Browse and read Markdown files from any connected repo, rendered as rich text directly in the main terminal area. The input box remains visible, allowing Claude to edit docs on request.

---

## Table of Contents

- [Motivation](#motivation)
- [Entry Point](#entry-point)
- [File Picker](#file-picker)
- [Document View](#document-view)
- [Navigation & Keyboard](#navigation--keyboard)
- [Input Box Behavior](#input-box-behavior)
- [Server Endpoint](#server-endpoint)
- [Markdown Rendering](#markdown-rendering)
- [Styling](#styling)
- [Out of Scope (v1)](#out-of-scope-v1)
- [Components & Files](#components--files)

---

## Motivation

Markdown files (README, CLAUDE.md, docs/) have become key context in modern repos. There is no convenient way to browse and read them in rich text format without leaving the terminal UI. Adding a lightweight docs browser lets users read and — via the chat input — edit docs without switching tools.

---

## Entry Point

Each repo row in the sidebar gets a small document icon on the right side, revealed on hover — matching the existing pattern where edit/delete icons appear via `opacity-0 group-hover:opacity-100 transition-opacity`.

```
┌─ Sidebar ──────────────────┐
│  Sessions              [+] │
│  ├─ Debug API issue        │
│  └─ Refactor auth flow     │
│                            │
│  Repos                     │
│  ├─ codekin           [📄] │  ← visible on row hover
│  ├─ myapp             [📄] │
│  └─ infra             [📄] │
└────────────────────────────┘
```

### Icon spec

- **Library**: `@tabler/icons-react` (consistent with all other icons in the app).
- **Icon**: `IconFileText` at 14px, stroke 2.
- **Idle color**: `text-neutral-5` (matches other hover-revealed action icons).
- **Hover color**: `text-neutral-2` via `hover:text-neutral-2 transition-colors`.
- **Tooltip**: `title="Browse docs"`.
- **Visibility**: `opacity-0 group-hover/repo:opacity-100 transition-opacity` — same pattern as existing edit/delete buttons on repo and session rows.
- **Placement**: Right side of the repo header row, before any existing action icons, inside the `group/repo` container.

---

## File Picker

A dropdown anchored to the doc icon, using the same visual pattern as `SkillMenu` and `ModelSelector` dropdowns.

```
┌─────────────────────────┐
│  CLAUDE.md              │   ← pinned
│  README.md              │   ← pinned
│  ─────────────────────  │
│  docs/protocol.md       │
│  docs/setup.md          │
│  CHANGELOG.md           │
└─────────────────────────┘
```

### Container styling

```
absolute left-full top-0 ml-1 w-64 z-50
rounded-md border border-neutral-10 bg-neutral-12 py-1 shadow-lg
```

This matches the Module Browser popover positioning (anchored to the right of the sidebar item).

### Item styling

```
w-full text-left px-3 py-1.5 text-[15px] text-neutral-4
hover:bg-neutral-10/50 transition-colors cursor-pointer
```

Matches `SkillMenu` item pattern. Pinned file names use `text-neutral-2 font-medium` to stand out.

### Divider

```
border-t border-neutral-10 my-1
```

Separates pinned files from the rest — same divider pattern used throughout the sidebar.

### Ordering rules

1. **Pinned files** appear first, in this order (if they exist): `CLAUDE.md`, `README.md`.
2. A visual divider separates pinned from the rest.
3. **Remaining files** are sorted alphabetically by relative path.
4. Files nested more than 3 directories deep are excluded to avoid noise.
5. Hidden directories (`.github/`, `.codekin/`, `node_modules/`, etc.) are excluded.

### Behavior

- Opens on doc icon click; closes on item click, `Escape`, or click outside.
- File list is fetched from the server on open (not preloaded), with a loading state: `IconLoader2` at 14px with `animate-spin`, centered in the dropdown.
- Empty state (no `.md` files found): `text-[13px] text-neutral-5 px-3 py-2` — "No markdown files found".

---

## Document View

Clicking a file in the picker replaces the main terminal/chat area with the rendered markdown content. A thin navigation bar appears at the top.

```
┌─ Main Area ────────────────────────────────────────┐
│  ← Back    codekin / docs/protocol.md    [Raw]     │
│────────────────────────────────────────────────────│
│                                                    │
│  # WebSocket Protocol                              │
│                                                    │
│  ## Message Types                                  │
│                                                    │
│  All messages are JSON objects with a `type`        │
│  field. The following types are supported:          │
│                                                    │
│  | Type     | Direction | Description |            │
│  |----------|-----------|-------------|            │
│  | auth     | client→ws | Auth token  |            │
│  | ping     | client→ws | Keepalive   |            │
│                                                    │
└────────────────────────────────────────────────────┘
│ Ask Claude about this doc, or request changes...   │
└────────────────────────────────────────────────────┘
```

### Nav bar styling

The top bar uses the same visual weight as the sidebar section headers:

```
flex items-center gap-2 px-4 py-2 border-b border-neutral-10 bg-neutral-11/50
```

| Element | Style | Behavior |
|---------|-------|----------|
| **← Back** button | `flex items-center gap-1 text-[13px] text-neutral-4 hover:text-neutral-1 transition-colors cursor-pointer` with `IconChevronLeft` at 14px stroke 2.5 | Returns to previous view |
| **File path** | `flex-1 text-[13px] text-neutral-5 text-center truncate` — format: `repoName / relative/path.md` with `/` separator in `text-neutral-7` | Non-interactive in v1 |
| **[Raw] toggle** | `rounded px-2 py-0.5 text-[13px] text-neutral-5 hover:text-neutral-2 hover:bg-neutral-9 transition-colors` — when active (raw mode): `bg-neutral-9 text-neutral-2` | Switches rendered ↔ raw source |

### Content area

```
flex-1 overflow-y-auto
```

Uses the existing `.chat-scroll` scrollbar styling for consistent scrollbar appearance.

### Loading state

While fetching file content, show the standard activity indicator pattern:

```
flex items-center justify-center py-12
```

With `IconLoader2` at 20px, `animate-spin text-neutral-5`.

### Error state

If the file fails to load:

```
rounded-md bg-error-10/50 px-3 py-2 text-[13px] text-error-4 mx-4 mt-4
```

Matches the existing error message pattern from modals.

### Scrolling

Independently scrollable. Scroll position is not preserved when navigating away.

---

## Navigation & Keyboard

| Action | Trigger |
|--------|---------|
| Close doc view | Click **← Back**, press `Escape`, or click any session in sidebar |
| Toggle raw/rendered | Click **[Raw]** / **[Rendered]** button |
| Open file picker | Click doc icon on repo row |

The doc view is **ephemeral** — it has no URL state, no history stack, and no persistence. Navigating away discards it.

---

## Input Box Behavior

The `InputBar` component at the bottom remains visible and functional while viewing a doc. The doc view replaces only the message feed area, not the full main column.

### With an active session

- Placeholder text changes to: `Ask Claude about this doc, or request changes...`
- User input is sent to Claude as a normal message. The currently viewed file path is included as context so Claude can reference or edit it.
- If Claude edits the viewed file, the rendered view re-fetches and updates.

### Without an active session

- Input box is **disabled** with placeholder: `Start a session to edit this doc`.
- `disabled:opacity-40` on the textarea (matches existing disabled patterns).
- The user can still read the doc; they just can't interact with Claude.

---

## Server Endpoint

A new REST endpoint provides the file list and file content. Routes are defined in `server/docs-routes.ts` and mounted alongside existing session routes.

### `GET /api/repos/:repoId/docs`

Returns the list of markdown files in the repo.

**Response:**

```json
{
  "files": [
    { "path": "CLAUDE.md", "pinned": true },
    { "path": "README.md", "pinned": true },
    { "path": "docs/protocol.md", "pinned": false },
    { "path": "docs/setup.md", "pinned": false },
    { "path": "CHANGELOG.md", "pinned": false }
  ]
}
```

### `GET /api/repos/:repoId/docs/:filePath`

Returns the raw content of a single markdown file. The `:filePath` is a URL-encoded relative path (e.g., `docs%2Fprotocol.md`).

**Response:**

```json
{
  "path": "docs/protocol.md",
  "content": "# WebSocket Protocol\n\n..."
}
```

**Errors:**
- `404` if the file doesn't exist or is outside the repo root (path traversal guard).
- `400` if the file extension is not `.md`.

### Security

- The `:filePath` parameter must be validated against path traversal (`..`, absolute paths). Use `path.resolve()` and verify the result starts with the repo root.
- Only `.md` files are served.
- The endpoint requires the same auth token as other API routes (existing middleware).

---

## Markdown Rendering

### Library: `marked` + `DOMPurify`

- **`marked`** — lightweight (~40KB), outputs HTML strings, built-in GFM support (tables, strikethrough, task lists, autolinks).
- **`DOMPurify`** — sanitizes the HTML output before injection to prevent XSS from malicious markdown content.
- Rendered via `dangerouslySetInnerHTML` on a container div.

### Syntax highlighting

- Use `marked-highlight` with `highlight.js` for fenced code blocks.
- Load a subset of language grammars to keep bundle size reasonable: typescript, javascript, json, bash, python, go, yaml, markdown, html, css.

### Implementation sketch

```typescript
import { marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js/lib/core'
import DOMPurify from 'dompurify'

marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value
    }
    return code
  }
}))

function MarkdownRenderer({ content }: { content: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(content, { gfm: true }) as string),
    [content]
  )
  return (
    <div
      className="docs-prose"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
```

---

## Styling

The rendered markdown uses a `.docs-prose` class scoped in `src/index.css` (alongside the existing `.prose-themed` styles), reusing the same CSS custom property system.

### Key style decisions

| Property | Value | Rationale |
|----------|-------|-----------|
| **Body font** | `'Lato', sans-serif` | Distinguishes docs from monospace chat. Matches app sans font. |
| **Code font** | `'Inconsolata', monospace` | Consistent with chat code blocks. |
| **Body text color** | `var(--color-neutral-2)` | Same as assistant message text. |
| **Body text size** | `15px` | Matches chat message text size. |
| **Max content width** | `720px`, centered with `mx-auto` | Long lines are hard to read at full width. |
| **Padding** | `px-6 py-4` | Comfortable reading margin. |
| **Background** | `bg-neutral-12` (same as chat) with a `border-t-2 border-accent-8/40` top accent | Subtle visual cue that this is a doc view, not a chat. |

### Headings

```css
.docs-prose h1 { font-size: 1.5em; font-weight: 700; color: var(--color-neutral-1); margin: 1.5em 0 0.5em; }
.docs-prose h2 { font-size: 1.25em; font-weight: 600; color: var(--color-neutral-1); margin: 1.25em 0 0.5em; }
.docs-prose h3 { font-size: 1.1em; font-weight: 600; color: var(--color-neutral-2); margin: 1em 0 0.5em; }
```

### Code blocks

Reuse the existing chat code block styles for consistency:

```css
.docs-prose pre {
  background: var(--color-neutral-11);
  border: 1px solid var(--color-neutral-9);
  border-radius: 6px;
  padding: 0.75em 1em;
  margin: 0.5em 0;
  overflow-x: auto;
  font-size: 14px;
}
.docs-prose code {
  font-family: 'Inconsolata', monospace;
}
.docs-prose :not(pre) > code {
  background: var(--color-neutral-10);
  padding: 0.1em 0.4em;
  border-radius: 3px;
  color: var(--color-accent-4);
}
```

### Tables

```css
.docs-prose table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5em 0;
  font-size: 14px;
}
.docs-prose th, .docs-prose td {
  padding: 0.25em 0.75em;
  border: 1px solid var(--color-neutral-9);
  text-align: left;
}
.docs-prose th {
  background: var(--color-neutral-11);
  font-weight: 600;
  color: var(--color-neutral-2);
}
.docs-prose tr:nth-child(even) {
  background: var(--color-neutral-11)/30;
}
```

### Links

```css
.docs-prose a {
  color: var(--color-accent-5);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.docs-prose a:hover {
  color: var(--color-accent-4);
}
```

External links open in a new tab. Internal `.md` links are non-functional in v1.

### Blockquotes

```css
.docs-prose blockquote {
  border-left: 3px solid var(--color-neutral-8);
  padding-left: 1em;
  color: var(--color-neutral-4);
  margin: 0.5em 0;
}
```

### Lists

```css
.docs-prose ul { list-style: disc; padding-left: 1.5em; margin: 0.5em 0; }
.docs-prose ol { list-style: decimal; padding-left: 1.5em; margin: 0.5em 0; }
.docs-prose li { margin: 0.25em 0; }
```

### Horizontal rules

```css
.docs-prose hr {
  border: none;
  border-top: 1px solid var(--color-neutral-9);
  margin: 1.5em 0;
}
```

### Raw view

When raw mode is active, the content area shows the source text in a `<pre>` with monospace styling:

```
font-family: 'Inconsolata', monospace
text-[14px] text-neutral-3 whitespace-pre-wrap px-6 py-4
```

No syntax highlighting in raw mode — just plain text.

### Light mode

The `.docs-prose` styles should respect the `[data-theme="light"]` selector. Since all colors reference CSS variables that are already remapped in light mode, this works automatically for most properties. Code block and table backgrounds may need explicit overrides if contrast is insufficient.

---

## Out of Scope (v1)

These are explicitly excluded from the first version to keep scope tight:

- **In-doc editing** — no contenteditable, no inline edit buttons.
- **File creation** — no "New doc" action from the browser.
- **Non-markdown files** — only `.md` files are shown.
- **Search within docs** — no full-text search across docs.
- **Cross-doc navigation** — clicking a relative link to another `.md` file does not open it in the viewer.
- **Mermaid diagrams** — no diagram rendering.
- **Image rendering** — images referenced in markdown are not displayed (would require serving arbitrary repo files).
- **URL state** — the doc view is not reflected in the browser URL / history.
- **Copy button on code blocks** — can be added later, reusing the existing `group/codeblock` hover pattern from chat.

---

## Components & Files

### New files

| File | Purpose |
|------|---------|
| `src/components/DocsBrowser.tsx` | Main doc view: nav bar + rendered content + raw toggle. Replaces message feed when active. |
| `src/components/DocsFilePicker.tsx` | Dropdown file list anchored to the repo doc icon. Uses click-outside and `Escape` to close. |
| `src/components/MarkdownRenderer.tsx` | `marked` + `DOMPurify` wrapper component. Memoized HTML output. |
| `src/hooks/useDocsBrowser.ts` | State: selected file, content, loading, error, raw toggle, open/close. Fetch logic. |
| `server/docs-routes.ts` | Express router: `GET /api/repos/:repoId/docs` and `GET /api/repos/:repoId/docs/:filePath`. |

### Modified files

| File | Change |
|------|--------|
| `src/components/RepoSection.tsx` | Add `IconFileText` button to repo header row, triggers `DocsFilePicker`. |
| `src/components/ChatView.tsx` (or layout root) | Conditionally render `DocsBrowser` in place of message feed when a doc is selected. |
| `server/ws-server.ts` | Mount `docs-routes` on the Express app. |
| `src/index.css` | Add `.docs-prose` scoped styles. |

### New dependencies

| Package | Purpose | Approx size |
|---------|---------|-------------|
| `marked` | Markdown → HTML | ~40KB |
| `dompurify` | HTML sanitization | ~15KB |
| `marked-highlight` | Code block highlighting bridge | ~2KB |
| `highlight.js` | Syntax highlighting (core + selected langs) | ~30KB subset |
