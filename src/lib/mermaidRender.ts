/**
 * Mermaid for Canvas diagram items, loaded on first use (it is large).
 *
 * Rendering runs with `securityLevel: 'strict'`: labels are sanitized and
 * Mermaid's own click handlers are off. Codekin adds its own handlers to the
 * rendered nodes (see DiagramView) and looks each node up in the item's
 * metadata.
 *
 * The hosted app is served with `style-src 'self'`, which blocks the <style>
 * element and style attributes in Mermaid's SVG. `mountSvg` moves the
 * stylesheet into a constructed CSSStyleSheet and re-applies the style
 * attributes through CSSOM, neither of which CSP restricts.
 */

type Mermaid = typeof import('mermaid').default

let loading: Promise<Mermaid> | null = null
let configuredFor: string | null = null
let counter = 0

function load(): Promise<Mermaid> {
  loading ??= import('mermaid').then(m => m.default)
  return loading
}

/** Render Mermaid source to an SVG string, themed for the current light/dark scheme. */
export async function renderMermaid(source: string, scheme: 'light' | 'dark'): Promise<string> {
  const mermaid = await load()
  if (configuredFor !== scheme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: scheme === 'dark' ? 'dark' : 'neutral',
      fontFamily: 'Lato, sans-serif',
    })
    configuredFor = scheme
  }
  const id = `ck-mermaid-${++counter}`
  try {
    const { svg } = await mermaid.render(id, source)
    return svg
  } finally {
    // A failed render can leave its scratch element behind.
    document.getElementById(`d${id}`)?.remove()
  }
}

/**
 * Put an SVG string into `host` without inline <style> or style attributes,
 * so it renders the same under a strict style-src. Returns a cleanup that
 * drops the constructed stylesheet.
 */
export function mountSvg(host: HTMLElement, svgText: string): () => void {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const svg = doc.documentElement
  if (svg.nodeName !== 'svg') throw new Error('Mermaid did not return an SVG')

  let css = ''
  for (const style of Array.from(svg.querySelectorAll('style'))) {
    css += style.textContent ?? ''
    style.remove()
  }
  const inline: string[] = []
  for (const el of Array.from(svg.querySelectorAll('[style]')).concat(svg.hasAttribute('style') ? [svg] : [])) {
    el.setAttribute('data-ck-style', String(inline.length))
    inline.push(el.getAttribute('style') ?? '')
    el.removeAttribute('style')
  }

  const node = document.importNode(svg, true) as unknown as SVGSVGElement
  host.replaceChildren(node)
  for (const el of [node, ...Array.from(node.querySelectorAll('[data-ck-style]'))]) {
    const index = el.getAttribute('data-ck-style')
    if (index === null) continue
    ;(el as HTMLElement | SVGElement).style.cssText = inline[Number(index)]
    el.removeAttribute('data-ck-style')
  }

  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  return () => {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet)
  }
}

/** The Mermaid node id of a rendered flowchart node element (`flowchart-<id>-<n>`), or null. */
export function mermaidNodeId(el: Element): string | null {
  const m = /(?:^|-)flowchart-(.+)-\d+$/.exec(el.id)
  return m ? m[1] : null
}
