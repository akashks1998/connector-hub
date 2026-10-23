/**
 * Live example: a sink writing to httpbin.org, which echoes requests back.
 * Shows plan/apply: the first run sends every row, the second sends nothing,
 * and after one change only that row's batch is sent.
 */
import { compilePlugin, runSink } from '@connector-hub/core'
import type { DomainPack, PluginInput } from '@connector-hub/spec'
import { binding, memoryHost } from '@connector-hub/testkit'
import { fetchHttp, userAgent } from './fetch-http.ts'

const tasksDomain = {
  domain: 'tasks',
  version: '0.1.0',
  entities: { task: { key: ['id'], fields: { id: 'string', project: 'string', title: 'string', done: 'bool', secret_note: 'string' } } },
  operations: { upsert_task: { entity: 'task', kind: 'upsert' } },
} satisfies DomainPack

const httpbin: PluginInput = {
  plugin: 'httpbin-tasks',
  version: '0.1.0',
  engine: '^0.1',
  domain: { name: 'tasks', version: '^0.1' },
  hosts: ['https://httpbin.org'],
  sinks: {
    tasks: {
      input: { entity: 'task', fields: ['project', 'title', 'done'] },
      batch: { size: 10, by: 'row.project' },
      request: {
        method: 'PUT',
        path: '/put',
        headers: { 'user-agent': userAgent },
        query: { project: 'batch.key' },
        body: 'batch.changes.map(c, {"id": c.row.id, "title": c.row.title, "done": c.row.done})',
      },
      ack: 'size(response.body.json) == size(batch.changes)',
    },
  },
}

const rows = {
  task: [
    { id: '1', project: 'web', title: 'Fix login', done: false, secret_note: 'not declared, never sent' },
    { id: '2', project: 'web', title: 'Add dark mode', done: true, secret_note: 'x' },
    { id: '3', project: 'api', title: 'Rate limits', done: false, secret_note: 'x' },
  ],
}
const plugin = compilePlugin(httpbin, tasksDomain)
const http = fetchHttp()
const host = memoryHost({ http, rows })
const b = binding('demo')

const first = await runSink(plugin, b, 'tasks', host.ports)
console.log(`Run 1: sent ${first.sent} batches (${first.plan.map((p) => `${String(p.key)}: ${p.changes.length}`).join(', ')})`)
const second = await runSink(plugin, b, 'tasks', host.ports)
console.log(`Run 2: ${second.plan.length} batches planned (nothing changed)`)
rows.task[2]!.done = true
const third = await runSink(plugin, b, 'tasks', host.ports)
console.log(`Run 3: sent ${third.sent} batch for "${String(third.plan[0]?.key)}", previous done=${String(third.plan[0]?.changes[0]?.previous?.done)}`)
console.log(`Request body never includes undeclared fields: ${!JSON.stringify(first.plan).includes('secret_note')}`)
