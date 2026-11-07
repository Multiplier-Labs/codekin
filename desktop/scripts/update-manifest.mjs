#!/usr/bin/env node
/**
 * Write the updater manifest (`latest.json`) for one release
 * (docs/DESKTOP-APP-TAURI-PLAN.md, "Distribution"; Tauri updater format).
 *
 *   node desktop/scripts/update-manifest.mjs --version 0.9.10 \
 *     --signature-file Codekin.app.tar.gz.sig --url https://…/Codekin_0.9.10_aarch64.app.tar.gz \
 *     [--notes "…"] [--out latest.json]
 *
 * The updater verifies the downloaded artifact against the app's public key
 * and, with `requireSignedVersion`, that the signature was made for this
 * version; the manifest itself is not signed. Publish it only after the
 * artifact and signature are uploaded.
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

export const PLATFORM = 'darwin-aarch64'

export function buildManifest({ version, signature, url, notes = '', pubDate = new Date() }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error(`version must be semver without a leading v, got ${version}`)
  const sig = (signature ?? '').trim()
  if (!sig) throw new Error('signature is empty')
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`url is not a URL: ${url}`)
  }
  if (parsed.protocol !== 'https:') throw new Error('url must be https')
  if (!parsed.pathname.endsWith('.app.tar.gz')) throw new Error('url must point at the .app.tar.gz updater artifact')
  if (!parsed.pathname.includes(version)) throw new Error(`url does not contain the version ${version}`)
  return {
    version,
    notes,
    pub_date: pubDate.toISOString(),
    platforms: { [PLATFORM]: { signature: sig, url: parsed.toString() } },
  }
}

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  try {
    const sigFile = arg(argv, '--signature-file')
    if (!sigFile) throw new Error('--signature-file is required')
    const manifest = buildManifest({
      version: arg(argv, '--version'),
      signature: readFileSync(sigFile, 'utf-8'),
      url: arg(argv, '--url'),
      notes: arg(argv, '--notes') ?? '',
    })
    const out = arg(argv, '--out') ?? 'latest.json'
    writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n')
    process.stderr.write(`[update-manifest] wrote ${out} for ${manifest.version}\n`)
  } catch (err) {
    process.stderr.write(`[update-manifest] ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
