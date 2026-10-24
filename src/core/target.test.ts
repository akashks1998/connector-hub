import type { PluginInput } from '../spec/index.js'
import { binding, memoryHost, replayHttp, replayTarget, type Fixture, type TargetFixture } from '../testkit/index.js'
import { describe, expect, it } from 'vitest'
import { compilePlugin, ConnectorError, orderSinks, PluginValidationError, runSink, runSinks, runSource, sinksFor } from './index.js'

const API = 'https://api.pricing.test/v2'
const NOW = new Date('2026-10-24T20:30:00Z')

/** A pricing tool fed from the host's API: listing first, then the calendar, then reservations. */
const pricing: PluginInput = {
  plugin: 'pricing-tool',
  version: '0.1.0',
  engine: '^0.2',
  hosts: [API],
  config: {
    token: { secret: true },
    unit_id: {},
    timezone: {},
  },
  headers: { 'x-integration-token': 'secrets.token' },
  sinks: {
    listing: {
      read: { path: '/rental-units/{config.unit_id}', records: '[response.body]' },
      key: 'row.id',
      fields: ['id', 'title'],
      on: ['listing.updated'],
      batch: { size: 1 },
      request: { method: 'POST', path: '/listings', body: '{"listings": batch.changes.map(c, {"id": c.row.id, "name": c.row.title})}' },
    },
    calendar: {
      after: ['listing'],
      read: {
        path: '/rental-units/{config.unit_id}/calendar',
        query: { from: 'dateIn(now, config.timezone)', to: 'addDays(dateIn(now, config.timezone), 2)' },
        records: 'response.body.days',
      },
      key: 'row.date',
      fields: ['date', 'rateMinor'],
      skip: 'has(row.bookingProvider) && row.bookingProvider == "pricing-tool"',
      on: ['calendar.updated', 'booking.created'],
      batch: { size: 100 },
      request: {
        method: 'POST',
        path: '/calendar',
        body: '{"data": batch.changes.map(c, {"date": c.row.date, "price": fromMinor(c.row.rateMinor, 2)})}',
      },
      ack: 'size(response.body.failure) == 0',
    },
    reservations: {
      after: ['listing'],
      read: {
        path: '/bookings',
        query: { listingId: 'config.unit_id', cursor: 'page.cursor' },
        records: 'response.body.data',
        paginate: { type: 'cursor', next: 'response.body.nextCursor' },
      },
      key: 'row.id',
      fields: ['id', 'status', 'arrival'],
      on: ['booking.created'],
      on_delete: 'send',
      request: {
        method: 'POST',
        path: '/reservations',
        body: '{"data": batch.changes.map(c, {"id": c.row.id, "status": c.deleted || c.row.status == "cancelled" ? "canceled" : "booked"})}',
      },
    },
  },
}

const unit = (title = 'Sea View 2BR'): TargetFixture => ({ request: { path: '/rental-units/u1' }, response: { body: { id: 'u1', title } } })
const calendar = (days: unknown[]): TargetFixture => ({
  request: { path: '/rental-units/u1/calendar?from=2026-10-25&to=2026-10-27' },
  response: { body: { days } },
})
const ok = (path: string, body: unknown = { failure: [] }): Fixture => ({ request: { method: 'POST', url: `${API}${path}` }, response: { body: body as never } })

function host(target: TargetFixture[], http: Fixture[]) {
  const t = replayTarget(target)
  const h = replayHttp(http)
  return { t, h, ...memoryHost({ http: h, target: t, secrets: { b1: { token: 'tok-123' } }, now: NOW }) }
}

const b = binding('b1', { unit_id: 'u1', timezone: 'Asia/Bangkok' })

describe('compile: target mode', () => {
  it('needs no domain pack', () => {
    expect(compilePlugin(pricing).domain).toBeNull()
  })

  it('refuses domain features without a domain, and sinks without a key', () => {
    const bad = {
      ...pricing,
      owns: { listing: ['name'] },
      sources: {
        s: { request: { path: '/x' }, records: 'response.body', emit: [{ operation: 'upsert_listing', fields: { external_id: 'record.id' } }] },
      },
      sinks: {
        a: { input: { entity: 'listing', fields: ['name'] }, request: { path: '/a' } },
        b: { read: { path: '/b', records: 'response.body' }, request: { path: '/b' } },
      },
    }
    expect(() => compilePlugin(bad)).toThrow(PluginValidationError)
    try {
      compilePlugin({ ...bad, sinks: { a: bad.sinks.a } })
    } catch (e) {
      expect((e as PluginValidationError).problems).toEqual(
        expect.arrayContaining(['sources.s.emit: needs a domain; use call', 'sinks.a.input: needs a domain; use read', 'owns: needs a domain']),
      )
    }
    expect(() => compilePlugin({ ...pricing, sinks: { b: bad.sinks.b } })).toThrow(/a sink with read needs key/)
  })

  it('checks after, plugin headers and target paths', () => {
    const problems = (input: unknown) => {
      try {
        compilePlugin(input)
        return []
      } catch (e) {
        return (e as PluginValidationError).problems
      }
    }
    const sink = pricing.sinks!.listing!
    expect(
      problems({ ...pricing, sinks: { a: { ...sink, after: ['b'] }, b: { ...sink, after: ['a'] }, c: { ...sink, after: ['nope'] } } }),
    ).toEqual(expect.arrayContaining(['sinks.c.after: unknown sink nope', 'sinks: after forms a cycle: a → b → a']))
    expect(problems({ ...pricing, headers: { Authorization: 'secrets.token' } })).toEqual(['headers: authorization is set by the engine or host'])
    expect(problems({ ...pricing, sinks: { a: { ...sink, read: { path: '/../admin', records: '[]' } } } })).toEqual([
      'sinks.a.read.path: "." and ".." segments are not allowed',
    ])
    expect(problems({ ...pricing, headers: { 'x-a': 'secrets.other' } })).toEqual(['headers.x-a: secrets.other is not a declared secret config field'])
  })
})

describe('sinks in target mode', () => {
  it('sends everything once, then only changes, with the plugin headers', async () => {
    const plugin = compilePlugin(pricing)
    const days = [
      { date: '2026-10-25', rateMinor: 450000, available: true },
      { date: '2026-10-26', rateMinor: 450000, available: true },
    ]
    const first = host([calendar(days)], [ok('/calendar')])
    const result = await runSink(plugin, b, 'calendar', first.ports)
    expect(result.sent).toBe(1)
    expect(JSON.parse(first.h.sent[0]!.body!)).toEqual({
      data: [
        { date: '2026-10-25', price: 4500 },
        { date: '2026-10-26', price: 4500 },
      ],
    })
    expect(first.h.sent[0]!.headers['x-integration-token']).toBe('tok-123')
    // Only the compared fields are kept as the last write.
    expect([...first.remote.get('b1/calendar')!.values()][0]).toEqual({ date: '2026-10-25', rateMinor: 450000 })

    // Next run: one price changed, `available` changed too but is not compared.
    const next = host([calendar([{ ...days[0], available: false }, { ...days[1], rateMinor: 470000 }])], [ok('/calendar')])
    next.remote.set('b1/calendar', first.remote.get('b1/calendar')!)
    const again = await runSink(plugin, b, 'calendar', next.ports)
    expect(again.plan.map((p) => p.changes.map((c) => c.key))).toEqual([['["2026-10-26"]']])
  })

  it('leaves skipped rows alone and fails an unacknowledged batch without saving it', async () => {
    const plugin = compilePlugin(pricing)
    const h = host(
      [calendar([{ date: '2026-10-25', rateMinor: 1, bookingProvider: 'pricing-tool' }, { date: '2026-10-26', rateMinor: 2 }])],
      [ok('/calendar', { failure: ['2026-10-26'] })],
    )
    h.remote.set('b1/calendar', new Map([['["2026-10-25"]', { date: '2026-10-25', rateMinor: 9 }]]))
    const error = await runSink(plugin, b, 'calendar', h.ports).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConnectorError)
    expect((error as ConnectorError).message).toMatch(/did not acknowledge/)
    expect(JSON.parse(h.h.sent[0]!.body!).data).toEqual([{ date: '2026-10-26', price: 0.02 }])
    expect([...h.remote.get('b1/calendar')!.keys()]).toEqual(['["2026-10-25"]'])
  })

  it('reads every page, sends deletions once with their last values, then forgets them', async () => {
    const plugin = compilePlugin(pricing)
    const page = (cursor: string | null, data: unknown[], next: string | null): TargetFixture => ({
      request: { path: `/bookings?listingId=u1${cursor ? `&cursor=${cursor}` : ''}` },
      response: { body: { data, nextCursor: next } },
    })
    const h = host(
      [page(null, [{ id: 'k1', status: 'confirmed', arrival: '2026-11-01', guest: 'x' }], 'c2'), page('c2', [], null)],
      [ok('/reservations')],
    )
    h.remote.set(
      'b1/reservations',
      new Map([
        ['["k1"]', { id: 'k1', status: 'confirmed', arrival: '2026-11-01' }],
        ['["k0"]', { id: 'k0', status: 'confirmed', arrival: '2026-10-01' }],
      ]),
    )
    const result = await runSink(plugin, b, 'reservations', h.ports)
    expect(result.plan[0]!.changes).toEqual([
      { key: '["k0"]', row: { id: 'k0', status: 'confirmed', arrival: '2026-10-01' }, previous: { id: 'k0', status: 'confirmed', arrival: '2026-10-01' }, deleted: true },
    ])
    expect(JSON.parse(h.h.sent[0]!.body!)).toEqual({ data: [{ id: 'k0', status: 'canceled' }] })
    expect([...h.remote.get('b1/reservations')!.keys()]).toEqual(['["k1"]'])
  })

  it('forgets rows that disappear when on_delete is ignore', async () => {
    const plugin = compilePlugin(pricing)
    const h = host([calendar([])], [])
    h.remote.set('b1/calendar', new Map([['["2026-10-01"]', { date: '2026-10-01', rateMinor: 1 }]]))
    const result = await runSink(plugin, b, 'calendar', h.ports)
    expect(result.plan).toEqual([])
    expect(h.remote.get('b1/calendar')!.size).toBe(0)
  })

  it('reports target failures with the host message, and a rejected key as config', async () => {
    const plugin = compilePlugin(pricing)
    const fail = (status: number) =>
      host([{ request: { path: '/rental-units/u1' }, response: { status, body: { message: 'Rental unit not found', reason: 'not_found' } } }], [])
    const notFound = await runSink(plugin, b, 'listing', fail(404).ports).catch((e: unknown) => e as ConnectorError)
    expect(notFound).toMatchObject({ kind: 'permanent', message: 'target GET /rental-units/u1 returned 404: Rental unit not found (not_found)' })
    await expect(runSink(plugin, b, 'listing', fail(401).ports)).rejects.toMatchObject({ kind: 'config' })
    await expect(runSink(plugin, b, 'listing', fail(503).ports)).rejects.toMatchObject({ kind: 'retryable' })
  })

  it('refuses to run without a required secret', async () => {
    const { ports } = memoryHost({ http: replayHttp([]), target: replayTarget([unit()]), now: NOW })
    await expect(runSink(compilePlugin(pricing), b, 'listing', ports)).rejects.toMatchObject({
      kind: 'config',
      message: 'binding b1: secret token is required',
    })
  })

  it('orders sinks by after, and maps events to sinks', async () => {
    const plugin = compilePlugin(pricing)
    expect(orderSinks(plugin, ['reservations', 'calendar', 'listing'])).toEqual(['listing', 'calendar', 'reservations'])
    expect(sinksFor(plugin, 'booking.created')).toEqual(['calendar', 'reservations'])
    expect(sinksFor(plugin, 'nothing')).toEqual([])
    const h = host([unit(), calendar([])], [ok('/listings')])
    const results = await runSinks(plugin, b, ['calendar', 'listing'], h.ports)
    expect([...results.keys()]).toEqual(['listing', 'calendar'])
    expect(h.t.sent.map((r) => r.path)).toEqual(['/rental-units/u1', '/rental-units/u1/calendar?from=2026-10-25&to=2026-10-27'])
  })
})

describe('sources with call', () => {
  const importer: PluginInput = {
    plugin: 'pms-import',
    version: '0.1.0',
    engine: '^0.2',
    hosts: [API],
    config: { unit_id: {} },
    sources: {
      reservations: {
        request: { path: '/reservations', query: { since: 'cursor' } },
        records: 'response.body.result',
        when: 'record.status != "inquiry"',
        call: {
          method: 'PUT',
          path: '/bookings/by-provider/pms/{string(record.id)}',
          body: '{"unitId": config.unit_id, "status": record.status, "imported": cursor == null}',
        },
        cursor: { value: 'record.updatedOn' },
      },
    },
  }
  const reservations: Fixture = {
    request: { url: `${API}/reservations` },
    response: {
      body: {
        result: [
          { id: 7, status: 'confirmed', updatedOn: '2026-10-20T00:00:00Z' },
          { id: 8, status: 'inquiry', updatedOn: '2026-10-21T00:00:00Z' },
        ],
      },
    },
  }

  it('plans the calls in a dry run and sends nothing', async () => {
    const plugin = compilePlugin(importer)
    const h = host([], [reservations])
    const result = await runSource(plugin, binding('b1', { unit_id: 'u1' }), 'reservations', h.ports, { dryRun: true })
    expect(result.calls).toEqual([
      { method: 'PUT', path: '/bookings/by-provider/pms/7', body: '{"unitId":"u1","status":"confirmed","imported":true}' },
    ])
    expect(h.t.sent).toEqual([])
    expect(h.cursors.size).toBe(0)
  })

  it('sends the calls, then moves the cursor; a refused call keeps it', async () => {
    const plugin = compilePlugin(importer)
    const good = host([{ request: { method: 'PUT', path: '/bookings/by-provider/pms/7' }, response: { body: { id: 'x' } } }], [reservations])
    await runSource(plugin, binding('b1', { unit_id: 'u1' }), 'reservations', good.ports)
    expect(good.t.pending()).toEqual([])
    expect(good.cursors.get('b1/reservations')).toBe('2026-10-21T00:00:00Z')

    const refused = host(
      [{ request: { method: 'PUT', path: '/bookings/by-provider/pms/7' }, response: { status: 409, body: { message: 'This unit is not connected to pms' } } }],
      [reservations],
    )
    await expect(runSource(plugin, binding('b1', { unit_id: 'u1' }), 'reservations', refused.ports)).rejects.toMatchObject({
      kind: 'permanent',
      message: 'sources.reservations: target PUT /bookings/by-provider/pms/7 returned 409: This unit is not connected to pms (call 1 of 1)',
    })
    expect(refused.cursors.size).toBe(0)
  })

  it('needs a target port', async () => {
    const plugin = compilePlugin(importer)
    const { ports } = memoryHost({ http: replayHttp([reservations]) })
    await expect(runSource(plugin, binding('b1', { unit_id: 'u1' }), 'reservations', ports)).rejects.toMatchObject({ kind: 'config' })
  })
})
