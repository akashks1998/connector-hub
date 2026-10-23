# connector-hub

A declarative connector engine for TypeScript. A connector plugin is a **declaration**: endpoints, paging, mappings and write rules, with small [CEL](https://github.com/google/cel-spec) expressions. It is not code. The engine runs every plugin the same way, and your application (the host) does all I/O through a small set of ports.

> Status: `0.x`, early development. The contract changes between minor versions until 1.0.

## Why declarations

SQL is powerful because a query cannot control how it runs. connector-hub applies the same idea to integrations:

| A plugin cannot… | so the engine can… |
| --- | --- |
| make network calls | enforce allowed hosts, rate limits, timeouts and body limits; replay recorded responses in tests |
| write to your database | send every change to your code as an operation, inside your transaction |
| keep state | store cursors and "last written" snapshots in your store, committed with the data |
| loop or have side effects in mappings | read which fields each mapping uses, and send only real changes |
| see fields it did not declare | give each sink exactly its declared input, nothing more |

The result: a new provider is a short file, a dry run gives you an import preview for free, and plugins can be versioned and rolled back without redeploying your application.

## Concepts

- **Domain pack.** The entities, keys, fields and operations of a domain, such as short-term rentals (`@connector-hub/domain-str`) or contacts (`@connector-hub/domain-contacts`). The engine itself knows nothing about any domain.
- **Plugin.** One provider: allowed hosts, auth preset, config fields, **sources** (provider → operations) and **sinks** (your data → provider).
- **Host ports.** What your application implements: HTTP, secrets, token cache, cursor and snapshot state, reading declared input, applying operations, and one transaction.
- **Engine.** `compilePlugin` validates a plugin against its domain pack and type-checks every expression. `runSource` and `runSink` run it.

## A plugin

```yaml
plugin: acme-pms
version: 1.0.0
engine: ^0.1
domain: { name: str, version: ^0.1 }
hosts: [https://api.acme.test]

config:
  account_id: { secret: true }
  api_secret: { secret: true }

auth:
  type: oauth2_client_credentials
  token_url: /v1/accessTokens
  client_id: secrets.account_id
  client_secret: secrets.api_secret

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
          listing_id: string(record.listingMapId)
          status: 'record.status == "cancelled" ? "cancelled" : "confirmed"'
          check_in: record.arrivalDate
          check_out: record.departureDate
          total_minor: toMinor(double(record.totalPrice), 2)
    cursor: { value: record.updatedOn }

sinks:
  availability:
    input: { entity: calendar_day, fields: [available] }
    batch: { size: 30, by: row.listing_id }
    request:
      method: PUT
      path: /v1/listings/{batch.key}/calendar
      body: 'batch.changes.map(c, {"date": c.row.date, "isAvailable": c.row.available ? 1 : 0})'
    ack: response.body.status == "success"
```

`compilePlugin` rejects this file if, for example, a mapping reads `row.price_minor` without declaring it, a field isn't in the domain pack, a key field is missing, or the token URL points outside `hosts`.

## Running it

```ts
import { compilePlugin, runSource, runSink } from '@connector-hub/core'
import { strDomain } from '@connector-hub/domain-str'

const plugin = compilePlugin(parsedYaml, strDomain)

// Read reservations; operations and the new cursor commit in one host transaction.
await runSource(plugin, binding, 'reservations', hostPorts)

// Preview what a sink would send, then send it.
const { plan } = await runSink(plugin, binding, 'availability', hostPorts, { dryRun: true })
await runSink(plugin, binding, 'availability', hostPorts)
```

Failures are `ConnectorError`s with a `kind` your job queue acts on: `retryable` (with `retryAfterMs` when the provider said so), `reauth`, `permanent` or `config`. The engine never retries by itself.

## Live examples

Three runnable examples against public APIs, each with its own small domain pack (Node 22.6+):

```sh
pnpm build
pnpm --filter @connector-hub/examples wikipedia   # cursor paging + incremental cursor
pnpm --filter @connector-hub/examples github      # page paging, page cap, skipping pull requests
pnpm --filter @connector-hub/examples httpbin     # sink plan/apply: send changes only
```

| Example | Shows |
| --- | --- |
| Wikipedia recent changes | `rccontinue` cursor pagination; the second run starts from the saved edit time |
| GitHub issues | Page-number paging; `max_pages` stops the run with `complete=false` and the cursor stays put |
| httpbin | First run sends every row, second sends nothing, a single change sends one batch; undeclared fields never leave |

## Packages

| Package | Contents |
| --- | --- |
| `@connector-hub/spec` | Plugin and domain-pack schemas, operation type, contract version |
| `@connector-hub/cel` | CEL environment with parse limits, field analysis, money and date helpers |
| `@connector-hub/core` | Compiler, source and sink runners, HTTP and auth handling, typed errors |
| `@connector-hub/testkit` | In-memory host and HTTP fixture replay for testing plugins |
| `@connector-hub/domain-str` | Short-term rental domain pack |
| `@connector-hub/domain-contacts` | Contacts domain pack |

## Roadmap

- Inbound webhooks: verification presets (including [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks)), event dedupe, re-read on signal
- Lifecycle, review and staging blocks for providers that need approval steps
- YAML loading and a CLI: `validate`, `test`, `record`, `certify`, `diff`
- Fixture recording with secret scrubbing, and a certification suite per domain pack
- Reference adapters: Postgres state and queue, `fetch` with SSRF protection
- Field ownership and echo suppression across sources and sinks

## Development

```sh
pnpm install
pnpm test
pnpm build
```

Node 20 or later. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/design.md](docs/design.md).

## Licence

[Apache-2.0](LICENSE)
