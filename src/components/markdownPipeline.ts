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
import { classifyImageSrc, remoteImageLabel } from '../lib/remoteImage'

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
      const image = classifyImageSrc(node.getAttribute('src'))
      if (image.kind === 'remote') {
        const link = node.ownerDocument.createElement('a')
        link.setAttribute('href', image.href)
        link.setAttribute('title', image.href)
        link.setAttribute('class', 'external-image-link')
        link.textContent = remoteImageLabel(image.host, node.getAttribute('alt'))
        node.replaceWith(link)
        return
      }
      if (image.kind === 'blocked') node.removeAttribute('src')
      else node.setAttribute('src', image.src)
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
