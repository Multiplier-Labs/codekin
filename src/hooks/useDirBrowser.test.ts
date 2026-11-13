// @vitest-environment jsdom
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

function renderHook<T>(hookFn: () => T): { result: { current: T } } {
  const result = { current: undefined as T }
  function TestComponent() {
    result.current = hookFn()
    return null
  }
  act(() => { createRoot(document.createElement('div')).render(createElement(TestComponent)) })
  return { result }
}

const browseDirs = vi.hoisted(() => vi.fn())
vi.mock('../lib/ccApi', () => ({ browseDirs }))

import { useDirBrowser, parentDir, childDir } from './useDirBrowser'

beforeEach(() => { browseDirs.mockReset() })

describe('path helpers', () => {
  it('parentDir and childDir', () => {
    expect(parentDir('/home/sam/notes')).toBe('/home/sam')
    expect(parentDir('/home')).toBe('/')
    expect(parentDir('/')).toBe('/')
    expect(childDir('/', 'home')).toBe('/home')
    expect(childDir('/home/sam/', 'x')).toBe('/home/sam/x')
  })
})

describe('useDirBrowser', () => {
  it('lists a folder with its git fields and goes up', async () => {
    browseDirs.mockResolvedValueOnce({ path: '/home/sam/p', dirs: ['a', 'b'], gitDirs: ['b'], git: true, roots: ['/home/sam'], home: '/home/sam' })
    const { result } = renderHook(() => useDirBrowser('tok'))
    await act(async () => { await result.current.open('/home/sam/p') })
    expect(result.current.path).toBe('/home/sam/p')
    expect(result.current.dirs).toEqual(['a', 'b'])
    expect(result.current.gitDirs.has('b')).toBe(true)
    expect(result.current.git).toBe(true)
    expect(result.current.home).toBe('/home/sam')

    browseDirs.mockResolvedValueOnce({ path: '/home/sam', dirs: ['p'] })
    await act(async () => { await result.current.up() })
    expect(browseDirs).toHaveBeenLastCalledWith('tok', '/home/sam')
    expect(result.current.git).toBe(false)
  })

  it('drops a response that arrives after a newer request', async () => {
    let resolveSlow: (v: unknown) => void = () => {}
    browseDirs
      .mockImplementationOnce(() => new Promise(r => { resolveSlow = r }))
      .mockResolvedValueOnce({ path: '/fast', dirs: [] })
    const { result } = renderHook(() => useDirBrowser('tok'))
    let slow: Promise<unknown> = Promise.resolve()
    await act(async () => {
      slow = result.current.open('/slow')
      await result.current.open('/fast')
    })
    await act(async () => { resolveSlow({ path: '/slow', dirs: ['x'] }); await slow })
    expect(result.current.path).toBe('/fast')
  })

  it('reports errors and does nothing without a token', async () => {
    browseDirs.mockRejectedValueOnce(new Error('Path is outside allowed directories'))
    const { result } = renderHook(() => useDirBrowser('tok'))
    await act(async () => { await result.current.open('/etc') })
    expect(result.current.error).toBe('Path is outside allowed directories')
    const none = renderHook(() => useDirBrowser(undefined))
    await act(async () => { expect(await none.result.current.open('/x')).toBeNull() })
    expect(browseDirs).toHaveBeenCalledTimes(1)
  })
})
