import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast } from './color'
import { extractBlock, parseVars, resolveVar } from './cssVars'
import { THEMES, THEME_IDS, isThemeId, getTheme, type ThemeDefinition } from './registry'

const root = resolve(__dirname, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const indexCss = read('src/index.css')
const palettesCss = read('src/themes/palettes.css')

const base = parseVars(extractBlock(indexCss, '@theme'))
const lightScheme = parseVars(extractBlock(indexCss, '[data-scheme="light"]'))

/** Variable scopes for a theme's chrome (the <html> element), most specific first. */
function scopesFor(theme: ThemeDefinition): Record<string, string>[] {
  const own =
    theme.id === 'dark' ? {}
    : theme.id === 'light' ? parseVars(extractBlock(indexCss, '[data-theme="light"]'))
    : parseVars(extractBlock(palettesCss, `[data-theme="${theme.id}"]`))
  return theme.scheme === 'light' ? [own, lightScheme, base] : [own, base]
}

const color = (theme: ThemeDefinition, token: string) => resolveVar(`--color-${token}`, scopesFor(theme))

const FAMILIES = ['neutral', 'primary', 'secondary', 'accent', 'error', 'warning', 'success']
const SYNTAX = ['keyword', 'builtin', 'function', 'string', 'number', 'comment', 'variable', 'regexp', 'meta', 'selector', 'deletion']
const GENERATED = THEMES.filter(t => t.id !== 'dark' && t.id !== 'light')

describe('theme registry', () => {
  it('lists every id exactly once, in THEME_IDS order', () => {
    expect(THEMES.map(t => t.id)).toEqual([...THEME_IDS])
  })

  it('validates ids', () => {
    expect(isThemeId('gruvbox')).toBe(true)
    expect(isThemeId('blue')).toBe(false)
    expect(isThemeId(undefined)).toBe(false)
    expect(getTheme('paper').scheme).toBe('light')
  })

  it.each(THEMES.map(t => [t.id, t] as const))('%s swatches match its CSS', (_id, theme) => {
    expect(theme.swatches).toEqual({
      page: color(theme, 'neutral-12'),
      surface: color(theme, 'neutral-11'),
      ink: color(theme, 'neutral-2'),
      primary: color(theme, 'primary-5'),
      accent: color(theme, 'accent-5'),
    })
  })

  it('pre-paint script knows every theme, its scheme and page color', () => {
    const script = read('public/theme-init.js')
    const entries = [...script.matchAll(/(\w+): \['(dark|light)', '(#[0-9a-f]{6})'\]/g)]
      .map(([, id, scheme, page]) => ({ id, scheme, page }))
    expect(entries).toEqual(THEMES.map(t => ({ id: t.id, scheme: t.scheme, page: t.swatches.page })))
  })
})

describe('generated palettes', () => {
  it.each(GENERATED.map(t => [t.id, t] as const))('%s defines every ramp step and syntax token', (_id, theme) => {
    const vars = parseVars(extractBlock(palettesCss, `[data-theme="${theme.id}"]`))
    for (const family of FAMILIES) {
      for (let step = 1; step <= 12; step++) expect(vars).toHaveProperty(`--color-${family}-${step}`)
    }
    for (const token of SYNTAX) expect(vars).toHaveProperty(`--syntax-${token}`)
    expect(vars).toHaveProperty('--syntax-deletion-bg')
  })
})

/*
 * Contrast floors (docs/THEME-SELECTOR-SPEC.md §6). Dark and Light are frozen
 * at their hand-tuned values and not re-checked here; every added theme must
 * clear these, High Contrast at the stricter column.
 */
describe('contrast floors', () => {
  const pairs: { name: string; fg: string; bg: string; floor: number; strict: number }[] = [
    { name: 'ink on page', fg: 'ink', bg: 'page', floor: 7, strict: 15 },
    { name: 'ink on surface', fg: 'ink', bg: 'surface', floor: 7, strict: 15 },
    { name: 'ink-muted on page', fg: 'ink-muted', bg: 'page', floor: 4.5, strict: 7 },
    { name: 'ink-muted on surface', fg: 'ink-muted', bg: 'surface', floor: 4.5, strict: 7 },
    { name: 'ink-faint on page', fg: 'ink-faint', bg: 'page', floor: 4.5, strict: 7 },
    { name: 'ink-faint on surface', fg: 'ink-faint', bg: 'surface', floor: 4.5, strict: 7 },
    { name: 'on-primary-fill on primary-fill', fg: 'on-primary-fill', bg: 'primary-fill', floor: 4.5, strict: 7 },
    { name: 'link (accent-5) on page', fg: 'accent-5', bg: 'page', floor: 4.5, strict: 7 },
    { name: 'edge on surface', fg: 'edge', bg: 'surface', floor: 1.2, strict: 3 },
    { name: 'edge-strong on surface', fg: 'edge-strong', bg: 'surface', floor: 1.4, strict: 3 },
    { name: 'focus on page', fg: 'focus', bg: 'page', floor: 3, strict: 4.5 },
  ]

  for (const theme of GENERATED) {
    const strict = theme.id === 'contrast'
    it.each(pairs)(`${theme.id}: $name`, ({ fg, bg, floor, strict: strictFloor }) => {
      const ratio = contrast(color(theme, fg), color(theme, bg))
      expect(ratio).toBeGreaterThanOrEqual(strict ? strictFloor : floor)
    })

    it(`${theme.id}: syntax tokens on the code background`, () => {
      const codeBg = color(theme, theme.scheme === 'dark' ? 'neutral-11' : 'neutral-10')
      const vars = parseVars(extractBlock(palettesCss, `[data-theme="${theme.id}"]`))
      for (const token of SYNTAX) {
        expect(contrast(vars[`--syntax-${token}`], codeBg), token).toBeGreaterThanOrEqual(strict ? 7 : 4.5)
      }
    })
  }
})
