/** Local Bridge client shared by the DSH browser tools. */

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import WebSocket from 'ws'
import type { Config, ResolvedConfig } from './types.js'
import { bridgeRecovery } from './diagnostics.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 17318
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_EXTENSION_READY_TIMEOUT_MS = 6_000
const DEFAULT_TOKEN_FILE = join(homedir(), '.pi', 'agent', 'pi-control-chrome.token')
const BRIDGE_WAIT_ATTEMPTS = 30
const BRIDGE_WAIT_DELAY_MS = 100
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

type PendingEntry = {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
  readonly socket: WebSocket
}

type BridgeResponse = {
  readonly type?: string
  readonly id?: string
  readonly result?: unknown
  readonly error?: { readonly code?: string; readonly message?: string }
}

/** Resolve and validate deployment settings without reading credentials. */
export function resolveConfig(config: Config): ResolvedConfig {
  const bridgeHost = config.bridgeHost ?? DEFAULT_HOST
  const bridgePort = config.bridgePort ?? DEFAULT_PORT
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const extensionReadyTimeoutMs = config.extensionReadyTimeoutMs ?? DEFAULT_EXTENSION_READY_TIMEOUT_MS
  if (!LOOPBACK_HOSTS.has(bridgeHost)) throw new Error(`control-chrome bridgeHost must be loopback: ${bridgeHost}`)
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65_535) {
    throw new Error(`control-chrome bridgePort must be an integer from 1 to 65535: ${bridgePort}`)
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error(`control-chrome requestTimeoutMs must be positive: ${requestTimeoutMs}`)
  }
  if (!Number.isFinite(extensionReadyTimeoutMs) || extensionReadyTimeoutMs < 0) {
    throw new Error(`control-chrome extensionReadyTimeoutMs must be a non-negative finite number: ${extensionReadyTimeoutMs}`)
  }
  return {
    bridgeHost,
    bridgePort,
    tokenFile: config.tokenFile ?? DEFAULT_TOKEN_FILE,
    autoStartBridge: config.autoStartBridge ?? true,
    requestTimeoutMs,
    extensionReadyTimeoutMs,
    lazyTools: config.lazyTools ?? true,
    ...(config.bridgeScript === undefined ? {} : { bridgeScript: config.bridgeScript }),
  }
}

function authority(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

function bridgeOrigin(config: ResolvedConfig): string {
  return `http://${authority(config.bridgeHost, config.bridgePort)}`
}

function connectionKey(config: ResolvedConfig): string {
  return `${authority(config.bridgeHost, config.bridgePort)}|${config.tokenFile}`
}

function bridgeWebSocket(config: ResolvedConfig, token: string): string {
  return `ws://${authority(config.bridgeHost, config.bridgePort)}/ws?role=pi&token=${encodeURIComponent(token)}`
}

async function localJsonRequest(config: ResolvedConfig, path: string, timeoutMs: number): Promise<{ status: number; value: unknown }> {
  const response = await fetch(`${bridgeOrigin(config)}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  const value: unknown = await response.json()
  return { status: response.status, value }
}

function isHealthyResponse(response: { status: number; value: unknown }): boolean {
  return response.status === 200
    && typeof response.value === 'object'
    && response.value !== null
    && (response.value as { ok?: unknown }).ok === true
}

function errorMessage(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(`${fallback}: ${String(error)}`)
}

function healthInstanceId(health: Record<string, unknown>): string | undefined {
  return typeof health.instanceId === 'string' && health.instanceId.length > 0 ? health.instanceId : undefined
}

function lifecycleError(code: string, message: string): Error & { readonly code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string }
  error.code = code
  return error
}

/**
 * Connect to, and when configured start, one loopback pi-control-chrome Bridge.
 * The Bridge process is deliberately left alive when this client stops so Pi
 * and DSH sessions can reuse the same browser connection.
 */
export class BrowserBridgeClient {
  private socket: WebSocket | undefined
  private socketKey: string | undefined
  private connecting: Promise<void> | undefined
  private restarting: Promise<Record<string, unknown>> | undefined
  private readonly starting = new Map<string, Promise<Record<string, unknown>>>()
  private lifecycle = 0
  private readonly pending = new Map<string, PendingEntry>()
  private readonly resolveConfig: () => ResolvedConfig

  /** @param resolveSettings - returns the current settings section. */
  constructor(resolveSettings: () => ResolvedConfig) {
    this.resolveConfig = resolveSettings
  }

  /** Start or reuse the Bridge and establish the DSH-side websocket. */
  async start(): Promise<void> {
    await this.connect()
  }

  /** Stop this client connection without stopping the reusable Bridge process. */
  async stop(): Promise<void> {
    this.lifecycle += 1
    this.rejectPending(new Error('DSH browser Bridge client stopped'))
    const socket = this.socket
    this.socket = undefined
    this.socketKey = undefined
    socket?.close()
    const connecting = this.connecting
    const starting = [...this.starting.values()]
    if (connecting !== undefined) await connecting.catch(() => {})
    await Promise.all(starting.map(promise => promise.catch(() => {})))
  }

  /** Read the local Bridge health document. */
  async health(): Promise<Record<string, unknown>> {
    return this.readHealth(this.resolveConfig())
  }

  /**
   * Restart a compatible Bridge through the local-user cooperative control
   * protocol, or start it when the configured port is offline.
   * @returns the new Bridge health document and lifecycle result.
   */
  async restart(): Promise<Record<string, unknown>> {
    if (this.restarting !== undefined) return this.restarting
    const lifecycle = this.lifecycle
    this.restarting = this.restartBridge(lifecycle).finally(() => {
      this.restarting = undefined
    })
    return this.restarting
  }

  /** Send one browser method request and preserve caller cancellation locally. */
  async request(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error(`Browser request aborted: ${method}`)
    await this.connect()
    const config = this.resolveConfig()
    if (this.socketKey !== connectionKey(config)) {
      await this.connect()
    }
    if (signal?.aborted) throw new Error(`Browser request aborted: ${method}`)
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) throw new Error('Browser Bridge is not connected')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(new Error(`Browser request timed out: ${method}`))
      }, config.requestTimeoutMs)
      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`Browser request aborted: ${method}`))
      }
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        ...(signal === undefined ? {} : { signal }),
        onAbort,
        socket,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        socket.send(JSON.stringify({ type: 'request', id, method, params }))
      } catch (error) {
        this.settlePending(id, errorMessage(error, 'Browser request failed'))
      }
    })
  }

  private async connect(): Promise<void> {
    const config = this.resolveConfig()
    const targetKey = connectionKey(config)
    if (this.socket?.readyState === WebSocket.OPEN && this.socketKey === targetKey) return
    if (this.socket !== undefined && this.socketKey !== targetKey) {
      this.rejectPending(new Error('Browser Bridge settings changed; reconnecting'))
      this.socket.close()
      this.socket = undefined
      this.socketKey = undefined
    }
    if (this.connecting !== undefined) return this.connecting
    const lifecycle = this.lifecycle
    const attempt = (async () => {
      await this.ensureBridgeProcess(config)
      const pairing = await localJsonRequest(config, '/pair', 2_000)
      if (pairing.status !== 200 || typeof pairing.value !== 'object' || pairing.value === null) {
        throw new Error(`Browser Bridge pairing failed: HTTP ${pairing.status}`)
      }
      const token = (pairing.value as { token?: unknown }).token
      if (typeof token !== 'string' || token.length === 0) throw new Error('Browser Bridge pairing response did not contain a token')
      await this.openSocket(config, token, lifecycle)
    })()
    const tracked = attempt.finally(() => {
      if (this.connecting === tracked) this.connecting = undefined
    })
    this.connecting = tracked
    return tracked
  }

  private async openSocket(config: ResolvedConfig, token: string, lifecycle: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(bridgeWebSocket(config, token))
      if (lifecycle !== this.lifecycle) {
        socket.close()
        reject(new Error('DSH browser Bridge client stopped'))
        return
      }
      let settled = false
      const timeout = setTimeout(() => {
        socket.close()
        if (!settled) {
          settled = true
          reject(new Error('Timed out connecting to the browser Bridge'))
        }
      }, 5_000)
      this.socket = socket
      this.socketKey = connectionKey(config)
      socket.once('open', () => {
        clearTimeout(timeout)
        if (lifecycle !== this.lifecycle) {
          settled = true
          socket.close()
          reject(new Error('DSH browser Bridge client stopped'))
          return
        }
        settled = true
        resolve()
      })
      socket.once('close', () => {
        if (this.socket === socket) {
          this.socket = undefined
          this.socketKey = undefined
          this.rejectPendingForSocket(socket, new Error('Browser Bridge disconnected'))
        }
        if (!settled) {
          clearTimeout(timeout)
          settled = true
          reject(new Error('Browser Bridge closed before connecting'))
        }
      })
      socket.on('error', error => {
        if (!settled) {
          clearTimeout(timeout)
          settled = true
          reject(errorMessage(error, 'Browser Bridge websocket failed'))
          return
        }
        if (this.socket === socket) this.rejectPendingForSocket(socket, errorMessage(error, 'Browser Bridge websocket failed'))
      })
      socket.on('message', raw => this.handleMessage(raw.toString(), socket))
    })
  }

  private async restartBridge(lifecycle: number): Promise<Record<string, unknown>> {
    const config = this.resolveConfig()
    const assertActive = () => {
      if (lifecycle !== this.lifecycle) throw new Error('DSH browser Bridge client stopped')
    }
    let health: Record<string, unknown>
    try {
      health = await this.readHealth(config)
    } catch {
      if (!config.autoStartBridge) throw lifecycleError('BRIDGE_OFFLINE', 'Browser Bridge is offline and autoStartBridge is disabled')
      health = await this.ensureBridgeProcess(config)
      assertActive()
      return { ok: true, restarted: true, recovery: 'started', bridgeHealth: health }
    }
    assertActive()
    const instanceId = healthInstanceId(health)
    if (instanceId === undefined || !bridgeRecovery(health).available) {
      throw lifecycleError('BRIDGE_RESTART_UNSUPPORTED', 'This Bridge does not expose local-user cooperative restart capabilities')
    }

    const control = await this.request('bridge_restart', {
      expectedInstanceId: instanceId,
      requester: 'dsh',
    })
    assertActive()
    await this.waitForBridgeOffline(config)
    assertActive()
    await this.startBridgeProcess(config)
    assertActive()
    const next = await this.waitForHealth(config)
    assertActive()
    if (healthInstanceId(next) === instanceId) {
      throw lifecycleError('BRIDGE_INSTANCE_CHANGED', 'The restarted Bridge reused the previous instance id')
    }
    return {
      ok: true,
      restarted: true,
      recovery: 'cooperative_restart',
      previousInstanceId: instanceId,
      control,
      bridgeHealth: next,
    }
  }

  private async readHealth(config: ResolvedConfig): Promise<Record<string, unknown>> {
    const response = await localJsonRequest(config, '/health', 1_500)
    if (!isHealthyResponse(response)) throw new Error(`Browser Bridge health failed: HTTP ${response.status}`)
    return response.value as Record<string, unknown>
  }

  private async waitForHealth(config: ResolvedConfig): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < BRIDGE_WAIT_ATTEMPTS; attempt += 1) {
      try {
        return await this.readHealth(config)
      } catch {
        await new Promise<void>(resolve => setTimeout(resolve, BRIDGE_WAIT_DELAY_MS))
      }
    }
    throw new Error(`Timed out starting the browser Bridge on ${config.bridgeHost}:${config.bridgePort}`)
  }

  private async waitForBridgeOffline(config: ResolvedConfig): Promise<void> {
    for (let attempt = 0; attempt < BRIDGE_WAIT_ATTEMPTS; attempt += 1) {
      if (!(await this.isHealthy(config))) return
      await new Promise<void>(resolve => setTimeout(resolve, BRIDGE_WAIT_DELAY_MS))
    }
    throw new Error(`Timed out stopping the browser Bridge on ${config.bridgeHost}:${config.bridgePort}`)
  }

  private async ensureBridgeProcess(config: ResolvedConfig): Promise<Record<string, unknown>> {
    const key = authority(config.bridgeHost, config.bridgePort)
    const existing = this.starting.get(key)
    if (existing !== undefined) return existing
    const starting = (async () => {
      try {
        return await this.readHealth(config)
      } catch {
        if (!config.autoStartBridge) throw new Error('Browser Bridge is offline and autoStartBridge is disabled')
        await this.startBridgeProcess(config)
        return this.waitForHealth(config)
      }
    })().finally(() => {
      if (this.starting.get(key) === starting) this.starting.delete(key)
    })
    this.starting.set(key, starting)
    return starting
  }

  private async startBridgeProcess(config: ResolvedConfig): Promise<void> {
    const bridgeScript = this.resolveBridgeScript(config)
    const child = spawn(process.execPath, [
      bridgeScript,
      '--port', String(config.bridgePort),
      '--token-file', config.tokenFile,
      '--started-by', 'dsh',
    ], {
      stdio: 'ignore',
      windowsHide: true,
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', error => reject(errorMessage(error, 'Cannot start the browser Bridge')))
      child.unref()
    })
  }

  private resolveBridgeScript(config: ResolvedConfig): string {
    if (config.bridgeScript !== undefined) {
      const script = resolvePath(config.bridgeScript)
      if (!existsSync(script)) throw new Error(`Configured browser Bridge script does not exist: ${script}`)
      return script
    }
    try {
      const require = createRequire(import.meta.url)
      return require.resolve('pi-control-chrome/bridge/server.mjs')
    } catch (error) {
      throw errorMessage(error, 'Cannot locate pi-control-chrome Bridge')
    }
  }

  private async isHealthy(config: ResolvedConfig): Promise<boolean> {
    try {
      return isHealthyResponse(await localJsonRequest(config, '/health', 700))
    } catch {
      return false
    }
  }

  private handleMessage(raw: string, source: WebSocket): void {
    if (this.socket !== source) return;
    let message: BridgeResponse
    try {
      message = JSON.parse(raw) as BridgeResponse
    } catch {
      return
    }
    if (message.type !== 'response' || typeof message.id !== 'string') return
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    if (message.error !== undefined) {
      const code = message.error.code
      const error = new Error(message.error.message ?? code ?? 'Browser request failed') as Error & { code?: string }
      if (code !== undefined) error.code = code
      this.settlePending(message.id, error)
      return
    }
    this.settlePending(message.id, undefined, message.result)
  }

  private settlePending(id: string, error?: Error, value?: unknown): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (entry.signal !== undefined && entry.onAbort !== undefined) entry.signal.removeEventListener('abort', entry.onAbort)
    if (error !== undefined) entry.reject(error)
    else entry.resolve(value)
  }

  private rejectPending(error: Error): void {
    for (const id of this.pending.keys()) this.settlePending(id, error)
  }

  private rejectPendingForSocket(socket: WebSocket, error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      if (entry.socket === socket) this.settlePending(id, error)
    }
  }
}
