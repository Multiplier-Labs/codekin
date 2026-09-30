# Theme Selector

**Status**: Implemented
**Goal**: Replace the binary dark/light toggle with a theme selector offering nine
pre-defined color themes. Today's Dark and Light modes become themes 1 and 2, unchanged.
Themes change **color only** — fonts, the type scale, radii, shadow geometry and
density are shared by every theme.

---

## 1. Problem

Codekin's appearance setting was a two-state switch (`Settings.theme: 'dark' | 'light'`).
Users who spend all day in the transcript want a choice: a cooler palette, a softer
low-glare reading theme, a high-contrast option for accessibility and bright rooms, and
the editor palettes they already know (Solarized, Dracula, Gruvbox).

The visual system is already token-driven, which makes this mostly a data problem rather
than a component problem:

- Components never use raw hex values. They use semantic tokens (`bg-page`, `text-ink`,
  `border-edge`, …) and the six intent families (`primary-N`, `secondary-N`, `accent-N`,
  `error-N`, `warning-N`, `success-N`), enforced by the ESLint guard in `eslint.config.js`.
- Every color resolves through CSS custom properties defined in `src/index.css`.

But the two modes were wired as a *polarity*, not as *themes*:

- `[data-theme="light"]` / `[data-theme="dark"]` selectors mixed two concerns: palette
  values (ramps, syntax colors) and polarity-dependent component tweaks (sidebar
  backgrounds, card contrast, diff tints, `color-scheme`).
- Some Dark palette rules were unconditional (`.terminal-area { … }`,
  `.app-left-sidebar { … }`) and so would have leaked into any new theme.
- `useSettings.load()` collapsed any stored value other than `'light'` to `'dark'`.
- The sidebar button toggled `dark ↔ light`.
- `index.html` hardcoded the dark `theme-color`, and light users got a dark flash on load
  because `data-theme` was only set in a React effect after the first render.

---

## 2. Non-Goals

- **No font, type-scale, spacing, radius or density changes per theme.** Inconsolata /
  Lato, the five type steps, `rounded-control` / `rounded-floating` and the density
  tokens are theme-independent. A theme is a set of color values, nothing else.
- No user-authored or imported themes, no per-token color pickers.
- No per-session or per-repo themes. The theme is app-wide.
- ~~No server-side persistence or cross-device sync.~~ Superseded: the theme now lives
  in the server-side prefs store (`/api/settings/prefs`), so it follows the user across
  browsers and devices. In hosted mode it is stored per machine.
- No "follow OS" mode in v1 (§10).

---

## 3. The Themes

Each theme declares a **scheme** (`dark` or `light`) that drives native UI
(`color-scheme`) and the polarity-dependent component rules (§5.1).

| # | id | Label | Scheme | Character |
|---|----|-------|--------|-----------|
| 1 | `dark` | Dark | dark | **Existing** dark mode, pixel-identical. Teal-tinted chrome, warm-gray transcript, gold primary, teal accent. |
| 2 | `light` | Light | light | **Existing** light mode, pixel-identical. Cream transcript, warm-gray chrome. |
| 3 | `midnight` | Midnight | dark | Cool blue-slate (Nord-adjacent). Frost-blue accent, soft gold primary. For users who find the warm transcript too brown. |
| 4 | `paper` | Paper | light | Cool cotton-white page (`#f8faff`), blue-gray surfaces, blue ink primary and a red editorial accent. |
| 5 | `contrast` | High Contrast | dark | Black ground, near-white ink, electric cyan primary, yellow accent, strong borders. Meets the stricter floors in §6. |
| 6 | `solarized` | Solarized Light | light | Solarized base3/base2 cream grounds, base02 ink, blue primary and teal accent. |
| 7 | `dracula` | Dracula | dark | Plum-tinted grounds with Dracula token colors; purple primary, pink secondary, cyan accent. |
| 8 | `gruvbox` | Gruvbox | dark | Warm brown grounds, cream ink; burnt-orange primary, sage accent and Gruvbox token colors. |
| 9 | `matrix` | Matrix | dark | Soft phosphor terminal: charcoal-green grounds, gray-green text and muted mint actions and syntax. Error stays dusty red and warning amber so status still reads. |

Solarized ships as the light variant: the dark side is already well covered (six dark
themes), and Solarized Light pairs warm cream grounds and teal accents, while Paper uses cool
blue-white grounds and red accents.

Themes 3–9 use **one palette throughout**. Dark and Light keep their distinct, warmer
`.terminal-area` palette; the new themes do not define one.

**Fidelity vs. contrast.** Where a canonical palette color fails a contrast floor, the
generator (§5.3) moves it along OKLCH lightness — keeping hue and chroma — until it
passes. This mainly affects Solarized Light, whose canonical accents (`#268bd2`,
`#2aa198`, `#859900`, …) sit at ~3:1 on its own cream. They come out noticeably deeper
than the upstream palette.

---

## 4. What a Theme Defines

Components use raw intent steps (`bg-primary-8`, `text-accent-5`, … — ~166 uses in
`src/components`), so a theme cannot only set the semantic tokens; it must supply full
ramps. Per theme:

1. **Seven 12-step ramps** — `neutral`, `primary`, `secondary`, `accent`, `error`,
   `warning`, `success`. Step 1 is the strongest ink and step 12 the page, in both
   schemes (the Light convention: its scales are inverted relative to Dark's hues).
2. **Syntax-highlight tokens** (`--syntax-*`, §5.4).

Everything else comes from the scheme or the shared layer:

- The semantic layer (`--color-page` → `neutral-12`, `--color-ink` → `neutral-2`, …) is
  shared and never redefined per theme.
- `--color-on-primary`, `--color-primary-fill`, `--color-on-primary-fill` differ by
  scheme and live on `[data-scheme="light"]`.
- Prose colors, diff tints, sidebar/card backgrounds and `color-scheme` are scheme rules
  expressed through ramp steps, so every theme inherits them.

---

## 5. Architecture

### 5.1 Two attributes: `data-theme` and `data-scheme`

- `<html data-theme="<id>">` selects the **palette**.
- `<html data-scheme="dark|light">` selects **polarity**, from the theme's registry entry.

Rules that depend on polarity moved from `[data-theme="light"]` to `[data-scheme="light"]`
(and `dark` likewise): `color-scheme`, the on-primary mappings, logo circle, sidebar
background, session-tab hover, settings/workflow card contrast, orchestrator composer
edge, prose tokens, `.hljs` background, diff tints. Rules that set palette values stay on
`data-theme`. The previously unconditional Dark rules — the warm `.terminal-area`
palette and the grayscale sidebar text — are now scoped to `[data-theme="dark"]` (the
terminal palette also to `light`, which inherits its non-neutral ramps as before).

### 5.2 Files

```
index.html                    # data-theme="dark" data-scheme="dark" defaults; loads theme-init.js
public/theme-init.js          # pre-paint: applies the saved theme before first render
scripts/generate-themes.mjs   # theme sources + generator → src/themes/palettes.css
src/index.css                 # Dark (@theme) and Light palettes, scheme rules, hljs rules
src/themes/
  palettes.css                # GENERATED: themes 3–9 (ramps + syntax tokens)
  registry.ts                 # THEMES, ThemeId, isThemeId, getTheme, applyTheme
  color.ts                    # OKLCH conversion, gamut mapping, WCAG contrast
  cssVars.ts                  # reads flat custom-property blocks (generator + tests)
  themes.test.ts              # registry/CSS drift, completeness, contrast floors
src/components/
  ThemeSwatch.tsx             # mini preview painted from registry swatches
  ThemeMenu.tsx               # sidebar palette button + popover
```

Dark and Light stay hand-tuned in `src/index.css` — moving them bought nothing and would
have risked the pixel-neutral guarantee. `palettes.css` is imported from `index.css`
right after Tailwind. Its selectors are theme-specific and unlayered, so they override
the `@theme` defaults (which Tailwind emits in a cascade layer) whatever the source order.

```ts
// src/themes/registry.ts
export const THEME_IDS = ['dark', 'light', 'midnight', 'paper', 'contrast', 'solarized', 'dracula', 'gruvbox'] as const
export type ThemeId = typeof THEME_IDS[number]

export interface ThemeDefinition {
  id: ThemeId
  label: string
  scheme: 'dark' | 'light'
  /** page (neutral-12, also the browser theme-color), surface, ink, primary-5, accent-5 */
  swatches: ThemeSwatches
}
```

### 5.3 Palette generation

`node scripts/generate-themes.mjs` (Node ≥ 23.6; it imports the TypeScript helpers via
type stripping) writes `src/themes/palettes.css`. Each theme source supplies:

- **`neutral`** — all 12 steps by hand. Page, surface, edges and ink live here, so they
  are authored, not derived.
- **`keys`** — one signature color per intent family. The ramp keeps the lightness
  profile of the matching Dark (dark scheme) or Light (light scheme) ramp — the profile
  components were tuned against — and takes hue and chroma from the key. Step 5 (the
  usual text step) is pinned to the key's lightness, with the shift tapering to zero at
  steps 1 and 12. Before that, the key is nudged to 4.5:1 against the page if it falls
  short. Out-of-gamut results are chroma-reduced at constant lightness and hue.
- **`syntax`** — highlight.js token colors, nudged in lightness where needed to reach
  the floor against the code-block background (`neutral-11` dark / `neutral-10` light).

The generated file is committed; the generator runs only when a theme source changes.

### 5.4 Syntax highlighting via tokens

The ~50 per-polarity `.hljs-*` hex rules became one rule set over 11 tokens plus a
deletion background:

| Token | highlight.js classes |
|-------|----------------------|
| `keyword` | keyword, tag, literal, name |
| `builtin` | built_in, type, title.class_ |
| `function` | title.function_ |
| `string` | string, addition |
| `number` | number, symbol |
| `comment` | comment, quote |
| `variable` | variable, template-variable, attr, attribute, params |
| `regexp`, `meta`, `selector` | regexp; meta; selector-tag/class/id |
| `deletion`, `deletion-bg` | deletion |

The groupings match the colors Dark and Light already shared, so both reproduce exactly.
The rules keep a `[data-theme]` prefix to preserve their old specificity.

### 5.5 Settings, applying, and first paint

- `Settings.theme: ThemeId`. `useSettings.load()` keeps any valid id and falls back to
  Dark otherwise. The old values `'dark'` and `'light'` are valid ids, so there is no
  migration.
- `applyTheme(id)` (called from an `App.tsx` effect) sets `data-theme`, `data-scheme`
  and the `theme-color` meta.
- **No flash on load:** `public/theme-init.js` is a classic blocking script in `<head>`
  that reads `codekin-settings`, validates the id against an inlined map, and applies
  it before first paint. It is a file rather than an inline script because the server
  CSP is `script-src 'self'`. `themes.test.ts` keeps its map in step with the registry.
- The PWA manifest's static `theme_color` stays Dark; it only affects the installed
  app's splash screen.

---

## 6. Contrast Floors

Enforced by `src/themes/themes.test.ts` for every theme except Dark and Light, which are
frozen at their hand-tuned values (their measured ratios are documented in
`src/index.css`). WCAG 2.x contrast.

| Pair | Floor | High Contrast |
|------|-------|---------------|
| `ink` on `page`, `surface` | ≥ 7:1 | ≥ 15:1 |
| `ink-muted` on `page`, `surface` | ≥ 4.5:1 | ≥ 7:1 |
| `ink-faint` on `page`, `surface` | ≥ 4.5:1 | ≥ 7:1 |
| `on-primary-fill` on `primary-fill` | ≥ 4.5:1 | ≥ 7:1 |
| link (`accent-5`) on `page` | ≥ 4.5:1 | ≥ 7:1 |
| `edge` on `surface` | ≥ 1.2:1 | ≥ 3:1 |
| `edge-strong` on `surface` | ≥ 1.4:1 | ≥ 3:1 |
| `focus` on `page` | ≥ 3:1 | ≥ 4.5:1 |
| each `--syntax-*` on the code background | ≥ 4.5:1 | ≥ 7:1 |

---

## 7. UI

- **Settings → Preferences → Theme**: a grid of theme cards (3 across, 2 on narrow
  widths), each with a `ThemeSwatch` preview, the label, and a Dark/Light hint (omitted
  where the label already says it). It is a `radiogroup`; the selected card gets a
  `border-focus` ring and a check. Selection applies immediately.
- **Sidebar**: the sun/moon toggle (collapsed and expanded/mobile variants) became a
  palette button opening a level-2 popover listing all themes (chip swatch, label,
  check). Rows use the density tokens (`--row-h`, `--row-pad`). Arrow keys move, Enter
  selects, Escape closes. Hover does not live-preview — repainting the whole app on
  pointer movement flickers.
- **Command palette**: a "Theme: <Label>" action per theme under Actions.

`ThemeSwatch` is the only component that paints colors from a theme other than the
active one, so it uses inline styles rather than tokens.

---

## 8. Verification

- **Unit**: registry ids/validation; `useSettings` restores each id and falls back to
  Dark on unknown values.
- **Drift**: registry swatches equal the CSS values they name; the pre-paint map in
  `public/theme-init.js` equals the registry's ids, schemes and page colors.
- **Completeness**: each generated theme defines all 84 ramp variables and every
  syntax token.
- **Contrast**: §6, per theme.
- **Pixel-neutral Dark/Light**: a harness page exercising both scopes, sidebar, prose,
  every highlight.js class, diff rows, cards, the orchestrator composer and form
  controls was rendered in headless Chromium with the `main` build's CSS and this
  branch's. Screenshots were byte-identical for Dark and for Light.
- **Manual**: the built app with each theme, the sidebar popover (desktop and the
  mobile drawer at 390px with touch density), keyboard selection, the Settings grid, and
  the pre-paint script (`data-theme`, `data-scheme` and `theme-color` set before React
  mounts).

---

## 9. Follow-ups

1. **"System" option** — follow `prefers-color-scheme`, mapping to a user-chosen dark
   and light theme. It layers on this design as one more selector value plus a
   `matchMedia` listener.
2. **Semantic tokens in override scopes** — `--color-page`, `--color-ink`, etc. are
   declared on `:root`, so they resolve against the root ramps even inside
   `.terminal-area` and the sidebars (custom properties compute where declared). This
   predates this work and does not affect themes 3–9, which have a single scope. If Dark
   and Light ever need semantic tokens to follow their scoped ramps, Tailwind's
   `@theme inline` is the fix.
