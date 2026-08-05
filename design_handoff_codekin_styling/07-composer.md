# Task 07 — Composer layout (direction 1a)

## Goal

Rebuild the chat composer so it sizes itself, has one toolbar instead of four, and distinguishes
session state from actions. Direction **1a** was chosen: keep the current anatomy, fix what is
broken inside it. See `Codekin Composer.dc.html` in this bundle (option `1a`) for the visual target,
and `Codekin Main Screen.dc.html` for it in situ.

## Files

- `src/components/InputBar.tsx` (almost all of it)
- `src/components/DropZone.tsx`, `src/components/SlashAutocomplete.tsx` (anchoring only)
- `src/index.css` (remove `.app-input-bar` height-related rules if any remain)

## Do

### 1. Auto-grow, and delete the resize machinery

Replace the fixed height with content-driven height:

- min: one line of `--text-body` plus padding
- max: `40%` of the chat pane height, then the textarea scrolls internally
- implement with `field-sizing: content` where supported, plus a `rows={1}` +
  scroll-height fallback in a small `useAutoGrow` hook

Delete: the `height` state, `heightRef`, `onDragStart` and its listeners, the drag-handle `<div>`,
`INPUT_HEIGHT_KEY`, `ORCH_HEIGHT_KEY`, `DEFAULT_HEIGHT`, `MIN_HEIGHT`, `MAX_HEIGHT`,
`MOBILE_HEIGHT`, `ORCHESTRATOR_DEFAULT_HEIGHT`. Both `localStorage` keys stop being written —
no migration needed, they are pure presentation.

### 2. One toolbar, driven by config

The four branches (`!isMobile && !isOrchestrator`, `!isMobile && isOrchestrator`,
`isMobile && !isOrchestrator`, `isMobile && isOrchestrator`) collapse into a single row. Build two
arrays and render them:

```ts
const stateItems  = [permissionMode, worktree, model, usage].filter(Boolean)
const actionItems = [skills, attach, send].filter(Boolean)
```

`variant === 'orchestrator'` becomes a filter over those arrays plus an accent flag — not a second
layout. Mobile becomes: when the container is narrow, `stateItems` beyond the first collapse into
the existing overflow menu. Keep `AttachButton` / `SendButton` / `PermissionModeDropdown` /
`ModelDropdown` as they are; only their arrangement changes.

### 3. Two registers

**Left — session state.** Inconsolata at `--text-meta`, `text-ink-muted`, **no chip background,
no border**. Reads as a status run matching the transcript's tool rail. Items: permission mode,
worktree, model, usage. A dangerous permission mode (`bypassPermissions`,
`dangerouslySkipPermissions`) is the exception — it keeps a warning treatment
(`text-warning-4` with the alert glyph) and must never be the thing that collapses into overflow.

**Right — actions.** 32px hit areas (`var(--row-h)` from task 06), `rounded-control`,
`hover:bg-surface-raised`. Exactly one filled element: send.

### 4. Send becomes a real button

`height: var(--row-h)`, `padding-inline: 14px`, label **"Send"** plus a dim return glyph,
`bg-primary-4` / `text-on-primary`, `hover:bg-primary-3`. Disabled state uses a muted background
rather than `opacity-30` — a 30%-opacity primary action is hard to find. On touch density it
inherits 44px from `--row-h`, which fixes the current 34px mobile target.

### 5. Match the transcript measure

Wrap both the textarea and the toolbar in the same `max-width: 68ch` column, at the same left
offset as the transcript turns (i.e. aligned with the prose, not the 44px timestamp gutter). Today
the input spans the full pane while the text above it is measured.

### 6. Container queries instead of `lg:`

Every `hidden lg:inline` label becomes a `@container` rule on the composer. The pane's width
depends on the user-resizable sidebar, so the viewport breakpoint is measuring the wrong thing.
Any icon that loses its label must still have a `title`.

### 7. Small corrections

- Remove `border-l` from the root `div` — nothing sits to its left in either layout.
- The file input accepts images and `.md` only; change the tooltip from "Attach files" to
  "Attach images or markdown" and say so in the `DropZone` overlay too.
- Anchor `SlashAutocomplete`, the `DropZone` overlay, and the pending-file chips to the same
  measured column so they line up with the input rather than the pane.

## Don't

- Don't change send/interrupt behaviour: Enter sends, Shift+Enter newlines, Ctrl+C sends the
  interrupt byte, Escape blurs and calls `onEscape`. All of that is correct and load-bearing.
- Don't remove the dangerous-mode `window.confirm` guard.
- Don't touch `usePromptState` / draft persistence.

## Acceptance

- The composer is one line tall when empty and grows to at most 40% of the pane.
- `rg -n 'INPUT_HEIGHT_KEY|ORCH_HEIGHT_KEY|cursor-row-resize' src` returns nothing.
- One toolbar JSX block; the remaining `isMobile` references in `InputBar.tsx` are the overflow
  logic only.
- Send measures at least 32px on pointer and 44px with `data-density="touch"`.
- Skip-permissions remains visible at every container width.
- Textarea and toolbar share the transcript's left edge and 68ch width.
- Orchestrator variant still renders attach + send only, in accent.

## Deferred

Direction `1c` (collapsed to one row at rest, toolbar on focus) is a collapse rule on top of this
same toolbar, not a separate implementation. Revisit as a density preference once 1a has shipped.
