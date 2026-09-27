# Theme Selector

**Status**: Draft spec
**Goal**: Replace the binary dark/light toggle with a theme selector offering five
pre-defined color themes. Today's Dark and Light modes become themes 1 and 2, unchanged.
Themes change **color only** — fonts, the type scale, radii, shadow geometry and
density are shared by every theme.

---

## 1. Problem

Codekin's appearance setting is a two-state switch (`Settings.theme: 'dark' | 'light'`).
Users who spend all day in the transcript want a choice: a cooler palette, a softer
low-glare reading theme, or a high-contrast option for accessibility and bright rooms.

The visual system is already token-driven, which makes this mostly a data problem rather
than a component problem:

- Components never use raw hex values. They use semantic tokens (`bg-page`, `text-ink`,
  `border-edge`, …) and the six intent families (`primary-N`, `secondary-N`, `accent-N`,
  `error-N`, `warning-N`, `success-N`), enforced by the ESLint guard in `eslint.config.js`.
- Every color resolves through CSS custom properties defined in `src/index.css`.

But the two current modes are wired as a *polarity*, not as *themes*:

- `[data-theme="light"]` / `[data-theme="dark"]` selectors (72 occurrences in
  `src/index.css`) mix two concerns: palette values (ramps, syntax colors, prose colors)
  and polarity-dependent component tweaks (sidebar backgrounds, card contrast, diff
  tints, `color-scheme`).
- `useSettings.load()` collapses any stored value other than `'light'` to `'dark'`.
- The sidebar button toggles `dark ↔ light` and picks a sun/moon icon from that.
- `index.html` and `manifest.webmanifest` hardcode the dark `theme-color` (`#0b0d0e`),
  and light users get a dark flash on load because `data-theme` is only set in a React
  effect after the first render.

---

## 2. Non-Goals

- **No font, type-scale, spacing, radius or density changes per theme.** Inconsolata /
  Lato, the five type steps, `rounded-control` / `rounded-floating` and the density
  tokens are theme-independent. A theme is a set of color values, nothing else.
- No user-authored or imported themes, no per-token color pickers. Five curated themes.
- No per-session or per-repo themes. The theme is app-wide.
- No server-side persistence or cross-device sync. The theme stays in `localStorage`
  like today (hosted mode included — each origin/device remembers its own choice).
- No "follow OS" mode in v1 (see §10, open question 2).

---

## 3. The Five Themes

Each theme declares a **scheme** (`dark` or `light`) that drives native UI
(`color-scheme`) and the polarity-dependent component rules (§5.2).

| # | id | Label | Scheme | Character |
|---|----|-------|--------|-----------|
| 1 | `dark` | Dark | dark | **Existing** dark mode, byte-for-byte. Teal-tinted chrome, warm-gray transcript, gold primary, teal accent. |
| 2 | `light` | Light | light | **Existing** light mode, byte-for-byte. Cream transcript, warm-gray chrome. |
| 3 | `midnight` | Midnight | dark | Cool blue-slate dark (Nord-adjacent). Blue-gray neutrals in both chrome and transcript, frost-blue accent, softened gold primary. For users who find the warm transcript too brown. |
| 4 | `paper` | Paper | light | Low-glare sepia light. Warmer, lower-contrast page than Light (off-white parchment, no pure white), ink stays ≥ 7:1. For long reading sessions. |
| 5 | `contrast` | High Contrast | dark | Near-black ground, near-white ink, saturated intent colors, strong borders. Targets WCAG AAA for body text. |

Themes 1 and 2 are **defined** as the current palettes: migrating them into the new
structure must be pixel-neutral (verified by screenshot diff, §8).

The exact ramp values for themes 3–5 are a design deliverable of Phase 2, constrained by
the contrast floors in §6. Starting palettes to tune from:

- **Midnight** — neutrals from `#eceff4` (step 1) to `#1b1f27` (step 12) along a
  ~220° hue; accent around `#88c0d0`; primary a desaturated `#ebcb8b`; error `#bf616a`,
  success `#a3be8c`, warning `#d08770`-adjacent.
- **Paper** — page `#f6f1e7`, surface `#efe8da`, ink `#2b2620`; accent a muted
  blue-teal (`#2f6f80`); primary a deeper ochre so gold fills keep contrast on
  parchment.
- **High Contrast** — page `#000000`, surface `#0d0d0d`, ink `#ffffff`, ink-muted
  `#d0d0d0`; borders at ≥ 3:1 against their surface (non-text contrast, WCAG 1.4.11);
  intents at their most saturated readable step.

---

## 4. What a Theme Must Define

A theme is a complete assignment of every color variable the app reads. Because
components use raw intent steps (`bg-primary-8`, `text-accent-5`, … — ~166 uses in
`src/components`), a theme cannot just set the semantic tokens; it must supply full
ramps. Per theme:

1. **Seven 12-step ramps** — `neutral`, `primary`, `secondary`, `accent`, `error`,
   `warning`, `success` — at the root (chrome) scope.
2. **The same seven ramps for `.terminal-area`** (the transcript scope). A theme may
   reuse its chrome ramps here; Dark and Light do not, and keep their distinct
   transcript palettes.
3. **Sidebar scope overrides** where the theme needs them (Light has darkened sidebar
   text today; §5.2).
4. **Semantic token mappings that differ from the defaults** — `--color-on-primary`,
   `--color-primary-fill`, `--color-on-primary-fill`, `--color-focus`. The rest of the
   semantic layer (`--color-page` → `neutral-12`, etc.) is shared and must not be
   redefined per theme.
5. **Syntax-highlight colors** as tokens (§5.3).
6. **Prose colors** (`--tw-prose-*`) — expressed via ramp steps, so most themes inherit
   the scheme's default mapping for free.
7. **Diff tints** — insert/delete backgrounds, via intent ramps + `color-mix`.
8. **`--shadow-floating`** color (the geometry is shared; the dark themes use a black
   shadow, light themes a softer one).
9. **Browser chrome color** — the `theme-color` meta value (the theme's page color).

---

## 5. Architecture

### 5.1 Two attributes: `data-theme` and `data-scheme`

Split the current overloaded attribute:

- `<html data-theme="<id>">` — selects the **palette** (one of the five ids).
- `<html data-scheme="dark|light">` — selects **polarity**, derived from the theme's
  registry entry.

Rules that depend on polarity rather than a specific palette move from
`[data-theme="light"]` to `[data-scheme="light"]`: `color-scheme`, sidebar background,
settings/workflow card contrast, session-tab hover, orchestrator composer edge, diff
text color. Rules that set palette values stay keyed on `data-theme`.

Result: a new light theme (Paper) automatically inherits every light-polarity layout fix
without copying them, and vice versa for dark themes.

### 5.2 File layout

```
src/
  index.css                 # @theme defaults (= Dark palette), shared tokens, scheme rules
  themes/
    registry.ts             # ThemeDefinition[] — id, label, scheme, themeColor, swatches
    dark.css                # .terminal-area ramps for Dark (moved from index.css)
    light.css               # [data-theme="light"] ramps + terminal/sidebar scopes (moved)
    midnight.css
    paper.css
    contrast.css
    syntax.css              # .hljs-* rules, written once against --syntax-* tokens
```

Dark stays the `@theme` default so that Tailwind's generated utilities and the
pre-hydration state need no attribute to render correctly. Each theme file is plain CSS
imported from `index.css`; nothing is loaded lazily (five palettes are a few KB).

```ts
// src/themes/registry.ts
export type ThemeId = 'dark' | 'light' | 'midnight' | 'paper' | 'contrast'

export interface ThemeDefinition {
  id: ThemeId
  label: string
  scheme: 'dark' | 'light'
  /** Page color, used for <meta name="theme-color"> and the pre-paint background. */
  themeColor: string
  /** Four colors for the picker preview: page, surface, primary, accent. */
  swatches: [string, string, string, string]
}

export const THEMES: readonly ThemeDefinition[] = [ /* the five, in §3 order */ ]
export const DEFAULT_THEME: ThemeId = 'dark'
export function isThemeId(v: unknown): v is ThemeId
export function getTheme(id: ThemeId): ThemeDefinition
```

The registry duplicates a handful of hex values from the CSS (`themeColor`, swatches).
A unit test (§8) asserts they match the CSS so the two cannot drift.

### 5.3 Syntax highlighting via tokens

Today `.hljs-*` colors are 50+ hardcoded hex rules duplicated per polarity. Replace with
~14 tokens set per theme and a single rule set:

```css
/* syntax.css — written once */
.hljs-keyword, .hljs-tag, .hljs-literal, .hljs-name { color: var(--syntax-keyword); }
.hljs-string, .hljs-addition                        { color: var(--syntax-string); }
/* … */
```

```css
/* dark.css */
:root, [data-theme="dark"] {
  --syntax-keyword: #d8a657;
  --syntax-string:  #ce9178;
  /* … values copied verbatim from the current [data-theme="dark"] .hljs-* rules */
}
```

Token set: `keyword`, `builtin` (built_in, type, class title), `function`, `string`,
`number` (number, symbol), `comment` (comment, quote), `variable` (variable,
template-variable, attr, attribute, params), `regexp`, `meta`, `selector`,
`deletion`, `deletion-bg`, plus `--syntax-bg` for `.hljs` background. The mapping
reproduces the current Dark and Light colors exactly.

### 5.4 Settings and migration

```ts
// src/types.ts
export interface Settings {
  token: string
  fontSize: number
  theme: ThemeId
}
```

`useSettings.load()`: `theme: isThemeId(saved?.theme) ? saved.theme : DEFAULT_THEME`.
Existing stored values `'dark'` and `'light'` are valid ids, so no migration step is
needed and current users see no change.

### 5.5 Applying the theme

`App.tsx` replaces the current effect with a small `applyTheme(id)` helper
(`src/themes/applyTheme.ts`) that sets `data-theme`, `data-scheme`, and updates the
`<meta name="theme-color">` content.

**No flash on load.** Add a tiny inline script at the top of `index.html` `<head>` that
reads `codekin-settings` from `localStorage`, validates the id against an inlined list,
and sets `data-theme` / `data-scheme` / `theme-color` before first paint. It must be
wrapped in `try/catch` and fall back to Dark. (Also drop the stale `class="dark"` and
`bg-neutral-12 text-neutral-2` in `index.html` in favor of the attribute defaults.)
If CSP ever forbids inline scripts, the fallback is the current behavior: a one-frame
Dark flash.

The PWA manifest's static `theme_color` / `background_color` stay Dark; they only affect
the splash screen of an installed app.

---

## 6. Contrast Floors

Every theme must meet these, in **both** the chrome scope and `.terminal-area` (and the
sidebar scope where overridden). Ratios are WCAG 2.x relative-luminance contrast.

| Pair | Floor | High Contrast |
|------|-------|---------------|
| `ink` on `page`, `surface` | ≥ 7:1 | ≥ 15:1 |
| `ink-muted` on `page`, `surface` | ≥ 4.5:1 | ≥ 7:1 |
| `ink-faint` on `page`, `surface` | ≥ 4.5:1 | ≥ 7:1 |
| `on-primary-fill` on `primary-fill` | ≥ 4.5:1 | ≥ 7:1 |
| `ink-inverse` on each intent's fill step (`*-6`/`*-8` as used for badges/buttons) | ≥ 4.5:1 | ≥ 7:1 |
| `edge` on `surface` | ≥ 1.2:1 | ≥ 3:1 |
| `edge-strong` on `surface` | ≥ 1.4:1 | ≥ 3:1 |
| `focus` on `page` | ≥ 3:1 | ≥ 4.5:1 |
| each `--syntax-*` on `--syntax-bg` | ≥ 4.5:1 | ≥ 7:1 |

The current Dark and Light palettes are grandfathered at their measured values where
they fall below a floor (they are pixel-frozen by definition); the check reports them as
warnings, not failures.

---

## 7. UI

### 7.1 Settings → Appearance

Replace the Dark / Light button pair with a **theme grid**: five cards in a responsive
grid (5 across on desktop, 2–3 on narrow widths). Each card:

- a mini preview built from the registry swatches — a page-colored tile with a
  surface-colored "sidebar" strip, a line of ink text, a primary pill and an accent dot;
- the label below, and a small `Dark` / `Light` scheme hint in `text-ink-faint`;
- selected state: `border-focus` ring + check icon; `rounded-control`, level-1 surface.

The previews render with the swatch colors as inline styles — this is the one place a
component legitimately paints another theme's colors, so it lives in a dedicated
`ThemeSwatch` component with a scoped ESLint exception comment.

Selection applies immediately (no save button), same as today.

### 7.2 Sidebar quick switch

The sun/moon icon button (two instances in `LeftSidebar.tsx`: desktop and mobile)
becomes a **palette icon** (`IconPalette`) that opens a level-2 popover
(`bg-surface-raised`, `border-edge-strong`, `shadow-floating`, `rounded-floating`)
listing the five themes as rows (swatch + label + check). Rows use the density tokens
(`var(--row-h)`, `var(--row-pad)`).

Keyboard: arrow keys move, Enter selects, Escape closes. Hovering a row does **not**
live-preview (avoids flicker and accidental repaint of the whole app); selecting does.

### 7.3 Command palette

Add a "Theme: <Label>" command per theme to `CommandPalette.tsx`, plus
"Theme: Next" to cycle — useful for comparing quickly.

---

## 8. Testing

- **Unit** (`src/themes/registry.test.ts`): ids unique; `isThemeId` rejects unknown
  values; `useSettings` round-trips each id and falls back to Dark on garbage,
  missing, or legacy values.
- **Registry ↔ CSS drift**: parse each theme CSS file, assert `themeColor` equals the
  theme's `neutral-12` (page) and swatches match their source variables.
- **Completeness**: every theme file defines all 84 ramp variables (7 × 12) for the
  root scope and — unless it opts into reuse — the `.terminal-area` scope, plus every
  `--syntax-*` token.
- **Contrast** (`src/themes/contrast.test.ts`): resolve the §6 pairs per theme and
  scope, compute WCAG ratios, fail below floor (warn for grandfathered Dark/Light).
- **Pixel-neutral migration**: before/after screenshots of Dark and Light on the main
  views (transcript with code block + diff, sidebar, settings, a modal) must be
  identical. Captured via the `run` skill / Playwright; attached to the Phase 1 PR.
- **Manual**: each new theme reviewed across transcript, tool output, diffs, permission
  prompts, orchestrator chat, Loops/Automations views, mobile density.

---

## 9. Rollout

| Phase | Scope | Visual change |
|-------|-------|---------------|
| 1 | Refactor: `data-scheme` split, `src/themes/` layout, syntax tokens, registry, `ThemeId` type, `applyTheme`, pre-paint script. Only Dark and Light registered. Sidebar keeps the dark↔light toggle. | None (pixel-neutral, plus the light-mode load flash is fixed). |
| 2 | Add Midnight, Paper, High Contrast palettes + completeness/contrast tests. | New themes selectable via Settings only. |
| 3 | Settings theme grid, sidebar popover, command palette entries. Update `CLAUDE.md` styling rules ("Both theme polarities…" → "all five themes"). | Final UI. |

Each phase is one PR. Phase 1 is independently valuable (flash fix, halved hljs CSS).

---

## 10. Open Questions

1. **Palette choices for themes 3–5.** Proposed: Midnight (cool dark), Paper (sepia
   light), High Contrast (dark). Alternatives: a Solarized-style pair, Dracula, or
   Gruvbox. The mix proposed gives 3 dark / 2 light and covers the three most common
   asks (cooler, softer, more accessible).
2. **"System" option.** Follow `prefers-color-scheme`, mapping to a user-chosen dark
   theme and light theme. Cheap to add on top of this design (a sixth selector value
   plus a `matchMedia` listener); deferred to keep v1 to exactly five choices.
3. **Distinct transcript palette for new themes.** Dark and Light keep a warmer
   `.terminal-area` than the chrome. Should Midnight/Paper/High Contrast do the same, or
   use one palette throughout? Proposal: one palette throughout for High Contrast;
   designer's call for the other two.
4. **Sidebar button.** Popover picker (proposed) vs. keeping a one-click toggle that
   flips between the user's last-used dark and last-used light theme.
