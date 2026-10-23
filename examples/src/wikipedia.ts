/**
 * Live example: English Wikipedia recent changes.
 * Shows cursor pagination (`rccontinue`), an incremental cursor on edit time,
 * and a domain pack defined outside the library.
 */
import { compilePlugin, runSource } from '@connector-hub/core'
import type { DomainPack, PluginInput } from '@connector-hub/spec'
import { binding, memoryHost } from '@connector-hub/testkit'
import { fetchHttp, userAgent } from './fetch-http.ts'

const wikiDomain = {
  domain: 'wiki',
  version: '0.1.0',
  entities: {
    edit: {
      key: ['rev_id'],
      fields: { rev_id: 'string', page_id: 'string', title: 'string', user: 'string', timestamp: 'timestamp', size_change: 'int' },
    },
  },
  operations: { upsert_edit: { entity: 'edit', kind: 'upsert' } },
} satisfies DomainPack

const wikipedia: PluginInput = {
  plugin: 'wikipedia-recent-changes',
  version: '0.1.0',
  engine: '^0.1',
  domain: { name: 'wiki', version: '^0.1' },
  hosts: ['https://en.wikipedia.org'],
  config: { since: { description: 'ISO timestamp to start from on the first run' } },
  limits: { max_pages: 5 },
  sources: {
    edits: {
      request: {
        path: '/w/api.php',
        headers: { 'user-agent': userAgent },
        query: {
          action: '"query"',
          list: '"recentchanges"',
          format: '"json"',
          formatversion: '"2"',
          rctype: '"edit"',
          rcprop: '"title|ids|timestamp|user|sizes"',
          rcdir: '"newer"',
          rclimit: '"50"',
          rcstart: 'cursor != null ? cursor : config.since',
          rccontinue: 'page.cursor',
        },
      },
      paginate: { type: 'cursor', next: 'has(response.body.continue) ? response.body.continue.rccontinue : ""' },
      records: 'response.body.query.recentchanges',
      emit: [
        {
          operation: 'upsert_edit',
          fields: {
            rev_id: 'string(record.revid)',
            page_id: 'string(record.pageid)',
            title: 'record.title',
            user: 'has(record.user) ? record.user : "(hidden)"',
            timestamp: 'record.timestamp',
            size_change: 'record.newlen - record.oldlen',
          },
        },
      ],
      cursor: { value: 'record.timestamp' },
    },
  },
}

const plugin = compilePlugin(wikipedia, wikiDomain)
const host = memoryHost({ http: fetchHttp() })
const since = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
const b = binding('enwiki', { since })

const first = await runSource(plugin, b, 'edits', host.ports)
console.log(`Run 1 (since ${since}): ${first.pages} pages, ${first.operations.length} edits, complete=${first.complete}, cursor=${String(first.cursor)}`)
const biggest = [...first.operations].sort((x, y) => Math.abs(Number(y.fields.size_change)) - Math.abs(Number(x.fields.size_change))).slice(0, 5)
for (const op of biggest) console.log(`  ${String(op.fields.size_change).padStart(7)}  ${String(op.fields.title)}`)

await new Promise((r) => setTimeout(r, 5_000))
const second = await runSource(plugin, b, 'edits', host.ports)
console.log(`Run 2 (from saved cursor): ${second.pages} pages, ${second.operations.length} edits, cursor=${String(second.cursor)}`)
