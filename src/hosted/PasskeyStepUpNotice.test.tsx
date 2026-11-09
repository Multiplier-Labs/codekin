/** The notice that says why the passkey prompt is up (§6.6b). */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PasskeyStepUpNotice } from './PasskeyStepUpNotice'
import { PASSKEY_STEP_UP_EVENT, type PasskeyStepUpDetail } from './intentSigner'

let root: Root | null = null
let el: HTMLDivElement | null = null
afterEach(() => { act(() => { root?.unmount() }); el?.remove(); root = null })

const fire = (detail: PasskeyStepUpDetail) => act(() => { window.dispatchEvent(new CustomEvent(PASSKEY_STEP_UP_EVENT, { detail })) })

describe('PasskeyStepUpNotice', () => {
  it('explains a bypass-permissions prompt while it is up, then goes away', () => {
    el = document.createElement('div')
    document.body.appendChild(el)
    root = createRoot(el)
    act(() => { root!.render(<PasskeyStepUpNotice />) })
    expect(el.textContent).toBe('')
    fire({ active: true, reason: 'bypass' })
    expect(el.textContent).toContain('Confirm with your passkey')
    expect(el.textContent).toContain('bypass permissions')
    expect(el.textContent).toContain("won't ask again for 15 minutes")
    fire({ active: false, reason: 'bypass' })
    expect(el.textContent).toBe('')
    // No session reason (a share with shell approvals, a device change): no promise of a window.
    fire({ active: true, reason: null })
    expect(el.textContent).toContain('sensitive action')
    expect(el.textContent).not.toContain('15 minutes')
  })
})
