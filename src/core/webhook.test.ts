import { describe, expect, it } from 'vitest'
import { compilePlugin, ConnectorError, handleWebhook, PluginValidationError, runSource, type PluginInput } from '../index.js'
import { binding, memoryHost, replayHttp, replayTarget } from '../testkit/index.js'

const API = 'https://api.example.com/v1'
const b = binding('b1', { account: 'acct-1' })
const secrets = { b1: { password: 'hunter22' } }

const base = {
  plugin: 'example',
  version: '1.0.0',
  engine: '^0.2',
  hosts: [API],
  config: { account: {}, password: { secret: true } },
  auth: { type: 'bearer', token: 'secrets.password' },
  sources: {
    reservations: {
      request: { path: '/reservations' },
      records: 'response.body.result',
      when: 'record.status != "inquiry"',
      call: { method: 'PUT', path: '/bookings/by-provider/example/{string(record.id)}', body: '{"status": record.status}' },
    },
  },
  sinks: {
    calendar: {
      read: { path: '/calendar', records: 'response.body.days' },
      key: 'row.date',
      request: { method: 'POST', path: '/calendar', body: '{"n": size(batch.changes)}' },
    },
  },
  webhooks: {
    reservation: {
      path: '/reservation',
      binding: 'request.body.account',
      verify: 'secureEquals(request.headers.authorization, "Basic " + base64(config.account + ":" + secrets.password))',
      when: 'request.body.event in ["reservation.created", "reservation.updated"]',
      order: 'request.body.seq',
      reread: { source: 'reservations', request: { path: '/reservations/{string(request.body.id)}' }, records: '[response.body.result]' },
    },
  },
} satisfies PluginInput

const auth = { authorization: `Basic ${Buffer.from('acct-1:hunter22').toString('base64')}` }
const event = (seq: number, extra: Record<string, unknown> = {}) => ({
  method: 'POST',
  path: '/reservation',
  headers: auth,
  body: JSON.stringify({ account: 'acct-1', event: 'reservation.updated', id: 77, seq, ...extra }),
})

describe('webhooks', () => {
  const plugin = compilePlugin(base)

  it('rereads the record from the provider and runs the source call on it, in order', async () => {
    const http = replayHttp([
      { request: { url: `${API}/reservations/77` }, response: { body: { result: { id: 77, status: 'modified' } } } },
      { request: { url: `${API}/reservations/77` }, response: { body: { result: { id: 77, status: 'inquiry' } } } },
    ])
    const target = replayTarget([{ request: { method: 'PUT', path: '/bookings/by-provider/example/77' }, response: { body: {} } }])
    const h = memoryHost({ http, target, secrets, webhookBindings: { 'acct-1': b } })

    await expect(handleWebhook(plugin, event(5), h.ports)).resolves.toMatchObject({ outcome: 'done', calls: [{ body: '{"status":"modified"}' }] })
    expect(http.sent[0]!.headers.authorization).toBe('Bearer hunter22')
    // Older or equal batches are dropped; the mark moved only after success.
    await expect(handleWebhook(plugin, event(5), h.ports)).resolves.toMatchObject({ outcome: 'stale' })
    await expect(handleWebhook(plugin, event(4), h.ports)).resolves.toMatchObject({ outcome: 'stale' })
    // The source's `when` applies to reread records too.
    await expect(handleWebhook(plugin, event(6), h.ports)).resolves.toMatchObject({ outcome: 'done', calls: [] })
    expect(h.marks.get('b1/reservation')).toBe(6)
  })

  it('handles two deliveries at once one after the other, under the port lock', async () => {
    const http = replayHttp([{ request: { url: `${API}/reservations/77` }, response: { body: { result: { id: 77, status: 'modified' } } } }])
    const target = replayTarget([{ request: { method: 'PUT', path: '/bookings/by-provider/example/77' }, response: { body: {} } }])
    const h = memoryHost({ http, target, secrets, webhookBindings: { 'acct-1': b } })
    const results = await Promise.all([handleWebhook(plugin, event(3), h.ports), handleWebhook(plugin, event(3), h.ports)])
    expect(results.map((r) => r.outcome)).toEqual(['done', 'stale'])
    expect(target.sent).toHaveLength(1)
  })

  it('skips a reread record the provider no longer has', async () => {
    const http = replayHttp([{ request: { url: `${API}/reservations/77` }, response: { body: { result: null } } }])
    const h = memoryHost({ http, target: replayTarget([]), secrets, webhookBindings: { 'acct-1': b } })
    await expect(handleWebhook(plugin, event(1), h.ports)).resolves.toMatchObject({ outcome: 'done', calls: [] })
  })

  it('ignores events `when` rejects, after verifying them', async () => {
    const h = memoryHost({ http: replayHttp([]), secrets, webhookBindings: { 'acct-1': b } })
    await expect(handleWebhook(plugin, event(1, { event: 'message.received' }), h.ports)).resolves.toMatchObject({ outcome: 'ignored', status: 200 })
    await expect(handleWebhook(plugin, { ...event(1), headers: { authorization: 'Basic eDp5' } }, h.ports)).resolves.toMatchObject({ outcome: 'unverified' })
    await expect(handleWebhook(plugin, { ...event(1), body: 'not json' }, h.ports)).resolves.toMatchObject({ outcome: 'unreadable', status: 400 })
  })

  it('a failed action leaves no mark, so the provider retry is handled', async () => {
    const http = replayHttp([
      { request: { url: `${API}/reservations/77` }, response: { body: { result: { id: 77, status: 'new' } } } },
      { request: { url: `${API}/reservations/77` }, response: { body: { result: { id: 77, status: 'new' } } } },
    ])
    const target = replayTarget([
      { request: { method: 'PUT', path: '/bookings/by-provider/example/77' }, response: { status: 503 } },
      { request: { method: 'PUT', path: '/bookings/by-provider/example/77' }, response: { body: {} } },
    ])
    const h = memoryHost({ http, target, secrets, webhookBindings: { 'acct-1': b } })
    await expect(handleWebhook(plugin, event(9), h.ports)).rejects.toMatchObject({ kind: 'retryable' })
    expect(h.marks.size).toBe(0)
    await expect(handleWebhook(plugin, event(9), h.ports)).resolves.toMatchObject({ outcome: 'done' })
  })

  it('needs the host webhooks port, and its marks when the plugin uses them', async () => {
    const h = memoryHost({ http: replayHttp([]), secrets })
    await expect(handleWebhook(plugin, event(1), h.ports)).rejects.toBeInstanceOf(ConnectorError)
    const partial = { ...h.ports, webhooks: { binding: async () => b } }
    await expect(handleWebhook(plugin, event(1), partial)).rejects.toThrow(/getMark/)
  })

  it('refuses declarations it cannot run', () => {
    const bad = (webhooks: unknown) => () => compilePlugin({ ...base, webhooks } as PluginInput)
    expect(bad({ a: { path: '/a', binding: '"x"', verify: 'true' } })).toThrow(/exactly one of/)
    expect(bad({ a: { path: '/a', binding: '"x"', verify: 'true', issue: '"x"', resend: ['calendar'] } })).toThrow(/exactly one of/)
    expect(bad({ a: { path: '/a', binding: '"x"', verify: 'true', resend: ['nope'] } })).toThrow(/unknown sink nope/)
    expect(bad({ a: { path: '/a', binding: '"x"', verify: 'true', issue: '"x"' }, b: { path: '/a', binding: '"x"', verify: 'true', issue: '"y"' } })).toThrow(
      /used by webhooks.a/,
    )
    expect(bad({ a: { path: '/a', binding: '"x"', verify: 'secrets.nope == "x"', issue: '"x"' } })).toThrow(/secrets.nope/)
    expect(bad({ a: { path: '/a', binding: 'secrets.password', verify: 'true', issue: '"x"' } })).toThrow(PluginValidationError)
    expect(bad({ a: { path: '/a', binding: '"x"', verify: 'true', reread: { source: 'missing', request: { path: '/x' } } } })).toThrow(/unknown source/)
    expect(bad({ a: { path: '../a', binding: '"x"', verify: 'true', issue: '"x"' } })).toThrow(/path like/)
  })
})

describe('oauth not_before_ms', () => {
  it('waits before using a new token', async () => {
    const plugin = compilePlugin({
      plugin: 'slow-token',
      version: '1.0.0',
      engine: '^0.2',
      hosts: [API],
      config: { id: { secret: true }, secret: { secret: true } },
      auth: { type: 'oauth2_client_credentials', token_url: '/token', client_id: 'secrets.id', client_secret: 'secrets.secret', not_before_ms: 150 },
      sources: { items: { request: { path: '/items' }, records: 'response.body', call: { method: 'POST', path: '/items', body: '{}' } } },
    })
    const http = replayHttp([
      { request: { method: 'POST', url: `${API}/token` }, response: { body: { access_token: 'fresh', expires_in: 3600 } } },
      { request: { url: `${API}/items` }, response: { body: [] } },
    ])
    const h = memoryHost({ http, target: replayTarget([]), secrets: { b1: { id: 'i', secret: 's' } } })
    const started = Date.now()
    await runSource(plugin, binding('b1'), 'items', h.ports)
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
  })
})
