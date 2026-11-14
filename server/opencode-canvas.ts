/**
 * Canvas for OpenCode sessions (docs/CANVAS-SPEC.md §3).
 *
 * Claude, Codex and Grok run one process per session, so each gets its own
 * Canvas MCP server carrying that session's id and token. OpenCode runs one
 * shared `opencode serve` for every session, so instead Codekin gives it
 * custom tools: a `canvas.ts` file in a Codekin-owned config directory
 * (OPENCODE_CONFIG_DIR), whose named exports become `canvas_show`,
 * `canvas_update` and `canvas_list`. OpenCode passes each call the calling
 * session's id; the tools send it to a local route, which maps it to the
 * Codekin session. That route accepts a token derived for this purpose only,
 * set in the OpenCode server's environment.
 *
 * Skipped (OpenCode sessions run without Canvas) when the user already sets
 * OPENCODE_CONFIG_DIR, or when zod can't be resolved for the tool file.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import path from 'path'

/** Token the OpenCode tools present; derived from the master token, never the token itself. */
export function openCodeCanvasToken(masterToken: string): string {
  return createHmac('sha256', masterToken).update('opencode-canvas').digest('hex')
}

export function verifyOpenCodeCanvasToken(masterToken: string, candidate: string | undefined): boolean {
  if (!masterToken || !candidate) return false
  const expected = Buffer.from(openCodeCanvasToken(masterToken))
  const got = Buffer.from(candidate)
  return got.length === expected.length && timingSafeEqual(got, expected)
}

/** Source of the OpenCode tool file; `zodUrl` is an importable URL for zod. */
export function openCodeCanvasToolSource(zodUrl: string): string {
  return `// Written by Codekin: Canvas tools for OpenCode sessions. Regenerated at startup; edits are lost.
import { z } from ${JSON.stringify(zodUrl)}

async function call(sessionID: string, method: string, suffix: string, body?: unknown): Promise<any> {
  const url = \`http://127.0.0.1:\${process.env.CODEKIN_PORT}/api/opencode-canvas/\${encodeURIComponent(sessionID)}/items\${suffix}\`
  const res = await fetch(url, {
    method,
    headers: { Authorization: \`Bearer \${process.env.CODEKIN_OPENCODE_CANVAS_TOKEN ?? ''}\`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = text
  try { data = JSON.parse(text) } catch { /* plain text */ }
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : \`Canvas request failed (\${res.status})\`)
  return data
}

const nodes = z.record(z.string(), z.object({
  file: z.string().optional().describe('Repository-relative file the node stands for'),
  line: z.number().int().positive().optional(),
  description: z.string().optional().describe('One or two sentences shown when the user clicks the node'),
})).optional().describe('Diagram only: Mermaid node id -> what it refers to')

export const show = {
  description: 'Show output in the Canvas beside the chat instead of pasting it into your reply: a Markdown report (markdown), table rows (table: CSV, TSV or JSON), a Mermaid diagram (diagram), or an image file (image, via path). Returns the item id for canvas_update.',
  args: {
    title: z.string().describe('Short title, e.g. "Benchmark results"'),
    kind: z.enum(['markdown', 'table', 'diagram', 'image']),
    content: z.string().optional().describe('Inline text: Markdown, table rows (see format), or Mermaid source. Omit when passing path.'),
    path: z.string().optional().describe('A file in the working directory instead of content. Required for images.'),
    format: z.enum(['csv', 'tsv', 'json']).optional().describe('Table only: how inline content is encoded (default csv)'),
    nodes,
  },
  async execute(args: Record<string, unknown>, context: { sessionID: string }) {
    const { item } = await call(context.sessionID, 'POST', '', args)
    return \`Shown in Canvas as "\${item.title}" (\${item.kind}, id \${item.id}, revision \${item.revision}). Revise it with canvas_update and this id.\`
  },
}

export const update = {
  description: 'Revise a Canvas item you showed earlier: new content (or path) and optionally a new title. Earlier revisions stay available to the user.',
  args: {
    itemId: z.string().describe('The id canvas_show returned'),
    title: z.string().optional(),
    content: z.string().optional(),
    path: z.string().optional(),
    format: z.enum(['csv', 'tsv', 'json']).optional(),
    nodes,
  },
  async execute(args: Record<string, unknown>, context: { sessionID: string }) {
    const { itemId, ...rest } = args
    const { item } = await call(context.sessionID, 'POST', '/' + encodeURIComponent(String(itemId)), rest)
    return \`Updated "\${item.title}" in Canvas (now revision \${item.revision}).\`
  },
}

export const list = {
  description: "List the items in this session's Canvas with their ids, kinds and latest revisions.",
  args: {},
  async execute(_args: Record<string, unknown>, context: { sessionID: string }) {
    const { items } = await call(context.sessionID, 'GET', '')
    return items.length ? items.map((i: any) => \`\${i.id}  \${i.kind}  rev \${i.revision}  \${i.title}\`).join('\\n') : 'The Canvas is empty.'
  },
}
`
}

/** An importable URL for zod, as the tool file sees it (null when it can't be found). */
export function zodModuleUrl(): string | null {
  try {
    return import.meta.resolve('zod')
  } catch {
    return null
  }
}

/**
 * Write the tool file and return the environment `opencode serve` needs for
 * it, or an empty object (with a log line) when OpenCode can't get Canvas.
 */
export function prepareOpenCodeCanvas(opts: {
  dataDir: string
  port: number
  masterToken: string
  env?: NodeJS.ProcessEnv
  zodUrl?: string | null
}): Record<string, string> {
  const env = opts.env ?? process.env
  if (env.OPENCODE_CONFIG_DIR) {
    console.log('[canvas] OPENCODE_CONFIG_DIR is set — OpenCode sessions run without Canvas tools')
    return {}
  }
  const zodUrl = opts.zodUrl === undefined ? zodModuleUrl() : opts.zodUrl
  if (!zodUrl || !opts.masterToken) {
    console.warn('[canvas] Cannot prepare Canvas tools for OpenCode (zod or auth token missing)')
    return {}
  }
  const dir = path.join(opts.dataDir, 'opencode')
  mkdirSync(path.join(dir, 'tool'), { recursive: true, mode: 0o700 })
  writeFileSync(path.join(dir, 'tool', 'canvas.ts'), openCodeCanvasToolSource(zodUrl), { mode: 0o600 })
  return {
    OPENCODE_CONFIG_DIR: dir,
    CODEKIN_PORT: String(opts.port),
    CODEKIN_OPENCODE_CANVAS_TOKEN: openCodeCanvasToken(opts.masterToken),
  }
}
