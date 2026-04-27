/** Tests for generate404Page and generate500Page — verifies the static HTML
 * payloads contain their expected status codes, headings, and the home link. */
import { describe, it, expect } from 'vitest'
import { generate404Page, generate500Page } from './error-page.js'

describe('generate404Page', () => {
  it('returns a complete HTML document', () => {
    const html = generate404Page()
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<html')
    expect(html).toContain('</html>')
    expect(html).toContain('<head>')
    expect(html).toContain('<body>')
  })

  it('contains the 404 status code and "Page not found" heading', () => {
    const html = generate404Page()
    expect(html).toContain('>404<')
    expect(html).toContain('Page not found')
  })

  it('uses the dark theme class on <html>', () => {
    expect(generate404Page()).toContain('<html lang="en" class="dark">')
  })

  it('includes the Codekin <title>', () => {
    expect(generate404Page()).toContain('<title>404 — Codekin</title>')
  })

  it('renders a "Go to Home" link pointing at /', () => {
    const html = generate404Page()
    expect(html).toContain('href="/"')
    expect(html).toContain('Go to Home')
  })

  it('embeds the Codekin font links and favicon', () => {
    const html = generate404Page()
    expect(html).toContain('Inconsolata')
    expect(html).toContain('Lato')
    expect(html).toContain('/favicon.svg')
  })
})

describe('generate500Page', () => {
  it('returns a complete HTML document', () => {
    const html = generate500Page()
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('</html>')
  })

  it('contains the 500 status code and "Something went wrong" heading', () => {
    const html = generate500Page()
    expect(html).toContain('>500<')
    expect(html).toContain('Something went wrong')
  })

  it('uses the error red colour for the 500 code (#d94444)', () => {
    expect(generate500Page()).toContain('#d94444')
  })

  it('includes the Codekin error <title>', () => {
    expect(generate500Page()).toContain('<title>Error — Codekin</title>')
  })

  it('renders a "Go to Home" link pointing at /', () => {
    const html = generate500Page()
    expect(html).toContain('href="/"')
    expect(html).toContain('Go to Home')
  })

  it('does not contain the 404 marker', () => {
    expect(generate500Page()).not.toContain('>404<')
  })
})
