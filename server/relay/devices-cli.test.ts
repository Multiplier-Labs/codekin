/** `codekin relay devices trust|approve` refuse to run inside a Codekin session (spec §5.2b). */
import { describe, it, expect } from 'vitest'
import { insideCodekinSession, runDevicesCommand } from './devices-cli.js'

function run(args: string[], env: NodeJS.ProcessEnv) {
  const out: string[] = []
  const err: string[] = []
  const code = runDevicesCommand(args, '/nonexistent/relay.json', { out: l => { out.push(l) }, err: l => { err.push(l) } }, env)
  return { code, out, err }
}

describe('devices CLI inside a Codekin session', () => {
  it('refuses trust and approve before reading anything', () => {
    for (const args of [['trust', 'A'.repeat(22)], ['trust'], ['approve', 'K7QM-2XPA']]) {
      const r = run(args, { CODEKIN_SESSION_ID: 's1', CODEKIN_TRUST_TOKEN: 'B'.repeat(22) })
      expect(r.code).toBe(1)
      expect(r.err[0]).toContain('inside a Codekin session')
    }
  })

  it('leaves other commands, and runs outside a session, alone', () => {
    expect(run(['list'], { CODEKIN_SESSION_ID: 's1' }).err[0]).toContain('Not paired')
    expect(run(['trust', 'A'.repeat(22)], {}).err[0]).toContain('Not paired')
  })

  it('reads the marker the session spawner sets', () => {
    expect(insideCodekinSession({ CODEKIN_SESSION_ID: 'abc' })).toBe(true)
    expect(insideCodekinSession({ CODEKIN_SESSION_ID: '' })).toBe(false)
    expect(insideCodekinSession({})).toBe(false)
  })
})
