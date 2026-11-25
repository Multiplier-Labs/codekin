/** Tests for Canvas downloads: file names, table conversions, and the formats each kind offers. */
import { describe, it, expect } from 'vitest'
import type { CanvasItem, CanvasItemKind } from '../types'
import { exportFileName, exportFormats, tableToCsv, tableToJson, tableToTsv } from './canvasExport'
import { parseTable, TABLE_LIMITS } from './canvasTable'

function item(kind: CanvasItemKind, title = 'Report', latest = 1): CanvasItem {
  return {
    id: 'i1', kind, title, source: { type: 'agent' },
    revisions: Array.from({ length: latest }, (_, i) => ({ n: i + 1, createdAt: '2026-11-25T00:00:00Z', size: 1, mediaType: 'text/plain' })),
    latest, createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z',
  }
}

const content = (text: string, mediaType: string) => ({ content: text, encoding: 'utf8' as const, mediaType })

async function text(data: BlobPart): Promise<string> {
  return new Blob([data]).text()
}

describe('exportFileName', () => {
  it('keeps a plain title and adds the extension', () => {
    expect(exportFileName('Q3 revenue by region', 'csv')).toBe('Q3 revenue by region.csv')
  })
  it('replaces characters file systems refuse and squeezes whitespace', () => {
    expect(exportFileName('Cost / revenue: "draft"?', 'md')).toBe('Cost - revenue- -draft-.md')
    expect(exportFileName('a\tb\n c', 'md')).toBe('a b c.md')
  })
  it('drops the extension of a title that names a file', () => {
    expect(exportFileName('report.md', 'md')).toBe('report.md')
    expect(exportFileName('data.csv', 'json')).toBe('data.json')
    expect(exportFileName('sales.vl.json', 'vl.json')).toBe('sales.vl.json')
  })
  it('names older revisions and never returns an empty or hidden name', () => {
    expect(exportFileName('Plan', 'md', 2)).toBe('Plan-rev2.md')
    expect(exportFileName('///', 'md')).toBe('canvas-item.md')
    expect(exportFileName('.env notes', 'md')).toBe('env notes.md')
  })
  it('caps the length', () => {
    expect(exportFileName('x'.repeat(300), 'md')).toBe(`${'x'.repeat(100)}.md`)
  })
})

describe('table conversions', () => {
  const table = { columns: ['name', 'note'], rows: [['a, b', 'say "hi"'], ['two\nlines', ' pad'], ['plain', '1']] }

  it('writes RFC 4180 CSV that reads back the same', () => {
    const csv = tableToCsv(table)
    expect(csv).toBe('name,note\r\n"a, b","say ""hi"""\r\n"two\nlines"," pad"\r\nplain,1\r\n')
    expect(parseTable(csv, 'text/csv')).toEqual(table)
  })
  it('writes TSV with tabs and line breaks in cells turned into spaces', () => {
    expect(tableToTsv({ columns: ['a', 'b'], rows: [['x\ty', 'one\r\ntwo']] })).toBe('a\tb\nx y\tone two\n')
  })
  it('writes JSON rows, keeping repeated column names apart', () => {
    expect(JSON.parse(tableToJson({ columns: ['id', 'v', 'v'], rows: [['1', 'a', 'b']] }))).toEqual([{ id: '1', v: 'a', 'v (2)': 'b' }])
  })
})

describe('exportFormats', () => {
  it('offers a table in its stored format first, then the others', async () => {
    const formats = exportFormats(item('table', 'Sales'), 1, content('id,ms\na,10\n', 'text/csv'))
    expect(formats.map(f => f.id)).toEqual(['csv', 'tsv', 'json', 'md'])
    const stored = await formats[0].build()
    expect(stored).toMatchObject({ filename: 'Sales.csv', mediaType: 'text/csv' })
    expect(await text(stored.data)).toBe('id,ms\na,10\n') // the stored bytes, unchanged
    expect(await text((await formats[3].build()).data)).toBe('| id | ms |\n| --- | --- |\n| a | 10 |\n')
    const json = exportFormats(item('table'), 1, content('[{"a":1}]', 'application/json'))
    expect(json.map(f => f.id)).toEqual(['json', 'csv', 'tsv', 'md'])
  })
  it('offers only the stored file for a table that cannot be read or was cut to fit', () => {
    expect(exportFormats(item('table'), 1, content('{"not":"rows"}', 'application/json')).map(f => f.id)).toEqual(['json'])
    const wide = Array.from({ length: TABLE_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(',')
    expect(exportFormats(item('table'), 1, content(`${wide}\n`, 'text/csv')).map(f => f.id)).toEqual(['csv'])
  })
  it('saves Markdown as .md, naming an older revision', async () => {
    const [md] = exportFormats(item('markdown', 'Plan', 3), 2, content('# Plan', 'text/markdown'))
    expect(await md.build()).toMatchObject({ filename: 'Plan-rev2.md', mediaType: 'text/markdown', data: '# Plan' })
  })
  it('decodes images to their bytes', async () => {
    const [png] = exportFormats(item('image', 'Shot'), 1, { content: btoa('\x89PNG'), encoding: 'base64', mediaType: 'image/png' })
    const file = await png.build()
    expect(file.filename).toBe('Shot.png')
    expect([...new Uint8Array(await new Blob([file.data]).arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })
  it('offers diagrams as source and SVG, and nothing for a live preview', () => {
    expect(exportFormats(item('diagram'), 1, content('graph TD; a-->b', 'text/vnd.mermaid')).map(f => f.ext)).toEqual(['mmd', 'svg'])
    expect(exportFormats(item('chart'), 1, content('{}', 'application/vnd.vegalite+json')).map(f => f.ext)).toEqual(['vl.json'])
    expect(exportFormats(item('preview'), 1, content('{}', 'application/vnd.codekin.preview+json'))).toEqual([])
  })
})
