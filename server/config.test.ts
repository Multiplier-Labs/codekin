/** Tests for server config loading — verifies env-var precedence, file-based auth tokens, and defaults; mocks fs and os to control filesystem and home-directory lookups. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockExistsSync = vi.hoisted(() => vi.fn(() => false))
const mockReadFileSync = vi.hoisted(() => vi.fn(() => ''))
const mockRealpathSync = vi.hoisted(() => vi.fn((p: string) => p))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    realpathSync: mockRealpathSync,
  }
})

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    homedir: () => '/mock/home',
  }
})

const savedEnv = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  process.env = { ...savedEnv }
  // Remove all config-related env vars for a clean slate
  delete process.env.PORT
  delete process.env.CORS_ORIGIN
  delete process.env.NODE_ENV
  delete process.env.AUTH_TOKEN
  delete process.env.AUTH_TOKEN_FILE
  delete process.env.REPOS_ROOT
  delete process.env.DATA_DIR
  delete process.env.SCREENSHOTS_DIR
  delete process.env.FRONTEND_DIST
  delete process.env.GH_ORG

  // Reset mock implementations to defaults
  mockExistsSync.mockReturnValue(false)
  mockReadFileSync.mockReturnValue('')
  mockRealpathSync.mockImplementation((p: string) => p)
})

afterEach(() => {
  process.env = { ...savedEnv }
})

async function loadConfig() {
  return import('./config.js')
}

describe('config', () => {
  describe('PORT', () => {
    it('defaults to 32352 when PORT env is unset', async () => {
      const config = await loadConfig()
      expect(config.PORT).toBe(32352)
    })

    it('parses custom value from env', async () => {
      process.env.PORT = '8080'
      const config = await loadConfig()
      expect(config.PORT).toBe(8080)
    })

    it('results in NaN when PORT is non-numeric', async () => {
      process.env.PORT = 'not-a-number'
      const config = await loadConfig()
      expect(config.PORT).toBeNaN()
    })
  })

  describe('CORS_ORIGIN', () => {
    it('defaults to http://localhost:5173 when unset', async () => {
      const config = await loadConfig()
      expect(config.CORS_ORIGIN).toBe('http://localhost:5173')
    })

    it('uses the value from env when set', async () => {
      process.env.CORS_ORIGIN = 'https://app.example.com'
      const config = await loadConfig()
      expect(config.CORS_ORIGIN).toBe('https://app.example.com')
    })
  })

  describe('AUTH_TOKEN', () => {
    it('reads from AUTH_TOKEN env var', async () => {
      process.env.AUTH_TOKEN = 'direct-token-value'
      const config = await loadConfig()
      expect(config.AUTH_TOKEN).toBe('direct-token-value')
    })

    it('reads from AUTH_TOKEN_FILE when AUTH_TOKEN is unset', async () => {
      process.env.AUTH_TOKEN_FILE = '/run/secrets/auth-token'
      mockExistsSync.mockImplementation((p: unknown) =>
        p === '/run/secrets/auth-token' ? true : false
      )
      mockReadFileSync.mockImplementation((p: unknown) =>
        p === '/run/secrets/auth-token' ? '  file-token-value  \n' : ''
      )
      const config = await loadConfig()
      expect(config.AUTH_TOKEN).toBe('file-token-value')
    })

    it('returns empty string when neither AUTH_TOKEN nor AUTH_TOKEN_FILE is set', async () => {
      const config = await loadConfig()
      expect(config.AUTH_TOKEN).toBe('')
    })
  })

  describe('GH_ORGS', () => {
    it('parses comma-separated orgs', async () => {
      process.env.GH_ORG = 'org-alpha, org-beta , org-gamma'
      const config = await loadConfig()
      expect(config.GH_ORGS).toEqual(['org-alpha', 'org-beta', 'org-gamma'])
    })

    it('returns empty array when GH_ORG is unset', async () => {
      const config = await loadConfig()
      expect(config.GH_ORGS).toEqual([])
    })

    it('filters out empty entries from trailing commas', async () => {
      process.env.GH_ORG = 'org-one,,org-two,'
      const config = await loadConfig()
      expect(config.GH_ORGS).toEqual(['org-one', 'org-two'])
    })
  })

  describe('production mode', () => {
    it('calls process.exit(1) when NODE_ENV=production and CORS_ORIGIN is unset', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      const mockError = vi.spyOn(console, 'error').mockImplementation(() => {})

      process.env.NODE_ENV = 'production'
      // CORS_ORIGIN is already deleted in beforeEach

      await loadConfig()

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mockError).toHaveBeenCalled()

      mockExit.mockRestore()
      mockError.mockRestore()
    })
  })
})
