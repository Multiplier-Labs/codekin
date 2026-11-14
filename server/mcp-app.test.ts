/** Tests for MCP Apps helpers: UI metadata, Claude tool names, results and resource documents. */
import { describe, it, expect } from 'vitest'
import { appDocument, claudeMcpToolName, findClaudeAppTool, isOwnServer, MAX_APP_HTML, showsApp, toContentBlocks, toolUiResourceUri } from './mcp-app.js'

describe('MCP Apps helpers', () => {
  it('reads the UI resource from tool metadata, current or legacy key', () => {
    expect(toolUiResourceUri({ ui: { resourceUri: 'ui://a/b' } })).toBe('ui://a/b')
    expect(toolUiResourceUri({ 'ui/resourceUri': 'ui://a/c' })).toBe('ui://a/c')
    expect(toolUiResourceUri({ ui: { resourceUri: 'https://evil.example' } })).toBeNull()
    expect(toolUiResourceUri(null)).toBeNull()
  })

  it('names tools the way Claude Code does', () => {
    expect(claudeMcpToolName('latency', 'latency_report')).toBe('mcp__latency__latency_report')
    expect(claudeMcpToolName('my server', 'do.it')).toBe('mcp__my_server__do_it')
  })

  it('normalizes result content and decides when an app is worth showing', () => {
    expect(toContentBlocks('hi')).toEqual([{ type: 'text', text: 'hi' }])
    expect(toContentBlocks([{ type: 'text', text: 'x' }])).toEqual([{ type: 'text', text: 'x' }])
    expect(toContentBlocks(undefined)).toEqual([])
    expect(showsApp({})).toBe(true)
    expect(showsApp({ isError: true })).toBe(false)
    expect(showsApp({ isError: true, structuredContent: { why: 'x' } })).toBe(true)
    expect(isOwnServer('codekin_canvas')).toBe(true)
  })

  it('takes the first HTML document from a resource read, text or blob, with its CSP', () => {
    expect(appDocument({ contents: [
      { mimeType: 'application/json', text: '{}' },
      { mimeType: 'text/html;profile=mcp-app', text: '<p>a</p>', _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] } } } },
    ] })).toEqual({ html: '<p>a</p>', csp: { connectDomains: ['https://api.example.com'] } })
    expect(appDocument({ contents: [{ blob: Buffer.from('<p>b</p>').toString('base64') }] })).toEqual({ html: '<p>b</p>' })
    expect(appDocument({ contents: [{ mimeType: 'text/html', text: 'x'.repeat(MAX_APP_HTML + 1) }] })).toBeNull()
    expect(appDocument(null)).toBeNull()
  })

  it("finds a Claude tool and its UI in mcp_status, never Codekin's own servers", () => {
    const status = { mcpServers: [
      { name: 'codekin_canvas', tools: [{ name: 'canvas_show', _meta: { ui: { resourceUri: 'ui://x' } } }] },
      { name: 'latency', tools: [{ name: 'plain' }, { name: 'latency_report', _meta: { ui: { resourceUri: 'ui://latency/report.html' } } }] },
    ] }
    expect(findClaudeAppTool(status, 'mcp__latency__latency_report')).toEqual({ server: 'latency', tool: 'latency_report', resourceUri: 'ui://latency/report.html' })
    expect(findClaudeAppTool(status, 'mcp__latency__plain')).toBeNull()
    expect(findClaudeAppTool(status, 'mcp__codekin_canvas__canvas_show')).toBeNull()
    expect(findClaudeAppTool({}, 'mcp__latency__latency_report')).toBeNull()
  })
})
