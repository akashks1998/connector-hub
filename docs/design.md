# Design notes

## The boundary

The engine is a pure planner and runner. It builds requests, reads responses,
and produces operations. It never opens a socket, touches a database, reads a
clock it wasn't given, or stores anything itself. Everything with side effects
goes through `HostPorts`, which the application implements.

This is enforced by the package boundary: `@connector-hub/core` depends only on
`spec`, `cel` and `zod`.

## Expressions

All logic in a plugin is CEL, compiled at load time:

- Variables are declared per position (`record`, `row`, `batch`, `response`,
  `config`, `secrets`, `cursor`, `page`). An expression can't read anything else.
- Parse limits cap size and depth. Nested comprehensions (`map` inside `map`)
  are rejected, so cost stays linear in the input.
- Every variable path an expression reads is extracted from its syntax tree.
  The compiler uses this to check `config.*` and `secrets.*` against declared
  config, and `row.*` against a sink's declared input.
- Integral JSON numbers are treated as CEL `int`, others as `double`.
- Secrets are only visible to auth expressions.

## Sources

A source pages through a provider endpoint, turns each record into zero or more
operations, and tracks the highest `cursor.value` seen. Operations and the new
cursor commit in one host transaction. If a page or record cap stops the run
early, the cursor is not advanced.

## Sinks: plan, then apply

A sink reads exactly its declared input from the host, compares it with the
snapshot of what it last wrote, and sends only the difference, grouped by
`batch.by` and chunked by `batch.size`. A dry run returns the plan. After each
acknowledged batch, the written rows become the new snapshot. A sink may not
write fields its own plugin owns, which would echo a provider's values back to it.

## Errors

The engine classifies every failure so the host's queue can act:

| Kind | Cause | Host action |
| --- | --- | --- |
| `retryable` | network error, 408, 425, 429, 5xx | retry, after `retryAfterMs` when set |
| `reauth` | 401 or 403, after one token refresh | pause the binding, ask the user to reconnect |
| `permanent` | other 4xx, non-JSON body, failed ack, cursor that does not advance | stop and report |
| `config` | unknown source or sink | fix the call |

## Prior art

- Shopify Functions: declared input, no network, output as operations.
- Kubernetes CEL admission policies: restricted expressions instead of webhooks.
- Kafka Connect: framework-owned offsets committed with the data.
- Terraform: plan and apply against last-known state.
- Airbyte low-code manifests: vocabulary for requesters, paginators and cursors.
