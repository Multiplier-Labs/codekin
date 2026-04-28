/**
 * MarkdownRenderer — renders markdown content as sanitized HTML.
 *
 * The marked → DOMPurify pipeline lives in `./markdownPipeline` so it can be
 * unit tested independently of React rendering.
 */

import { useMemo } from 'react'
import { renderMarkdownToSafeHtml } from './markdownPipeline'

interface Props {
  content: string
}

export function MarkdownRenderer({ content }: Props) {
  const html = useMemo(() => renderMarkdownToSafeHtml(content), [content])

  return (
    <div
      className="docs-prose"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
