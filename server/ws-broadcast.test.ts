import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import { broadcastToAuthenticated } from './ws-broadcast.js'

describe('broadcastToAuthenticated', () => {
  it('sends only to open sockets in the authenticated set', () => {
    const sent: string[] = []
    const open = { readyState: WebSocket.OPEN, send: (d: string) => sent.push(`open:${d}`) }
    const closing = { readyState: WebSocket.CLOSING, send: (d: string) => sent.push(`closing:${d}`) }

    broadcastToAuthenticated([open, closing], { type: 'sessions_updated' })

    expect(sent).toEqual(['open:{"type":"sessions_updated"}'])
  })

  describe('over a real WebSocket server', () => {
    let server: Server
    let wss: WebSocketServer

    afterEach(async () => {
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
    })

    it('does not deliver a global approval prompt to a socket that has not authenticated', async () => {
      // Mirrors ws-server.ts: sockets join `authenticated` only after a valid auth frame.
      server = createServer()
      wss = new WebSocketServer({ server })
      const authenticated = new Set<WebSocket>()
      wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString()) as { type: string; token?: string }
          if (msg.type === 'auth' && msg.token === 'good') {
            authenticated.add(ws)
            ws.send(JSON.stringify({ type: 'connected' }))
          }
        })
        ws.on('close', () => authenticated.delete(ws))
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
      const { port } = server.address() as { port: number }

      const received = { authed: [] as string[], unauthed: [] as string[] }
      const connect = (bucket: string[]) => new Promise<WebSocket>((resolve) => {
        const c = new WebSocket(`ws://127.0.0.1:${port}`)
        c.on('message', (d) => bucket.push(d.toString()))
        c.on('open', () => resolve(c))
      })

      const authed = await connect(received.authed)
      const unauthed = await connect(received.unauthed)
      authed.send(JSON.stringify({ type: 'auth', token: 'good' }))
      await expect.poll(() => received.authed.length).toBe(1)
      expect(wss.clients.size).toBe(2)

      broadcastToAuthenticated(authenticated, {
        type: 'prompt',
        promptType: 'permission',
        toolName: 'Bash',
        toolInput: { command: 'cat ~/.ssh/id_ed25519' },
        requestId: 'r1',
        sessionId: 's1',
        sessionName: 'secret-session',
      })

      await expect.poll(() => received.authed.length).toBe(2)
      expect(received.authed[1]).toContain('"requestId":"r1"')
      // Give any stray frame time to arrive before asserting absence.
      await new Promise(r => setTimeout(r, 50))
      expect(received.unauthed).toEqual([])

      authed.close()
      unauthed.close()
    })
  })
})
