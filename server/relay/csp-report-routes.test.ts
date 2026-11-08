/** Tests for the CSP violation report endpoint: both report formats, logging only directive + host, limits. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { createCspReportRouter, parseCspReports, MAX_CSP_REPORT_BYTES } from './csp-report-routes.js'

describe('parseCspReports', () => {
  it('reads the report-uri format', () => {
    expect(parseCspReports({
      'csp-report': {
        'document-uri': 'https://app.example.com/?token=secret',
        'violated-directive': "img-src 'self' data:",
        'blocked-uri': 'https://attacker.example/x.png?d=secret',
      },
    })).toEqual([{ directive: 'img-src', blocked: 'attacker.example' }])
  })

  it('reads a Reporting API batch and skips other report types', () => {
    expect(parseCspReports([
      { type: 'csp-violation', body: { effectiveDirective: 'script-src-elem', blockedURL: 'inline' } },
      { type: 'deprecation', body: { id: 'x' } },
      { type: 'csp-violation', body: { effectiveDirective: 'connect-src', blockedURL: 'wss://other.example:444/ws' } },
    ])).toEqual([
      { directive: 'script-src-elem', blocked: 'inline' },
      { directive: 'connect-src', blocked: 'other.example:444' },
    ])
  })

  it('never passes through anything but a directive name and a host or keyword', () => {
    expect(parseCspReports({ 'csp-report': { 'effective-directive': 'img-src\nFAKE LOG LINE', 'blocked-uri': 'data:image/png;base64,AAAA' } }))
      .toEqual([{ directive: 'img-src', blocked: 'data' }])
    expect(parseCspReports({ 'csp-report': { 'effective-directive': 'evil"directive', 'blocked-uri': 'not a url' } }))
      .toEqual([{ directive: 'unknown', blocked: 'unknown' }])
  })

  it('ignores bodies that are not reports', () => {
    expect(parseCspReports(undefined)).toEqual([])
    expect(parseCspReports({ hello: 'world' })).toEqual([])
    expect(parseCspReports('csp-report')).toEqual([])
  })
})

describe('POST /api/csp-report', () => {
  let server: Server
  let baseUrl: string
  let logged: string[]

  beforeEach(async () => {
    logged = []
    const app = express()
    app.use(createCspReportRouter(line => { logged.push(line) }))
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', () => { resolve() }))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  })

  const post = (body: string, type: string) =>
    fetch(`${baseUrl}/api/csp-report`, { method: 'POST', headers: { 'content-type': type }, body })

  it('accepts an application/csp-report body and logs only directive and host', async () => {
    const res = await post(JSON.stringify({
      'csp-report': { 'document-uri': 'https://app.example.com/s/abc?token=secret', 'effective-directive': 'img-src', 'blocked-uri': 'https://attacker.example/?d=secret' },
    }), 'application/csp-report')
    expect(res.status).toBe(204)
    expect(logged).toEqual(['[relay] CSP violation: img-src blocked attacker.example'])
    expect(logged.join('\n')).not.toContain('secret')
  })

  it('accepts an application/reports+json batch', async () => {
    const res = await post(JSON.stringify([
      { type: 'csp-violation', body: { effectiveDirective: 'style-src-elem', blockedURL: 'https://fonts.example/css' } },
    ]), 'application/reports+json')
    expect(res.status).toBe(204)
    expect(logged).toEqual(['[relay] CSP violation: style-src-elem blocked fonts.example'])
  })

  it('caps how many violations one request can log', async () => {
    const batch = Array.from({ length: 50 }, () => ({ type: 'csp-violation', body: { effectiveDirective: 'img-src', blockedURL: 'inline' } }))
    expect((await post(JSON.stringify(batch), 'application/reports+json')).status).toBe(204)
    expect(logged).toHaveLength(10)
  })

  it('refuses a body over the size limit without logging it', async () => {
    const big = JSON.stringify({ 'csp-report': { 'blocked-uri': 'x'.repeat(MAX_CSP_REPORT_BYTES) } })
    const res = await post(big, 'application/csp-report')
    expect(res.status).toBe(413)
    expect(logged).toEqual([])
  })

  it('answers malformed JSON with a quiet 400', async () => {
    expect((await post('{not json', 'application/csp-report')).status).toBe(400)
    expect(logged).toEqual([])
  })
})
