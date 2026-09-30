/**
 * Color math shared by the palette generator (scripts/generate-themes.mjs)
 * and the theme contrast tests: hex ↔ OKLCH conversion, sRGB gamut mapping,
 * and WCAG 2.x contrast ratios.
 *
 * Kept dependency-free and to erasable TypeScript so Node can run it
 * directly with type stripping.
 */

export type Rgb = [number, number, number]
export interface Oklch { l: number; c: number; h: number }

export function hexToRgb(hex: string): Rgb {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map(ch => ch + ch).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`Invalid hex color: ${hex}`)
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb
}

export function rgbToHex([r, g, b]: Rgb): string {
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toGamma = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

function linearToOklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabToLinear([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

export function hexToOklch(hex: string): Oklch {
  const [L, a, b] = linearToOklab(hexToRgb(hex).map(toLinear) as Rgb)
  const c = Math.hypot(a, b)
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360
  return { l: L, c, h }
}

function oklchToLinear({ l, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180
  return oklabToLinear([l, c * Math.cos(rad), c * Math.sin(rad)])
}

const inGamut = (rgb: Rgb) => rgb.every(v => v >= -1e-4 && v <= 1 + 1e-4)

/** OKLCH → hex, reducing chroma (keeping lightness and hue) until in sRGB gamut. */
export function oklchToHex(color: Oklch): string {
  let lo = 0
  let hi = color.c
  if (inGamut(oklchToLinear(color))) lo = hi
  else {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(oklchToLinear({ ...color, c: mid }))) lo = mid
      else hi = mid
    }
  }
  return rgbToHex(oklchToLinear({ ...color, c: lo }).map(toGamma) as Rgb)
}

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio between two colors (1–21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * Move `fg` along OKLCH lightness (away from `bg`) until it reaches `ratio`
 * against `bg`. Hue and chroma are kept, so the color keeps its identity.
 */
export function ensureContrast(fg: string, bg: string, ratio: number): string {
  if (contrast(fg, bg) >= ratio) return fg
  const base = hexToOklch(fg)
  const lighten = luminance(bg) < 0.18
  let out = fg
  for (let step = 1; step <= 100; step++) {
    const l = lighten ? base.l + (1 - base.l) * (step / 100) : base.l * (1 - step / 100)
    out = oklchToHex({ ...base, l })
    if (contrast(out, bg) >= ratio) return out
  }
  return out
}
