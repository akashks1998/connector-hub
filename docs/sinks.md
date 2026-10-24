# Sinks

A sink writes your data to a provider. It works like `terraform plan` and
`apply`: the engine compares what you have now with what the sink last wrote,
and sends only the difference.

```yaml
sinks:
  availability:
    input:
      entity: calendar_day
      fields: [available]
      where: row.date >= "2026-01-01"
    batch: { size: 30, by: row.listing_id }
    request:
      method: PUT
      path: /v1/listings/{batch.key}/calendar
      body: 'batch.changes.map(c, {"date": c.row.date, "isAvailable": c.row.available ? 1 : 0})'
    ack: response.body.status == "success"
```

## Declared input

`input.fields` is everything the sink can see, plus the entity's key fields.
The host's `read` port is asked for exactly those fields, and the compiler
rejects any expression that reads another `row.*` field. A sink that declares
`available` can never send prices, even by mistake.

A sink may not declare a field its plugin lists under `owns`: that field comes
*from* the provider, and writing it back would create an echo loop.

## Plan

1. `read` the declared input for the binding.
2. Drop rows where `input.where` isn't `true`.
3. Compare each row's declared fields with the remote snapshot (what this sink
   last wrote for that key). New or different rows become changes.
4. Group changes by `batch.by`, then split each group into chunks of
   `batch.size`.
5. Build one request per batch.

Each change carries `row` (current values) and `previous` (last written, or
`null`), so a request can send only the changed values if the API wants that.

```ts
const { plan } = await runSink(plugin, binding, 'availability', ports, { dryRun: true })
for (const batch of plan) console.log(batch.key, batch.changes.length, batch.request.url)
```

## Apply

Batches are sent in order. For each one:

- a non-2xx response fails the run with a [typed error](errors.md);
- if `ack` is set and isn't `true`, the run fails as `permanent`;
- otherwise the batch's rows are saved as the new snapshot, in their own
  transaction.

Batches already acknowledged stay saved when a later one fails, so a retry
sends only what is still different.

A row that disappears from the input is not sent, unless the sink sets
`on_delete: send` (see [Plugin reference](plugin-reference.md#sinks)).

## Precheck

A sink can read the provider's current records for each batch before planning
it (`precheck`). Changes its `allow` refuses come back in `conflicts` and are
left unsaved, so a day someone changed on the provider is reported rather than
overwritten. The Hostaway plugin uses it to close only open days and release
only days it closed.
