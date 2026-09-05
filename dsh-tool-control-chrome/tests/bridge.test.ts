import { expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { BrowserBridgeClient, resolveConfig } from '../src/bridge.js'

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not expose a port')
  return address.port
}

function json(response: import('node:http').ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  response.end(body)
}

it('resolveConfig rejects non-loopback Bridge hosts and accepts defaults', () => {
  const defaults = resolveConfig({})
  expect(defaults.bridgeHost).toBe('127.0.0.1')
  expect(defaults.bridgePort).toBe(17318)
  expect(defaults.autoStartBridge).toBe(true)
  expect(defaults.extensionReadyTimeoutMs).toBe(6_000)
  expect(defaults.lazyTools).toBe(true)
  expect(() => resolveConfig({ extensionReadyTimeoutMs: -1 })).toThrow(/extensionReadyTimeoutMs/)
  expect(() => resolveConfig({ bridgeHost: '192.0.2.10' })).toThrow(/must be loopback/)
})

it('rejects the old launcher-owner restart protocol', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/health') return json(response, 200, {
      ok: true,
      protocol: 1,
      instanceId: 'legacy-instance',
      managedBy: 'dsh',
      capabilities: { cooperativeRestart: true },
      restart: { available: true, managedBy: 'dsh' },
    })
    return json(response, 404, { ok: false })
  })
  const port = await listen(server)
  const client = new BrowserBridgeClient(() => resolveConfig({ bridgePort: port, autoStartBridge: false }))
  try {
    await expect(client.restart()).rejects.toMatchObject({ code: 'BRIDGE_RESTART_UNSUPPORTED' })
  } finally {
    await client.stop()
    server.close()
    await once(server, 'close')
  }
})

it('BrowserBridgeClient pairs, routes requests, reads health, and observes abort', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/health') return json(response, 200, { ok: true, protocol: 1, extensionConnected: true })
    if (request.url === '/pair') return json(response, 200, { ok: true, protocol: 1, token: 'test-token' })
    return json(response, 404, { ok: false })
  })
  const port = await listen(server)
  const sockets = new Set<WebSocket>()
  const websocketServer = new WebSocketServer({ server, path: '/ws' })
  websocketServer.on('connection', socket => {
    sockets.add(socket)
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as { id: string; method: string; params: Record<string, unknown> }
      if (message.method === 'wait_forever') return
      if (message.method === 'malformed') {
        socket.send(JSON.stringify({ type: 'response', id: message.id }))
        return
      }
      socket.send(JSON.stringify({ type: 'response', id: message.id, result: { method: message.method, params: message.params } }))
    })
    socket.on('close', () => sockets.delete(socket))
  })
  const client = new BrowserBridgeClient(() => resolveConfig({ bridgePort: port, autoStartBridge: false }))
  try {
    await client.start()
    expect(await client.health()).toEqual({ ok: true, protocol: 1, extensionConnected: true })
    expect(await client.request('status', { sessionId: 'session-test' })).toEqual({
      method: 'status',
      params: { sessionId: 'session-test' },
    })
    await expect(client.request('malformed', {})).rejects.toThrow(/without exactly one result or error/)
    const controller = new AbortController()
    const pending = client.request('wait_forever', {}, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(/aborted/)

    const disconnectPending = client.request('wait_forever', {})
    const socket = [...sockets][0]
    if (socket === undefined) throw new Error('test Bridge socket was not registered')
    socket.close()
    await expect(disconnectPending).rejects.toMatchObject({
      code: 'BROWSER_BRIDGE_DISCONNECTED',
      details: { actionState: 'not_completed', retryable: true, inspectFirst: false },
    })
  } finally {
    await client.stop()
    for (const socket of sockets) socket.close()
    websocketServer.close()
    server.close()
    await once(server, 'close')
  }
})
