/**
 * Shell command analysis for auto-approval matching.
 *
 * Two jobs:
 *  - Unwrap harness shell wrappers. Codex reports every command as
 *    `/bin/bash -lc '<command>'`, so allowlists (`Bash(rg:*)`) and saved
 *    "Always allow" rules never matched it.
 *  - Split compound commands into segments so each one is approved on its
 *    own: `cat a && rm -rf b` must not pass on a `cat` rule.
 *
 * Deliberately conservative: anything this cannot reason about (command or
 * process substitution, redirection, subshells, unbalanced quotes) returns
 * null and falls back to asking the user.
 */

/** `bash -lc '…'`, `/bin/sh -c "…"`, `zsh -c …` — optional path, optional -l. */
const WRAPPER = /^(?:\/usr)?(?:\/bin\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/

/**
 * Undo one level of shell quoting for a single wrapper argument:
 * 'single' (with the '"'"' idiom), "double" (backslash escapes), or a bare
 * word. Returns null when the argument is not exactly one quoted word.
 */
function unquoteArgument(arg: string): string | null {
  let out = ''
  let i = 0
  const s = arg.trim()
  while (i < s.length) {
    const ch = s[i]
    if (ch === "'") {
      const end = s.indexOf("'", i + 1)
      if (end < 0) return null
      out += s.slice(i + 1, end)
      i = end + 1
    } else if (ch === '"') {
      let j = i + 1
      let chunk = ''
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) {
          chunk += s[j + 1]
          j += 2
        } else {
          chunk += s[j]
          j++
        }
      }
      if (j >= s.length) return null
      out += chunk
      i = j + 1
    } else if (/\s/.test(ch)) {
      return null // more than one argument — not a plain `-c '<script>'`
    } else {
      out += ch
      i++
    }
  }
  return out
}

/** Strip a harness shell wrapper (`/bin/bash -lc '<cmd>'`) if present. */
export function unwrapShellCommand(command: string): string {
  let cmd = command.trim()
  // Wrappers can nest (bash -lc "bash -c '…'"); unwrap a few levels at most.
  for (let depth = 0; depth < 3; depth++) {
    const match = WRAPPER.exec(cmd)
    if (!match) break
    const inner = unquoteArgument(match[1])
    if (inner === null) break
    cmd = inner.trim()
  }
  return cmd
}

/**
 * Split an (unwrapped) command into simple segments on unquoted `&&`, `||`,
 * `;`, `|` and newlines. Returns null for constructs whose effect can't be
 * judged from the leading word: `$(…)`, backticks, `<(…)`, redirection,
 * subshells/groups, background `&`, or unbalanced quotes.
 */
export function splitShellSegments(command: string): string[] | null {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  const s = command

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (quote === '"' && (ch === '`' || (ch === '$' && s[i + 1] === '('))) return null
      else if (quote === '"' && ch === '\\') { current += ch + (s[i + 1] ?? ''); i++; continue }
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue }
    if (ch === '\\') { current += ch + (s[i + 1] ?? ''); i++; continue }
    if (ch === '`' || ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '<' || ch === '>') return null
    if (ch === '$' && s[i + 1] === '(') return null
    if ((ch === '&' && s[i + 1] === '&') || (ch === '|' && s[i + 1] === '|')) {
      segments.push(current); current = ''; i++; continue
    }
    if (ch === '&') return null // background job
    if (ch === ';' || ch === '|' || ch === '\n') {
      segments.push(current); current = ''; continue
    }
    current += ch
  }
  if (quote) return null
  segments.push(current)
  const cleaned = segments.map(seg => seg.trim()).filter(Boolean)
  return cleaned.length > 0 ? cleaned : null
}

/**
 * Drop output discards (`2>/dev/null`, `>/dev/null`, `2>&1`) — they only
 * silence output, and harnesses append them constantly. Any other
 * redirection still makes splitShellSegments refuse the command.
 */
export function stripOutputDiscards(command: string): string {
  return command.replace(/(^|\s)(?:[12]?>>?\s*\/dev\/null|2>&1)(?=\s|$|;|&&|\|)/g, '$1').trim()
}

/**
 * Segments of a command as the approval matcher should see them: wrapper
 * unwrapped, output discards dropped, split on control operators. Null when
 * the command cannot be judged segment by segment.
 */
export function approvalSegments(command: string): string[] | null {
  return splitShellSegments(stripOutputDiscards(unwrapShellCommand(command)))
}

/** `cd <dir>` only changes the directory — it never needs its own approval. */
export function isHarmlessSegment(segment: string): boolean {
  return /^cd(\s+\S+)?$/.test(segment) || segment === 'pwd' || segment === 'true'
}
