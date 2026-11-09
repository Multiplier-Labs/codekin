/** ChatView shows images from other origins as links, however their URL is spelled. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatView } from './ChatView'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

function renderAssistant(text: string): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(<ChatView messages={[{ type: 'assistant', text, complete: true, key: 'a' }]} fontSize={14} />) })
  return container
}

describe('ChatView images', () => {
  it.each([
    // The test page is http:, so a scheme-relative-looking https: URL resolves to another host.
    ['https:/evil.test/x', 'https://evil.test/x'],
    ['HTTPS://evil.test/x', 'https://evil.test/x'],
  ])('renders %s as a link, not an <img>', (src, href) => {
    const view = renderAssistant(`see ![chart](${src})`)
    expect(view.querySelector('img')).toBeNull()
    const link = view.querySelector(`a[href="${href}"]`)
    expect(link?.textContent).toBe('External image: chart (evil.test)')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('still loads same-origin images', () => {
    const view = renderAssistant('see ![chart](/screenshots/a.png)')
    expect(view.querySelector('img')?.getAttribute('src')).toBe(`${window.location.origin}/screenshots/a.png`)
  })
})
