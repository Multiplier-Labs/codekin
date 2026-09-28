/**
 * Tests for the routed Settings view: which sections each build offers,
 * section resolution and redirects (desktop vs mobile), that each section
 * loads its own data from the machine, and per-section save errors.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Settings as SettingsType } from '../../types'

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
vi.mock('../../lib/ccApi', () => api)
vi.mock('../FolderPicker', () => ({ FolderPicker: ({ value }: { value: string }) => <span data-testid="repos-path">{value}</span> }))
// Hosted sections are only probed for presence here.
vi.mock('../../hosted/TwoFactor', () => ({ TwoFactorPanel: () => <p>2FA panel</p> }))
vi.mock('../../hosted/DevicesSection', () => ({ DevicesSection: () => <p>devices panel</p> }))

import { SettingsView } from './SettingsView'
import { availableSections, resolveSection } from './sections'

const local: SettingsType = { token: 'tok', fontSize: 14, theme: 'dark' }
let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

async function render(ui: React.ReactElement): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { root = createRoot(container!); root.render(ui) })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  return container
}

const navLabels = (el: HTMLElement) =>
  [...el.querySelectorAll('nav[aria-label="Settings sections"] button')].map(b => b.textContent)

beforeEach(() => { Object.values(api).forEach(fn => { if (vi.isMockFunction(fn)) fn.mockClear() }) })
afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
})

describe('section map', () => {
  it('offers the local build only appearance and this machine', () => {
    expect(availableSections({ hosted: false, hasToken: true }).map(s => s.id)).toEqual([
      'appearance', 'connection', 'sessions', 'permissions', 'webhooks',
    ])
  })

  it('adds account and workspace sections when hosted, and hides machine settings without a token', () => {
    expect(availableSections({ hosted: true, hasToken: true }).map(s => s.id)).toEqual([
      'security', 'appearance', 'workspace', 'members', 'machines', 'connection', 'sessions', 'permissions', 'webhooks',
    ])
    expect(availableSections({ hosted: false, hasToken: false }).map(s => s.id)).toEqual(['appearance', 'connection'])
  })

  it('resolves only sections that are shown', () => {
    const available = availableSections({ hosted: false, hasToken: true })
    expect(resolveSection('sessions', available)).toBe('sessions')
    expect(resolveSection('members', available)).toBeNull()
    expect(resolveSection('nope', available)).toBeNull()
  })
})

describe('SettingsView', () => {
  const view = (props: Partial<React.ComponentProps<typeof SettingsView>> = {}) => (
    <SettingsView section={null} onNavigate={vi.fn()} onClose={vi.fn()} settings={local} onUpdate={vi.fn()} {...props} />
  )

  it('opens the first section on desktop for bare /settings, replacing the URL', async () => {
    const onNavigate = vi.fn()
    await render(view({ onNavigate }))
    expect(onNavigate).toHaveBeenCalledWith('appearance', true)
  })

  it('shows the section list on mobile for bare /settings, and navigates on a pick', async () => {
    const onNavigate = vi.fn()
    const el = await render(view({ onNavigate, isMobile: true }))
    expect(onNavigate).not.toHaveBeenCalled()
    expect(navLabels(el)).toEqual(['Appearance', 'Connection', 'Sessions', 'Permissions', 'GitHub webhooks'])
    const sessions = [...el.querySelectorAll('nav button')].find(b => b.textContent === 'Sessions')!
    await act(async () => { sessions.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onNavigate).toHaveBeenCalledWith('sessions')
  })

  it('redirects an unavailable or unknown section', async () => {
    const onNavigate = vi.fn()
    await render(view({ section: 'members', onNavigate }))
    expect(onNavigate).toHaveBeenCalledWith('appearance', true)
  })

  it('loads each machine section’s own data only when it is open', async () => {
    let el = await render(view({ section: 'sessions' }))
    expect(el.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('30')
    expect(el.querySelector('[data-testid="repos-path"]')!.textContent).toBe('/srv/repos')
    expect(api.getWebhookConfig).not.toHaveBeenCalled()
    act(() => { root?.unmount() }); container?.remove()

    el = await render(view({ section: 'permissions', repos: [{ workingDir: '/r/a' } as never] }))
    expect(el.textContent).toContain('2 approved patterns across 1 repo')
    act(() => { root?.unmount() }); container?.remove()

    el = await render(view({ section: 'webhooks' }))
    expect(el.textContent).toContain('max 3 concurrent sessions')
  })

  it('shows a section’s save failure within that section', async () => {
    const el = await render(view({ section: 'sessions' }))
    const retention = el.querySelector<HTMLInputElement>('input[type="number"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setValue.call(retention, '10'); retention.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('Failed to save retention setting')
  })

  it('switches theme on click and saves a verified token', async () => {
    const onUpdate = vi.fn()
    let el = await render(view({ section: 'appearance', onUpdate }))
    const light = [...el.querySelectorAll('[role="radio"]')].find(b => b.textContent?.includes('Light'))!
    await act(async () => { light.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onUpdate).toHaveBeenCalledWith({ theme: 'light' })
    act(() => { root?.unmount() }); container?.remove()

    el = await render(view({ section: 'connection', onUpdate, settings: { ...local, token: '' } }))
    const field = el.querySelector<HTMLInputElement>('input[type="password"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setValue.call(field, 'new-token'); field.dispatchEvent(new Event('input', { bubbles: true })) })
    const verify = [...el.querySelectorAll('button')].find(b => b.textContent === 'Verify')!
    await act(async () => { verify.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(onUpdate).toHaveBeenCalledWith({ token: 'new-token' })
  })

  it('in hosted mode groups account and workspace sections, and hides the local token', async () => {
    const el = await render(view({ section: 'connection', onSwitchMachine: vi.fn() }))
    expect(navLabels(el)).toEqual(expect.arrayContaining(['Security', 'General', 'Members', 'Machines']))
    expect(el.querySelector('input[type="password"]')).toBeNull()
    act(() => { root?.unmount() }); container?.remove()

    const security = await render(view({ section: 'security', onSwitchMachine: vi.fn() }))
    expect(security.textContent).toContain('2FA panel')
    expect(security.textContent).toContain('devices panel')
  })

  it('closes', async () => {
    const onClose = vi.fn()
    const el = await render(view({ section: 'appearance', onClose }))
    await act(async () => { el.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]')!.click() })
    expect(onClose).toHaveBeenCalled()
  })
})
