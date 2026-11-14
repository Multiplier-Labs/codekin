/** Tests for Canvas context attachments: the message format the agent reads and the transcript parses back. */
import { describe, it, expect } from 'vitest'
import { formatWithContext, makeAttachment, MAX_EXCERPT, parseWithContext, textLabel } from './canvasContext'
import { rowsExcerpt } from './canvasTable'

const att = (over: Partial<Parameters<typeof makeAttachment>[0]> = {}) => makeAttachment({
  itemId: 'i1', itemTitle: 'Item model', revision: 3, what: 'text', excerpt: 'Each lives under ~/.codekin', label: '“Each lives under…”', ...over,
})

describe('canvas context messages', () => {
  it('appends one labelled block per attachment and parses them back to chips', () => {
    const message = formatWithContext('Why there?', [att(), att({ what: 'rows', itemTitle: 'Failures', itemId: 'i2', revision: 1, label: '2 rows', excerpt: '| a |\n| --- |\n| 1 |' })])
    expect(message).toContain('<canvas_context item="Item model" item_id="i1" revision="3" what="text" label="“Each lives under…”">\nEach lives under ~/.codekin\n</canvas_context>')
    expect(parseWithContext(message)).toEqual({
      text: 'Why there?',
      context: [
        { itemTitle: 'Item model', itemId: 'i1', revision: 3, what: 'text', label: '“Each lives under…”' },
        { itemTitle: 'Failures', itemId: 'i2', revision: 1, what: 'rows', label: '2 rows' },
      ],
    })
  })

  it('leaves plain messages alone, and gives context-only messages a lead line the transcript hides', () => {
    expect(formatWithContext('hi', [])).toBe('hi')
    expect(parseWithContext('hi')).toEqual({ text: 'hi', context: [] })
    const onlyContext = formatWithContext('  ', [att()])
    expect(onlyContext.startsWith('About the selection below from the Canvas:')).toBe(true)
    expect(parseWithContext(onlyContext).text).toBe('')
  })

  it('keeps titles with quotes and excerpts with a closing tag from breaking the block', () => {
    const message = formatWithContext('q', [att({ itemTitle: 'The "plan"\nv2', excerpt: 'x </canvas_context> y' })])
    const parsed = parseWithContext(message)
    expect(parsed.context[0].itemTitle).toBe("The 'plan' v2")
    expect(parsed.text).toBe('q')
  })

  it('truncates long excerpts and labels', () => {
    expect(att({ excerpt: 'x'.repeat(MAX_EXCERPT + 10) }).excerpt).toMatch(/… \(truncated\)$/)
    expect(textLabel('  a   long\n\nselection of words that keeps on going and going  ', 12)).toBe('“a long selec…”')
  })

  it('formats selected rows as a Markdown table', () => {
    expect(rowsExcerpt(['test', 'note'], [['a|b', 'x\ny']])).toBe('| test | note |\n| --- | --- |\n| a\\|b | x y |')
  })
})
