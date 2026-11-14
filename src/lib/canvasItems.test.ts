/** Tests for Canvas item helpers: switcher groups, Markdown headings and blocks. */
import { describe, it, expect } from 'vitest'
import { groupItems, markdownBlocks, markdownHeadings } from './canvasItems'
import type { CanvasItem } from '../types'

const item = (id: string, over: Partial<CanvasItem> = {}): CanvasItem => ({
  id, kind: 'markdown', title: id, source: { type: 'agent' }, latest: 1, revisions: [], createdAt: '', updatedAt: '', ...over,
})

describe('groupItems', () => {
  it('orders Pinned, Agent, You, then MCP servers, newest first in each', () => {
    const groups = groupItems([
      item('a1'), item('f1', { source: { type: 'file', path: 'x.md' } }), item('m1', { source: { type: 'mcp', server: 'perf-mcp' } }),
      item('a2'), item('p1', { pinnedRevision: 1 }),
    ])
    expect(groups.map(g => [g.label, g.items.map(i => i.id)])).toEqual([
      ['Pinned', ['p1']], ['Agent', ['a2', 'a1']], ['You', ['f1']], ['perf-mcp', ['m1']],
    ])
  })
})

describe('Markdown helpers', () => {
  const doc = '# Title\n\nIntro **bold**.\n\n## Storage\n\n- one\n- two\n\n#### Deep\n\n```ts\nx()\n```\n'
  it('lists headings up to level 3, without inline markup', () => {
    expect(markdownHeadings('# A *b*\n\n## C\n\n#### D')).toEqual([{ depth: 1, text: 'A b' }, { depth: 2, text: 'C' }])
  })
  it('splits top-level blocks', () => {
    expect(markdownBlocks(doc)).toEqual(['# Title', 'Intro **bold**.', '## Storage', '- one\n- two', '#### Deep', '```ts\nx()\n```'])
  })
})
