# Task 06 — Density as one token, not a ternary per element

## Goal

Touch sizing is currently decided element by element inside JSX:
`isMobile ? 'px-2 py-2' : 'px-1.5 py-1'`, `size={isMobile ? 24 : 20}`, and similar, scattered
across `LeftSidebar.tsx`, `RepoSection.tsx`, `InputBar.tsx` and others. Desktop rows land near
26px, which is fine for a pointer; several mobile branches still fall short of a 44px target, and
the ones that hit it do so by accident.

## Files

- `src/App.tsx` (set the density scope)
- `src/index.css` (define the tokens)
- `src/hooks/useIsMobile.ts` (already returns what is needed)
- every component containing `isMobile ?` in a className or an icon `size`

## Do

1. Define the tokens:

   ```css
   :root            { --row-h: 28px; --row-pad: 10px; --icon-size: 20px; --tap-min: 28px; }
   [data-density="touch"] { --row-h: 44px; --row-pad: 12px; --icon-size: 24px; --tap-min: 44px; }
   ```

2. Set `data-density="touch"` once on the app shell in `App.tsx` from `useIsMobile()`. Prefer a
   `@media (pointer: coarse)` fallback in CSS as well, so a touch laptop gets sane targets without
   the JS breakpoint agreeing.

3. Rewrite rows to read the variables — `height: var(--row-h)`, `padding-inline: var(--row-pad)`,
   icons at `var(--icon-size)` — and delete the ternaries. Sidebar nav rows, repo/session tree
   rows, the bottom toolbar buttons, the composer's toolbar chips, and the model/permission menus
   are the main clusters.

4. Any interactive element that must remain visually small (a status dot, a close X) gets a
   transparent hit area of `var(--tap-min)` rather than a bigger visual footprint.

5. Row text follows the same knob: `text-body` throughout, and let the row height do the density
   work. Do not shrink type to fit.

## Acceptance

- `rg -n 'isMobile \?' src/components` returns nothing for sizing or spacing (routing/behaviour
  branches like `if (isMobile) onMobileClose?.()` stay).
- Every interactive element measures ≥44px in at least one axis with `data-density="touch"`.
- Desktop layout is unchanged from before the task.

## Visual reference

Proposal section 06 in `Codekin Styling Proposal.dc.html` — the same sidebar rows at 28px and 44px.
