# Expressions

Plugins use [CEL](https://github.com/google/cel-spec), the Common Expression
Language used by Kubernetes, Envoy and Google Cloud IAM. CEL has no loops, no
I/O and no side effects, and every expression terminates. That is what lets the
engine inspect, cache and reorder plugin logic.

The implementation is [`@marcbachmann/cel-js`](https://github.com/marcbachmann/cel-js),
wrapped by `connector-hub/cel`.

## Variables by position

| Where | Variables |
| --- | --- |
| `auth.*` | `secrets`, `config` |
| source `request` | `config`, `cursor`, `page` |
| `records`, `paginate.next` | `response`, `config`, `cursor`, `page` |
| `emit.when`, `emit.fields` | `record`, `config`, `cursor` |
| `cursor.value` | `record` |
| `input.where`, `batch.by` | `row`, `config` |
| sink `request` | `batch`, `config` |
| `ack` | `response`, `batch`, `config` |

`response` is `{status, headers, body}` with `body` parsed as JSON.
`page` depends on the [paging type](sources.md#paging). `batch` is
`{key, changes}` where each change is `{row, previous}`.

Using a variable that isn't available in that position is a compile error.

## Common patterns

```cel
string(record.id)                                   // number → string
record.status == "cancelled" ? "cancelled" : "confirmed"
has(record.email) ? lower(record.email) : dyn(null) // optional field
record.tags.exists(t, t == "vip")
response.body.items.filter(i, i.type != "pull_request")
batch.changes.map(c, {"date": c.row.date, "price": c.row.price_minor})
size(response.body.results) > 0
```

## Numbers

JSON numbers that are whole become CEL `int`, others become `double`. CEL does
not mix them implicitly: `record.count + 1` works, `record.price * 1.1` needs
`double(record.price) * 1.1`. Wrap provider numbers in `double(...)` whenever
the provider might send `2` instead of `2.5`.

Results are converted back to plain JSON numbers. Integers beyond 2^53
(common for IDs) can't be JS numbers, so they arrive from the provider as
strings, keeping every digit, and leave CEL as strings. `Infinity` and `NaN`
are refused.

Both branches of `? :` must have the same type, so write a `null` fallback
as `dyn(null)`.

## Text in YAML

YAML strips one layer of quotes, and CEL needs its own for string literals:

```yaml
query:
  format: '"json"'           # the CEL string "json"
  list: '"recentchanges"'
fields:
  status: 'record.done ? "closed" : "open"'
```

## Templates

`request.path` is a template: literal text with `{expr}` holes.

```yaml
path: /v1/listings/{batch.key}/calendar
path: /repos/{config.owner}/{config.repo}/issues
```

Each hole's value is URL-encoded, so a value can't add path segments or a
query string. A hole must produce a string, number or bool, and may not be
empty, `.` or `..`.

## Built-in functions

Standard CEL (`size`, `has`, `string`, `int`, `double`, `startsWith`,
`endsWith`, `contains`, `all`, `exists`, `exists_one`, `map`, `filter`, …),
except `matches`: JavaScript regular expressions can take exponential time, so
regex matching is left out until a linear-time engine is in place. Also
available:

| Function | Result |
| --- | --- |
| `toMinor(double, int): int` | `toMinor(12.34, 2)` → `1234`. Fails if the value has more decimals than the scale |
| `toMinor(int, int): int` | `toMinor(12, 2)` → `1200` |
| `fromMinor(int, int): double` | `fromMinor(1234, 2)` → `12.34` |
| `lower(string): string` | lower case |
| `datePart(string): string` | `"2026-10-23T08:00:00Z"` → `"2026-10-23"` |

## Limits

Every expression is limited to 500 AST nodes, depth 32, and 200 elements per
list or map literal. Comprehensions (`map`, `filter`, `all`, `exists`,
`exists_one`) may not be nested. At run time, a result larger than twice
`limits.max_body_bytes` (counted as characters plus elements) fails as
`permanent`, which stops expressions that build huge strings or lists.

A failing expression (a missing key, a type mismatch) fails the run as
`permanent`, with the expression's location in the message, e.g.
`sources.reservations.emit[0].fields.total_minor: No such key: totalPrice`.

## Field analysis

The compiler records every field path an expression reads, for example
`row.price_minor`. Comprehension variables are followed, so
`batch.changes.map(c, c.row.price_minor)` records
`batch.changes[].row.price_minor`. That is how a sink is limited to its
declared input, and how the engine can later fetch only what plugins use.
