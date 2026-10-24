import { describe, expect, it } from 'vitest'
import { compilePlugin, handleWebhook, runSink, runSource, type Row } from '../index.js'
import { binding, memoryHost, replayHttp, replayTarget, type Fixture, type TargetFixture } from '../testkit/index.js'
import { hostawayPlugin } from './hostaway.js'

const HA = 'https://api.hostaway.com/v1'
const UNIT = '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const MARK = `[Propool:${UNIT}]`
// 20:30 UTC is already the 25th in Bangkok.
const NOW = new Date('2026-10-24T20:30:00Z')
const b = binding('b1', { webhook_login: 'login-1', unit_id: UNIT, hostaway_listing_id: '4242', timezone: 'Asia/Bangkok' })
const secrets = { b1: { account_id: '99', api_secret: 'sec', webhook_password: 'pw-123456' } }

const reservation = (extra: Record<string, unknown> = {}) => ({
  id: 555,
  listingMapId: 4242,
  status: 'new',
  arrivalDate: '2026-11-02',
  departureDate: '2026-11-05',
  guestFirstName: 'Ava',
  guestLastName: 'Khan',
  guestName: 'Ava Khan',
  guestEmail: 'ava@example.com',
  phone: '+66 81 000 0000',
  guestCountry: 'gb',
  adults: 2,
  children: null,
  totalPrice: 13500.5,
  currency: 'thb',
  channelName: 'airbnbOfficial',
  confirmationCode: 'HMX123',
  updatedOn: '2026-10-20 08:15:00',
  insertedOn: '2026-10-01 08:00:00',
  reservationDate: '2026-10-01 07:59:00',
  ...extra,
})
const haDay = (date: string, extra: Record<string, unknown> = {}) => ({ date, status: 'available', isAvailable: 1, note: null, ...extra })
const night = (date: string, extra: Record<string, unknown> = {}) => ({
  date,
  available: true,
  rateMinor: 450000,
  bookingId: null,
  bookingProvider: null,
  blockId: null,
  blockProvider: null,
  ...extra,
})

function host(http: Fixture[], target: TargetFixture[] = []) {
  const replay = replayHttp(http)
  const t = replayTarget(target)
  const h = memoryHost({ http: replay, target: t, secrets, now: NOW, webhookBindings: { '4242': b } })
  // A cached token, so tests skip the token call and its one-second wait.
  h.tokens.set('b1', { value: 'tok', expiresAt: new Date(NOW.getTime() + 3_600_000) })
  return { ...h, http: replay, target: t }
}

describe('hostaway plugin', () => {
  const plugin = compilePlugin(hostawayPlugin)

  it('imports reservations as provider bookings, skipping inquiries and other listings', async () => {
    const h = host(
      [
        {
          request: { url: `${HA}/reservations?listingId=4242&departureStartDate=2026-10-25&includeResources=1&limit=100&offset=0` },
          response: {
            body: {
              result: [
                reservation(),
                reservation({ id: 556, status: 'inquiry' }),
                reservation({ id: 557, listingMapId: 7 }),
                reservation({ id: 558, status: 'cancelled', channelName: 'somethingNew', guestFirstName: '', reservationDate: null, confirmationCode: null }),
              ],
            },
          },
        },
        { request: { url: `${HA}/reservations?listingId=4242&departureStartDate=2026-10-25&includeResources=1&limit=100&offset=4` }, response: { body: { result: [] } } },
      ],
      [
        { request: { method: 'PUT', path: '/bookings/by-provider/hostaway/555' }, response: { body: {} } },
        { request: { method: 'PUT', path: '/bookings/by-provider/hostaway/558' }, response: { body: {} } },
      ],
    )
    const result = await runSource(plugin, b, 'reservations', h.ports)
    expect(h.http.sent[0]!.headers.authorization).toBe('Bearer tok')
    expect(result.calls.map((c) => JSON.parse(c.body!))).toEqual([
      {
        unitId: UNIT,
        status: 'confirmed',
        arrival: '2026-11-02',
        departure: '2026-11-05',
        guest: { firstName: 'Ava', lastName: 'Khan', email: 'ava@example.com', phone: '+66 81 000 0000', country: 'GB' },
        adults: 2,
        children: 0,
        infants: 0,
        totalAmountMinor: 1350050,
        currency: 'THB',
        channelName: 'Airbnb',
        confirmationCode: 'HMX123',
        updatedAt: '2026-10-20T08:15:00Z',
        bookedAt: '2026-10-01T07:59:00Z',
        change: 'created',
        imported: false,
      },
      expect.objectContaining({
        status: 'cancelled',
        guest: expect.objectContaining({ firstName: 'Ava Khan' }),
        channelName: 'somethingNew',
        confirmationCode: 'HA-558',
        change: 'modified',
      }),
    ])
    expect(JSON.parse(result.calls[1]!.body!)).not.toHaveProperty('bookedAt')
  })

  it("sends Hostaway's closed nights, leaving out the ones Propool closed", async () => {
    const h = host(
      [
        {
          request: { url: `${HA}/listings/4242/calendar?startDate=2026-10-25&endDate=2027-10-24&includeResources=1` },
          response: {
            body: {
              result: [
                haDay('2026-10-25'),
                haDay('2026-10-26', { status: 'blocked', isAvailable: 0, note: 'owner' }),
                haDay('2026-10-27', { status: 'reserved', isAvailable: 0 }),
                haDay('2026-10-28', { status: 'blocked', isAvailable: 0, note: `x\n[Propool:old-mapping]` }),
                haDay('2026-10-29', { isAvailable: 0 }),
              ],
            },
          },
        },
      ],
      [{ request: { method: 'PUT', path: `/rental-units/${UNIT}/provider-closures/hostaway` }, response: { body: { added: 3, removed: 0, coveredByBookings: 0 } } }],
    )
    const result = await runSource(plugin, b, 'closures', h.ports)
    expect(JSON.parse(result.calls[0]!.body!)).toEqual({
      from: '2026-10-25',
      to: '2027-10-24',
      dates: ['2026-10-26', '2026-10-27', '2026-10-29'],
      reserved: ['2026-10-27'],
    })
  })

  describe('calendar to Hostaway', () => {
    const read = (days: unknown[]): TargetFixture => ({
      request: { path: `/rental-units/${UNIT}/calendar?from=2026-10-25&to=2027-10-24` },
      response: { body: { days } },
    })
    const check = (date: string, day: unknown): Fixture => ({
      request: { url: `${HA}/listings/4242/calendar?startDate=${date}&endDate=${date}` },
      response: { body: { result: [day] } },
    })
    const write: Fixture = { request: { method: 'PUT', url: `${HA}/listings/4242/calendar` }, response: { body: { status: 'success' } } }

    it("closes open days with a marker, reports a day Hostaway changed, and skips Hostaway's own nights", async () => {
      const h = host(
        [check('2026-10-26', haDay('2026-10-26', { note: 'clean' })), write, check('2026-10-27', haDay('2026-10-27', { status: 'blocked', isAvailable: 0, note: 'owner' }))],
        [
          read([
            night('2026-10-25'),
            night('2026-10-26', { available: false, blockId: 'blk' }),
            night('2026-10-27', { available: false, bookingId: 'bk', bookingProvider: 'channex' }),
            night('2026-10-28', { available: false, bookingId: 'bk2', bookingProvider: 'hostaway' }),
            night('2026-10-29', { available: false, blockId: 'blk2', blockProvider: 'hostaway' }),
          ]),
        ],
      )
      const result = await runSink(plugin, b, 'calendar', h.ports)
      // Each day is checked right before it is written.
      expect(h.http.sent.map((r) => r.method)).toEqual(['GET', 'PUT', 'GET'])
      const puts = h.http.sent.filter((r) => r.method === 'PUT')
      expect(puts.map((r) => JSON.parse(r.body!))).toEqual([{ startDate: '2026-10-26', endDate: '2026-10-26', isAvailable: 0, note: `clean\n${MARK}` }])
      expect(result.conflicts.map((c) => c.row.date)).toEqual(['2026-10-27'])
      // The conflict is not saved, so the next run checks it again.
      expect([...h.remote.get('b1/calendar')!.keys()].sort()).toEqual(['#config', '["2026-10-26"]'])
    })

    it('releases a day Propool closed, giving the note back, but not one Hostaway took over', async () => {
      const h = host(
        [
          check('2026-10-26', haDay('2026-10-26', { status: 'blocked', isAvailable: 0, note: `clean\n${MARK}` })),
          write,
          check('2026-10-27', haDay('2026-10-27', { status: 'reserved', isAvailable: 0, note: MARK })),
        ],
        [read([night('2026-10-25')])],
      )
      h.remote.set(
        'b1/calendar',
        new Map<string, Row>([
          ['#config', { config: JSON.stringify(b.config) }],
          ['["2026-10-26"]', night('2026-10-26', { available: false }) as Row],
          ['["2026-10-27"]', night('2026-10-27', { available: false }) as Row],
        ]),
      )
      const result = await runSink(plugin, b, 'calendar', h.ports)
      const puts = h.http.sent.filter((r) => r.method === 'PUT')
      expect(puts.map((r) => JSON.parse(r.body!))).toEqual([{ startDate: '2026-10-26', endDate: '2026-10-26', isAvailable: 1, note: 'clean' }])
      expect(result.conflicts.map((c) => [c.row.date, c.deleted])).toEqual([['2026-10-27', true]])
    })
  })

  it('rereads the reservation a webhook names, after checking its Basic auth', async () => {
    const h = host(
      [{ request: { url: `${HA}/reservations/555` }, response: { body: { result: reservation({ status: 'modified' }) } } }],
      [{ request: { method: 'PUT', path: '/bookings/by-provider/hostaway/555' }, response: { body: {} } }],
    )
    const body = JSON.stringify({ event: 'reservation.updated', data: { id: 555, listingMapId: 4242 } })
    const auth = { authorization: `Basic ${Buffer.from('login-1:pw-123456').toString('base64')}` }
    await expect(handleWebhook(plugin, { method: 'POST', path: '/reservation', headers: { authorization: 'Basic bm9wZQ==' }, body }, h.ports)).resolves.toMatchObject({
      outcome: 'unverified',
    })
    const result = await handleWebhook(plugin, { method: 'POST', path: '/reservation', headers: auth, body }, h.ports)
    expect(result).toMatchObject({ outcome: 'done', bindingId: 'b1' })
    expect(JSON.parse(result.calls[0]!.body!)).toMatchObject({ status: 'confirmed', change: 'modified' })
    // The account's other events and listings are acknowledged, so Hostaway keeps the webhook on.
    for (const other of [
      { event: 'message.received', data: { id: 1 } },
      { event: 'reservation.created', data: { id: 2, listingMapId: 7 } },
      { event: 'reservation.created', data: { id: 3 } },
    ]) {
      await expect(
        handleWebhook(plugin, { method: 'POST', path: '/reservation', headers: {}, body: JSON.stringify(other) }, h.ports),
      ).resolves.toMatchObject({ outcome: 'ignored', status: 200 })
    }
  })
})
