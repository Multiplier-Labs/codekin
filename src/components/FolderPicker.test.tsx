/** Tests for FolderPicker — the browse button uses the native macOS dialog when the server offers it, and the in-page browser otherwise. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const api = vi.hoisted(() => ({
  browseDirs: vi.fn(),
  getNativeFolderPickerAvailable: vi.fn(),
  pickFolderNative: vi.fn(),
}))
vi.mock('../lib/ccApi', () => api)

import { FolderPicker } from './FolderPicker.js'

let container: HTMLDivElement
let root: Root

async function render(onSave: (p: string) => Promise<void>) {
  await act(async () => {
    root.render(<FolderPicker value="/Users/me/repos" token="tok" onSave={onSave} />)
  })
}

const browseButton = () => container.querySelector('button') as HTMLButtonElement
const input = () => container.querySelector('input') as HTMLInputElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  api.browseDirs.mockResolvedValue({ path: '/Users/me/repos', dirs: ['alpha', 'beta'] })
  api.pickFolderNative.mockResolvedValue('/Users/me/code')
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.clearAllMocks()
})

describe('FolderPicker', () => {
  it('opens the native dialog and saves the chosen folder when available', async () => {
    api.getNativeFolderPickerAvailable.mockResolvedValue(true)
    const onSave = vi.fn(async () => {})
    await render(onSave)

    expect(browseButton().title).toBe('Choose folder…')
    await act(async () => { browseButton().click() })

    expect(api.pickFolderNative).toHaveBeenCalledWith('tok', '/Users/me/repos')
    expect(onSave).toHaveBeenCalledWith('/Users/me/code')
    expect(input().value).toBe('/Users/me/code')
    expect(api.browseDirs).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Select this folder')
  })

  it('leaves the path alone when the native dialog is cancelled', async () => {
    api.getNativeFolderPickerAvailable.mockResolvedValue(true)
    api.pickFolderNative.mockResolvedValue(null)
    const onSave = vi.fn(async () => {})
    await render(onSave)

    await act(async () => { browseButton().click() })

    expect(onSave).not.toHaveBeenCalled()
    expect(input().value).toBe('/Users/me/repos')
  })

  it('shows the error when the native dialog fails', async () => {
    api.getNativeFolderPickerAvailable.mockResolvedValue(true)
    api.pickFolderNative.mockRejectedValue(new Error('osascript failed'))
    await render(vi.fn(async () => {}))

    await act(async () => { browseButton().click() })

    expect(container.textContent).toContain('osascript failed')
  })

  it('falls back to the in-page browser when the native dialog is unavailable', async () => {
    api.getNativeFolderPickerAvailable.mockResolvedValue(false)
    await render(vi.fn(async () => {}))

    expect(browseButton().title).toBe('Browse folders')
    await act(async () => { browseButton().click() })

    expect(api.pickFolderNative).not.toHaveBeenCalled()
    expect(api.browseDirs).toHaveBeenCalledWith('tok', '/Users/me/repos')
    expect(container.textContent).toContain('Select this folder')
    expect(container.textContent).toContain('alpha')
  })

  it('saves the folder chosen in the in-page browser', async () => {
    api.getNativeFolderPickerAvailable.mockResolvedValue(false)
    api.browseDirs.mockImplementation(async (_t: string, p?: string) => (
      p === '/Users/me/repos/alpha' ? { path: p, dirs: [] } : { path: '/Users/me/repos', dirs: ['alpha', 'beta'] }
    ))
    const onSave = vi.fn(async () => {})
    await render(onSave)

    await act(async () => { browseButton().click() })
    const alpha = [...container.querySelectorAll('button')].find(b => b.textContent === 'alpha')!
    await act(async () => { alpha.click() })
    const select = [...container.querySelectorAll('button')].find(b => b.textContent === 'Select this folder')!
    await act(async () => { select.click() })

    expect(onSave).toHaveBeenCalledWith('/Users/me/repos/alpha')
    expect(input().value).toBe('/Users/me/repos/alpha')
    expect(container.textContent).not.toContain('Select this folder')
  })
})

