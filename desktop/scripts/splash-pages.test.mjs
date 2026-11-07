/** Tests for the bundled pages' hosted-location views (desktop/splash). */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { JSDOM } from 'jsdom'

const SPLASH = join(dirname(fileURLToPath(import.meta.url)), '..', 'splash')
const html = readFileSync(join(SPLASH, 'index.html'), 'utf-8').replace(/<script[^>]*><\/script>/, '')
const script = readFileSync(join(SPLASH, 'splash.js'), 'utf-8')

/** Load the page at `?query`, run splash.js, and record form submissions and IPC calls. */
function load(query) {
  const dom = new JSDOM(html, { url: `tauri://localhost/index.html?${query}`, runScripts: 'outside-only' })
  const { window } = dom
  const submitted = []
  const invoked = []
  window.HTMLFormElement.prototype.submit = function () {
    submitted.push({ action: this.action, fields: Object.fromEntries(new window.FormData(this)) })
  }
  window.__TAURI__ = { core: { invoke: (cmd, args) => { invoked.push([cmd, args]); return Promise.resolve() } } }
  window.eval(script)
  return { document: window.document, submitted, invoked }
}

function claimQuery(action) {
  return new URLSearchParams({ view: 'claim', action, code: 'c0de', code_verifier: 'v3rifier' }).toString()
}

describe('claim page', () => {
  it('posts the code and verifier to the relay claim endpoint', () => {
    const { submitted } = load(claimQuery('https://app.codekin.ai/api/auth/desktop/claim'))
    expect(submitted).toEqual([
      { action: 'https://app.codekin.ai/api/auth/desktop/claim', fields: { code: 'c0de', code_verifier: 'v3rifier' } },
    ])
  })

  it('allows plain http only on loopback', () => {
    expect(load(claimQuery('http://localhost:32360/api/auth/desktop/claim')).submitted).toHaveLength(1)
    expect(load(claimQuery('http://relay.example/api/auth/desktop/claim')).submitted).toHaveLength(0)
  })

  it('refuses anything that is not the claim endpoint', () => {
    for (const action of [
      'https://evil.example/collect',
      'https://app.codekin.ai/api/auth/desktop/claim?x=1',
      'javascript:alert(1)',
      '',
    ]) {
      expect(load(claimQuery(action)).submitted, action).toHaveLength(0)
    }
  })
})

describe('sign-in pages', () => {
  it('names the location and starts the browser sign-in on click', () => {
    const { document, invoked } = load('view=signin&name=Acme&origin=https%3A%2F%2Frelay.acme.dev&error=Too%20slow')
    expect(document.getElementById('signin').hidden).toBe(false)
    expect(document.getElementById('signin-title').textContent).toBe('Sign in to Acme')
    expect(document.getElementById('signin-error').textContent).toBe('Too slow')
    document.getElementById('signin-start').click()
    document.getElementById('signin-this-mac').click()
    expect(invoked).toEqual([['location_sign_in', undefined], ['location_switch', { id: null }]])
  })

  it('offers to reopen the browser or cancel while waiting', () => {
    const { document, invoked } = load('view=waiting&name=Acme')
    document.getElementById('waiting-reopen').click()
    document.getElementById('waiting-cancel').click()
    expect(invoked.map(([cmd]) => cmd)).toEqual(['location_sign_in_reopen', 'location_sign_in_cancel'])
  })

  it('keeps the existing splash and error views', () => {
    expect(load('view=status&status=restarting').document.getElementById('status-text').textContent)
      .toBe('Restarting the Codekin server…')
    expect(load('view=error&code=port_conflict').document.getElementById('error-title').textContent)
      .toBe('The Codekin port is taken')
  })
})
