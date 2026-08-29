/**
 * Tests for the global sign-out control in the devices section.
 *
 * The behaviour that matters is that it cannot fire on one click: it ends the
 * session of the tab you are looking at, so an accidental hit is a real cost.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { DevicesSection } from './DevicesSection'

// The other two panels reach for the network and WebAuthn on mount; neither is
// under test here, and both are noisy in jsdom.
vi.mock('./passkeys', () => ({
  passkeysSupported: () => false,
  fetchPasskeys: () => Promise.resolve([]),
  registerPasskey: () => Promise.reject(new Error('unused')),
  removePasskey: () => Promise.resolve(false),
  defaultPasskeyLabel: () => 'This device',
  isPasskeyCancel: () => false,
}))

const signOutEverywhere = vi.fn()
vi.mock('./sessions', async () => {
  const actual = await vi.importActual<typeof import('./sessions')>('./sessions')
  return { ...actual, signOutEverywhere: () => signOutEverywhere() as Promise<{ destroyed: number }> }
})

let activeRoot: ReturnType<typeof createRoot> | null = null
let activeContainer: HTMLElement | null = null

const reload = vi.fn()

async function render(): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    activeRoot = createRoot(container)
    activeRoot.render(<DevicesSection reload={reload} />)
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  activeContainer = container
  return container
}

function buttonLabelled(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text))
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

afterEach(() => {
  if (activeRoot) act(() => { activeRoot!.unmount() })
  activeContainer?.remove()
  activeRoot = null
  activeContainer = null
  signOutEverywhere.mockReset()
  reload.mockReset()
})

describe('sign out everywhere', () => {
  it('does not sign out on the first click — it asks first', async () => {
    const container = await render()

    await click(buttonLabelled(container, 'Sign out everywhere')!)

    expect(signOutEverywhere).not.toHaveBeenCalled()
    expect(buttonLabelled(container, 'Yes, sign out everywhere')).toBeDefined()
  })

  it('signs out once confirmed, then resets the page', async () => {
    signOutEverywhere.mockResolvedValue({ destroyed: 3 })
    const container = await render()

    await click(buttonLabelled(container, 'Sign out everywhere')!)
    await click(buttonLabelled(container, 'Yes, sign out everywhere')!)

    expect(signOutEverywhere).toHaveBeenCalledTimes(1)
    // The relay socket and machine connection are dead now; staying on the
    // current tree would leave the app wired to a session that no longer exists.
    expect(reload).toHaveBeenCalled()
    expect(container.textContent).toContain('2 other sessions were ended')
  })

  it('backs out without signing out when cancelled', async () => {
    const container = await render()

    await click(buttonLabelled(container, 'Sign out everywhere')!)
    await click(buttonLabelled(container, 'Cancel')!)

    expect(signOutEverywhere).not.toHaveBeenCalled()
    // Back to the un-armed state, ready to ask again.
    expect(buttonLabelled(container, 'Yes, sign out everywhere')).toBeUndefined()
    expect(buttonLabelled(container, 'Sign out everywhere')).toBeDefined()
  })

  it('reports a failure and re-arms instead of claiming success', async () => {
    signOutEverywhere.mockRejectedValue(new Error('nope'))
    const container = await render()

    await click(buttonLabelled(container, 'Sign out everywhere')!)
    await click(buttonLabelled(container, 'Yes, sign out everywhere')!)

    expect(container.textContent).toContain('Could not sign out everywhere')
    // The user is still signed in, so the offer must still be on screen and the
    // page must not have been reset out from under them.
    expect(buttonLabelled(container, 'Sign out everywhere')).toBeDefined()
    expect(reload).not.toHaveBeenCalled()
  })
})
