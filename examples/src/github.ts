/**
 * Live example: open issues of a public GitHub repository.
 * Shows page-number pagination and the page cap: the run stops after
 * `max_pages`, reports complete=false, and does not advance the cursor.
 * Unauthenticated GitHub allows 60 requests an hour.
 */
import { compilePlugin, runSource } from '@connector-hub/core'
import type { DomainPack, PluginInput } from '@connector-hub/spec'
import { binding, memoryHost } from '@connector-hub/testkit'
import { fetchHttp, userAgent } from './fetch-http.ts'

const issuesDomain = {
  domain: 'issues',
  version: '0.1.0',
  entities: {
    issue: {
      key: ['external_id'],
      fields: { external_id: 'string', number: 'int', title: 'string', author: 'string', comments: 'int', updated_at: 'timestamp' },
    },
  },
  operations: { upsert_issue: { entity: 'issue', kind: 'upsert' } },
} satisfies DomainPack

const github: PluginInput = {
  plugin: 'github-issues',
  version: '0.1.0',
  engine: '^0.1',
  domain: { name: 'issues', version: '^0.1' },
  hosts: ['https://api.github.com'],
  config: { owner: {}, repo: {} },
  limits: { max_pages: 2 },
  sources: {
    issues: {
      request: {
        path: '/repos/{config.owner}/{config.repo}/issues',
        headers: { 'user-agent': userAgent, accept: '"application/vnd.github+json"' },
        query: { state: '"open"', per_page: '"30"', page: 'page.number', since: 'cursor' },
      },
      paginate: { type: 'page', start: 1 },
      records: 'response.body',
      emit: [
        {
          operation: 'upsert_issue',
          when: '!has(record.pull_request)',
          fields: {
            external_id: 'string(record.id)',
            number: 'record.number',
            title: 'record.title',
            author: 'record.user.login',
            comments: 'record.comments',
            updated_at: 'record.updated_at',
          },
        },
      ],
      cursor: { value: 'record.updated_at' },
    },
  },
}

const plugin = compilePlugin(github, issuesDomain)
const host = memoryHost({ http: fetchHttp() })
const result = await runSource(plugin, binding('node', { owner: 'nodejs', repo: 'node' }), 'issues', host.ports, { dryRun: true })
console.log(`${result.pages} pages, ${result.operations.length} issues (pull requests skipped), complete=${result.complete}`)
for (const op of result.operations.slice(0, 5)) console.log(`  #${String(op.fields.number)}  ${String(op.fields.title)}`)
