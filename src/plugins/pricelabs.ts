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
 * Bedrooms, the cleaning fee and platform ids are left out when the unit has none. Not in the
 * public API, so not sent: the creation time of blocks. `currency` comes from the binding.
 */
// PriceLabs takes alpha-3 countries; the units Propool serves today. A binding's `country` wins.
const alpha3 = `{"AE": "ARE", "TH": "THA", "SG": "SGP", "MY": "MYS", "ID": "IDN", "VN": "VNM", "PH": "PHL", "GB": "GBR", "US": "USA"}`
const r = 'batch.changes[0].row'
const ota = '["airbnb", "vrbo", "booking_com"]'
// PriceLabs signs every callback with the integration token: first the headers, then the body.
const signed = `secureEquals(request.headers["x-pl-signed-headers"], "v1." + hmacSha256Hex(secrets.integration_token,
    "v1:" + request.headers["x-source"] + ":" + request.headers["x-pl-timestamp"] + ":" + request.headers["x-pl-requestid"]))
  && secureEquals(request.headers["x-pl-signed-body"],
    hmacSha256Hex(secrets.integration_token, request.headers["x-pl-signed-headers"] + request.raw_body))`
// The push contract names the listing \`listing_id\`, the pull contract \`id\`.
const listingOf = 'has(request.body.listing_id) ? request.body.listing_id : request.body.id'
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
    city: { required: false, description: "Overrides the unit's own city" },
    country: { required: false, description: "ISO 3166 alpha-3, e.g. THA; overrides the unit's own country" },
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
      fields: ['id', 'title', 'bedrooms', 'cleaningFeeMinor', 'location', 'platformListings'],
      batch: { size: 1 },
      request: {
        method: 'POST',
        path: '/listings',
        // One unit per binding, so the one changed row is addressed directly (nested maps are refused).
        body: `{"listings": [compact({"listing_id": config.pricelabs_listing_id,
          "user_token": config.user_email, "name": ${r}.title, "status": "available",
          "location": {"latitude": double(${r}.location.latitude), "longitude": double(${r}.location.longitude),
            "city": config.city != null ? config.city : ${r}.location.city,
            "country": config.country != null ? config.country : ${alpha3}[${r}.location.countryCode]},
          "number_of_bedrooms": ${r}.bedrooms,
          "listing_fees": ${r}.cleaningFeeMinor == null ? dyn(null) : dyn({"cleaning_fee": {"type": "fixed",
            "value": fromMinor(int(${r}.cleaningFeeMinor), currencyDigits(config.currency)), "currency": config.currency}}),
          "ota_listing_ids": size(${r}.platformListings) == 0 ? dyn(null) : dyn(compact(fromEntries(
            ${r}.platformListings.filter(p, p.channelCode in ${ota}).map(p,
              [p.channelCode == "booking_com" ? "bookingcom" : p.channelCode, compact({"id": p.externalId, "url": p.url})])
            + [["other", ${r}.platformListings.exists(p, !(p.channelCode in ${ota}))
              ? dyn(fromEntries(${r}.platformListings.filter(p, !(p.channelCode in ${ota})).map(p,
                  [p.channelCode, compact({"id": p.externalId, "url": p.url})])))
              : dyn(null)]])))})]}`,
      },
      ack: '!has(response.body.errors) || size(response.body.errors) == 0',
    },
    calendar: calendarSink(0, 364),
    calendar_next: calendarSink(365, 729),
    reservations: {
      after: ['listing'],
      read: {
        path: '/bookings',
        // sort=id pages by keyset, so a booking revised mid-read is neither skipped nor read twice.
        query: { listingId: 'config.unit_id', limit: '100', sort: '"id"', cursor: 'page.cursor' },
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
  webhooks: {
    // New prices from PriceLabs. Propool refuses a batch not newer than the last one it took.
    sync: {
      path: '/sync',
      ping: 'size(request.raw_body) <= 128 && request.body == {"verify": true}',
      binding: listingOf,
      verify: signed,
      dedupe_key: 'request.headers["x-pl-requestid"]',
      call: {
        method: 'POST',
        path: '/rental-units/{config.unit_id}/rate-recommendations',
        body: `{"requestId": uuidFrom("pricelabs:" + request.headers["x-pl-requestid"]),
          "generatedAt": has(request.body.last_refreshed) ? request.body.last_refreshed : request.body.last_refreshed_at,
          "days": request.body.data.map(d, compact({"date": d.date,
            "rateMinor": toMinor(double(d.price), currencyDigits(config.currency)),
            "minStay": has(d.min_stay) ? dyn(int(d.min_stay)) : dyn(null)}))}`,
      },
    },
    // PriceLabs asks for everything again.
    calendar: {
      path: '/calendar',
      ping: 'size(request.raw_body) <= 128 && request.body == {"verify": true}',
      binding: listingOf,
      verify: signed,
      dedupe_key: 'request.headers["x-pl-requestid"]',
      resend: ['listing', 'calendar', 'calendar_next', 'reservations', 'blocks'],
    },
    // PriceLabs could not sync the listing.
    hook: {
      path: '/hook',
      ping: 'size(request.raw_body) <= 128 && request.body == {"verify": true}',
      binding: 'has(request.body.listing_id) ? request.body.listing_id : request.body._json.API_FAILED_SYNC',
      verify: signed,
      dedupe_key: 'request.headers["x-pl-requestid"]',
      issue: '"PriceLabs could not sync this listing"',
    },
  },
} satisfies PluginInput
