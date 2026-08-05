# Task 08 — Sidebar rows and the repo drawer

## Goal

Two changes that go together: make sidebar rows composable and discoverable, and give the three
repo-scoped list collections one home outside the tree.

Design reference: `Codekin Sidebar.dc.html` — turn 1 option **1a**, turn 2 option **2c**, turn 3
options **3a** + **3c**, expanded in turn 4.

## Non-goal — read this first

**Changes / the diff view stays out of the drawer, permanently.** `DiffPanel` keeps its own panel,
its own header, its own view toggle and its own resize handle. Side-by-side is unusable at drawer
width, and unified still wraps. Do not add a Changes tab to the drawer, now or later; diff
improvements are separate work with more room, not a tab.

The drawer and the diff are independent surfaces: separate open state, separate width. The drawer
never takes the diff below its minimum width — past that the drawer overlays as a level-2 panel.

## Files

- `src/components/LeftSidebar.tsx`, `src/components/RepoSection.tsx`
- `src/components/NewSessionButton.tsx` + `NewSessionMenu` (merge)
- `src/components/DocsFilePicker.tsx`, `src/components/ArchivedSessionsPanel.tsx` (become renderers)
- new `src/components/RepoDrawer.tsx`
- `src/components/CommandPalette.tsx`, `src/components/Settings.tsx`
- `src/components/DiffPanel.tsx` — **untouched**

## Do

### A. Rows (1a)

1. Every hover-revealed control collapses into **one persistent `⋯` overflow button per row**.
   Rename, move-to-worktree, archive and delete live inside it; delete is separated by a rule and
   uses the error colour, and keeps its confirm. Real `<button>` elements — the tree becomes
   keyboard navigable.
2. **Fixes a bug:** docs, approvals, archive and delete-repo currently use plain `group-hover` with
   no mobile branch, so they are unreachable on touch. The overflow menu removes that class of bug
   entirely.
3. **Three status meanings only:** filled dot = running, hollow ring = idle, amber = waiting for
   you. Only amber pulses. Drop `dotColor.replace('bg-','text-')` and pass a status token instead;
   origin (workflow / webhook / agent) becomes a separate leading glyph so it stops competing with
   state.
4. **One labelled "New" button in the header, replacing the bare `+` icon.** It serves both flows:
   pick repo, then provider, in one menu. The current header `+` (`NewSessionButton`) and the
   hover-revealed "New session" inside each repo (`NewSessionMenu`) are **both** removed — today
   they have different labels, different menus, and two separate hand-rolled viewport-flip
   positioners. One button, one menu, one positioner.

   Visual target: the `+ New` pill in the 2c mock header — 26px tall, `bg-surface-raised`,
   `rounded-control`, glyph plus the word "New". A bare icon is not the design.

### B. Structure (2c)

5. Repos stop being rows. Each becomes the **uppercase micro section label** the sidebar already
   uses for "Active sessions", with its sessions flush beneath — one depth level, no chevrons.
   The label carries the repo's worst child status as a dot, a count when collapsed, and its own
   `⋯`. Clicking the label collapses; it needs a clear hover state since the chevron is gone.
6. Session names gain ~30px of width, which is what matters at the 160px minimum sidebar width.

### C. The drawer (3a)

7. New `RepoDrawer` owns the header (repo name + tab strip), an optional filter row, and **one**
   scroll region. Three tabs: **Docs**, **Archive**, **Approvals**. `DocsFilePicker` and
   `ArchivedSessionsPanel` become content renderers with their own chrome deleted. Nothing expands
   inside the sidebar tree any more.
8. Tab state is per-repo and remembered. The sidebar's `⋯` items deep-link to a tab.
9. Below ~380px the tab labels drop to icons with tooltips, on `@container` width — the panel is
   user-resizable, so a viewport breakpoint is wrong.
10. **Docs:** emphasise the filename, demote the directory to monospace beside it. Starred, then
    pinned root files (`CLAUDE.md`, `README.md`), then folder groups. Drop the `.md` extension in
    grouped rows — every entry has it.
11. **Archive:** two lines per row (title; then age, turn count, worktree, diff stat).
    **"Continue in new session" moves onto the row** — it is why anyone opens an archived session
    and it is currently buried in the fullscreen viewer's header. Delete moves into the row menu.
12. **Approvals:** group by tool with a count and a revoke-all per group, so 14 patterns read as 4
    decisions. The **permission mode selector sits at the top of the tab** — "what am I
    auto-approving" and "what have I already approved" are one question asked twice.
13. **Empty states:** say what the collection is and how it fills. Copy in turn 4 option `4f`.

### D. Palette (3c)

14. Add **Docs** and **Archived sessions** as two more `Command.Group` blocks in
    `CommandPalette.tsx`, scoped to the active repo first. Cheapest item in this task by a wide
    margin — do it even if the drawer slips.

### E. Settings (4e)

15. Two settings are app-wide but currently authored per-repo. Move both to `Settings.tsx`:
    - **archive retention** ("Keep *n* d" — calls the app-wide `setRetentionDays` from a per-repo
      header today)
    - **default permission mode** for new sessions
    Add a warning row when repos are set to skip permissions, and a global count of approved
    patterns with a revoke-all.

## Acceptance

- The sidebar header shows a **labelled `+ New` button**, not a bare `+` icon. `NewSessionMenu` and
  the per-repo "New session" affordance no longer exist; `rg -n 'NewSessionMenu' src` returns
  nothing.
- No sidebar control is reachable only on hover. Every row action is behind a persistent `⋯`.
- Full keyboard traversal of the tree; no `<span onClick>` remains in either file.
- Exactly three session status treatments; exactly one of them animates.
- Approvals, archive and docs no longer render inside the sidebar's scroll container.
- `DiffPanel.tsx` has no diff in this task.
- Both themes checked; `pnpm lint && pnpm test` pass.
