/**
 * Renders diff hunks for a single file using react-diff-view.
 * Maps our DiffHunk[]/DiffLine[] types to react-diff-view's expected format.
 */

import { Diff, Hunk } from 'react-diff-view'
import type { HunkData, ChangeData } from 'react-diff-view'
import type { DiffHunk } from '../../types'
import 'react-diff-view/style/index.css'

interface DiffHunkViewProps {
  hunks: DiffHunk[]
}

/** Convert our DiffHunk[] to react-diff-view's HunkData[] format. */
function toRdvHunks(hunks: DiffHunk[]): HunkData[] {
  return hunks.map(hunk => {
    const changes: ChangeData[] = hunk.lines.map(line => {
      if (line.type === 'add') {
        return {
          type: 'insert' as const,
          isInsert: true,
          lineNumber: line.newLineNo ?? 0,
          content: line.content,
        }
      } else if (line.type === 'delete') {
        return {
          type: 'delete' as const,
          isDelete: true,
          lineNumber: line.oldLineNo ?? 0,
          content: line.content,
        }
      } else {
        return {
          type: 'normal' as const,
          isNormal: true,
          oldLineNumber: line.oldLineNo ?? 0,
          newLineNumber: line.newLineNo ?? 0,
          content: line.content,
        }
      }
    })

    return {
      content: hunk.header,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      changes,
    }
  })
}

export function DiffHunkView({ hunks }: DiffHunkViewProps) {
  if (hunks.length === 0) return null

  const rdvHunks = toRdvHunks(hunks)

  return (
    <div className="diff-hunk-view text-xs font-mono overflow-x-auto">
      <Diff viewType="unified" diffType="modify" hunks={rdvHunks}>
        {(rdvHunks) => rdvHunks.map((hunk, i) => (
          <Hunk key={`${hunk.oldStart}:${hunk.newStart}:${i}`} hunk={hunk} />
        ))}
      </Diff>
    </div>
  )
}
