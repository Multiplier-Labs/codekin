/**
 * Tests for the full Settings dialog (local build): every section renders and
 * loads its own data from the machine when the dialog opens, nothing is asked
 * while it is closed, section save failures reach the shared error line, and
 * the footer still commits the access token.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Settings as SettingsType } from '../types'

const api = vi.hoisted(() => ({
  verifyToken: vi.fn(() => Promise.resolve(true)),
  getRetentionDays: vi.fn(() => Promise.resolve(30)),
  setRetentionDays: vi.fn(() => Promise.reject(new Error('down'))),
  getReposPath: vi.fn(() => Promise.resolve('/srv/repos')),
  setReposPath: vi.fn(() => Promise.resolve()),
  getWorktreePrefix: vi.fn(() => Promise.resolve('wt/')),
  setWorktreePrefix: vi.fn(() => Promise.resolve()),
  getQueueMessages: vi.fn(() => Promise.resolve(true)),
  setQueueMessages: vi.fn(() => Promise.resolve()),
  setAgentName: vi.fn(() => Promise.resolve('Joe')),
  getWebhookConfig: vi.fn(() => Promise.resolve({ enabled: true, maxConcurrentSessions: 3 })),
  getWebhookEvents: vi.fn(() => Promise.resolve([])),
  getIntegrationHealth: vi.fn(),
  previewWebhookSetup: vi.fn(),
  applyWebhookSetup: vi.fn(),
  testWebhookDelivery: vi.fn(),
  getRepoApprovals: vi.fn(() => Promise.resolve({ tools: ['Read'], commands: ['ls'], patterns: [] })),
  bulkRemoveRepoApprovals: vi.fn(() => Promise.resolve()),
  webhookEndpointUrl: () => 'https://example.test/api/webhooks/github',
}))
vi.mock('../lib/ccApi', () => api)
vi.mock('./FolderPicker', () => ({ FolderPicker: ({ value }: { value: string }) => <span data-testid="repos-path">{value}</span> }))

import { Settings } from './Settings'

const settings: SettingsType = { token: 'tok', fontSize: 14, theme: 'dark' }
let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

async function render(ui: React.ReactElement): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { root = createRoot(container!); root.render(ui) })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  return container
}

beforeEach(() => { Object.values(api).forEach(fn => { if (vi.isMockFunction(fn)) fn.mockClear() }) })
afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
})

describe('Settings dialog', () => {
  it('asks the machine nothing while closed', async () => {
    await render(<Settings open={false} onClose={vi.fn()} settings={settings} onUpdate={vi.fn()} />)
    expect(api.getRetentionDays).not.toHaveBeenCalled()
    expect(api.getWebhookConfig).not.toHaveBeenCalled()
  })

  it('renders every section with the values each one loaded', async () => {
    const el = await render(
      <Settings open onClose={vi.fn()} settings={settings} onUpdate={vi.fn()} repos={[{ workingDir: '/r/a' } as never]} />,
    )
    for (const title of ['Authentication', 'Preferences', 'Permissions', 'GitHub Webhooks']) {
      expect(el.textContent).toContain(title)
    }
    expect(el.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('30')
    expect(el.querySelector('[data-testid="repos-path"]')!.textContent).toBe('/srv/repos')
    expect(el.textContent).toContain('2 approved patterns across 1 repo')
    expect(el.textContent).toContain('max 3 concurrent sessions')
    // Hosted-only sections stay out of the local build.
    expect(el.textContent).not.toContain('Workspace')
  })

  it('shows a section’s save failure on the shared error line', async () => {
    const el = await render(<Settings open onClose={vi.fn()} settings={settings} onUpdate={vi.fn()} />)
    const retention = el.querySelector<HTMLInputElement>('input[type="number"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setValue.call(retention, '10'); retention.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(el.textContent).toContain('Failed to save retention setting')
  })

  it('switches theme immediately and commits the token from the footer', async () => {
    const onUpdate = vi.fn()
    const onClose = vi.fn()
    const el = await render(<Settings open onClose={onClose} settings={settings} onUpdate={onUpdate} />)
    const light = [...el.querySelectorAll('[role="radio"]')].find(b => b.textContent?.includes('Light'))!
    await act(async () => { light.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onUpdate).toHaveBeenCalledWith({ theme: 'light' })
    const save = [...el.querySelectorAll('button')].find(b => b.textContent === 'Save')!
    await act(async () => { save.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onUpdate).toHaveBeenCalledWith({ token: 'tok' })
    expect(onClose).toHaveBeenCalled()
  })
})
