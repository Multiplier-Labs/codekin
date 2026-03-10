/**
 * MarkdownRenderer — renders markdown content as sanitized HTML.
 *
 * Uses `marked` for GFM parsing, `marked-highlight` + `highlight.js` for
 * syntax highlighting, and `DOMPurify` for XSS protection.
 */

import { useMemo } from 'react'
import { marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from '../lib/hljs'
import DOMPurify from 'dompurify'

// Configure marked with syntax highlighting
marked.use(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value
      }
      return code
    },
  }),
)

// Make external links open in new tabs
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')?.startsWith('http')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

interface Props {
  content: string
}

export function MarkdownRenderer({ content }: Props) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(content, { gfm: true }) as string),
    [content],
  )

  return (
    <div
      className="docs-prose"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
