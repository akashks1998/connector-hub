/**
 * Live example: the getting-started plugin. Reads users from JSONPlaceholder
 * into the contacts domain as a dry run and prints the operations.
 */
import { compilePlugin, runSource, type PluginInput } from 'connector-hub'
import { contactsDomain } from 'connector-hub/contacts'
import { binding, memoryHost } from 'connector-hub/testkit'
import { fetchHttp, userAgent } from './fetch-http.ts'

const users: PluginInput = {
  plugin: 'jsonplaceholder-users',
  version: '0.1.0',
  engine: '^0.1',
  domain: { name: 'contacts', version: '^0.1' },
  hosts: ['https://jsonplaceholder.typicode.com'],
  sources: {
    users: {
      request: { path: '/users', headers: { 'user-agent': userAgent } },
      records: 'response.body',
      emit: [
        {
          operation: 'upsert_person',
          fields: {
            external_id: 'string(record.id)',
            first_name: 'record.name',
            email: 'lower(record.email)',
            phone: 'record.phone',
          },
        },
      ],
    },
  },
}

const plugin = compilePlugin(users, contactsDomain)
const host = memoryHost({ http: fetchHttp() })
const result = await runSource(plugin, binding('demo'), 'users', host.ports, { dryRun: true })

console.log(`${result.operations.length} operations from ${result.pages} page (dry run, nothing applied)\n`)
for (const op of result.operations.slice(0, 4)) {
  const { first_name, email } = op.fields as Record<string, string>
  console.log(`  ${op.operation}  key=${JSON.stringify(op.key)}  ${first_name} <${email}>`)
}
console.log(`  …`)
