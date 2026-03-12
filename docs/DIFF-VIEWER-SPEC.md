# Diff Viewer Sidebar — Specification

A right-hand sidebar panel that shows all file changes made by Claude during the current session, with inline unified diffs and file-level navigation.

---

## Motivation

When Claude edits files during a session, the changes are visible only as tool activity chips in the chat stream. Once the conversation grows, it's hard to get a consolidated view of *what actually changed*. The diff viewer gives the user a persistent, browsable summary of all file modifications — similar to VS Code's Source Control panel or GitHub's "Files changed" tab.

---

## User Experience

### Opening / Closing

- **Toggle button** in the top-right area of the main chat panel (icon: `<>` or a split-diff icon).
- **Keyboard shortcut**: `Ctrl+Shift+D` / `Cmd+Shift+D`.
- The panel opens as a **right sidebar**, alongside the chat. It does NOT replace the chat — both are visible side by side.
- On mobile, it opens as a **full-screen overlay** (slide-in from right) with a close button.

### Layout

```
┌────────────┐ ┌──────────────────────┐ ┌─────────────────┐
│  Left      │ │   Chat Area          │ │  Diff Viewer    │
│  Sidebar   │ │                      │ │                 │
│            │ │                      │ │  file-tree      │
│            │ │                      │ │  ────────────── │
│            │ │                      │ │  unified diff   │
│            │ │                      │ │  (scrollable)   │
│            │ │                      │ │                 │
└────────────┘ └──────────────────────┘ └─────────────────┘
```

- Default width: **400px**, resizable (drag left edge), min 280px, max 600px.
- The chat area shrinks to accommodate the diff panel (flexbox).
- Width preference persisted in `localStorage` (`codekin-diff-panel-width`).

### File Tree (top section)

A compact list of changed files, grouped by status:

| Icon | Status | Meaning |
|------|--------|---------|
| `M`  | Modified | File was edited (Edit tool) |
| `A`  | Added | File was created (Write tool to new path) |
| `D`  | Deleted | File was removed (Bash `rm` detected) |

Each row shows:
- Status badge (M/A/D) with color (yellow/green/red)
- Relative file path (relative to session `workingDir`)
- Additions / deletions count (`+12 −3`)

Click a file to scroll the diff section to that file. The active file is highlighted.

### Diff Section (bottom / scrollable)

- **Unified diff** format, one file after another, scrollable.
- Syntax-highlighted with the same theme as code blocks in chat.
- Line numbers shown for both old and new versions.
- Added lines highlighted green, removed lines highlighted red, context lines neutral.
- **Collapsed by default** for files with >200 changed lines (click to expand).
- Each file section has a header bar with the file path and expand/collapse toggle.

### Summary Bar (sticky top)

- Total files changed, total insertions, total deletions.
- Example: `5 files changed  +87 −23`
- "Refresh" button to re-fetch the current diff state.

---

## Data Flow

### Source of Truth: `git diff`

The diff data comes from running `git diff` in the session's working directory on the server. This captures the *actual* filesystem state vs the last commit — which is exactly what Claude changed.

We do **not** try to reconstruct diffs from tool events (too fragile — Bash commands can also modify files). Instead, we ask the server for the real git diff.

### New WebSocket Messages

#### Client → Server

```typescript
| { type: 'get_diff'; scope?: 'staged' | 'unstaged' | 'all' }
```

- `scope` defaults to `'all'` (equivalent to `git diff HEAD`).
- Requests the current diff for the active session's working directory.

#### Server → Client

```typescript
| { type: 'diff_result'; files: DiffFile[]; summary: DiffSummary }
```

```typescript
interface DiffFile {
  path: string                     // relative to workingDir
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  oldPath?: string                 // set when status is 'renamed'
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

interface DiffHunk {
  header: string                   // e.g. "@@ -10,7 +10,8 @@"
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

interface DiffLine {
  type: 'add' | 'delete' | 'context'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

interface DiffSummary {
  filesChanged: number
  insertions: number
  deletions: number
}
```

### Server Implementation

On receiving `get_diff`, the session manager:

1. Validates the requesting client is joined to a session.
2. Runs `git diff HEAD --no-color --unified=3` in the session's `workingDir`.
3. Parses the unified diff output into the `DiffFile[]` structure.
4. Sends `diff_result` back to the requesting client only (not broadcast).

A `parseDiff(raw: string): DiffFile[]` utility handles the parsing. This is a new server module: `server/diff-parser.ts`.

### Auto-Refresh

The diff panel auto-refreshes after:
- A `tool_done` event where `toolName` is `Edit`, `Write`, or `Bash` (debounced 500ms).
- The user clicks the manual "Refresh" button.

The panel does **not** poll on an interval. It refreshes reactively.

---

## Frontend Components

### New Components

| Component | File | Description |
|-----------|------|-------------|
| `DiffPanel` | `src/components/DiffPanel.tsx` | Top-level right sidebar container. Manages open/close state, width, resize handle. |
| `DiffFileTree` | `src/components/diff/DiffFileTree.tsx` | Compact file list with status badges and change counts. |
| `DiffFileView` | `src/components/diff/DiffFileView.tsx` | Single file's diff display: header + hunks. |
| `DiffHunkView` | `src/components/diff/DiffHunkView.tsx` | Renders one hunk with line numbers and syntax highlighting. |
| `DiffSummaryBar` | `src/components/diff/DiffSummaryBar.tsx` | Sticky top bar with aggregate stats and refresh button. |

### New Hook

| Hook | File | Description |
|------|------|-------------|
| `useDiff` | `src/hooks/useDiff.ts` | Sends `get_diff`, receives `diff_result`, manages diff state. Exposes `refresh()`, `files`, `summary`, `loading`. Auto-refreshes on relevant `tool_done` events. |

### Integration Points

- **`App.tsx`**: Add `DiffPanel` to the right side of the flex layout, conditionally rendered.
- **`types.ts`**: Add `get_diff` to `WsClientMessage`, `diff_result` to `WsServerMessage`, plus `DiffFile`, `DiffHunk`, `DiffLine`, `DiffSummary` interfaces.
- **`useChatSocket.ts`**: Route incoming `diff_result` messages to the `useDiff` hook. Emit auto-refresh signals on `tool_done` for file-mutating tools.
- **`LeftSidebar.tsx`** or top bar: Add the toggle button for the diff panel.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd+Shift+D` | Toggle diff panel |
| `Escape` (when panel focused) | Close diff panel |
| `↑` / `↓` (in file tree) | Navigate files |
| `Enter` (in file tree) | Scroll to file diff |

---

## Edge Cases

- **No git repo**: If the session's `workingDir` is not inside a git repository, the diff panel shows an info message: "Not a git repository — diff view unavailable."
- **No changes**: Shows "No changes detected" with a subtle icon.
- **Binary files**: Listed in the file tree with a "binary" badge; no inline diff shown.
- **Large diffs**: Files with >500 changed lines are collapsed by default with a warning: "Large diff (N lines) — click to expand."
- **Uncommitted new files**: `git diff HEAD` won't show untracked files. The server should run `git add -N .` (intent-to-add) before diffing, or use `git diff HEAD` + `git ls-files --others --exclude-standard` to also capture new untracked files.
- **Renamed files**: Detected via `git diff --find-renames` and displayed with `oldPath → newPath`.
- **Session without active Claude process**: Diff is still available — it reads the filesystem, not the process.

---

## Styling

- Follows the existing Codekin theme (neutral backgrounds, accent colors from `src/index.css`).
- Diff colors:
  - Added lines: `bg-success-950/30` (dark) / `bg-success-100` (light), text `text-success-400`
  - Deleted lines: `bg-error-950/30` (dark) / `bg-error-100` (light), text `text-error-400`
  - Context lines: default background
  - File headers: `bg-neutral-800` (dark) / `bg-neutral-100` (light)
- Line numbers: `text-neutral-500`, monospace (Inconsolata).
- Resize handle: Same treatment as the left sidebar resize handle.
- Transition: Slide-in from right, 150ms ease-out.

---

## Non-Goals (v1)

These are explicitly out of scope for the initial implementation:

- **Side-by-side diff view** — unified only for v1.
- **Inline commenting / review** — this is a viewer, not a review tool.
- **Commit / stage from the UI** — the user does this through Claude or the terminal.
- **Diff between arbitrary commits** — always diffs working tree vs HEAD.
- **File editing from the diff panel** — read-only.

---

## Implementation Order

1. **Server**: `diff-parser.ts` + `get_diff` message handler in session-manager.
2. **Types**: Add new message types and interfaces to `src/types.ts` and `server/types.ts`.
3. **Hook**: `useDiff.ts` — WebSocket integration + auto-refresh logic.
4. **Components**: `DiffPanel` → `DiffSummaryBar` → `DiffFileTree` → `DiffFileView` → `DiffHunkView`.
5. **App integration**: Layout changes in `App.tsx`, toggle button, keyboard shortcut.
6. **Polish**: Resize persistence, mobile overlay, collapsed large files, syntax highlighting.
