import { describe, expect, it } from 'vitest'
import { compilePlugin, runSinks, type Row } from '../index.js'
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
  city: 'Phuket',
  country: 'THA',
  currency: 'THB',
  timezone: 'Asia/Bangkok',
})

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
    { request: { path: `/rental-units/${UNIT}` }, response: { body: { id: UNIT, title: 'Sea View 2BR', latitude: 7.89, longitude: 98.3 } } },
    { request: { path: `/rental-units/${UNIT}/calendar?from=2026-10-25&to=2027-10-24` }, response: { body: { days } } },
    { request: { path: `/rental-units/${UNIT}/calendar?from=2027-10-25&to=2028-10-23` }, response: { body: { days: [] } } },
    { request: { path: `/bookings?listingId=${UNIT}&limit=100` }, response: { body: { data: bookings, nextCursor: null } } },
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
})
