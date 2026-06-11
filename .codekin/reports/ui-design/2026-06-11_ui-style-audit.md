# UI Style & Color Scheme Audit

**Date:** 2026-06-11
**Scope:** `src/index.css` theme system, component color usage, light & dark modes
**Method:** Full review of the theme CSS (~600 color tokens across 5 override scopes); live rendering of the real `ChatView` + `InputBar` with fixture content (markdown, code blocks, tool groups, system messages) in headless Chromium in both themes; WCAG 2.1 contrast measurement of key foreground/background pairings.

---

## Summary

The palette concept is strong — a warm gold/terracotta/teal identity with a deliberate "cool chrome, warm content" split between the sidebar and terminal area. Dark mode is in good shape: every measured text pairing passes WCAG AA, and the muted warm grays feel calm and cohesive. The main problems are: (1) chat markdown is visually flat because the `prose` classes reference a Tailwind Typography plugin that is not installed; (2) light mode has several AA contrast failures; (3) the theme is maintained as ~600 hand-tuned hex literals across five override scopes with no semantic layer, which is why one-off component patches keep accumulating.

| Area | Dark | Light |
| --- | --- | --- |
| Body text contrast | 12.4:1 ✅ | 16.6:1 ✅ |
| Secondary text | 4.2–6.2:1 ✅ | 2.9–4.4:1 ⚠️ several AA failures |
| Markdown hierarchy | ❌ flat (no plugin) | ❌ flat (no plugin) |
| Status colors | ✅ distinct enough | ⚠️ notification gold 3.1:1 |
| Code blocks | ✅ good, slight temperature clash | ⚠️ stock VS Code blue harsh on cream |

---

## Findings

### F1 — Chat markdown has no typographic hierarchy (high impact)

`ChatView` wraps assistant messages in `prose prose-themed` (src/components/ChatView.tsx:178), but `@tailwindcss/typography` is **not installed** — `prose` is an inert class. The only styling that applies is the hand-rolled `.prose.prose-themed` rules in `src/index.css:611-687`, which cover margins, code font, link underline, and table borders — nothing else.

Observed result in both themes:

- `## Headings` render at body size and weight — indistinguishable from paragraphs.
- Bullet/numbered lists render with **no markers** and no indentation (Tailwind preflight strips `list-style`; nothing restores it). Multi-item lists read as run-on lines.
- Blockquotes render as plain text — no left border, no color shift, despite `--tw-prose-quote-borders` being defined (those vars do nothing without the plugin).
- Bold/italic survive only because browser defaults for `<strong>/<em>` survive preflight.

This is the single biggest aesthetic problem: assistant answers — the core content of the product — lose their structure. Note the docs browser does *not* have this problem because `.docs-prose` (index.css:860-942) defines complete rules; chat deserves the same treatment.

### F2 — Light mode AA contrast failures (high impact)

Measured against the light terminal background `#fdf9f4` (WCAG AA requires 4.5:1 for normal text):

| Element | Color | Ratio | Verdict |
| --- | --- | --- | --- |
| Tool name (`text-accent-6`) | `#559f97` | **2.95** | ❌ fail |
| Notification banner (`text-primary-5`) | `#af8958` | **3.06** | ❌ fail |
| Request-ID / muted (`text-neutral-6`) | `#93918c` | **3.00** | ❌ fail |
| Links (`accent-5`) | `#42847d` | **4.15** | ❌ fail (borderline) |
| Tool summary (`text-neutral-5`) | `#777571` | **4.39** | ❌ fail (borderline) |
| Success / init banner (`success-5`) | `#3f8559` | 4.25 | ❌ fail (borderline) |
| Body text (`neutral-2`) | `#1b1a18` | 16.59 | ✅ |
| Error text (`error-5`) | `#ad3e3e` | 5.67 | ✅ |

The root cause: dark mode picks step 5–6 for "muted but readable" colors, and the light theme reuses the same step indices after inversion — but mid-steps that glow on near-black wash out on cream. Light mode needs its own step mapping (roughly: wherever dark uses step 5, light should use step 6–7 of the inverted scale).

Dark mode passes everywhere measured (worst case: timestamps at 4.19:1, which is acceptable for de-emphasized metadata).

### F3 — Light theme is an inversion hack plus 15 component patches (medium, maintainability)

The light theme is produced by wholesale inverting each 12-step scale (index.css:244-358), then re-overriding the terminal area (427-505), then patching individual components: `.app-logo-circle`, `.app-right-sidebar`, `.app-left-sidebar`, `.app-new-session-btn`, `.app-session-tab`, `.app-input-bar`, `.app-thinking-badge`, `.settings-section-card`, `.workflow-card`, `.user-bubble` (361-424). Each patch exists because the inverted scale lacks the right mid-tone.

Concretely, the inverted neutral scale jumps from `#777571` (step 6) to `#c8c7c4` (step 7) — a hole where all the light-mode borders, hovers, and surface tints should live. Every new component will keep hitting this hole and growing the patch list.

### F4 — `font-weight: 465` global hack (low, correctness)

`[data-theme="light"] { font-weight: 465 }` (index.css:245). Lato is loaded as static 300/400/700, so for all Lato text this rounds to 400 — a no-op. It only affects Inconsolata (variable 300–700), making *code* slightly bolder in light mode while body text is untouched. If light-mode text feels thin, the fix is darker ink (F2), not synthetic weight.

### F5 — Redundant and ambiguous color roles (medium)

- **`info` ≈ `accent`**: two nearly identical teal/cyan-blue 12-step scales (`#45b5c9` vs `#40a9c8` at step 5). `info` appears unused in components; it's 48+ tokens of dead weight per scope.
- **`warning` ≈ `primary`**: warm yellow vs warm gold are visually indistinguishable at message-banner sizes. System messages use primary for *notifications* and warning for *exit/restart* (ChatView.tsx:66-90) — users cannot tell these apart by color.

### F6 — The "two blacks" problem (low, dark mode)

The intended cool-chrome/warm-content split: sidebar `#090e0f` (teal-black) vs terminal `#0f0e0d` (warm-black). At these depths the hue difference is imperceptible — both read as black, and the design intent is invisible while costing a full duplicate palette (`.terminal-area`, 124-236) plus grayscale text overrides for the sidebar (507-529) to undo the teal tint in fonts. In light mode the split *does* read (cool white vs cream). Either make the dark split legible (lighten the sidebar a step, e.g. `#11181a`, or add a visible border/elevation) or accept that dark mode doesn't need two neutral families.

### F7 — Syntax highlighting palette clashes with the theme (low-medium)

Token colors are stock VS Code Dark+/Light (index.css:761-813):

- Dark: cool saturated blues (`#569cd6`, `#9cdcfe`) sit inside the deliberately *warm* terminal area — the code blocks feel pasted in from a different app. Contrast is fine (5.2–6.6:1).
- Light: pure `#0000ff` keywords and `#a31515` strings are the harshest colors anywhere in the light UI, against a soft cream background. Contrast passes, but the saturation is jarring against the otherwise muted palette.

A warm-leaning scheme (Gruvbox-ish: sand, sage, terracotta, muted teal) would make code blocks feel native to the theme in both modes.

### F8 — No semantic token layer (medium, root cause)

The theme is ~600 hex literals spread over five scopes (base, `.terminal-area`, `[data-theme=light]`, `[data-theme=light] .terminal-area`, sidebar text overrides). Components reference raw steps (`bg-neutral-12`, `text-neutral-5`), so changing "muted text" or "card border" means re-deriving step choices in every scope — which is exactly why F2 and F3 happened. There are no `--color-bg`, `--color-surface`, `--color-border`, `--color-text-muted` aliases.

### F9 — Minor polish items

- **User bubble (dark)** is barely distinguishable from the background — the conversation reads as one undifferentiated column. A faint warm tint (e.g. `primary-11` at low alpha) would mark the user's turns without shouting.
- **Links** are styled identically to muted teal text plus underline; in dark mode they have less salience than inline code. Consider one step brighter.
- **Empty input bar** reserves a tall area with the send/attach icons at ~2:1 contrast in the corner — fine when typing, but reads as dead space when idle.
- **Scroll-to-bottom button** floats directly over text with minimal elevation; a slightly stronger shadow would separate it.
- Good news: **zero hardcoded hex values in components** — everything goes through theme classes. The discipline is there; only the token architecture is missing.

---

## Recommendations (prioritized)

### R1 — Restore markdown hierarchy in chat (highest value, small effort)

Either install `@tailwindcss/typography`, or (lighter, no new dependency, consistent with `.docs-prose`) extend `.prose.prose-themed` with the missing structural rules:

```css
.prose.prose-themed h1 { font-size: 1.4em; font-weight: 700; }
.prose.prose-themed h2 { font-size: 1.2em; font-weight: 600; }
.prose.prose-themed h3 { font-size: 1.05em; font-weight: 600; }
.prose.prose-themed ul { list-style: disc; padding-left: 1.5em; }
.prose.prose-themed ol { list-style: decimal; padding-left: 1.5em; }
.prose.prose-themed li { margin: 0.2em 0; }
.prose.prose-themed blockquote {
  border-left: 3px solid var(--tw-prose-quote-borders);
  padding-left: 1em;
  color: var(--tw-prose-quotes);
}
```

(Mirror in `.prose.prose-invert`.)

### R2 — Fix light-mode contrast failures

Darken the light terminal-area values for the failing roles to reach ≥4.5:1 on `#fdf9f4`:

| Token (light terminal scope) | Current | Suggested | New ratio |
| --- | --- | --- | --- |
| `--color-accent-6` (tool names) | `#559f97` | `#3d7a72` | ~4.6 |
| `--color-primary-5` (notifications) | `#af8958` | `#8a6a3c` | ~4.9 |
| `--color-neutral-6` (request IDs) | `#93918c` | `#7c7a75` | ~4.2* |
| `--color-neutral-5` (tool summaries) | `#777571` | `#6b6964` | ~5.0 |
| `--color-accent-5` (links) | `#42847d` | `#356f69` | ~5.2 |
| `--color-success-5` (init banner) | `#3f8559` | `#327249` | ~5.2 |

\* intentionally de-emphasized metadata; 4.2 is a reasonable floor if full AA isn't required there.

### R3 — Introduce a semantic alias layer

Add ~10 semantic variables mapped once per scope, and migrate components gradually:

```css
@theme {
  --color-bg: var(--color-neutral-12);
  --color-surface: var(--color-neutral-11);
  --color-surface-raised: var(--color-neutral-10);
  --color-border: var(--color-neutral-9);
  --color-border-strong: var(--color-neutral-8);
  --color-text: var(--color-neutral-2);
  --color-text-muted: var(--color-neutral-5);
  --color-text-faint: var(--color-neutral-6);
}
```

Light mode then remaps eight aliases instead of inverting 600 literals — and most of the `[data-theme="light"] .app-*` patches (F3) become deletable.

### R4 — Remove the `font-weight: 465` hack

Delete it; R2's darker ink solves the legibility issue it was papering over, and it stops code text from changing weight between themes.

### R5 — Collapse redundant scales

- Delete the `info` scale (alias it to `accent` if any usage emerges).
- Differentiate notification vs. exit/restart banners by something other than two near-identical golds — e.g. notifications keep gold, exit/restart use the neutral "info" treatment, or warning shifts toward orange (`#d97f2d`-family).

### R6 — Decide the two-tone story in dark mode

Cheapest legible option: lift the dark sidebar one step (`#11181a`-ish) and keep the terminal at `#0f0e0d`, so the cool/warm split actually reads. Alternatively drop the dual neutral family in dark mode entirely and keep the split light-mode-only.

### R7 — Warm the syntax palette

Swap the stock VS Code token colors for a warm-leaning set (keep current contrast levels). Dark example: keywords `#d8a657`, strings `#a9b665`, functions `#e2bf5d`, comments `#8f8a80`, variables `#83a598`. Light: replace `#0000ff` → `#2d5e8f`, `#a31515` → `#9a4a32`, `#008000` → `#5a7a4a`.

### R8 — Small polish

- User bubble (dark): `background: color-mix(in srgb, var(--color-primary-11) 35%, var(--color-neutral-11))` for a faint warm identity.
- Links one accent step brighter in dark mode.
- Stronger shadow on the scroll-to-bottom button.

---

## Suggested sequencing

1. **R1 + R2 + R4** — one small PR, immediate visible improvement, no architecture risk.
2. **R5 + R7 + R8** — palette refinement PR.
3. **R3 + R6** — token-architecture refactor, done incrementally (alias layer first, component migration opportunistically).
