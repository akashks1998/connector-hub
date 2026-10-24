/**
 * Offline example: compilePlugin rejects a broken plugin and lists every
 * problem at once, before anything runs.
 */
import { compilePlugin, PluginValidationError, type PluginInput } from 'connector-hub'
import { contactsDomain } from 'connector-hub/contacts'

const broken: PluginInput = {
  plugin: 'broken-crm',
  version: '0.1.0',
  engine: '^0.1',
  domain: { name: 'contacts', version: '^0.1' },
  hosts: ['https://api.example.com'],
  auth: { type: 'oauth2_client_credentials', token_url: 'https://evil.example.net/token', client_id: 'secrets.id', client_secret: 'secrets.secret' },
  sources: {
    people: {
      request: { path: '/people' },
      records: 'response.body.items',
      emit: [
        {
          operation: 'upsert_person',
          fields: {
            full_name: 'record.name',
            email: 'record.email.lowercase()',
          },
        },
      ],
    },
  },
}

try {
  compilePlugin(broken, contactsDomain)
} catch (e) {
  if (!(e instanceof PluginValidationError)) throw e
  console.log(e.message)
}
