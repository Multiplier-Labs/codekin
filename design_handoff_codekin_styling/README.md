# Handoff: Codekin styling system

## Overview

Six scoped refactors to Codekin's visual system, derived from a review of `src/index.css`,
`src/components/LeftSidebar.tsx`, `src/components/ChatView.tsx` and the shipped screenshot
(`docs/screenshot.png`) at `Multiplier-Labs/codekin@main`.

This is **not** a new feature or a new screen. It is a refactor of an existing app's styling
layer, so the handoff is written as a set of sequenced Claude Code tasks against real file paths
rather than as screen specifications.

## About the design files

`Codekin Styling Proposal.dc.html` in this bundle is a **design reference created in HTML**. It is
a prototype showing the intended look of the before/after states — not production code to copy.
Open it in a browser and use the "proposed" columns as the visual target. Implement the changes in
Codekin's own environment: React 19 + TypeScript + Tailwind CSS v4 (`@theme` in `src/index.css`),
Vite, Vitest.

## Fidelity

**Mixed.**

- Tasks 01, 04, 05, 06 are **high-fidelity** — the proposal file carries exact hex values, pixel
  sizes, line-heights and gutter widths. Match them.
- Tasks 02 and 03 are **structural** — the proposal shows the intended token architecture and a
  worked oklch example, but the exact per-step lightness values must be derived from Codekin's
  current hex scales, not copied from the mock.

## How to run this

Work one task at a time, in this order. Each task file is written to be pasted into Claude Code
as a prompt more or less verbatim.

| # | Task | Scope | Visual change |
|---|---|---|---|
| 01 | `01-type-scale.md` | `src/index.css` + all of `src/components` | yes |
| 05 | `05-transcript.md` | `src/components/ChatView.tsx` | yes, large |
| 04 | `04-surfaces.md` | `src/index.css` + panel containers | yes |
| 03 | `03-semantic-tokens.md` | all of `src/components`, `eslint.config.js` | no |
| 02 | `02-derive-scopes.md` | `src/index.css` only | no (must be pixel-neutral) |
| 06 | `06-density.md` | `src/App.tsx`, `src/index.css`, components with `isMobile` ternaries | slight |

Tasks 01 → 05 → 04 land the user-visible improvements first. 03 → 02 → 06 are the plumbing that
stops the drift returning; they are the largest diffs and the least visible, so they should not
block the first three.

## Guardrails for every task

- Codekin has a `CLAUDE.md` at the repo root. **Task 03 asks you to extend it** so future sessions
  inherit the token rules. Read it before starting anything.
- The app has two theme polarities (`[data-theme="dark"]`, `[data-theme="light"]`) and a scoped
  palette override (`.terminal-area`). **Check both themes after every task.** Most of the existing
  one-off patches in `index.css` exist because a change was verified in dark mode only.
- `pnpm test` and `pnpm lint` must pass. Several components have snapshot-ish tests
  (`TodoPanel.test.tsx`, `WorkflowBadges.test.tsx`, `TentativeBanner.test.tsx`) that assert on
  class names — expect to update them.
- Do not introduce a CSS-in-JS library, a component library, or a new dependency. Everything here
  is achievable with Tailwind v4 `@theme` plus custom properties.
- Do not reformat files you are not otherwise touching. `.prettierrc` is authoritative.

## Verification loop

After each task:

```bash
pnpm lint && pnpm test
pnpm dev        # then toggle dark/light and check the transcript, sidebar, and diff panel
```

Useful greps for measuring progress:

```bash
# should trend to 0 after task 01
rg -o 'text-\[[0-9.]+px\]' src/components | wc -l

# should be 0 after task 03
rg -n 'text-(purple|red|blue|green|gray|slate|zinc)-[0-9]{3}|text-white|bg-white' src/components

# should be 0 after task 06
rg -n 'isMobile \?' src/components
```

## Design tokens

The proposal's target values are listed in each task file. Two global notes:

- **Fonts stay as they are** — Lato for UI, Inconsolata for code and metadata. No font swap is
  proposed. The type problem is scale discipline, not typeface choice.
- **Palette hues stay as they are.** The warm-content / cool-chrome split is a deliberate idea and
  the tasks preserve it; task 02 only changes how it is expressed.

## Assets

No new assets. `docs/screenshot.png` in the repo is the "before" reference.

## Files in this bundle

- `README.md` — this file
- `01-type-scale.md` … `06-density.md` — one Claude Code task each
- `Codekin Styling Proposal.dc.html` — the visual reference (open in a browser)
