# Task 02 — Rationalise the theme scopes (revised)

> **Revised after measurement.** The original version of this task asked for a single shared
> perceptual lightness ramp and claimed the result would be pixel-neutral. That was wrong, and the
> implementer was right to stop. Measured findings:
>
> - Per-step lightness spread across the seven families reaches **0.21** in OKLCH.
> - Rebuilding the hexes from a median ramp gives worst-case **ΔE ≈ 11**, roughly five times the
>   visible-difference threshold.
> - The four `/* darkened for AA on cream */` overrides currently measure **4.74–5.52:1**. Two fall
>   **below 4.5:1** if deleted without a replacement.
>
> A shared ramp cannot satisfy "no visual change". The families are individually tuned, and that
> tuning is real. This revision keeps the goal — stop re-typing the same palette five times — and
> drops the false premise.

## Goal

`src/index.css` declares 84 colour tokens and then re-declares them for `.terminal-area`,
`[data-theme="light"]`, `[data-theme="light"] .terminal-area`, and the sidebar scope. The
duplication is the problem. Uniform lightness is not the solution.

Do this as **per-family ramps**: each family keeps its own measured lightness curve, and the scopes
become transforms of it. Result is the same rendered pixels with roughly a quarter of the
declarations.

## Files

- `src/index.css` only.

## Do

1. **Per-family ramps, from measurement not invention.** Convert each family's existing dark-mode
   hex scale to OKLCH and write its own 12-step lightness list. Do not median across families —
   that is what the measurement rules out.

   ```css
   @theme {
     /* each family keeps its own curve; chroma and hue are per-family constants */
     --neutral-l: 0.92 0.86 0.82 0.72 0.62 0.52 0.42 0.34 0.27 0.21 0.15 0.09;
     --neutral-c: 0.014;  --neutral-h: 195;
     /* …primary, secondary, accent, error, warning, success likewise */
   }
   ```

   Practical note: CSS custom properties cannot be indexed, so express each step explicitly
   (`--color-neutral-5: oklch(0.62 var(--neutral-c) var(--neutral-h));`). The saving comes from the
   scopes in step 2, not from the base scale.

2. **Scopes as transforms.** This is where the ~300 lines go. `.terminal-area` is documented as
   "desaturated ~40%, shifted warm" — verify that against the measured values and, where it holds,
   express it as a chroma/hue change only:

   ```css
   .terminal-area { --neutral-c: 0.006; --neutral-h: 70; }
   ```

   Where it does **not** hold within ΔE 2, keep an explicit override for that step and leave a
   comment saying it is a measured exception. A handful of documented exceptions is a good outcome;
   84 undocumented ones is what we are replacing.

3. **Light mode keeps its own ramp.** Do not derive it by flipping lightness — measure the existing
   light scales and give them their own per-family curves. Same structure, different numbers.

4. **Keep the four AA overrides.** They are load-bearing. Two of them are the only thing holding
   `primary-5` and `accent-5` above 4.5:1 on cream. Change the comment from
   `/* darkened for AA */` to name the measured ratio, so nobody deletes them again:

   ```css
   /* 4.74:1 on --color-page; do not lighten */
   ```

5. **`#11181a` still goes.** That one is not a colour-system problem — task 04 replaces it with a
   real surface level. Delete it there, not here.

## Don't

- Don't unify lightness across families.
- Don't claim pixel-neutrality for anything you have not measured. Every step you rewrite should be
  checked at ΔE ≤ 2 against the pre-refactor value.

## Acceptance

- Declaration count in `src/index.css` drops substantially (target ~40%, not ~75% — the original
  estimate assumed a shared ramp).
- Every rewritten step measures ΔE ≤ 2 against the pre-refactor render, in all four scopes.
- All four AA-critical tokens still measure ≥ 4.5:1 on their background, with the ratio in a comment.
- Any surviving per-step override carries a comment saying why it is an exception.

## If you would rather repaint

The alternative is a **deliberate repaint**: adopt one shared ramp, accept ΔE ≈ 11 in places, and
re-tune the four AA cases against the new values. That is a visual-design decision, not a refactor,
and it should be reviewed as a new palette rather than merged as cleanup. Flag it and we will look
at it as its own piece of work. Default to the per-family version above.
