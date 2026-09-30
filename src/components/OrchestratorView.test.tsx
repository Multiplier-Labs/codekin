// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestratorView } from './OrchestratorView'
import * as api from '../lib/ccApi'
import { setAgentHealth } from '../lib/agentHealth'

vi.mock('../lib/ccApi', () => ({
  getOrchestratorStatus: vi.fn(),
  startOrchestrator: vi.fn(),
  getOrchestratorDashboard: vi.fn(async () => null),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const ready = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  setAgentHealth({ claudeAvailable: false, claudeAuthenticated: false, claudeVersion: '', codexAvailable: true, codexAuthenticated: true, openCodeAvailable: true })
  vi.mocked(api.getOrchestratorStatus).mockResolvedValue({ provider: null })
  vi.mocked(api.startOrchestrator).mockResolvedValue({ sessionId: 'joe', status: 'active' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
})

async function render() {
  await act(async () => { root.render(<OrchestratorView token="test" onOrchestratorSessionReady={ready} sessionJoined={false} />) })
}

describe('Joe harness selection', () => {
  it('does not start Claude before the user chooses and starts the selected Codex harness', async () => {
    await render()
    expect(api.startOrchestrator).not.toHaveBeenCalled()
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.find(b => b.textContent?.startsWith('Claude'))?.disabled).toBe(true)
    const codex = buttons.find(b => b.textContent?.startsWith('Codex'))!
    await act(async () => { codex.click() })
    expect(api.startOrchestrator).toHaveBeenCalledWith('test', 'codex')
    expect(ready).toHaveBeenCalledWith('joe')
  })

  it('resumes the saved harness without replacing it with a browser default', async () => {
    vi.mocked(api.getOrchestratorStatus).mockResolvedValue({ provider: 'opencode' })
    await render()
    expect(api.startOrchestrator).toHaveBeenCalledExactlyOnceWith('test')
    expect(ready).toHaveBeenCalledWith('joe')
  })

  it('offers a different harness after a startup failure', async () => {
    vi.mocked(api.getOrchestratorStatus).mockResolvedValue({ provider: 'claude' })
    vi.mocked(api.startOrchestrator).mockRejectedValueOnce(new Error('Unavailable harness'))
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Unavailable harness')
    const opencode = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.startsWith('OpenCode'))!
    await act(async () => { opencode.click() })
    expect(api.startOrchestrator).toHaveBeenLastCalledWith('test', 'opencode')
    expect(ready).toHaveBeenCalledWith('joe')
  })
})

describe('activity log header', () => {
  it('labels the view as a log and links back to Tasks', async () => {
    vi.mocked(api.getOrchestratorStatus).mockResolvedValue({ provider: 'codex' })
    const onBack = vi.fn()
    await act(async () => {
      root.render(<OrchestratorView token="test" onOrchestratorSessionReady={ready} sessionJoined onBackToTasks={onBack} />)
    })
    expect(container.textContent).toContain('activity log')
    expect(container.querySelector('[role="tab"]')).toBeNull()
    const back = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Tasks'))!
    await act(async () => { back.click() })
    expect(onBack).toHaveBeenCalled()
  })
})
