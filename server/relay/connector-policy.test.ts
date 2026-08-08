/**
 * Frame-level permission enforcement on the connector.
 *
 * These are the checks that stand between a shared-in user and someone
 * else's machine, so they are exercised directly rather than only through
 * the relay.
 */
import { describe, it, expect } from 'vitest'
import {
  checkClientFrame,
  filterSessionList,
  newChannelState,
  observeServerFrame,
  permissionForTool,
} from './connector-policy.js'
import type { ChannelPolicy } from './connector-policy.js'

const owner: ChannelPolicy = { role: 'owner', grants: {} }

/** An editor on s1: may drive the session, may not approve dangerous tools. */
const editor: ChannelPolicy = {
  role: 'grantee',
  grants: { s1: ['view', 'view_diff', 'send_prompt', 'upload_file', 'approve_readonly_tool'] },
}

const viewer: ChannelPolicy = { role: 'grantee', grants: { s1: ['view', 'view_diff'] } }

function frame(msg: Record<string, unknown>): string {
  return JSON.stringify(msg)
}

/** A channel that has already joined the shared session. */
function joined(policy: ChannelPolicy, sessionId = 's1') {
  const state = newChannelState()
  checkClientFrame(policy, state, frame({ type: 'join_session', sessionId }))
  return state
}

describe('permissionForTool', () => {
  it('classifies shell, read-only, and mutating tools', () => {
    expect(permissionForTool('Bash')).toBe('approve_shell')
    expect(permissionForTool('Read')).toBe('approve_readonly_tool')
    expect(permissionForTool('Write')).toBe('approve_mutating_tool')
  })

  it('treats an unknown or missing tool as mutating', () => {
    // Failing closed matters: a tool added later must not be auto-approvable
    expect(permissionForTool('SomeFutureTool')).toBe('approve_mutating_tool')
    expect(permissionForTool(undefined)).toBe('approve_mutating_tool')
  })
})

describe('joining a session', () => {
  it('lets a grantee join only a shared session', () => {
    const state = newChannelState()
    expect(checkClientFrame(editor, state, frame({ type: 'join_session', sessionId: 's1' })).allowed).toBe(true)
    expect(checkClientFrame(editor, state, frame({ type: 'join_session', sessionId: 's2' })).allowed).toBe(false)
  })

  it('lets the owner join anything', () => {
    const state = newChannelState()
    expect(checkClientFrame(owner, state, frame({ type: 'join_session', sessionId: 'anything' })).allowed).toBe(true)
  })

  it('refuses actions before a session is joined', () => {
    const state = newChannelState()
    expect(checkClientFrame(editor, state, frame({ type: 'input', data: 'hi' })).allowed).toBe(false)
  })
})

describe('grantee actions', () => {
  it('allows what the grant covers', () => {
    const state = joined(editor)
    expect(checkClientFrame(editor, state, frame({ type: 'input', data: 'hi' })).allowed).toBe(true)
    expect(checkClientFrame(editor, state, frame({ type: 'get_diff' })).allowed).toBe(true)
    expect(checkClientFrame(editor, state, frame({ type: 'ping' })).allowed).toBe(true)
  })

  it('refuses what it does not', () => {
    const state = joined(viewer)
    const input = checkClientFrame(viewer, state, frame({ type: 'input', data: 'hi' }))
    expect(input.allowed).toBe(false)
    expect(input.permission).toBe('send_prompt')
    expect(checkClientFrame(viewer, state, frame({ type: 'stop' })).allowed).toBe(false)
  })

  it('refuses session and machine reshaping outright', () => {
    const state = joined(editor)
    for (const type of [
      'create_session', 'set_model', 'set_provider', 'set_permission_mode',
      'discard_changes', 'move_to_worktree', 'start_claude',
    ]) {
      expect(checkClientFrame(editor, state, frame({ type })).allowed).toBe(false)
    }
  })

  it('refuses an unparsable frame', () => {
    expect(checkClientFrame(editor, joined(editor), 'not json').allowed).toBe(false)
  })
})

describe('approval answers', () => {
  it('classifies the answer by the tool the prompt was for', () => {
    const state = joined(editor)
    observeServerFrame(state, frame({ type: 'prompt', requestId: 'p1', toolName: 'Read' }))
    observeServerFrame(state, frame({ type: 'prompt', requestId: 'p2', toolName: 'Bash' }))
    observeServerFrame(state, frame({ type: 'prompt', requestId: 'p3', toolName: 'Write' }))

    // Editor holds approve_readonly_tool only
    expect(checkClientFrame(editor, state, frame({ type: 'prompt_response', requestId: 'p1', value: 'yes' })).allowed).toBe(true)
    expect(checkClientFrame(editor, state, frame({ type: 'prompt_response', requestId: 'p2', value: 'yes' })).allowed).toBe(false)
    expect(checkClientFrame(editor, state, frame({ type: 'prompt_response', requestId: 'p3', value: 'yes' })).allowed).toBe(false)
  })

  it('treats an answer to an unknown prompt as the strictest kind', () => {
    const state = joined(editor)
    const decision = checkClientFrame(editor, state, frame({ type: 'prompt_response', requestId: 'never-seen', value: 'yes' }))
    expect(decision.allowed).toBe(false)
    expect(decision.permission).toBe('approve_mutating_tool')
  })

  it('forgets a dismissed prompt', () => {
    const state = joined(editor)
    observeServerFrame(state, frame({ type: 'prompt', requestId: 'p1', toolName: 'Read' }))
    observeServerFrame(state, frame({ type: 'prompt_dismiss', requestId: 'p1' }))
    // Now unclassifiable, so judged as mutating and refused
    expect(checkClientFrame(editor, state, frame({ type: 'prompt_response', requestId: 'p1', value: 'yes' })).allowed).toBe(false)
  })

  it('bounds how many prompts it remembers', () => {
    const state = joined(editor)
    for (let i = 0; i < 200; i++) {
      observeServerFrame(state, frame({ type: 'prompt', requestId: `p${i}`, toolName: 'Read' }))
    }
    expect(state.pendingPrompts.size).toBeLessThanOrEqual(64)
  })

  it('lets an owner answer anything', () => {
    const state = joined(owner, 'any')
    expect(checkClientFrame(owner, state, frame({ type: 'prompt_response', requestId: 'x', value: 'yes' })).allowed).toBe(true)
  })
})

describe('filterSessionList', () => {
  it('keeps only granted sessions', () => {
    const body = JSON.stringify({ sessions: [{ id: 's1' }, { id: 's2' }], extra: 1 })
    const filtered = JSON.parse(filterSessionList(viewer, body)!) as { sessions: { id: string }[]; extra: number }
    expect(filtered.sessions).toEqual([{ id: 's1' }])
    // Unrelated fields survive
    expect(filtered.extra).toBe(1)
  })

  it('refuses a body it cannot filter', () => {
    expect(filterSessionList(viewer, 'not json')).toBeNull()
    expect(filterSessionList(viewer, JSON.stringify({ nope: true }))).toBeNull()
  })
})
