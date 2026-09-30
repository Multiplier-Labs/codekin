# Handoff: Changes panel redesign

## Overview
This redesign covers the right-hand **Changes** panel (`src/components/DiffPanel.tsx` and its children in `src/components/diff/`). It solves three problems:
1. Text is too small. The panel uses `text-xs` (12px) and `text-micro` (11px) throughout.
2. Context is repeated and scattered. The branch name appears three times, there are two refresh buttons, and the view picker, review base and PR card sit in three separately styled blocks.
3. Navigation is weak. The file list and every file's diff share one scroll, so the list scrolls out of view as soon as you start reading.

The design we chose is **"Pinned file list"**, frame **2a** in the design file. The file list stays fixed at the top of the panel and scrolls on its own. Below it, one file's diff is shown at a time, with previous/next controls. Frames **3a–3d** show how this layout adapts to narrow widths, touch, review comments and discard.

## About the design files
`Changes Panel.dc.html` is a **design reference built in HTML**. It shows the intended look and behavior; it is not production code. Rebuild it inside the existing Codekin React + Tailwind v4 app, using the current components, hooks (`useDiff`, `usePrStatus`, `useReviewComments`), the `@tabler/icons-react` icons and the theme tokens in `src/index.css`. Do not copy the inline styles.

Open the file in a browser. Frames are ordered newest first:
- **3a–3d:** open cases (280px, phone/touch, review comments, discard).
- **2a:** the refined chosen design. The buttons above it switch between the Default, Uncommitted files, Loading, Empty and Error states.
- **1a:** the current panel, recreated from source, for comparison.
- **1b:** the first version of the chosen design.
- **1c:** the rejected drill-in alternative.

## Fidelity
**High fidelity.** The mock uses the **Paper** theme. Every color in it is an existing theme token (mapping below), so use the semantic Tailwind classes; the panel then works in all nine themes. Sizes and spacing are final.

---

## Type scale: the core change
Do not add arbitrary `text-[Npx]` sizes. Raise the scale for the whole panel, the same way `.settings-view` does in `index.css`:

```css
.changes-panel {
  --text-micro: 12.5px;
  --text-meta: 14px;
  --text-body: 15.5px;
  --text-title: 17px;
}
```
Put `changes-panel` on DiffPanel's root element. Then replace every `text-xs` in the panel and its children with `text-meta`, and move the small labels up to `text-micro`. The diff overrides in `.diff-hunk-view` then change as follows:
- `.diff-unified`: font-size **14px**, line-height **1.55** (currently 12px / 1.5).
- `.diff-gutter`: min-width **44px**, padding **0 8px**.
- `.diff-code`: padding **0 10px**.
- `.diff-hunk-header`: font-size **12.5px**, padding **3px 12px**.

Mono text (paths, branch names, diff) is Inconsolata. It looks smaller than Lato at the same size, so mono sizes in this spec run about 1px larger than the Lato text beside them.

| Role | Size / weight | Font |
|---|---|---|
| Panel title "Changes" | 17px / 700 | Lato |
| Tabs, buttons, PR title, section headers | 14px (headers 700) | Lato |
| Hints, labels, counters, badges | 12.5px | Lato |
| File name in list | 15px (active row 700) | Inconsolata |
| Folder heading / folder in diff bar | 14px / 13px, ink-faint | Inconsolata |
| File name in diff bar | 16px / 700 | Inconsolata |
| Branch / base ref | 15px | Inconsolata |
| +/− counts | 13px in rows, 14px in headers | Lato |

---

## Layout: frame 2a, top to bottom (panel width 400–1200, default 400; the mock is 505)
The panel stays a flex column, `h-full`, `bg-surface border-l border-edge`, with the resize handle unchanged.

### 1. Header, `shrink-0`, padding `10px 8px 10px 16px`, `border-b border-edge`
- An 8px status dot (`bg-success-5` when there are changes, hidden otherwise).
- "Changes" in `text-title` bold, flex-1.
- **One** refresh button. It refreshes both the diff and the PR status: `diff.refresh()` plus `refreshPr(true)`. It spins while either is loading. This replaces the refresh buttons in both DiffToolbar and PrStatusCard.
- Close button with tooltip "Close (Esc)".
- Icon buttons are 32×32, `rounded-control`, `text-ink-muted`, hover `bg-surface-raised text-ink`, with 18px icons. On touch, use the `density-icon-btn` class.

### 2. Context block, padding `12px 16px`, gap 12px, `border-b`
- **View tabs** (segmented control) replace the dropdown.
  - Track: `bg-surface-raised`, 3px padding, 8px radius, 2px gap.
  - Tabs: 32px tall, flex `1 1 auto`, 6px radius, `text-meta`.
  - Active tab: `bg-page text-ink font-bold`, shadow `0 1px 2px rgb(20 28 43 / .12)`, file count after the label in `text-micro text-ink-muted`.
  - Inactive tab: transparent, `text-ink-muted`.
  - Labels: "All task changes", "Committed", "Uncommitted".
  - "Staged" and "Unstaged" move into a 32px "…" button (`IconDots`) that opens the existing floating menu.
  - Each tab's tooltip is its `SCOPE_HINTS` text.
- **Branch / base**, branch views only (`review != null`): a 2-column grid (`auto minmax(0,1fr)`), column gap 14px, row gap 6px.
  - Row 1: label "Branch" (`text-micro text-ink-faint`), then `IconGitBranch` 16 and the branch name in 15px mono, truncated.
  - Row 2: label "Compared with", then a button: 30px tall, `border-edge`, `bg-page`, `rounded-control`, padding `0 8px 0 10px`. It holds the base ref (15px mono, nowrap) and the reason ("default branch" / "pull request base" / "branch start") in `text-micro text-ink-faint`, nowrap, plus `IconChevronDown` 14. It opens the base picker (Automatic plus candidates, as in `DiffToolbar`).
- The branch name is **not** repeated anywhere else (it was in DiffToolbar row 1 and in the PR card's `base ← head` line).

### 3. PR row, padding `10px 8px 10px 16px`, `border-b`
- Line 1:
  - `IconGitPullRequest` 17, `text-ink-muted`.
  - "#679" in `text-ink-muted`.
  - The title, flex-1, truncated, full title in the tooltip.
  - State badge: `rounded-control`, padding `1px 8px`, `text-micro`, capitalized ("Merged" / "Open" / "Draft" / "Closed"). Merged uses `bg-primary-11 text-primary-4`; keep the existing `STATE_STYLE` for the others.
  - "Open on GitHub" as a 32px icon link.
  - The separate PR refresh button is removed.
- Line 2, 25px left indent, `text-micro`: check summary ("2 checks passed" with `IconCircleCheck` 14 in `text-success-5`; failures and pending as today), then "·", then "checked just now" in `text-ink-faint`.
- Lines 3+: `localNotes()`, failing checks and `staleReason`, unchanged, in `text-micro text-warning-5` / `text-error-5`.
- Other PR states:
  - No PR: one row with `IconGitPullRequest` and "No pull request for this branch." in `text-meta text-ink-faint`.
  - Unknown: `IconAlertTriangle` and "Pull request status unknown: …" in `text-warning-5`.

### 4. File list header, padding `6px 16px 6px 10px`
- A button (flex-1) toggles the list open or closed: chevron 16, then "13 files" in `text-meta` bold. When `summary.uncommittedFiles > 0`, it adds a 6px `bg-warning-5` dot and "2 uncommitted" in `text-micro text-warning-5`.
- On the right: "+201" in `text-success-5` and "−10" in `text-error-5`, both `text-meta`.
- In discardable views, a "Discard all" text button comes last (see 3d).

### 5. Filter + grouped list, only when the list is open
- **Filter input:**
  - Margin `0 16px 8px`, 32px tall, `border-edge`, `bg-page`, `rounded-control`.
  - `IconSearch` 15 in `text-ink-faint`, placeholder "Filter files".
  - Case-insensitive substring match on the full path.
- **List:**
  - Its own scroll container. Default height **232px**; resizable from **96px to 520px**; store the height with `setPref('diffListHeight')` alongside `diffPanelWidth`.
  - Files are grouped by folder. Sort by directory; within a directory keep the server's order.
  - **Folder row:** 26px tall, padding `0 16px`, `IconFolder` 14, then the folder path with trailing slash (e.g. `server/relay/`), 14px mono, `text-ink-faint`. Not clickable.
  - **File row** (button, full width): 32px tall (`density-row` on touch), padding `0 16px 0 26px`, gap 10px.
    - 2px left border: `border-primary-6` when active, transparent otherwise.
    - Background: `bg-page` when active; hover `bg-surface-raised`.
    - Status chip: 18×18, 4px radius, 11px bold. M is `text-warning-5 bg-warning-10`, A is `text-success-5 bg-success-10`, D is `text-error-5 bg-error-10`, R is `text-accent-5 bg-accent-10`.
    - File **name only**, 15px mono, truncated; bold when active. Show "old → new" for renames.
    - A 6px `bg-warning-5` dot for uncommitted files.
    - +/− counts at 13px.
    - Tooltip: the full path, plus " (uncommitted changes)" when that applies.
- **Divider:** 9px tall, `border-t border-edge`, cursor `row-resize`, with a centered grip (36×3px, full radius, `bg-edge-strong`); hover `bg-surface-raised`. Dragging it resizes the list; set `document.body.style.cursor = 'row-resize'` while dragging, as the panel's width resize does.

### 6. Diff area, flex-1, `min-h-0`, `border-t`
- **Diff bar**, `shrink-0`, `bg-surface-raised`, `border-b`, padding `8px 8px 8px 16px`, gap 10px:
  - Status chip.
  - A column holding the folder (13px mono, `text-ink-faint`, with an "uncommitted" pill after it when that applies: `bg-warning-10 text-warning-4`, 12px, 4px radius, padding `0 6px`) and the file name (16px mono bold, truncated).
  - +/− counts.
  - Previous button (`IconChevronUp`, tooltip "Previous file (K)"), then the counter "3 / 13" (`text-micro text-ink-muted`, min-width 44px, centered), then next (`IconChevronDown`, tooltip "Next file (J)"). The arrows are at 35% opacity and do nothing at the first and last file.
  - Copy path (`IconCopy` 16). In discardable views, also a trash button (see 3d).
  - All of these are 32px icon buttons, hover `bg-edge`.
- **Diff body:** its own scroll. It shows **only the active file's** hunks (`DiffHunkView` for the active file). Replace the stacked `DiffFileCard` list; `scrollIntoView` is no longer needed. Reset the body's scroll to the top when the active file changes.
- Each hunk starts with its `@@` header row.
- Added lines start with "+ " and deleted lines with "− ", so the change is readable without color. Keep the existing light and dark color-mix backgrounds.
- Large diffs (over 300 lines), binary files and "No changes" use the existing card-body messages inside this area.

### 7. Footer
- `border-t`, padding `8px 16px`, `text-micro text-ink-faint`.
- "Click a line number to comment; shift-click to select a range." then two key caps, "J" and "K": 13px mono, padding `0 5px`, `border-edge`, 4px radius, `bg-page`, `text-ink-muted`.
- When comments exist this is replaced by the comments tray (see 3c).

---

## States (frame 2a switcher)
- **Default:** as above. The first file is active when the panel opens. Keep the active file per session; if it disappears after a refresh, fall back to index 0.
- **Uncommitted files:** as described above, uncommitted files get the dot in their row, the pill in the diff bar and the count in the list header. The PR card shows "Uncommitted local edits are not checked." (already in `localNotes`).
- **Loading** (`diff.loading` with no files yet):
  - The header refresh icon spins.
  - The file area shows skeleton rows: an 18×18 block, then a 12px-tall bar at 40–71% width, all `bg-surface-raised`, 4px radius.
  - Below them, "Reading changes…" in `text-micro text-ink-faint`.
  - Refreshing with files already on screen keeps them visible and only spins the icon.
- **Empty** (no files, no error):
  - Centered in the file area: `IconFileCode` 36 in neutral-6, a title (15.5px bold), a line of `text-meta text-ink-muted`, and a secondary button.
  - Copy depends on the view. Uncommitted: "No uncommitted changes" / "Everything on this branch is committed." / button "Show all task changes", which switches to the branch view. Other views: "No changes detected" with no button.
  - The dot in the header is hidden.
- **Error** (`diff.error`):
  - A box with 16px margin, padding `12px 12px 12px 14px`, `border-error-9 bg-error-11`, 8px radius, `role="alert"`.
  - Inside: `IconAlertCircle` 18 in `text-error-5`; the title "Couldn't load changes" (14px bold, `text-error-4`); the raw error in 14px mono, `text-error-2`, word-break; a short hint in `text-micro text-ink-muted`; and a "Retry" button (30px tall, `border-error-8 bg-error-12 text-error-4`) that calls `diff.refresh()`.
  - The hint text in the mock ("The base branch may not be fetched…") is an example; write hints per error type.
- **Truncated** (`summary.truncated`): keep the current warning strip, placed above the file list header.

## Frames 3a–3d
- **3a, 280px (desktop minimum) and any panel narrower than 420px** (use a `ResizeObserver` on the panel, not the viewport):
  - The view tabs collapse into one dropdown button: 34px tall, `border-edge bg-page`, active label bold plus count, chevron on the right.
  - Branch and base stack: the branch on its own line, then "vs" plus the base button.
  - The PR row splits into a meta line (number, badge, check count, link) and a title line.
  - The file list shows no folder icons.
  - The diff bar drops the counter and copy button.
  - The diff shows one gutter (38px) with the new line number, or the old one for deleted lines.
  - The footer hint shortens to "Click a line number to comment."
- **3b, phone** (`data-density="touch"`; the panel is a full-screen sheet):
  - Touch targets are 48px; text is one step larger (tabs dropdown 15.5px, paths 16–17px, diff 15px/1.6, single 48px gutter).
  - The pinned list is **replaced by a file switcher bar**, 56px tall on `bg-surface-raised`. It shows the chip, the file name (17px mono bold) with "1 of 13 files · +41" under it, `IconSelector`, and 48px previous/next arrows. Tapping the name opens the grouped file list as a sheet.
  - The footer hint reads "Tap a line number to comment." Leave room for the bottom safe area.
- **3c, review comments** (when `review.comments.length > 0`):
  - The file list auto-collapses to its header, which gains "· 2 with comments" (the number of files that have comments). The user can reopen it.
  - The diff bar shows `IconMessage2` with that file's comment count.
  - Inline comment cards and the composer are unchanged (`DiffHunkView`), with text raised to 14.5px.
  - The tray (`ReviewCommentsTray`) keeps its behavior and max-height of 45%, with sizes raised:
    - Header: 14px bold "2 drafts", and "· 1 changed" in `text-warning-5`.
    - "Send N to agent" is a filled primary button: `bg-primary-fill text-on-primary-fill`, 32px, bold, `IconSend`.
    - Rows: the location in 13px mono ink-faint, the body in 14px, truncated; the "code changed" pill as in the diff bar.
- **3d, discard** (only when `isDiscardableView(scope)` is true):
  - "Discard all" is a text button at the end of the file list header: `text-error-5`, `IconTrash` 16, hover `bg-error-11`.
  - Each file gets a trash icon button in the diff bar, `text-error-5`, tooltip "Discard this file's changes".
  - **Confirmation is inline**, replacing the current "click again within 3 s" pattern. A box appears under the context block, styled like the error box (`border-error-8 bg-error-11`), `role="alertdialog"`:
    - Title: "Discard all 3 files?"
    - Body: "Edits to 2 files are reverted and 1 new file, `path`, is deleted. This can't be undone." List new or untracked files by name (up to 3, then "and N more").
    - Buttons: "Cancel" (secondary) and "Discard 3 files" (`bg-error-5 text-error-12`, bold).
  - Per-file discard uses the same box, worded for one file.
  - Escape cancels the box before it closes the panel.

## Interactions & keyboard
- Clicking a file row makes it active and shows its diff; the list keeps its scroll position.
- **J / K** move to the next / previous file. Ignore them while an input or textarea has focus, including the comment composer and the filter.
- Previous/next stop at the ends; they do not wrap.
- Changing the view resets the active file to the first one. The filter text is kept.
- Esc closes the panel (existing behavior) unless a confirmation box or the composer is open.
- The only animation is the refresh icon spin, reusing the existing `animate-spin`.

## State to add (DiffPanel)
- `activeFile: string | null` (already exists): now it selects what the diff area shows, rather than scrolling to it.
- `listOpen: boolean`, default true. Set it to false automatically the first time drafts appear in a session.
- `listHeight: number`, stored in prefs.
- `filter: string`
- `confirm: null | { kind: 'all' } | { kind: 'file', path }`
- `narrow: boolean`, from a `ResizeObserver` (width under 420px).

## Token mapping (Paper hex in the mock → semantic class)
| Hex | Token |
|---|---|
| #f8faff | `page` (neutral-12) |
| #eaf0f8 | `surface` (neutral-11) |
| #dce4ef | `surface-raised` (neutral-10) |
| #c4cfde | `edge` (neutral-9) |
| #b0bed1 | `edge-strong` (neutral-8) |
| #243047 | `ink` (neutral-2) |
| #48566b | `ink-muted` (neutral-4) |
| #59677b | `ink-faint` (neutral-5) |
| #7a8799 | neutral-6 (gutter numbers, empty-state icon) |
| #477b42 / #daedd7 | success-5 / success-10 |
| #af2d24 / #94261e / #5e1b15 | error-5 / error-4 / error-2 |
| #fcece9 / #f1b2a8 / #e78679 / #fef2f1 | error-11 / error-9 / error-8 / error-12 |
| #946b29 / #7b5923 / #f9e5ca | warning-5 / warning-4 / warning-10 |
| #4976c3 | primary-6 (active row bar) |
| #38578a / #e1edff | primary-4 / primary-11 (Merged badge) |
| #82adf4 / #232f43 | `primary-fill` / `on-primary-fill` (Send button) |
| #2d4f2a | success-3 (diff insert color-mix, existing CSS) |

Radii: `rounded-control` (6px) for buttons, inputs, rows and badges; 8px for the tab track, alert boxes and the PR card in 1c; 4px for status chips, pills and key caps. There are no new shadows except the active tab's.

**Themes: not yet checked.** The mock was checked in Paper only. Check contrast in Dark, Light and High Contrast, in particular the `-10` chip backgrounds and the `-11` alert backgrounds on dark themes, where those steps flip.

## Open items (not designed)
1. **The "…" menu and the base picker.** Use the existing floating menu styles (`bg-surface-raised border-edge-strong rounded-floating shadow-floating`) with the new text sizes. In the base picker, show the reason in `text-ink-faint` beside each ref.
2. **Unusual files:** renamed files (show "old → new" in the diff bar's folder line), binary files, collapsed large diffs, and more than one PR (the existing `<select>` in the PR row, restyled at 14px).
3. **Other themes:** contrast check, as above.

## Assets
- Icons come from `@tabler/icons-react`, already a dependency: X, Refresh, GitBranch, ChevronDown/Up/Right, Dots, GitPullRequest, ExternalLink, CircleCheck, Search, Folder, Copy, Trash, AlertCircle, AlertTriangle, FileCode, MessageSquare/Message2, Send, Selector. The mock loads the Tabler webfont only for preview.
- Fonts are Lato and Inconsolata, as already loaded in `index.css`.
- There are no images.

## Screenshots (`screenshots/`, 2x, Paper theme)
- `2a-default.png`, `2a-uncommitted.png`, `2a-loading.png`, `2a-empty.png`, `2a-error.png` — chosen design, all states
- `3a-narrow-280.png`, `3b-phone-touch.png`, `3c-review-comments.png`, `3d-discard.png`, `3d-discard-confirm.png` — edge cases
- `1a-current.png` — the panel as it ships today (before)
- `1b-pinned-list-v1.png`, `1c-drill-in-rejected.png` — earlier exploration, for context only

## Files
- `Changes Panel.dc.html`: all frames. Open it directly in a browser; it needs `support.js` next to it.
- Source files this touches: `src/components/DiffPanel.tsx`, `src/components/diff/DiffToolbar.tsx` (becomes the header refresh, view tabs and branch/base grid), `PrStatusCard.tsx`, `DiffFileTree.tsx` (grouped list), `DiffFileCard.tsx` (becomes the diff bar and body for the active file), `DiffHunkView.tsx`, `ReviewCommentsTray.tsx`, and `src/index.css` (the `.changes-panel` scale and the diff overrides).
