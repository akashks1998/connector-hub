# Design: PriceLabs and Hostaway plugins

Status: draft for review, 2026-10-24. Nothing here is built yet.

Scope is exactly three flows, nothing generic:

1. **PriceLabs**: our listings, calendar and bookings go to PriceLabs; its prices come back.
2. **Hostaway import and webhook**: Hostaway listings, reservations and calendar come into Propool, once and then live.
3. **Propool → Hostaway**: changes made in Propool go to Hostaway.

Based on Propool's `origin/dev` (`src/short-term-rentals/hostaway`,
`src/short-term-rentals/pricing`, `src/public-api`).

## The model

A plugin translates between one provider's API and Propool's public API
(`/api/public/v1`). It has no data model, storage or code of its own.

| | Who does it |
| --- | --- |
| Calling the provider, paging, auth, mapping fields, verifying the provider's webhooks | Plugin (YAML) |
| Reading Propool data | Public API `GET` calls |
| Writing Propool data | Public API `POST`/`PATCH` calls, so validation, permissions and audit are the same as for any client |
| Knowing when Propool data changed | Propool outbound webhooks (events) |
| Running jobs, retries, rate limits, cursors, last-written snapshots, dedupe | Propool's plugin runner |
| Business rules (manual edits win, Channex beats Hostaway, approval step) | Propool, behind the public API |

Installing a plugin issues it an API key limited to the scopes it declares;
uninstalling revokes the key. No admin creates keys by hand.

The existing PriceLabs and Hostaway screens stay. The plugin replaces the code
behind them, not the screens.

## What the public API needs first

Today it has listings (CRUD), contacts (CRUD), leads, bookings (read only),
and the events `lead.created`, `lead.stage_changed`, `booking.created`.

| Add | PriceLabs | Hostaway import | Propool → Hostaway |
| --- | --- | --- | --- |
| `GET /listings/{id}/calendar` (price, min stay, available, booked, blocked) | ✓ | | ✓ |
| `PATCH /listings/{id}/calendar` (price, min stay, closures) | | ✓ | |
| `POST/PATCH /bookings` with `source` and `external_id` (upsert by external id) | | ✓ | |
| `POST /listings/{id}/rate-recommendations` | ✓ | | |
| Events `booking.updated`, `booking.cancelled` | ✓ | | ✓ |
| Event `calendar.updated` (listing, date range) | ✓ | | ✓ |
| Event `listing.updated` | ✓ | | |
| Scopes `calendar:read`, `calendar:write`, `bookings:write`, `pricing:write` | ✓ | ✓ | ✓ |

Rate recommendations get their own endpoint, not a calendar write. Propool
then decides whether to apply them (ready/active/paused, approval, manual
edits win, minimum rate), as it does now.

## PriceLabs plugin

PriceLabs PMS Integration API v2. Credentials: Propool's partner keys
(`X-INTEGRATION-NAME`, `X-INTEGRATION-TOKEN`, the same for every agency) and
the customer's PriceLabs email per listing.

**Trigger.** Events `listing.updated`, `calendar.updated`,
`booking.created/updated/cancelled` queue a run for that listing. The runner
reads the rows through the public API and the sink sends only what changed
since the last write.

```yaml
plugin: pricelabs
version: 0.1.0
engine: ^0.2
hosts: [https://api.pricelabs.co/v2/integration/api]
limits: { requests_per_minute: 290, timeout_ms: 120000 }
scopes: [inventory:read, calendar:read, bookings:read, pricing:write]

config:
  integration_name: { secret: true }
  integration_token: { secret: true }
  user_email: { description: The customer's PriceLabs account email }
  currency: { description: The listing currency, e.g. THB }

headers:                                    # E1
  x-integration-name: secrets.integration_name
  x-integration-token: secrets.integration_token

sinks:
  listing:
    read: GET /listings/{binding.listing_id}
    on: [listing.updated]
    request:
      method: POST
      path: /listings
      body: |
        {"listings": [{"listing_id": row.id, "user_token": config.user_email,
          "name": row.name, "status": row.active ? "available" : "unavailable",
          "location": {"latitude": row.latitude, "longitude": row.longitude,
                       "city": row.city, "country": iso3(row.country)},
          "number_of_bedrooms": row.bedrooms}]}
    ack: size(response.body.errors) == 0

  calendar:
    after: [listing]                        # E4
    read: GET /listings/{binding.listing_id}/calendar?from={today}&days=730
    on: [calendar.updated, booking.created, booking.updated, booking.cancelled]
    key: row.date
    batch: { size: 730 }
    request:
      method: POST
      path: /calendar
      body: |
        {"calendars": [{"listing_id": binding.listing_id, "currency": config.currency,
          "data": batch.changes.map(c, {
            "date": c.row.date, "end_date": c.row.date,
            "price": fromMinor(c.row.price_minor, currencyDigits(config.currency)),
            "available_units": c.row.available ? 1 : 0,
            "booked_units": c.row.booked ? 1 : 0,
            "blocked_units": c.row.blocked ? 1 : 0,
            "settings": {"min_stay": c.row.min_stay}})}]}
    ack: size(response.body.failure) == 0

  reservations:
    after: [listing]
    read: GET /bookings?listingId={binding.listing_id}&departureFrom={today}
    on: [booking.created, booking.updated, booking.cancelled]
    key: row.id
    batch: { size: 100 }
    on_delete: send                         # E3
    request:
      method: POST
      path: /reservations
      body: |
        {"reservations": [{"listing_id": binding.listing_id, "data": batch.changes.map(c, {
          "reservation_id": c.row.id,
          "status": c.deleted || c.row.status == "cancelled" ? "canceled" : "booked",
          "start_date": c.row.arrival, "end_date": c.row.departure,
          "total_cost": fromMinor(c.row.total_minor, currencyDigits(c.row.currency)),
          "currency": c.row.currency, "booking_source": c.row.source})}]}
    ack: size(response.body.failure) == 0

webhooks:                                   # E2
  sync:
    path: /sync
    respond_unsigned: request.body == {"verify": true}
    verify: |
      secureEquals(request.headers["x-pl-signed-headers"], "v1." + hmacSha256Hex(secrets.integration_token,
        "v1:" + request.headers["x-source"] + ":" + request.headers["x-pl-timestamp"] + ":" + request.headers["x-pl-requestid"]))
      && secureEquals(request.headers["x-pl-signed-body"],
        hmacSha256Hex(secrets.integration_token, request.headers["x-pl-signed-headers"] + request.raw_body))
    dedupe_key: request.headers["x-pl-requestid"]
    binding: request.body.listing_id
    order: request.body.last_refreshed       # E5: drop older batches
    call:
      method: POST
      path: /listings/{binding.listing_id}/rate-recommendations
      body: |
        {"generated_at": request.body.last_refreshed,
         "days": request.body.data.map(d, {"date": d.date,
           "price_minor": toMinor(double(d.price), 2),
           "min_stay": has(d.min_stay) ? int(d.min_stay) : null})}

  calendar:
    path: /calendar
    verify: …same as sync…
    binding: request.body.listing_id
    resend: [listing, calendar, reservations] # E5: forget the snapshot, send everything

  hook:
    path: /hook
    verify: …same as sync…
    binding: request.body.listing_id
    issue: '"PriceLabs reported a sync issue"'
```

Gains over today's exporter:

- **Only changes go out.** Today every change re-sends 730 days and every reservation. PriceLabs recommends deltas after the first full send.
- **Cancellations by disappearance** come from the snapshot (`on_delete: send`), replacing `last_export_reservations`.
- **Resumable.** Each acknowledged batch is saved, replacing `export_cursor`.
- **Fixes a bug.** Today cancelled bookings and deleted blocks still mark nights booked or blocked. The calendar endpoint decides that, and it must ignore cancelled rows.

## Hostaway plugin

One plugin, both directions. The binding is one Hostaway listing matched to
one Propool listing; matching stays a manual step in Propool's Hostaway screen.

```yaml
plugin: hostaway
version: 0.1.0
engine: ^0.2
hosts: [https://api.hostaway.com/v1]
limits: { requests_per_minute: 80 }
scopes: [inventory:write, calendar:write, calendar:read, bookings:write, bookings:read]

config:
  account_id: { secret: true }
  api_secret: { secret: true }
  webhook_password: { secret: true }
  timezone: { description: The listing's IANA time zone, e.g. Asia/Bangkok }

auth:
  type: oauth2_client_credentials
  token_url: /accessTokens
  client_id: secrets.account_id
  client_secret: secrets.api_secret
  scope: general
  not_before_ms: 1100                       # E7: Hostaway rejects a token used within a second
  default_ttl_s: 86400
```

### 1. Import (Hostaway → Propool, once per listing)

```yaml
sources:
  listings:                                 # matching picker; multi-unit is skipped
    request: { path: /listings, query: { limit: page.limit, offset: page.offset } }
    paginate: { type: offset, limit: 100 }
    records: response.body.result
    when: '!(has(record.isMultiUnit) && record.isMultiUnit == 1)'
    call:                                   # only on "create new unit"; matched listings skip this
      method: POST
      path: /listings
      body: '{"name": record.name, "bedrooms": int(record.bedroomsNumber), "maxGuests": int(record.personCapacity),
              "latitude": double(record.lat), "longitude": double(record.lng),
              "country": record.countryCode, "currency": record.currencyCode}'

  reservations:
    request:
      path: /reservations
      query: { listingId: binding.hostaway_id, departureStartDate: formatDate(today(config.timezone)),
               limit: page.limit, offset: page.offset }
    paginate: { type: offset, limit: 100 }
    records: response.body.result
    when: record.status in ["new", "modified", "cancelled"]
    call:
      method: PUT                           # upsert by (source, external_id)
      path: /bookings/hostaway/{string(record.id)}
      body: '{"listingId": binding.listing_id,
              "status": record.status == "cancelled" ? "cancelled" : "confirmed",
              "arrival": record.arrivalDate, "departure": record.departureDate,
              "guests": int(record.adults) + int(record.children), "guestName": record.guestName,
              "totalMinor": toMinor(double(record.totalPrice), currencyDigits(upper(record.currency))),
              "currency": upper(record.currency), "channel": record.channelName, "imported": true}'

  calendar:
    request:
      path: /listings/{binding.hostaway_id}/calendar
      query: { startDate: formatDate(today(config.timezone)),
               endDate: formatDate(addDays(today(config.timezone), 395)) }
    records: response.body.result
    call:
      method: PATCH
      path: /listings/{binding.listing_id}/calendar
      body: '{"days": [{"date": record.date, "priceMinor": toMinor(double(record.price), 2),
              "minStay": int(record.minimumStay),
              "closed": record.isAvailable == 0 && size(record.reservations) == 0}]}'
```

The import screen runs these with `dryRun: true` first (preview), then for
real. Propool's ingest rules sit behind `PUT /bookings/hostaway/{id}`:
Channex beats Hostaway, and a Hostaway stay is promoted when Channex sends the
same stay.

### 2. Live updates (Hostaway webhook → Propool)

```yaml
webhooks:
  reservation:
    path: /hostaway
    verify: secureEquals(request.headers.authorization, "Basic " + base64(binding.account_id + ":" + secrets.webhook_password))
    when: request.body.event in ["reservation.created", "reservation.updated"]
    reread:                                 # E6: payload is only a signal; re-read, then reuse the source's call
      source: reservations
      request: { path: '/reservations/{string(request.body.data.id)}' }
```

A 15-minute poll of `reservations` stays as a safety net for missed webhooks.

### 3. Propool → Hostaway

Propool events trigger the sinks; the runner reads Propool's rows through the
public API, and only changed days or bookings are written.

```yaml
sinks:
  calendar:
    read: GET /listings/{binding.listing_id}/calendar?from={today}&days=365
    on: [calendar.updated, booking.created, booking.updated, booking.cancelled]
    key: row.date
    skip: row.booked_by_source == "hostaway"  # echo guard: don't block Hostaway's own stays
    batch: { size: 365 }
    request:
      method: PUT
      path: /listings/{binding.hostaway_id}/calendar
      body: |
        batch.changes.map(c, {"date": c.row.date,
          "price": fromMinor(c.row.price_minor, 2),
          "minimumStay": c.row.min_stay,
          "isAvailable": c.row.available ? 1 : 0})
    ack: response.body.status == "success"
```

Bookings from Propool reach Hostaway as closed dates, not as Hostaway
reservations; that is what the current bridge does and it avoids duplicate
guests in Hostaway.

The current bridge has its own protocol (claim, re-read, note marker, write,
read back) to avoid overwriting edits made in Hostaway. The sink replaces it
with deltas against the last-written snapshot. If Hostaway changed a day we
are about to write, we overwrite it: see open question 1.

## Engine features (0.2)

| | Feature | Needed by |
| --- | --- | --- |
| E1 | Plugin-level `headers` | PriceLabs |
| E2 | `webhooks`: `path`, `verify`, `dedupe_key`, `binding`, then `call` or `reread` | both |
| E3 | Sink deletions: `on_delete`, `c.deleted` | PriceLabs |
| E4 | Sink order: `after` | PriceLabs |
| E5 | Webhook actions: `order`, `resend`, `issue` | PriceLabs |
| E6 | `reread` from a webhook | Hostaway |
| E7 | Auth `not_before_ms` | Hostaway |
| E8 | CEL helpers: `today(tz)`, `addDays`, `formatDate`, `currencyDigits`, `iso3`, `hmacSha256Hex`, `secureEquals`, `base64`, `upper` | both |
| E9 | Public API target: `call` and `read` go to Propool's public API with the install's key; sinks declare `read` and `on` (events) | both |
| E10 | Sink `skip` (echo guard) | Hostaway |

E9 replaces the old domain pack and host ports for Propool: a plugin's
"operations" are public API calls.

## Build order

1. Public API: calendar read, `calendar.updated` and booking lifecycle events, per-install keys.
2. Engine: E9, E1, E8, E3, E4.
3. PriceLabs sinks, run beside the current exporter and compared before switching.
4. Public API: rate recommendations. Engine: E2, E5. PriceLabs `sync` webhook.
5. Public API: calendar write, booking upsert by external id. Engine: E6, E7. Hostaway import and webhook.
6. Engine: E10. Propool → Hostaway sink, replacing the bridge.

## Open questions

1. Who wins when a day was changed in Hostaway and in Propool: Propool always, or skip days Hostaway changed since our last write (needs a read before write)?
2. Hostaway and Channex on the same listing: do both get Propool's updates, or only Channex once a listing moves?
3. Does PriceLabs need `/calendar` again after `/reservations`?
4. Prices in whole baht and THB only today: PriceLabs' limit or Propool's?
