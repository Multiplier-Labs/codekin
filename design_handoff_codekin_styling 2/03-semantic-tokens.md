# Task 03 — Make the semantic tokens the only public API

## Goal

`src/index.css` already defines a semantic layer (`--color-page`, `--color-surface`,
`--color-surface-raised`, `--color-edge`, `--color-edge-strong`, `--color-ink`, `--color-ink-muted`,
`--color-ink-faint`, `--color-on-primary`) with a comment saying to prefer it. Only
`text-on-primary` is ever used. Components reach past it into raw scale steps, so `neutral-5` is
simultaneously muted text, an icon colour, and a border — and no adjustment can be made without
collateral damage.

## Files

- all of `src/components`
- `src/index.css` (two additions)
- `eslint.config.js`
- `CLAUDE.md`

## Do

1. Add the two aliases that are currently improvised:

   ```css
   --color-ink-inverse: var(--color-neutral-12);  /* replaces text-white */
   --color-focus: var(--color-accent-6);          /* focus rings, currently ad-hoc */
   ```

2. Migrate components with this mapping:

   | raw | semantic |
   |---|---|
   | `bg-neutral-12` | `bg-page` |
   | `bg-neutral-11` | `bg-surface` |
   | `bg-neutral-10`, `hover:bg-neutral-6/50`, `hover:bg-neutral-6` | `bg-surface-raised` / `hover:bg-surface-raised` |
   | `border-neutral-9`, `border-neutral-8/30`, `border-neutral-8/40`, `border-neutral-10` | `border-edge` |
   | `border-neutral-7` (emphasised inputs/buttons) | `border-edge-strong` |
   | `text-neutral-1`, `text-neutral-2`, `text-neutral-3` | `text-ink` |
   | `text-neutral-4`, `text-neutral-5` | `text-ink-muted` |
   | `text-neutral-6` | `text-ink-faint` |
   | `text-white` | `text-ink-inverse` |
   | `focus:border-accent-6` | `focus:border-focus` |

   Where a file distinguishes `neutral-2` from `neutral-3` meaningfully (primary vs secondary text
   in the same row), keep the distinction by using `text-ink` and `text-ink-muted` respectively
   rather than inventing a fourth ink step.

3. Delete the off-system colours entirely — these are Tailwind defaults, not Codekin tokens:
   - `text-purple-400` → `text-secondary-4` (`AddWorkflowModal.tsx` ~line 279, `EditWorkflowModal.tsx` ~line 141)
   - `text-red-400` → `text-error-4` (`FolderPicker.tsx` ~line 138)
   - `text-white` → `text-ink-inverse` (`FolderPicker.tsx` ~line 199 and elsewhere)

4. Add an ESLint rule to `eslint.config.js` that fails on raw scale steps and Tailwind's default
   palette inside `src/components`. `no-restricted-syntax` on JSX string literals matching
   `/\b(bg|text|border)-neutral-\d/` and `/\b(text|bg|border)-(purple|red|blue|green|gray|slate|zinc)-\d{3}/`
   is enough. Allow the semantic names and the intent families (`primary`, `accent`, `error`,
   `warning`, `success`), which are meaningful and should stay.

5. Append a short "Styling rules" section to the repo's `CLAUDE.md`: semantic tokens only, five
   type steps, three surfaces, density via `--row-h`. Future Claude Code sessions will then comply
   by default instead of regressing this work.

## Don't

- Don't rename or remove the raw scale — `index.css` still needs it, and the intent families are
  legitimately used directly for status colour.

## Acceptance

- `rg -n '(bg|text|border)-neutral-[0-9]' src/components` returns nothing.
- `rg -n 'purple-|red-4|text-white' src/components` returns nothing.
- `pnpm lint` fails on a deliberately reintroduced `text-neutral-5`.
- Zero visual change.
