#!/usr/bin/env node
/**
 * Check a production build against the strict CSP the web app is served with
 * (nginx/snippets/codekin-security-headers.conf.example): no inline script
 * and no third-party origins in the document or its stylesheets.
 *
 *   node scripts/check-csp-build.mjs [dist-dir ...]   # default: dist dist-hosted
 *
 * Exits 1 with one line per problem. A missing directory is an error, so CI
 * can't pass by skipping the build.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const dirs = process.argv.length > 2 ? process.argv.slice(2) : ['dist', 'dist-hosted']

/** Origins a built file may name without the CSP blocking it. */
const ALLOWED_ORIGINS = new Set([
  // Hosted sign-in shows GitHub avatars (img-src allows exactly this host).
  'https://avatars.githubusercontent.com',
])

export function checkIndexHtml(html) {
  const problems = []
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, body] = match
    if (!/\bsrc\s*=/.test(attrs) || body.trim() !== '') problems.push('inline <script> (blocked by script-src \'self\')')
  }
  if (/<style\b/i.test(html)) problems.push('inline <style> element (blocked by style-src \'self\')')
  if (/\son[a-z]+\s*=/i.test(html)) problems.push('inline event handler attribute')
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi)) {
    const origin = originOf(match[1])
    if (origin && !ALLOWED_ORIGINS.has(origin)) problems.push(`third-party origin ${origin}`)
  }
  return problems
}

export function checkStylesheet(css) {
  const problems = []
  // font-src is 'self' only: a font inlined as a data: URI is blocked.
  if (/url\(\s*["']?data:(?:font\/|application\/(?:x-)?font)/i.test(css)) problems.push('font inlined as a data: URI (blocked by font-src \'self\')')
  for (const match of css.matchAll(/(?:@import\s+(?:url\()?|url\()\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi)) {
    const origin = originOf(match[1])
    if (origin && !ALLOWED_ORIGINS.has(origin)) problems.push(`third-party origin ${origin}`)
  }
  return problems
}

function originOf(url) {
  try {
    return new URL(url, 'https://self.invalid').origin
  } catch {
    return null
  }
}

function filesUnder(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(path))
    else out.push(path)
  }
  return out
}

function main() {
  const problems = []
  for (const dir of dirs) {
    const index = join(dir, 'index.html')
    if (!existsSync(index)) {
      problems.push(`${index}: missing (build first)`)
      continue
    }
    for (const p of checkIndexHtml(readFileSync(index, 'utf8'))) problems.push(`${index}: ${p}`)
    for (const file of filesUnder(dir).filter(f => f.endsWith('.css'))) {
      for (const p of checkStylesheet(readFileSync(file, 'utf8'))) problems.push(`${relative('.', file)}: ${p}`)
    }
  }
  if (problems.length > 0) {
    console.error(`CSP build check failed:\n${problems.map(p => `  - ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`CSP build check passed: ${dirs.join(', ')}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
