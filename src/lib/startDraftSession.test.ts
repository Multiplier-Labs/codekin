import { describe, it, expect, vi } from 'vitest'
import { draftModeFor, startDraftSession, type DraftDeps, type DraftSession } from './startDraftSession'
import { NEW_SCRATCH, placeFromPath, placeFromOwner, type DraftPlace } from './places'

const HOME = '/home/sam'

function deps(over: Partial<DraftDeps> = {}): DraftDeps & { createSession: ReturnType<typeof vi.fn> } {
  return {
    createScratch: vi.fn(async () => `${HOME}/codekin/scratch/brisk-otter`),
    cloneRepo: vi.fn(async () => `${HOME}/repos/acme-co/web-app`),
    orgFolder: vi.fn(async (owner: string) => `${HOME}/repos/${owner}`),
    uploadAndBuildMessage: vi.fn(async (files: File[], text: string) => `${text}\n[${files.length} file]`),
    createSession: vi.fn(),
    onProgress: vi.fn(),
    ...over,
  } as DraftDeps & { createSession: ReturnType<typeof vi.fn> }
}

function draft(place: DraftPlace, over: Partial<DraftSession> = {}): DraftSession {
  return {
    place, text: 'Write a parser', files: [], provider: 'claude', model: 'claude-opus-5', effort: 'high',
    permissionMode: 'acceptEdits', useWorktree: true, ...over,
  }
}

const remote: DraftPlace = {
  kind: 'repo', git: true, label: 'acme-co/web-app',
  repo: { id: 'web-app', owner: 'acme-co', name: 'web-app', cloned: false, dir: `${HOME}/repos/acme-co/web-app` },
}

describe('startDraftSession', () => {
  it('creates a scratch folder, then the session there without a worktree', async () => {
    const d = deps()
    const started = await startDraftSession(draft(NEW_SCRATCH), d)
    expect(d.createScratch).toHaveBeenCalled()
    expect(d.createSession).toHaveBeenCalledWith(
      'hub:brisk-otter', `${HOME}/codekin/scratch/brisk-otter`, false, 'acceptEdits', 'claude',
      { model: 'claude-opus-5', effort: 'high' },
      { firstMessage: 'Write a parser', place: expect.objectContaining({ kind: 'scratch', path: `${HOME}/codekin/scratch/brisk-otter` }) as unknown },
    )
    expect(started.workingDir).toBe(`${HOME}/codekin/scratch/brisk-otter`)
  })

  it('runs a non-git folder in place, never in a worktree', async () => {
    const d = deps()
    await startDraftSession(draft(placeFromPath(`${HOME}/notes`, false, HOME)), d)
    expect(d.createScratch).not.toHaveBeenCalled()
    expect(d.createSession.mock.calls[0].slice(1, 3)).toEqual([`${HOME}/notes`, false])
  })

  it('honours the worktree choice for a git folder', async () => {
    const d = deps()
    await startDraftSession(draft(placeFromPath(`${HOME}/site`, true, HOME)), d)
    expect(d.createSession.mock.calls[0][2]).toBe(true)
    const off = deps()
    await startDraftSession(draft(placeFromPath(`${HOME}/site`, true, HOME), { useWorktree: false }), off)
    expect(off.createSession.mock.calls[0][2]).toBe(false)
  })

  it('runs a folder inside a repository in place, even with worktrees on', async () => {
    const d = deps()
    await startDraftSession(draft(placeFromPath(`${HOME}/site/src`, true, HOME, `${HOME}/site`)), d)
    expect(d.createSession.mock.calls[0].slice(1, 3)).toEqual([`${HOME}/site/src`, false])
  })

  it('clones a remote repo on send and reports progress', async () => {
    const d = deps()
    const started = await startDraftSession(draft(remote), d)
    expect(d.cloneRepo).toHaveBeenCalledWith('acme-co', 'web-app')
    expect(d.onProgress).toHaveBeenCalledWith('Cloning acme-co/web-app…')
    expect(started.place).toMatchObject({ path: `${HOME}/repos/acme-co/web-app`, repo: { cloned: true } })
  })

  it('falls back to the listed checkout when the clone response names no path', async () => {
    const d = deps({ cloneRepo: vi.fn(async () => null) })
    const started = await startDraftSession(draft(remote), d)
    expect(started.workingDir).toBe(`${HOME}/repos/acme-co/web-app`)
  })

  it('uploads attachments first and sends the built message', async () => {
    const d = deps()
    const file = new File(['x'], 'a.png')
    const started = await startDraftSession(draft(NEW_SCRATCH, { files: [file] }), d)
    expect(d.uploadAndBuildMessage).toHaveBeenCalledWith([file], 'Write a parser')
    expect(started.firstMessage).toBe('Write a parser\n[1 file]')
  })

  it('omits the model when none is chosen, and the effort without a model', async () => {
    const d = deps()
    await startDraftSession(draft(NEW_SCRATCH, { model: null, effort: 'high' }), d)
    expect(d.createSession.mock.calls[0][5]).toEqual({})
  })

  it('throws and creates nothing when a step fails', async () => {
    const d = deps({ cloneRepo: vi.fn(async () => { throw new Error('Repository not found') }) })
    await expect(startDraftSession(draft(remote), d)).rejects.toThrow('Repository not found')
    expect(d.createSession).not.toHaveBeenCalled()
    expect(d.onProgress).toHaveBeenLastCalledWith(null)
  })

  it('refuses an empty message', async () => {
    await expect(startDraftSession(draft(NEW_SCRATCH, { text: '  ' }), deps())).rejects.toThrow('first message')
  })

  it('starts an org session in its owner folder, passing the worktree choice on', async () => {
    const d = deps()
    const started = await startDraftSession(draft(placeFromOwner('acme-co')), d)
    expect(d.orgFolder).toHaveBeenCalledWith('acme-co')
    expect(d.onProgress).toHaveBeenCalledWith('Preparing the folder for acme-co…')
    expect(d.createSession.mock.calls[0].slice(0, 3)).toEqual(['hub:acme-co', `${HOME}/repos/acme-co`, true])
    expect(started.place).toMatchObject({ kind: 'org', owner: 'acme-co', path: `${HOME}/repos/acme-co` })
    const off = deps()
    await startDraftSession(draft(placeFromOwner('acme-co'), { useWorktree: false }), off)
    expect(off.createSession.mock.calls[0][2]).toBe(false)
  })

  it('creates nothing when the org folder cannot be prepared', async () => {
    const d = deps({ orgFolder: vi.fn(async () => { throw new Error('Invalid owner name') }) })
    await expect(startDraftSession(draft(placeFromOwner('bad')), d)).rejects.toThrow('Invalid owner name')
    expect(d.createSession).not.toHaveBeenCalled()
  })
})

describe('draftModeFor', () => {
  it('falls back from Skip to Bypass for agents without it, and keeps other modes', () => {
    expect(draftModeFor('codex', 'dangerouslySkipPermissions')).toBe('bypassPermissions')
    expect(draftModeFor('grok', 'dangerouslySkipPermissions')).toBe('bypassPermissions')
    expect(draftModeFor('claude', 'dangerouslySkipPermissions')).toBe('dangerouslySkipPermissions')
    expect(draftModeFor('codex', 'acceptEdits')).toBe('acceptEdits')
  })
})
