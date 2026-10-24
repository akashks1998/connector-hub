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
| `engine` | caret range | required | engine contract, e.g. `^0.1` |
| `domain` | `{name, version}` | required | domain pack name and caret range, e.g. `{ name: str, version: ^0.1 }` |
| `hosts` | URL[] | required | `http(s)` origins the plugin may call. Paths are relative to the first one |
| `config` | map of [config fields](#config) | `{}` | |
| `auth` | [auth](auth.md) | `{type: none}` | |
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
fields are visible as `secrets.<name>` **only in `auth`**. Fields must be read
by name: referencing an undeclared field, or `config`/`secrets` as a whole map,
is a compile error. At run time only declared config reaches expressions;
missing required values and wrong types fail the run as `config`.

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
| `request` | [request](#request) | required | `GET` or `POST`; variables: `config`, `cursor`, `page` |
| `paginate` | [paginate](sources.md#paging) | `{type: none}` | |
| `records` | CEL | required | over `response`; must return a list |
| `emit` | emit[] | required, ≥1 | |
| `cursor` | `{value: CEL}` | | over `record`; see [cursors](sources.md#incremental-cursors) |
| `filters` | string[] | `[]` | reserved for engine query push-down |

Emit:

| Field | Type | Notes |
| --- | --- | --- |
| `operation` | string | an operation of the domain pack |
| `when` | CEL | over `record`, `config`, `cursor`; records where it isn't `true` are skipped |
| `fields` | field → CEL | over `record`, `config`, `cursor`; must include every key field of the entity |

## Sinks

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `description` | string | | |
| `input.entity` | string | required | an entity of the domain pack |
| `input.fields` | string[] | required, ≥1 | the only fields the sink sees, plus the key |
| `input.where` | CEL | | over `row`, `config` |
| `batch.size` | int | 50 | |
| `batch.by` | CEL | | over `row`, `config`; groups rows that share a request |
| `request` | [request](#request) | required | variables: `batch`, `config` |
| `ack` | CEL | any 2xx | over `response`, `batch`, `config`; `false` fails the batch |

See [Sinks](sinks.md) for how diffs and batches work.

## Compile-time checks

`compilePlugin` reports every problem at once. Beyond the schema it checks:

- the engine and domain pack versions satisfy the plugin's ranges;
- every expression parses, type-checks, and stays within the size limits;
- `config.*` and `secrets.*` refer to declared fields, and secrets appear only in `auth`;
- paths start with `/`, and an OAuth `token_url` is on one of `hosts`;
- emitted operations and fields exist, and every key field is set;
- sources only use `GET` or `POST`, and no request sets a reserved or invalid header;
- sink entities and fields exist, no sink writes a field the plugin `owns`, and
  sinks only read fields they declared — through `row.*` or through
  `batch.changes`, e.g. `batch.changes.map(c, c.row.price_minor)`.

At run time, every emitted value is checked against its field type (`int`,
`date`, enum values and so on); a mismatch fails the run as `permanent`.
