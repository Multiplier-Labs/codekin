/**
 * Main chat display area for a Claude session.
 *
 * Renders a scrollable message feed with system banners, user bubbles,
 * markdown-rendered assistant responses (with syntax highlighting),
 * collapsible tool activity groups, and an activity indicator showing
 * what Claude is currently doing.
 *
 * Auto-scrolls to the bottom on new messages when the user is near the
 * bottom, with a manual "scroll to bottom" button when scrolled up.
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from '../lib/hljs'
import { IconArrowDown, IconRobotFace } from '@tabler/icons-react'
import type { ChatMessage } from '../types'
import { formatModelName, formatUserText } from '../lib/chatFormatters'

/** Visual theme variant — 'orchestrator' uses accent colors for the non-coding assistant persona. */
export type ChatViewVariant = 'default' | 'orchestrator'

interface Props {
  /** Ordered array of chat messages to render (user, assistant, tool, system, etc.). */
  messages: ChatMessage[]
  /** Base font size in pixels for message text. Code blocks use `fontSize - 1`. */
  fontSize: number
  /** When true, shows a full-screen overlay prompting the user to configure their token. */
  disabled?: boolean
  /** When true, displays a sticky "Plan Mode" banner at the top of the chat area. */
  planningMode?: boolean
  /** Current activity label (e.g. "Reading file..."). Shows the spinning activity indicator when set. */
  activityLabel?: string
  /** Adjusts layout for narrow viewports (wider user bubbles, larger touch targets). */
  isMobile?: boolean
  /** Visual variant — 'orchestrator' uses accent colors for assistant messages and indicators. */
  variant?: ChatViewVariant
}

/** Try to parse an API error JSON from a system error message and return structured parts. */
function parseApiError(text: string): { prefix: string; errorType: string; message: string; requestId?: string } | null {
  // Match patterns like "Failed to authenticate. API Error: 401 {...}" or just "{...}" at the end
  const jsonMatch = text.match(/^(.*?)\s*(\{.+\})\s*$/)
  if (!jsonMatch) return null
  try {
    const parsed = JSON.parse(jsonMatch[2])
    if (parsed?.error?.message) {
      return {
        prefix: jsonMatch[1].replace(/\s*$/, ''),
        errorType: parsed.error.type || 'error',
        message: parsed.error.message,
        requestId: parsed.request_id,
      }
    }
  } catch { /* not JSON */ }
  return null
}

/** Renders system banners (init, error, exit, notification) with color-coded dot and optional API error formatting. */
function SystemMessage({ msg }: { msg: ChatMessage & { type: 'system' } }) {
  const colorClass = msg.subtype === 'init'
    ? 'text-success-5'
    : msg.subtype === 'notification'
    ? 'text-primary-5'
    : msg.subtype === 'exit' || msg.subtype === 'stall' || msg.subtype === 'restart'
    ? 'text-warning-5'
    : msg.subtype === 'info'
    ? 'text-neutral-5'
    : 'text-error-5'

  const dotClass = msg.subtype === 'init'
    ? 'bg-success-5'
    : msg.subtype === 'notification'
    ? 'bg-primary-5'
    : msg.subtype === 'exit' || msg.subtype === 'stall' || msg.subtype === 'restart'
    ? 'bg-warning-5'
    : msg.subtype === 'info'
    ? 'bg-neutral-5'
    : 'bg-error-5'

  const modelLabel = msg.model ? ` (${formatModelName(msg.model)})` : ''

  // Try to format API errors nicely
  const apiError = msg.subtype === 'error' ? parseApiError(msg.text) : null

  if (apiError) {
    return (
      <div className={`px-4 py-2 text-[15px] ${colorClass}`}>
        <div className="flex items-center gap-2">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass} flex-shrink-0`} />
          <span className="font-semibold">{apiError.prefix || 'API Error'}</span>
        </div>
        <div className="ml-3.5 mt-1 space-y-0.5 text-[14px] opacity-90">
          <div>{apiError.message}</div>
          {apiError.requestId && (
            <div className="opacity-50 text-[12px] font-mono">Request ID: {apiError.requestId}</div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={`px-4 py-1.5 text-[15px] ${colorClass} flex items-center gap-2`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass} flex-shrink-0`} />
      {msg.text}{modelLabel}
    </div>
  )
}

function UserMessage({ msg, fontSize, isMobile }: { msg: ChatMessage & { type: 'user' }; fontSize: number; isMobile?: boolean }) {
  return (
    <div className="px-4 py-2">
      <div
        className={`user-bubble rounded-lg bg-neutral-10/60 px-3 py-2 text-neutral-3 whitespace-pre-wrap ${isMobile ? 'max-w-[95%]' : 'max-w-[80%]'}`}
        style={{ fontSize: `${fontSize}px` }}
      >
        {formatUserText(msg.text)}
      </div>
    </div>
  )
}

function CodeCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [code])

  return (
    <button
      onClick={handleCopy}
      className="absolute top-2 right-2 rounded p-1 opacity-0 transition-opacity group-hover/codeblock:opacity-100 bg-neutral-8/80 hover:bg-neutral-7 text-neutral-4 hover:text-neutral-2 cursor-pointer"
      title="Copy to clipboard"
    >
      {copied ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
      )}
    </button>
  )
}

function highlightCode(code: string, lang: string): string {
  if (hljs.getLanguage(lang)) {
    return hljs.highlight(code, { language: lang }).value
  }
  return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function AssistantMessage({ msg, fontSize, variant = 'default' }: { msg: ChatMessage & { type: 'assistant' }; fontSize: number; variant?: ChatViewVariant }) {
  return (
    <div className={`px-4 py-2 ${variant === 'orchestrator' ? 'orchestrator-assistant-msg' : ''}`}>
      <div
        className="prose prose-themed max-w-none"
        style={{ fontSize: `${fontSize}px` }}
      >
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '')
              const codeString = String(children).replace(/\n$/, '')
              if (match) {
                return (
                  <div className="group/codeblock relative">
                    <div
                      className="hljs"
                      style={{
                        margin: '0.5em 0',
                        borderRadius: '6px',
                        fontSize: `${fontSize - 1}px`,
                        padding: '1em',
                        overflowX: 'auto',
                      }}
                      dangerouslySetInnerHTML={{ __html: highlightCode(codeString, match[1]) }}
                    />
                    <CodeCopyButton code={codeString} />
                  </div>
                )
              }
              return (
                <code className={`${className || ''} rounded bg-neutral-10 px-1.5 py-0.5`} {...props}>
                  {children}
                </code>
              )
            },
            a({ href, children, ...props }) {
              const safeHref = href && /^(https?:|mailto:|\/|#)/i.test(href) ? href : '#'
              return <a href={safeHref} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
            },
            img({ src, alt, ...props }) {
              return (
                <img
                  src={src}
                  alt={alt || 'Image'}
                  className="max-w-full max-h-96 rounded-lg border border-neutral-8 my-2"
                  loading="lazy"
                  {...props}
                />
              )
            },
          }}
        >
          {msg.text}
        </Markdown>
      </div>
    </div>
  )
}

function ToolGroupInline({ msg, fontSize }: { msg: ChatMessage & { type: 'tool_group' }; fontSize: number }) {
  const smallSize = fontSize - 1
  return (
    <div
      className="flex flex-wrap gap-x-4 gap-y-0.5 text-neutral-4"
      style={{ fontSize: `${smallSize}px`, fontFamily: "'Inconsolata', monospace" }}
    >
      {msg.tools.map((tool, i) => (
        <span key={i} className="flex items-center gap-1.5 whitespace-nowrap overflow-hidden">
          {tool.active ? (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary-5 animate-pulse flex-shrink-0" />
          ) : (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-6 flex-shrink-0" />
          )}
          <span className="text-accent-6">{tool.name}</span>
          {tool.summary && (
            <span className="text-neutral-5 truncate max-w-[400px]">{tool.summary}</span>
          )}
        </span>
      ))}
    </div>
  )
}

function ToolOutputInline({ msg, fontSize }: { msg: ChatMessage & { type: 'tool_output' }; fontSize: number }) {
  const [expanded, setExpanded] = useState(false)
  const smallSize = fontSize - 1
  const colorClass = msg.isError ? 'text-error-5' : 'text-neutral-5'
  const lines = msg.content.split('\n')
  const collapsible = lines.length > 3
  const displayContent = collapsible && !expanded
    ? lines.slice(0, 3).join('\n')
    : msg.content
  return (
    <div
      className={`pl-4 py-0.5 ${colorClass}`}
      style={{ fontSize: `${smallSize}px`, fontFamily: "'Inconsolata', monospace" }}
    >
      <div className="whitespace-pre-wrap break-all">{displayContent}</div>
      {collapsible && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-neutral-6 hover:text-neutral-3 transition-colors mt-0.5"
          style={{ fontSize: `${smallSize}px` }}
        >
          {expanded ? '▴ collapse' : `▾ ${lines.length - 3} more lines`}
        </button>
      )}
    </div>
  )
}

interface ToolRun {
  groups: (ChatMessage & { type: 'tool_group' })[]
  outputs: (ChatMessage & { type: 'tool_output' })[]
  images: (ChatMessage & { type: 'image' })[]
}

function ToolActivity({ run, fontSize }: { run: ToolRun; fontSize: number }) {
  const hasActive = run.groups.some(g => g.tools.some(t => t.active))
  const [expanded, setExpanded] = useState(false)
  const isOpen = hasActive || expanded
  const smallSize = fontSize - 1

  // Collect all unique tool names for the summary
  const allTools = run.groups.flatMap(g => g.tools)
  const uniqueNames = [...new Set(allTools.map(t => t.name))]
  const toolCount = allTools.length
  const errorCount = run.outputs.filter(o => o.isError).length

  return (
    <div className="px-4 py-0.5">
      <button
        onClick={() => setExpanded(!isOpen)}
        className="flex items-center gap-1.5 text-neutral-5 hover:text-neutral-3 transition-colors w-full text-left"
        style={{ fontSize: `${smallSize}px`, fontFamily: "'Inconsolata', monospace" }}
      >
        {hasActive ? (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary-5 animate-pulse flex-shrink-0" />
        ) : (
          <span className="text-neutral-6 flex-shrink-0">{isOpen ? '▾' : '▸'}</span>
        )}
        <span className="text-neutral-5">
          {toolCount} tool{toolCount !== 1 ? ' calls' : ' call'}
          {' — '}
          <span className="text-accent-6">{uniqueNames.slice(0, 4).join(', ')}{uniqueNames.length > 4 ? ` +${uniqueNames.length - 4}` : ''}</span>
          {errorCount > 0 && <span className="text-error-5 ml-1">({errorCount} error{errorCount !== 1 ? 's' : ''})</span>}
        </span>
      </button>
      {isOpen && (
        <div className="pl-3 mt-0.5 border-l border-neutral-9/50">
          {run.groups.map((g, gi) => (
            <div key={`g-${gi}`}>
              <ToolGroupInline msg={g} fontSize={fontSize} />
            </div>
          ))}
          {run.outputs.map((o, oi) => (
            <ToolOutputInline key={`o-${oi}`} msg={o} fontSize={fontSize} />
          ))}
        </div>
      )}
      {run.images.map((img, ii) => (
        <ImageInline key={`img-${ii}`} msg={img} />
      ))}
    </div>
  )
}

function ImageInline({ msg }: { msg: ChatMessage & { type: 'image' } }) {
  const [expanded, setExpanded] = useState(false)
  const allowedMediaTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])
  const mediaType = allowedMediaTypes.has(msg.mediaType) ? msg.mediaType : 'image/png'
  const src = `data:${mediaType};base64,${msg.base64}`
  return (
    <div className="pl-4 py-1">
      <img
        src={src}
        alt="Tool output"
        className={`rounded-lg border border-neutral-8 cursor-pointer transition-all ${expanded ? 'max-w-full' : 'max-w-xs max-h-48 object-contain'}`}
        onClick={() => setExpanded(!expanded)}
      />
    </div>
  )
}

function TentativeMessage({ msg, fontSize }: { msg: ChatMessage & { type: 'tentative' }; fontSize: number }) {
  return (
    <div className="px-4 py-2">
      <div
        className="max-w-[80%] rounded-lg border-l-2 border-warning-6 bg-warning-11/20 px-3 py-2 text-neutral-4 whitespace-pre-wrap"
        style={{ fontSize: `${fontSize}px` }}
      >
        <div className="mb-1 text-[13px] text-warning-5 uppercase tracking-wider">queued</div>
        {msg.text}
      </div>
    </div>
  )
}

function PlanningModeMessage({ msg }: { msg: ChatMessage & { type: 'planning_mode' } }) {
  return (
    <div className="px-4 py-1.5 text-[15px] text-primary-5 flex items-center gap-2">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary-5 flex-shrink-0" />
      {msg.active ? 'Entered plan mode' : 'Exited plan mode'}
    </div>
  )
}

function OrchestratorWelcome() {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-9/40">
          <IconRobotFace size={28} className="text-accent-5" />
        </div>
        <h2 className="mb-2 text-[18px] font-semibold text-neutral-2">Orchestrator</h2>
        <p className="mb-5 text-[15px] leading-relaxed text-neutral-4">
          Your AI ops manager for triaging reports, spawning implementation sessions,
          and keeping your repositories healthy.
        </p>
        <div className="mx-auto grid max-w-sm gap-2 text-left text-[14px]">
          <div className="flex items-start gap-2.5 rounded-lg bg-neutral-10/60 px-3 py-2">
            <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-6" />
            <span className="text-neutral-3">Ask questions about concepts, architecture, or design decisions</span>
          </div>
          <div className="flex items-start gap-2.5 rounded-lg bg-neutral-10/60 px-3 py-2">
            <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-6" />
            <span className="text-neutral-3">Brainstorm ideas, draft plans, or think through tradeoffs</span>
          </div>
          <div className="flex items-start gap-2.5 rounded-lg bg-neutral-10/60 px-3 py-2">
            <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-6" />
            <span className="text-neutral-3">Write or review prose — docs, emails, specs, messages</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function ActivityIndicator({ label, variant = 'default' }: { label: string; variant?: ChatViewVariant }) {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(0)

  // Reset timer when label changes
  useEffect(() => {
    startRef.current = Date.now()
    setElapsed(0) // eslint-disable-line react-hooks/set-state-in-effect -- timer reset
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [label])

  return (
    <div className="px-4 pt-4 pb-2">
      <div className="app-thinking-badge inline-flex items-center gap-2 rounded-lg bg-neutral-9/80 px-3.5 py-2">
        <svg
          className="h-4 w-4 animate-[spin_3s_linear_infinite]"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: variant === 'orchestrator' ? 'var(--color-accent-7)' : 'var(--color-primary-7)' }}
        >
          <path d="M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
          <path d="M12 21l0 .01" />
          <path d="M3 9l0 .01" />
          <path d="M21 9l0 .01" />
          <path d="M8 20.1a9 9 0 0 1 -5 -7.1" />
          <path d="M16 20.1a9 9 0 0 0 5 -7.1" />
          <path d="M6.2 5a9 9 0 0 1 11.4 0" />
        </svg>
        <span className="text-[13px] text-neutral-4 tracking-wide">{label}</span>
        {elapsed >= 10 && (
          <span className="text-[12px] text-neutral-5">{elapsed}s</span>
        )}
      </div>
    </div>
  )
}

export function ChatView({ messages, fontSize, disabled, planningMode, activityLabel, isMobile, variant = 'default' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const isNearBottomRef = useRef(true)

  // Track whether the user is near the bottom of the scroll container.
  // 100px threshold accounts for the activity indicator height so auto-scroll
  // doesn't disengage when new tool output pushes content just past the viewport.
  const checkScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const threshold = 100
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    isNearBottomRef.current = nearBottom
    setShowScrollButton(!nearBottom)
  }, [])

  // Auto-scroll on new messages if near bottom
  useEffect(() => {
    if (isNearBottomRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [messages])

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
      setShowScrollButton(false)
      isNearBottomRef.current = true
    }
  }, [])

  return (
    <div className="relative flex flex-1 min-h-0 w-full flex-col">
      {planningMode && (
        <div className="z-10 flex items-center gap-2 border-b border-primary-9/50 bg-primary-11/80 px-4 py-1.5 text-[15px] text-primary-5 backdrop-blur-sm flex-shrink-0">
          <span className="inline-block h-2 w-2 rounded-full bg-primary-5 animate-pulse" />
          Plan Mode
        </div>
      )}
      <div
        ref={containerRef}
        className="chat-scroll flex-1 overflow-y-auto overflow-x-hidden min-h-0"
        onScroll={checkScroll}
      >
        {variant === 'orchestrator' && messages.length === 0 && !activityLabel ? (
          <OrchestratorWelcome />
        ) : (
        <div className="flex flex-col py-2">
          {(() => {
            let lastShownTs = 0
            const nodes: React.ReactNode[] = []

            // Group consecutive tool_group + tool_output messages into ToolRuns
            let i = 0
            while (i < messages.length) {
              const msg = messages[i]

              // Check for timestamps on user/assistant messages
              const ts = (msg as ChatMessage & { ts?: number }).ts
              if (ts && (msg.type === 'user' || msg.type === 'assistant') && ts - lastShownTs >= 60_000) {
                lastShownTs = ts
                const d = new Date(ts)
                const hh = String(d.getHours()).padStart(2, '0')
                const mm = String(d.getMinutes()).padStart(2, '0')
                nodes.push(<div key={`ts-${msg.key || i}`} className="px-4 pt-3 pb-0.5 text-[13px] text-neutral-6">{hh}:{mm}</div>)
              }

              // Collect consecutive tool_group/tool_output/image into a single ToolActivity
              if (msg.type === 'tool_group' || msg.type === 'tool_output' || msg.type === 'image') {
                const run: ToolRun = { groups: [], outputs: [], images: [] }
                const startIdx = i
                while (i < messages.length && (messages[i].type === 'tool_group' || messages[i].type === 'tool_output' || messages[i].type === 'image')) {
                  const m = messages[i]
                  if (m.type === 'tool_group') run.groups.push(m as ChatMessage & { type: 'tool_group' })
                  if (m.type === 'tool_output') run.outputs.push(m as ChatMessage & { type: 'tool_output' })
                  if (m.type === 'image') run.images.push(m as ChatMessage & { type: 'image' })
                  i++
                }
                const taKey = run.groups[0]?.key || run.outputs[0]?.key || `ta-${startIdx}`
                nodes.push(<ToolActivity key={taKey} run={run} fontSize={fontSize} />)
                continue
              }

              let node: React.ReactNode
              switch (msg.type) {
                case 'system':
                  if (msg.subtype === 'trim') {
                    node = <div key={msg.key || i} className="px-4 py-1.5 text-[15px] text-neutral-6 flex items-center gap-2">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-6 flex-shrink-0" />
                      Older messages trimmed
                    </div>
                    break
                  }
                  node = <SystemMessage key={msg.key || i} msg={msg} />; break
                case 'user':
                  node = <UserMessage key={msg.key || i} msg={msg} fontSize={fontSize} isMobile={isMobile} />; break
                case 'assistant':
                  node = <AssistantMessage key={msg.key || i} msg={msg} fontSize={fontSize} variant={variant} />; break
                case 'planning_mode':
                  node = <PlanningModeMessage key={msg.key || i} msg={msg} />; break
                case 'todo_list':
                  node = null; break
                case 'tentative':
                  node = <TentativeMessage key={msg.key || `tentative-${msg.index}`} msg={msg} fontSize={fontSize} />; break
              }
              nodes.push(node)
              i++
            }
            return nodes
          })()}
          {activityLabel && <ActivityIndicator label={activityLabel} variant={variant} />}
        </div>
        )}
      </div>

      {/* Scroll to bottom indicator */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-neutral-8/90 p-2 text-neutral-3 shadow-lg transition hover:bg-neutral-7 hover:text-neutral-1"
          title="Scroll to bottom"
        >
          <IconArrowDown size={16} stroke={2} />
        </button>
      )}

      {disabled && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-12/80">
          <p className="text-[15px] text-neutral-3">Configure token in Settings to use chat</p>
        </div>
      )}

    </div>
  )
}
