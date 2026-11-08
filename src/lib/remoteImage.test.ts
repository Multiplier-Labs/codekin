/** Tests for which image URLs count as remote (rendered as links, never loaded). */
import { describe, it, expect } from 'vitest'
import { remoteImageHost, remoteImageLabel } from './remoteImage'

const ORIGIN = 'https://app.example.com'

describe('remoteImageHost', () => {
  it.each([
    ['https://attacker.example/x.png', 'attacker.example'],
    ['http://attacker.example:8080/x.png', 'attacker.example:8080'],
    ['//attacker.example/x.png', 'attacker.example'],
    ['  HTTPS://Attacker.Example/x.png', 'attacker.example'],
  ])('%s is remote', (src, host) => {
    expect(remoteImageHost(src, ORIGIN)).toBe(host)
  })

  it.each([
    undefined,
    '',
    'data:image/png;base64,AAAA',
    '/screenshots/a.png',
    'a.png',
    'https://app.example.com/a.png',
    'javascript:alert(1)',
    'https://[bad',
  ])('%s is not remote', src => {
    expect(remoteImageHost(src, ORIGIN)).toBeNull()
  })
})

describe('remoteImageLabel', () => {
  it('names the host, and the alt text when there is one', () => {
    expect(remoteImageLabel('cdn.example', '')).toBe('External image (cdn.example)')
    expect(remoteImageLabel('cdn.example', ' chart ')).toBe('External image: chart (cdn.example)')
  })
})
