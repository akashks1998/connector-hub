# @connector-hub/cel

A restricted [CEL](https://github.com/google/cel-spec) environment, used by
connector-hub for every expression in a plugin. Built on
[@marcbachmann/cel-js](https://github.com/marcbachmann/cel-js).

- Parse limits: 500 AST nodes, depth 32, 200 elements per literal.
- Nested comprehensions and `matches` are refused; together with the result-size cap in core, this keeps cost bounded.
- `refs` lists every field path an expression reads, including through
  comprehension variables (`xs.map(x, x.a)` reads `xs[].a`).
- Whole JSON numbers become CEL `int`; results come back as plain JSON.
- Helpers: `toMinor`, `fromMinor`, `lower`, `datePart`.

```ts
import { CelEnvironment } from '@connector-hub/cel'

const env = new CelEnvironment({ variables: { record: 'map' } })
const expr = env.compile('toMinor(double(record.total), 2)')
expr.refs                                 // Set { 'record.total' }
expr.evaluate({ record: { total: 12.5 } }) // 1250
```

See [Expressions](https://github.com/akashks1998/connector-hub/blob/main/docs/expressions.md).

Apache-2.0. Part of [connector-hub](https://github.com/akashks1998/connector-hub).
