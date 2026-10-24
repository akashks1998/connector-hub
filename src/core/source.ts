import type { JsonValue, Operation } from '../spec/index.js'
import type { CompiledPlugin, CompiledSource } from './compile.js'
import { bindingFor, secretsFor } from './config.js'
import { ConnectorError } from './errors.js'
import { buildRequest, call, type CallContext } from './http.js'
import { checkRepeat, firstPage, nextPage } from './paging.js'
import type { Binding, HostPorts, HttpRequest, TargetHttpRequest } from './ports.js'
import { buildTargetRequest, callTarget, targetLimits } from './target.js'
import { canonical, compareCursor, mismatch } from './values.js'

export interface RunOptions {
  /** Send the reads, but apply nothing and save no cursor or snapshot. Gives a preview. */
  dryRun?: boolean
}

export interface SourceResult {
  operations: Operation[]
  /** Target API requests of a `call` source, in send order. */
  calls: TargetHttpRequest[]
  /** The cursor saved for the next run, or the previous one when unchanged. */
  cursor: JsonValue | null
  pages: number
  /** False when a page or record cap stopped the run early. The cursor is then not advanced. */
  complete: boolean
  /** Every request sent, without auth. */
  requests: HttpRequest[]
  applied: boolean
}

/**
 * Reads one source to the end (or a cap), maps records to operations, and
 * commits the operations and the new cursor in one host transaction.
 */
export async function runSource<Tx>(
  plugin: CompiledPlugin,
  bindingInput: Binding,
  sourceName: string,
  ports: HostPorts<Tx>,
  options: RunOptions = {},
): Promise<SourceResult> {
  const source = plugin.sources.get(sourceName)
  if (!source) throw new ConnectorError('config', `unknown source ${sourceName}`)
  const binding = bindingFor(plugin, bindingInput)
  const { limits } = plugin.declaration
  const origin = { plugin: plugin.declaration.plugin, version: plugin.declaration.version, source: sourceName }

  const previousCursor = await ports.state.getCursor(binding.id, sourceName)
  const ctx: CallContext = { plugin, binding, ports: ports as HostPorts<never>, secrets: await secretsFor(plugin, binding, ports.secrets) }
  const now = (ports.clock?.now() ?? new Date()).toISOString()
  const operations: Operation[] = []
  const calls: TargetHttpRequest[] = []
  const requests: HttpRequest[] = []
  const seenPages = new Set<string>()
  let highest: JsonValue | null = previousCursor
  let page = firstPage(source.paginate)
  let pages = 0
  let records = 0
  let complete = true

  for (;;) {
    if (pages >= limits.max_pages) {
      complete = false
      break
    }
    const vars = { config: binding.config, cursor: previousCursor, page, now }
    const request = buildRequest(plugin, source.request, vars)
    requests.push(request)
    const response = await call(ctx, request)
    pages++

    const list = source.records.evaluate({ ...vars, response })
    if (!Array.isArray(list)) throw new ConnectorError('permanent', `sources.${sourceName}.records did not return a list`)
    checkRepeat(list as JsonValue[], seenPages, `sources.${sourceName}`)

    for (const record of list as JsonValue[]) {
      if (++records > limits.max_records) {
        complete = false
        break
      }
      const recordVars = { record, config: binding.config, cursor: previousCursor, now }
      // A record `when` skips is still read, so it still moves the cursor.
      const included = !source.when || source.when.evaluate(recordVars) === true
      if (included && source.call) calls.push(buildTargetRequest(source.call, recordVars))
      for (const emit of included ? source.emits : []) {
        if (emit.when && emit.when.evaluate(recordVars) !== true) continue
        const fields: Record<string, JsonValue> = {}
        for (const [name, expr] of emit.fields) {
          const value = (expr.evaluate(recordVars) ?? null) as JsonValue
          const problem = mismatch(emit.types[name]!, value)
          if (problem) throw new ConnectorError('permanent', `sources.${sourceName}: ${emit.entity}.${name} ${problem}`)
          fields[name] = value
        }
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
      if (source.cursor) {
        const value = source.cursor.evaluate({ record }) as JsonValue
        if (value !== null && value !== undefined && (highest === null || compareCursor(value, highest) > 0)) highest = value
      }
    }
    if (!complete) break

    const next = nextPage(source.paginate, source.next, page, list.length, { ...vars, response }, seenPages)
    if (next === null) break
    page = next
  }

  const cursor = complete ? highest : previousCursor
  if (options.dryRun) return { operations, calls, cursor, pages, complete, requests, applied: false }
  // Without a complete read the cursor cannot move, so the same calls would be sent on every run.
  if (!complete && calls.length > 0) {
    throw new ConnectorError('permanent', `sources.${sourceName}: read stopped at the page or record limit; narrow the request so one run covers it`)
  }

  // Target calls are the host's own writes, each idempotent by design; the cursor moves only
  // after all of them succeed, so a failed run is simply repeated.
  for (const [i, request] of calls.entries()) {
    try {
      await callTarget(ports as HostPorts<never>, request, targetLimits(plugin))
    } catch (e) {
      if (e instanceof ConnectorError) {
        throw new ConnectorError(e.kind, `sources.${sourceName}: ${e.message} (call ${i + 1} of ${calls.length})`, { ...e.details, cause: e, sent: i })
      }
      throw e
    }
  }
  await ports.transaction(async (tx) => {
    if (operations.length > 0) await ports.apply(operations, tx)
    if (cursor !== null && canonical(cursor) !== canonical(previousCursor)) {
      await ports.saveCursor(binding.id, sourceName, cursor, tx)
    }
  })
  return { operations, calls, cursor, pages, complete, requests, applied: true }
}
