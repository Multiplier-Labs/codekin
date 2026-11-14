// @vitest-environment jsdom
/** mountSvg: untrusted diagram SVG goes into Codekin's origin without links, forms or inline styles. */
import { describe, expect, it } from 'vitest'
import { mountSvg } from './mermaidRender'

// jsdom has no constructable stylesheets.
class FakeSheet { replaceSync() {} }
;(globalThis as unknown as { CSSStyleSheet: unknown }).CSSStyleSheet = FakeSheet
Object.defineProperty(document, 'adoptedStyleSheets', { value: [], writable: true })

describe('mountSvg', () => {
  it('removes links and form controls from labels, and moves styles out of the markup', () => {
    const host = document.createElement('div')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" style="max-width:100px">
      <style>#d1 .node{fill:red}</style>
      <a xlink:href="https://evil.example/phish" href="https://evil.example/2" target="_top"><g class="node"><text>A</text></g></a>
      <foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><form action="https://evil.example"><input name="t"/><button>go</button></form>label</div></foreignObject>
    </svg>`
    const cleanup = mountSvg(host, svg)
    const a = host.querySelector('a')!
    expect(a.getAttribute('href')).toBeNull()
    expect(a.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBeNull()
    expect(a.getAttribute('target')).toBeNull()
    expect(host.querySelector('form, input, button, style')).toBeNull()
    expect(host.textContent).toContain('label')
    expect((host.firstElementChild as SVGSVGElement).getAttribute('style')).toBe('max-width: 100px;')
    cleanup()
  })
})
