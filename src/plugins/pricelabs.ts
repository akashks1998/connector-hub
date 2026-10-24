import type { PluginInput } from '../spec/index.js'

/**
 * PriceLabs PMS Integration API v2, fed from Propool's public API (`/api/public/v1`).
 * One binding is one Propool unit connected to one PriceLabs listing.
 *
 * The payloads match Propool's current exporter, including the reservation ids, so a
 * listing can move from the exporter to this plugin without duplicates in PriceLabs.
 * PriceLabs takes 730 nights and the public calendar returns at most 366, hence two
 * calendar sinks.
 *
 * Not yet in the public API, so not sent: bedrooms, OTA listing ids, cleaning fee, and the
 * creation time of blocks. `city`, `country` and `currency` come from the binding.
 */
const reservationAck = '!has(response.body.failure) || size(response.body.failure) == 0'
const today = 'dateIn(now, config.timezone)'

const calendarSink = (fromDays: number, toDays: number) => ({
  after: ['listing'],
  read: {
    path: '/rental-units/{config.unit_id}/calendar',
    query: { from: `addDays(${today}, ${fromDays})`, to: `addDays(${today}, ${toDays})` },
    records: 'response.body.days',
  },
  key: 'row.date',
  fields: ['date', 'available', 'rateMinor', 'minStay', 'stopSell', 'bookingId', 'blockId'],
  on: ['calendar.updated', 'booking.created', 'booking.changed', 'booking.cancelled'],
  batch: { size: 366 },
  request: {
    method: 'POST' as const,
    path: '/calendar',
    body: `{"calendars": [{"listing_id": config.pricelabs_listing_id, "currency": config.currency,
      "data": batch.changes.map(c, {
        "date": c.row.date, "end_date": c.row.date,
        "price": fromMinor(int(c.row.rateMinor), currencyDigits(config.currency)),
        "available_units": c.row.available ? 1 : 0,
        "booked_units": has(c.row.bookingId) && c.row.bookingId != null ? 1 : 0,
        "blocked_units": !(has(c.row.bookingId) && c.row.bookingId != null)
          && ((has(c.row.blockId) && c.row.blockId != null) || c.row.stopSell) ? 1 : 0,
        "settings": {"min_stay": c.row.minStay}})}]}`,
  },
  ack: reservationAck,
})

export const pricelabsPlugin = {
  plugin: 'pricelabs',
  version: '0.1.0',
  description: 'Sends a Propool unit, its calendar and its reservations to PriceLabs.',
  engine: '^0.2',
  hosts: ['https://api.pricelabs.co/v2/integration/api'],
  limits: { requests_per_minute: 290, timeout_ms: 120_000 },
  config: {
    integration_name: { secret: true, description: "Propool's PriceLabs integration name" },
    integration_token: { secret: true, description: "Propool's PriceLabs integration token" },
    unit_id: { description: 'The Propool rental unit' },
    pricelabs_listing_id: { description: 'The listing id PriceLabs knows the unit by' },
    user_email: { description: "The customer's PriceLabs account email" },
    city: {},
    country: { description: 'ISO 3166 alpha-3, e.g. THA' },
    currency: { description: 'ISO 4217, e.g. THB' },
    timezone: { description: "The unit's IANA time zone, e.g. Asia/Bangkok" },
  },
  headers: {
    'x-integration-name': 'secrets.integration_name',
    'x-integration-token': 'secrets.integration_token',
  },
  sinks: {
    listing: {
      read: { path: '/rental-units/{config.unit_id}', records: '[response.body]' },
      key: 'row.id',
      fields: ['id', 'title', 'latitude', 'longitude'],
      batch: { size: 1 },
      request: {
        method: 'POST',
        path: '/listings',
        body: `{"listings": batch.changes.map(c, {"listing_id": config.pricelabs_listing_id,
          "user_token": config.user_email, "name": c.row.title, "status": "available",
          "location": {"latitude": double(c.row.latitude), "longitude": double(c.row.longitude),
                       "city": config.city, "country": config.country}})}`,
      },
      ack: '!has(response.body.errors) || size(response.body.errors) == 0',
    },
    calendar: calendarSink(0, 364),
    calendar_next: calendarSink(365, 729),
    reservations: {
      after: ['listing'],
      read: {
        path: '/bookings',
        query: { listingId: 'config.unit_id', limit: '100', cursor: 'page.cursor' },
        records: 'response.body.data',
        paginate: { type: 'cursor', next: 'response.body.nextCursor' },
      },
      key: 'row.id',
      where: 'row.departure >= "2020-01-01"',
      fields: ['id', 'status', 'arrival', 'departure', 'nights', 'totalAmountMinor', 'currency', 'channel', 'bookedAt', 'receivedAt'],
      on: ['booking.created', 'booking.changed', 'booking.cancelled'],
      // A booking that disappears from the read is sent once more as cancelled.
      on_delete: 'send',
      batch: { size: 100 },
      request: {
        method: 'POST',
        path: '/reservations',
        body: `{"reservations": [{"listing_id": config.pricelabs_listing_id, "data": batch.changes.map(c, {
          "reservation_id": "propool_booking_" + replaceAll(c.row.id, "-", ""),
          "currency": c.row.currency, "start_date": c.row.arrival, "end_date": c.row.departure,
          "booked_time": replaceAll((has(c.row.bookedAt) && c.row.bookedAt != null
            ? c.row.bookedAt : c.row.receivedAt).substring(0, 19), "T", " "),
          "total_days": c.row.nights,
          "total_cost": fromMinor(int(c.row.totalAmountMinor), currencyDigits(c.row.currency)),
          "status": c.deleted || c.row.status == "cancelled" ? "canceled" : "booked",
          "booking_source": c.row.channel})}]}`,
      },
      ack: reservationAck,
    },
    blocks: {
      after: ['listing'],
      read: {
        path: '/rental-units/{config.unit_id}/blocks',
        query: { from: '"2020-01-01"' },
        records: 'response.body.data',
      },
      key: 'row.id',
      fields: ['id', 'dateFrom', 'dateTo'],
      on: ['calendar.updated'],
      // A block whose deletion was requested leaves the read: PriceLabs gets it as cancelled.
      on_delete: 'send',
      batch: { size: 100 },
      request: {
        method: 'POST',
        path: '/reservations',
        body: `{"reservations": [{"listing_id": config.pricelabs_listing_id, "data": batch.changes.map(c, {
          "reservation_id": "propool_block_" + replaceAll(c.row.id, "-", ""),
          "currency": config.currency, "start_date": c.row.dateFrom, "end_date": addDays(c.row.dateTo, 1),
          "total_days": daysBetween(c.row.dateFrom, c.row.dateTo) + 1,
          "total_cost": 0, "status": c.deleted ? "canceled" : "blocked", "booking_source": "propool"})}]}`,
      },
      ack: reservationAck,
    },
  },
} satisfies PluginInput
