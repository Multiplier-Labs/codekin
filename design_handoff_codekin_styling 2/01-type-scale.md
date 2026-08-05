# Task 01 — Collapse the type scale to five named steps

## Goal

Replace the 405 hardcoded `text-[Npx]` classes in `src/components` with five named type steps.
Eight distinct sizes (11, 12, 13, 14, 15, 17, 18, 19px) are currently in use with no rule behind
the choice; 13/14/15 are not distinguishable in context but are three separate decisions.

## Files

- `src/index.css` — add the steps to `@theme`
- every file under `src/components` (and `src/components/diff`, `src/components/workflows`)

## Do

1. Add to `@theme` in `src/index.css`:

   ```css
   --text-micro: 11px;      --text-micro--line-height: 1.4;
   --text-meta: 12.5px;     --text-meta--line-height: 1.45;
   --text-body: 14.5px;     --text-body--line-height: 1.6;
   --text-title: 17px;      --text-title--line-height: 1.35;
   --text-head: 22px;       --text-head--line-height: 1.25;
   ```

   Tailwind v4 generates `text-micro`, `text-meta`, `text-body`, `text-title`, `text-head` with the
   line-height bound in, which is the point — a label cannot be authored half-right.

2. Migrate every call site using this mapping:

   | current | becomes | notes |
   |---|---|---|
   | `text-[11px]` | `text-micro` | section labels, uppercase badges, hints |
   | `text-[12px]` | `text-meta` | metadata, counts, request IDs, timestamps |
   | `text-[13px]` | `text-meta` **or** `text-body` | see step 3 |
   | `text-[14px]` | `text-body` | |
   | `text-[15px]` | `text-body` | |
   | `text-[16px]` | `text-body` | the mobile textarea in `InputBar.tsx` line ~575 must stay ≥16px to stop iOS zoom-on-focus — keep an explicit `text-[16px]` there and leave a comment saying why |
   | `text-[17px]` | `text-title` | |
   | `text-[18px]`, `text-[19px]` | `text-head` | |

3. `text-[13px]` is the ambiguous one and appears ~150 times. Rule: if the text is a **sentence,
   label, or interactive row the user reads**, it becomes `text-body`. If it is **supporting
   metadata beside something else** (counts, ages, paths, verdicts, `turn N`), it becomes
   `text-meta`. When in doubt use `text-body` — the app currently errs too small.

4. Remove any `leading-*` class that the new step already supplies, unless it was deliberately
   overriding (e.g. `leading-snug` on the composer textarea).

## Don't

- Don't add a sixth step "just for this one place". If something genuinely does not fit, raise it
  rather than reintroducing an arbitrary pixel value.
- Don't change font families or weights in this task.

## Acceptance

- `rg -o 'text-\[[0-9.]+px\]' src/components` returns only the documented iOS-zoom exception.
- Transcript prose renders at 14.5px / 1.6 line-height in both themes.
- `pnpm lint && pnpm test` pass (expect class-name assertions in component tests to need updating).
