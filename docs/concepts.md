# Concepts

```
            plugin file (YAML/JSON + CEL)
                        │ compilePlugin(plugin, domainPack)
                        ▼
  provider API ◀── engine (no I/O) ──▶ host ports ──▶ your database, queue, secrets
```

## Domain pack

The vocabulary of one domain: **entities** (with key fields and typed fields)
and the **operations** a plugin may emit on them (`upsert`, `patch` or
`delete`). The engine knows nothing about rentals, contacts or anything else;
everything domain-specific is in the pack. See [Domain packs](domain-packs.md).

## Plugin

One provider, described as data:

- `hosts`: every origin it may call. Anything else is refused.
- `config`: fields a user fills in when connecting; `secret: true` fields go to
  your credential store.
- `auth`: one of a few presets. See [Authentication](auth.md).
- `sources`: provider → operations. See [Sources](sources.md).
- `sinks`: your data → provider. See [Sinks](sinks.md).
- `owns`: fields this provider is the source of truth for.

Every logic-bearing value is a [CEL expression](expressions.md): side-effect
free, guaranteed to terminate, and type-checked at compile time.

## Binding

One configured connection of a plugin, for example one customer's account.
A binding has an `id` and its non-secret `config` values. Cursors, snapshots,
tokens and secrets are all stored per binding.

## Operation

The only thing a source produces:

```ts
interface Operation {
  operation: string            // e.g. 'upsert_booking'
  entity: string               // e.g. 'booking'
  kind: 'upsert' | 'patch' | 'delete'
  key: Record<string, JsonValue>
  fields: Record<string, JsonValue>
  origin: { plugin: string; version: string; source: string }
}
```

Your host decides how to apply it. The plugin never writes to your storage.

## Host ports

The interface your application implements: HTTP, secrets, token cache, cursor
and snapshot state, reading a sink's input, applying operations, and a
transaction. See [Integrating a host](host-integration.md).

## Runs

- `runSource` reads one source to the end or to a limit, maps records to
  operations, and commits the operations and the new cursor in one
  transaction.
- `runSink` reads the sink's declared input, diffs it against what it last
  wrote, sends only the changes in batches, and saves each acknowledged batch.

Both take `{ dryRun: true }`, which returns what would happen without
applying or saving anything. Scheduling, retries and webhooks belong to the
host; the engine reports what to do through [typed errors](errors.md).
