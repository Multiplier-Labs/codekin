/** State of the Changes button above the transcript. */

/**
 * Whether to show the Changes button, and its count and tooltip detail.
 * Shown for uncommitted files, commits on the branch, or an edit just made in
 * this browser; the count prefers uncommitted files, then branch commits.
 */
export function changesButtonState(
  hasFileChanges: boolean,
  summary: { uncommittedFiles: number; branchCommits: number | null } | null | undefined,
): { show: boolean; count: number; detail: string } {
  const uncommittedFiles = summary?.uncommittedFiles ?? 0
  const branchCommits = summary?.branchCommits ?? 0
  return {
    show: hasFileChanges || uncommittedFiles > 0 || branchCommits > 0,
    count: uncommittedFiles || branchCommits,
    detail: [
      uncommittedFiles > 0 && `${uncommittedFiles} file${uncommittedFiles === 1 ? '' : 's'} with uncommitted changes`,
      branchCommits > 0 && `${branchCommits} commit${branchCommits === 1 ? '' : 's'} on this branch`,
    ].filter(Boolean).join(', '),
  }
}
