import type { JsonValue } from '@connector-hub/spec'
import type { CompiledPlugin, CompiledSink } from './compile.js'
import { ConnectorError } from './errors.js'
import { buildRequest, call, type CallContext } from './http.js'
import type { Binding, HostPorts, HttpRequest, Row } from './ports.js'
import type { RunOptions } from './source.js'

export interface Change {
  /** Stable record key, `JSON.stringify` of the key values in key order. */
  key: string
  row: Row
  /** What the sink last wrote for this record, or null if never written. */
  previous: Row | null
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
 * Plan, then apply. The engine reads the declared input, compares it with what
 * this sink last wrote, and sends only the difference. A dry run returns the plan.
 */
export async function runSink<Tx>(
  plugin: CompiledPlugin,
  binding: Binding,
  sinkName: string,
  ports: HostPorts<Tx>,
  options: RunOptions = {},
): Promise<SinkResult> {
  const sink = plugin.sinks.get(sinkName)
  if (!sink) throw new ConnectorError('config', `unknown sink ${sinkName}`)

  const rows = await ports.read({ bindingId: binding.id, entity: sink.entity, fields: sink.visibleFields })
  const remote = await ports.state.getRemote(binding.id, sinkName)
  const changes = diff(sink, rows.map((r) => pick(r, sink.visibleFields)), remote, binding)
  const plan = batches(sink, changes, binding).map(({ key, changes }) => ({
    key,
    changes,
    request: buildRequest(plugin, sink.request, batchVars(key, changes, binding)),
  }))
  if (options.dryRun) return { plan, sent: 0, applied: false }

  const ctx: CallContext = { plugin, binding, ports: ports as HostPorts<never>, secrets: await ports.secrets.get(binding.id) }
  let sent = 0
  for (const batch of plan) {
    const response = await call(ctx, batch.request)
    if (sink.ack && sink.ack.evaluate({ ...batchVars(batch.key, batch.changes, binding), response }) !== true) {
      throw new ConnectorError('permanent', `sinks.${sinkName}: provider did not acknowledge batch ${sent + 1} of ${plan.length}`)
    }
    await ports.transaction((tx) => ports.saveRemote(binding.id, sinkName, new Map(batch.changes.map((c) => [c.key, c.row])), tx))
    sent++
  }
  return { plan, sent, applied: true }
}

function diff(sink: CompiledSink, rows: Row[], remote: Map<string, Row>, binding: Binding): Change[] {
  const out: Change[] = []
  for (const row of rows) {
    if (sink.where && sink.where.evaluate({ row, config: binding.config }) !== true) continue
    const key = JSON.stringify(sink.keyFields.map((k) => row[k] ?? null))
    const previous = remote.get(key) ?? null
    const changed = previous === null || sink.declaredFields.some((f) => !equal(row[f] ?? null, previous[f] ?? null))
    if (changed) out.push({ key, row, previous })
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

function batches(sink: CompiledSink, changes: Change[], binding: Binding): Array<{ key: JsonValue | null; changes: Change[] }> {
  const groups = new Map<string, { key: JsonValue | null; changes: Change[] }>()
  for (const c of changes) {
    const key = sink.by ? (sink.by.evaluate({ row: c.row, config: binding.config }) as JsonValue) : null
    const id = JSON.stringify(key)
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

function batchVars(key: JsonValue | null, changes: Change[], binding: Binding) {
  return { batch: { key, changes: changes.map((c) => ({ row: c.row, previous: c.previous })) }, config: binding.config }
}

function pick(row: Row, fields: string[]): Row {
  const out: Row = {}
  for (const f of fields) if (f in row) out[f] = row[f]!
  return out
}

function equal(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
