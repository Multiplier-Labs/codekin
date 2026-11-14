/**
 * The Canvas MCP server (docs/CANVAS-SPEC.md §1): lets the agent in a
 * Codekin session show output in the session's Canvas, beside the chat.
 *
 * Spawned over stdio by the session's CLI (Claude, Codex or Grok; see
 * canvas-mcp-config.ts). It reads CODEKIN_PORT, CODEKIN_SESSION_ID and the
 * session-scoped CODEKIN_AUTH_TOKEN from its environment and calls the local
 * Canvas routes (canvas-routes.ts), which only reach that one session.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { pathToFileURL } from 'url'
import { z } from 'zod'

export const CANVAS_MCP_SERVER_NAME = 'codekin_canvas'
export const CANVAS_MCP_TOOLS = ['canvas_show', 'canvas_update', 'canvas_list'] as const

export interface CanvasApi {
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>
}

/** HTTP client for the local Canvas routes, from the env Codekin injects into sessions. */
export function canvasApiFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): CanvasApi {
  const port = env.CODEKIN_PORT
  const token = env.CODEKIN_AUTH_TOKEN || env.CODEKIN_TOKEN
  const sessionId = env.CODEKIN_SESSION_ID
  if (!port || !token || !sessionId) {
    throw new Error('CODEKIN_PORT, CODEKIN_SESSION_ID and CODEKIN_AUTH_TOKEN must be set (Codekin injects them into agent sessions)')
  }
  const base = `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/canvas`
  return {
    async request(method, path, body) {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const text = await res.text()
      let parsed: unknown = text
      try { parsed = JSON.parse(text) } catch { /* plain text */ }
      if (!res.ok) {
        const message = typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : `Canvas request failed (${res.status})`
        throw new Error(message)
      }
      return parsed
    },
  }
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

async function run(call: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await call() }] }
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
}

interface ItemReply { item: { id: string; title: string; kind: string; revision: number } }

const KINDS = ['markdown', 'table', 'diagram', 'image', 'chart', 'html'] as const

const nodesSchema = z.record(z.string(), z.object({
  file: z.string().optional().describe('Repository-relative file the node stands for'),
  line: z.number().int().positive().optional(),
  description: z.string().optional().describe('One or two sentences shown when the user clicks the node'),
})).optional().describe('Diagram only: Mermaid node id → what it refers to, so the user can click a node to see its file')

export function buildCanvasMcpServer(api: CanvasApi): McpServer {
  const server = new McpServer(
    { name: CANVAS_MCP_SERVER_NAME, version: '1.0.0' },
    {
      instructions: [
        'Codekin shows a Canvas beside this chat. Put substantial output the user should read or keep there instead of pasting it into the reply:',
        'reports and explanations (markdown), tabular results (table: CSV, TSV or JSON rows), architecture or flow diagrams (diagram: Mermaid), images such as screenshots (image: a file path),',
        'interactive charts (chart: a Vega-Lite JSON spec with its data inline as data.values; add a selection param so the user can select points or ranges), and small interactive pages (html: one self-contained file with inline scripts and styles; it has no network access).',
        'Give each item a short title, mention it in one line of your reply, and revise it with canvas_update rather than creating a near-duplicate.',
      ].join(' '),
    },
  )

  server.registerTool(
    'canvas_show',
    {
      description: 'Show new output in the Canvas beside the chat: a Markdown document, a table, a Mermaid diagram, an image file, a Vega-Lite chart (data inline), or a self-contained HTML page (no network). Returns the item id for canvas_update.',
      inputSchema: {
        title: z.string().describe('Short title, e.g. "Benchmark results"'),
        kind: z.enum(KINDS),
        content: z.string().optional().describe('Inline text: Markdown, table rows (see format), Mermaid source, a Vega-Lite JSON spec, or an HTML page. Omit when passing path.'),
        path: z.string().optional().describe('A file in the working directory instead of content. Required for images (png, jpg, gif, webp, svg).'),
        format: z.enum(['csv', 'tsv', 'json']).optional().describe('Table only: how inline content is encoded (default csv; json is an array of objects)'),
        nodes: nodesSchema,
      },
    },
    (args) => run(async () => {
      const { item } = await api.request('POST', '/items', args) as ItemReply
      return `Shown in Canvas as "${item.title}" (${item.kind}, id ${item.id}, revision ${item.revision}). Revise it with canvas_update and this id.`
    }),
  )

  server.registerTool(
    'canvas_update',
    {
      description: 'Revise a Canvas item you showed earlier: new content (or path) and optionally a new title. Earlier revisions stay available to the user.',
      inputSchema: {
        itemId: z.string().describe('The id canvas_show returned'),
        title: z.string().optional(),
        content: z.string().optional(),
        path: z.string().optional(),
        format: z.enum(['csv', 'tsv', 'json']).optional(),
        nodes: nodesSchema,
      },
    },
    ({ itemId, ...rest }) => run(async () => {
      const { item } = await api.request('POST', `/items/${encodeURIComponent(itemId)}`, rest) as ItemReply
      return `Updated "${item.title}" in Canvas (now revision ${item.revision}).`
    }),
  )

  server.registerTool(
    'canvas_list',
    { description: 'List the items in this session\'s Canvas with their ids, kinds and latest revisions.', inputSchema: {} },
    () => run(async () => {
      const { items } = await api.request('GET', '/items') as { items: ItemReply['item'][] }
      return items.length
        ? items.map(i => `${i.id}  ${i.kind}  rev ${i.revision}  ${i.title}`).join('\n')
        : 'The Canvas is empty.'
    }),
  )

  return server
}

// Started directly (node server/dist/canvas-mcp-server.js): serve over stdio.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const server = buildCanvasMcpServer(canvasApiFromEnv())
  server.connect(new StdioServerTransport()).catch((err: unknown) => {
    console.error('[canvas-mcp] Failed to start:', err)
    process.exit(1)
  })
}
