/**
 * Hook for the docs browser feature.
 *
 * Manages state for the file picker, selected file, content loading,
 * raw/rendered toggle, starred docs, and open/close lifecycle.
 */

import { useState, useCallback } from 'react'

const BASE = '/cc'
const STARRED_KEY = 'codekin-starred-docs'

interface DocFile {
  path: string
  pinned: boolean
}

/** Load starred doc paths from localStorage. Keyed by repo dir. */
function loadStarred(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(STARRED_KEY) || '{}')
  } catch {
    return {}
  }
}

function persistStarred(starred: Record<string, string[]>) {
  localStorage.setItem(STARRED_KEY, JSON.stringify(starred))
}

interface UseDocsBrowserReturn {
  /** Whether the docs browser is showing a document. */
  isOpen: boolean
  /** Currently selected file path (relative to repo root). */
  selectedFile: string | null
  /** Raw markdown content of the selected file. */
  content: string | null
  /** Whether content is currently loading. */
  loading: boolean
  /** Error message if content failed to load. */
  error: string | null
  /** Whether raw source mode is active. */
  rawMode: boolean
  /** Toggle between raw and rendered view. */
  toggleRawMode: () => void
  /** Open a doc file by path — fetches content from the server. */
  openFile: (repoWorkingDir: string, filePath: string, token: string) => void
  /** Close the doc viewer and reset state. */
  close: () => void
  /** The repo working dir that's currently being viewed. */
  repoWorkingDir: string | null

  /** File picker state. */
  pickerOpen: boolean
  pickerFiles: DocFile[]
  pickerLoading: boolean
  /** Open the file picker for a repo — fetches the file list. */
  openPicker: (repoWorkingDir: string, token: string) => void
  /** Close the file picker. */
  closePicker: () => void
  /** The repo working dir for the open picker. */
  pickerRepoDir: string | null

  /** Starred docs — persisted per-repo in localStorage. */
  starredDocs: string[]
  /** Whether the currently viewed file is starred. */
  isCurrentFileStarred: boolean
  /** Toggle star on the currently viewed file. */
  toggleStarCurrentFile: () => void
}

export function useDocsBrowser(): UseDocsBrowserReturn {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rawMode, setRawMode] = useState(false)
  const [repoWorkingDir, setRepoWorkingDir] = useState<string | null>(null)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerFiles, setPickerFiles] = useState<DocFile[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerRepoDir, setPickerRepoDir] = useState<string | null>(null)

  const [starred, setStarred] = useState<Record<string, string[]>>(loadStarred)

  const openPicker = useCallback(async (repoDir: string, token: string) => {
    setPickerRepoDir(repoDir)
    setPickerOpen(true)
    setPickerLoading(true)
    setPickerFiles([])

    try {
      const params = new URLSearchParams({ repo: repoDir })
      const res = await fetch(`${BASE}/api/docs?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`Failed to list docs: ${res.status}`)
      const data = await res.json()
      setPickerFiles(data.files ?? [])
    } catch {
      setPickerFiles([])
    } finally {
      setPickerLoading(false)
    }
  }, [])

  const closePicker = useCallback(() => {
    setPickerOpen(false)
  }, [])

  const openFile = useCallback(async (repoDir: string, filePath: string, token: string) => {
    setRepoWorkingDir(repoDir)
    setSelectedFile(filePath)
    setContent(null)
    setError(null)
    setLoading(true)
    setRawMode(false)
    setPickerOpen(false)

    try {
      const params = new URLSearchParams({ repo: repoDir, file: filePath })
      const res = await fetch(`${BASE}/api/docs/file?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`Failed to load file: ${res.status}`)
      const data = await res.json()
      setContent(data.content)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file')
    } finally {
      setLoading(false)
    }
  }, [])

  const close = useCallback(() => {
    setSelectedFile(null)
    setContent(null)
    setError(null)
    setLoading(false)
    setRawMode(false)
    setRepoWorkingDir(null)
  }, [])

  const toggleRawMode = useCallback(() => {
    setRawMode(prev => !prev)
  }, [])

  const currentRepoStarred = repoWorkingDir ? (starred[repoWorkingDir] ?? []) : []
  const isCurrentFileStarred = selectedFile !== null && currentRepoStarred.includes(selectedFile)

  const toggleStarCurrentFile = useCallback(() => {
    if (!repoWorkingDir || !selectedFile) return
    setStarred(prev => {
      const repoStarred = prev[repoWorkingDir] ?? []
      const next = repoStarred.includes(selectedFile)
        ? repoStarred.filter(f => f !== selectedFile)
        : [...repoStarred, selectedFile]
      const updated = { ...prev, [repoWorkingDir]: next }
      persistStarred(updated)
      return updated
    })
  }, [repoWorkingDir, selectedFile])

  /** Starred docs for the picker's currently open repo. */
  const pickerStarred = pickerRepoDir ? (starred[pickerRepoDir] ?? []) : []

  return {
    isOpen: selectedFile !== null,
    selectedFile,
    content,
    loading,
    error,
    rawMode,
    toggleRawMode,
    openFile,
    close,
    repoWorkingDir,
    pickerOpen,
    pickerFiles,
    pickerLoading,
    openPicker,
    closePicker,
    pickerRepoDir,
    starredDocs: pickerStarred,
    isCurrentFileStarred,
    toggleStarCurrentFile,
  }
}
