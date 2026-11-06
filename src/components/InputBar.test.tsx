// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InputBar } from './InputBar'
import { getPref, setPref, resetPrefsForTest } from '../lib/prefs'
import type { PermissionMode } from '../types'

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

describe('InputBar Shift+Tab mode cycling', () => {
  async function renderWith(mode: PermissionMode, onChange = vi.fn()) {
    await act(async () => {
      root.render(
        <InputBar
          onSendInput={vi.fn()} isWaiting={false} disabled={false} onEscape={vi.fn()}
          pendingFiles={[]} onAddFiles={vi.fn()} onRemoveFile={vi.fn()}
          currentPermissionMode={mode} onPermissionModeChange={onChange}
        />,
      )
    })
    return onChange
  }

  function shiftTab() {
    const textarea = container.querySelector('textarea')!
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    act(() => { textarea.dispatchEvent(event) })
    return event
  }

  afterEach(() => { resetPrefsForTest(); vi.restoreAllMocks() })

  it('switches to the next enabled mode and keeps focus in the field', async () => {
    resetPrefsForTest({ enabledPermissionModes: ['default', 'plan'] })
    const onChange = await renderWith('default')
    const event = shiftTab()
    expect(event.defaultPrevented).toBe(true)
    expect(onChange).toHaveBeenCalledWith('plan')
  })

  it('never lands on a dangerous mode, so it never has to ask', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onChange = await renderWith('plan')  // every mode enabled (unset)
    shiftTab()
    expect(onChange).toHaveBeenCalledWith('default')
    await renderWith('acceptEdits', onChange)
    shiftTab()
    expect(onChange).toHaveBeenLastCalledWith('plan')
    expect(onChange.mock.calls.flat()).not.toContain('bypassPermissions')
    expect(onChange.mock.calls.flat()).not.toContain('dangerouslySkipPermissions')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('steps out of a dangerous mode to the first safe one without asking', async () => {
    resetPrefsForTest({ enabledPermissionModes: ['plan', 'acceptEdits', 'bypassPermissions'] })
    const confirm = vi.spyOn(window, 'confirm')
    const onChange = await renderWith('bypassPermissions')
    shiftTab()
    expect(onChange).toHaveBeenCalledWith('acceptEdits')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('does nothing when only dangerous modes are enabled besides the current one', async () => {
    resetPrefsForTest({ enabledPermissionModes: ['bypassPermissions', 'dangerouslySkipPermissions'] })
    const onChange = await renderWith('bypassPermissions')
    shiftTab()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('asks every time a dangerous mode is picked from the menu', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValueOnce(true)
    const onChange = await renderWith('default')
    const item = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(label))
    const pick = (label: string) => {
      // Declining leaves the menu open; only open it when it's closed.
      if (!item(label)) act(() => { container.querySelector<HTMLButtonElement>('button[title^="Permission mode:"]')!.click() })
      act(() => { item(label)!.click() })
    }
    pick('Bypass permissions')
    pick('Bypass permissions')
    pick('Bypass permissions')
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(getPref('confirmedDangerousModes' as never)).toBeUndefined()
  })

  it('uses the red bypass background by default and updates when the preference changes', async () => {
    await renderWith('plan')
    expect(container.querySelector('.composer-card')?.getAttribute('data-mode-tone')).toBe('plan')
    await renderWith('dangerouslySkipPermissions')
    expect(container.querySelector('.composer-card')?.getAttribute('data-mode-tone')).toBe('danger')
    act(() => { setPref('bypassComposerBackground', 'standard') })
    expect(container.querySelector('.composer-card')?.hasAttribute('data-mode-tone')).toBe(false)
    act(() => { setPref('bypassComposerBackground', 'red') })
    expect(container.querySelector('.composer-card')?.getAttribute('data-mode-tone')).toBe('danger')
    await renderWith('bypassPermissions')
    expect(container.querySelector('.composer-card')?.getAttribute('data-mode-tone')).toBe('danger')
    act(() => { setPref('bypassComposerBackground', 'standard') })
    expect(container.querySelector('.composer-card')?.hasAttribute('data-mode-tone')).toBe(false)
    await renderWith('acceptEdits')
    expect(container.querySelector('.composer-card')?.hasAttribute('data-mode-tone')).toBe(false)
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

describe('InputBar refocus on window return', () => {
  async function renderBar(props: Partial<Parameters<typeof InputBar>[0]> = {}) {
    await act(async () => {
      root.render(
        <InputBar
          onSendInput={vi.fn()} isWaiting={false} disabled={false} onEscape={vi.fn()}
          pendingFiles={[]} onAddFiles={vi.fn()} onRemoveFile={vi.fn()}
          {...props}
        />,
      )
    })
    const textarea = container.querySelector('textarea')!
    textarea.blur()
    return textarea
  }

  const returnToWindow = () => act(async () => { window.dispatchEvent(new Event('focus')) })

  it('focuses the composer when nothing else holds focus', async () => {
    const textarea = await renderBar()
    expect(document.activeElement).toBe(document.body)
    await returnToWindow()
    expect(document.activeElement).toBe(textarea)
  })

  it('leaves focus alone when another control has it', async () => {
    await renderBar()
    const other = document.createElement('input')
    container.appendChild(other)
    other.focus()
    await returnToWindow()
    expect(document.activeElement).toBe(other)
  })

  it('does not steal focus from an open dialog', async () => {
    const textarea = await renderBar()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    container.appendChild(dialog)
    await returnToWindow()
    expect(document.activeElement).not.toBe(textarea)
  })

  it('does nothing on mobile', async () => {
    const textarea = await renderBar({ isMobile: true })
    await returnToWindow()
    expect(document.activeElement).not.toBe(textarea)
  })
})

describe('InputBar effort picker', () => {
  const models = [
    { id: 'claude-opus-5', label: 'Opus 5', efforts: [{ id: 'low' }, { id: 'high' }, { id: 'xhigh' }] },
    { id: 'glm', label: 'GLM' },
  ]

  async function renderBar(props: Partial<Parameters<typeof InputBar>[0]> = {}) {
    const onEffortChange = vi.fn()
    await act(async () => {
      root.render(
        <InputBar
          onSendInput={vi.fn()} isWaiting={false} disabled={false} onEscape={vi.fn()}
          pendingFiles={[]} onAddFiles={vi.fn()} onRemoveFile={vi.fn()}
          sessionProvider="claude"
          currentModel="claude-opus-5" onModelChange={vi.fn()} availableModels={models}
          currentEffort="high" onEffortChange={onEffortChange}
          {...props}
        />,
      )
    })
    return onEffortChange
  }

  const chip = () => container.querySelector('button[title*="change model, effort"]') as HTMLButtonElement
  const buttonByText = (text: string) =>
    Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim().startsWith(text)) as HTMLButtonElement

  it('names the effort on the chip and beside the model', async () => {
    await renderBar()
    expect(chip().textContent).toContain('High')
    await act(async () => { chip().click() })
    expect(buttonByText('Opus 5').textContent).toContain('High')
    // A model without effort control shows no level.
    expect(buttonByText('GLM').textContent).toBe('GLM')
  })

  it('picks a level from the Effort pane', async () => {
    const onEffortChange = await renderBar()
    await act(async () => { chip().click() })
    await act(async () => { buttonByText('Effort').click() })
    await act(async () => { buttonByText('Extra high').click() })
    expect(onEffortChange).toHaveBeenCalledWith('xhigh')
  })

  it('offers Default for a harness whose default is unknown', async () => {
    const onEffortChange = await renderBar()
    await act(async () => { chip().click() })
    await act(async () => { buttonByText('Effort').click() })
    await act(async () => { buttonByText('Default').click() })
    expect(onEffortChange).toHaveBeenCalledWith(null)
  })

  it('cycles effort with Mod+Shift+E', async () => {
    const onEffortChange = await renderBar()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', shiftKey: true, metaKey: true, ctrlKey: true }))
    })
    // high → xhigh: the next level in the model's cycle.
    expect(onEffortChange).toHaveBeenCalledWith('xhigh')
  })

  it('hides the Effort row for models without effort control', async () => {
    await renderBar({ currentModel: 'glm' })
    await act(async () => { chip().click() })
    expect(buttonByText('Effort')).toBeUndefined()
    expect(container.textContent).not.toContain('Cycle effort')
  })
})
