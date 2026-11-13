/**
 * Carry-context provider switch flow: handoff generation on setProvider and
 * injection into the first message under the new provider.
 * handoff-manager is mocked — its own behavior is covered in
 * handoff-manager.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionManager } from './session-manager.js'
import type { Handoff } from './handoff-manager.js'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const mocks = vi.hoisted(() => ({
  generateHandoff: vi.fn(),
  buildHandoffInjection: vi.fn((h: Handoff) => `[HANDOFF from ${h.sourceHarness}]\n${h.content}\n[End of handoff]`),
}))

vi.mock('./handoff-manager.js', () => ({
  generateHandoff: mocks.generateHandoff,
  buildHandoffInjection: mocks.buildHandoffInjection,
}))

function fakeProcess(alive = true) {
  return {
    isAlive: vi.fn(() => alive),
    isReady: vi.fn(() => alive),
    stop: vi.fn(),
    start: vi.fn(),
    on: vi.fn(),
    once: vi.fn((_event: string, cb: () => void) => { cb() }),
    removeAllListeners: vi.fn(),
    sendMessage: vi.fn(),
    sendControlResponse: vi.fn(),
    getSessionId: vi.fn(() => 'native-session-id'),
    hasSessionConflict: vi.fn(() => false),
    hadOutput: vi.fn(() => true),
    hasSpawnFailed: vi.fn(() => false),
    waitForExit: vi.fn(() => Promise.resolve()),
    emit: vi.fn(),
  } as any
}

const FAKE_HANDOFF: Handoff = {
  content: '## Goal\nShip the feature.',
  transcriptPath: '/fake/rollout.jsonl',
  sourceHarness: 'codex',
  distilled: true,
  savedPath: null,
}

describe('carry-context provider switch', () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager()
    mocks.generateHandoff.mockReset()
    mocks.buildHandoffInjection.mockClear()
  })

  it('generates a handoff from the pre-switch identity, then switches', async () => {
    const s = sm.create('test', '/repo')
    s.provider = 'codex'
    s.claudeSessionId = 'thread-abc'
    mocks.generateHandoff.mockResolvedValue(FAKE_HANDOFF)

    sm.setProvider(s.id, 'claude', true)
    await vi.waitFor(() => expect(s.pendingHandoff).toBeDefined())

    expect(mocks.generateHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', harnessSessionId: 'thread-abc', workingDir: '/repo' }),
      undefined,
    )
    expect(s.provider).toBe('claude')
    expect(s.claudeSessionId).toBeNull()
    expect(s.pendingHandoff).toEqual(FAKE_HANDOFF)
    // Status lines were recorded for the user
    const notices = s.outputHistory.filter((m) => m.type === 'system_message')
    expect(notices.some((m) => 'text' in m && (m.text as string).includes('Preparing handoff'))).toBe(true)
    expect(notices.some((m) => 'text' in m && (m.text as string).includes('Handoff ready'))).toBe(true)
  })

  it('uses the worktree path as the handoff working dir when present', async () => {
    const s = sm.create('test', '/repo')
    s.worktreePath = '/worktrees/wt-1'
    s.claudeSessionId = 'abc'
    mocks.generateHandoff.mockResolvedValue(FAKE_HANDOFF)

    sm.setProvider(s.id, 'codex', true)
    await vi.waitFor(() => expect(s.provider).toBe('codex'))

    expect(mocks.generateHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: '/worktrees/wt-1' }),
      undefined,
    )
  })

  it('still switches provider when no transcript is found', async () => {
    const s = sm.create('test', '/repo')
    s.claudeSessionId = 'abc'
    mocks.generateHandoff.mockResolvedValue(null)

    sm.setProvider(s.id, 'codex', true)
    await vi.waitFor(() => expect(s.provider).toBe('codex'))

    expect(s.pendingHandoff).toBeUndefined()
    const notices = s.outputHistory.filter((m) => m.type === 'system_message')
    expect(notices.some((m) => 'text' in m && (m.text as string).includes('No transcript found'))).toBe(true)
  })

  it('does not generate a handoff without carryContext', () => {
    const s = sm.create('test', '/repo')
    sm.setProvider(s.id, 'codex')
    expect(mocks.generateHandoff).not.toHaveBeenCalled()
    expect(s.provider).toBe('codex')
  })

  it('injects the pending handoff into the next message and clears it', () => {
    const s = sm.create('test', '/repo')
    const cp = fakeProcess(true)
    s.claudeProcess = cp
    s.claudeSessionId = 'live-session'
    s.pendingHandoff = FAKE_HANDOFF

    sm.sendInput(s.id, 'continue the work')

    expect(cp.sendMessage).toHaveBeenCalledTimes(1)
    const sent = cp.sendMessage.mock.calls[0][0] as string
    expect(sent).toContain('[HANDOFF from codex]')
    expect(sent).toContain('## Goal')
    expect(sent.endsWith('continue the work')).toBe(true)
    expect(s.pendingHandoff).toBeUndefined()

    // Second message: no re-injection
    sm.sendInput(s.id, 'and then?')
    expect(cp.sendMessage.mock.calls[1][0]).toBe('and then?')
  })
})

describe('org session manifest', () => {
  it('prefixes the first message with the manifest, once, and names the session from the user text', () => {
    const sm = new SessionManager()
    const s = sm.create('hub:org', '/repos/acme-co', { orgManifest: '<codekin-org-session>\nacme-co\n</codekin-org-session>' })
    expect(s.pendingOrgManifest).toContain('acme-co')
    const cp = fakeProcess(true)
    s.claudeProcess = cp
    s.claudeSessionId = 'live-session'

    sm.sendInput(s.id, 'bump node everywhere')

    const sent = cp.sendMessage.mock.calls[0][0] as string
    expect(sent.startsWith('<codekin-org-session>')).toBe(true)
    expect(sent.endsWith('bump node everywhere')).toBe(true)
    expect(s.pendingOrgManifest).toBeUndefined()
    expect(s._namingUserInput).toBe('bump node everywhere')

    sm.sendInput(s.id, 'and the lockfiles')
    expect(cp.sendMessage.mock.calls[1][0]).toBe('and the lockfiles')
  })
})

describe('attached places', () => {
  function attachable(): string {
    // Attached folders must sit under the home directory or the repos root.
    return realpathSync(mkdtempSync(join(homedir(), '.codekin-attach-test-')))
  }

  it('attaches and detaches, persists notes and prefixes the next message with them, once', () => {
    const sm = new SessionManager()
    const s = sm.create('test', '/repo', { provider: 'grok' })
    const extra = attachable()
    try {
      const res = sm.attachDir(s.id, extra)
      expect(res).toEqual({ ok: true, attached: [extra] })
      expect(s.addDirs).toEqual([extra])
      expect(sm.attachDir(s.id, extra)).toMatchObject({ ok: false, status: 400 })
      expect(sm.list().find(i => i.id === s.id)?.attached?.[0].path).toBe(extra)

      const cp = fakeProcess(true)
      s.claudeProcess = cp
      s.claudeSessionId = 'live'
      sm.sendInput(s.id, 'go on')
      const sent = cp.sendMessage.mock.calls[0][0] as string
      expect(sent.startsWith('<codekin-place-attached>')).toBe(true)
      expect(sent).toContain(extra)
      expect(sent.endsWith('go on')).toBe(true)
      expect(s.pendingPlaceNotes).toBeUndefined()

      expect(sm.detachDir(s.id, '/not/attached')).toMatchObject({ ok: false, status: 404 })
      expect(sm.detachDir(s.id, extra)).toEqual({ ok: true, attached: [] })
      expect(s.addDirs).toBeUndefined()
      sm.sendInput(s.id, 'next')
      expect(cp.sendMessage.mock.calls[1][0]).toMatch(/^<codekin-place-detached>[\s\S]*next$/)
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
  })

  it('restarts Claude between turns, and leaves Grok running', () => {
    const sm = new SessionManager()
    const extra = attachable()
    try {
      const claude = sm.create('c', '/repo')
      claude.claudeProcess = fakeProcess(true)
      const spy = vi.spyOn(claude.coordinator, 'requestReconfigure').mockResolvedValue(true)
      sm.attachDir(claude.id, extra)
      expect(spy).toHaveBeenCalledOnce()

      const busy = sm.create('b', '/repo2', { provider: 'codex' })
      busy.claudeProcess = fakeProcess(true)
      busy.isProcessing = true
      const busySpy = vi.spyOn(busy.coordinator, 'requestReconfigure').mockResolvedValue(true)
      sm.attachDir(busy.id, extra)
      expect(busySpy).not.toHaveBeenCalled()
      expect(busy._configRestartPending).toBe(true)

      const grok = sm.create('g', '/repo3', { provider: 'grok' })
      grok.claudeProcess = fakeProcess(true)
      const grokSpy = vi.spyOn(grok.coordinator, 'requestReconfigure').mockResolvedValue(true)
      sm.attachDir(grok.id, extra)
      expect(grokSpy).not.toHaveBeenCalled()
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
  })
})

describe('move a scratch folder', () => {
  async function setup() {
    const { configureScratchRoot } = await import('./places.js')
    const { mkdirSync, writeFileSync } = await import('fs')
    const base = realpathSync(mkdtempSync(join(homedir(), '.codekin-move-test-')))
    const scratch = join(base, 'scratch')
    mkdirSync(join(scratch, 'brisk-otter'), { recursive: true })
    mkdirSync(join(base, 'projects'))
    writeFileSync(join(scratch, 'brisk-otter', 'a.txt'), 'x')
    configureScratchRoot(scratch)
    const cleanup = () => { configureScratchRoot(''); rmSync(base, { recursive: true, force: true }) }
    return { base, scratch, cleanup }
  }

  it('moves the folder, repoints a Claude session and tells the agent; waits for a running turn', async () => {
    const { base, scratch, cleanup } = await setup()
    const { existsSync } = await import('fs')
    try {
      const sm = new SessionManager()
      const s = sm.create('c', join(scratch, 'brisk-otter'))
      s.claudeSessionId = 'claude-conv'
      s.isProcessing = true
      expect(await sm.moveSessionFolder(s.id, join(base, 'projects'))).toMatchObject({ ok: false, error: /turn/ })
      s.isProcessing = false

      const res = await sm.moveSessionFolder(s.id, join(base, 'projects'))
      expect(res).toEqual({ ok: true, path: join(base, 'projects', 'brisk-otter') })
      expect(s.workingDir).toBe(join(base, 'projects', 'brisk-otter'))
      expect(existsSync(join(base, 'projects', 'brisk-otter', 'a.txt'))).toBe(true)
      expect(s.pendingPlaceNotes?.[0]).toContain('<codekin-place-moved>')
      // Claude resumes the same conversation.
      expect(s.claudeSessionId).toBe('claude-conv')
      expect(mocks.generateHandoff).not.toHaveBeenCalled()
      expect(sm.list().find(i => i.id === s.id)?.place?.kind).toBe('folder')
    } finally {
      cleanup()
    }
  })

  it('carries a Grok conversation over with a handoff, upgraded to the distilled one before the next message', async () => {
    const { base, scratch, cleanup } = await setup()
    try {
      const raw: Handoff = { ...FAKE_HANDOFF, sourceHarness: 'grok', distilled: false, content: 'raw extract' }
      const distilled: Handoff = { ...FAKE_HANDOFF, sourceHarness: 'grok', distilled: true, content: 'distilled doc' }
      mocks.generateHandoff.mockReset()
      mocks.generateHandoff.mockResolvedValueOnce(raw).mockResolvedValueOnce(distilled)
      const sm = new SessionManager()
      const s = sm.create('g', join(scratch, 'brisk-otter'), { provider: 'grok' })
      s.claudeSessionId = '11111111-2222-3333-4444-555555555555'

      const res = await sm.moveSessionFolder(s.id, join(base, 'projects'))
      expect(res.ok).toBe(true)
      // The transcript is read from the old folder's session, before the move.
      expect(mocks.generateHandoff.mock.calls[0][0]).toMatchObject({ provider: 'grok', workingDir: join(scratch, 'brisk-otter'), harnessSessionId: '11111111-2222-3333-4444-555555555555' })
      expect(s.claudeSessionId).toBeNull()
      await vi.waitFor(() => { expect(s.pendingHandoff).toBe(distilled) })

      const cp = fakeProcess(true)
      s.claudeProcess = cp
      sm.sendInput(s.id, 'carry on')
      const sent = cp.sendMessage.mock.calls[0][0] as string
      expect(sent).toContain('<codekin-place-moved>')
      expect(sent).toContain('[HANDOFF from grok]')
      expect(sent).toContain('distilled doc')
    } finally {
      cleanup()
    }
  })

  it('moves an OpenCode session to a fresh conversation, summarized from history', async () => {
    const { base, scratch, cleanup } = await setup()
    try {
      mocks.generateHandoff.mockReset()
      mocks.generateHandoff.mockResolvedValue(null)
      const sm = new SessionManager()
      const s = sm.create('o', join(scratch, 'brisk-otter'), { provider: 'opencode' })
      s.claudeSessionId = 'ses_abc'
      const res = await sm.moveSessionFolder(s.id, join(base, 'projects'))
      expect(res.ok).toBe(true)
      expect(s.claudeSessionId).toBeNull()
      expect(s.pendingHandoff).toBeUndefined()
      expect(s.outputHistory.some(m => m.type === 'system_message' && m.text.includes('OpenCode starts a new conversation'))).toBe(true)
    } finally {
      cleanup()
    }
  })
})
