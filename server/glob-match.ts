/**
 * Minimal glob matcher for Goal Run readonly constraints.
 *
 * Supports the subset needed by loop specs (e.g. `.github/workflows/**`,
 * `tests/security/**`, `*.lock`):
 *   **  — any run of characters, including '/'
 *   *   — any run of characters except '/'
 *   ?   — a single character except '/'
 * Everything else is matched literally. Patterns are anchored to the full path.
 *
 * Intentionally dependency-free — the codebase ships no glob library, and the
 * constraint set is small and author-controlled, so a focused matcher beats
 * pulling in micromatch.
 */

const REGEX_SPECIAL = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])

/** Convert a glob to a RegExp anchored to the whole string. */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++ // consume the second '*'
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if (REGEX_SPECIAL.has(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`)
}

/** True when `path` matches any of the supplied globs. */
export function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path))
}
