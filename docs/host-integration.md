# Integrating a host

The engine does no I/O. Your application implements `HostPorts` and decides
where things are stored, how requests are sent and how operations are applied.

```ts
import type { HostPorts } from 'connector-hub'
```

| Port | Called | Notes |
| --- | --- | --- |
| `http.send(req, {timeoutMs, maxBodyBytes})` | every request | must enforce both limits and **must not follow redirects** |
| `secrets.get(bindingId)` | once per run | secret config values, by field name |
| `tokens.get/put(bindingId, token)` | OAuth presets | `put(id, null)` clears the cache |
| `state.getCursor(bindingId, source)` | start of a source run | `null` if none |
| `state.getRemote(bindingId, sink)` | start of a sink run | key → last written row |
| `read({bindingId, entity, fields})` | start of a domain-mode sink run | return only the requested fields |
| `target.send({method, path, body}, {timeoutMs, maxBodyBytes})` | target-mode `read` and source `call` | optional; your own API. Prefix your API root (concatenate, don't use `new URL(path, base)`), add the install's credentials, enforce both limits |
| `transaction(fn)` | commit points | `fn(tx)` must run in one transaction |
| `apply(operations, tx)` | source commit | write the operations to your storage |
| `saveCursor(bindingId, source, cursor, tx)` | source commit | |
| `saveRemote(bindingId, sink, rows, tx)` | after each acked batch | **merge** into the snapshot, don't replace it; a `null` row removes that key; keep the `#config` entry like any other |

Node 22 or later. A binding's `config` may hold anything; only the fields the
plugin declares (and not its secrets) are passed to its expressions.
| `budget.take(plugin)` | optional, before each request | resolve when a request may go out |
| `clock.now()` | optional | for token expiry and `now`; defaults to the system clock |

## HTTP

Use any client. The engine already checks that every URL is on the plugin's
`hosts`, but your `send` should also:

- refuse redirects (`redirect: 'manual'` with `fetch`), so a provider can't
  bounce a request to another host;
- stop reading the body once it exceeds `maxBodyBytes`;
- in a multi-tenant service, resolve DNS and refuse private and link-local
  addresses if plugins can be supplied by users.

`examples/src/fetch-http.ts` is a minimal `fetch` implementation.

Return the body as the raw text. The engine parses it, keeping integers beyond
2^53 exact.

## Transactions

`runSource` calls `transaction` once, with `apply` and `saveCursor` inside, so
data and cursor commit together. Pass your database transaction as `Tx`:

```ts
const ports: HostPorts<Knex.Transaction> = {
  transaction: (fn) => db.transaction(fn),
  apply: async (ops, tx) => { for (const op of ops) await applyOne(tx, op) },
  saveCursor: (id, source, cursor, tx) =>
    tx('connector_cursors').insert({ binding_id: id, source, cursor: JSON.stringify(cursor) })
      .onConflict(['binding_id', 'source']).merge(),
  // …
}
```

## Applying operations

Operations arrive as `{operation, entity, kind, key, fields, origin}`. A
typical host maps each `operation` name to a function. Two rules matter:

- **Idempotency.** The same operation can arrive twice (after a retry or at a
  cursor boundary). Upsert by `key`.
- **Ownership.** `origin.plugin` tells you which provider produced a value; use
  it if several providers write the same entity.

## Running

Scheduling, retries, webhooks and concurrency are the host's job. A typical
worker:

```ts
try {
  await runSource(plugin, binding, 'reservations', ports)
} catch (e) {
  if (e instanceof ConnectorError) {
    if (e.kind === 'retryable') return retryLater(e.details.retryAfterMs ?? backoff())
    if (e.kind === 'reauth') return pauseBinding(binding, 'reconnect needed')
  }
  throw e // permanent or config: alert, don't retry
}
```

Run at most one source run per binding and source at a time, or two runs may
both start from the same cursor.

## Webhooks

Route `POST <your webhook URL>/<plugin>/<path>` to `handleWebhook` with the raw
body, and answer with the result's `status`:

```ts
const result = await handleWebhook(plugin, { method, path, headers, query, body: rawBody }, ports)
if (result.issue) flagBinding(result.bindingId, result.issue)
if (result.resend.length) queueSinks(result.bindingId, result.resend)
return reply(result.status)
```

The `webhooks` port finds a binding by the plugin's key (`binding`) and keeps
the dedupe and order marks (`seen`/`remember`, `getMark`/`saveMark`) that
plugins using `dedupe_key` or `order` need. Handle one request per binding at a
time, so two deliveries of the same id cannot both pass the dedupe check. A
thrown `ConnectorError` maps as for runs: answer 5xx for `retryable` so the
provider retries.

## Storing plugins

Compile once and keep the `CompiledPlugin` in memory; it is immutable and safe
to share. Store the plugin file and its `version` so you can roll back.
