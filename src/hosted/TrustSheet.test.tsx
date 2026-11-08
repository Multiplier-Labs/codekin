/** Tests for the "Confirm this browser" sheet: code shown, outcome polled, failures explained. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const trust = vi.hoisted(() => ({
  startEnrolment: vi.fn(),
  currentUserId: vi.fn(),
  deviceTrustSupported: vi.fn(),
  deletePin: vi.fn(),
}))
vi.mock('./deviceTrust', async importOriginal => ({
  ...(await importOriginal<typeof import('./deviceTrust')>()),
  startEnrolment: trust.startEnrolment,
  currentUserId: trust.currentUserId,
  deviceTrustSupported: trust.deviceTrustSupported,
  trustStorage: () => ({ deletePin: trust.deletePin }),
}))
vi.mock('../lib/transport/relay-client', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/transport/relay-client')>()),
  RelayConnection: class { connect() {} close() {} enrol() { return Promise.resolve({}) } },
}))

import { TrustSheet } from './TrustSheet'
import { EnrolmentFailure } from './deviceTrust'
import { RelayRequestError } from '../lib/transport/relay-client'

let root: Root | null = null
let el: HTMLDivElement | null = null

async function render(props: Partial<Parameters<typeof TrustSheet>[0]> = {}) {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  const onTrusted = vi.fn()
  await act(async () => {
    root!.render(<TrustSheet machineId="m1" machineName="Dev box" onClose={() => {}} onTrusted={onTrusted} {...props} />)
  })
  await act(async () => { await Promise.resolve() })
  return { onTrusted }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  trust.currentUserId.mockResolvedValue('u1')
  trust.deviceTrustSupported.mockReturnValue(true)
})

afterEach(() => {
  act(() => { root?.unmount() })
  el?.remove()
  root = null
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('TrustSheet', () => {
  it('shows the code, then the approval once the machine signs it', async () => {
    const check = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('approved')
    trust.startEnrolment.mockResolvedValue({ enrolId: 'e1', code: 'K7QM-2XPA', machineKeyId: 'mk', check })
    const { onTrusted } = await render()
    expect(el!.querySelector('[aria-label="Confirmation code"]')?.textContent).toBe('K7QM-2XPA')
    expect(el!.textContent).toContain('codekin relay devices approve K7QM-2XPA')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(onTrusted).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(el!.textContent).toContain('This browser is confirmed on Dev box.')
    expect(onTrusted).toHaveBeenCalledTimes(1)
  })

  it('waits for a machine that is still coming online', async () => {
    trust.startEnrolment
      .mockRejectedValueOnce(new RelayRequestError('machine_offline', 'Machine is not connected'))
      .mockResolvedValueOnce({ enrolId: 'e1', code: 'ABCD-EFGH', machineKeyId: 'mk', check: vi.fn().mockResolvedValue(null) })
    await render()
    expect(el!.textContent).toContain('Waiting for Dev box to come online')
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(el!.textContent).toContain('ABCD-EFGH')
  })

  it('explains an outdated computer and a changed machine key', async () => {
    trust.startEnrolment.mockRejectedValueOnce(new RelayRequestError('connector_update_required', 'x'))
    await render()
    expect(el!.textContent).toContain('Update Codekin on that computer')
    act(() => { root?.unmount() }); el?.remove()

    trust.startEnrolment.mockRejectedValueOnce(new EnrolmentFailure('machine_key_changed', 'Key changed.'))
    await render()
    expect(el!.textContent).toContain('Key changed.')
    const forget = [...el!.querySelectorAll('button')].find(b => b.textContent?.includes('Forget the old key'))!
    trust.startEnrolment.mockResolvedValueOnce({ enrolId: 'e2', code: 'WXYZ-2345', machineKeyId: 'mk', check: vi.fn().mockResolvedValue(null) })
    await act(async () => { forget.click() })
    await act(async () => { await Promise.resolve() })
    expect(trust.deletePin).toHaveBeenCalledWith('u1', 'm1')
    expect(el!.textContent).toContain('WXYZ-2345')
  })

  it('says when this browser cannot keep a key', async () => {
    trust.deviceTrustSupported.mockReturnValue(false)
    await render()
    expect(el!.textContent).toContain("can't keep a signing key")
    expect(trust.startEnrolment).not.toHaveBeenCalled()
  })
})
