# Task 04 — Three surfaces instead of a field of hairlines

## Goal

The sidebar, transcript, and diff panel are all near-black separated by 1px `border-neutral-8/30`
lines. The `background-color: #11181a` override in `index.css` is a symptom — the layout needed
elevation and only had borders, so a hex was hardcoded to force a seam. Define three levels and
let background carry the structure.

## Files

- `src/index.css`
- container elements in `LeftSidebar.tsx`, `DiffPanel.tsx`, `ChatView.tsx`, `CommandPalette.tsx`,
  `ConnectionPopup.tsx`, `TodoPanel.tsx`, `Settings.tsx`, `AddWorkflowModal.tsx`,
  `EditWorkflowModal.tsx`, `ArchivedSessionsPanel.tsx`

## Do

1. Define the levels in `@theme`:

   ```css
   --shadow-floating: 0 12px 28px -8px rgb(0 0 0 / 0.7);
   --radius-control: 6px;
   --radius-floating: 10px;
   ```

   The background/border pairs already exist as semantic tokens from task 03:

   | level | use | background | border | shadow |
   |---|---|---|---|---|
   | 0 — page | transcript ground | `bg-page` | none | none |
   | 1 — surface | sidebar, diff panel, code blocks, cards | `bg-surface` | `border-edge` (full strength, no alpha) | none |
   | 2 — floating | command palette, popovers, modals, tasks card | `bg-surface-raised` | `border-edge-strong` | `shadow-floating` |

2. Apply them. The sidebar and the right-hand diff panel move to level 1, which is what
   `#11181a` was faking — **delete that override**. The transcript stays level 0. Everything that
   floats over content gets level 2 and is the **only** thing with a shadow.

3. Drop the alpha suffixes on borders. `/30`, `/40`, `/50` appear on the same conceptual line with
   no rule; a full-strength `border-edge` at the correct step reads better and is one decision.

4. Normalise radius: `rounded-control` (6px) on buttons, inputs, rows, badges;
   `rounded-floating` (10px) on modals, popovers, palette; `rounded-full` only on status dots and
   avatars. Today `rounded`, `rounded-md` and `rounded-lg` are used interchangeably on the same
   class of element.

## Acceptance

- No hardcoded hex remains in `index.css` for component backgrounds.
- The sidebar / transcript / diff-panel boundaries are legible in dark mode with the borders
  temporarily removed — i.e. background alone carries the structure.
- Exactly one shadow token in use, only on floating elements.
- Both themes checked.

## Visual reference

Proposal section 04 in `Codekin Styling Proposal.dc.html` — three swatch cards showing the levels
at `#090e0f` / `#101e21` / `#1a2c30` with matching edges.
