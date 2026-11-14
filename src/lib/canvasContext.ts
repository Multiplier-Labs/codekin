/**
 * Canvas selections sent to the agent as context (docs/CANVAS-SPEC.md §5).
 *
 * Each attachment is appended to the user's message as a labelled block the
 * agent can read, naming the item, its revision and what was selected:
 *
 *   <canvas_context item="Item model" item_id="…" revision="3" what="text">
 *   Each lives under ~/.codekin/canvas …
 *   </canvas_context>
 *
 * The transcript parses the blocks back out and shows them as chips, so the
 * format is also what survives a reload.
 */

export type CanvasSelectionKind = 'text' | 'rows' | 'node'

export interface CanvasAttachment {
  /** Local id, for removing it from the composer. */
  id: string
  itemId: string
  itemTitle: string
  revision: number
  what: CanvasSelectionKind
  /** What the user selected, as text the agent can read. */
  excerpt: string
  /** Short chip label: “Each lives under…”, 4 rows, Session manager. */
  label: string
}

/** The longest excerpt one attachment carries. */
export const MAX_EXCERPT = 8000

const attr = (v: string | number) => String(v).replace(/[\r\n]+/g, ' ').replace(/"/g, '\'')

/** Short label for a chip from selected text. */
export function textLabel(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return `“${flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat}”`
}

export function makeAttachment(input: Omit<CanvasAttachment, 'id' | 'excerpt'> & { excerpt: string }): CanvasAttachment {
  const excerpt = input.excerpt.length > MAX_EXCERPT ? `${input.excerpt.slice(0, MAX_EXCERPT)}\n… (truncated)` : input.excerpt
  return { ...input, excerpt, id: `${input.itemId}:${input.revision}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}` }
}

/** The message text the agent receives: the user's text, then one block per attachment. */
export function formatWithContext(text: string, attachments: CanvasAttachment[]): string {
  if (attachments.length === 0) return text
  const blocks = attachments.map(a => [
    `<canvas_context item="${attr(a.itemTitle)}" item_id="${attr(a.itemId)}" revision="${a.revision}" what="${a.what}" label="${attr(a.label)}">`,
    // A literal closing tag inside the excerpt must not end the block early.
    a.excerpt.replace(/<\/canvas_context>/gi, '</canvas_context​>'),
    '</canvas_context>',
  ].join('\n'))
  const lead = text.trim() || 'About the selection below from the Canvas:'
  return `${lead}\n\n${blocks.join('\n\n')}`
}

export interface SentContext {
  itemId: string
  itemTitle: string
  revision: number
  what: CanvasSelectionKind
  label: string
}

const BLOCK = /\n*<canvas_context item="([^"]*)" item_id="([^"]*)" revision="(\d+)" what="(text|rows|node)" label="([^"]*)">\n[\s\S]*?\n<\/canvas_context>/g

/** Split a sent message into the user's text and its Canvas attachments. */
export function parseWithContext(message: string): { text: string; context: SentContext[] } {
  const context: SentContext[] = []
  const text = message.replace(BLOCK, (_, itemTitle: string, itemId: string, revision: string, what: CanvasSelectionKind, label: string) => {
    context.push({ itemTitle, itemId, revision: Number(revision), what, label })
    return ''
  }).trimEnd()
  return { text: context.length && text === 'About the selection below from the Canvas:' ? '' : text, context }
}
