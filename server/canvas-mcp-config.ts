/**
 * How each harness gets the Canvas MCP server (canvas-mcp-server.ts) for a
 * session: Claude through `--mcp-config` with its tools pre-approved, Codex
 * through `-c mcp_servers.…` overrides on `codex app-server`, Grok through
 * ACP `session/new` `mcpServers`. The server only writes to its own
 * session's Canvas, so its tools need no approval prompt.
 *
 * When the compiled server is absent (a source checkout that never built
 * server/dist) nothing is added and sessions run as before.
 */

import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { CANVAS_MCP_SERVER_NAME, CANVAS_MCP_TOOLS } from './canvas-mcp-server.js'

/** Environment the server needs; forwarded explicitly where a harness filters env. */
export const CANVAS_MCP_ENV_KEYS = ['CODEKIN_PORT', 'CODEKIN_SESSION_ID', 'CODEKIN_AUTH_TOKEN'] as const

let warned = false

/** Path of the compiled server next to this module, or null when it isn't built. */
export function canvasMcpServerPath(here = dirname(fileURLToPath(import.meta.url))): string | null {
  const path = join(here, 'canvas-mcp-server.js')
  if (existsSync(path)) return path
  if (!warned) {
    warned = true
    console.warn(`[canvas] MCP server not found at ${path} — agents can't publish to Canvas until server/dist is built`)
  }
  return null
}

/** Claude's tool names for the server (mcp__<server>__<tool>), pre-approved via --allowedTools. */
export const CANVAS_CLAUDE_TOOLS = CANVAS_MCP_TOOLS.map(t => `mcp__${CANVAS_MCP_SERVER_NAME}__${t}`)

/** Whether a tool name (as any harness reports it) is one of the Canvas server's tools. */
export function isCanvasMcpTool(name: string): boolean {
  return CANVAS_CLAUDE_TOOLS.includes(name) ||
    CANVAS_MCP_TOOLS.some(t => name === `${CANVAS_MCP_SERVER_NAME}.${t}` || name === `${CANVAS_MCP_SERVER_NAME}__${t}`)
}

/** `--mcp-config` JSON for Claude; the server inherits the CLI's environment. */
export function claudeCanvasMcpConfig(serverPath: string): string {
  return JSON.stringify({ mcpServers: { [CANVAS_MCP_SERVER_NAME]: { command: process.execPath, args: [serverPath] } } })
}

/** `-c` overrides that add the server to `codex app-server`, forwarding the session env by name, tools pre-approved. */
export function codexCanvasMcpArgs(serverPath: string): string[] {
  const key = `mcp_servers.${CANVAS_MCP_SERVER_NAME}`
  return [
    '-c', `${key}.command=${JSON.stringify(process.execPath)}`,
    '-c', `${key}.args=[${JSON.stringify(serverPath)}]`,
    '-c', `${key}.env_vars=[${CANVAS_MCP_ENV_KEYS.map(k => JSON.stringify(k)).join(',')}]`,
    // Its tools only write to this session's Canvas: no approval prompt.
    '-c', `${key}.default_tools_approval_mode="approve"`,
  ]
}

/** An ACP stdio MCP server entry (session/new `mcpServers`). */
export interface AcpStdioMcpServer {
  name: string
  command: string
  args: string[]
  env: Array<{ name: string; value: string }>
}

/** Grok's `mcpServers` entry; ACP passes env explicitly. */
export function acpCanvasMcpServer(serverPath: string, env: Record<string, string>): AcpStdioMcpServer {
  return {
    name: CANVAS_MCP_SERVER_NAME,
    command: process.execPath,
    args: [serverPath],
    env: CANVAS_MCP_ENV_KEYS.filter(k => env[k]).map(k => ({ name: k, value: env[k] })),
  }
}
