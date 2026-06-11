import { describe, it, expect } from 'vitest'
import {
  BUILTIN_COMMANDS,
  BUNDLED_SKILLS,
  resolveBuiltinAlias,
  buildSlashCommandList,
  buildOpenCodeSlashCommandList,
} from './slashCommands'
import type { Skill } from '../types'

describe('BUILTIN_COMMANDS', () => {
  it('has 6 commands', () => {
    expect(BUILTIN_COMMANDS).toHaveLength(6)
  })

  it('all have category "builtin"', () => {
    for (const cmd of BUILTIN_COMMANDS) {
      expect(cmd.category).toBe('builtin')
    }
  })
})

describe('BUNDLED_SKILLS', () => {
  it('has 5 skills', () => {
    expect(BUNDLED_SKILLS).toHaveLength(5)
  })

  it('all have category "bundled"', () => {
    for (const cmd of BUNDLED_SKILLS) {
      expect(cmd.category).toBe('bundled')
    }
  })
})

describe('resolveBuiltinAlias', () => {
  it('resolves canonical command to itself', () => {
    expect(resolveBuiltinAlias('/clear')).toBe('/clear')
    expect(resolveBuiltinAlias('/compact')).toBe('/compact')
    expect(resolveBuiltinAlias('/help')).toBe('/help')
  })

  it('resolves /reset alias to /clear', () => {
    expect(resolveBuiltinAlias('/reset')).toBe('/clear')
  })

  it('resolves /new alias to /clear', () => {
    expect(resolveBuiltinAlias('/new')).toBe('/clear')
  })

  it('returns undefined for unknown command', () => {
    expect(resolveBuiltinAlias('/unknown')).toBeUndefined()
  })

  it('returns undefined for non-slash string', () => {
    expect(resolveBuiltinAlias('clear')).toBeUndefined()
    expect(resolveBuiltinAlias('')).toBeUndefined()
  })
})

describe('buildSlashCommandList', () => {
  it('returns bundled + builtin when no filesystem skills provided', () => {
    const result = buildSlashCommandList([])
    const bundledCommands = result.filter((c) => c.category === 'bundled')
    const builtinCommands = result.filter((c) => c.category === 'builtin')

    expect(bundledCommands).toHaveLength(BUNDLED_SKILLS.length)
    expect(builtinCommands).toHaveLength(BUILTIN_COMMANDS.length)
    expect(result).toHaveLength(BUNDLED_SKILLS.length + BUILTIN_COMMANDS.length)
  })

  it('filesystem skill takes priority over bundled with same command', () => {
    const fsSkill: Skill = {
      command: '/commit',
      name: 'Custom Commit',
      description: 'My custom commit skill',
      content: '# Custom commit content',
    }
    const result = buildSlashCommandList([fsSkill])
    const commitEntries = result.filter((c) => c.command === '/commit')

    expect(commitEntries).toHaveLength(1)
    expect(commitEntries[0].category).toBe('skill')
    expect(commitEntries[0].name).toBe('Custom Commit')
    expect(commitEntries[0].content).toBe('# Custom commit content')
  })

  it('includes filesystem skills that do not overlap with bundled', () => {
    const fsSkill: Skill = {
      command: '/deploy',
      name: 'Deploy',
      description: 'Deploy to production',
      content: '# Deploy steps',
    }
    const result = buildSlashCommandList([fsSkill])
    const skillEntries = result.filter((c) => c.category === 'skill')

    expect(skillEntries).toHaveLength(1)
    expect(skillEntries[0].command).toBe('/deploy')
    expect(result).toHaveLength(
      1 + BUNDLED_SKILLS.length + BUILTIN_COMMANDS.length,
    )
  })

  it('does not create duplicate entries from aliases', () => {
    const result = buildSlashCommandList([])
    const clearEntries = result.filter(
      (c) =>
        c.command === '/clear' ||
        c.command === '/reset' ||
        c.command === '/new',
    )

    // Only the canonical /clear should appear, not /reset or /new as separate entries
    expect(clearEntries).toHaveLength(1)
    expect(clearEntries[0].command).toBe('/clear')
  })

  it('deduplicates filesystem skills with the same command', () => {
    const skills: Skill[] = [
      {
        command: '/deploy',
        name: 'Deploy A',
        description: 'First deploy',
        content: 'A',
      },
      {
        command: '/deploy',
        name: 'Deploy B',
        description: 'Second deploy',
        content: 'B',
      },
    ]
    const result = buildSlashCommandList(skills)
    const deployEntries = result.filter((c) => c.command === '/deploy')

    expect(deployEntries).toHaveLength(1)
    expect(deployEntries[0].name).toBe('Deploy A')
  })
})

describe('buildOpenCodeSlashCommandList', () => {
  it('returns only built-ins when no opencode commands provided', () => {
    const result = buildOpenCodeSlashCommandList([])
    expect(result).toHaveLength(BUILTIN_COMMANDS.length)
    expect(result.every((c) => c.category === 'builtin')).toBe(true)
  })

  it('maps opencode commands with the opencode category', () => {
    const result = buildOpenCodeSlashCommandList([
      { name: 'review', description: 'Review code', source: 'command' },
    ])
    const entry = result.find((c) => c.command === '/review')
    expect(entry).toBeDefined()
    expect(entry!.category).toBe('opencode')
    expect(entry!.description).toBe('Review code')
  })

  it('derives a description from the source when missing', () => {
    const result = buildOpenCodeSlashCommandList([
      { name: 'myskill', source: 'skill' },
      { name: 'myprompt', source: 'mcp' },
      { name: 'mycmd' },
    ])
    expect(result.find((c) => c.command === '/myskill')!.description).toBe('OpenCode skill')
    expect(result.find((c) => c.command === '/myprompt')!.description).toBe('MCP prompt')
    expect(result.find((c) => c.command === '/mycmd')!.description).toBe('OpenCode command')
  })

  it('opencode commands take priority over built-ins with the same name', () => {
    const result = buildOpenCodeSlashCommandList([{ name: 'help', description: 'OpenCode help' }])
    const helpEntries = result.filter((c) => c.command === '/help')
    expect(helpEntries).toHaveLength(1)
    expect(helpEntries[0].category).toBe('opencode')
  })

  it('deduplicates opencode commands with the same name', () => {
    const result = buildOpenCodeSlashCommandList([
      { name: 'review', description: 'First' },
      { name: 'review', description: 'Second' },
    ])
    const entries = result.filter((c) => c.command === '/review')
    expect(entries).toHaveLength(1)
    expect(entries[0].description).toBe('First')
  })

  it('does not include Claude bundled skills', () => {
    const result = buildOpenCodeSlashCommandList([])
    expect(result.find((c) => c.command === '/commit')).toBeUndefined()
  })
})
