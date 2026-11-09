// @vitest-environment jsdom
/** In the desktop app, links to other sites go through a page navigation the app opens in the default browser. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { externalLinkTarget, installDesktopLinkHandler, isDesktopWebView } from './desktopLinks'

const PAGE = 'https://app.codekin.ai'

function click(html: string, init: { button?: number; defaultPrevented?: boolean } = {}) {
  document.body.innerHTML = html
  const target = document.querySelector('[data-click]') ?? document.querySelector('a')
  return externalLinkTarget({ button: init.button ?? 0, defaultPrevented: init.defaultPrevented ?? false, target }, PAGE, `${PAGE}/`)
}

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

describe('externalLinkTarget', () => {
  it('hands over links to other sites, including from inside the link', () => {
    expect(click('<a href="https://github.com/x/y" target="_blank" rel="noopener noreferrer">pr</a>')).toBe('https://github.com/x/y')
    expect(click('<a href="https://github.com/x"><code data-click>x</code></a>')).toBe('https://github.com/x')
    expect(click('<a href="mailto:a@b.c">mail</a>')).toBe('mailto:a@b.c')
  })

  it("leaves the app's own links, other schemes and non-primary clicks alone", () => {
    expect(click('<a href="/docs/x">docs</a>')).toBeNull()
    expect(click('<a href="https://app.codekin.ai/settings">s</a>')).toBeNull()
    expect(click('<a href="#top">top</a>')).toBeNull()
    expect(click('<a href="javascript:alert(1)">x</a>')).toBeNull()
    expect(click('<a href="https://github.com">x</a>', { button: 1 })).toBeNull()
    expect(click('<a href="https://github.com">x</a>', { defaultPrevented: true })).toBeNull()
    expect(click('<span data-click>no link</span>')).toBeNull()
  })
})

describe('installDesktopLinkHandler', () => {
  it('only acts in the desktop app', () => {
    expect(isDesktopWebView('Mozilla/5.0 … Safari/605.1.15 CodekinDesktop/0.11.1')).toBe(true)
    expect(isDesktopWebView('Mozilla/5.0 … Safari/605.1.15')).toBe(false)
    const listen = vi.spyOn(document, 'addEventListener')
    installDesktopLinkHandler(window)
    expect(listen).not.toHaveBeenCalled()
  })

  it('turns a click on an external link into a navigation of the page', () => {
    const assign = vi.fn()
    const fake = {
      navigator: { userAgent: 'Safari/605.1.15 CodekinDesktop/0.11.1' },
      location: { origin: window.location.origin, assign },
      document,
    } as unknown as Window
    installDesktopLinkHandler(fake)
    document.body.innerHTML = '<a href="https://github.com/x" target="_blank" rel="noopener">x</a><a href="/local">l</a>'
    const [external, local] = [...document.querySelectorAll('a')]
    const ext = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    external.dispatchEvent(ext)
    expect(assign).toHaveBeenCalledWith('https://github.com/x')
    expect(ext.defaultPrevented).toBe(true)
    const loc = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    local.dispatchEvent(loc)
    expect(assign).toHaveBeenCalledTimes(1)
  })
})
