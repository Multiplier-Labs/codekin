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
- Panel header shows a **colored status indicator** (green dot when `summary.filesChanged > 0` for the current scope, neutral when zero) alongside the title.

### Layout

```
┌────────────┐ ┌──────────────────────┐ ┌─────────────────────┐
│  Left      │ │   Chat Area          │ │  Diff Viewer        │
│  Sidebar   │ │                      │ │                     │
│            │ │                      │ │  [toolbar]          │
│            │ │                      │ │  branch · scope ▾   │
│            │ │                      │ │  5 files +87 −23    │
│            │ │                      │ │  ─────────────────  │
│            │ │                      │ │  file-tree          │
│            │ │                      │ │  ─────────────────  │
│            │ │                      │ │  ┌─ file card ────┐ │
│            │ │                      │ │  │ path  +3 −1  ⟳│ │
│            │ │                      │ │  │ diff hunks     │ │
│            │ │                      │ │  └────────────────┘ │
│            │ │                      │ │  ┌─ file card ────┐ │
│            │ │                      │ │  │ ...            │ │
│            │ │                      │ │  └────────────────┘ │
└────────────┘ └──────────────────────┘ └─────────────────────┘
```

- Default width: **400px**, resizable (drag left edge), min 280px, max 600px.
- The chat area shrinks to accommodate the diff panel (flexbox).
- Width preference persisted in `localStorage` (`codekin-diff-panel-width`).

### Toolbar (sticky top)

The top of the panel contains controls and summary info:

- **Branch indicator**: Shows the current branch name (read-only, informational). When in detached HEAD state (`git rev-parse --abbrev-ref HEAD` returns `"HEAD"`), display the short commit SHA instead (via `git rev-parse --short HEAD`) prefixed with "detached at".
- **Scope selector**: Dropdown to switch between `Uncommitted changes` (default, `git diff HEAD`), `Staged`, and `Unstaged`. Changing scope re-fetches the diff. The dropdown label includes a file count badge (e.g. `Uncommitted changes (5)`).
- **Discard all**: A destructive action button (red text, confirmation required) that reverts all changes visible in the current scope. Behavior varies by scope — see [Discard Behavior](#discard-behavior) below. Always shown (disabled when no changes).
- **Summary line**: Total files changed, total insertions, total deletions. Example: `5 files changed  +87 −23`
- **Refresh button**: Re-fetch the current diff state.

### File Tree

A compact list of changed files, grouped by status:

| Icon | Status | Color | Meaning |
|------|--------|-------|---------|
| `M`  | Modified | yellow | File was edited (Edit tool) |
| `A`  | Added | green | File was created (Write tool to new path) |
| `D`  | Deleted | red | File was removed (Bash `rm` detected) |
| `R`  | Renamed | blue | File was moved/renamed; displayed as `old → new` |

Each row shows:
- Status badge (M/A/D/R) with color per table above
- Relative file path (relative to session `workingDir`)
- Additions / deletions count (`+12 −3`)

Click a file to scroll the diff section to that file. The active file is highlighted.

### File Cards (scrollable section)

Each changed file is rendered as a **distinct card** with a border and its own header. Cards are stacked vertically in the scrollable area.

#### Card Header

Each card header contains:
- **File path** (relative to `workingDir`) — clicking the path opens the file in a new tab/panel.
- **Change counts**: `+N −M` in green/red.
- **Action buttons** (icon-only, right-aligned):
  - **Open file**: Opens the file for viewing (pencil/external-link icon).
  - **Copy path**: Copies the relative file path to clipboard.
  - **Undo / Discard file**: Reverts changes for this single file using the active scope's discard behavior (see [Discard Behavior](#discard-behavior)). Requires confirmation.
  - **Expand / Collapse toggle**: Collapses the card to header-only.

#### Card Body (Diff Content)

- **Unified diff** format, syntax-highlighted with the same theme as code blocks in chat.
- **Two-gutter line numbers**: old line number on the left, new on the right. Added lines show a blank old gutter; deleted lines show a blank new gutter. Context lines show both.
- Added lines highlighted green, removed lines highlighted red, context lines neutral.
- **Collapsed by default** for files with >300 changed lines (additions + deletions), with a note: "Large diff (N lines) — click to expand."
- Cards for binary files show a "Binary file" badge with no diff content.

---

## Data Flow

### Source of Truth: `git diff`

The diff data comes from running `git diff` in the session's working directory on the server. This captures the *actual* filesystem state vs the last commit — which is exactly what Claude changed.

We do **not** try to reconstruct diffs from tool events (too fragile — Bash commands can also modify files). Instead, we ask the server for the real git diff.

### New WebSocket Messages

#### Client → Server

```typescript
| { type: 'get_diff'; scope?: 'staged' | 'unstaged' | 'all' }
| { type: 'discard_changes'; scope: 'staged' | 'unstaged' | 'all'; paths?: string[]; statuses?: Record<string, DiffFile['status']> }
```

**`get_diff`**:
- `scope` determines which git command runs:
  - `'unstaged'` → `git diff --no-color --unified=3` (working tree vs index)
  - `'staged'` → `git diff --cached --no-color --unified=3` (index vs HEAD)
  - `'all'` (default) → `git diff HEAD --no-color --unified=3` (working tree vs HEAD, combines staged + unstaged)
- Requests the current diff for the active session's working directory.

**`discard_changes`**:
- `scope` — required, determines which changes to discard. Must match the currently active scope in the UI.
- `paths` — optional array of relative file paths to discard. If omitted, discards all changes in the given scope.
- `statuses` — optional map of `path → status` for the files being discarded. When `paths` is provided, this tells the server each file's status so it can pick the correct discard command per the [Per-status handling](#per-status-handling) table. If omitted (e.g. discard-all), the server runs `git status --porcelain` to determine statuses before discarding.
- Behavior per scope — see [Discard Behavior](#discard-behavior).
- Server sends a `diff_result` after discarding (auto-refresh).

#### Server → Client

```typescript
| { type: 'diff_result'; files: DiffFile[]; summary: DiffSummary; branch: string; scope: 'staged' | 'unstaged' | 'all' }
| { type: 'diff_error'; message: string }
```

```typescript
interface DiffFile {
  path: string                     // relative to workingDir
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  oldPath?: string                 // set when status is 'renamed'
  isBinary: boolean                // true for binary files (no hunks emitted)
  additions: number                // 0 for binary files
  deletions: number                // 0 for binary files
  hunks: DiffHunk[]                // empty for binary files
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
  content: string                  // line text WITHOUT the leading +/-/space prefix, no trailing newline
  oldLineNo?: number               // undefined for 'add' lines
  newLineNo?: number               // undefined for 'delete' lines
}

interface DiffSummary {
  filesChanged: number
  insertions: number
  deletions: number
  truncated: boolean               // true if output exceeded size limits
  truncationReason?: string        // e.g. "Diff output exceeded 2 MB limit"
}
```

### Server Implementation

#### `get_diff` handler

On receiving `get_diff`, the session manager:

1. Validates the requesting client is joined to a session.
2. Resolves the `workingDir` from the server-side session record (never from client input).
3. Runs `git rev-parse --abbrev-ref HEAD` to get the current branch name (included in the response as `branch`). If the result is `"HEAD"` (detached state), falls back to `git rev-parse --short HEAD` and prefixes with `"detached at "` (e.g. `"detached at a1b2c3d"`).
4. Runs `git diff` (per scope, see above) with `--find-renames --no-color --unified=3` as a fixed argv array (no shell interpolation). For `'unstaged'` and `'all'` scopes only, also runs `git ls-files --others --exclude-standard` to discover untracked files. (Skipped for `'staged'` — untracked files cannot be staged.)
5. For each untracked file (when applicable), generates a synthetic "added" diff by diffing `/dev/null` against the file content (does **not** mutate the index with `git add -N`).
6. Parses the combined output into `DiffFile[]`. If raw output exceeds **2 MB**, parsing stops, `truncated` is set to `true`, and files parsed so far are returned.
7. Sends `diff_result` (including `branch` and `scope`) back to the requesting client only (not broadcast). On error (e.g. not a git repo, git not found), sends `diff_error` instead.

#### `discard_changes` handler

On receiving `discard_changes`, the session manager:

1. Validates the requesting client is joined to a session.
2. Resolves the `workingDir` from the server-side session record.
3. Validates each path in `paths` (if provided) — must be relative, no `..` traversal, must exist within `workingDir`.
4. Executes discard per the scope and file status — see [Discard Behavior](#discard-behavior).
5. After discard completes, automatically sends a fresh `diff_result` to the client.
6. On error, sends `diff_error`.

### Discard Behavior

Discard uses `git restore` (requires Git 2.23+) with flags that match the active scope. The behavior also depends on the file's status.

#### Commands by scope

| Scope | Git command | Effect |
|-------|------------|--------|
| `unstaged` | `git restore --worktree -- <paths>` | Restores working tree from index |
| `staged` | `git restore --staged -- <paths>` | Unstages changes (moves them back to working tree) |
| `all` | `git restore --staged --worktree -- <paths>` | Fully reverts to HEAD |

When `paths` is omitted, replace `<paths>` with `.` to affect all files.

#### Per-status handling

| Status | `unstaged` scope | `staged` scope | `all` scope |
|--------|-----------------|----------------|-------------|
| **Modified** | `git restore --worktree` | `git restore --staged` | `git restore --staged --worktree` |
| **Deleted** | `git restore --worktree` (recreates file) | `git restore --staged` (unstages deletion) | `git restore --staged --worktree` (recreates file) |
| **Added (untracked)** | Delete with `fs.unlink` | N/A (untracked files can't be staged without `git add`) | Delete with `fs.unlink` |
| **Added (staged new file)** | N/A (file only in index) | `git rm --cached -- <path>` (unstages, leaves on disk) | `git rm --cached -- <path>` + `fs.unlink` (fully removes) |
| **Renamed** | Reverts the rename in the working directory, restoring the file's path and content to match the index | `git restore --staged` on both old and new paths (unstages the rename, leaves working tree as-is) | Fully reverts the rename, restoring the file to its original path and content from HEAD |

#### Safety

- All file deletions use `fs.unlink` (no shell `rm`). Directories are never recursively deleted.
- Paths are validated server-side before any operation — no `..` traversal, must resolve within `workingDir`.

**Constraints:**
- Git commands run with a **10-second timeout** and **2 MB stdout cap** (`maxBuffer`).
- `workingDir` must match a known session — no arbitrary path execution.
- Binary files are detected via `Binary files ... differ` or `GIT binary patch` markers; the parser sets `isBinary: true` and emits no hunks.

A `parseDiff(raw: string, maxBytes?: number): { files: DiffFile[]; truncated: boolean; truncationReason?: string }` utility handles the parsing. This is a new server module: `server/diff-parser.ts`.

### Auto-Refresh

The diff panel auto-refreshes after:
- A `tool_done` event where `toolName` is `Edit` or `Write` (always, debounced 500ms).
- A `tool_done` event where `toolName` is `Bash` **only if** the tool summary suggests a file-mutating command (heuristic: summary does not start with common read-only commands like `ls`, `cat`, `echo`, `grep`, `git log`, `git status`, `pwd`, `which`, `node -e`). When in doubt, refresh — false positives are cheap, missed updates are confusing.
- The user clicks the manual "Refresh" button.

The panel does **not** poll on an interval. It refreshes reactively.

---

## Dependencies

### `react-diff-view`

The diff rendering inside each file card uses [`react-diff-view`](https://github.com/nickodev/react-diff-view) — a React component library for rendering unified diffs with line number gutters, add/delete/context styling, and syntax highlighting support.

- **What it handles**: Hunk rendering, line number gutters, line type styling (add/delete/context), widget insertion points.
- **What we handle**: Panel layout, file tree, file cards, toolbar, scope/discard logic, auto-refresh, resize.
- **Syntax highlighting**: Use `react-diff-view`'s `tokenize` utility with `refractor` (Prism-based) to syntax-highlight diff lines. **Note:** The rest of Codekin uses `highlight.js` for code blocks. Adding `refractor` introduces a second highlighting library. This is acceptable because `react-diff-view`'s tokenizer is designed around `refractor` and adapting it to `highlight.js` would require significant custom work. Ensure the Prism theme CSS is mapped to match the existing Codekin code block colors for visual consistency.
- **Styling**: Override `react-diff-view`'s default CSS with Codekin theme colors (see Styling section). Import the base stylesheet and layer custom styles on top.

```
npm install react-diff-view unidiff refractor
```

### Data pipeline

```
git diff (raw string)
  → server/diff-parser.ts → DiffFile[] (our types)
  → WebSocket → client
  → convert DiffFile.hunks to react-diff-view Hunk[] format
  → <Diff> / <Hunk> components render inside DiffFileCard
```

The `DiffHunkView` component wraps `react-diff-view`'s `<Diff>` and `<Hunk>` components, mapping our `DiffHunk[]` / `DiffLine[]` types to the library's expected format.

---

## Frontend Components

### New Components

| Component | File | Description |
|-----------|------|-------------|
| `DiffPanel` | `src/components/DiffPanel.tsx` | Top-level right sidebar container. Manages open/close state, width, resize handle. |
| `DiffToolbar` | `src/components/diff/DiffToolbar.tsx` | Sticky top bar: branch indicator, scope dropdown, discard-all button, summary line, refresh button. |
| `DiffFileTree` | `src/components/diff/DiffFileTree.tsx` | Compact file list with status badges and change counts. |
| `DiffFileCard` | `src/components/diff/DiffFileCard.tsx` | Single file card: header (path, counts, action buttons) + collapsible diff body. |
| `DiffHunkView` | `src/components/diff/DiffHunkView.tsx` | Renders one hunk within a file card with line numbers and syntax highlighting. |

### New Hook

| Hook | File | Description |
|------|------|-------------|
| `useDiff` | `src/hooks/useDiff.ts` | Sends `get_diff`/`discard_changes`, receives `diff_result`, manages diff state. Exposes `refresh()`, `discard(paths?)`, `setScope()`, `files`, `summary`, `branch`, `scope`, `loading`. Auto-refreshes on relevant `tool_done` events. |

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
- **Binary files**: Listed in the file tree with a "binary" badge (`isBinary: true`); no inline diff shown, additions/deletions reported as 0.
- **Large diffs**: Files with >300 changed lines (additions + deletions) are collapsed by default with a note: "Large diff (N lines) — click to expand." If the entire diff payload was truncated (>2 MB), a banner reads: "Diff truncated — showing partial results."
- **Uncommitted new files**: Untracked files are discovered via `git ls-files --others --exclude-standard` and diffed as synthetic additions (compare `/dev/null` to file content). The server does **not** run `git add -N` or otherwise mutate the index.
- **Renamed files**: Detected via `git diff --find-renames` and displayed in the file tree as `R old → new` with a blue badge.
- **Session without active Claude process**: Diff is still available — it reads the filesystem, not the process.
- **Detached HEAD**: Branch indicator shows `"detached at <short-sha>"` instead of a branch name.
- **Discard confirmation**: Both "Discard all" and per-file discard require a confirmation dialog ("Are you sure? This cannot be undone.") before executing. The dialog uses destructive styling (red confirm button). For "Discard all" when untracked files are present, the dialog explicitly warns that untracked files will be deleted.
- **Discard while Claude is running**: Discard is allowed even when a Claude process is active — the user may want to revert a bad edit mid-session. The diff panel refreshes after discard completes.
- **Git version requirement**: Discard requires Git 2.23+ for `git restore`. If `git restore` is not available, fall back to `git checkout --` for worktree restores and `git reset HEAD --` for unstaging, with a logged warning.

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
- **Commit / stage from the UI** — the user does this through Claude or the terminal. (Discard/undo IS supported.)
- **Diff between arbitrary commits** — always diffs working tree vs HEAD.
- **File editing from the diff panel** — read-only.

---

## Implementation Order

1. **Server**: `diff-parser.ts` + `get_diff` / `discard_changes` cases in `ws-message-handler.ts` (follows existing `switch(msg.type)` dispatch pattern), with implementation methods in `session-manager.ts`.
2. **Types**: Add new message types and interfaces to `src/types.ts` and `server/types.ts`.
3. **Hook**: `useDiff.ts` — WebSocket integration, scope management, discard actions, auto-refresh logic.
4. **Components**: `DiffPanel` → `DiffToolbar` → `DiffFileTree` → `DiffFileCard` → `DiffHunkView`.
5. **App integration**: Layout changes in `App.tsx`, toggle button, keyboard shortcut.
6. **Polish**: Resize persistence, mobile overlay, collapsed large files, syntax highlighting, discard confirmation dialog.
