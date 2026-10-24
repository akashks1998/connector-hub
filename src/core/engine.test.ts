import { strDomain } from '../domains/str/index.js'
import type { PluginInput } from '../spec/index.js'
import { binding, memoryHost, replayHttp, type Fixture } from '../testkit/index.js'
import { describe, expect, it } from 'vitest'
import { compilePlugin, ConnectorError, PluginValidationError, runSink, runSource } from './index.js'

const API = 'https://api.acme.test'

/** A fictional PMS: OAuth client credentials, offset paging, incremental reservations, availability write-back. */
const acme: PluginInput = {
  plugin: 'acme-pms',
  version: '1.0.0',
  engine: '^0.1',
  domain: { name: 'str', version: '^0.1' },
  hosts: [API],
  config: {
    account_id: { secret: true },
    api_secret: { secret: true },
    currency: { required: false },
  },
  auth: {
    type: 'oauth2_client_credentials',
    token_url: '/v1/accessTokens',
    client_id: 'secrets.account_id',
    client_secret: 'secrets.api_secret',
    scope: 'general',
  },
  sources: {
    reservations: {
      request: {
        path: '/v1/reservations',
        query: { limit: 'page.limit', offset: 'page.offset', updatedSince: 'cursor' },
      },
      paginate: { type: 'offset', limit: 2 },
      records: 'response.body.result',
      emit: [
        {
          operation: 'upsert_booking',
          when: 'record.status != "test"',
          fields: {
            external_id: 'string(record.id)',
            listing_id: 'string(record.listingMapId)',
            status: 'record.status == "cancelled" ? "cancelled" : "confirmed"',
            check_in: 'record.arrivalDate',
            check_out: 'record.departureDate',
            total_minor: 'toMinor(double(record.totalPrice), 2)',
            revision: 'record.updatedOn',
          },
        },
      ],
      cursor: { value: 'record.updatedOn' },
    },
  },
  sinks: {
    availability: {
      input: { entity: 'calendar_day', fields: ['available', 'note'] },
      batch: { size: 30, by: 'row.listing_id' },
      request: {
        method: 'PUT',
        path: '/v1/listings/{batch.key}/calendar',
        body: 'batch.changes.map(c, {"date": c.row.date, "isAvailable": c.row.available ? 1 : 0})',
      },
      ack: 'response.body.status == "success"',
    },
  },
}

const token: Fixture = {
  request: { method: 'POST', url: `${API}/v1/accessTokens` },
  response: { body: { access_token: 'tok-1', expires_in: 3600 } },
}

const reservation = (id: number, updatedOn: string, status = 'new') => ({
  id,
  listingMapId: 10,
  status,
  arrivalDate: '2026-11-01',
  departureDate: '2026-11-04',
  totalPrice: 4500.5,
  updatedOn,
})

const secrets = { b1: { account_id: 'acct', api_secret: 's3cret' } }

describe('compilePlugin', () => {
  it('accepts a valid plugin', () => {
    const plugin = compilePlugin(acme, strDomain)
    expect([...plugin.sources.keys()]).toEqual(['reservations'])
    expect(plugin.sinks.get('availability')?.visibleFields).toEqual(['listing_id', 'date', 'available', 'note'])
  })

  it('reports every problem at once', () => {
    const broken: PluginInput = {
      ...acme,
      engine: '^2.0',
      owns: { calendar_day: ['available'] },
      auth: { type: 'bearer', token: 'secrets.missing' },
      sources: {
        reservations: {
          request: { path: 'v1/reservations' },
          records: 'response.body.result',
          emit: [{ operation: 'upsert_booking', fields: { listing_id: 'config.nope', bogus: '1' } }],
        },
      },
      sinks: {
        availability: {
          input: { entity: 'calendar_day', fields: ['available'] },
          request: { method: 'PUT', path: '/x/{batch.key}', body: 'batch.changes' },
          ack: 'response.body.ok',
        },
        prices: {
          input: { entity: 'calendar_day', fields: ['price_minor'], where: 'row.min_stay > 1' },
          request: { method: 'PUT', path: '/p' },
        },
      },
    }
    try {
      compilePlugin(broken, strDomain)
      expect.fail('should not compile')
    } catch (e) {
      expect(e).toBeInstanceOf(PluginValidationError)
      const problems = (e as PluginValidationError).problems.join('\n')
      expect(problems).toContain('engine: plugin needs ^2.0')
      expect(problems).toContain('secrets.missing is not a declared secret')
      expect(problems).toContain('path: must start with "/"')
      expect(problems).toContain('booking has no field bogus')
      expect(problems).toContain('missing key field external_id')
      expect(problems).toContain('config.nope is not a declared non-secret config field')
      expect(problems).toContain('available is owned by this plugin, so writing it back would echo')
      expect(problems).toContain('row.min_stay is not in the declared input')
    }
  })

  it('refuses a token URL outside the declared hosts', () => {
    const plugin = { ...acme, auth: { ...(acme.auth as object), token_url: 'https://evil.test/token' } } as PluginInput
    expect(() => compilePlugin(plugin, strDomain)).toThrow(/token_url: https:\/\/evil.test\/token is not under hosts/)
  })
})

describe('runSource', () => {
  const plugin = compilePlugin(acme, strDomain)

  it('pages through, maps records, and commits operations with the cursor', async () => {
    const http = replayHttp([
      token,
      { request: { url: `${API}/v1/reservations?limit=2&offset=0` }, response: { body: { result: [reservation(1, '2026-10-01T10:00:00Z'), reservation(2, '2026-10-03T09:00:00Z', 'test')] } } },
      { request: { url: `${API}/v1/reservations?limit=2&offset=2` }, response: { body: { result: [reservation(3, '2026-10-02T08:00:00Z', 'cancelled')] } } },
      { request: { url: `${API}/v1/reservations?limit=2&offset=3` }, response: { body: { result: [] } } },
    ])
    const host = memoryHost({ http, secrets })

    const result = await runSource(plugin, binding('b1'), 'reservations', host.ports)

    expect(result.pages).toBe(3)
    expect(result.complete).toBe(true)
    expect(host.applied.map((o) => [o.key.external_id, o.fields.status, o.fields.total_minor])).toEqual([
      ['1', 'confirmed', 450050],
      ['3', 'cancelled', 450050],
    ])
    expect(host.applied[0]?.origin).toEqual({ plugin: 'acme-pms', version: '1.0.0', source: 'reservations' })
    // The skipped test record still counts for the cursor: it was read.
    expect(host.cursors.get('b1/reservations')).toBe('2026-10-03T09:00:00Z')
    expect(http.sent[1]?.headers.authorization).toBe('Bearer tok-1')
    expect(http.pending()).toEqual([])
  })

  it('reuses the cached token and sends the cursor on the next run', async () => {
    const http = replayHttp([
      token,
      { request: { url: `${API}/v1/reservations?limit=2&offset=0` }, response: { body: { result: [reservation(1, '2026-10-01T10:00:00Z')] } } },
      { request: { url: `${API}/v1/reservations?limit=2&offset=1` }, response: { body: { result: [] } } },
      { request: { url: `${API}/v1/reservations?limit=2&offset=0&updatedSince=2026-10-01T10%3A00%3A00Z` }, response: { body: { result: [] } } },
    ])
    const host = memoryHost({ http, secrets })
    await runSource(plugin, binding('b1'), 'reservations', host.ports)
    await runSource(plugin, binding('b1'), 'reservations', host.ports)
    expect(http.sent.filter((r) => r.url.endsWith('/accessTokens'))).toHaveLength(1)
    expect(http.pending()).toEqual([])
  })

  it('applies nothing on a dry run', async () => {
    const http = replayHttp([
      token,
      { request: { url: `${API}/v1/reservations?limit=2&offset=0` }, response: { body: { result: [reservation(1, '2026-10-01T10:00:00Z')] } } },
      { request: { url: `${API}/v1/reservations?limit=2&offset=1` }, response: { body: { result: [] } } },
    ])
    const host = memoryHost({ http, secrets })
    const result = await runSource(plugin, binding('b1'), 'reservations', host.ports, { dryRun: true })
    expect(result.operations).toHaveLength(1)
    expect(result.applied).toBe(false)
    expect(host.applied).toEqual([])
    expect(host.cursors.size).toBe(0)
  })

  it('saves no cursor when applying fails', async () => {
    const http = replayHttp([
      token,
      { request: { url: `${API}/v1/reservations?limit=2&offset=0` }, response: { body: { result: [reservation(1, '2026-10-01T10:00:00Z')] } } },
      { request: { url: `${API}/v1/reservations?limit=2&offset=1` }, response: { body: { result: [] } } },
    ])
    const host = memoryHost({ http, secrets, failApply: true })
    await expect(runSource(plugin, binding('b1'), 'reservations', host.ports)).rejects.toThrow('apply failed')
    expect(host.cursors.size).toBe(0)
  })

  it('classifies rate limits as retryable with the wait', async () => {
    const http = replayHttp([
      token,
      { request: { url: `${API}/v1/reservations?limit=2&offset=0` }, response: { status: 429, headers: { 'Retry-After': '30' } } },
    ])
    const error = await runSource(plugin, binding('b1'), 'reservations', memoryHost({ http, secrets }).ports).catch((e) => e)
    expect(error).toBeInstanceOf(ConnectorError)
    expect(error).toMatchObject({ kind: 'retryable', details: { status: 429, retryAfterMs: 30_000 } })
  })

  it('refreshes the token once, then asks for re-authentication', async () => {
    const http = replayHttp([
      token,
      { request: { url: `${API}/v1/reservations?limit=2&offset=0` }, response: { status: 401 } },
      { ...token, response: { body: { access_token: 'tok-2' } } },
      { request: { url: `${API}/v1/reservations?limit=2&offset=0` }, response: { status: 401 } },
    ])
    const error = await runSource(plugin, binding('b1'), 'reservations', memoryHost({ http, secrets }).ports).catch((e) => e)
    expect(error).toMatchObject({ kind: 'reauth' })
    expect(http.sent[3]?.headers.authorization).toBe('Bearer tok-2')
  })

  it('stops a cursor that does not advance', async () => {
    const looping = compilePlugin(
      {
        ...acme,
        auth: { type: 'none' },
        config: {},
        sinks: {},
        sources: {
          people: {
            request: { path: '/v1/reservations' , query: { cursor: 'page.cursor' } },
            paginate: { type: 'cursor', next: '"same"' },
            records: 'response.body.result',
            emit: [{ operation: 'delete_booking', fields: { external_id: 'string(record.id)' } }],
          },
        },
      },
      strDomain,
    )
    const http = replayHttp([
      { request: { url: `${API}/v1/reservations` }, response: { body: { result: [{ id: 1 }] } } },
      { request: { url: `${API}/v1/reservations?cursor=same` }, response: { body: { result: [{ id: 2 }] } } },
    ])
    await expect(runSource(looping, binding('b1'), 'people', memoryHost({ http }).ports)).rejects.toThrow(/repeated an earlier value/)
  })
})

describe('runSink', () => {
  const plugin = compilePlugin(acme, strDomain)
  const day = (listing: string, date: string, available: boolean) => ({ listing_id: listing, date, available, price_minor: 100 })

  it('plans only changes, batches by listing, and remembers what it wrote', async () => {
    const rows = { calendar_day: [day('10', '2026-11-01', true), day('10', '2026-11-02', false), day('11', '2026-11-01', true)] }
    const ok = { body: { status: 'success' } }
    const http = replayHttp([
      token,
      { request: { method: 'PUT', url: `${API}/v1/listings/10/calendar` }, response: ok },
      { request: { method: 'PUT', url: `${API}/v1/listings/11/calendar` }, response: ok },
    ])
    const host = memoryHost({ http, secrets, rows })

    const first = await runSink(plugin, binding('b1'), 'availability', host.ports)
    expect(first.sent).toBe(2)
    expect(JSON.parse(http.sent[1]!.body!)).toEqual([
      { date: '2026-11-01', isAvailable: 1 },
      { date: '2026-11-02', isAvailable: 0 },
    ])

    // Nothing changed: nothing to send.
    const second = await runSink(plugin, binding('b1'), 'availability', host.ports)
    expect(second.plan).toEqual([])

    // One day changed: only that listing's batch, with the previous value attached.
    rows.calendar_day[1]!.available = true
    const third = await runSink(plugin, binding('b1'), 'availability', host.ports, { dryRun: true })
    expect(third.plan).toHaveLength(1)
    expect(third.plan[0]?.changes[0]?.previous).toMatchObject({ available: false })
  })

  it('never shows the sink fields outside its declared input', async () => {
    const rows = { calendar_day: [day('10', '2026-11-01', true)] }
    const host = memoryHost({ http: replayHttp([]), secrets, rows })
    const result = await runSink(plugin, binding('b1'), 'availability', host.ports, { dryRun: true })
    expect(Object.keys(result.plan[0]!.changes[0]!.row)).not.toContain('price_minor')
  })

  it('keeps the remote state unchanged when the provider does not acknowledge', async () => {
    const rows = { calendar_day: [day('10', '2026-11-01', true)] }
    const http = replayHttp([
      token,
      { request: { method: 'PUT', url: `${API}/v1/listings/10/calendar` }, response: { body: { status: 'fail' } } },
    ])
    const host = memoryHost({ http, secrets, rows })
    await expect(runSink(plugin, binding('b1'), 'availability', host.ports)).rejects.toMatchObject({ kind: 'permanent' })
    expect(host.remote.size).toBe(0)
  })
})
