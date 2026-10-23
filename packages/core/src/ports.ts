import type { JsonValue, Operation } from '@connector-hub/spec'

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  headers: Record<string, string>
  body?: string
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
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
  /** Reads the declared input of a sink: the key fields plus the declared fields. */
  read(query: { bindingId: string; entity: string; fields: string[] }): Promise<Row[]>
  /** Runs `fn` in one host transaction. Operations and cursors commit together. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  apply(operations: Operation[], tx: Tx): Promise<void>
  saveCursor(bindingId: string, source: string, cursor: JsonValue, tx: Tx): Promise<void>
  /** Merges `rows` into the sink's snapshot. Keys not in `rows` keep their saved values. */
  saveRemote(bindingId: string, sink: string, rows: Map<string, Row>, tx: Tx): Promise<void>
  /** Optional shared rate budget per plugin. Resolves when a request may be sent. */
  budget?: { take(plugin: string): Promise<void> }
  clock?: { now(): Date }
}
