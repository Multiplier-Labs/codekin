/** Tests for KeepThisWork — the scratch promotion callout. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('../lib/ccApi', () => ({
  browseDirs: vi.fn(async () => ({ path: '/home/sam', dirs: [], gitDirs: [], git: false, roots: ['/home/sam'], home: '/home/sam' })),
  getNativeFolderPickerAvailable: vi.fn(async () => false),
  pickFolderNative: vi.fn(),
}))
import { KeepThisWork } from './KeepThisWork.js'
import type { SessionPlace } from '../types'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
})

function mount(place: SessionPlace, overrides: Partial<Parameters<typeof KeepThisWork>[0]> = {}) {
  const props = {
    place, folderName: 'brisk-otter', owners: ['sam', 'acme-co'],
    onGitInit: vi.fn(async () => {}), onPublish: vi.fn(async () => 'https://github.com/sam/brisk-otter'), onDismiss: vi.fn(),
    ...overrides,
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<KeepThisWork {...props} />)
  })
  return props
}

const button = (text: string) => [...container!.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined

describe('KeepThisWork', () => {
  it('offers git init and publish, never claims the folder will be deleted', () => {
    mount({ kind: 'scratch', git: false, hasFiles: true })
    expect(button('Make it a git repo')).toBeDefined()
    expect(button('Publish to GitHub')).toBeDefined()
    expect(container!.textContent).not.toMatch(/archived|deleted/)
  })

  it('hides git init once the folder is a repository', () => {
    mount({ kind: 'scratch', git: true, hasFiles: true })
    expect(button('Make it a git repo')).toBeUndefined()
  })

  it('initializes git and dismisses', async () => {
    const props = mount({ kind: 'scratch', git: false, hasFiles: true })
    await act(async () => { button('Make it a git repo')!.click() })
    expect(props.onGitInit).toHaveBeenCalledTimes(1)
    act(() => { button('Not now')!.click() })
    expect(props.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('publishes with the chosen owner, name and visibility', async () => {
    const props = mount({ kind: 'scratch', git: false, hasFiles: true })
    act(() => { button('Publish to GitHub')!.click() })
    const owner = container!.querySelector('select[aria-label="Owner"]') as HTMLSelectElement
    const visibility = container!.querySelector('select[aria-label="Visibility"]') as HTMLSelectElement
    act(() => {
      owner.value = 'acme-co'
      owner.dispatchEvent(new Event('change', { bubbles: true }))
      visibility.value = 'public'
      visibility.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect((container!.querySelector('input[aria-label="Repository name"]') as HTMLInputElement).value).toBe('brisk-otter')
    await act(async () => { button('Publish')!.click() })
    expect(props.onPublish).toHaveBeenCalledWith({ owner: 'acme-co', name: 'brisk-otter', visibility: 'public' })
    expect(container!.textContent).toContain('Published to https://github.com/sam/brisk-otter')
  })

  it('shows why publishing failed and cannot publish without a GitHub login', async () => {
    mount({ kind: 'scratch', git: false, hasFiles: true }, { onPublish: vi.fn(async () => { throw new Error('gh repo create failed: Name already exists') }) })
    act(() => { button('Publish to GitHub')!.click() })
    await act(async () => { button('Publish')!.click() })
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe('gh repo create failed: Name already exists')
    act(() => { root!.unmount() })
    container!.remove()
    mount({ kind: 'scratch', git: false, hasFiles: true }, { owners: [] })
    expect(button('Publish to GitHub')!.disabled).toBe(true)
  })

  it('moves into a chosen folder only after Move here', async () => {
    const onMove = vi.fn(async () => {})
    mount({ kind: 'scratch', git: true, hasFiles: true, remote: true }, { onMove, token: 'tok' })
    // Published already: only Move is left.
    expect(button('Publish to GitHub')).toBeUndefined()
    act(() => { button('Move to a folder')!.click() })
    expect(button('Move here')!.disabled).toBe(true)
    const input = container!.querySelector('input') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, '/home/sam/projects')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onMove).not.toHaveBeenCalled()
    expect(container!.textContent).toContain('/home/sam/projects/brisk-otter')
    await act(async () => { button('Move here')!.click() })
    expect(onMove).toHaveBeenCalledWith('/home/sam/projects')
  })
})
