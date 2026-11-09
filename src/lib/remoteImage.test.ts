// @vitest-environment jsdom
/** Tests for which image URLs count as remote (rendered as links, never loaded). */
import { describe, it, expect } from 'vitest'
import { classifyImageSrc, remoteImageLabel } from './remoteImage'

const HTTPS_PAGE = 'https://app.example.com/s/abc'
const HTTP_PAGE = 'http://localhost:32352/'

describe('classifyImageSrc', () => {
  it.each([
    [HTTPS_PAGE, 'https://attacker.example/x.png', 'https://attacker.example/x.png', 'attacker.example'],
    [HTTPS_PAGE, 'http://attacker.example:8080/x.png', 'http://attacker.example:8080/x.png', 'attacker.example:8080'],
    [HTTPS_PAGE, '//attacker.example/x.png', 'https://attacker.example/x.png', 'attacker.example'],
    [HTTPS_PAGE, '  HTTPS://Attacker.Example/x.png', 'https://attacker.example/x.png', 'attacker.example'],
    // Spellings browsers resolve to another host.
    [HTTP_PAGE, 'https:/attacker.example/x', 'https://attacker.example/x', 'attacker.example'],
    [HTTPS_PAGE, 'http:/attacker.example/x', 'http://attacker.example/x', 'attacker.example'],
    [HTTPS_PAGE, '/\\attacker.example/x', 'https://attacker.example/x', 'attacker.example'],
    [HTTP_PAGE, '/\\attacker.example/x', 'http://attacker.example/x', 'attacker.example'],
    [HTTPS_PAGE, 'https:\\\\attacker.example/x', 'https://attacker.example/x', 'attacker.example'],
    [HTTPS_PAGE, '\\\\attacker.example/x', 'https://attacker.example/x', 'attacker.example'],
    [HTTPS_PAGE, 'https://app.example.com:8443/x', 'https://app.example.com:8443/x', 'app.example.com:8443'],
  ])('on %s, %s is remote', (page, src, href, host) => {
    expect(classifyImageSrc(src, page)).toEqual({ kind: 'remote', href, host })
  })

  it.each([
    ['data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
    ['/screenshots/a.png', 'https://app.example.com/screenshots/a.png'],
    ['a.png', 'https://app.example.com/s/a.png'],
    ['https://app.example.com/a.png', 'https://app.example.com/a.png'],
    // Same scheme as the page: a path on this origin, not another host.
    ['https:/app-path/x', 'https://app.example.com/app-path/x'],
  ])('%s loads from this origin', (src, resolved) => {
    expect(classifyImageSrc(src, HTTPS_PAGE)).toEqual({ kind: 'local', src: resolved })
  })

  it.each([
    undefined,
    '',
    '   ',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<b>x</b>',
    'blob:https://app.example.com/1234',
    'file:///etc/passwd',
    'https://[bad',
  ])('%s is not loadable', src => {
    expect(classifyImageSrc(src, HTTPS_PAGE)).toEqual({ kind: 'blocked' })
  })

  it('resolves against the document base URL by default', () => {
    expect(classifyImageSrc('/\\attacker.example/x').kind).toBe('remote')
    expect(classifyImageSrc('/a.png').kind).toBe('local')
  })
})

describe('remoteImageLabel', () => {
  it('names the host, and the alt text when there is one', () => {
    expect(remoteImageLabel('cdn.example', '')).toBe('External image (cdn.example)')
    expect(remoteImageLabel('cdn.example', ' chart ')).toBe('External image: chart (cdn.example)')
  })
})
