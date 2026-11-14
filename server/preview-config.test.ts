import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { displayCommand, parseJsonc, publicConfig, readLaunchConfigs, resolveLaunchEntry } from './preview-config.js'

describe('parseJsonc', () => {
  it('reads comments and trailing commas, leaving strings alone', () => {
    expect(parseJsonc(`{
      // the app
      "a": "http://x//y", /* block */
      "b": [1, 2,],
      "c": "keep ,} this",
    }`)).toEqual({ a: 'http://x//y', b: [1, 2], c: 'keep ,} this' })
  })
})

describe('resolveLaunchEntry', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'launch-'))
    mkdirSync(path.join(root, 'web'))
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('resolves a package-manager entry', () => {
    const c = resolveLaunchEntry({ name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 5173, cwd: 'web', env: { MODE: '${workspaceFolder}/x' } }, root, 0)
    expect(c.error).toBeUndefined()
    expect(c.command).toBe('npm run dev')
    expect(c.port).toBe(5173)
    expect(c.cwd).toBe('web')
    expect(c.env.MODE).toBe(`${root}/x`)
    expect(publicConfig(c)).toEqual({ name: 'web', command: 'npm run dev', port: 5173, cwd: 'web', envKeys: ['MODE'] })
  })

  it('runs program entries with node and defaults the port to 3000', () => {
    const c = resolveLaunchEntry({ name: 'api', program: 'server.js', args: ['--watch'] }, root, 0)
    expect(c.executable).toBe('node')
    expect(c.args).toEqual(['server.js', '--watch'])
    expect(c.port).toBe(3000)
  })

  it('attaches to a server you run, by localhost url', () => {
    const c = resolveLaunchEntry({ name: 'mine', url: 'http://localhost:8080' }, root, 0)
    expect(c.error).toBeUndefined()
    expect(c.command).toBeNull()
    expect(c.port).toBe(8080)
  })

  it('reports what is wrong with an entry', () => {
    expect(resolveLaunchEntry({ name: 'x', url: 'https://app.example.com' }, root, 0).error).toMatch(/http:\/\//)
    expect(resolveLaunchEntry({ name: 'x', url: 'http://app.example.com' }, root, 0).error).toMatch(/only previews servers on this machine/)
    expect(resolveLaunchEntry({ name: 'x', url: 'http://localhost:1', port: 2 }, root, 0).error).toMatch(/must match/)
    expect(resolveLaunchEntry({ name: 'x', runtimeExecutable: 'npm', cwd: '../..' }, root, 0).error).toMatch(/outside the project|does not exist/)
    expect(resolveLaunchEntry({ name: 'x', runtimeExecutable: 'npm', port: 70000 }, root, 0).error).toMatch(/port/)
    expect(resolveLaunchEntry({ name: 'x' }, root, 0).error).toMatch(/Give a command/)
  })

  it('quotes arguments for display', () => {
    expect(displayCommand('npm', ['run', 'dev', '--', '--host', 'a b'])).toBe("npm run dev -- --host 'a b'")
  })
})

describe('readLaunchConfigs', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'launch-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('is empty without a file', async () => {
    expect(await readLaunchConfigs(root)).toEqual({ file: '.claude/launch.json', configs: [] })
  })

  it('reads the file and flags duplicate names', async () => {
    mkdirSync(path.join(root, '.claude'))
    writeFileSync(path.join(root, '.claude/launch.json'), `{
      "version": "0.0.1",
      "configurations": [
        { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 5173 },
        { "name": "web", "runtimeExecutable": "yarn" }, // duplicate
      ]
    }`)
    const r = await readLaunchConfigs(root)
    expect(r.error).toBeUndefined()
    expect(r.configs.map(c => [c.name, c.error ?? null])).toEqual([['web', null], ['web', 'Another configuration is also named "web".']])
  })

  it('reports a file it can not read', async () => {
    mkdirSync(path.join(root, '.claude'))
    writeFileSync(path.join(root, '.claude/launch.json'), '{ nope')
    expect((await readLaunchConfigs(root)).error).toMatch(/can't be read/)
    writeFileSync(path.join(root, '.claude/launch.json'), '{}')
    expect((await readLaunchConfigs(root)).error).toMatch(/no "configurations"/)
  })
})
