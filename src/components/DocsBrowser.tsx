/**
 * DocsBrowser — full document view replacing the message feed.
 *
 * Shows a nav bar with back button, file path, and raw/rendered toggle,
 * followed by the rendered markdown content or raw source.
 */

import { IconChevronLeft, IconLoader2 } from '@tabler/icons-react'
import { MarkdownRenderer } from './MarkdownRenderer'

interface Props {
  repoName: string
  filePath: string
  content: string | null
  loading: boolean
  error: string | null
  rawMode: boolean
  onToggleRaw: () => void
  onClose: () => void
}

export function DocsBrowser({
  repoName,
  filePath,
  content,
  loading,
  error,
  rawMode,
  onToggleRaw,
  onClose,
}: Props) {
  return (
    <div className="relative flex flex-1 min-h-0 w-full flex-col">
      {/* Nav bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-10 bg-neutral-11/50 flex-shrink-0">
        <button
          onClick={onClose}
          className="flex items-center gap-1 text-[13px] text-neutral-4 hover:text-neutral-1 transition-colors cursor-pointer"
        >
          <IconChevronLeft size={14} stroke={2.5} />
          Back
        </button>
        <span className="flex-1 text-[13px] text-neutral-5 text-center truncate">
          {repoName} <span className="text-neutral-7">/</span> {filePath}
        </span>
        <button
          onClick={onToggleRaw}
          className={`rounded px-2 py-0.5 text-[13px] transition-colors cursor-pointer ${
            rawMode
              ? 'bg-neutral-9 text-neutral-2'
              : 'text-neutral-5 hover:text-neutral-2 hover:bg-neutral-9'
          }`}
        >
          {rawMode ? 'Rendered' : 'Raw'}
        </button>
      </div>

      {/* Content area */}
      <div className="chat-scroll flex-1 overflow-y-auto min-h-0">
        {/* Accent top border */}
        <div className="border-t-2 border-accent-8/40" />

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <IconLoader2 size={20} className="animate-spin text-neutral-5" />
          </div>
        ) : error ? (
          <div className="rounded-md bg-error-10/50 px-3 py-2 text-[13px] text-error-4 mx-4 mt-4">
            {error}
          </div>
        ) : content !== null ? (
          rawMode ? (
            <pre className="px-6 py-4 text-[14px] text-neutral-3 whitespace-pre-wrap" style={{ fontFamily: "'Inconsolata', monospace" }}>
              {content}
            </pre>
          ) : (
            <div className="mx-auto max-w-[720px] px-6 py-4">
              <MarkdownRenderer content={content} />
            </div>
          )
        ) : null}
      </div>
    </div>
  )
}
