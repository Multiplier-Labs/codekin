/**
 * Download a Canvas item as a file (docs/CANVAS-SPEC.md §4): every item kind
 * except live previews saves in the format it is stored in, and tables and
 * diagrams also convert, to CSV, TSV, JSON or a Markdown table, and to an SVG
 * image.
 */

import type { CanvasItem } from '../types'
import type { CanvasContent } from '../hooks/useCanvas'
import { canvasKindForPath } from './canvas'
import { parseTable, rowsExcerpt, type ParsedTable } from './canvasTable'

export interface ExportFile {
  data: BlobPart
  filename: string
  mediaType: string
}

export interface ExportFormat {
  id: string
  /** Menu label, e.g. "CSV" or "SVG image". */
  label: string
  /** File extension, without the dot. */
  ext: string
  build: () => Promise<ExportFile>
}

const MAX_NAME = 100

/**
 * A file name from the item's title: characters no file system takes become
 * "-", a title that already names a file ("report.md") loses its extension,
 * and an older revision says which one it is.
 */
export function exportFileName(title: string, ext: string, revision?: number): string {
  let base = title.trim()
  if (canvasKindForPath(base)) base = base.replace(/(\.(vl|vegalite))?\.[^./\\]+$/i, '')
  base = base
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/^[\s.-]+|[\s.]+$/g, '')
    .slice(0, MAX_NAME)
    .trim()
  return `${base || 'canvas-item'}${revision !== undefined ? `-rev${revision}` : ''}.${ext}`
}

function csvField(v: string): string {
  return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function tableToCsv(t: Pick<ParsedTable, 'columns' | 'rows'>): string {
  return [t.columns, ...t.rows].map(r => r.map(csvField).join(',')).join('\r\n') + '\r\n'
}

/** TSV has no quoting: tabs and line breaks inside a cell become spaces. */
export function tableToTsv(t: Pick<ParsedTable, 'columns' | 'rows'>): string {
  const clean = (v: string) => v.replace(/[\t\r\n]+/g, ' ')
  return [t.columns, ...t.rows].map(r => r.map(clean).join('\t')).join('\n') + '\n'
}

/** An array of objects, one per row; repeated column names get " (2)", " (3)"… so no value is lost. */
export function tableToJson(t: Pick<ParsedTable, 'columns' | 'rows'>): string {
  const seen = new Map<string, number>()
  const keys = t.columns.map(c => {
    const n = (seen.get(c) ?? 0) + 1
    seen.set(c, n)
    return n === 1 ? c : `${c} (${n})`
  })
  return JSON.stringify(t.rows.map(r => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? '']))), null, 2) + '\n'
}

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
}

const TABLE_FORMATS = [
  { id: 'csv', label: 'CSV', ext: 'csv', mediaType: 'text/csv', native: 'text/csv', write: tableToCsv },
  { id: 'tsv', label: 'TSV', ext: 'tsv', mediaType: 'text/tab-separated-values', native: 'text/tab-separated-values', write: tableToTsv },
  { id: 'json', label: 'JSON', ext: 'json', mediaType: 'application/json', native: 'application/json', write: tableToJson },
  { id: 'md', label: 'Markdown table', ext: 'md', mediaType: 'text/markdown', native: null, write: (t: ParsedTable) => rowsExcerpt(t.columns, t.rows) + '\n' },
] as const

/**
 * The ways to save the shown revision of an item, the stored format first.
 * Empty for live previews, which have nothing to save.
 */
export function exportFormats(item: CanvasItem, revision: number, content: CanvasContent): ExportFormat[] {
  const rev = revision === item.latest ? undefined : revision
  const name = (ext: string) => exportFileName(item.title, ext, rev)
  const text = (id: string, label: string, ext: string, mediaType: string): ExportFormat =>
    ({ id, label, ext, build: () => Promise.resolve({ data: content.content, filename: name(ext), mediaType }) })

  switch (item.kind) {
    case 'markdown': return [text('md', 'Markdown', 'md', 'text/markdown')]
    case 'chart': return [text('vl', 'Vega-Lite spec', 'vl.json', 'application/json')]
    case 'html': return [text('html', 'HTML page', 'html', 'text/html')]
    case 'mcp_app': return [text('json', 'Tool result (JSON)', 'json', 'application/json')]
    case 'preview': return []
    case 'image': {
      const ext = IMAGE_EXT[content.mediaType] ?? 'png'
      return [{
        id: ext, label: `${ext.toUpperCase()} image`, ext,
        build: () => Promise.resolve({ data: decodeBase64(content.content), filename: name(ext), mediaType: content.mediaType }),
      }]
    }
    case 'diagram': return [
      text('mmd', 'Mermaid source', 'mmd', 'text/plain'),
      {
        id: 'svg', label: 'SVG image', ext: 'svg',
        build: async () => {
          const { renderMermaid } = await import('./mermaidRender')
          // Light colours: a saved diagram is mostly seen on white.
          return { data: await renderMermaid(content.content, 'light'), filename: name('svg'), mediaType: 'image/svg+xml' }
        },
      },
    ]
    case 'table': {
      const stored = TABLE_FORMATS.find(f => f.native === content.mediaType)
      const first = stored ? [text(stored.id, stored.label, stored.ext, stored.mediaType)] : []
      let table: ParsedTable
      try { table = parseTable(content.content, content.mediaType) } catch { return first }
      // A table cut to fit the view would lose rows in a conversion: only the stored file then.
      if (table.truncated) return first
      return [
        ...first,
        ...TABLE_FORMATS.filter(f => f !== stored).map(f => ({
          id: f.id, label: f.label, ext: f.ext,
          build: () => Promise.resolve({ data: f.write(table), filename: name(f.ext), mediaType: f.mediaType }),
        })),
      ]
    }
  }
}
