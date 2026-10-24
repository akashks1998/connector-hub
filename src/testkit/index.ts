import type { Binding, CachedToken, HostPorts, HttpRequest, HttpResponse, Row } from '../core/index.js'
import type { JsonValue, Operation } from '../spec/index.js'

export interface Fixture {
  request: { method?: HttpRequest['method']; url: string }
  response: { status?: number; headers?: Record<string, string>; body?: JsonValue | string }
}

/**
 * Replays recorded HTTP exchanges. Each fixture answers one request, matched on
 * method and full URL (query order ignored), in the order given.
 */
export function replayHttp(fixtures: Fixture[]): HostPorts['http'] & { pending(): Fixture[]; sent: HttpRequest[] } {
  const queue = [...fixtures]
  const sent: HttpRequest[] = []
  return {
    sent,
    pending: () => [...queue],
    async send(request) {
      sent.push(request)
      const i = queue.findIndex(
        (f) => (f.request.method ?? 'GET') === request.method && sameUrl(f.request.url, request.url),
      )
      if (i === -1) throw new Error(`no fixture for ${request.method} ${request.url}`)
      const [fixture] = queue.splice(i, 1)
      const { status = 200, headers = {}, body = '' } = fixture!.response
      return { status, headers, body: typeof body === 'string' ? body : JSON.stringify(body) } satisfies HttpResponse
    },
  }
}

function sameUrl(a: string, b: string): boolean {
  const ua = new URL(a)
  const ub = new URL(b)
  ua.searchParams.sort()
  ub.searchParams.sort()
  return ua.toString() === ub.toString()
}

interface MemoryTx {
  operations: Operation[]
  cursors: Map<string, JsonValue>
  remote: Map<string, Map<string, Row>>
}

export interface MemoryHostOptions {
  http: HostPorts['http']
  secrets?: Record<string, Record<string, string>>
  /** Rows returned to sinks, by entity. */
  rows?: Record<string, Row[]>
  now?: Date
  /** Make `apply` throw, to test that nothing commits. */
  failApply?: boolean
}

/** A complete in-memory host. Writes are staged per transaction and kept only on success. */
export function memoryHost(options: MemoryHostOptions) {
  const applied: Operation[] = []
  const cursors = new Map<string, JsonValue>()
  const remote = new Map<string, Map<string, Row>>()
  const tokens = new Map<string, CachedToken>()
  const rows = options.rows ?? {}

  const ports: HostPorts<MemoryTx> = {
    http: options.http,
    secrets: { get: async (id) => options.secrets?.[id] ?? {} },
    tokens: {
      get: async (id) => tokens.get(id) ?? null,
      put: async (id, token) => void (token ? tokens.set(id, token) : tokens.delete(id)),
    },
    state: {
      getCursor: async (id, source) => cursors.get(`${id}/${source}`) ?? null,
      getRemote: async (id, sink) => new Map(remote.get(`${id}/${sink}`) ?? []),
    },
    read: async ({ entity, fields }) =>
      (rows[entity] ?? []).map((r) => Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]!]))),
    async transaction(fn) {
      const tx: MemoryTx = { operations: [], cursors: new Map(), remote: new Map() }
      const result = await fn(tx)
      applied.push(...tx.operations)
      for (const [k, v] of tx.cursors) cursors.set(k, v)
      for (const [k, v] of tx.remote) remote.set(k, new Map([...(remote.get(k) ?? []), ...v]))
      return result
    },
    async apply(operations, tx) {
      if (options.failApply) throw new Error('apply failed')
      tx.operations.push(...operations)
    },
    async saveCursor(id, source, cursor, tx) {
      tx.cursors.set(`${id}/${source}`, cursor)
    },
    async saveRemote(id, sink, written, tx) {
      const k = `${id}/${sink}`
      tx.remote.set(k, new Map([...(tx.remote.get(k) ?? []), ...written]))
    },
    clock: { now: () => options.now ?? new Date() },
  }

  return { ports, applied, cursors, remote, tokens }
}

export function binding(id: string, config: Record<string, JsonValue> = {}): Binding {
  return { id, config }
}
