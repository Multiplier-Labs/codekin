# Task 09 — Tone down the chrome blue (option 5b)

## Goal

Reduce how blue the app chrome reads without losing the warm-content / cool-chrome relationship.
Chosen direction: **5b — half chroma at the same hue.**

```css
/* before */  --neutral-c: 0.018;  --neutral-h: 195;
/* after  */  --neutral-c: 0.009;  --neutral-h: 195;
```

Hue is unchanged from the shipped value. Only saturation drops.

Design reference: `Codekin Palette.dc.html`, option `5b`. `Codekin Main Screen.dc.html` in this
bundle already has it applied.

## Why this is small

Sidebar and chrome text are already `chroma 0` (pure grayscale) in the shipped build, so all of the
perceived blue comes from four surface tokens. Lightness does not change, so contrast ratios are
unaffected and nothing needs re-checking for AA.

## Files

- `src/index.css` only, if task 02 (revised) has landed — then it really is a two-line edit.
- If task 02 has **not** landed, the same change has to be made to each hardcoded hex in the chrome
  scale and in the `[data-theme="light"]` scope. Prefer doing 02 first.

## Target values

Held constant across the change: lightness **and hue**. Chrome surfaces at `--neutral-c: 0.009`,
hue `195` (the shipped hue):

| token | oklch | approx hex |
|---|---|---|
| `page` | `oklch(0.155 0.009 195)` | replaces `#090e0f` |
| `surface` | `oklch(0.235 0.009 195)` | replaces `#101e21` |
| `surface-raised` | `oklch(0.300 0.009 195)` | replaces `#1a2c30` |
| `edge` | `oklch(0.355 0.009 195)` | replaces `#263a3e` |
| `edge-strong` | `oklch(0.420 0.009 195)` | replaces `#354a4e` |

## Do

1. Halve `--neutral-c` in the base `@theme` scope: `0.018 → 0.009`. **Leave `--neutral-h` at its
   shipped value of `195`** — do not round it to 200; the extra 5° of blue is visible in the
   sidebar.

2. **The selected-row tint needs the same treatment.** It currently carries roughly double the
   surface chroma by design (`#1d3236` against `#1a2c30`). Keep the *ratio*, not the absolute
   value — `oklch(0.300 0.018 195)`. If you halve the surfaces and leave this alone, the active
   session row will look conspicuously bluer than everything around it.

3. **Light mode has its own chroma and does not follow automatically.** Apply the equivalent
   reduction in the `[data-theme="light"]` scope and check it separately. The light chrome is
   already lower-chroma than dark, so the correct reduction there may be smaller than half — judge
   it against the cream content pane, not in isolation.

4. `.terminal-area` is **unchanged**. The warm content scope is the other half of the relationship
   and it stays exactly as it is. That contrast is the point; this task only lowers the volume on
   the cool side.

5. The intent families are **unchanged**: green running, amber waiting, terracotta error, gold
   accent. Do not touch `--primary-*`, `--accent-*`, `--error-*`, `--warning-*`, `--success-*`.

## Acceptance

- One value changed in the base scope, one in the selected-row tint, one in the light scope.
- No lightness value changed anywhere — contrast ratios identical to before.
- Status dots checked against the new surface. They should read *slightly stronger* than before
  (lower surface chroma makes coloured dots stand out more); if any now look garish, that is a
  finding worth reporting rather than fixing here.
- Both themes checked, plus the sidebar/transcript boundary where the warm/cool contrast lives.

## If it still feels too cool

Option `5d` in the reference (`--neutral-c: 0.004`) is the next stop and is the same one-line edit.
Do not go below `0.004` — past that the warm/cool split stops reading as a system and starts looking
accidental. Keep the hue at `195` regardless.
