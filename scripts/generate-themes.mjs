#!/usr/bin/env node
/**
 * Generates src/themes/palettes.css — the color ramps and syntax tokens for
 * every theme except Dark and Light (which are hand-tuned in src/index.css).
 *
 *   node scripts/generate-themes.mjs
 *
 * Each theme below supplies:
 *   - neutral: all 12 steps by hand (page, surface, edges and ink live here,
 *     so they are authored, not derived). Step 1 is the strongest ink, step
 *     12 the page — in both schemes, matching the Dark/Light convention.
 *   - keys:    one signature color per intent family. The 12-step ramp keeps
 *     the lightness profile of the matching Dark (or Light) ramp — which the
 *     components were tuned against — and takes hue and chroma from the key.
 *     Step 5 is pinned to the key's lightness, after nudging the key to
 *     4.5:1 against the page if it falls short (canonical Solarized blue
 *     does, on its own cream).
 *   - syntax:  highlight.js token colors, nudged in lightness where needed to
 *     reach the contrast floor against the code-block background.
 *
 * Requires Node ≥ 23.6 (imports TypeScript via type stripping).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hexToOklch, oklchToHex, ensureContrast } from '../src/themes/color.ts'
import { extractBlock, parseVars } from '../src/themes/cssVars.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const indexCss = readFileSync(resolve(root, 'src/index.css'), 'utf8')
const reference = {
  dark: parseVars(extractBlock(indexCss, '@theme')),
  light: parseVars(extractBlock(indexCss, '[data-theme="light"]')),
}

const FAMILIES = ['primary', 'secondary', 'accent', 'error', 'warning', 'success']
const SYNTAX_TOKENS = ['keyword', 'builtin', 'function', 'string', 'number', 'comment', 'variable', 'regexp', 'meta', 'selector', 'deletion']

/** Neutral ramp from a list of 12 hex values, step 1 first. */
const ramp = list => list.split(/\s+/).filter(Boolean)

const THEMES = [
  {
    id: 'midnight',
    label: 'Midnight',
    scheme: 'dark',
    neutral: ramp('#eceff4 #d8dee9 #c5ccd8 #a7b1c2 #8d97aa #6c768a #525b6d #414958 #333a47 #2a303c #222731 #1b1f27'),
    keys: { primary: '#ebcb8b', secondary: '#d08770', accent: '#88c0d0', error: '#bf616a', warning: '#e5b567', success: '#a3be8c' },
    syntax: { keyword: '#81a1c1', builtin: '#8fbcbb', function: '#88c0d0', string: '#a3be8c', number: '#b48ead', comment: '#8d97aa', variable: '#d8dee9', regexp: '#ebcb8b', meta: '#d08770', selector: '#8fbcbb', deletion: '#bf616a' },
  },
  {
    id: 'paper',
    label: 'Paper',
    scheme: 'light',
    neutral: ramp('#1a1611 #2b2620 #3d372f #4f473c #5c5347 #7a7163 #aea38b #bfb49b #d3cab5 #e4dcc9 #efe8da #f6f1e7'),
    keys: { primary: '#a8741a', secondary: '#a0522d', accent: '#2f6f80', error: '#b3261e', warning: '#a6720d', success: '#3f7d3a' },
    syntax: { keyword: '#8a3b12', builtin: '#2f6f80', function: '#6b4f12', string: '#4d6b2a', number: '#7a3e7a', comment: '#6f6555', variable: '#34506a', regexp: '#9c2a2a', meta: '#7a3e7a', selector: '#8a3b12', deletion: '#a0522d' },
  },
  {
    id: 'contrast',
    label: 'High Contrast',
    scheme: 'dark',
    neutral: ramp('#ffffff #f5f5f5 #e6e6e6 #d4d4d4 #bdbdbd #a0a0a0 #8c8c8c #7a7a7a #6a6a6a #1f1f1f #0d0d0d #000000'),
    keys: { primary: '#ffd000', secondary: '#ff8fb0', accent: '#4dd8ff', error: '#ff5c5c', warning: '#ffb000', success: '#3ddc84' },
    syntax: { keyword: '#ffd000', builtin: '#4dd8ff', function: '#8cf0ff', string: '#9dff9d', number: '#ffb0ff', comment: '#c8c8c8', variable: '#a8d8ff', regexp: '#ff9d9d', meta: '#ffb0ff', selector: '#ffd000', deletion: '#ff8080' },
    minContrast: { syntax: 7 },
  },
  {
    id: 'solarized',
    label: 'Solarized Light',
    scheme: 'light',
    neutral: ramp('#002b36 #073642 #28444d #3f565e #4f646b #6f8286 #b3b09c #c6c1ab #d8d2bd #e6e0cb #eee8d5 #fdf6e3'),
    keys: { primary: '#b58900', secondary: '#cb4b16', accent: '#268bd2', error: '#dc322f', warning: '#b58900', success: '#859900' },
    syntax: { keyword: '#859900', builtin: '#b58900', function: '#268bd2', string: '#2aa198', number: '#d33682', comment: '#586e75', variable: '#268bd2', regexp: '#dc322f', meta: '#cb4b16', selector: '#b58900', deletion: '#dc322f' },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    scheme: 'dark',
    neutral: ramp('#ffffff #f8f8f2 #e2e3ea #c0c4da #9ca2c2 #6272a4 #555a74 #464a5e #3a3d4f #313343 #282a36 #21222c'),
    keys: { primary: '#bd93f9', secondary: '#ff79c6', accent: '#8be9fd', error: '#ff5555', warning: '#ffb86c', success: '#50fa7b' },
    syntax: { keyword: '#ff79c6', builtin: '#8be9fd', function: '#50fa7b', string: '#f1fa8c', number: '#bd93f9', comment: '#6272a4', variable: '#f8f8f2', regexp: '#ff5555', meta: '#ff79c6', selector: '#50fa7b', deletion: '#ff5555' },
  },
  {
    id: 'gruvbox',
    label: 'Gruvbox',
    scheme: 'dark',
    neutral: ramp('#fbf1c7 #ebdbb2 #d5c4a1 #bdae93 #a89984 #7c6f64 #665c54 #504945 #3c3836 #32302f #282828 #1d2021'),
    keys: { primary: '#fabd2f', secondary: '#d3869b', accent: '#83a598', error: '#fb4934', warning: '#fe8019', success: '#b8bb26' },
    syntax: { keyword: '#fb4934', builtin: '#fabd2f', function: '#8ec07c', string: '#b8bb26', number: '#d3869b', comment: '#928374', variable: '#83a598', regexp: '#fe8019', meta: '#8ec07c', selector: '#fabd2f', deletion: '#fb4934' },
  },
]

/** Step whose lightness is pinned to the key color (text-*-5 is the common text step). */
const ANCHOR = 5

/**
 * A 12-step ramp with the key's hue and chroma. Lightness follows the
 * reference ramp, shifted so the anchor step lands on the key's lightness;
 * the shift tapers to zero at steps 1 and 12, which keep the reference's
 * extremes (the tints and shades components pair against page and ink).
 */
function deriveRamp(family, scheme, key) {
  const ref = Array.from({ length: 12 }, (_, i) => hexToOklch(reference[scheme][`--color-${family}-${i + 1}`]))
  const k = hexToOklch(key)
  const refPeak = Math.max(...ref.map(s => s.c))
  const shift = k.l - ref[ANCHOR - 1].l
  return ref.map((s, i) => {
    const step = i + 1
    const weight = step <= ANCHOR ? (step - 1) / (ANCHOR - 1) : (12 - step) / (12 - ANCHOR)
    return oklchToHex({ l: s.l + shift * weight, c: s.c * (k.c / refPeak), h: k.h })
  })
}

function renderTheme(theme) {
  if (theme.neutral.length !== 12) throw new Error(`${theme.id}: neutral ramp needs 12 steps`)
  const lines = [`/* ${theme.label} (${theme.scheme}) */`, `[data-theme="${theme.id}"] {`]
  theme.neutral.forEach((hex, i) => lines.push(`  --color-neutral-${i + 1}: ${hex};`))
  const page = theme.neutral[11]
  for (const family of FAMILIES) {
    lines.push('')
    // Step 5 is the usual text step (links, status text), so the key must
    // read on the page; darken/lighten it just enough when it doesn't.
    const key = ensureContrast(theme.keys[family], page, 4.5)
    deriveRamp(family, theme.scheme, key).forEach((hex, i) => lines.push(`  --color-${family}-${i + 1}: ${hex};`))
  }
  // Code blocks sit on neutral-11 (dark) or neutral-10 (light); see .hljs in index.css.
  const codeBg = theme.neutral[theme.scheme === 'dark' ? 10 : 9]
  const floor = theme.minContrast?.syntax ?? 4.5
  lines.push('')
  for (const token of SYNTAX_TOKENS) {
    const color = ensureContrast(theme.syntax[token], codeBg, floor)
    lines.push(`  --syntax-${token}: ${color};`)
  }
  lines.push(`  --syntax-deletion-bg: color-mix(in srgb, var(--syntax-deletion) 10%, transparent);`)
  lines.push('}')
  return lines.join('\n')
}

const header = `/* Generated by scripts/generate-themes.mjs — do not edit by hand.
   Dark and Light live in src/index.css; these are the additional themes.
   Ramps follow the Dark/Light step conventions, so every component class
   (bg-primary-8, text-accent-5, …) means the same role in every theme. */`

const out = [header, ...THEMES.map(renderTheme)].join('\n\n') + '\n'
writeFileSync(resolve(root, 'src/themes/palettes.css'), out)
console.log(`Wrote ${THEMES.length} themes to src/themes/palettes.css`)
