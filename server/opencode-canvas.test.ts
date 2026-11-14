/** Tests for OpenCode's Canvas tools: the scoped token, the generated tool file, and its setup. */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { openCodeCanvasToken, openCodeCanvasToolSource, prepareOpenCodeCanvas, verifyOpenCodeCanvasToken, zodModuleUrl } from './opencode-canvas.js'

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('OpenCode Canvas token', () => {
  it('is derived from the master token and verified exactly', () => {
    const token = openCodeCanvasToken('master')
    expect(token).not.toContain('master')
    expect(verifyOpenCodeCanvasToken('master', token)).toBe(true)
    expect(verifyOpenCodeCanvasToken('other', token)).toBe(false)
    expect(verifyOpenCodeCanvasToken('master', undefined)).toBe(false)
    expect(verifyOpenCodeCanvasToken('', token)).toBe(false)
  })
})

describe('prepareOpenCodeCanvas', () => {
  it('writes the tool file and returns the server environment', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'oc-canvas-'))
    const env = prepareOpenCodeCanvas({ dataDir: dir, port: 4321, masterToken: 'm', env: {}, zodUrl: 'file:///z/index.js' })
    expect(env).toEqual({ OPENCODE_CONFIG_DIR: path.join(dir, 'opencode'), CODEKIN_PORT: '4321', CODEKIN_OPENCODE_CANVAS_TOKEN: openCodeCanvasToken('m') })
    expect(readFileSync(path.join(dir, 'opencode', 'tool', 'canvas.ts'), 'utf-8')).toContain('import { z } from "file:///z/index.js"')
  })

  it("leaves a user's own OPENCODE_CONFIG_DIR alone, and needs zod and a token", () => {
    dir = mkdtempSync(path.join(tmpdir(), 'oc-canvas-'))
    expect(prepareOpenCodeCanvas({ dataDir: dir, port: 1, masterToken: 'm', env: { OPENCODE_CONFIG_DIR: '/mine' }, zodUrl: 'x' })).toEqual({})
    expect(prepareOpenCodeCanvas({ dataDir: dir, port: 1, masterToken: 'm', env: {}, zodUrl: null })).toEqual({})
    expect(prepareOpenCodeCanvas({ dataDir: dir, port: 1, masterToken: '', env: {}, zodUrl: 'x' })).toEqual({})
  })
})

describe('the generated tool file', () => {
  async function loadTools() {
    dir = mkdtempSync(path.join(tmpdir(), 'oc-canvas-tool-'))
    const file = path.join(dir, 'canvas.ts')
    writeFileSync(file, openCodeCanvasToolSource(zodModuleUrl()!))
    return await import(/* @vite-ignore */ file) as Record<'show' | 'update' | 'list', { args: Record<string, unknown>; execute: (a: Record<string, unknown>, c: { sessionID: string }) => Promise<string> }>
  }

  it('exports show, update and list, calling the local route for the OpenCode session', async () => {
    vi.stubEnv('CODEKIN_PORT', '4321')
    vi.stubEnv('CODEKIN_OPENCODE_CANVAS_TOKEN', 'tok')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ item: { id: 'i1', title: 'Report', kind: 'markdown', revision: 1 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ item: { id: 'i1', title: 'Report', kind: 'markdown', revision: 2 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Images need a path to the image file.' }), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    const tools = await loadTools()
    expect(Object.keys(tools.show.args)).toEqual(['title', 'kind', 'content', 'path', 'format', 'nodes'])

    expect(await tools.show.execute({ title: 'Report', kind: 'markdown', content: '# x' }, { sessionID: 'ses_1' })).toMatch(/id i1, revision 1/)
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4321/api/opencode-canvas/ses_1/items')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer tok' } })

    expect(await tools.update.execute({ itemId: 'i1', content: 'v2' }, { sessionID: 'ses_1' })).toMatch(/now revision 2/)
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:4321/api/opencode-canvas/ses_1/items/i1')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({ content: 'v2' })

    expect(await tools.list.execute({}, { sessionID: 'ses_1' })).toBe('The Canvas is empty.')
    await expect(tools.show.execute({ title: 'x', kind: 'image', content: 'x' }, { sessionID: 'ses_1' })).rejects.toThrow('Images need a path to the image file.')
  })
})
