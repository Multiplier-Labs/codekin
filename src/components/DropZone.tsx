/**
 * Full-window drag-and-drop overlay for file uploads.
 *
 * Listens on the window for drag/drop and paste events. When files are
 * dragged over the window, shows a translucent overlay with an upload icon.
 * Uses a drag-enter/leave counter to correctly handle nested DOM elements.
 * Also supports pasting images from the clipboard.
 */

import { useState, useEffect, useRef } from 'react'
import { IconUpload } from '@tabler/icons-react'

interface Props {
  onUpload: (files: File[]) => void
  disabled?: boolean
}

function getFiles(dt: DataTransfer): File[] {
  const files: File[] = []
  for (const item of Array.from(dt.items)) {
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  if (files.length === 0) {
    for (const file of Array.from(dt.files)) {
      files.push(file)
    }
  }
  return files
}

export function DropZone({ onUpload, disabled }: Props) {
  const [dragOver, setDragOver] = useState(false)
  const dragCountRef = useRef(0)

  // Window-level drag listeners — no wrapping required
  useEffect(() => {
    if (disabled) return

    function handleDragEnter(e: DragEvent) {
      e.preventDefault()
      dragCountRef.current++
      if (dragCountRef.current === 1) setDragOver(true)
    }
    function handleDragLeave(e: DragEvent) {
      e.preventDefault()
      dragCountRef.current--
      if (dragCountRef.current === 0) setDragOver(false)
    }
    function handleDragOver(e: DragEvent) {
      e.preventDefault()
    }
    function handleDrop(e: DragEvent) {
      e.preventDefault()
      dragCountRef.current = 0
      setDragOver(false)
      if (e.dataTransfer) {
        const files = getFiles(e.dataTransfer)
        if (files.length > 0) onUpload(files)
      }
    }

    window.addEventListener('dragenter', handleDragEnter)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragenter', handleDragEnter)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', handleDrop)
    }
  }, [onUpload, disabled])

  // Window-level paste listener for images
  useEffect(() => {
    if (disabled) return
    function handlePaste(e: ClipboardEvent) {
      if (!e.clipboardData) return
      const files = getFiles(e.clipboardData)
      if (files.length > 0) {
        e.preventDefault()
        onUpload(files)
      }
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [onUpload, disabled])

  if (!dragOver || disabled) return null

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center rounded border-2 border-dashed border-primary-7 bg-primary-11/60 backdrop-blur-sm pointer-events-none">
      <div className="text-center">
        <IconUpload className="mx-auto mb-2 text-primary-6" size={40} stroke={1.5} />
        <p className="text-[15px] font-medium text-primary-5">Drop files here</p>
      </div>
    </div>
  )
}
