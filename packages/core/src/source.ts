import type { JsonValue, Operation } from '@connector-hub/spec'
import type { CompiledPlugin, CompiledSource } from './compile.js'
import { ConnectorError } from './errors.js'
import { buildRequest, call, type CallContext } from './http.js'
import type { Binding, HostPorts, HttpRequest } from './ports.js'

export interface RunOptions {
  /** Build and send reads, but apply nothing and save no state. Gives a preview. */
  dryRun?: boolean
}

export interface SourceResult {
  operations: Operation[]
  /** The cursor saved for the next run, or the previous one when unchanged. */
  cursor: JsonValue | null
  pages: number
  /** False when a page or record cap stopped the run early. The cursor is then not advanced. */
  complete: boolean
  requests: HttpRequest[]
  applied: boolean
}

/**
 * Reads one source to the end (or a cap), maps records to operations, and
 * commits the operations and the new cursor in one host transaction.
 */
export async function runSource<Tx>(
  plugin: CompiledPlugin,
  binding: Binding,
  sourceName: string,
  ports: HostPorts<Tx>,
  options: RunOptions = {},
): Promise<SourceResult> {
  const source = plugin.sources.get(sourceName)
  if (!source) throw new ConnectorError('config', `unknown source ${sourceName}`)
  const { limits } = plugin.declaration
  const origin = { plugin: plugin.declaration.plugin, version: plugin.declaration.version, source: sourceName }

  const previousCursor = await ports.state.getCursor(binding.id, sourceName)
  const ctx: CallContext = { plugin, binding, ports: ports as HostPorts<never>, secrets: await ports.secrets.get(binding.id) }
  const operations: Operation[] = []
  const requests: HttpRequest[] = []
  let highest: JsonValue | null = previousCursor
  let page = firstPage(source)
  let pages = 0
  let records = 0
  let complete = true

  for (;;) {
    if (pages >= limits.max_pages) {
      complete = false
      break
    }
    const vars = { config: binding.config, cursor: previousCursor, page }
    const request = buildRequest(plugin, source.request, vars)
    requests.push(request)
    const response = await call(ctx, request)
    pages++

    const list = source.records.evaluate({ ...vars, response })
    if (!Array.isArray(list)) throw new ConnectorError('permanent', `sources.${sourceName}.records did not return a list`)

    for (const record of list as JsonValue[]) {
      if (++records > limits.max_records) {
        complete = false
        break
      }
      const recordVars = { record, config: binding.config, cursor: previousCursor }
      for (const emit of source.emits) {
        if (emit.when && emit.when.evaluate(recordVars) !== true) continue
        const fields: Record<string, JsonValue> = {}
        for (const [name, expr] of emit.fields) fields[name] = expr.evaluate(recordVars) as JsonValue
        const key: Record<string, JsonValue> = {}
        for (const k of emit.keyFields) {
          const v = fields[k]
          if (v === null || v === undefined || v === '') {
            throw new ConnectorError('permanent', `sources.${sourceName}: ${emit.entity}.${k} evaluated to an empty key`)
          }
          key[k] = v
        }
        operations.push({ operation: emit.operation, entity: emit.entity, kind: emit.kind, key, fields, origin })
      }
      if (source.cursor) highest = maxCursor(highest, source.cursor.evaluate({ record }) as JsonValue)
    }
    if (!complete) break

    const next = nextPage(source, page, list.length, { ...vars, response })
    if (next === null) break
    page = next
  }

  const cursor = complete ? highest : previousCursor
  if (options.dryRun) return { operations, cursor, pages, complete, requests, applied: false }

  await ports.transaction(async (tx) => {
    if (operations.length > 0) await ports.apply(operations, tx)
    if (cursor !== null && JSON.stringify(cursor) !== JSON.stringify(previousCursor)) {
      await ports.saveCursor(binding.id, sourceName, cursor, tx)
    }
  })
  return { operations, cursor, pages, complete, requests, applied: true }
}

type Page = Record<string, JsonValue>

function firstPage(source: CompiledSource): Page {
  switch (source.paginate.type) {
    case 'none':
      return {}
    case 'offset':
      return { offset: 0, limit: source.paginate.limit }
    case 'page':
      return { number: source.paginate.start }
    case 'cursor':
      return { cursor: null }
  }
}

function nextPage(source: CompiledSource, page: Page, count: number, vars: Record<string, unknown>): Page | null {
  switch (source.paginate.type) {
    case 'none':
      return null
    case 'offset':
      return count < source.paginate.limit ? null : { offset: (page.offset as number) + count, limit: source.paginate.limit }
    case 'page':
      return count === 0 ? null : { number: (page.number as number) + 1 }
    case 'cursor': {
      const next = source.next!.evaluate(vars) as JsonValue
      if (next === null || next === undefined || next === '') return null
      if (next === page.cursor) throw new ConnectorError('permanent', 'pagination cursor did not advance')
      return { cursor: next }
    }
  }
}

/** Keeps the highest cursor value. Numbers compare numerically, everything else as strings. */
function maxCursor(current: JsonValue | null, candidate: JsonValue): JsonValue | null {
  if (candidate === null || candidate === undefined) return current
  if (current === null) return candidate
  if (typeof current === 'number' && typeof candidate === 'number') return candidate > current ? candidate : current
  return String(candidate) > String(current) ? candidate : current
}
