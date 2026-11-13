/**
 * Pure model of the place picker: which rows each view shows, and what each
 * key does. The component (PlacePicker.tsx) renders rows and performs the
 * actions; everything decidable without the DOM or the network lives here so
 * it can be tested as tables.
 *
 * Views:
 *   root   — Recent · Start fresh · GitHub (owners)
 *   owner  — one owner's repositories
 *   browse — one folder's subfolders, with "Use <folder>" first
 *   search — any query typed in root (names, and `~/…` or `/…` paths)
 * In owner and browse views a query filters that view instead.
 */

import type { ApiRepo, RepoGroup } from '../hooks/useRepos'
import {
  NEW_SCRATCH, placeFromOwner, placeFromPath, placeFromRepo, placeKey, tildify, untildify,
  type DraftPlace,
} from './places'

export type PickerView =
  | { name: 'root' }
  | { name: 'owner'; owner: string }
  | { name: 'browse' }

export interface PickerState {
  view: PickerView
  query: string
  /** Index into the actionable rows. */
  highlight: number
}

export const INITIAL_PICKER_STATE: PickerState = { view: { name: 'root' }, query: '', highlight: 0 }

export type RowIcon =
  | 'scratch' | 'folder' | 'folder-plus' | 'folder-check' | 'repo' | 'remote' | 'org' | 'back' | 'local'

/** What activating a row does. */
export type RowAction =
  | { type: 'pick'; place: DraftPlace }
  | { type: 'open-owner'; owner: string }
  | { type: 'browse'; path?: string }
  /** Open the native folder dialog when the machine offers one, else browse. */
  | { type: 'choose-folder' }
  /** Back to the root view. */
  | { type: 'back' }
  /** Browse view: list the parent folder, or return to root from a top folder. */
  | { type: 'up' }

export interface PickerRow {
  id: string
  icon: RowIcon
  label: string
  /** Secondary text after the label. */
  meta?: string
  /** Right-aligned tag (`folder`, `repo`, `clones on send`, …). */
  tag?: string
  /** Label drawn in accent ink (the "Use this folder" row). */
  accent?: boolean
  /** Monospace label (paths). */
  mono?: boolean
  /** Shows a chevron: → opens it. */
  opens?: boolean
  action: RowAction
}

export interface PickerSection {
  title?: string
  rows: PickerRow[]
}

/** Non-actionable line shown in place of, or under, rows. */
export interface PickerNotice {
  id: string
  text: string
  tone: 'muted' | 'error'
}

export interface PickerModel {
  sections: PickerSection[]
  notices: PickerNotice[]
  /** Search input placeholder for the view. */
  placeholder: string
  /** Footer key hints. */
  footer: string
}

/** Everything the rows are built from. */
export interface PickerData {
  groups: RepoGroup[]
  recent: DraftPlace[]
  showOrgPlaces: boolean
  /** Current folder listing for browse view and path search. */
  listing: { path: string; dirs: string[]; gitDirs: ReadonlySet<string>; git: boolean } | null
  /** Allowed roots, once known. */
  roots: string[]
  home: string | null
  /** A path the server refused (403) while completing a typed path. */
  refusedPath?: string | null
}

// ---------------------------------------------------------------------------
// Path queries
// ---------------------------------------------------------------------------

/** True when the query is a path (`~`, `~/…`, `/…`). */
export function isPathQuery(query: string): boolean {
  return query === '~' || query.startsWith('~/') || query.startsWith('/')
}

/**
 * For a typed path, the folder to list and the partial name to complete.
 * `~/Doc` → list `~`, complete `Doc`; `~/Documents/` → list it, complete ''.
 */
export function splitPathQuery(query: string, home: string | null): { dir: string; partial: string } {
  const abs = untildify(query, home)
  if (abs.endsWith('/')) return { dir: abs.length > 1 ? abs.replace(/\/+$/, '') || '/' : '/', partial: '' }
  if (abs === home) return { dir: abs, partial: '' }
  const slash = abs.lastIndexOf('/')
  return { dir: slash <= 0 ? '/' : abs.slice(0, slash), partial: abs.slice(slash + 1) }
}

function withinRoots(path: string, roots: string[]): boolean {
  return roots.some(r => path === r || path.startsWith(r.replace(/\/+$/, '') + '/'))
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function placeRow(place: DraftPlace, prefix: string, home: string | null): PickerRow {
  const icon: RowIcon = place.kind === 'scratch' ? 'scratch'
    : place.kind === 'org' ? 'org'
    : place.kind === 'repo' ? (place.path ? 'repo' : 'remote')
    : place.git ? 'repo' : 'folder'
  const tag = place.kind === 'scratch' ? 'scratch'
    : place.kind === 'org' ? 'org'
    : place.kind === 'repo' ? 'repo'
    : place.git ? 'git folder' : 'folder'
  const label = place.kind === 'folder' && place.path ? tildify(place.path, home) : place.label
  return {
    id: `${prefix}:${placeKey(place)}`,
    icon,
    label,
    mono: place.kind === 'folder',
    tag,
    meta: place.kind === 'scratch' ? 'new empty folder' : place.kind === 'org' ? 'whole organization' : undefined,
    action: { type: 'pick', place },
  }
}

function repoRow(repo: ApiRepo, prefix: string): PickerRow {
  const place = placeFromRepo(repo)
  return {
    id: `${prefix}:${placeKey(place)}`,
    icon: repo.cloned ? 'repo' : 'remote',
    label: prefix === 'search' && repo.owner ? `${repo.owner}/${repo.name}` : repo.name,
    tag: repo.cloned ? undefined : 'clones on send',
    action: { type: 'pick', place },
  }
}

function ownerRows(data: PickerData): PickerRow[] {
  return data.groups.filter(g => g.repos.length > 0 || g.error).map(g => {
    const local = g.source === 'local'
    return {
      id: `owner:${g.owner}`,
      icon: local ? 'local' as const : 'org' as const,
      label: local ? 'Local checkouts' : g.owner,
      meta: g.error ? 'could not list' : `${g.repos.length} repo${g.repos.length === 1 ? '' : 's'}`,
      opens: true,
      action: { type: 'open-owner', owner: g.owner },
    }
  })
}

/** Case-insensitive substring match; tolerates fields an older server leaves out. */
function matches(text: string | undefined, q: string): boolean {
  return !!text && text.toLowerCase().includes(q.toLowerCase())
}

function rootModel(data: PickerData): PickerModel {
  const recent = data.recent
    .filter(p => data.showOrgPlaces || p.kind !== 'org')
    .map(p => placeRow(p, 'recent', data.home))
  const sections: PickerSection[] = []
  if (recent.length) sections.push({ title: 'Recent', rows: recent })
  sections.push({
    title: 'Start fresh',
    rows: [
      { ...placeRow(NEW_SCRATCH, 'fresh', data.home), tag: undefined },
      { id: 'fresh:choose', icon: 'folder-plus', label: 'Choose a folder on this machine…', action: { type: 'choose-folder' } },
    ],
  })
  const owners = ownerRows(data)
  // Local checkouts alone are not GitHub.
  const anyGithub = data.groups.some(g => g.source !== 'local' && (g.repos.length > 0 || g.error))
  if (owners.length) sections.push({ title: anyGithub ? 'GitHub' : 'Repositories', rows: owners })
  return {
    sections,
    notices: [],
    placeholder: 'Folder, repo, or a path like ~/Documents',
    footer: '↑↓ move · ⏎ use place · → open · esc close',
  }
}

function ownerModel(data: PickerData, owner: string, query: string): PickerModel {
  const group = data.groups.find(g => g.owner === owner)
  const back: PickerRow = { id: 'back', icon: 'back', label: group?.source === 'local' ? 'Local checkouts' : owner, action: { type: 'back' } }
  const rows: PickerRow[] = []
  if (data.showOrgPlaces && group?.source !== 'local' && !query) {
    rows.push({ ...placeRow(placeFromOwner(owner), 'owner', data.home), label: 'Whole organization', meta: `${group?.repos.length ?? 0} repos` })
  }
  for (const repo of group?.repos ?? []) {
    if (query && !matches(repo.name, query) && !matches(repo.description, query)) continue
    rows.push(repoRow(repo, 'owner'))
  }
  const notices: PickerNotice[] = []
  if (group?.error) notices.push({ id: 'owner-error', text: group.error, tone: 'error' })
  else if (!rows.length) notices.push({ id: 'owner-empty', text: query ? 'No repositories match.' : 'No repositories.', tone: 'muted' })
  return {
    sections: [{ rows: [back] }, { title: 'Repositories', rows }],
    notices,
    placeholder: `Search ${owner} repos`,
    footer: '⏎ use this repo · ← back to all places',
  }
}

function browseModel(data: PickerData, query: string): PickerModel {
  const back: PickerRow = { id: 'back', icon: 'back', label: 'Choose a folder', action: { type: 'back' } }
  const listing = data.listing
  if (!listing) {
    return { sections: [{ rows: [back] }], notices: [{ id: 'loading', text: 'Loading…', tone: 'muted' }], placeholder: 'Filter folders', footer: '⏎ use or open · → open folder · ← up a level' }
  }
  const use: PickerRow = {
    id: `use:${listing.path}`,
    icon: 'folder-check',
    label: `Use ${tildify(listing.path, data.home)}`,
    mono: true,
    accent: true,
    tag: listing.git ? 'git repo' : undefined,
    action: { type: 'pick', place: placeFromPath(listing.path, listing.git, data.home) },
  }
  const dirs = listing.dirs.filter(d => !query || matches(d, query)).map(d => ({
    id: `dir:${listing.path}/${d}`,
    icon: listing.gitDirs.has(d) ? 'repo' as const : 'folder' as const,
    label: d,
    tag: listing.gitDirs.has(d) ? 'git' : undefined,
    opens: true,
    action: { type: 'browse' as const, path: listing.path === '/' ? `/${d}` : `${listing.path}/${d}` },
  }))
  const notices: PickerNotice[] = []
  if (!dirs.length) {
    notices.push({ id: 'empty', text: query ? 'No folders match.' : 'No subfolders. Use this folder, or go back.', tone: 'muted' })
  }
  return {
    sections: [{ rows: [back, use] }, ...(dirs.length ? [{ title: 'Folders', rows: dirs }] : [])],
    notices,
    placeholder: 'Filter folders',
    footer: '⏎ use or open · → open folder · ← up a level',
  }
}

function searchModel(data: PickerData, query: string): PickerModel {
  const rows: PickerRow[] = []
  const notices: PickerNotice[] = []
  const footer = '↑↓ move · ⏎ use place · esc close'
  const placeholder = 'Folder, repo, or a path like ~/Documents'

  if (isPathQuery(query)) {
    const abs = untildify(query, data.home).replace(/\/+$/, '') || '/'
    const outside = (data.roots.length > 0 && query.startsWith('/') && !withinRoots(abs, data.roots))
      || (!!data.refusedPath)
    if (outside) {
      notices.push({
        id: 'outside',
        text: `Only folders under your home or the repos root can be used. ${tildify(abs, data.home)} is outside both.`,
        tone: 'error',
      })
      return { sections: [], notices, placeholder, footer }
    }
    const { dir, partial } = splitPathQuery(query, data.home)
    const listing = data.listing
    if (listing && listing.path === dir) {
      // An exact existing folder: the typed path itself, or a child named exactly.
      if (!partial) {
        rows.push({
          id: `use:${dir}`, icon: 'folder-check', label: `Use ${tildify(dir, data.home)}`, mono: true, accent: true,
          tag: listing.git ? 'git repo' : undefined,
          action: { type: 'pick', place: placeFromPath(dir, listing.git, data.home) },
        })
      }
      for (const d of listing.dirs) {
        if (partial && !d.toLowerCase().startsWith(partial.toLowerCase())) continue
        const path = dir === '/' ? `/${d}` : `${dir}/${d}`
        const git = listing.gitDirs.has(d)
        if (partial && d === partial) {
          rows.unshift({
            id: `use:${path}`, icon: 'folder-check', label: `Use ${tildify(path, data.home)}`, mono: true, accent: true,
            tag: git ? 'git repo' : undefined,
            action: { type: 'pick', place: placeFromPath(path, git, data.home) },
          })
        }
        rows.push({
          id: `dir:${path}`, icon: git ? 'repo' : 'folder', label: tildify(path, data.home), mono: true,
          tag: git ? 'git' : undefined, opens: true, action: { type: 'browse', path },
        })
      }
    }
    if (!rows.length && listing && listing.path === dir) {
      notices.push({ id: 'none', text: 'No folders match.', tone: 'muted' })
    }
    return { sections: rows.length ? [{ title: 'Folders', rows }] : [], notices, placeholder, footer: '↑↓ move · ⏎ use or open · → open folder · esc close' }
  }

  for (const place of data.recent) {
    if (!data.showOrgPlaces && place.kind === 'org') continue
    if (matches(place.label, query) || (place.path && matches(place.path, query))) rows.push(placeRow(place, 'search-recent', data.home))
  }
  const seen = new Set(rows.map(r => r.action.type === 'pick' ? placeKey(r.action.place) : r.id))
  for (const g of data.groups) {
    for (const repo of g.repos) {
      if (!matches(repo.name, query) && !matches(`${repo.owner}/${repo.name}`, query)) continue
      const row = repoRow(repo, 'search')
      const key = row.action.type === 'pick' ? placeKey(row.action.place) : row.id
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
    }
    if (data.showOrgPlaces && g.source !== 'local' && matches(g.owner, query)) {
      rows.push(placeRow(placeFromOwner(g.owner), 'search', data.home))
    }
  }
  if (!rows.length) notices.push({ id: 'none', text: 'No places match. Type a path starting with ~ to use any folder.', tone: 'muted' })
  return { sections: rows.length ? [{ title: 'Results', rows }] : [], notices, placeholder, footer }
}

/** The rows and texts for the current state. */
export function pickerModel(state: PickerState, data: PickerData): PickerModel {
  const q = state.query.trim()
  switch (state.view.name) {
    case 'owner': return ownerModel(data, state.view.owner, q)
    case 'browse': return browseModel(data, q)
    case 'root': return q ? searchModel(data, q) : rootModel(data)
  }
}

/** Actionable rows in display order. */
export function flatRows(model: PickerModel): PickerRow[] {
  return model.sections.flatMap(s => s.rows)
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type PickerKey = 'ArrowDown' | 'ArrowUp' | 'Enter' | 'ArrowRight' | 'ArrowLeft' | 'Backspace' | 'Escape'

/** The result of a key: the next state, an action to perform, or closing. */
export interface KeyResult {
  state: PickerState
  /** Perform this row action (the component does the side effects). */
  action?: RowAction
  close?: boolean
  /** The key was handled; the component should preventDefault. */
  handled: boolean
}

/**
 * Apply a key. Arrows move the highlight (wrapping); Enter activates; → opens
 * an owner or folder and ← / Backspace go back a level, but only while the
 * query is empty, so they still edit text otherwise.
 */
export function pickerKey(state: PickerState, rows: PickerRow[], key: PickerKey): KeyResult {
  const n = rows.length
  const hi = n ? Math.min(Math.max(state.highlight, 0), n - 1) : 0
  const row = n ? rows[hi] : undefined
  const empty = state.query === ''
  switch (key) {
    case 'ArrowDown':
      return { state: { ...state, highlight: n ? (hi + 1) % n : 0 }, handled: true }
    case 'ArrowUp':
      return { state: { ...state, highlight: n ? (hi - 1 + n) % n : 0 }, handled: true }
    case 'Enter':
      return row ? { state, action: row.action, handled: true } : { state, handled: true }
    case 'ArrowRight':
      if (empty && row?.opens) return { state, action: row.action, handled: true }
      return { state, handled: false }
    case 'ArrowLeft':
    case 'Backspace':
      if (empty && state.view.name === 'browse') return { state, action: { type: 'up' }, handled: true }
      if (empty && state.view.name !== 'root') return { state, action: { type: 'back' }, handled: true }
      return { state, handled: false }
    case 'Escape':
      return { state, close: true, handled: true }
  }
}

/** State after opening a view: query cleared, highlight on the first useful row. */
export function enterView(view: PickerView): PickerState {
  // In owner and browse views row 0 is "back"; start on the first real row.
  return { view, query: '', highlight: view.name === 'root' ? 0 : 1 }
}
