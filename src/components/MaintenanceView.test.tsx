// @vitest-environment jsdom
/** Tests for the repo maintenance view: explicit, reviewed enrollment and honest health. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaintenanceView } from './MaintenanceView'
import * as maintenanceApi from '../lib/maintenanceApi'
import type { RepoMaintenance } from '../lib/maintenanceApi'

vi.mock('../lib/maintenanceApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/maintenanceApi')>()),
  getMaintenancePlan: vi.fn(),
  setPlanState: vi.fn(async () => ({})),
}))
vi.mock('../lib/workflowApi', () => ({
  getConfig: vi.fn(async () => ({ reviewRepos: [{ id: 'deps', name: 'Dependency health', repoPath: '/r/app', cronExpression: '0 6 * * *', enabled: true }] })),
}))
vi.mock('../lib/tasksApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tasksApi')>()),
  listTasks: vi.fn(async () => ({ tasks: [], counts: {} })),
}))

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
  vi.clearAllMocks()
})

function plan(overrides: Partial<RepoMaintenance>): RepoMaintenance {
  return {
    repo: '/r/app', state: 'off', revision: 0, health: null, label: 'Not maintained', reasons: [],
    responsibilities: [{
      id: 'r1', repo: '/r/app', name: 'Keep dependencies healthy', scope: 'package.json', automationIds: ['deps'], policy: 'propose',
      maxActiveTasks: 1, requiredDecision: '', enabled: true, proposed: true, latestObservation: null, latestObservationAt: null,
      health: null, reasons: [], openTasks: 0,
      checks: [{ automationId: 'deps', name: 'Dependency health', managedBy: 'user', health: 'starting', lastSuccessAt: null, nextRunAt: '2026-10-01T06:00:00Z', hold: null }],
    }],
    activeTasks: 0, runningTasks: 0, needsYou: 0, governedAutomations: [], hasProposal: true, updatedAt: null, ...overrides,
  }
}

async function render() {
  await act(async () => {
    root.render(<MaintenanceView token="tok" repo="/r/app" agentName="Joe" onBack={vi.fn()} onOpenTasks={vi.fn()} onOpenSession={vi.fn()} onOpenAutomations={vi.fn()} onChanged={vi.fn()} />)
  })
}

const button = (text: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(text))

describe('MaintenanceView', () => {
  it('shows a proposal and enables only after the user reviews it', async () => {
    vi.mocked(maintenanceApi.getMaintenancePlan).mockResolvedValue({ plan: plan({}), activity: [] })
    await render()
    expect(container.textContent).toContain('Not maintained')
    expect(container.textContent).toContain('Proposed by Joe')

    await act(async () => { button('Review & enable')!.click() })
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Keep dependencies healthy')
    // Opt the automation out of adoption: it keeps running on its own controls.
    const adopt = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement
    await act(async () => { adopt.click() })
    await act(async () => { button('Enable maintenance')!.click() })
    expect(maintenanceApi.setPlanState).toHaveBeenCalledWith('tok', 'enable', '/r/app', { expectedRevision: 0, adoptAutomationIds: [] })
  })

  it('names what is wrong instead of showing a healthy badge', async () => {
    vi.mocked(maintenanceApi.getMaintenancePlan).mockResolvedValue({
      plan: plan({ state: 'enabled', revision: 2, health: 'degraded', label: 'Maintenance needs attention', reasons: ['Keep dependencies healthy: Dependency health: held (repo dormant)'], hasProposal: false }),
      activity: [{ id: 'a1', repo: '/r/app', responsibilityId: 'r1', kind: 'check_failed', summary: 'Check failed: npm audit crashed', ref: null, createdAt: '2026-09-30T06:00:00Z' }],
    })
    await render()
    expect(container.textContent).toContain('Maintenance needs attention')
    expect(container.textContent).toContain('held (repo dormant)')
    expect(container.textContent).toContain('Check failed: npm audit crashed')
    await act(async () => { button('Pause')!.click() })
    expect(maintenanceApi.setPlanState).toHaveBeenCalledWith('tok', 'pause', '/r/app', { expectedRevision: 2 })
  })
})
