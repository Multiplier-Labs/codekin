/**
 * Shared marked → DOMPurify rendering pipeline.
 *
 * Configures `marked` (GFM + syntax highlighting) and registers the
 * `afterSanitizeAttributes` hook that opens external links in new tabs and
 * turns remote images into links.
 * The configuration is idempotent so repeated imports/test runs do not
 * stack hooks or extensions on the singletons.
 */

import { marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import DOMPurify from 'dompurify'
import hljs from '../lib/hljs'
import { remoteImageHost, remoteImageLabel } from '../lib/remoteImage'

let configured = false

function configurePipeline() {
  if (configured) return
  configured = true

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

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    // Remote images become a link the user can open, never a fetch
    // (see lib/remoteImage.ts). The link is sanitized next, by this hook too.
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src')
      const host = remoteImageHost(src)
      if (src && host) {
        const link = node.ownerDocument.createElement('a')
        link.setAttribute('href', src)
        link.setAttribute('title', src)
        link.setAttribute('class', 'external-image-link')
        link.textContent = remoteImageLabel(host, node.getAttribute('alt'))
        node.replaceWith(link)
        return
      }
    }
    if (node.tagName === 'A' && node.getAttribute('href')?.startsWith('http')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

export function renderMarkdownToSafeHtml(content: string): string {
  configurePipeline()
  return DOMPurify.sanitize(marked.parse(content, { gfm: true }) as string)
}
