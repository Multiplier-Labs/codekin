/** Tests for the Canvas header's Download control: direct save, the format menu, and the narrow ⋯ menu. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { CanvasItem } from '../../types'
import type { ExportFormat } from '../../lib/canvasExport'

const saveFile = vi.fn()
vi.mock('../../lib/download', () => ({ saveFile: (...args: unknown[]) => { saveFile(...args) } }))
const { CanvasHeaderActions } = await import('./CanvasHeaderActions')

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

const item: CanvasItem = {
  id: 'i1', kind: 'table', title: 'Sales', source: { type: 'agent' }, latest: 1,
  revisions: [{ n: 1, createdAt: '', size: 1, mediaType: 'text/csv' }], createdAt: '', updatedAt: '',
}
const format = (id: string, label: string): ExportFormat => ({
  id, label, ext: id, build: () => Promise.resolve({ data: `${id} data`, filename: `Sales.${id}`, mediaType: `text/${id}` }),
})

function render(downloads: ExportFormat[], narrow = false): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<CanvasHeaderActions item={item} revision={1} narrow={narrow} sourceMode={false} onToggleSource={() => {}}
      downloads={downloads} onPin={() => {}} onCompare={undefined} onDelete={() => {}} />)
  })
  return container
}
const button = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === name || b.textContent === name)
async function click(el: Element | undefined) {
  await act(async () => { (el as HTMLElement).click(); await Promise.resolve() })
}

beforeEach(() => { saveFile.mockClear() })
afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
})

describe('CanvasHeaderActions downloads', () => {
  it('saves a single format straight away', async () => {
    const el = render([format('md', 'Markdown')])
    const download = button(el, 'Download')
    expect(download?.getAttribute('aria-haspopup')).toBeNull()
    await click(download)
    expect(saveFile).toHaveBeenCalledWith('md data', 'Sales.md', 'text/md')
    expect(download?.title).toBe('Downloaded')
  })

  it('lists several formats in a menu', async () => {
    const el = render([format('csv', 'CSV'), format('json', 'JSON')])
    await click(button(el, 'Download'))
    expect(saveFile).not.toHaveBeenCalled()
    const rows = [...el.querySelectorAll('[role="menu"][aria-label="Download as"] [role="menuitem"]')]
    expect(rows.map(r => r.textContent)).toEqual(['CSV.csv', 'JSON.json'])
    await click(rows[1])
    expect(saveFile).toHaveBeenCalledWith('json data', 'Sales.json', 'text/json')
    expect(el.querySelector('[aria-label="Download as"]')).toBeNull()
  })

  it('shows no Download button when there is nothing to save', () => {
    expect(button(render([]), 'Download')).toBeUndefined()
  })

  it('folds the formats into the ⋯ menu when narrow', async () => {
    const el = render([format('csv', 'CSV'), format('tsv', 'TSV')], true)
    expect(button(el, 'Download')).toBeUndefined()
    await click(button(el, 'More actions'))
    await click(button(el, 'Download as TSV'))
    expect(saveFile).toHaveBeenCalledWith('tsv data', 'Sales.tsv', 'text/tsv')
  })
})
