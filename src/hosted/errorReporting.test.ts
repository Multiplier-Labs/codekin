// @vitest-environment jsdom
/** Tests for hosted-app error capture: only the app's own errors, only type/message/frames, capped per page. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installErrorReporting, stackFrames, toReport } from './errorReporting'

const ORIGIN = 'https://app.example.com'

function appError(message: string, name = 'TypeError'): Error {
  const err = new Error(message)
  err.name = name
  err.stack = `${name}: ${message}\n    at render (${ORIGIN}/assets/index-abc.js?v=2:1:2345)\n    at ${ORIGIN}/assets/vendor.js:3:4`
  return err
}

describe('stackFrames', () => {
  it('keeps paths only, for Chrome and Safari stacks', () => {
    expect(stackFrames(`E\n    at f (${ORIGIN}/assets/a.js?x=1#h:1:2)`, ORIGIN)).toEqual([{ filename: '/assets/a.js', function: 'f', lineno: 1, colno: 2 }])
    expect(stackFrames(`g@${ORIGIN}/assets/b.js:3:4`, ORIGIN)).toEqual([{ filename: '/assets/b.js', function: 'g', lineno: 3, colno: 4 }])
  })
})

describe('toReport', () => {
  it('reports the app\'s own errors with a truncated message', () => {
    const report = toReport(appError('x'.repeat(500)), ORIGIN)!
    expect(report.type).toBe('TypeError')
    expect(report.message).toHaveLength(200)
    expect(report.frames[0].filename).toBe('/assets/index-abc.js')
  })

  it('ignores errors from extensions and non-errors', () => {
    const ext = new Error('ext')
    ext.stack = 'Error: ext\n    at x (chrome-extension://abcdef/content.js:1:1)'
    expect(toReport(ext, ORIGIN)).toBeNull()
    expect(toReport('a string', ORIGIN)).toBeNull()
  })
})

describe('installErrorReporting', () => {
  let uninstall: (() => void) | null = null
  afterEach(() => { uninstall?.(); uninstall = null })

  it('sends uncaught errors and rejections once each, at most five per page', () => {
    const post = vi.fn()
    uninstall = installErrorReporting(post)
    // jsdom's origin is http://localhost:3000 by default; build stacks for it.
    const origin = window.location.origin
    const err = (msg: string) => {
      const e = new Error(msg)
      e.stack = `Error: ${msg}\n    at f (${origin}/assets/index.js:1:1)`
      return e
    }
    window.dispatchEvent(new ErrorEvent('error', { error: err('one') }))
    window.dispatchEvent(new ErrorEvent('error', { error: err('one') }))
    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(rejection, 'reason', { value: err('two') })
    window.dispatchEvent(rejection)
    expect(post.mock.calls.map(c => (c[0] as { message: string }).message)).toEqual(['one', 'two'])

    for (let i = 0; i < 10; i++) window.dispatchEvent(new ErrorEvent('error', { error: err(`n${i}`) }))
    expect(post).toHaveBeenCalledTimes(5)
    expect(Object.keys(post.mock.calls[0][0] as object).sort()).toEqual(['frames', 'message', 'type'])
  })
})
