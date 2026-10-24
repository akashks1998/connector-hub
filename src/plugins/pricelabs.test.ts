import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { compilePlugin, handleWebhook, runSinks, type Row } from '../index.js'
import { binding, memoryHost, replayHttp, replayTarget, type Fixture, type TargetFixture } from '../testkit/index.js'
import { pricelabsPlugin } from './pricelabs.js'

const PL = 'https://api.pricelabs.co/v2/integration/api'
const UNIT = '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
// 20:30 UTC is already the 25th in Bangkok.
const NOW = new Date('2026-10-24T20:30:00Z')

const b = binding('b1', {
  unit_id: UNIT,
  pricelabs_listing_id: 'PL_42',
  user_email: 'owner@example.com',
  currency: 'THB',
  timezone: 'Asia/Bangkok',
})
const unit = {
  id: UNIT,
  title: 'Sea View 2BR',
  bedrooms: 2,
  cleaningFeeMinor: 80000,
  location: { city: 'Phuket', countryCode: 'TH', latitude: 7.89, longitude: 98.3 },
  platformListings: [
    { channelCode: 'airbnb', externalId: '1234', url: 'https://airbnb.com/rooms/1234' },
    { channelCode: 'booking_com', externalId: '55', url: null },
    { channelCode: 'agoda', externalId: 'ag-9', url: null },
  ],
}

const day = (date: string, extra: Record<string, unknown> = {}) => ({
  date,
  available: true,
  rateMinor: 450000,
  priceSource: 'base',
  minStay: 2,
  maxStay: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
  bookingId: null,
  bookingProvider: null,
  blockId: null,
  ...extra,
})
const booking = (extra: Record<string, unknown> = {}) => ({
  id: '11111111-2222-4333-8444-555555555555',
  listingId: UNIT,
  status: 'confirmed',
  arrival: '2026-11-02',
  departure: '2026-11-05',
  nights: 3,
  currency: 'THB',
  totalAmountMinor: 1350000,
  channel: 'Airbnb',
  bookedAt: '2026-10-01T08:15:00.000Z',
  receivedAt: '2026-10-01T08:16:00.000Z',
  ...extra,
})

function target(days: unknown[], bookings: unknown[], blocks: unknown[]): TargetFixture[] {
  return [
    { request: { path: `/rental-units/${UNIT}` }, response: { body: unit } },
    { request: { path: `/rental-units/${UNIT}/calendar?from=2026-10-25&to=2027-10-24` }, response: { body: { days } } },
    { request: { path: `/rental-units/${UNIT}/calendar?from=2027-10-25&to=2028-10-23` }, response: { body: { days: [] } } },
    { request: { path: `/bookings?listingId=${UNIT}&limit=100&sort=id` }, response: { body: { data: bookings, nextCursor: null } } },
    { request: { path: `/rental-units/${UNIT}/blocks?from=2020-01-01` }, response: { body: { data: blocks } } },
  ]
}
const accepted = (path: string): Fixture => ({
  request: { method: 'POST', url: `${PL}${path}` },
  response: { body: path === '/listings' ? { successes: ['PL_42'], errors: [] } : { success: ['PL_42'], failure: [] } },
})

const secrets = { b1: { integration_name: 'propool', integration_token: 'tok' } }
const sinks = ['listing', 'calendar', 'calendar_next', 'reservations', 'blocks']

describe('pricelabs plugin', () => {
  const plugin = compilePlugin(pricelabsPlugin)

  it('sends the exporter payloads on the first run, with the integration headers', async () => {
    const http = replayHttp([accepted('/listings'), accepted('/calendar'), accepted('/reservations'), accepted('/reservations')])
    const { ports } = memoryHost({
      http,
      target: replayTarget(
        target(
          [day('2026-10-25'), day('2026-10-26', { available: false, bookingId: 'bk', stopSell: false }), day('2026-10-27', { available: false, blockId: 'bl' })],
          [booking()],
          [{ id: '99999999-8888-4777-8666-555555555555', dateFrom: '2026-12-20', dateTo: '2026-12-27', reason: 'owner_stay', note: null }],
        ),
      ),
      secrets,
      now: NOW,
    })
    await runSinks(plugin, b, sinks, ports)
    const bodies = http.sent.map((r) => [new URL(r.url).pathname.replace('/v2/integration/api', ''), JSON.parse(r.body!)])
    expect(http.sent[0]!.headers).toMatchObject({ 'x-integration-name': 'propool', 'x-integration-token': 'tok' })
    expect(bodies).toEqual([
      [
        '/listings',
        {
          listings: [
            {
              listing_id: 'PL_42',
              user_token: 'owner@example.com',
              name: 'Sea View 2BR',
              status: 'available',
              location: { latitude: 7.89, longitude: 98.3, city: 'Phuket', country: 'THA' },
              number_of_bedrooms: 2,
              listing_fees: { cleaning_fee: { type: 'fixed', value: 800, currency: 'THB' } },
              ota_listing_ids: {
                airbnb: { id: '1234', url: 'https://airbnb.com/rooms/1234' },
                bookingcom: { id: '55' },
                other: { agoda: { id: 'ag-9' } },
              },
            },
          ],
        },
      ],
      [
        '/calendar',
        {
          calendars: [
            {
              listing_id: 'PL_42',
              currency: 'THB',
              data: [
                { date: '2026-10-25', end_date: '2026-10-25', price: 4500, available_units: 1, booked_units: 0, blocked_units: 0, settings: { min_stay: 2 } },
                { date: '2026-10-26', end_date: '2026-10-26', price: 4500, available_units: 0, booked_units: 1, blocked_units: 0, settings: { min_stay: 2 } },
                { date: '2026-10-27', end_date: '2026-10-27', price: 4500, available_units: 0, booked_units: 0, blocked_units: 1, settings: { min_stay: 2 } },
              ],
            },
          ],
        },
      ],
      [
        '/reservations',
        {
          reservations: [
            {
              listing_id: 'PL_42',
              data: [
                {
                  reservation_id: 'propool_booking_11111111222243338444555555555555',
                  currency: 'THB',
                  start_date: '2026-11-02',
                  end_date: '2026-11-05',
                  booked_time: '2026-10-01 08:15:00',
                  total_days: 3,
                  total_cost: 13500,
                  status: 'booked',
                  booking_source: 'Airbnb',
                },
              ],
            },
          ],
        },
      ],
      [
        '/reservations',
        {
          reservations: [
            {
              listing_id: 'PL_42',
              data: [
                {
                  reservation_id: 'propool_block_99999999888847778666555555555555',
                  currency: 'THB',
                  start_date: '2026-12-20',
                  end_date: '2026-12-28',
                  total_days: 8,
                  total_cost: 0,
                  status: 'blocked',
                  booking_source: 'propool',
                },
              ],
            },
          ],
        },
      ],
    ])
  })

  it('later sends only what changed: a new price, a cancellation, a removed block', async () => {
    const first = memoryHost({
      http: replayHttp([accepted('/listings'), accepted('/calendar'), accepted('/reservations'), accepted('/reservations')]),
      target: replayTarget(
        target([day('2026-10-25'), day('2026-10-26')], [booking()], [{ id: 'blk-1', dateFrom: '2026-12-20', dateTo: '2026-12-21' }]),
      ),
      secrets,
      now: NOW,
    })
    await runSinks(plugin, b, sinks, first.ports)

    const http = replayHttp([accepted('/calendar'), accepted('/reservations'), accepted('/reservations')])
    const next = memoryHost({
      http,
      target: replayTarget(target([day('2026-10-25'), day('2026-10-26', { rateMinor: 470000 })], [booking({ status: 'cancelled' })], [])),
      secrets,
      now: NOW,
    })
    for (const [k, v] of first.remote) next.remote.set(k, new Map(v) as Map<string, Row>)
    const results = await runSinks(plugin, b, sinks, next.ports)
    expect(results.get('listing')!.plan).toEqual([])
    const bodies = http.sent.map((r) => JSON.parse(r.body!))
    expect(bodies[0].calendars[0].data.map((d: { date: string; price: number }) => [d.date, d.price])).toEqual([['2026-10-26', 4700]])
    expect(bodies[1].reservations[0].data[0]).toMatchObject({ status: 'canceled' })
    expect(bodies[2].reservations[0].data[0]).toMatchObject({ reservation_id: 'propool_block_blk1', status: 'canceled' })
    expect([...next.remote.get('b1/blocks')!.keys()]).toEqual(['#config'])
  })
  it('leaves out what the unit lacks, and a binding city or country wins', async () => {
    const bare = { ...unit, bedrooms: null, cleaningFeeMinor: null, platformListings: [] }
    const http = replayHttp([accepted('/listings')])
    const { ports } = memoryHost({
      http,
      target: replayTarget([{ request: { path: `/rental-units/${UNIT}` }, response: { body: bare } }]),
      secrets,
      now: NOW,
    })
    const custom = binding('b1', { ...b.config, city: 'Karon', country: 'THA' })
    await runSinks(plugin, custom, ['listing'], ports)
    expect(JSON.parse(http.sent[0]!.body!).listings[0]).toEqual({
      listing_id: 'PL_42',
      user_token: 'owner@example.com',
      name: 'Sea View 2BR',
      status: 'available',
      location: { latitude: 7.89, longitude: 98.3, city: 'Karon', country: 'THA' },
    })
  })

  it('fails the listing rather than send a unit with no location', async () => {
    const { ports } = memoryHost({
      http: replayHttp([]),
      target: replayTarget([
        { request: { path: `/rental-units/${UNIT}` }, response: { body: { ...unit, location: { ...unit.location, latitude: null } } } },
      ]),
      secrets,
      now: NOW,
    })
    await expect(runSinks(plugin, b, ['listing'], ports)).rejects.toThrow()
  })
})

describe('pricelabs webhooks', () => {
  const plugin = compilePlugin(pricelabsPlugin)
  const token = 'tok'
  const sign = (body: string, requestId = 'req-1') => {
    const headers = { 'x-source': 'pricelabs', 'x-pl-timestamp': '1761300000', 'x-pl-requestid': requestId }
    const signedHeaders = `v1.${createHmac('sha256', token).update(`v1:pricelabs:1761300000:${requestId}`).digest('hex')}`
    const signedBody = createHmac('sha256', token).update(signedHeaders).update(body).digest('hex')
    return { ...headers, 'X-PL-Signed-Headers': signedHeaders, 'x-pl-signed-body': signedBody }
  }
  const host = (target: TargetFixture[] = []) =>
    memoryHost({ http: replayHttp([]), target: replayTarget(target), secrets, now: NOW, webhookBindings: { PL_42: b } })
  const sync = JSON.stringify({
    listing_id: 'PL_42',
    last_refreshed: '2026-10-24T06:00:00Z',
    data: [
      { date: '2026-11-02', price: 4800, min_stay: 3 },
      { date: '2026-11-03', price: 4750.5 },
    ],
  })

  it('takes new prices from a signed sync, once', async () => {
    const target = replayTarget([{ request: { method: 'POST', path: `/rental-units/${UNIT}/rate-recommendations` }, response: { body: { success: true } } }])
    const { ports } = memoryHost({ http: replayHttp([]), target, secrets, now: NOW, webhookBindings: { PL_42: b } })
    const request = { method: 'POST', path: '/sync', headers: sign(sync), body: sync }
    const result = await handleWebhook(plugin, request, ports)
    expect(result).toMatchObject({ webhook: 'sync', bindingId: 'b1', outcome: 'done', status: 200 })
    const body = JSON.parse(target.sent[0]!.body!)
    expect(body).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      generatedAt: '2026-10-24T06:00:00Z',
      days: [
        { date: '2026-11-02', rateMinor: 480000, minStay: 3 },
        { date: '2026-11-03', rateMinor: 475050 },
      ],
    })
    await expect(handleWebhook(plugin, request, ports)).resolves.toMatchObject({ outcome: 'duplicate', status: 200 })
    expect(target.sent).toHaveLength(1)
  })

  it('answers the URL probe and refuses a bad signature or an unknown listing', async () => {
    const { ports } = host()
    await expect(handleWebhook(plugin, { method: 'POST', path: '/sync', headers: {}, body: '{"verify": true}' }, ports)).resolves.toMatchObject({
      outcome: 'ping',
      status: 200,
    })
    const forged = { ...sign(sync), 'x-pl-signed-body': '0'.repeat(64) }
    await expect(handleWebhook(plugin, { method: 'POST', path: '/sync', headers: forged, body: sync }, ports)).resolves.toMatchObject({
      outcome: 'unverified',
      status: 401,
    })
    const tampered = sync.replace('4800', '1')
    await expect(handleWebhook(plugin, { method: 'POST', path: '/sync', headers: sign(sync), body: tampered }, ports)).resolves.toMatchObject({
      outcome: 'unverified',
    })
    await expect(handleWebhook(plugin, { method: 'POST', path: '/sync', headers: {}, body: sync }, ports)).resolves.toMatchObject({ outcome: 'unverified' })
    const other = sync.replace('PL_42', 'PL_7')
    await expect(handleWebhook(plugin, { method: 'POST', path: '/sync', headers: sign(other), body: other }, ports)).resolves.toMatchObject({
      outcome: 'unknown_binding',
      status: 404,
    })
    await expect(handleWebhook(plugin, { method: 'POST', path: '/nope', headers: {}, body: '' }, ports)).resolves.toMatchObject({ outcome: 'unknown_path' })
  })

  it('a calendar request forgets the snapshots so the next run sends everything', async () => {
    const h = host()
    h.remote.set('b1/calendar', new Map([['2026-10-25', { date: '2026-10-25' }], ['#config', {}]]))
    const body = '{"listing_id": "PL_42"}'
    const result = await handleWebhook(plugin, { method: 'POST', path: '/calendar', headers: sign(body, 'req-9'), body }, h.ports)
    expect(result).toMatchObject({ outcome: 'done', resend: ['listing', 'calendar', 'calendar_next', 'reservations', 'blocks'] })
    expect(h.remote.get('b1/calendar')!.size).toBe(0)
  })

  it('a failed sync is reported as an issue', async () => {
    const body = '{"_json": {"API_FAILED_SYNC": "PL_42"}}'
    const result = await handleWebhook(plugin, { method: 'POST', path: '/hook', headers: sign(body, 'req-3'), body }, host().ports)
    expect(result).toMatchObject({ outcome: 'done', issue: 'PriceLabs could not sync this listing' })
  })
})
