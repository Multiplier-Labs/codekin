/**
 * Parses raw `git diff` output into structured DiffFile[] objects.
 *
 * Handles unified diff format with rename detection, binary files,
 * and optional size-based truncation.
 */

import type { DiffFile, DiffFileStatus, DiffHunk, DiffLine } from './types.js'

/** 2 MB default cap on raw diff output before truncation. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export interface ParseDiffResult {
  files: DiffFile[]
  truncated: boolean
  truncationReason?: string
}

/**
 * Parse raw unified diff output into structured file/hunk/line objects.
 * If `maxBytes` is provided and the input exceeds it, parsing stops early
 * and `truncated` is set to true.
 */
export function parseDiff(raw: string, maxBytes: number = DEFAULT_MAX_BYTES): ParseDiffResult {
  let truncated = false
  let truncationReason: string | undefined
  let input = raw

  if (Buffer.byteLength(raw, 'utf-8') > maxBytes) {
    truncated = true
    truncationReason = `Diff output exceeded ${Math.round(maxBytes / (1024 * 1024))} MB limit`
    // Truncate to roughly maxBytes — cut at last newline before limit
    const buf = Buffer.from(raw, 'utf-8')
    const sliced = buf.subarray(0, maxBytes).toString('utf-8')
    const lastNewline = sliced.lastIndexOf('\n')
    input = lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced
  }

  const files: DiffFile[] = []

  // Split on diff headers: "diff --git a/... b/..."
  const fileSections = input.split(/^diff --git /m)

  for (let i = 1; i < fileSections.length; i++) {
    const section = fileSections[i]
    const file = parseFileSection(section)
    if (file) files.push(file)
  }

  return { files, truncated, truncationReason }
}

function parseFileSection(section: string): DiffFile | null {
  const lines = section.split('\n')
  if (lines.length === 0) return null

  // First line: "a/path b/path"
  const headerLine = lines[0]
  const pathMatch = headerLine.match(/^a\/(.+?) b\/(.+?)$/)
  if (!pathMatch) return null

  const bPath = pathMatch[2]

  let status: DiffFileStatus = 'modified'
  let oldPath: string | undefined
  let isBinary = false
  const hunks: DiffHunk[] = []
  let additions = 0
  let deletions = 0

  let lineIdx = 1

  // Parse extended header lines (new file, deleted file, rename, binary, etc.)
  while (lineIdx < lines.length) {
    const line = lines[lineIdx]

    if (line.startsWith('new file mode')) {
      status = 'added'
    } else if (line.startsWith('deleted file mode')) {
      status = 'deleted'
    } else if (line.startsWith('rename from ')) {
      status = 'renamed'
      oldPath = line.slice('rename from '.length)
    } else if (line.startsWith('similarity index') || line.startsWith('dissimilarity index')) {
      // part of rename/copy header, skip
    } else if (line.startsWith('rename to ')) {
      // already captured via bPath
    } else if (line.startsWith('index ')) {
      // index line, skip
    } else if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
      isBinary = true
    } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      // file marker lines — skip but keep going for hunks
    } else if (line.startsWith('@@')) {
      // Start of hunks — break out to hunk parsing
      break
    } else if (line.startsWith('old mode') || line.startsWith('new mode')) {
      // mode change, skip
    } else {
      // Unknown header line or empty — if we hit content, stop
      if (!line.startsWith('\\') && line !== '') {
        break
      }
    }
    lineIdx++
  }

  // Parse hunks
  if (!isBinary) {
    while (lineIdx < lines.length) {
      const line = lines[lineIdx]
      if (line.startsWith('@@')) {
        const hunkResult = parseHunk(lines, lineIdx)
        if (hunkResult) {
          hunks.push(hunkResult.hunk)
          additions += hunkResult.additions
          deletions += hunkResult.deletions
          lineIdx = hunkResult.nextIdx
        } else {
          lineIdx++
        }
      } else {
        lineIdx++
      }
    }
  }

  return {
    path: bPath,
    status,
    oldPath: status === 'renamed' ? oldPath : undefined,
    isBinary,
    additions,
    deletions,
    hunks,
  }
}

interface HunkParseResult {
  hunk: DiffHunk
  additions: number
  deletions: number
  nextIdx: number
}

function parseHunk(lines: string[], startIdx: number): HunkParseResult | null {
  const headerLine = lines[startIdx]
  // Parse "@@ -10,7 +10,8 @@ optional context"
  const hunkMatch = headerLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
  if (!hunkMatch) return null

  const oldStart = parseInt(hunkMatch[1], 10)
  const oldLines = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1
  const newStart = parseInt(hunkMatch[3], 10)
  const newLines = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1

  const diffLines: DiffLine[] = []
  let additions = 0
  let deletions = 0
  let oldLineNo = oldStart
  let newLineNo = newStart
  let idx = startIdx + 1

  while (idx < lines.length) {
    const line = lines[idx]

    // Next hunk or next file
    if (line.startsWith('@@') || line.startsWith('diff --git ')) break

    if (line.startsWith('+')) {
      diffLines.push({
        type: 'add',
        content: line.slice(1),
        newLineNo: newLineNo,
      })
      additions++
      newLineNo++
    } else if (line.startsWith('-')) {
      diffLines.push({
        type: 'delete',
        content: line.slice(1),
        oldLineNo: oldLineNo,
      })
      deletions++
      oldLineNo++
    } else if (line.startsWith(' ')) {
      diffLines.push({
        type: 'context',
        content: line.slice(1),
        oldLineNo: oldLineNo,
        newLineNo: newLineNo,
      })
      oldLineNo++
      newLineNo++
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — skip
    } else if (line === '') {
      // Unified diff always prefixes lines with ' ', '+', or '-'.
      // An empty string means end-of-section (from split at file boundaries).
      break
    } else {
      break
    }
    idx++
  }

  return {
    hunk: {
      header: headerLine,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: diffLines,
    },
    additions,
    deletions,
    nextIdx: idx,
  }
}

/**
 * Generate a synthetic diff for an untracked file, treating it as fully added.
 * Reads the file content and produces a single hunk with all lines as additions.
 */
export function createUntrackedFileDiff(relativePath: string, content: string): DiffFile {
  const fileLines = content.split('\n')
  // Remove trailing empty line from split if file ends with newline
  if (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') {
    fileLines.pop()
  }

  const diffLines: DiffLine[] = fileLines.map((line, i) => ({
    type: 'add' as const,
    content: line,
    newLineNo: i + 1,
  }))

  return {
    path: relativePath,
    status: 'added',
    isBinary: false,
    additions: fileLines.length,
    deletions: 0,
    hunks: fileLines.length > 0 ? [{
      header: `@@ -0,0 +1,${fileLines.length} @@`,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: fileLines.length,
      lines: diffLines,
    }] : [],
  }
}
