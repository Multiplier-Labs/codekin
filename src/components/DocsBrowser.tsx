/**
 * DocsBrowser — full document view replacing the message feed.
 *
 * Shows a nav bar with back button, file path, star toggle, and raw/rendered toggle,
 * followed by the rendered markdown content or raw source.
 */

import { IconChevronLeft, IconLoader2, IconStar, IconStarFilled } from '@tabler/icons-react'
import { MarkdownRenderer } from './MarkdownRenderer'

interface Props {
  repoName: string
  filePath: string
  content: string | null
  loading: boolean
  error: string | null
  rawMode: boolean
  isStarred: boolean
  onToggleRaw: () => void
  onToggleStar: () => void
  onClose: () => void
}

export function DocsBrowser({
  repoName,
  filePath,
  content,
  loading,
  error,
  rawMode,
  isStarred,
  onToggleRaw,
  onToggleStar,
  onClose,
}: Props) {
  return (
    <div className="relative flex flex-1 min-h-0 w-full flex-col">
      {/* Nav bar — inverted colors so it's clearly distinct from terminal */}
      <div className="docs-header flex items-center gap-2 px-4 py-2 border-b flex-shrink-0">
        <button
          onClick={onClose}
          className="docs-header-back flex items-center gap-1 text-body transition-colors cursor-pointer"
        >
          <IconChevronLeft size={14} stroke={2.5} />
          Back
        </button>
        <span className="docs-header-path flex-1 text-meta text-center truncate">
          {repoName} <span className="docs-header-slash">/</span> {filePath}
        </span>
        <button
          onClick={onToggleStar}
          className={`docs-header-star transition-colors cursor-pointer ${isStarred ? 'is-starred' : ''}`}
          title={isStarred ? 'Remove from favourites' : 'Add to favourites'}
        >
          {isStarred ? <IconStarFilled size={15} /> : <IconStar size={15} />}
        </button>
        <button
          onClick={onToggleRaw}
          className={`docs-header-toggle rounded-control px-2 py-0.5 text-body transition-colors cursor-pointer ${
            rawMode ? 'is-active' : ''
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
          <div className="rounded-control bg-error-10/50 px-3 py-2 text-body text-error-4 mx-4 mt-4">
            {error}
          </div>
        ) : content !== null ? (
          rawMode ? (
            <pre className="px-6 py-4 text-body text-neutral-3 whitespace-pre-wrap" style={{ fontFamily: "'Inconsolata', monospace" }}>
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
