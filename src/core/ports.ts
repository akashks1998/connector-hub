import type { JsonValue, Operation } from '../spec/index.js'

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  headers: Record<string, string>
  body?: string
}

/** A request to the host's own API. `path` includes the query string and is relative to the API root. */
export interface TargetHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: string
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** An incoming webhook request as the host received it. */
export interface WebhookRequest {
  method: string
  /** The path under this plugin's webhook URL, e.g. `/sync`, without the query string. */
  path: string
  headers: Record<string, string>
  query?: Record<string, string>
  /** The body exactly as received; signatures are computed over it. */
  body: string
}

/** One configured connection of a plugin, e.g. one agency's Hostaway account. */
export interface Binding {
  id: string
  /** Non-secret config values declared by the plugin. */
  config: Record<string, JsonValue>
}

export type Row = Record<string, JsonValue>

export interface CachedToken {
  value: string
  /** When the engine stops using the token, already a little before it really expires. */
  expiresAt: Date
}

/**
 * Everything the engine needs from its host. The engine performs no I/O of its
 * own: it builds requests and operations, and the host sends and applies them.
 */
export interface HostPorts<Tx = unknown> {
  http: {
    /** Must enforce the timeout and body limit, and must not follow redirects. */
    send(request: HttpRequest, limits: { timeoutMs: number; maxBodyBytes: number }): Promise<HttpResponse>
  }
  /** Secret config values for a binding, as declared with `secret: true`. Values are redacted from error messages. */
  secrets: { get(bindingId: string): Promise<Record<string, string>> }
  /** Cache for access tokens obtained by auth presets. */
  tokens: {
    get(bindingId: string): Promise<CachedToken | null>
    put(bindingId: string, token: CachedToken | null): Promise<void>
  }
  state: {
    getCursor(bindingId: string, source: string): Promise<JsonValue | null>
    /** Last values successfully written by a sink, keyed by record key. */
    getRemote(bindingId: string, sink: string): Promise<Map<string, Row>>
  }
  /**
   * The host's own API, for plugins that read and write through it (`read`, `call`). The host
   * adds the base URL and this install's credentials, and must keep `path` under its API root.
   */
  target?: { send(request: TargetHttpRequest, limits: { timeoutMs: number; maxBodyBytes: number }): Promise<HttpResponse> }
  /** Reads the declared input of a sink: the key fields plus the declared fields. */
  read(query: { bindingId: string; entity: string; fields: string[] }): Promise<Row[]>
  /** Runs `fn` in one host transaction. Operations and cursors commit together. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  apply(operations: Operation[], tx: Tx): Promise<void>
  saveCursor(bindingId: string, source: string, cursor: JsonValue, tx: Tx): Promise<void>
  /** Merges `rows` into the sink's snapshot: null removes a key, keys not in `rows` keep their saved values. */
  saveRemote(bindingId: string, sink: string, rows: Map<string, Row | null>, tx: Tx): Promise<void>
  /**
   * Incoming webhooks. `binding` finds the binding a request belongs to. The others are needed
   * only by webhooks that declare `dedupe_key` or `order`. `lock` runs its function while holding
   * a per-binding lock (an advisory lock, say), so two deliveries of one id cannot both pass the
   * dedupe and order checks; without it the host must serialise requests itself.
   */
  webhooks?: {
    binding(webhook: string, key: string): Promise<Binding | null>
    lock?<T>(bindingId: string, fn: () => Promise<T>): Promise<T>
    seen?(bindingId: string, webhook: string, key: string): Promise<boolean>
    remember?(bindingId: string, webhook: string, key: string): Promise<void>
    getMark?(bindingId: string, webhook: string): Promise<JsonValue | null>
    saveMark?(bindingId: string, webhook: string, value: JsonValue): Promise<void>
  }
  /** Optional shared rate budget. Resolves when a request may be sent; hosts may group bindings that share a provider account. */
  budget?: { take(plugin: string, bindingId: string): Promise<void> }
  clock?: { now(): Date }
}
