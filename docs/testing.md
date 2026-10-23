# Testing plugins

`@connector-hub/testkit` runs plugins without a network or database.

```sh
npm install --save-dev @connector-hub/testkit
```

## Fixture replay

```ts
import { compilePlugin, runSource } from '@connector-hub/core'
import { binding, memoryHost, replayHttp } from '@connector-hub/testkit'

const http = replayHttp([
  {
    request: { url: 'https://api.acme.test/v1/reservations?limit=2&offset=0' },
    response: { body: { result: [{ id: 1, status: 'new', updatedOn: '2026-10-01' }] } },
  },
])
const host = memoryHost({ http, secrets: { b1: { api_key: 'test' } } })

const result = await runSource(plugin, binding('b1'), 'reservations', host.ports)

expect(result.operations).toHaveLength(1)
expect(host.cursors.get('b1/reservations')).toBe('2026-10-01')
expect(http.pending()).toEqual([])
```

`replayHttp` matches on method (default `GET`) and full URL, ignoring query
parameter order. Each fixture answers one request; an unexpected request
throws `no fixture for …`. `http.sent` lists what was sent, including auth
headers, so you can assert on them.

## The in-memory host

`memoryHost(options)` implements every port:

| Option | Purpose |
| --- | --- |
| `http` | an HTTP port, usually `replayHttp(...)` |
| `secrets` | binding id → secret values |
| `rows` | entity → rows, returned to sinks |
| `now` | fixed clock for token expiry |
| `failApply` | make `apply` throw, to test that nothing commits |

It returns `{ports, applied, cursors, remote, tokens}`. Writes are staged per
transaction and kept only when the transaction succeeds, like a real database.

## Testing sinks

```ts
const host = memoryHost({ http, rows: { calendar_day: [{ listing_id: 'L1', date: '2026-11-01', available: false }] } })
const { plan } = await runSink(plugin, binding('b1'), 'availability', host.ports, { dryRun: true })
expect(plan[0].request.body).toBe('[{"date":"2026-11-01","isAvailable":0}]')
```

Run it twice without dry run to check that the second run sends nothing.

## Against a live API

`dryRun: true` with a real HTTP port reads from the provider and returns the
operations without writing anything. The repository's `examples/` run this way
against Wikipedia, GitHub and httpbin.
