import { describe, it, expect } from 'vitest'
import { parseDiff, createUntrackedFileDiff } from './diff-parser.js'

describe('parseDiff', () => {
  it('parses a basic multi-file diff with additions, deletions, and context', () => {
    const raw = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc1234..def5678 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -10,7 +10,8 @@ function hello() {',
      '   context line',
      '-  old line',
      '+  new line',
      '+  added line',
      '   context line',
      'diff --git a/src/bar.ts b/src/bar.ts',
      'index 1111111..2222222 100644',
      '--- a/src/bar.ts',
      '+++ b/src/bar.ts',
      '@@ -1,3 +1,2 @@',
      ' keep',
      '-remove',
      ' keep',
    ].join('\n')

    const result = parseDiff(raw)

    expect(result.truncated).toBe(false)
    expect(result.truncationReason).toBeUndefined()
    expect(result.files).toHaveLength(2)

    const foo = result.files[0]
    expect(foo.path).toBe('src/foo.ts')
    expect(foo.status).toBe('modified')
    expect(foo.additions).toBe(2)
    expect(foo.deletions).toBe(1)
    expect(foo.hunks).toHaveLength(1)
    expect(foo.hunks[0].oldStart).toBe(10)
    expect(foo.hunks[0].oldLines).toBe(7)
    expect(foo.hunks[0].newStart).toBe(10)
    expect(foo.hunks[0].newLines).toBe(8)
    expect(foo.hunks[0].lines).toHaveLength(5)

    const bar = result.files[1]
    expect(bar.path).toBe('src/bar.ts')
    expect(bar.status).toBe('modified')
    expect(bar.additions).toBe(0)
    expect(bar.deletions).toBe(1)
    expect(bar.hunks).toHaveLength(1)
    expect(bar.hunks[0].lines).toHaveLength(3)
  })

  it('truncates when input exceeds maxBytes', () => {
    // Create a diff that exceeds 100 bytes
    const raw = [
      'diff --git a/big.txt b/big.txt',
      'index aaa..bbb 100644',
      '--- a/big.txt',
      '+++ b/big.txt',
      '@@ -1,1 +1,1 @@',
      '-' + 'x'.repeat(200),
      '+' + 'y'.repeat(200),
    ].join('\n')

    const result = parseDiff(raw, 100)

    expect(result.truncated).toBe(true)
    expect(result.truncationReason).toBeDefined()
    expect(typeof result.truncationReason).toBe('string')
  })

  it('returns empty files array for empty input', () => {
    const result = parseDiff('')

    expect(result.files).toEqual([])
    expect(result.truncated).toBe(false)
    expect(result.truncationReason).toBeUndefined()
  })

  it('returns empty files array for whitespace-only input', () => {
    const result = parseDiff('   \n\n  ')

    expect(result.files).toEqual([])
    expect(result.truncated).toBe(false)
  })
})

describe('parseFileSection — new file', () => {
  it('detects added status for new file mode', () => {
    const raw = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,3 @@',
      '+line one',
      '+line two',
      '+line three',
    ].join('\n')

    const result = parseDiff(raw)

    expect(result.files).toHaveLength(1)
    const file = result.files[0]
    expect(file.path).toBe('src/new.ts')
    expect(file.status).toBe('added')
    expect(file.additions).toBe(3)
    expect(file.deletions).toBe(0)
    expect(file.hunks).toHaveLength(1)
    expect(file.hunks[0].lines.every(l => l.type === 'add')).toBe(true)
  })
})

describe('parseFileSection — deleted file', () => {
  it('detects deleted status for deleted file mode', () => {
    const raw = [
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      'index abc1234..0000000',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line one',
      '-line two',
    ].join('\n')

    const result = parseDiff(raw)

    expect(result.files).toHaveLength(1)
    const file = result.files[0]
    expect(file.path).toBe('src/old.ts')
    expect(file.status).toBe('deleted')
    expect(file.additions).toBe(0)
    expect(file.deletions).toBe(2)
    expect(file.hunks).toHaveLength(1)
    expect(file.hunks[0].lines.every(l => l.type === 'delete')).toBe(true)
  })
})

describe('parseFileSection — renamed file', () => {
  it('detects renamed status with oldPath set', () => {
    const raw = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 95%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
      'index abc1234..def5678 100644',
      '--- a/src/old-name.ts',
      '+++ b/src/new-name.ts',
      '@@ -1,3 +1,3 @@',
      ' unchanged',
      '-old content',
      '+new content',
      ' unchanged',
    ].join('\n')

    const result = parseDiff(raw)

    expect(result.files).toHaveLength(1)
    const file = result.files[0]
    expect(file.path).toBe('src/new-name.ts')
    expect(file.status).toBe('renamed')
    expect(file.oldPath).toBe('src/old-name.ts')
    expect(file.additions).toBe(1)
    expect(file.deletions).toBe(1)
  })
})

describe('parseFileSection — binary file', () => {
  it('detects binary with "Binary files ... differ"', () => {
    const raw = [
      'diff --git a/image.png b/image.png',
      'index abc1234..def5678 100644',
      'Binary files a/image.png and b/image.png differ',
    ].join('\n')

    const result = parseDiff(raw)

    expect(result.files).toHaveLength(1)
    const file = result.files[0]
    expect(file.path).toBe('image.png')
    expect(file.isBinary).toBe(true)
    expect(file.hunks).toHaveLength(0)
  })

  it('detects binary with "GIT binary patch"', () => {
    const raw = [
      'diff --git a/data.bin b/data.bin',
      'index abc1234..def5678 100644',
      'GIT binary patch',
      'literal 1234',
      'some binary data here',
    ].join('\n')

    const result = parseDiff(raw)

    expect(result.files).toHaveLength(1)
    expect(result.files[0].isBinary).toBe(true)
    expect(result.files[0].hunks).toHaveLength(0)
  })
})

describe('parseFileSection — mode change', () => {
  it('handles old mode / new mode lines', () => {
    const raw = [
      'diff --git a/script.sh b/script.sh',
      'old mode 100644',
      'new mode 100755',
      'index abc1234..def5678',
      '--- a/script.sh',
      '+++ b/script.sh',
      '@@ -1,2 +1,2 @@',
      ' #!/bin/bash',
      '-echo hello',
      '+echo world',
    ].join('\n')

    const result = parseDiff(raw)

    expect(result.files).toHaveLength(1)
    const file = result.files[0]
    expect(file.path).toBe('script.sh')
    expect(file.status).toBe('modified')
    expect(file.additions).toBe(1)
    expect(file.deletions).toBe(1)
  })
})

describe('parseHunk — line number tracking', () => {
  it('tracks oldLineNo and newLineNo correctly across context, add, delete lines', () => {
    const raw = [
      'diff --git a/src/lines.ts b/src/lines.ts',
      'index abc1234..def5678 100644',
      '--- a/src/lines.ts',
      '+++ b/src/lines.ts',
      '@@ -5,6 +5,7 @@ some context',
      ' context at 5',
      '-deleted at 6',
      '-deleted at 7',
      '+added at 6',
      '+added at 7',
      '+added at 8',
      ' context at 8',
    ].join('\n')

    const result = parseDiff(raw)
    const lines = result.files[0].hunks[0].lines

    // Context line at old:5, new:5
    expect(lines[0]).toEqual({ type: 'context', content: 'context at 5', oldLineNo: 5, newLineNo: 5 })

    // Delete at old:6
    expect(lines[1]).toEqual({ type: 'delete', content: 'deleted at 6', oldLineNo: 6 })

    // Delete at old:7
    expect(lines[2]).toEqual({ type: 'delete', content: 'deleted at 7', oldLineNo: 7 })

    // Add at new:6
    expect(lines[3]).toEqual({ type: 'add', content: 'added at 6', newLineNo: 6 })

    // Add at new:7
    expect(lines[4]).toEqual({ type: 'add', content: 'added at 7', newLineNo: 7 })

    // Add at new:8
    expect(lines[5]).toEqual({ type: 'add', content: 'added at 8', newLineNo: 8 })

    // Context at old:8, new:9
    expect(lines[6]).toEqual({ type: 'context', content: 'context at 8', oldLineNo: 8, newLineNo: 9 })
  })

  it('handles hunk header with single-line ranges (no comma)', () => {
    const raw = [
      'diff --git a/one.txt b/one.txt',
      'index abc..def 100644',
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n')

    const result = parseDiff(raw)
    const hunk = result.files[0].hunks[0]

    expect(hunk.oldStart).toBe(1)
    expect(hunk.oldLines).toBe(1)
    expect(hunk.newStart).toBe(1)
    expect(hunk.newLines).toBe(1)
  })
})

describe('parseHunk — no newline at end marker', () => {
  it('skips lines starting with backslash (no newline marker)', () => {
    const raw = [
      'diff --git a/file.txt b/file.txt',
      'index abc..def 100644',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,2 +1,2 @@',
      '-old line',
      '\\ No newline at end of file',
      '+new line',
      '\\ No newline at end of file',
    ].join('\n')

    const result = parseDiff(raw)
    const lines = result.files[0].hunks[0].lines

    // Only the actual diff lines, not the "no newline" markers
    expect(lines).toHaveLength(2)
    expect(lines[0].type).toBe('delete')
    expect(lines[1].type).toBe('add')
  })
})

describe('parseDiff — multiple hunks in one file', () => {
  it('parses multiple hunks within a single file', () => {
    const raw = [
      'diff --git a/multi.ts b/multi.ts',
      'index abc..def 100644',
      '--- a/multi.ts',
      '+++ b/multi.ts',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '@@ -20,3 +20,4 @@',
      ' x',
      ' y',
      '+z',
      ' w',
    ].join('\n')

    const result = parseDiff(raw)
    const file = result.files[0]

    expect(file.hunks).toHaveLength(2)
    expect(file.hunks[0].oldStart).toBe(1)
    expect(file.hunks[1].oldStart).toBe(20)
    expect(file.additions).toBe(2)
    expect(file.deletions).toBe(1)
  })
})

describe('createUntrackedFileDiff', () => {
  it('creates a DiffFile with all lines as additions', () => {
    const content = 'line one\nline two\nline three\n'
    const file = createUntrackedFileDiff('src/untracked.ts', content)

    expect(file.path).toBe('src/untracked.ts')
    expect(file.status).toBe('added')
    expect(file.isBinary).toBe(false)
    expect(file.additions).toBe(3)
    expect(file.deletions).toBe(0)
    expect(file.hunks).toHaveLength(1)

    const hunk = file.hunks[0]
    expect(hunk.header).toBe('@@ -0,0 +1,3 @@')
    expect(hunk.oldStart).toBe(0)
    expect(hunk.oldLines).toBe(0)
    expect(hunk.newStart).toBe(1)
    expect(hunk.newLines).toBe(3)

    expect(hunk.lines).toHaveLength(3)
    hunk.lines.forEach((line, i) => {
      expect(line.type).toBe('add')
      expect(line.newLineNo).toBe(i + 1)
    })
    expect(hunk.lines[0].content).toBe('line one')
    expect(hunk.lines[1].content).toBe('line two')
    expect(hunk.lines[2].content).toBe('line three')
  })

  it('returns empty hunks for empty content', () => {
    const file = createUntrackedFileDiff('empty.txt', '')

    expect(file.path).toBe('empty.txt')
    expect(file.status).toBe('added')
    expect(file.additions).toBe(0)
    expect(file.deletions).toBe(0)
    expect(file.hunks).toEqual([])
  })

  it('handles content without trailing newline', () => {
    const content = 'single line'
    const file = createUntrackedFileDiff('no-newline.txt', content)

    expect(file.additions).toBe(1)
    expect(file.hunks).toHaveLength(1)
    expect(file.hunks[0].lines).toHaveLength(1)
    expect(file.hunks[0].lines[0].content).toBe('single line')
  })
})
