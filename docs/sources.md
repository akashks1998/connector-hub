# Sources

A source reads one kind of record from a provider and turns each record into
one or more operations.

```yaml
sources:
  reservations:
    request:
      path: /v1/reservations
      query: { limit: page.limit, offset: page.offset, updatedSince: cursor }
    paginate: { type: offset, limit: 100 }
    records: response.body.result
    emit:
      - operation: upsert_booking
        when: record.status != "test"
        fields:
          external_id: string(record.id)
          check_in: record.arrivalDate
    cursor: { value: record.updatedOn }
```

## How a run works

1. Load the binding's saved cursor (or `null` on the first run).
2. Build the request for the first page, send it, and evaluate `records`.
3. For each record and each `emit`: skip it if `when` isn't `true`, evaluate
   `fields`, check each value against the field's type in the domain pack,
   and check that every key field is non-empty.
4. Track the highest `cursor.value` seen.
5. Ask the paging strategy for the next page, until it stops or a limit is hit.
6. In one host transaction, apply all operations and save the new cursor.

```ts
const result = await runSource(plugin, binding, 'reservations', ports)
result.operations  // what was applied
result.pages       // pages fetched
result.complete    // false if max_pages or max_records stopped the run
result.cursor      // the cursor now saved
result.requests    // every request sent, auth headers excluded
```

## Paging

| `type` | Extra fields | `page` variable | Stops when |
| --- | --- | --- | --- |
| `none` | | `{}` | after one request |
| `offset` | `limit` | `{offset, limit}` | a page is empty |
| `page` | `start` (default 1) | `{number}` | a page is empty |
| `cursor` | `next` (CEL over `response`) | `{cursor}` (`null` first) | `next` is `null` or `""` |

Offset paging advances by the number of records actually returned, so a
provider that caps page size below `limit` is still read to the end, at the
cost of one final empty request.

Two safeguards stop runaway paging with a `permanent` error: a page whose
records are identical to an earlier page, and a `cursor` paginator that
returns a value it already returned.

```yaml
# Cursor paging, e.g. MediaWiki
request:
  path: /w/api.php
  query: { rccontinue: page.cursor }
paginate:
  type: cursor
  next: 'has(response.body.continue) ? response.body.continue.rccontinue : null'
```

## Incremental cursors

`cursor.value` is evaluated for every record and the engine keeps the
highest. Values are ordered as integers when both are integers (or integer
strings, of any size), as numbers when both are numeric, as instants when
both are ISO dates or timestamps (so `10:00:00Z` < `10:00:00.5Z` and offsets
are honoured), and otherwise as text. On the next run it is available as `cursor` in the request and
emit expressions.

The cursor is only advanced when the run is **complete** and the operations
were applied. If the run stopped at a limit, or `apply` threw, the next run
starts from the same cursor. Applying an operation twice must therefore be
safe for your host — which `upsert` and `patch` naturally are.

Many APIs filter with "updated since", which includes the boundary record, so
the last record of one run is read again on the next. This is expected.

## Methods

Sources may use `GET` or `POST` (for search endpoints that take a body).
Anything that changes data on the provider belongs in a sink.

## Dry runs

`{ dryRun: true }` sends the reads and returns the operations, but applies
nothing and saves no cursor. An OAuth token fetched along the way is still
cached, and requests still count against the host's `budget`. Use it for import previews and for testing a
plugin against a real account.
