import type { DomainPack, PluginInput } from '../spec/index.js'
import { binding, memoryHost, replayHttp } from '../testkit/index.js'
import { describe, expect, it } from 'vitest'
import { compilePlugin, ConnectorError, runSink, runSource, type HostPorts } from './index.js'

const API = 'https://api.test/tenants/42'

const domain = {
  domain: 'test',
  version: '0.1.0',
  entities: {
    item: {
      key: ['id'],
      fields: { id: 'string', n: 'int', price: 'double', status: { enum: ['open', 'closed'] }, day: 'date', at: 'timestamp', blob: 'json' },
    },
  },
  operations: { upsert_item: { entity: 'item', kind: 'upsert' } },
} satisfies DomainPack

function plugin(overrides: Partial<PluginInput> = {}, source: Record<string, unknown> = {}): PluginInput {
  return {
    plugin: 'test',
    version: '1.0.0',
    engine: '^0.1',
    domain: { name: 'test', version: '^0.1' },
    hosts: [API],
    sources: {
      items: {
        request: { path: '/items' },
        records: 'response.body',
        emit: [{ operation: 'upsert_item', fields: { id: 'string(record.id)' } }],
        ...source,
      },
    },
    ...overrides,
  } as PluginInput
}

const read = (body: unknown, url = `${API}/items`) => ({ request: { url }, response: { body: body as never } })

async function run(p: PluginInput, fixtures: Parameters<typeof replayHttp>[0], options: { secrets?: Record<string, string> } = {}) {
  const http = replayHttp(fixtures)
  const host = memoryHost({ http, secrets: { b: options.secrets ?? {} } })
  const result = await runSource(compilePlugin(p, domain), binding('b'), 'items', host.ports)
  return { result, host, http }
}

describe('cursors', () => {
  const cases: Array<[string, unknown[], unknown]> = [
    ['fractional seconds', ['2026-10-01T10:00:00Z', '2026-10-01T10:00:00.500Z'], '2026-10-01T10:00:00.500Z'],
    ['numeric strings', ['99', '100'], '100'],
    ['numbers', [9, 10], 10],
    ['offsets', ['2026-10-01T12:00:00+05:00', '2026-10-01T08:00:00Z'], '2026-10-01T08:00:00Z'],
    ['huge integer strings', ['9007199254740993', '9007199254740992'], '9007199254740993'],
  ]
  for (const [name, values, expected] of cases) {
    it(`orders ${name}`, async () => {
      const p = plugin({}, { cursor: { value: 'record.c' } })
      const { result } = await run(p, [read(values.map((c, i) => ({ id: i + 1, c })))])
      expect(result.cursor).toEqual(expected)
    })
  }
})

describe('values', () => {
  it('keeps integers larger than 2^53 exact, as strings', async () => {
    const { result } = await run(plugin(), [{ request: { url: `${API}/items` }, response: { body: '[{"id":1234567890123456789}]' } }])
    expect(result.operations[0]?.key).toEqual({ id: '1234567890123456789' })
  })

  it('checks emitted values against the domain pack', async () => {
    const p = plugin({}, { emit: [{ operation: 'upsert_item', fields: { id: 'string(record.id)', status: 'record.s' } }] })
    await expect(run(p, [read([{ id: 1, s: 'archived' }])])).rejects.toThrow(/item.status expected one of open, closed, got "archived"/)
    const q = plugin({}, { emit: [{ operation: 'upsert_item', fields: { id: 'string(record.id)', n: 'record.n', day: 'record.d' } }] })
    await expect(run(q, [read([{ id: 1, n: 1.5, d: '2026-10-01' }])])).rejects.toThrow(/item.n expected int/)
    await expect(run(q, [read([{ id: 1, n: 1, d: '01/10/2026' }])])).rejects.toThrow(/item.day expected date/)
    const ok = await run(q, [read([{ id: 1, n: 2, d: '2026-10-01' }])])
    expect(ok.result.operations[0]?.fields).toEqual({ id: '1', n: 2, day: '2026-10-01' })
  })

  it('reports expression failures as permanent ConnectorErrors with their location', async () => {
    const p = plugin({}, { emit: [{ operation: 'upsert_item', fields: { id: 'string(record.missing)' } }] })
    const error = await run(p, [read([{ id: 1 }])]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConnectorError)
    expect(error).toMatchObject({ kind: 'permanent', message: expect.stringMatching(/^sources.items.emit\[0\].fields.id:/) })
  })
})

describe('requests', () => {
  it('keeps requests under the host path, even with .. in the template or a value', async () => {
    const climbing = plugin({}, { request: { path: '/../../admin' } })
    await expect(run(climbing, [])).rejects.toThrow(/not under the plugin's hosts/)
    const injected = plugin({ config: { a: {} } }, { request: { path: '/items/{config.a}/x' } })
    const host = memoryHost({ http: replayHttp([]) })
    const error = await runSource(compilePlugin(injected, domain), binding('b', { a: '..' }), 'items', host.ports).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'permanent', message: expect.stringMatching(/".." is not allowed in a path/) })
  })

  it('redacts secrets from transport errors', async () => {
    const p = plugin({ config: { key: { secret: true } }, auth: { type: 'api_key', in: 'query', name: 'key', value: 'secrets.key' } })
    const http = { send: async (r: { url: string }) => Promise.reject(new Error(`connect failed for ${r.url}`)) } as HostPorts['http']
    const host = memoryHost({ http, secrets: { b: { key: 'SUPER/SECRET' } } })
    const error = (await runSource(compilePlugin(p, domain), binding('b'), 'items', host.ports).catch((e: unknown) => e)) as ConnectorError
    expect(error.kind).toBe('retryable')
    expect(error.message).not.toMatch(/SUPER|SECRET/)
    expect(error.cause).toBeUndefined()
  })

  it('refuses reserved headers, bad header names and line breaks in values', async () => {
    expect(() => compilePlugin(plugin({}, { request: { path: '/items', headers: { Host: '"x"' } } }), domain)).toThrow(/host is set by the engine/)
    expect(() => compilePlugin(plugin({}, { request: { path: '/items', headers: { 'a b': '"x"' } } }), domain)).toThrow(/not a valid header name/)
    const p = plugin({ config: { tag: {} } }, { request: { path: '/items', headers: { 'X-Tag': 'config.tag' } } })
    const host = memoryHost({ http: replayHttp([]) })
    await expect(runSource(compilePlugin(p, domain), binding('b', { tag: 'a\r\nInjected: 1' }), 'items', host.ports)).rejects.toThrow(
      /line break/,
    )
  })

  it('keeps a content-type the plugin sets', async () => {
    const p = plugin({}, { request: { method: 'POST', path: '/search', headers: { 'Content-Type': '"application/vnd.api+json"' }, body: '{"q": 1}' } })
    const { http } = await run(p, [{ request: { method: 'POST', url: `${API}/search` }, response: { body: [] } }])
    expect(http.sent[0]?.headers['content-type']).toBe('application/vnd.api+json')
  })

  it('only lets sources GET or POST', () => {
    expect(() => compilePlugin(plugin({}, { request: { method: 'DELETE', path: '/items' } }), domain)).toThrow(/only GET and POST/)
  })
})

describe('config', () => {
  it('rejects reading config or secrets as a whole map', () => {
    expect(() => compilePlugin(plugin({}, { request: { path: '/items', body: 'config.map(k, k)' } }), domain)).toThrow(
      /read config fields by name/,
    )
    expect(() => compilePlugin(plugin({}, { request: { path: '/items', query: { k: 'config["x" + "y"]' } } }), domain)).toThrow(
      /read config fields by name/,
    )
  })

  it('passes only declared config to expressions, and checks it', async () => {
    const p = plugin({ config: { region: { required: false }, count: { type: 'int' } } }, { request: { path: '/items', query: { r: 'config.region', c: 'config.count' } } })
    const compiled = compilePlugin(p, domain)
    const http = replayHttp([read([], `${API}/items?c=3`)])
    await runSource(compiled, binding('b', { count: 3, undeclared: 'hidden' }), 'items', memoryHost({ http }).ports)
    expect(http.pending()).toEqual([])
    await expect(runSource(compiled, binding('b', {}), 'items', memoryHost({ http }).ports)).rejects.toMatchObject({ kind: 'config' })
    await expect(runSource(compiled, binding('b', { count: '3' }), 'items', memoryHost({ http }).ports)).rejects.toThrow(/must be a int/)
  })
})

describe('expression cost', () => {
  it('does not offer regular expressions', () => {
    expect(() => compilePlugin(plugin({}, { records: 'response.body.filter(r, r.id.matches("^(a+)+$"))' }), domain)).toThrow(/"matches" is not available/)
  })

  it('refuses results far larger than the body limit', async () => {
    const p = plugin({ limits: { max_body_bytes: 1000 } }, { records: 'response.body.map(r, response.body)' })
    await expect(run(p, [read(Array.from({ length: 40 }, (_, i) => ({ id: i })))])).rejects.toThrow(/result is larger than/)
  })
})

describe('paging', () => {
  it('keeps going when the provider caps the page size below the limit', async () => {
    const p = plugin({}, { request: { path: '/items', query: { offset: 'page.offset', limit: 'page.limit' } }, paginate: { type: 'offset', limit: 100 } })
    const { result } = await run(p, [
      read([{ id: 1 }, { id: 2 }], `${API}/items?offset=0&limit=100`),
      read([{ id: 3 }], `${API}/items?offset=2&limit=100`),
      read([], `${API}/items?offset=3&limit=100`),
    ])
    expect(result.operations.map((o) => o.key.id)).toEqual(['1', '2', '3'])
  })

  it('fails when the provider repeats a page', async () => {
    const p = plugin({}, { request: { path: '/items', query: { page: 'page.number' } }, paginate: { type: 'page' } })
    await expect(run(p, [read([{ id: 1 }], `${API}/items?page=1`), read([{ id: 1 }], `${API}/items?page=2`)])).rejects.toThrow(
      /same page twice/,
    )
  })

  it('fails when a pagination cursor cycles', async () => {
    const p = plugin({}, { request: { path: '/items', query: { c: 'page.cursor' } }, records: 'response.body.items', paginate: { type: 'cursor', next: 'response.body.next' } })
    await expect(
      run(p, [
        read({ items: [{ id: 1 }], next: 'A' }),
        read({ items: [{ id: 2 }], next: 'B' }, `${API}/items?c=A`),
        read({ items: [{ id: 3 }], next: 'A' }, `${API}/items?c=B`),
      ]),
    ).rejects.toThrow(/repeated an earlier value/)
  })
})

describe('tokens', () => {
  const oauth = plugin({
    config: { id: { secret: true }, secret: { secret: true } },
    auth: { type: 'oauth2_client_credentials', token_url: '/oauth/token', client_id: 'secrets.id', client_secret: 'secrets.secret' },
  })
  const tokenFixture = (expires_in: unknown) => ({
    request: { method: 'POST' as const, url: `${API}/oauth/token` },
    response: { body: { access_token: 't', expires_in } as never },
  })

  it('reuses a short-lived token instead of fetching one per request', async () => {
    const p = { ...oauth, sources: { items: { ...(oauth.sources as never)['items'], request: { path: '/items', query: { page: 'page.number' } }, paginate: { type: 'page' } } } } as PluginInput
    const { http } = await run(p, [tokenFixture(30), read([{ id: 1 }], `${API}/items?page=1`), read([{ id: 2 }], `${API}/items?page=2`), read([], `${API}/items?page=3`)], {
      secrets: { id: 'i', secret: 's' },
    })
    expect(http.sent.filter((r) => r.url.endsWith('/oauth/token'))).toHaveLength(1)
  })

  it('accepts expires_in as a string and expiresAt as a string from the token store', async () => {
    const http = replayHttp([tokenFixture('3600'), read([]), read([])])
    const host = memoryHost({ http, secrets: { b: { id: 'i', secret: 's' } } })
    const json = { ...host.ports.tokens, get: async (id: string) => JSON.parse(JSON.stringify(await host.ports.tokens.get(id))) }
    const ports = { ...host.ports, tokens: json }
    const compiled = compilePlugin(oauth, domain)
    await runSource(compiled, binding('b'), 'items', ports)
    await runSource(compiled, binding('b'), 'items', ports)
    expect(http.sent.filter((r) => r.url.endsWith('/oauth/token'))).toHaveLength(1)
  })
})

describe('Retry-After', () => {
  const at = new Date('2026-10-23T00:00:00Z')
  const cases: Array<[string, number | undefined]> = [
    ['30', 30_000],
    ['0x10', undefined],
    ['   ', undefined],
    ['1000000000', 86_400_000],
    ['Fri, 23 Oct 2026 00:01:00 GMT', 60_000],
  ]
  for (const [header, expected] of cases) {
    it(`reads ${JSON.stringify(header)}`, async () => {
      const http = replayHttp([{ request: { url: `${API}/items` }, response: { status: 503, headers: { 'retry-after': header } } }])
      const host = memoryHost({ http, now: at })
      const error = (await runSource(compilePlugin(plugin(), domain), binding('b'), 'items', host.ports).catch((e: unknown) => e)) as ConnectorError
      expect(error.details.retryAfterMs).toBe(expected)
    })
  }
})

describe('sinks', () => {
  const sinkPlugin = (body = 'batch.changes.map(c, {"id": c.row.id, "n": c.row.n})') =>
    plugin({
      sources: {},
      sinks: { items: { input: { entity: 'item', fields: ['n', 'blob'] }, batch: { size: 2, by: 'row.blob.group' }, request: { method: 'PUT', path: '/groups/{batch.key}', body } } },
    })

  it('rejects requests that read undeclared fields through batch.changes', () => {
    expect(() => compilePlugin(sinkPlugin('batch.changes.map(c, c.row.price)'), domain)).toThrow(/batch.changes\[\].row.price is not in the declared input/)
  })

  it('refuses empty and duplicate keys and empty batch keys', async () => {
    const plan = (rows: Record<string, unknown>[]) =>
      runSink(compilePlugin(sinkPlugin(), domain), binding('b'), 'items', memoryHost({ http: replayHttp([]), rows: { item: rows as never } }).ports, {
        dryRun: true,
      })
    await expect(plan([{ n: 1, blob: { group: 'g' } }])).rejects.toThrow(/empty id/)
    await expect(plan([{ id: 'a', blob: { group: 'g' } }, { id: 'a', blob: { group: 'g' } }])).rejects.toThrow(/two item rows/)
    await expect(plan([{ id: 'a', blob: { group: '' } }])).rejects.toThrow(/batch.by is empty/)
  })

  it('does not resend rows whose JSON only changed key order', async () => {
    const rows = { item: [{ id: 'a', n: 1, blob: { group: 'g', x: 1 } }] }
    const http = replayHttp([{ request: { method: 'PUT', url: `${API}/groups/g` }, response: { body: {} } }])
    const host = memoryHost({ http, rows })
    const compiled = compilePlugin(sinkPlugin(), domain)
    await runSink(compiled, binding('b'), 'items', host.ports)
    rows.item[0]!.blob = { x: 1, group: 'g' }
    const second = await runSink(compiled, binding('b'), 'items', host.ports, { dryRun: true })
    expect(second.plan).toEqual([])
  })

  it('says how many batches were sent when one fails, and resumes from there', async () => {
    const rows = { item: [{ id: 'a', n: 1, blob: { group: 'g' } }, { id: 'b', n: 1, blob: { group: 'g' } }, { id: 'c', n: 1, blob: { group: 'g' } }] }
    const http = replayHttp([
      { request: { method: 'PUT', url: `${API}/groups/g` }, response: { body: {} } },
      { request: { method: 'PUT', url: `${API}/groups/g` }, response: { status: 500 } },
      { request: { method: 'PUT', url: `${API}/groups/g` }, response: { body: {} } },
    ])
    const host = memoryHost({ http, rows })
    const compiled = compilePlugin(sinkPlugin(), domain)
    const error = (await runSink(compiled, binding('b'), 'items', host.ports).catch((e: unknown) => e)) as ConnectorError
    expect(error).toMatchObject({ kind: 'retryable', details: { sent: 1 } })
    expect(error.message).toMatch(/batch 2 of 2, 1 sent/)
    const retry = await runSink(compiled, binding('b'), 'items', host.ports)
    expect(retry.plan.map((b) => b.changes.map((c) => c.row.id))).toEqual([['c']])
  })
})
