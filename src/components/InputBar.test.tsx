// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InputBar } from './InputBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
})

describe('InputBar permission picker', () => {
  it('is shown in the orchestrator (Joe) composer, the same as in sessions', async () => {
    await act(async () => {
      root.render(
        <InputBar
          variant="orchestrator"
          onSendInput={vi.fn()} isWaiting={false} disabled={false} onEscape={vi.fn()}
          pendingFiles={[]} onAddFiles={vi.fn()} onRemoveFile={vi.fn()}
          sessionProvider="codex"
          currentPermissionMode="acceptEdits" onPermissionModeChange={vi.fn()}
        />,
      )
    })
    expect(container.textContent).toContain('Auto accept edits')
  })
})
