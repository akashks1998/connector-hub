import type { DomainPack } from '@connector-hub/spec'

/**
 * Short-term rental domain. Shaped after channel-manager models: availability is
 * separate from rates and restrictions, calendars are addressed by listing and
 * date, and bookings arrive as revisions.
 */
export const strDomain = {
  domain: 'str',
  version: '0.1.0',
  description: 'Short-term rentals: listings, calendar days and booking revisions.',
  entities: {
    listing: {
      key: ['external_id'],
      fields: {
        external_id: 'string',
        name: 'string',
        bedrooms: 'int',
        max_guests: 'int',
        latitude: 'double',
        longitude: 'double',
        country: 'string',
        currency: 'string',
      },
    },
    calendar_day: {
      description: 'One night of one listing.',
      key: ['listing_id', 'date'],
      fields: {
        listing_id: 'string',
        date: 'date',
        available: 'bool',
        /** Price in integer minor units of the listing currency. */
        price_minor: 'int',
        min_stay: 'int',
        max_stay: 'int',
        closed_to_arrival: 'bool',
        closed_to_departure: 'bool',
        note: 'string',
      },
    },
    booking: {
      key: ['external_id'],
      fields: {
        external_id: 'string',
        listing_id: 'string',
        status: { enum: ['confirmed', 'cancelled', 'request', 'closure'] },
        check_in: 'date',
        check_out: 'date',
        guests: 'int',
        guest_name: 'string',
        total_minor: 'int',
        currency: 'string',
        channel: 'string',
        revision: 'timestamp',
      },
    },
  },
  operations: {
    upsert_listing: { entity: 'listing', kind: 'upsert' },
    upsert_calendar_day: { entity: 'calendar_day', kind: 'upsert' },
    patch_calendar_day: { entity: 'calendar_day', kind: 'patch' },
    upsert_booking: { entity: 'booking', kind: 'upsert' },
    delete_booking: { entity: 'booking', kind: 'delete' },
  },
} satisfies DomainPack
