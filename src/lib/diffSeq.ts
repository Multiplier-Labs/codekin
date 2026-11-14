/**
 * Diff two sequences (Markdown blocks, table rows, source lines) for the
 * Canvas compare view: an LCS walk that keeps unchanged entries in order.
 * Past `limit` cells of work it falls back to "all removed, then all added",
 * which is still correct, just not minimal.
 */

export type DiffOp<T> = { op: 'same' | 'add' | 'del'; value: T }

export function diffSequences<T>(a: T[], b: T[], key: (v: T) => string = String, limit = 4_000_000): DiffOp<T>[] {
  // Trim the common head and tail first: revisions usually change a little in the middle.
  let start = 0
  while (start < a.length && start < b.length && key(a[start]) === key(b[start])) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && key(a[endA - 1]) === key(b[endB - 1])) { endA--; endB-- }

  const head = a.slice(0, start).map(value => ({ op: 'same' as const, value }))
  const tail = a.slice(endA).map(value => ({ op: 'same' as const, value }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const n = midA.length
  const m = midB.length

  if (n * m > limit) {
    return [...head, ...midA.map(value => ({ op: 'del' as const, value })), ...midB.map(value => ({ op: 'add' as const, value })), ...tail]
  }

  const ka = midA.map(key)
  const kb = midB.map(key)
  // lcs[i][j] = length of the LCS of midA[i..] and midB[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = ka[i] === kb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const mid: DiffOp<T>[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { mid.push({ op: 'same', value: midA[i] }); i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { mid.push({ op: 'del', value: midA[i] }); i++ }
    else { mid.push({ op: 'add', value: midB[j] }); j++ }
  }
  while (i < n) mid.push({ op: 'del', value: midA[i++] })
  while (j < m) mid.push({ op: 'add', value: midB[j++] })
  return [...head, ...mid, ...tail]
}
