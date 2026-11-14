/**
 * Canvas item helpers shared by the switcher, the Markdown view and the
 * compare view: grouping items, Markdown headings and top-level blocks.
 */

import { marked } from 'marked'
import type { CanvasItem } from '../types'

/** Groups for 6+ items: Pinned, Agent, You, then each MCP server; newest first within each. */
export function groupItems(items: CanvasItem[]): Array<{ label: string; items: CanvasItem[] }> {
  const groups = new Map<string, CanvasItem[]>()
  const add = (label: string, item: CanvasItem) => { groups.set(label, [...(groups.get(label) ?? []), item]) }
  for (const item of items) if (item.pinnedRevision !== undefined) add('Pinned', item)
  for (const item of items) {
    if (item.pinnedRevision !== undefined) continue
    add(item.source.type === 'agent' ? 'Agent' : item.source.type === 'file' ? 'You' : item.source.server, item)
  }
  const order = ['Pinned', 'Agent', 'You']
  return [...groups].sort(([a], [b]) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
  }).map(([label, list]) => ({ label, items: list.slice().reverse() }))
}

/** Headings (levels 1–3) of a Markdown document, in order. */
export function markdownHeadings(text: string): Array<{ depth: number; text: string }> {
  return marked.lexer(text)
    .filter((t): t is Extract<ReturnType<typeof marked.lexer>[number], { type: 'heading' }> => t.type === 'heading' && t.depth <= 3)
    .map(t => ({ depth: t.depth, text: t.text.replace(/[*_`[\]]/g, '') }))
}

/** Top-level Markdown blocks (paragraphs, headings, lists, code…) as raw text. */
export function markdownBlocks(text: string): string[] {
  return marked.lexer(text).filter(t => t.type !== 'space').map(t => t.raw.trim())
}
