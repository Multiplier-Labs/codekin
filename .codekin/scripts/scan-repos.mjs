#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

const REPOS_DIR = process.env.REPOS_ROOT || '/srv/repos'
const CONFIG_PATH = join(homedir(), '.config', 'codekin', 'repos.yml')
const OUTPUT_PATH = join(import.meta.dirname, '..', '..', 'public', 'data', 'repos.json')

function parseSkillMd(content) {
  const lines = content.split('\n')
  const skill = { name: '', description: '' }
  let inFrontmatter = false

  for (const line of lines) {
    if (line.trim() === '---') {
      if (inFrontmatter) break
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      const match = line.match(/^(\w+):\s*(.+)/)
      if (match) {
        const [, key, value] = match
        if (key === 'name') skill.name = value.trim()
        if (key === 'description') skill.description = value.trim()
      }
    }
  }
  return skill
}

function scanSkills(repoPath) {
  const skillsDir = join(repoPath, '.claude', 'skills')
  if (!existsSync(skillsDir)) return []

  const skills = []
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillMd = join(skillsDir, entry.name, 'SKILL.md')
    if (!existsSync(skillMd)) continue
    const content = readFileSync(skillMd, 'utf-8')
    const parsed = parseSkillMd(content)
    skills.push({
      id: entry.name,
      name: parsed.name || entry.name,
      description: parsed.description || '',
      command: `/${entry.name}`,
    })
  }
  return skills
}

function getRepoTags(repoPath) {
  const tags = []
  if (existsSync(join(repoPath, 'package.json'))) tags.push('node')
  if (existsSync(join(repoPath, 'Cargo.toml'))) tags.push('rust')
  if (existsSync(join(repoPath, 'go.mod'))) tags.push('go')
  if (existsSync(join(repoPath, 'requirements.txt')) || existsSync(join(repoPath, 'pyproject.toml'))) tags.push('python')
  if (existsSync(join(repoPath, '.claude', 'settings.json'))) tags.push('claude')
  return tags
}

function loadRepoList() {
  // Simple YAML-like parser for repos.yml
  if (existsSync(CONFIG_PATH)) {
    const content = readFileSync(CONFIG_PATH, 'utf-8')
    const repos = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('- ')) {
        // Could be "- name: path" or just "- path"
        const value = trimmed.slice(2).trim()
        const colonIdx = value.indexOf(':')
        if (colonIdx > 0 && !value.startsWith('/')) {
          const name = value.slice(0, colonIdx).trim()
          const path = value.slice(colonIdx + 1).trim()
          repos.push({ name, path })
        } else {
          repos.push({ name: basename(value), path: value })
        }
      }
    }
    return repos
  }

  // Fallback: scan /srv/repos/
  return readdirSync(REPOS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => ({ name: d.name, path: join(REPOS_DIR, d.name) }))
}

function main() {
  const repoList = loadRepoList()
  const repos = repoList.map(({ name, path: repoPath }) => {
    const id = basename(repoPath)
    const fullPath = repoPath.startsWith('/') ? repoPath : join(REPOS_DIR, repoPath)
    const skills = scanSkills(fullPath)
    const tags = getRepoTags(fullPath)
    const workingDir = `${REPOS_DIR}/${id}`

    return { id, name, path: fullPath, workingDir, skills, tags }
  })

  const outputDir = join(OUTPUT_PATH, '..')
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })

  writeFileSync(OUTPUT_PATH, JSON.stringify({ repos, generatedAt: new Date().toISOString() }, null, 2))
  console.log(`Generated ${OUTPUT_PATH} with ${repos.length} repos`)
}

main()
