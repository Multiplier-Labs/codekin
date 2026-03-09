/**
 * Hook for the docs browser feature.
 *
 * Manages state for the file picker, selected file, content loading,
 * raw/rendered toggle, and open/close lifecycle.
 */

import { useState, useCallback } from 'react'

const BASE = '/cc'

interface DocFile {
  path: string
  pinned: boolean
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

  const openPicker = useCallback(async (repoDir: string, token: string) => {
    setPickerRepoDir(repoDir)
    setPickerOpen(true)
    setPickerLoading(true)
    setPickerFiles([])

    try {
      const res = await fetch(
        `${BASE}/api/repos/${encodeURIComponent(repoDir)}/docs?token=${encodeURIComponent(token)}`,
      )
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
      const res = await fetch(
        `${BASE}/api/repos/${encodeURIComponent(repoDir)}/docs/${encodeURIComponent(filePath)}?token=${encodeURIComponent(token)}`,
      )
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
  }
}
