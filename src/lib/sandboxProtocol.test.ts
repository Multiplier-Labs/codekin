/** Tests for sandbox message parsing and where the sandbox origin comes from. */
import { describe, it, expect } from 'vitest'
import { parseFromSandbox } from './sandboxProtocol'
import { originFrom } from '../hooks/useSandboxOrigin'

describe('parseFromSandbox', () => {
  it('accepts the known messages and drops everything else', () => {
    expect(parseFromSandbox({ type: 'codekin-sandbox:ready' })).toEqual({ type: 'codekin-sandbox:ready' })
    expect(parseFromSandbox({ type: 'codekin-sandbox:rendered', id: '1' })).toEqual({ type: 'codekin-sandbox:rendered', id: '1' })
    expect(parseFromSandbox({ type: 'codekin-sandbox:selection', id: '1', label: 'x 1–2', excerpt: 'rows' })).toMatchObject({ label: 'x 1–2' })
    expect(parseFromSandbox({ type: 'codekin-sandbox:selection', id: '1', label: '', excerpt: 'rows' })).toBeNull()
    expect(parseFromSandbox({ type: 'codekin-sandbox:navigate', url: 'https://evil.example' })).toBeNull()
    expect(parseFromSandbox('codekin-sandbox:ready')).toBeNull()
  })
  it('caps text it is handed', () => {
    const msg = parseFromSandbox({ type: 'codekin-sandbox:selection', id: '1', label: 'l'.repeat(500), excerpt: 'e'.repeat(20000) })
    expect(msg && 'label' in msg && msg.label.length).toBe(120)
    expect(msg && 'excerpt' in msg && msg.excerpt.length).toBe(8000)
  })
})

describe('originFrom', () => {
  const loc = { protocol: 'https:', hostname: 'codekin.example.com' }
  it('prefers a configured origin, else the same host on the sandbox port', () => {
    expect(originFrom({ origin: 'https://s.example.net', port: null }, loc)).toBe('https://s.example.net')
    expect(originFrom({ origin: null, port: 32353 }, loc)).toBe('https://codekin.example.com:32353')
    expect(originFrom({ origin: null, port: 32353 }, { protocol: 'http:', hostname: '::1' })).toBe('http://[::1]:32353')
    expect(originFrom({ origin: null, port: null }, loc)).toBeNull()
    expect(originFrom(null, loc)).toBeNull()
  })
})
