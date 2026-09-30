import { describe, expect, it } from 'vitest'
import { approvalSegments, isHarmlessSegment, splitShellSegments, stripOutputDiscards, unwrapShellCommand } from './shell-command.js'

describe('unwrapShellCommand', () => {
  it.each([
    ["/bin/bash -lc 'ls -la /home/dev/.codekin/orchestrator'", 'ls -la /home/dev/.codekin/orchestrator'],
    ['bash -c "git status --short"', 'git status --short'],
    ['/usr/bin/zsh -lc \'echo "hi"\'', 'echo "hi"'],
    ["sh -c 'cat PROFILE.md REPOS.md'", 'cat PROFILE.md REPOS.md'],
    // The '"'"' idiom Codex uses to embed single quotes
    // Adjacent quoted words concatenate, exactly as the shell would
    [`/bin/bash -lc "rg --files -g '"'!node_modules'"' /srv/repos/gitnook"`, `rg --files -g '!node_modules' /srv/repos/gitnook`],
    [`/bin/bash -lc 'rg --files -g '"'"'!node_modules'"'"' /srv/repos/gitnook'`, `rg --files -g '!node_modules' /srv/repos/gitnook`],
    ['bash -lc "bash -c \'ls\'"', 'ls'],
  ])('unwraps %s', (input, expected) => {
    expect(unwrapShellCommand(input)).toBe(expected)
  })

  it('leaves plain commands and multi-argument -c forms alone', () => {
    expect(unwrapShellCommand('git log --oneline')).toBe('git log --oneline')
    expect(unwrapShellCommand("bash -c 'ls' extra")).toBe("bash -c 'ls' extra")
    expect(unwrapShellCommand("bash -c 'unterminated")).toBe("bash -c 'unterminated")
  })
})

describe('splitShellSegments', () => {
  it('splits on unquoted control operators', () => {
    expect(splitShellSegments('cd /srv/repos/x && rg foo | head -20; git status || true')).toEqual([
      'cd /srv/repos/x', 'rg foo', 'head -20', 'git status', 'true',
    ])
  })

  it('keeps quoted operators inside their segment', () => {
    expect(splitShellSegments(`rg "a && b" -g '!x|y'`)).toEqual([`rg "a && b" -g '!x|y'`])
  })

  it.each([
    'cat $(ls)', 'echo `id`', 'diff <(ls a) <(ls b)', 'echo hi > out.txt', 'cat < in', '(cd x && ls)',
    '{ ls; }', 'sleep 10 &', 'echo "$(whoami)"', "echo 'unbalanced",
  ])('refuses %s', (cmd) => {
    expect(splitShellSegments(cmd)).toBeNull()
  })
})

describe('approvalSegments', () => {
  it('unwraps, drops output discards, and splits', () => {
    expect(approvalSegments("/bin/bash -lc 'cd /srv/repos/gitnook && git log --oneline -5 2>/dev/null | head'")).toEqual([
      'cd /srv/repos/gitnook', 'git log --oneline -5', 'head',
    ])
    expect(stripOutputDiscards('ls x >/dev/null 2>&1')).toBe('ls x')
    expect(approvalSegments("bash -lc 'ls > files.txt'")).toBeNull()
  })

  it('treats cd/pwd/true as harmless', () => {
    expect(isHarmlessSegment('cd /srv/repos/x')).toBe(true)
    expect(isHarmlessSegment('cd')).toBe(true)
    expect(isHarmlessSegment('cd x y')).toBe(false)
    expect(isHarmlessSegment('rm -rf x')).toBe(false)
  })
})
