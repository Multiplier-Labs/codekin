/** ChatView renders fenced code as a scrolling block, with or without a language tag. */
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

describe('ChatView code blocks', () => {
  it.each([
    ['without a language', '```\nfirst line\n<b>second</b> line\n```'],
    ['with an unknown language', '```nosuchlang\nfirst line\n<b>second</b> line\n```'],
    ['with a known language', '```bash\nfirst line\n<b>second</b> line\n```'],
  ])('renders a fenced block %s in a horizontal scroller', (_label, md) => {
    const view = renderAssistant(md)
    const block = view.querySelector<HTMLElement>('pre .hljs')
    expect(block).not.toBeNull()
    expect(block!.style.overflowX).toBe('auto')
    expect(block!.textContent).toBe('first line\n<b>second</b> line')
    expect(block!.querySelector('b')).toBeNull()
    // No inline-code pill inside the block.
    expect(view.querySelector('pre code')).toBeNull()
  })

  it('keeps inline code inline', () => {
    const view = renderAssistant('run `npm test` now')
    expect(view.querySelector('.hljs')).toBeNull()
    expect(view.querySelector('p > code')?.textContent).toBe('npm test')
  })
})
