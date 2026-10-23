# Getting started

This guide builds a plugin that reads users from the public
[JSONPlaceholder](https://jsonplaceholder.typicode.com) API into the contacts
domain, and runs it.

## Install

```sh
npm install @connector-hub/core @connector-hub/domain-contacts
npm install --save-dev @connector-hub/testkit
```

Node 22 or later. The packages are ESM; on Node 22.12+ `require()` works too.

## 1. Write the plugin

A plugin is a plain object. Most people keep it in a YAML or JSON file and
parse it with any YAML library; the engine only sees the parsed object.

```yaml
# users.plugin.yaml
plugin: jsonplaceholder-users
version: 0.1.0
engine: ^0.1
domain: { name: contacts, version: ^0.1 }
hosts: [https://jsonplaceholder.typicode.com]

sources:
  users:
    request:
      path: /users
    records: response.body
    emit:
      - operation: upsert_person
        fields:
          external_id: string(record.id)
          first_name: record.name
          email: lower(record.email)
          phone: record.phone
```

Every value under `records` and `fields` is a [CEL expression](expressions.md).
`record` is one item of the list that `records` returns.

## 2. Compile it

```ts
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { compilePlugin } from '@connector-hub/core'
import { contactsDomain } from '@connector-hub/domain-contacts'

const plugin = compilePlugin(parse(readFileSync('users.plugin.yaml', 'utf8')), contactsDomain)
```

`compilePlugin` validates the file against its domain pack and type-checks
every expression. If anything is wrong it throws a `PluginValidationError`
listing every problem, for example:

```
invalid plugin:
  - sources.users.emit[0]: person has no field full_name
  - sources.users.emit[0]: missing key field external_id
```

## 3. Run it

The engine performs no I/O. You give it **host ports**: an HTTP client, state,
and somewhere to apply operations. The testkit has an in-memory host for
trying things out; you only need to supply HTTP:

```ts
import { runSource } from '@connector-hub/core'
import { binding, memoryHost } from '@connector-hub/testkit'

const http = {
  async send(req, { timeoutMs }) {
    const res = await fetch(req.url, {
      method: req.method, headers: req.headers, body: req.body,
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() }
  },
}

const host = memoryHost({ http })
const result = await runSource(plugin, binding('demo'), 'users', host.ports, { dryRun: true })
console.log(result.operations)
```

Each operation is what your application would receive:

```js
{
  operation: 'upsert_person',
  entity: 'person',
  kind: 'upsert',
  key: { external_id: '1' },
  fields: { external_id: '1', first_name: 'Leanne Graham', email: 'sincere@april.biz', phone: '…' },
  origin: { plugin: 'jsonplaceholder-users', version: '0.1.0', source: 'users' }
}
```

Drop `dryRun` and the operations are passed to the host's `apply` inside a
transaction.

## Next

- Add [paging and an incremental cursor](sources.md).
- Write back to a provider with a [sink](sinks.md).
- Connect it to your real application by [implementing the host ports](host-integration.md).
- The repository's `examples/` folder has runnable plugins for Wikipedia,
  GitHub and httpbin.
