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

describe('InputBar addressing Joe', () => {
  async function renderBar(props: Partial<Parameters<typeof InputBar>[0]> = {}) {
    const onSendInput = vi.fn()
    await act(async () => {
      root.render(
        <InputBar
          onSendInput={onSendInput} isWaiting={false} disabled={false} onEscape={vi.fn()}
          pendingFiles={[]} onAddFiles={vi.fn()} onRemoveFile={vi.fn()}
          joeName="Joe"
          {...props}
        />,
      )
    })
    return onSendInput
  }

  function type(text: string) {
    const textarea = container.querySelector('textarea')!
    return act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('shows the recipient before sending', async () => {
    await renderBar()
    expect(container.querySelector('[role="status"]')).toBeNull()
    await type('@Joe run the security review every Monday')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('To Agent Joe')
  })

  it('Ask Joe addresses the draft to Joe and back', async () => {
    await renderBar()
    await type('what are you monitoring?')
    const ask = container.querySelector('button[title="Ask Agent Joe"]') as HTMLButtonElement
    await act(async () => { ask.click() })
    expect(container.querySelector('textarea')!.value).toBe('@Joe what are you monitoring?')
    const back = container.querySelector('button[title="Send to the coding agent instead"]') as HTMLButtonElement
    await act(async () => { back.click() })
    expect(container.querySelector('textarea')!.value).toBe('what are you monitoring?')
  })

  it('pauses ordinary messages while Joe controls the session, but still reaches Joe', async () => {
    const onSendInput = await renderBar({ lockedReason: 'Joe is coordinating this session.' })
    await type('keep going')
    const send = container.querySelector('button[title="Send (Enter)"]') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(container.textContent).toContain('Joe is coordinating this session.')
    await type('@Joe how is it going?')
    expect(send.disabled).toBe(false)
    await act(async () => { send.click() })
    expect(onSendInput).toHaveBeenCalledWith('@Joe how is it going?')
  })
})
