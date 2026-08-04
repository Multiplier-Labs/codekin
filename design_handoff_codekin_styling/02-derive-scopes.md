# Task 02 — Derive the theme scopes instead of re-typing them

## Goal

`src/index.css` declares 84 colour tokens (7 families × 12 steps) and then re-declares them for
`.terminal-area`, `[data-theme="light"]`, `[data-theme="light"] .terminal-area`, and the sidebar
scope — roughly 400 hand-tuned hex values describing what the source comments already state as a
formula ("desaturated ~40% from base teal, shifted warm, text lightened 10%").

Express the formula. This is a **pixel-neutral refactor**: the rendered result should be
indistinguishable from today, or provably closer to the stated intent.

## Files

- `src/index.css` only.

## Do

1. Pick one perceptual lightness ramp shared by all families and both polarities:

   ```css
   @theme {
     --l-1: 0.92; --l-2: 0.86; --l-3: 0.82; --l-4: 0.72;
     --l-5: 0.62; --l-6: 0.52; --l-7: 0.42; --l-8: 0.34;
     --l-9: 0.27; --l-10: 0.21; --l-11: 0.15; --l-12: 0.09;
   }
   ```

   Derive the actual numbers by converting the existing dark-mode hex scales to oklch and taking
   the median lightness per step across families. Do not invent them — the current scales are
   tuned and the point is to preserve their appearance.

2. Give each family one chroma + hue pair, and build the steps from the ramp:

   ```css
   --neutral-c: 0.014;  --neutral-h: 195;   /* chrome: teal-tinted */
   --color-neutral-5: oklch(var(--l-5) var(--neutral-c) var(--neutral-h));
   /* …one line per step, per family */
   ```

3. Replace the four scope overrides with knob changes:

   ```css
   .terminal-area            { --neutral-c: 0.006; --neutral-h: 70; }   /* warm, desaturated */
   [data-theme="light"]      { /* flip the ramp only */ --l-1: 0.09; … --l-12: 0.98; }
   ```

   The sidebar's pure-grayscale text override becomes `--neutral-c: 0` on
   `.app-left-sidebar, .app-right-sidebar`.

4. Delete the patches this makes unnecessary:
   - the hardcoded `background-color: #11181a` on
     `[data-theme="dark"] .app-left-sidebar, .app-right-sidebar` — task 04 owns that seam properly
   - the four `/* darkened for AA on cream */` one-offs in `[data-theme="light"] .terminal-area`
     (`--color-primary-5`, `--color-accent-5`, `--color-accent-6`, `--color-success-5`). Perceptual
     lightness makes these unnecessary; **verify with a contrast check rather than assuming.**

## Don't

- Don't change any hue relationship. Gold stays gold, terracotta stays terracotta, the
  chrome/content temperature split stays.
- Don't ship this without checking both themes and the `.terminal-area` scope side by side against
  a before screenshot. If a step drifts visibly, adjust the ramp — not by adding an override back.

## Acceptance

- `rg -c '^\s*--color-' src/index.css` drops by roughly 300 lines.
- No `#rrggbb` literals remain in `src/index.css` outside the `hljs` syntax-token block (that block
  is a legitimate separate concern — leave it, or convert it in a follow-up).
- Dark, light, and terminal-area scopes visually match the pre-refactor build.
- Muted text in `[data-theme="light"] .terminal-area` still meets 4.5:1 on the cream background.
