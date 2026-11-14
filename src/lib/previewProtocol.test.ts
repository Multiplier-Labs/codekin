import { describe, expect, it } from 'vitest'
import { consoleContext, entryUrl, parseFromPreview, pickedContext, previewOrigin, serverLogContext } from './previewProtocol'

describe('parseFromPreview', () => {
  it('accepts the script\'s messages and clips their text', () => {
    expect(parseFromPreview({ type: 'codekin-preview:ready', extra: 1 })).toEqual({ type: 'codekin-preview:ready' })
    expect(parseFromPreview({ type: 'codekin-preview:location', path: '/a', title: 'A' })).toEqual({ type: 'codekin-preview:location', path: '/a', title: 'A' })
    const long = parseFromPreview({ type: 'codekin-preview:console', level: 'nonsense', message: 'x'.repeat(5000) })
    expect(long).toMatchObject({ level: 'error' })
    expect(long?.type === 'codekin-preview:console' && long.message.length).toBe(4001)
  })

  it('drops anything else', () => {
    expect(parseFromPreview(null)).toBeNull()
    expect(parseFromPreview('codekin-preview:ready')).toBeNull()
    expect(parseFromPreview({ type: 'codekin-sandbox:ready' })).toBeNull()
  })

  it('normalizes a picked element', () => {
    const msg = parseFromPreview({ type: 'codekin-preview:picked', selector: '#save', tag: 'button', text: 'Save', html: '<button id="save">Save</button>', rect: { x: 1.4, y: 'no' }, component: { name: 'SaveButton', source: 7 } })
    expect(msg).toEqual({
      type: 'codekin-preview:picked',
      picked: { selector: '#save', tag: 'button', label: '', text: 'Save', html: '<button id="save">Save</button>', rect: { x: 1, y: 0, width: 0, height: 0 }, path: '/', component: { name: 'SaveButton' } },
    })
  })
})

describe('preview URLs', () => {
  it('uses the host the browser reaches Codekin by', () => {
    expect(previewOrigin(32362, { hostname: 'localhost' })).toBe('http://localhost:32362')
    expect(previewOrigin(32362, { hostname: '[::1]' })).toBe('http://[::1]:32362')
    expect(previewOrigin(32362, { hostname: '::1' })).toBe('http://[::1]:32362')
  })

  it('opens the entry URL at another path', () => {
    const entry = '/__codekin/enter?k=abc&to=%2F'
    expect(entryUrl('http://localhost:1', entry)).toBe('http://localhost:1/__codekin/enter?k=abc&to=%2F')
    expect(entryUrl('http://localhost:1', entry, '/settings?tab=2')).toBe('http://localhost:1/__codekin/enter?k=abc&to=%2Fsettings%3Ftab%3D2')
    expect(entryUrl('http://localhost:1', entry, '//evil.example.com')).toContain('to=%2Fevil.example.com')
  })
})

describe('context for the agent', () => {
  it('describes a picked element', () => {
    const c = pickedContext({ selector: 'main > button', tag: 'button', label: 'button.primary', text: 'Save changes', html: '<button>Save changes</button>', rect: { x: 10, y: 20, width: 80, height: 32 }, path: '/settings', component: { name: 'SaveButton', source: 'src/Save.tsx:12' } }, 5173)
    expect(c.label).toBe('<SaveButton> “Save changes”')
    expect(c.excerpt).toContain('localhost:5173/settings')
    expect(c.excerpt).toContain('selector: main > button')
    expect(c.excerpt).toContain('component: SaveButton (src/Save.tsx:12)')
  })

  it('sends errors, or warnings when there are none', () => {
    const at = 0
    expect(consoleContext([{ level: 'warn', message: 'w', path: '/', at }, { level: 'error', message: 'boom', path: '/x', at }], 3000))
      .toEqual({ label: '1 console error', excerpt: 'Browser console errors from the live preview (localhost:3000):\n\n[error on /x] boom' })
    expect(consoleContext([{ level: 'warn', message: 'w', path: '/', at }], 3000).label).toBe('1 console warning')
  })

  it('sends the tail of the server output', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const c = serverLogContext(lines, 'web')
    expect(c.label).toBe('web output (80 lines)')
    expect(c.excerpt.split('\n')).toHaveLength(81)
  })
})
