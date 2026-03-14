/**
 * Folder picker component for selecting a directory path.
 *
 * Shows a text input with a browse button that opens a dropdown
 * directory browser. Validates paths on save and shows error messages.
 */

import { useState, useEffect, useRef } from 'react'
import { IconFolder, IconFolderOpen, IconChevronRight, IconArrowUp, IconX } from '@tabler/icons-react'
import { browseDirs } from '../lib/ccApi'

interface Props {
  value: string
  token?: string
  placeholder?: string
  helpText?: string
  /** Called after a valid path is saved successfully. */
  onSave: (path: string) => Promise<void>
  /** Font size class for the input. */
  inputClass?: string
}

export function FolderPicker({ value, token, placeholder = '~/repos (default)', helpText, onSave, inputClass }: Props) {
  const [path, setPath] = useState(value)
  const [savedPath, setSavedPath] = useState(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browsePath, setBrowsePath] = useState<string | null>(null)
  const [dirs, setDirs] = useState<string[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setPath(value)
    setSavedPath(value)
  }, [value])

  // Close dropdown on outside click
  useEffect(() => {
    if (!browserOpen) return
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setBrowserOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [browserOpen])

  async function save() {
    if (!token || path === savedPath) return
    setSaving(true)
    setError(null)
    try {
      await onSave(path)
      setSavedPath(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save path')
    } finally {
      setSaving(false)
    }
  }

  async function browse(dirPath?: string) {
    if (!token) return
    setBrowseLoading(true)
    setBrowseError(null)
    try {
      const result = await browseDirs(token, dirPath)
      setBrowsePath(result.path)
      setDirs(result.dirs)
      setBrowserOpen(true)
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : 'Failed to browse directory')
    } finally {
      setBrowseLoading(false)
    }
  }

  function navigateUp() {
    if (!browsePath) return
    const parent = browsePath.replace(/\/[^/]+\/?$/, '') || '/'
    void browse(parent)
  }

  function selectDir(dir: string) {
    const newPath = browsePath === '/' ? `/${dir}` : `${browsePath}/${dir}`
    void browse(newPath)
  }

  function pickCurrentDir() {
    if (!browsePath) return
    setPath(browsePath)
    setBrowserOpen(false)
  }

  const inputSizeClass = inputClass ?? 'text-[13px]'

  return (
    <div className="relative">
      <label className="mb-1.5 block text-neutral-5" style={{ fontSize: inputClass ? undefined : '13px' }}>
        <span className="flex items-center gap-1.5">
          <IconFolder size={13} className="text-neutral-6" />
          Repositories Path
        </span>
      </label>

      <div className="flex gap-1.5">
        <input
          type="text"
          value={path}
          onChange={e => { setPath(e.target.value); setError(null) }}
          onBlur={() => void save()}
          onKeyDown={e => { if (e.key === 'Enter') void save() }}
          placeholder={placeholder}
          disabled={saving}
          className={`flex-1 rounded border border-neutral-9 bg-neutral-10 px-3 py-2 ${inputSizeClass} font-mono text-neutral-3 outline-none focus:border-primary-7 disabled:opacity-50`}
        />
        <button
          type="button"
          onClick={() => browserOpen ? setBrowserOpen(false) : void browse(path || undefined)}
          disabled={!token || browseLoading}
          className="flex items-center gap-1 rounded border border-neutral-9 bg-neutral-10 px-2.5 py-2 text-[13px] text-neutral-4 hover:border-neutral-7 hover:text-neutral-3 disabled:opacity-50"
          title="Browse folders"
        >
          {browseLoading ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-6 border-t-transparent" />
          ) : (
            <IconFolderOpen size={16} />
          )}
        </button>
      </div>

      {/* Error message */}
      {(error || browseError) && (
        <p className="mt-1 text-[12px] text-red-400">
          {error || browseError}
        </p>
      )}

      {/* Help text */}
      {helpText && !error && !browseError && (
        <p className="mt-1 text-[12px] text-neutral-6">{helpText}</p>
      )}

      {/* Directory browser dropdown */}
      {browserOpen && browsePath !== null && (
        <div
          ref={dropdownRef}
          className="absolute z-50 mt-1 w-full rounded-lg border border-neutral-8 bg-neutral-10 shadow-lg"
        >
          {/* Current path header */}
          <div className="flex items-center gap-2 border-b border-neutral-8 px-3 py-2">
            <button
              type="button"
              onClick={navigateUp}
              className="rounded p-0.5 text-neutral-5 hover:bg-neutral-8 hover:text-neutral-3"
              title="Go up"
            >
              <IconArrowUp size={14} />
            </button>
            <span className="flex-1 truncate font-mono text-[12px] text-neutral-4">{browsePath}</span>
            <button
              type="button"
              onClick={() => setBrowserOpen(false)}
              className="rounded p-0.5 text-neutral-5 hover:bg-neutral-8 hover:text-neutral-3"
            >
              <IconX size={14} />
            </button>
          </div>

          {/* Directory list */}
          <div className="max-h-48 overflow-y-auto py-1">
            {dirs.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-neutral-6">No subdirectories</p>
            ) : (
              dirs.map(dir => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => selectDir(dir)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-neutral-3 hover:bg-neutral-8"
                >
                  <IconFolder size={14} className="shrink-0 text-neutral-5" />
                  <span className="truncate">{dir}</span>
                  <IconChevronRight size={12} className="ml-auto shrink-0 text-neutral-6" />
                </button>
              ))
            )}
          </div>

          {/* Select current directory button */}
          <div className="border-t border-neutral-8 px-3 py-2">
            <button
              type="button"
              onClick={pickCurrentDir}
              className="w-full rounded bg-primary-7 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-primary-6"
            >
              Select this folder
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
