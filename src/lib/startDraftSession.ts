/**
 * The new-session composer's Send sequence.
 *
 *   1. Upload attachments (independent of any session).
 *   2. Resolve the place to a folder: create a scratch folder, or clone a
 *      GitHub repo that isn't on the machine yet.
 *   3. Ask the server to create the session there.
 *
 * The prompt itself goes out once the server confirms the session (see the
 * caller's onSessionCreated); this function hands it back as `firstMessage`.
 * Any failure throws, and the caller keeps the draft — text included — and
 * shows the error under the composer. Dependencies are injected so the
 * sequence can be tested without a socket or a server.
 */

import type { CodingProvider, PermissionMode } from '../types'
import { permissionModesFor } from '../types'
import { baseName, type DraftPlace } from './places'

export interface DraftSession {
  place: DraftPlace
  text: string
  files: File[]
  provider: CodingProvider
  model?: string | null
  effort?: string | null
  permissionMode: PermissionMode
  /**
   * The user's worktree choice; applied to a repository root, and for an org
   * it means one worktree per repository (made by the agent, per the org manifest).
   */
  useWorktree: boolean
}

export interface DraftDeps {
  createScratch: () => Promise<string>
  cloneRepo: (owner: string, name: string) => Promise<string | null>
  /** The org's owner folder on the machine, created on first use. */
  orgFolder: (owner: string) => Promise<string>
  uploadAndBuildMessage: (files: File[], text: string) => Promise<string>
  createSession: (
    name: string, workingDir: string, useWorktree: boolean, permissionMode: PermissionMode,
    provider: CodingProvider, explicit: { model?: string; effort?: string },
    /** Send this once the session exists; known before the create goes out. */
    start: { firstMessage: string; place: DraftPlace },
  ) => void
  /** Progress line for the hint, or null when a step finishes. */
  onProgress?: (text: string | null) => void
}

export interface StartedDraft {
  workingDir: string
  /** The resolved place (with its path), for the recent list. */
  place: DraftPlace
  /** Text to send once the session exists. */
  firstMessage: string
}

/**
 * The permission mode a draft keeps when its agent changes. Skip permissions
 * is Claude-only, so another agent falls back to Bypass (the nearest mode it
 * has); any mode the new agent offers is kept as is.
 */
export function draftModeFor(provider: CodingProvider, mode: PermissionMode): PermissionMode {
  return permissionModesFor(provider).some(m => m.id === mode) ? mode : 'bypassPermissions'
}

/** Resolve a draft's place to a folder on the machine. */
export async function resolvePlacePath(place: DraftPlace, deps: Pick<DraftDeps, 'createScratch' | 'cloneRepo' | 'orgFolder' | 'onProgress'>): Promise<DraftPlace & { path: string }> {
  if (place.kind === 'scratch' && !place.path) {
    deps.onProgress?.('Creating a scratch folder…')
    const path = await deps.createScratch()
    return { ...place, path }
  }
  if (place.kind === 'repo' && !place.path) {
    if (!place.repo) throw new Error('This repository has no location yet.')
    deps.onProgress?.(`Cloning ${place.repo.owner}/${place.repo.name}…`)
    // The server may point at an existing checkout; otherwise it is where the repo list said.
    const path = await deps.cloneRepo(place.repo.owner, place.repo.name) ?? place.repo.dir
    if (!path) throw new Error(`Cloned ${place.repo.owner}/${place.repo.name}, but the server did not say where.`)
    return { ...place, path, repo: { ...place.repo, cloned: true } }
  }
  if (place.kind === 'org') {
    const owner = place.owner ?? place.label
    deps.onProgress?.(`Preparing the folder for ${owner}…`)
    const path = await deps.orgFolder(owner)
    return { ...place, owner, path }
  }
  if (!place.path) throw new Error('Choose where this session should run.')
  return { ...place, path: place.path }
}

/** Run the Send sequence. Throws on any failure; nothing is created in that case. */
export async function startDraftSession(draft: DraftSession, deps: DraftDeps): Promise<StartedDraft> {
  const text = draft.text.trim()
  if (!text) throw new Error('Write a first message to start the session.')
  try {
    const firstMessage = draft.files.length
      ? (deps.onProgress?.('Uploading files…'), await deps.uploadAndBuildMessage(draft.files, text))
      : text
    const place = await resolvePlacePath(draft.place, deps)
    deps.onProgress?.('Starting the session…')
    deps.createSession(
      `hub:${baseName(place.path)}`,
      place.path,
      (place.kind === 'org' || (place.git && !place.inRepo)) && draft.useWorktree,
      draft.permissionMode,
      draft.provider,
      {
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.model && draft.effort ? { effort: draft.effort } : {}),
      },
      { firstMessage, place },
    )
    return { workingDir: place.path, place, firstMessage }
  } catch (err) {
    deps.onProgress?.(null)
    throw err
  }
}
