/**
 * The body of a Canvas item. Markdown renders through the shared sanitized
 * pipeline and images only through <img> (so SVG scripts never run). Tables
 * and diagrams show their source until their renderers land in slice 3.
 */

import { IconAlertTriangle, IconLoader2 } from '@tabler/icons-react'
import type { CanvasView } from '../../hooks/useCanvas'
import { MarkdownRenderer } from '../MarkdownRenderer'

export function CanvasItemView({ view }: { view: Exclude<CanvasView, { state: 'empty' }> }) {
  if (view.state === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-meta text-ink-muted" role="status">
        <IconLoader2 size={18} className="animate-spin" />
        Loading {view.item.title}…
      </div>
    )
  }
  if (view.state === 'error') {
    return (
      <div className="mx-auto mt-10 flex max-w-[560px] items-start gap-2.5 rounded-control border border-error-8 bg-error-11 px-4 py-3 text-body text-error-5" role="alert">
        <IconAlertTriangle size={18} className="mt-0.5 shrink-0" />
        <div>
          <div className="font-bold">Couldn't load {view.item.title}</div>
          <div className="text-meta">{view.message}</div>
        </div>
      </div>
    )
  }

  const { item, content } = view
  if (item.kind === 'markdown') {
    return (
      <div className="mx-auto w-full max-w-[680px] px-8 py-8">
        <MarkdownRenderer content={content.content} />
      </div>
    )
  }
  if (item.kind === 'image') {
    return (
      <div className="flex flex-1 items-start justify-center p-8">
        <img
          src={`data:${content.mediaType};base64,${content.content}`}
          alt={item.title}
          className="max-h-full max-w-full rounded-control border border-edge bg-surface object-contain"
        />
      </div>
    )
  }
  // Tables and diagrams: source until their renderers land.
  return (
    <pre className="px-8 py-6 font-mono text-body text-ink whitespace-pre-wrap break-words">{content.content}</pre>
  )
}
