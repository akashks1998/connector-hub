import type { JsonValue } from '../spec/index.js'
import type { CompiledPlugin, CompiledSink, CompiledTargetSink } from './compile.js'
import { bindingFor, secretsFor } from './config.js'
import { ConnectorError } from './errors.js'
import { buildRequest, call, type CallContext } from './http.js'
import { checkRepeat, firstPage, nextPage } from './paging.js'
import type { Binding, HostPorts, HttpRequest, Row } from './ports.js'
import type { RunOptions } from './source.js'
import { buildTargetRequest, callTarget } from './target.js'
import { canonical } from './values.js'

export interface Change {
  /** Stable record key: the JSON of the key values (domain mode) or of the `key` value (target mode). */
  key: string
  /** The row to send. For a deletion, what was last written. */
  row: Row
  /** What the sink last wrote for this record, or null if never written. */
  previous: Row | null
  /** True when the row was written before and is now absent (`on_delete: send`). */
  deleted: boolean
}

export interface PlannedBatch {
  key: JsonValue | null
  changes: Change[]
  request: HttpRequest
}

export interface SinkResult {
  /** Every batch the plan contains, in send order. */
  plan: PlannedBatch[]
  /** Batches sent and acknowledged. Their rows are saved as the new remote state. */
  sent: number
  applied: boolean
}

/**
 * Plan, then apply. The engine reads the sink's rows, compares them with what
 * this sink last wrote, and sends only the difference. A dry run returns the plan.
 */
export async function runSink<Tx>(
  plugin: CompiledPlugin,
  bindingInput: Binding,
  sinkName: string,
  ports: HostPorts<Tx>,
  options: RunOptions = {},
): Promise<SinkResult> {
  const sink = plugin.sinks.get(sinkName)
  if (!sink) throw new ConnectorError('config', `unknown sink ${sinkName}`)
  const binding = bindingFor(plugin, bindingInput)
  const now = (ports.clock?.now() ?? new Date()).toISOString()

  const rows =
    sink.mode === 'domain'
      ? (await ports.read({ bindingId: binding.id, entity: sink.entity, fields: sink.visibleFields })).map((r) => pick(r, sink.visibleFields))
      : await readTarget(plugin, sink, binding, ports as HostPorts<never>, now)
  const remote = await ports.state.getRemote(binding.id, sinkName)
  const { changes, forgotten } = diff(sink, rows, remote, binding, now)
  const plan = batches(sink, changes, binding, now).map(({ key, changes }) => ({
    key,
    changes,
    request: buildRequest(plugin, sink.request, batchVars(key, changes, binding, now)),
  }))
  if (options.dryRun) return { plan, sent: 0, applied: false }

  const ctx: CallContext = { plugin, binding, ports: ports as HostPorts<never>, secrets: await secretsFor(plugin, binding, ports.secrets) }
  let sent = 0
  for (const batch of plan) {
    const progress = `batch ${sent + 1} of ${plan.length}, ${sent} sent`
    try {
      const response = await call(ctx, batch.request)
      if (sink.ack && sink.ack.evaluate({ ...batchVars(batch.key, batch.changes, binding, now), response }) !== true) {
        throw new ConnectorError('permanent', `sinks.${sinkName}: provider did not acknowledge the batch`)
      }
    } catch (e) {
      if (e instanceof ConnectorError) throw new ConnectorError(e.kind, `${e.message} (${progress})`, { ...e.details, cause: e, sent })
      throw e
    }
    const saved = new Map(batch.changes.map((c) => [c.key, c.deleted ? null : snapshot(sink, c.row)]))
    await ports.transaction((tx) => ports.saveRemote(binding.id, sinkName, saved, tx))
    sent++
  }
  // Written rows that are gone and need no message: forget them, so a return is sent again.
  if (forgotten.length > 0) {
    await ports.transaction((tx) => ports.saveRemote(binding.id, sinkName, new Map(forgotten.map((k) => [k, null])), tx))
  }
  return { plan, sent, applied: true }
}

/** Sinks in an order that respects `after`, limited to `names`. */
export function orderSinks(plugin: CompiledPlugin, names: Iterable<string>): string[] {
  const wanted = new Set(names)
  for (const n of wanted) if (!plugin.sinks.has(n)) throw new ConnectorError('config', `unknown sink ${n}`)
  const out: string[] = []
  const done = new Set<string>()
  const visit = (n: string) => {
    if (done.has(n)) return
    done.add(n)
    for (const before of plugin.sinks.get(n)!.after) if (wanted.has(before)) visit(before)
    out.push(n)
  }
  for (const n of [...plugin.sinks.keys()]) if (wanted.has(n)) visit(n)
  return out
}

/** The sinks a host event should run, in order. */
export function sinksFor(plugin: CompiledPlugin, event: string): string[] {
  return orderSinks(
    plugin,
    [...plugin.sinks.values()].filter((s) => s.on.includes(event)).map((s) => s.name),
  )
}

/** Runs several sinks in `after` order, stopping at the first failure. */
export async function runSinks<Tx>(
  plugin: CompiledPlugin,
  binding: Binding,
  names: Iterable<string>,
  ports: HostPorts<Tx>,
  options: RunOptions = {},
): Promise<Map<string, SinkResult>> {
  const results = new Map<string, SinkResult>()
  for (const name of orderSinks(plugin, names)) results.set(name, await runSink(plugin, binding, name, ports, options))
  return results
}

/** Reads every page of a target-mode sink. A partial read could look like deletions, so caps fail the run. */
async function readTarget(plugin: CompiledPlugin, sink: CompiledTargetSink, binding: Binding, ports: HostPorts<never>, now: string): Promise<Row[]> {
  const { limits } = plugin.declaration
  const where = `sinks.${sink.name}.read`
  const rows: Row[] = []
  const seen = new Set<string>()
  let page = firstPage(sink.read.paginate)
  for (let pages = 0; ; pages++) {
    if (pages >= limits.max_pages) throw new ConnectorError('permanent', `${where}: more than ${limits.max_pages} pages`)
    const vars = { config: binding.config, cursor: null, page, now }
    const response = await callTarget(ports, buildTargetRequest(sink.read.request, vars))
    const list = sink.read.records.evaluate({ ...vars, response })
    if (!Array.isArray(list)) throw new ConnectorError('permanent', `${where}.records did not return a list`)
    checkRepeat(list as JsonValue[], seen, where)
    for (const row of list as JsonValue[]) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new ConnectorError('permanent', `${where}: a row is not an object`)
      rows.push(row as Row)
    }
    if (rows.length > limits.max_records) throw new ConnectorError('permanent', `${where}: more than ${limits.max_records} rows`)
    const next = nextPage(sink.read.paginate, sink.read.next, page, list.length, { ...vars, response }, seen)
    if (next === null) return rows
    page = next
  }
}

function diff(
  sink: CompiledSink,
  rows: Row[],
  remote: Map<string, Row>,
  binding: Binding,
  now: string,
): { changes: Change[]; forgotten: string[] } {
  const changes: Change[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const vars = { row, config: binding.config, now }
    if (sink.where && sink.where.evaluate(vars) !== true) continue
    const key = keyOf(sink, row, vars)
    if (seen.has(key)) {
      const what = sink.mode === 'domain' ? `${sink.entity} rows` : 'rows'
      throw new ConnectorError('permanent', `sinks.${sink.name}: two ${what} have the key ${key}`)
    }
    seen.add(key)
    if (sink.skip && sink.skip.evaluate(vars) === true) continue
    const previous = remote.get(key) ?? null
    if (previous === null || canonical(snapshot(sink, row)) !== canonical(snapshot(sink, previous))) {
      changes.push({ key, row, previous, deleted: false })
    }
  }
  const forgotten: string[] = []
  for (const [key, previous] of remote) {
    if (seen.has(key)) continue
    if (sink.onDelete === 'send') changes.push({ key, row: previous, previous, deleted: true })
    else forgotten.push(key)
  }
  return { changes: changes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)), forgotten }
}

function keyOf(sink: CompiledSink, row: Row, vars: Record<string, unknown>): string {
  const empty = (v: unknown) => v === null || v === undefined || v === ''
  if (sink.mode === 'domain') {
    for (const k of sink.keyFields) {
      if (empty(row[k])) throw new ConnectorError('permanent', `sinks.${sink.name}: a ${sink.entity} row has an empty ${k}`)
    }
    return JSON.stringify(sink.keyFields.map((k) => row[k]))
  }
  const value = sink.key.evaluate(vars)
  if (empty(value) || (typeof value !== 'string' && typeof value !== 'number')) {
    throw new ConnectorError('permanent', `sinks.${sink.name}.key must give a non-empty string or number`)
  }
  return JSON.stringify([value])
}

/** What is compared with, and saved as, the last write. */
function snapshot(sink: CompiledSink, row: Row): Row {
  if (sink.mode === 'domain') return row
  return sink.fields ? pick(row, sink.fields) : row
}

function batches(sink: CompiledSink, changes: Change[], binding: Binding, now: string): Array<{ key: JsonValue | null; changes: Change[] }> {
  const groups = new Map<string, { key: JsonValue | null; changes: Change[] }>()
  for (const c of changes) {
    let key: JsonValue | null = null
    if (sink.by) {
      key = (sink.by.evaluate({ row: c.row, config: binding.config, now }) ?? null) as JsonValue
      if (key === null || key === '') throw new ConnectorError('permanent', `sinks.${sink.name}: batch.by is empty for ${c.key}`)
    }
    const id = canonical(key)
    const group = groups.get(id) ?? { key, changes: [] }
    group.changes.push(c)
    groups.set(id, group)
  }
  const out: Array<{ key: JsonValue | null; changes: Change[] }> = []
  for (const g of groups.values()) {
    for (let i = 0; i < g.changes.length; i += sink.batchSize) out.push({ key: g.key, changes: g.changes.slice(i, i + sink.batchSize) })
  }
  return out
}

function batchVars(key: JsonValue | null, changes: Change[], binding: Binding, now: string) {
  return {
    batch: { key, changes: changes.map((c) => ({ row: c.row, previous: c.previous, deleted: c.deleted })) },
    config: binding.config,
    now,
  }
}

function pick(row: Row, fields: string[]): Row {
  const out: Row = {}
  for (const f of fields) if (f in row) out[f] = row[f]!
  return out
}
