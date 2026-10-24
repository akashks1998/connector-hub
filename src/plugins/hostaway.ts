import type { PluginInput } from '../spec/index.js'

/**
 * Hostaway, both ways, through Propool's public API (`/api/public/v1`). One binding is one
 * Hostaway listing matched to one Propool unit; matching stays a step in Propool's Hostaway screen.
 *
 * In: reservations (a poll and the reservation webhook, which only signals: the record is read
 * again) and the nights Hostaway has closed. Out: nights Propool has closed become closed days in
 * Hostaway, carrying a note marker. A precheck reads each day first, so a day changed in Hostaway
 * since is reported as a conflict instead of overwritten; that is what the in-app bridge does.
 * Bookings reach Hostaway as closed days, not reservations, so guests are never duplicated.
 */
const today = 'dateIn(now, config.timezone)'
const lastNight = `addDays(${today}, 364)`
// Marks the days Propool closed, so they are told apart from Hostaway's own closures. Any
// "[Propool:" note counts as ours, which covers days the in-app bridge closed before.
const marker = '"[Propool:" + config.unit_id + "]"'

const opt = (field: string) => `(has(record.${field}) && record.${field} != null && string(record.${field}) != "" ? dyn(record.${field}) : dyn(null))`
const count = (field: string, fallback: number) => `(has(record.${field}) && record.${field} != null ? int(record.${field}) : ${fallback})`
// Hostaway times are UTC without a zone, as "2026-10-01 08:15:00"; dates may come bare.
const iso = (value: string) => `(size(${value}) == 10 ? ${value} + "T00:00:00Z" : replaceAll(${value}, " ", "T") + "Z")`
// Hostaway channelName → the channel name Propool stores (the app's own Hostaway mapping).
const channels = `{"airbnb": "Airbnb", "airbnbofficial": "Airbnb", "bookingcom": "Booking.com", "agoda": "Agoda",
  "expedia": "Expedia", "homeaway": "Vrbo", "homeawayical": "Vrbo", "vrbo": "Vrbo", "vrboical": "Vrbo",
  "direct": "Direct", "bookingengine": "Direct", "customical": "iCal", "google": "Google"}`

const available = (day: string) => `(${day}.status == "available" && string(${day}.isAvailable) in ["1", "true"])`
const ours = (day: string) => `(has(${day}.note) && ${day}.note != null && ${day}.note.contains("[Propool:"))`

const change = 'batch.changes[0]'
// The day's own note without our marker, so a reopened day gets its note back.
const ownNote = `(${change}.remote != null && "note" in ${change}.remote && ${change}.remote.note != null
  ? replaceAll(replaceAll(${change}.remote.note, "\\n" + ${marker}, ""), ${marker}, "") : "")`

export const hostawayPlugin = {
  plugin: 'hostaway',
  version: '0.1.0',
  description: 'Imports Hostaway reservations and closed nights into a Propool unit, and closes in Hostaway the nights Propool has closed.',
  engine: '^0.2',
  hosts: ['https://api.hostaway.com/v1'],
  limits: { requests_per_minute: 80, timeout_ms: 30_000 },
  config: {
    account_id: { secret: true, description: 'Hostaway account id' },
    api_secret: { secret: true, description: 'Hostaway API key' },
    webhook_password: { secret: true, description: 'Basic-auth password set on the Hostaway webhook' },
    webhook_login: { description: 'Basic-auth login set on the Hostaway webhook' },
    unit_id: { description: 'The Propool rental unit' },
    hostaway_listing_id: { description: 'The Hostaway listing (listingMapId)' },
    timezone: { description: "The unit's IANA time zone, e.g. Asia/Bangkok" },
    initial_import: { type: 'bool', required: false, description: 'True for the first import: bookings are marked imported and send no guest notices' },
  },
  auth: {
    type: 'oauth2_client_credentials',
    token_url: '/accessTokens',
    client_id: 'secrets.account_id',
    client_secret: 'secrets.api_secret',
    scope: 'general',
    // Hostaway rejects a token used within a second of being issued.
    not_before_ms: 1100,
  },
  sources: {
    reservations: {
      request: {
        path: '/reservations',
        query: {
          listingId: 'config.hostaway_listing_id',
          departureStartDate: today,
          includeResources: '"1"',
          limit: 'page.limit',
          offset: 'page.offset',
        },
      },
      paginate: { type: 'offset', limit: 100 },
      records: 'response.body.result',
      // Requests, inquiries and owner stays carry no revenue; the closed nights cover them.
      when: 'record.status in ["new", "modified", "cancelled"] && string(record.listingMapId) == config.hostaway_listing_id',
      call: {
        method: 'PUT',
        path: '/bookings/by-provider/hostaway/{string(record.id)}',
        body: `compact({"unitId": config.unit_id,
          "status": record.status == "cancelled" ? "cancelled" : "confirmed",
          "arrival": record.arrivalDate, "departure": record.departureDate,
          "guest": compact({"firstName": ${opt('guestFirstName')} != null ? ${opt('guestFirstName')} : ${opt('guestName')},
            "lastName": ${opt('guestLastName')}, "email": ${opt('guestEmail')}, "phone": ${opt('phone')},
            "country": ${opt('guestCountry')} != null && size(string(record.guestCountry)) == 2 ? dyn(upper(record.guestCountry)) : dyn(null)}),
          "adults": ${count('adults', 1)}, "children": ${count('children', 0)}, "infants": ${count('infants', 0)},
          "totalAmountMinor": toMinor(double(record.totalPrice), currencyDigits(upper(record.currency))),
          "currency": upper(record.currency),
          "channelName": ${opt('channelName')} == null ? "Hostaway"
            : lower(record.channelName) in ${channels} ? ${channels}[lower(record.channelName)] : record.channelName,
          "confirmationCode": ${opt('confirmationCode')} != null ? ${opt('confirmationCode')} : "HA-" + string(record.id),
          "updatedAt": ${iso('string(record.updatedOn != null ? record.updatedOn : record.insertedOn)')},
          "bookedAt": ${opt('reservationDate')} != null ? dyn(${iso('string(record.reservationDate)')}) : dyn(null),
          "change": record.status == "new" ? "created" : "modified",
          "imported": config.initial_import == true})`,
      },
    },
    // Every night Hostaway has closed in the next year, minus the ones Propool closed itself.
    // Propool keeps them as blocks and skips nights its bookings already cover.
    closures: {
      request: {
        path: '/listings/{config.hostaway_listing_id}/calendar',
        query: { startDate: today, endDate: lastNight, includeResources: '"1"' },
      },
      records: '[{"days": response.body.result}]',
      call: {
        method: 'PUT',
        path: '/rental-units/{config.unit_id}/provider-closures/hostaway',
        body: `{"from": ${today}, "to": ${lastNight},
          "dates": record.days.filter(d, !${available('d')} && !${ours('d')}).map(d, d.date),
          "reserved": record.days.filter(d, d.status == "reserved" && !${ours('d')}).map(d, d.date)}`,
      },
    },
  },
  sinks: {
    calendar: {
      read: {
        path: '/rental-units/{config.unit_id}/calendar',
        query: { from: today, to: lastNight },
        records: 'response.body.days',
      },
      key: 'row.date',
      // Closed nights only: a night that opens again leaves the read and is sent as a release.
      where: '!row.available',
      fields: ['date'],
      // Hostaway's own stays and closures are already closed there.
      skip: 'row.bookingProvider == "hostaway" || (has(row.blockProvider) && row.blockProvider == "hostaway")',
      on: ['calendar.updated', 'booking.created', 'booking.changed', 'booking.cancelled'],
      on_delete: 'send',
      batch: { size: 1 },
      precheck: {
        request: {
          path: '/listings/{config.hostaway_listing_id}/calendar',
          query: { startDate: `${change}.row.date`, endDate: `${change}.row.date` },
        },
        records: 'response.body.result',
        key: 'remote.date',
        // Close only an open day (or one already ours); release only a day still ours, or already open.
        allow: `remote != null && (${available('remote')} || (${ours('remote')} && remote.status in ["blocked", "available"]))`,
      },
      request: {
        method: 'PUT',
        path: '/listings/{config.hostaway_listing_id}/calendar',
        body: `{"startDate": ${change}.row.date, "endDate": ${change}.row.date,
          "isAvailable": ${change}.deleted ? 1 : 0,
          "note": ${change}.deleted ? (${ownNote} == "" ? dyn(null) : dyn(${ownNote}))
            : dyn(${ownNote} == "" ? ${marker} : ${ownNote} + "\\n" + ${marker})}`,
      },
      ack: 'response.body.status == "success"',
    },
  },
  webhooks: {
    // Reservation created or updated. The payload only signals: the reservation is read again.
    reservation: {
      path: '/reservation',
      binding: 'string(has(request.body.data) ? request.body.data.listingMapId : request.body.listingMapId)',
      verify: 'secureEquals(request.headers.authorization, "Basic " + base64(config.webhook_login + ":" + secrets.webhook_password))',
      when: '!has(request.body.event) || request.body.event in ["reservation.created", "reservation.updated"]',
      reread: {
        source: 'reservations',
        request: { path: '/reservations/{string(has(request.body.data) ? request.body.data.id : request.body.objectId)}' },
        records: '[response.body.result]',
      },
    },
  },
} satisfies PluginInput
