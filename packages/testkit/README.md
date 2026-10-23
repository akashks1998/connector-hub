# @connector-hub/testkit

Test connector-hub plugins without a network or database.

- `replayHttp(fixtures)`: answers requests from recorded responses, matched on
  method and URL, and fails on anything unexpected.
- `memoryHost(options)`: every host port in memory, with real transaction
  semantics.
- `binding(id, config)`.

```ts
const host = memoryHost({ http: replayHttp(fixtures), secrets: { b1: { api_key: 'test' } } })
const result = await runSource(plugin, binding('b1'), 'reservations', host.ports)
```

See [Testing plugins](https://github.com/akashks1998/connector-hub/blob/main/docs/testing.md).

Apache-2.0. Part of [connector-hub](https://github.com/akashks1998/connector-hub).
