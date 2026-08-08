/** Tests for resolveAttachmentPath — verifies uploads resolve and everything outside SCREENSHOTS_DIR is rejected. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const uploadRoot = vi.hoisted(() => {
  const { mkdtempSync, realpathSync } = require('fs')
  const { tmpdir } = require('os')
  const { join } = require('path')
  return realpathSync(mkdtempSync(join(tmpdir(), 'codekin-uploads-')))
})

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  SCREENSHOTS_DIR: uploadRoot,
}))

import { resolveAttachmentPath } from './attachment-paths.js'
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename } from 'path'

describe('resolveAttachmentPath', () => {
  let outside: string

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'codekin-outside-'))
  })

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true })
  })

  describe('accepts', () => {
    it('resolves a file directly inside the upload directory', () => {
      const file = join(uploadRoot, 'shot.png')
      writeFileSync(file, 'x')

      expect(resolveAttachmentPath(file)).toBe(realpathSync(file))
      rmSync(file)
    })

    it('resolves a file in a nested subdirectory', () => {
      const nested = join(uploadRoot, 'nested', 'deeper')
      mkdirSync(nested, { recursive: true })
      const file = join(nested, 'shot.png')
      writeFileSync(file, 'x')

      expect(resolveAttachmentPath(file)).toBe(realpathSync(file))
      rmSync(join(uploadRoot, 'nested'), { recursive: true, force: true })
    })
  })

  describe('rejects', () => {
    it('returns null for a file outside the upload directory', () => {
      const file = join(outside, 'id_rsa')
      writeFileSync(file, 'secret')

      expect(resolveAttachmentPath(file)).toBeNull()
    })

    it('returns null for a nonexistent path', () => {
      expect(resolveAttachmentPath(join(uploadRoot, 'missing.png'))).toBeNull()
    })

    it('returns null for a symlink pointing outside the upload directory', () => {
      const secret = join(outside, 'secret.txt')
      writeFileSync(secret, 'secret')
      const link = join(uploadRoot, 'link.txt')
      symlinkSync(secret, link)

      expect(resolveAttachmentPath(link)).toBeNull()
      rmSync(link)
    })

    it('returns null for traversal segments that escape the upload directory', () => {
      const secret = join(outside, 'secret.txt')
      writeFileSync(secret, 'secret')

      const traversal = join(uploadRoot, '..', basename(outside), 'secret.txt')
      expect(resolveAttachmentPath(traversal)).toBeNull()
    })

    it('returns null for the upload directory itself', () => {
      expect(resolveAttachmentPath(uploadRoot)).toBeNull()
    })

    it('returns null for a sibling directory sharing the upload prefix', () => {
      // Guards against a plain startsWith check matching "<root>-evil".
      const sibling = `${uploadRoot}-evil`
      mkdirSync(sibling, { recursive: true })
      const file = join(sibling, 'secret.txt')
      writeFileSync(file, 'secret')

      expect(resolveAttachmentPath(file)).toBeNull()
      rmSync(sibling, { recursive: true, force: true })
    })

    it('returns null for a relative path resolving outside the upload directory', () => {
      expect(resolveAttachmentPath('etc/passwd')).toBeNull()
    })
  })
})
