/** Tests for the generated install / pair commands and their live expiry. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { InstallCommand } from './InstallCommand'
import { formatTimeLeft, type Pairing } from './machines'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function pairing(overrides: Partial<Pairing> = {}): Pairing {
  return { pairingToken: 'tok-abc', machineId: 'm-new', expiresAt: Date.now() + 10 * 60_000, ...overrides }
}

function render(ui: React.ReactElement): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(ui)
  })
  return container
}

function rerender(ui: React.ReactElement) {
  act(() => { root!.render(ui) })
}

/**
 * Advance the fake clock in small steps: each countdown tick schedules the
 * next one only after React commits, so one big jump would fire one tick.
 */
function advance(ms: number) {
  let left = ms
  while (left > 0) {
    const step = Math.min(500, left)
    act(() => { vi.advanceTimersByTime(step) })
    left -= step
  }
}

const codes = () => [...container!.querySelectorAll('code')].map(c => c.textContent)
const timeLeft = () => container!.querySelector('[data-testid="time-left"]')?.textContent

describe('InstallCommand', () => {
  it('renders an https installer command carrying the token in CODEKIN_PAIR_TOKEN', () => {
    render(<InstallCommand pairing={pairing()} onGenerate={vi.fn()} generating={false} error={null} />)
    // jsdom's origin is not the default relay, so it is named explicitly
    const origin = window.location.origin
    expect(codes()).toEqual([
      `curl -fsSL https://codekin.ai/install.sh | CODEKIN_PAIR_TOKEN=tok-abc bash -s -- --relay ${origin}`,
      `CODEKIN_PAIR_TOKEN=tok-abc codekin relay login --url ${origin}`,
    ])
  })

  it('offers to generate when there is no command yet', () => {
    const onGenerate = vi.fn()
    render(<InstallCommand pairing={null} onGenerate={onGenerate} generating={false} error={null} />)
    const button = container!.querySelector('button')!
    expect(button.textContent).toContain('Generate install command')
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onGenerate).toHaveBeenCalled()
  })

  it('counts down live, in seconds for the last minute, then hides the expired command', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'))
    const onGenerate = vi.fn()
    render(<InstallCommand pairing={pairing()} onGenerate={onGenerate} generating={false} error={null} />)
    expect(timeLeft()).toBe('10 min')

    advance(4 * 60_000 + 30_000)
    expect(timeLeft()).toBe('6 min')

    advance(5 * 60_000)
    expect(timeLeft()).toBe('30 s')

    advance(29_000)
    expect(timeLeft()).toBe('1 s')

    advance(2_000)
    // Past expiry: no valid-looking command is left on screen.
    expect(codes()).toEqual([])
    expect(container!.textContent).toContain('expired')
    const regenerate = [...container!.querySelectorAll('button')].find(b => b.textContent?.includes('Generate a new command'))
    expect(regenerate).toBeDefined()
    act(() => { regenerate!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onGenerate).toHaveBeenCalled()
  })

  it('shows a fresh countdown for a regenerated command after the old one expired', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'))
    const props = { onGenerate: vi.fn(), generating: false, error: null }
    render(<InstallCommand pairing={pairing()} {...props} />)
    advance(60 * 60_000)
    expect(codes()).toEqual([])

    rerender(<InstallCommand pairing={pairing({ pairingToken: 'tok-new', expiresAt: Date.now() + 10 * 60_000 })} {...props} />)
    advance(10)
    expect(timeLeft()).toBe('10 min')
    expect(codes()[0]).toContain('tok-new')
  })

  it('shows a regeneration error even while an older command is displayed', () => {
    render(
      <InstallCommand
        pairing={pairing()}
        onGenerate={vi.fn()}
        generating={false}
        error="Too many install commands in a short time. Wait a minute, then try again."
      />,
    )
    expect(codes()).toHaveLength(2)
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain('Too many install commands')
  })
})

describe('formatTimeLeft', () => {
  it('uses whole minutes above one minute and seconds below', () => {
    expect(formatTimeLeft(10 * 60_000)).toBe('10 min')
    expect(formatTimeLeft(61_000)).toBe('2 min')
    expect(formatTimeLeft(60_000)).toBe('60 s')
    expect(formatTimeLeft(1)).toBe('1 s')
    expect(formatTimeLeft(-5)).toBe('0 s')
  })
})
