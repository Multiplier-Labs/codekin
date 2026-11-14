/**
 * MCP Apps (docs/CANVAS-SPEC.md §8): a tool whose definition names a UI
 * resource (`_meta.ui.resourceUri`) can be shown as an interactive view.
 * The provider adapters detect such calls, read the resource through their
 * CLI (Claude Code: `mcp_status` + `mcp_read_resource`; Codex app-server:
 * `mcpAppUi` + `mcpServer/resource/read`) and emit one `McpAppCall`, which
 * the session stores as a Canvas item. Nothing here talks to MCP servers
 * directly: the CLIs own those connections.
 */

/**
 * Whether a finished call is worth an app view: not when it failed without
 * data (a denied permission, a crash), where the app would only show an
 * empty shell. A failed call that still returns structured data is shown.
 */
export function showsApp(result: { isError?: boolean; structuredContent?: unknown }): boolean {
  return !result.isError || result.structuredContent !== undefined
}

/** Codekin's own Canvas server: never shown as an app. */
const OWN_SERVERS = new Set(['codekin_canvas', 'codekin'])

/** One finished tool call with a UI: everything needed to render it later without re-running it. */
export interface McpAppCall {
  server: string
  tool: string
  toolInput: Record<string, unknown>
  /** The tool's CallToolResult as the app expects it. */
  result: { content: unknown[]; structuredContent?: unknown; _meta?: unknown; isError?: boolean }
  resourceUri: string
  html: string
  /** `_meta.ui.csp` / `_meta.ui.permissions` from the resource, passed to the sandbox as declared. */
  csp?: unknown
  permissions?: unknown
}

/** The largest app document Codekin stores (the whole item is capped at 1 MiB). */
export const MAX_APP_HTML = 900 * 1024

export function isOwnServer(server: string): boolean {
  return OWN_SERVERS.has(server)
}

/** The UI resource URI a tool definition declares, current or legacy key. */
export function toolUiResourceUri(meta: unknown): string | null {
  if (typeof meta !== 'object' || meta === null) return null
  const m = meta as { ui?: { resourceUri?: unknown }; 'ui/resourceUri'?: unknown }
  const uri = m.ui?.resourceUri ?? m['ui/resourceUri']
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : null
}

/** Claude Code's tool name for an MCP tool: mcp__<server>__<tool>, non-identifier characters as _. */
export function claudeMcpToolName(server: string, tool: string): string {
  const norm = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
  return `mcp__${norm(server)}__${norm(tool)}`
}

/** A tool_result block's content as MCP content blocks. */
export function toContentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return []
}

/**
 * The app document from a resources/read result: the first HTML content,
 * text or base64 blob, with its declared CSP and permissions. Null when there
 * is none, or it is too large.
 */
export function appDocument(read: unknown): { html: string; csp?: unknown; permissions?: unknown } | null {
  const contents = (read as { contents?: unknown } | null)?.contents
  if (!Array.isArray(contents)) return null
  for (const c of contents as Array<{ mimeType?: unknown; text?: unknown; blob?: unknown; _meta?: { ui?: { csp?: unknown; permissions?: unknown } } }>) {
    if (typeof c.mimeType === 'string' && !c.mimeType.startsWith('text/html')) continue
    const html = typeof c.text === 'string' ? c.text : typeof c.blob === 'string' ? Buffer.from(c.blob, 'base64').toString('utf-8') : null
    if (html === null) continue
    if (Buffer.byteLength(html) > MAX_APP_HTML) return null
    const ui = c._meta?.ui
    return { html, ...(ui?.csp !== undefined ? { csp: ui.csp } : {}), ...(ui?.permissions !== undefined ? { permissions: ui.permissions } : {}) }
  }
  return null
}

/** Claude Code `mcp_status` → the server, tool and UI resource for a Claude tool name. */
export function findClaudeAppTool(status: unknown, toolName: string): { server: string; tool: string; resourceUri: string } | null {
  const servers = (status as { mcpServers?: unknown } | null)?.mcpServers
  if (!Array.isArray(servers)) return null
  for (const s of servers as Array<{ name?: unknown; tools?: unknown }>) {
    if (typeof s.name !== 'string' || isOwnServer(s.name) || !Array.isArray(s.tools)) continue
    for (const t of s.tools as Array<{ name?: unknown; _meta?: unknown }>) {
      if (typeof t.name !== 'string' || claudeMcpToolName(s.name, t.name) !== toolName) continue
      const resourceUri = toolUiResourceUri(t._meta)
      return resourceUri ? { server: s.name, tool: t.name, resourceUri } : null
    }
  }
  return null
}
