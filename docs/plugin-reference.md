# Plugin reference

Every field of a plugin declaration. "CEL" means a [CEL expression](expressions.md);
"template" means text with `{expr}` holes, each hole being CEL.
The JSON Schema is published as `connector-hub/schema/plugin.schema.json`.

## Top level

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `plugin` | string | required | lower-kebab-case name, e.g. `acme-pms` |
| `version` | semver | required | the plugin's own version, e.g. `1.2.0` |
| `description` | string | | |
| `engine` | caret range | required | engine contract, e.g. `^0.2`. This engine runs `^0.1` and `^0.2` plugins |
| `domain` | `{name, version}` | | domain pack name and caret range, e.g. `{ name: str, version: ^0.1 }`. Needed for `emit`, `input` and `owns`; a plugin that only talks to the [target API](#target-api) has none |
| `hosts` | URL[] | required | `http(s)` origins the plugin may call. Paths are relative to the first one |
| `config` | map of [config fields](#config) | `{}` | |
| `auth` | [auth](auth.md) | `{type: none}` | |
| `headers` | name → CEL | `{}` | on every provider request, over `secrets` and `config`; e.g. a partner key |
| `limits` | [limits](#limits) | defaults below | |
| `owns` | entity → field[] | `{}` | fields this provider is the source of truth for |
| `sources` | map of [sources](#sources) | `{}` | names are lower_snake_case |
| `sinks` | map of [sinks](#sinks) | `{}` | names are lower_snake_case |

Caret ranges follow npm rules, with 0.x treated strictly: `^0.1` accepts
`0.1.x` only.

## Config

```yaml
config:
  account_id: { description: Your account number }
  region: { type: string, required: false }
  api_key: { secret: true }
```

| Field | Type | Default |
| --- | --- | --- |
| `type` | `string`, `int`, `bool` | `string` |
| `required` | bool | `true` |
| `secret` | bool | `false` |
| `description` | string | |

Non-secret fields are visible as `config.<name>` in every expression. Secret
fields are visible as `secrets.<name>` **only in `auth` and `headers`**. Fields must be read
by name: referencing an undeclared field, or `config`/`secrets` as a whole map,
is a compile error. At run time only declared config reaches expressions;
missing required values (secrets included) and wrong types fail the run as `config`.

## Limits

| Field | Default | Effect |
| --- | --- | --- |
| `timeout_ms` | 15000 (max 120000) | passed to the host's HTTP port for every request |
| `max_body_bytes` | 8388608, 8 MiB (max 64 MiB) | larger responses fail as `permanent`; expression results are capped at twice this |
| `max_pages` | 1000 (max 100000) | a source stops after this many pages with `complete: false` |
| `max_records` | 100000 (max 1000000) | a source stops after this many records with `complete: false` |
| `requests_per_minute` | none | advisory, for the host's `budget` port |

## Request

Used by sources and sinks.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `method` | `GET` `POST` `PUT` `PATCH` `DELETE` | `GET` | |
| `path` | template | required | must start with `/`; holes are URL-encoded |
| `query` | name → CEL | `{}` | `null` values are left out |
| `headers` | name → CEL | `{}` | names are lowercased; values may not contain line breaks |
| `body` | CEL | | result is sent as JSON with `content-type: application/json` |

Every request carries `accept: application/json`, and a request with a body
gets `content-type: application/json` unless the plugin sets its own.
Headers the transport or auth preset controls (`host`, `content-length`,
`transfer-encoding`, `connection`, `authorization` and the like) can't be set.

The final URL must be on one of `hosts` **and under that host's path**: with
`hosts: [https://api.example.com/v2]`, a path that resolves outside `/v2` is
refused.

## Sources

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `description` | string | | |
| `request` | [request](#request) | required | `GET` or `POST`; variables: `config`, `cursor`, `page`, `now` |
| `paginate` | [paginate](sources.md#paging) | `{type: none}` | |
| `records` | CEL | required | over `response`; must return a list |
| `when` | CEL | | over `record`, `config`, `cursor`, `now`; skipped records still move the cursor |
| `emit` | emit[] | | domain operations per record |
| `call` | [target request](#target-api) | | one target API request per record, variables as for `when`. A source has `emit` or `call` |
| `cursor` | `{value: CEL}` | | over `record`; see [cursors](sources.md#incremental-cursors) |
| `filters` | string[] | `[]` | reserved for engine query push-down |

Emit:

| Field | Type | Notes |
| --- | --- | --- |
| `operation` | string | an operation of the domain pack |
| `when` | CEL | over `record`, `config`, `cursor`; records where it isn't `true` are skipped |
| `fields` | field → CEL | over `record`, `config`, `cursor`; must include every key field of the entity |

## Sinks

A sink reads its rows either from the host (`input`, domain mode) or from the
[target API](#target-api) (`read`, target mode).

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `description` | string | | |
| `input.entity` | string | domain mode | an entity of the domain pack |
| `input.fields` | string[] | domain mode, ≥1 | the only fields the sink sees, plus the key |
| `input.where` | CEL | | over `row`, `config`, `now` |
| `read` | `{path, query, records, paginate}` | target mode | a `GET` on the target API; every page is read before anything is sent |
| `key` | CEL | target mode, required | over `row`; a string or number identifying the row |
| `fields` | string[] | whole row | target mode: fields compared with the last write (the whole row is saved) |
| `where` | CEL | | target mode: rows where it isn't `true` count as absent |
| `skip` | CEL | | over `row`; rows where it is `true` are neither sent nor treated as deleted (echo guard) |
| `on_delete` | `send` `ignore` | `ignore` | `send`: a written row that is now absent is sent once more with `deleted: true` and its saved values, then forgotten |
| `on` | string[] | `[]` | host events that should run the sink; see `sinksFor` |
| `after` | sink[] | `[]` | sinks that run first when both run; cycles are a compile error |
| `batch.size` | int | 50 | |
| `batch.by` | CEL | | over `row`, `config`, `now`; groups rows that share a request |
| `request` | [request](#request) | required | variables: `batch`, `config`, `now` |
| `ack` | CEL | any 2xx | over `response`, `batch`, `config`, `now`; `false` fails the batch |

A deleted change carries the whole row as last written. Changing the binding
config sends every row again. A target read that returns one key twice (rows
moved while paging) fails as `retryable`.

See [Sinks](sinks.md) for how diffs and batches work.

## Target API

The target is the host's own API, for example Propool's public API. A plugin
that reads and writes through it needs no domain pack: the host's API does the
validation, permissions and business rules. The host adds the base URL and the
install's credentials (see [`target`](host-integration.md)); the plugin never
sees them.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `method` | `GET` `POST` `PUT` `PATCH` `DELETE` | `GET` | `read` is always `GET` |
| `path` | template | required | relative to the target root. Refused: `//` at the start, `.`/`..` segments (also encoded), backslashes, `#`, `?`, `%` in literal text |
| `query` | name → CEL | `{}` | `null` values are left out |
| `body` | CEL | | sent as JSON |

A failed target call is `config` on 401/403 (the install key is wrong),
`retryable` on 408/425/429/5xx and `permanent` otherwise. Its message keeps the
host's own error text.

## Webhooks

`webhooks` maps a name to an incoming provider webhook. The host routes a
request to it by `path` and calls `handleWebhook`. Nothing runs before the
request is verified against its binding's secrets.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `path` | string | required | e.g. `/sync`; unique per plugin |
| `ping` | CEL | | over `request`; `true` answers a URL probe without verifying or acting |
| `binding` | CEL | required | over `request`; the key the host finds the binding by |
| `verify` | CEL | required | over `request`, `config`, `secrets`; must be `true`, otherwise 401 |
| `when` | CEL | | over `request`, `config`, `now`; `false` acknowledges and ignores |
| `dedupe_key` | CEL | | over `request`; a key already handled is acknowledged and ignored |
| `order` | CEL | | over `request`; a value not greater than the last handled one is ignored |
| `call` | [target request](#target-api) | | variables `request`, `config`, `now` |
| `reread` | `{source, request, records?}` | | reads the record from the provider, then runs that source's `when` and `call` on each record |
| `resend` | sink[] | | forgets those sinks' snapshots; the host runs them, and they send everything |
| `issue` | CEL | | a message the host shows as a problem with the binding |

A webhook has exactly one of `call`, `reread`, `resend` and `issue`. Dedupe and
order marks are saved only after the action succeeds, so a provider retry of a
failed request is handled again.

## Compile-time checks

`compilePlugin` reports every problem at once. Beyond the schema it checks:

- the engine and domain pack versions satisfy the plugin's ranges, and `emit`, `input` and `owns` have a domain;
- every expression parses, type-checks, and stays within the size limits;
- `config.*` and `secrets.*` refer to declared fields, and secrets appear only in `auth` and `headers`;
- `after` names existing sinks and has no cycle;
- paths start with `/`, and an OAuth `token_url` is on one of `hosts`;
- emitted operations and fields exist, and every key field is set;
- sources only use `GET` or `POST`, and no request sets a reserved or invalid header;
- sink entities and fields exist, no sink writes a field the plugin `owns`, and
  sinks only read fields they declared — through `row.*` or through
  `batch.changes`, e.g. `batch.changes.map(c, c.row.price_minor)`.

At run time, every emitted value is checked against its field type (`int`,
`date`, enum values and so on); a mismatch fails the run as `permanent`.
