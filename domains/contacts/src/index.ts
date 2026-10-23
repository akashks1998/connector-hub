import type { DomainPack } from '@connector-hub/spec'

/** Contacts domain: people and the organisations they belong to. */
export const contactsDomain = {
  domain: 'contacts',
  version: '0.1.0',
  description: 'People and organisations, as kept in a CRM.',
  entities: {
    person: {
      key: ['external_id'],
      fields: {
        external_id: 'string',
        first_name: 'string',
        last_name: 'string',
        email: 'string',
        phone: 'string',
        organisation_id: 'string',
        updated_at: 'timestamp',
      },
    },
    organisation: {
      key: ['external_id'],
      fields: { external_id: 'string', name: 'string', domain: 'string', updated_at: 'timestamp' },
    },
  },
  operations: {
    upsert_person: { entity: 'person', kind: 'upsert' },
    delete_person: { entity: 'person', kind: 'delete' },
    upsert_organisation: { entity: 'organisation', kind: 'upsert' },
  },
} satisfies DomainPack
