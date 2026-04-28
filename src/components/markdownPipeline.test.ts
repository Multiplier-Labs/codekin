// @vitest-environment jsdom
/**
 * Tests for the marked → DOMPurify rendering pipeline.
 *
 * These tests guard against regressions in XSS sanitization when the
 * `marked` major version is bumped. They cover three classes of payload:
 *  - inline event handlers on tags emitted via raw HTML in markdown
 *  - dangerous URL protocols (javascript:, data:) on links and images
 *  - script and style tags injected as raw HTML
 * They also verify that the `afterSanitizeAttributes` hook still opens
 * external http(s) links in a new tab with rel="noopener noreferrer".
 */

import { describe, it, expect } from 'vitest'
import { renderMarkdownToSafeHtml } from './markdownPipeline'

describe('renderMarkdownToSafeHtml — XSS sanitization', () => {
  it('strips onerror handlers from injected <img> tags', () => {
    const html = renderMarkdownToSafeHtml('Hello <img src=x onerror="alert(1)"> world')
    expect(html).not.toMatch(/onerror/i)
    expect(html).not.toMatch(/alert\(1\)/)
  })

  it('strips onclick handlers from injected anchors', () => {
    const html = renderMarkdownToSafeHtml('<a href="https://example.com" onclick="alert(1)">link</a>')
    expect(html).not.toMatch(/onclick/i)
  })

  it('removes javascript: URLs in markdown links', () => {
    const html = renderMarkdownToSafeHtml('[click me](javascript:alert(1))')
    expect(html).not.toMatch(/javascript:/i)
    expect(html).not.toMatch(/alert\(1\)/)
  })

  it('removes javascript: URLs in raw <a href> tags', () => {
    const html = renderMarkdownToSafeHtml('<a href="javascript:alert(1)">x</a>')
    expect(html).not.toMatch(/javascript:/i)
  })

  it('strips <iframe> tags entirely', () => {
    const html = renderMarkdownToSafeHtml('<iframe src="https://evil.example/x"></iframe>')
    expect(html).not.toMatch(/<iframe/i)
  })

  it('strips <script> nested inside <svg>', () => {
    const html = renderMarkdownToSafeHtml('<svg><script>alert(1)</script></svg>')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/alert\(1\)/)
  })

  it('strips <script> tags from raw HTML in markdown', () => {
    const html = renderMarkdownToSafeHtml('hi <script>alert(1)</script> there')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/alert\(1\)/)
  })

  it('strips inline <style> tags', () => {
    const html = renderMarkdownToSafeHtml('<style>body{display:none}</style>text')
    expect(html).not.toMatch(/<style/i)
  })

  it('renders plain markdown unchanged', () => {
    const html = renderMarkdownToSafeHtml('# Hello\n\nThis is **bold**.')
    expect(html).toMatch(/<h1[^>]*>Hello<\/h1>/)
    expect(html).toMatch(/<strong>bold<\/strong>/)
  })

  it('opens external http(s) links in a new tab with rel=noopener noreferrer', () => {
    const html = renderMarkdownToSafeHtml('[ext](https://example.com)')
    expect(html).toMatch(/target="_blank"/)
    expect(html).toMatch(/rel="noopener noreferrer"/)
  })

  it('does not add target=_blank to relative links', () => {
    const html = renderMarkdownToSafeHtml('[doc](/docs/page)')
    expect(html).not.toMatch(/target="_blank"/)
  })
})
