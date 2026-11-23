/** Tests for SessionContent — the session column around the transcript and composer. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('./ChatView', () => ({ ChatView: () => <div data-testid="chat" /> }))
vi.mock('./TodoPanel', () => ({ TodoPanel: () => null }))
vi.mock('./InputBar', () => ({ InputBar: () => <textarea data-testid="composer" /> }))
vi.mock('./TentativeBanner', () => ({ TentativeBanner: () => <div data-testid="tentative" /> }))
import { SessionContent, type SessionContentProps } from './SessionContent.js'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
})

const noop = () => {}

function props(overrides: Partial<SessionContentProps> = {}): SessionContentProps {
  return {
    activeSessionId: 's1', messages: [], fontSize: 14, isMobile: false, planningMode: false, tasks: [],
    isProcessing: false, disabled: false, hasFileChanges: false, diffPanelOpen: false, onOpenDiffPanel: noop,
    activePrompt: null, promptQueueSize: 0, sendPromptResponse: noop, activeTentativeCount: 0, activeRepoName: 'repo',
    onExecuteTentative: noop, onDiscardTentative: noop, inputBarRef: createRef(), onSendInput: noop, onInterrupt: noop,
    pendingFiles: [], onAddFiles: noop, onRemoveFile: noop, skillGroups: [], slashCommands: [], sessionInputs: {},
    onSessionInputChange: noop, currentModel: null, onModelChange: noop, hasUserMessages: true, useWorktree: false,
    onWorktreeChange: noop, currentPermissionMode: 'default', onPermissionModeChange: noop, moveToWorktree: undefined,
    worktreePath: undefined, onRetryWorktree: noop, onUseExistingCheckout: noop, openCodeConnected: null,
    codexConnected: null, grokConnected: null,
    ...overrides,
  }
}

describe('SessionContent', () => {
  it('keeps one Keep this work? callout when it shares the session id key with the composer', () => {
    // App keys both the callout and the InputBar by the session id.
    const callout = <div key="s1" role="region" aria-label="Keep this work?" />
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      root = createRoot(container!)
      root.render(<SessionContent {...props({ keepThisWork: callout })} />)
    })
    // Siblings come and go between turns (queued prompts, tentative messages).
    for (const n of [2, 0, 3, 0]) {
      act(() => { root!.render(<SessionContent {...props({ keepThisWork: callout, promptQueueSize: n, activeTentativeCount: n })} />) })
    }
    expect(container.querySelectorAll('[aria-label="Keep this work?"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="composer"]')).toHaveLength(1)
  })
})
