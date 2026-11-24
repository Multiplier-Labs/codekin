/**
 * Runs before every test file. Tests must never touch the real data folder
 * (`~/.codekin`): a test that builds a SessionManager without mocking config
 * would otherwise restore the machine's real sessions and write over its
 * sessions.json and history files. Each test file gets its own empty folder.
 *
 * Node modules come from process.getBuiltinModule rather than imports:
 * vitest transforms setup files for the browser in jsdom test files, where
 * an import of `fs` does not resolve.
 */
import { afterAll } from 'vitest'

const fs = process.getBuiltinModule('node:fs')
const os = process.getBuiltinModule('node:os')
const path = process.getBuiltinModule('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codekin-test-data-'))
process.env.DATA_DIR = dataDir

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})
