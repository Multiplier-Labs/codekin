/**
 * Stand-in for a remote image in rendered markdown: a link the user can choose
 * to open, so the browser never fetches the image by itself (see remoteImage.ts).
 */

import { IconPhoto } from '@tabler/icons-react'
import type { ImgHTMLAttributes } from 'react'
import { classifyImageSrc, remoteImageLabel } from '../lib/remoteImage'

export function ExternalImageLink({ src, host, alt }: { src: string; host: string; alt?: string }) {
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      title={src}
      className="inline-flex items-center gap-1 rounded-control border border-edge px-1.5 py-0.5 text-meta text-ink-muted no-underline hover:text-ink"
    >
      <IconPhoto size={14} stroke={1.75} aria-hidden="true" />
      {remoteImageLabel(host, alt)}
    </a>
  )
}

/**
 * react-markdown `img` override for transcripts that need no other image
 * handling: remote images become links, unloadable ones are dropped, and
 * everything else renders as is.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- `node` is react-markdown's hast node, not a DOM attribute
export function MarkdownImage({ src, alt, node, ...props }: ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
  const image = classifyImageSrc(typeof src === 'string' ? src : undefined)
  if (image.kind === 'remote') return <ExternalImageLink src={image.href} host={image.host} alt={alt} />
  if (image.kind === 'blocked') return alt ? <span>{alt}</span> : null
  return <img src={image.src} alt={alt ?? ''} className="max-w-full" {...props} />
}
