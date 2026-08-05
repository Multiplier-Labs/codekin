# Task 05 — Quiet the transcript

## Goal

The change users will actually feel. In the current build, model prose, tool-call rows, and
timestamps all render at 15px in the same reading column, so eight repetitions of
"2 tool calls — Read" compete with the sentences that matter. Machine bookkeeping should sit in a
different register from language.

## Files

- `src/components/ChatView.tsx` (primary)
- `src/lib/chatFormatters.ts`, `src/lib/deriveActivityLabel.ts` (grouping helpers)
- `src/components/OrchestratorContent.tsx` (same treatment, keeps its accent variant)
- `src/index.css` (`.prose.prose-themed` measure)

## Do

1. **Cap the measure.** Constrain the transcript's text column to `max-width: 68ch` (roughly
   66–72 characters), centred or left-aligned within the scroll area. At 1920px the column
   currently runs about 140 characters per line, which is roughly twice a comfortable measure.

2. **Timestamps into a fixed left gutter.** A `44px` fixed-width column, right-aligned,
   `text-meta` in Inconsolata at `text-ink-faint`. Rows without a timestamp render an empty
   `44px` spacer so every row shares one left edge — use a fixed pixel width, not `ch`, or the
   spacer inherits a different font and the edge goes ragged. Timestamps currently sit inline in
   the flow (`ChatView.tsx` ~line 533) and interrupt the vertical rhythm.

3. **Collapse consecutive tool-call rows into one group.** Today each assistant turn emits its own
   "▸ N tool calls — Read" line. Merge runs of adjacent tool-call rows into a single disclosure:

   ```
   ▸  6 tool calls  ·  Read, Edit, TodoWrite
   ```

   Render it as an indented rail — `border-left: 2px solid` at `border-edge`, `padding-left: 12px`
   — in Inconsolata at `text-meta`, colour `text-ink-faint`, with the tool-name list one step
   brighter at `text-ink-muted`. Deduplicate the tool names, preserve first-seen order, keep the
   total count accurate. Expanding still shows the individual calls exactly as it does now.

4. **Give the user's turns a real surface.** The current dark-mode `.user-bubble` tint
   (`primary-11` at 35% over `neutral-11`) is subtle to the point of invisibility on most
   displays. Use `bg-surface` with `border-edge` and `rounded-control`, or raise the tint until the
   turn boundary is unambiguous at arm's length.

5. **Spacing.** `18px` between turns, `1.6` line-height within a turn (from task 01's
   `--text-body`). The transcript currently uses `gap`-less `py-1.5` rows at `1.45`.

## Don't

- Don't change what information is shown, only its register. Every tool call must still be
  reachable; the collapsed group is a summary, not a filter.
- Don't touch the streaming/scroll logic in `useChatSocket.ts`. This is presentation only.
- Don't lose the existing status affordances — the thinking badge, queued marker, init banner, and
  error rows keep their intent colours.

## Acceptance

- A turn with six tool calls across three assistant messages renders **one** rail, not three rows.
- Prose and rails share a single left edge (measure both: the gutter is 44px on every row).
- No transcript line exceeds ~72 characters at 1920px.
- Tests in `ChatView.test.ts` updated; `TodoPanel.test.tsx` and `TentativeBanner.test.tsx` still pass.
- Checked in both themes and on a narrow mobile viewport.

## Visual reference

Proposal section 05 in `Codekin Styling Proposal.dc.html` — before/after of exactly this
transcript fragment, with the gutter, rail, and measure as specified. Values there:
prose `#e2e1de` at 14.5px/1.65, gutter `#555350` at 12px, rail border `#333130`,
rail text `#777571`, tool names `#93918c`.
